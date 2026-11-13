import argparse
import asyncio
import importlib
import logging
import shutil
import os
import sys
import tempfile
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Path as P, Request, WebSocket, WebSocketDisconnect
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from typing import Annotated

from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

SRC = Path(__file__).resolve().parent
ROOT = SRC.parent
sys.path.insert(0, str(SRC))
from media import (AudioQueue, audio_suffix, call_process, first_upload, image_to_jpeg, lip_gate,  # noqa: E402
                   lan_ip, read_body, speech_banner, speech_status, warm_up_notes)
from sources import CameraSource, IngestSource, RoomConsent  # noqa: E402
from store import ConsentRequired, Store  # noqa: E402

log = logging.getLogger("face-context")
MAX_MODEL = 25 * 1024 * 1024
MAX_AUDIO = 50 * 1024 * 1024
MAX_INGEST_AUDIO = 10 * 1024 * 1024
MAX_IMAGE = 5 * 1024 * 1024
INGEST_RATE = 30
DEMO_ROOM_TEXT = "demo session: synthetic faces only"
AUTO_TEXT = "auto-captured in a test session; operator presumed consent; individual consent not recorded"
PersonId = P(ge=1, le=2**31 - 1)


class Hub:
    def __init__(self):
        self.clients = set()

    def add(self):
        q = asyncio.Queue(maxsize=32)
        self.clients.add(q)
        return q

    def remove(self, q):
        self.clients.discard(q)

    def broadcast(self, msg):
        for q in list(self.clients):
            try:
                q.put_nowait(msg)
            except asyncio.QueueFull:
                q.get_nowait()
                q.put_nowait(msg)


class Enrol(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    consent: str = Field(min_length=1, max_length=500)
    role: str = Field(default="", max_length=120)


class PersonPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    role: str | None = Field(default=None, max_length=120)
    summary: str | None = Field(default=None, max_length=2000)
    tags: list[Annotated[str, Field(max_length=40)]] | None = Field(default=None, max_length=12)
    followups: list[Annotated[str, Field(max_length=300)]] | None = Field(default=None, max_length=12)


class NoteIn(BaseModel):
    text: str = Field(min_length=1, max_length=4000)


def create_app(store, source, data_dir, web_dir=ROOT / "web", ingest=False, room=None, warm_notes=False):
    data_dir = Path(data_dir)
    model_dir = data_dir / "models"
    model_dir.mkdir(parents=True, exist_ok=True)
    hub = Hub()

    speech = {"stt": "unknown", "cloudSpeech": False}

    def session():
        return {"roomConsent": room is not None, "text": room.text if room else None,
                "autoEnrolled": store.count_auto(), **speech}

    async def pump():
        tick = 0
        while True:
            if tick % 24 == 0 and (now := await run_in_threadpool(speech_status)) != speech:
                speech.update(now)
                hub.broadcast({"type": "session", **session()})
            tick += 1
            hub.broadcast(source.detections())
            line = source.transcript()
            if line:
                hub.broadcast(line)
            await asyncio.sleep(1 / 12)

    @asynccontextmanager
    async def lifespan(app):
        source.start()
        app.state.loop = asyncio.get_running_loop()
        audio.start()
        if warm_notes:
            threading.Thread(target=warm_up_notes, daemon=True).start()
        task = asyncio.create_task(pump())
        yield
        task.cancel()
        audio.stop()
        source.stop()

    app = FastAPI(title="face-context", lifespan=lifespan)
    app.state.hub, app.state.source, app.state.store = hub, source, store

    @app.exception_handler(RequestValidationError)
    async def bad_request(request, exc):
        errs = [f"{'.'.join(str(x) for x in e.get('loc', [])[1:])}: {e.get('msg')}" for e in exc.errors()]
        return JSONResponse({"detail": "; ".join(errs) or "invalid request"}, status_code=400)

    def person_or_404(pid):
        person = store.get_person(pid)
        if person is None:
            raise HTTPException(404, "person not found")
        return person

    def public(p, full=False):
        out = {"id": p["id"], "name": p["name"], "role": p["role"], "tags": p["tags"], "summary": p["summary"]}
        if not full:
            out.update(lastSeen=p["lastSeen"], hasModel=bool(p["modelPath"]), thumbClear=p["thumbClear"])
            return out
        out.update(followups=p["followups"],
                   notes=[{"id": i, "ts": ts, "text": text} for i, ts, text in store.notes_with_ids(p["id"])],
                   modelUrl=f"/models/{p['id']}.glb" if p["modelPath"] else None,
                   thumbUrl=f"/api/people/{p['id']}/thumb.jpg", lastSeen=p["lastSeen"],
                   consentAt=p["consentAt"], consentNote=p["consentNote"], autoEnrolled=p["auto"], thumbClear=p["thumbClear"],
                   nameSource=p["nameSource"], edited=p["manualFields"] + (["thumb"] if p["pinned"] else []))
        return out

    @app.get("/api/people")
    def list_people():
        return [public(p) for p in store.list_people()]

    @app.get("/api/people/{pid}")
    def get_person(pid: int = PersonId):
        return public(person_or_404(pid), full=True)

    @app.get("/api/people/{pid}/thumb.jpg")
    def thumb(pid: int = PersonId):
        data = store.thumb(pid)
        if not data:
            raise HTTPException(404, "no thumbnail")
        return Response(data, media_type="image/jpeg", headers={"Cache-Control": "no-cache"})

    @app.get("/api/people/{pid}/snapshots")
    def snapshots(pid: int = PersonId):
        p = person_or_404(pid)
        out = [{"url": f"/api/people/{pid}/thumb.jpg", "score": None, "ts": None, "pinned": True}] if p["pinned"] else []
        return out + [{"url": f"/api/people/{pid}/snapshots/{sid}.jpg", "score": round(score, 1), "ts": ts,
                       "pinned": False} for sid, score, ts in store.snapshots(pid)]

    @app.get("/api/people/{pid}/snapshots/{sid}.jpg")
    def snapshot_file(pid: int = PersonId, sid: int = P(ge=1, le=2**31 - 1)):
        data = store.snapshot(pid, sid)
        if not data:
            raise HTTPException(404, "no such snapshot")
        return Response(data, media_type="image/jpeg")

    @app.post("/api/people/{pid}/snapshot")
    async def pin_snapshot(request: Request, pid: int = PersonId):
        person_or_404(pid)
        if request.headers.get("content-type", "").startswith("multipart/form-data"):
            data = (await first_upload(request, MAX_IMAGE))[2]
        else:
            data = await read_body(request, MAX_IMAGE)
        try:
            store.set_pinned(pid, image_to_jpeg(data))
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        return {"thumbUrl": f"/api/people/{pid}/thumb.jpg?v={int(time.time() * 1000)}"}

    @app.delete("/api/people/{pid}/snapshot", status_code=204)
    def unpin_snapshot(pid: int = PersonId):
        person_or_404(pid)
        store.set_pinned(pid, None)
        return Response(status_code=204)

    @app.post("/api/enrol", status_code=201)
    def enrol(body: Enrol):
        name, consent = body.name.strip(), body.consent.strip()
        if not name:
            raise HTTPException(400, "name is required")
        if not consent:
            raise HTTPException(400, "consent text is required")
        try:
            emb, thumb_jpeg = source.capture_face()
            pid = store.enrol(name, emb, consent, body.role.strip(), thumb_jpeg)
        except (ValueError, ConsentRequired) as exc:
            raise HTTPException(400, str(exc))
        source.enrolled(pid, name)
        return {"id": pid}

    @app.post("/api/people/{pid}/notes", status_code=201)
    def add_note(body: NoteIn, pid: int = PersonId):
        person_or_404(pid)
        text = body.text.strip()
        if not text:
            raise HTTPException(400, "text is required")
        ts = store.add_note(pid, text)
        return {"id": store.notes_with_ids(pid)[-1][0] if store.notes_with_ids(pid) else None, "ts": ts, "text": text}

    @app.delete("/api/people/{pid}/notes/{note_id}", status_code=204)
    def delete_note(pid: int = PersonId, note_id: int = P(ge=1, le=2**31 - 1)):
        person_or_404(pid)
        if not store.delete_note(pid, note_id):
            raise HTTPException(404, "note not found")
        return Response(status_code=204)

    @app.post("/api/people/{pid}/model")
    async def upload_model(request: Request, pid: int = PersonId):
        person_or_404(pid)
        filename, _, data = await first_upload(request, MAX_MODEL)
        if len(data) < 12 or data[:4] != b"glTF":
            raise HTTPException(400, "file is not a binary glTF (.glb)")
        if int.from_bytes(data[4:8], "little") != 2:
            raise HTTPException(400, "only glTF 2.0 .glb files are supported")
        path = model_dir / f"{pid}.glb"
        path.write_bytes(data)
        store.set_model_path(pid, str(path))
        return {"modelUrl": f"/models/{pid}.glb"}

    @app.get("/models/{pid}.glb")
    def get_model(pid: int = PersonId):
        p = person_or_404(pid)
        if not p["modelPath"] or not Path(p["modelPath"]).is_file():
            raise HTTPException(404, "no model")
        return FileResponse(p["modelPath"], media_type="model/gltf-binary", headers={"Cache-Control": "no-cache"})

    def emit(msg):
        loop = getattr(app.state, "loop", None)
        if loop is not None and not loop.is_closed():
            loop.call_soon_threadsafe(hub.broadcast, msg)

    def process_chunk(job):
        pid, suffix, data, lip = job
        person = store.get_person(pid)
        if person is None:
            return
        notes_mod = importlib.import_module("notes")
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp.write(data)
        try:
            known = [text for _, text in store.notes(pid)]
            hot = [p["name"] for p in store.list_people() if p["nameSource"] != "placeholder"]
            result = call_process(notes_mod.process_audio, tmp.name, person["name"], known, hot, lip)
        finally:
            Path(tmp.name).unlink(missing_ok=True)
        if not isinstance(result, dict) or not store.exists(pid):
            return
        transcript = str(result.get("transcript") or "").strip()[:20000]
        if transcript:
            emit({"type": "transcript", "personId": pid, "text": transcript, "ts": store.add_note(pid, transcript)})
            extract = getattr(notes_mod, "extract_names", None)
            try:
                candidates = extract(transcript) if callable(extract) else []
            except Exception as exc:
                log.warning("name extraction failed: %s", type(exc).__name__)
                candidates = []
            if named := store.name_from_speech(pid, candidates):
                source.renamed(pid, named)
        summary, followups = result.get("summary"), result.get("followups")
        store.update_profile(pid, summary=summary if isinstance(summary, str) and summary.strip() else None,
                             followups=followups if isinstance(followups, list) else None)

    audio = app.state.audio = AudioQueue(process_chunk, maxlen=2)

    def queue_audio(pid, suffix, data, lip=None):
        if reason := lip_gate(lip, pid):
            return JSONResponse({"queued": False, "reason": reason, "personId": pid}, 202)
        try:
            importlib.import_module("notes").process_audio
        except Exception:
            raise HTTPException(503, "notes pipeline unavailable: src/notes.py is missing or failed to import")
        dropped = audio.submit((pid, suffix, data, lip))
        return JSONResponse({"queued": True, "personId": pid, "dropped": dropped}, 202)

    @app.post("/api/people/{pid}/conversation")
    async def conversation(request: Request, pid: int = PersonId, lip: float | None = None):
        person_or_404(pid)
        filename, ctype, data = await first_upload(request, MAX_AUDIO)
        suffix = audio_suffix(filename, ctype)
        if suffix is None or not data:
            raise HTTPException(400, "upload an audio file (wav, mp3, m4a, webm, ogg, aac, flac)")
        return queue_audio(pid, suffix, data, lip)

    @app.post("/api/ingest/audio")
    async def ingest_audio(request: Request, personId: int | None = None, lip: float | None = None):
        if personId is not None and not 1 <= personId < 2**31:
            raise HTTPException(400, "invalid personId")
        ctype = request.headers.get("content-type", "")
        if ctype.startswith("multipart/form-data"):
            filename, ctype, data = await first_upload(request, MAX_INGEST_AUDIO)
        else:
            data, filename = await read_body(request, MAX_INGEST_AUDIO), ""
        suffix = audio_suffix(filename, ctype) or (".wav" if data[:4] == b"RIFF" else None)
        if suffix is None or not data:
            raise HTTPException(400, "send audio bytes with an audio/* content type")
        if personId is None:
            faces = [f for f in source.detections()["faces"] if f["personId"]]
            if not faces:
                return JSONResponse({"stored": False, "detail": "no enrolled person in view; audio discarded"}, 202)
            personId = max(faces, key=lambda f: f["box"][2] * f["box"][3])["personId"]
        person_or_404(personId)
        return queue_audio(personId, suffix, data, lip)

    @app.patch("/api/people/{pid}")
    def patch_person(body: PersonPatch, pid: int = PersonId):
        person_or_404(pid)
        name = body.name.strip() if body.name is not None else None
        if name is not None and not name:
            raise HTTPException(400, "name cannot be empty")
        fields = (body.role, body.summary, body.tags, body.followups)
        if name is None and all(f is None for f in fields):
            raise HTTPException(400, "send at least one of name, role, summary, tags, followups")
        store.rename(pid, name=name, source="manual")
        store.update_profile(pid, role=body.role, summary=body.summary, tags=body.tags, followups=body.followups,
                             manual=True)
        if name:
            source.renamed(pid, name)
        return public(person_or_404(pid), full=True)

    @app.get("/api/session")
    def get_session():
        return session()

    @app.post("/api/session/wipe", status_code=204)
    def wipe():
        for pid, model_path in store.delete_auto():
            (model_dir / f"{pid}.glb").unlink(missing_ok=True)
            if model_path:
                Path(model_path).unlink(missing_ok=True)
            source.forgot(pid)
        return Response(status_code=204)

    @app.delete("/api/people/{pid}", status_code=204)
    def delete(pid: int = PersonId):
        person_or_404(pid)
        model_path = store.delete_person(pid)
        (model_dir / f"{pid}.glb").unlink(missing_ok=True)
        if model_path:
            Path(model_path).unlink(missing_ok=True)
        source.forgot(pid)
        return Response(status_code=204)

    @app.get("/video.mjpg")
    async def video(request: Request):
        async def frames():
            last = None
            while not await request.is_disconnected():
                jpeg = source.jpeg()
                if jpeg is not None and jpeg is not last:
                    last = jpeg
                    yield b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: " + str(len(jpeg)).encode() + b"\r\n\r\n" + jpeg + b"\r\n"
                await asyncio.sleep(1 / 30)
        return StreamingResponse(frames(), media_type="multipart/x-mixed-replace; boundary=frame",
                                 headers={"Cache-Control": "no-store"})

    @app.websocket("/ws")
    async def ws(socket_: WebSocket):
        await socket_.accept()
        q = hub.add()
        try:
            await socket_.send_json({"type": "session", **session()})
            while True:
                await socket_.send_json(await q.get())
        except (WebSocketDisconnect, RuntimeError):
            pass
        finally:
            hub.remove(q)

    @app.websocket("/ingest")
    async def ingest_ws(socket_: WebSocket):
        await socket_.accept()
        if not ingest:
            await socket_.close(code=1008, reason="server is not running with --source ingest")
            return
        window, count = time.time(), 0
        try:
            while True:
                msg = await socket_.receive()
                if msg["type"] == "websocket.disconnect":
                    break
                data = msg.get("bytes")
                now = time.time()
                if now - window >= 1.0:
                    window, count = now, 0
                count += 1
                if count > INGEST_RATE:
                    await socket_.send_json({"type": "error", "error": "rate limit 30 frames/s"})
                    continue
                if data is None:
                    await socket_.send_json({"type": "error", "error": "send binary JPEG frames"})
                    continue
                try:
                    await run_in_threadpool(source.push_jpeg, data)
                except ValueError as exc:
                    await socket_.send_json({"type": "error", "error": str(exc)})
        except (WebSocketDisconnect, RuntimeError):
            pass

    if Path(web_dir).is_dir():
        app.mount("/", StaticFiles(directory=str(web_dir), html=True), name="web")
    else:
        @app.get("/")
        def root():
            return PlainTextResponse("face-context API is running; web/ is not built yet")
    return app


def main(argv=None):
    p = argparse.ArgumentParser(description="face-context viewer server")
    p.add_argument("--demo", action="store_true", help="synthetic frames and fictional people, no camera")
    p.add_argument("--source", choices=["camera", "ingest", "demo"], default=None)
    p.add_argument("--camera", type=int, default=0)
    p.add_argument("--db", default="memory.db")
    p.add_argument("--data", default=str(ROOT / "data"))
    p.add_argument("--host", default="0.0.0.0")
    p.add_argument("--port", type=int, default=8800)
    p.add_argument("--room-consent", default=None, metavar="TEXT",
                   help="override the stored consent text, e.g. who actually agreed")
    p.add_argument("--no-auto-enrol", action="store_true", help="turn off automatic enrolment (on by default)")
    p.add_argument("--keep", action="store_true", help="with --room-consent, keep the DB instead of an ephemeral one")
    p.add_argument("--no-cloud-speech", action="store_true", help="never send audio to Google; local speech only")
    args = p.parse_args(argv)
    if args.no_cloud_speech:
        os.environ["NOTES_STT_BACKEND"] = "mlx"
    if args.room_consent is not None and not args.room_consent.strip():
        p.error("--room-consent needs a non-empty text describing who agreed and when")
    mode = "demo" if args.demo else (args.source or "camera")
    logging.basicConfig(level=logging.INFO)
    text = room_text(mode, args.room_consent, args.no_auto_enrol)
    store, data_dir, temp_dir = open_store(mode, args.db, args.data, text, args.keep)
    room = RoomConsent(store, text, prefix="" if text == AUTO_TEXT else "room consent session: ") if text else None
    if mode == "demo":
        from demo import DemoSource
        source = DemoSource(store, room=room)
    else:
        try:
            source = (CameraSource(store, args.camera, room=room) if mode == "camera"
                      else IngestSource(store, room=room))
        except RuntimeError as exc:
            sys.exit(str(exc))
    app = create_app(store, source, data_dir, ingest=mode == "ingest", room=room, warm_notes=True)
    ip = lan_ip()
    print(f"face-context ({mode}) viewer: http://{ip}:{args.port}/  (local http://127.0.0.1:{args.port}/)", flush=True)
    print(speech_banner(args.no_cloud_speech), flush=True)
    if mode == "ingest":
        print(f"ingest frames: ws://{ip}:{args.port}/ingest   audio: http://{ip}:{args.port}/api/ingest/audio", flush=True)
    if room:
        kept = "kept in " + args.db if args.keep and mode != "demo" else "ephemeral, deleted on exit"
        print(f"ROOM CONSENT MODE: auto-enrolling faces in view (cap {room.cap}), store {kept}. "
              f"Consent: {room.text}", flush=True)
        print("AUTOMATIC ENROLMENT IS ON: every clear face in view is enrolled. "
              "Turn it off with --no-auto-enrol.", flush=True)
    import uvicorn
    try:
        uvicorn.run(app, host=args.host, port=args.port, log_level="warning")
    finally:
        if temp_dir:
            shutil.rmtree(temp_dir, ignore_errors=True)


def room_text(mode, override=None, no_auto=False):
    if no_auto:
        return None
    if override is not None:
        return override.strip() or None
    return DEMO_ROOM_TEXT if mode == "demo" else AUTO_TEXT


def open_store(mode, db, data, room_text=None, keep=False):
    if mode == "demo" or (room_text and not keep):
        temp_dir = tempfile.mkdtemp(prefix="face-context-")
        return Store(":memory:"), temp_dir, temp_dir
    return Store(db), data, None


if __name__ == "__main__":
    main()
