import sys
import time
import types
from pathlib import Path

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
import server  # noqa: E402
from demo import DemoSource  # noqa: E402
from server import create_app  # noqa: E402
from sources import IngestSource, Tracker  # noqa: E402
from store import Store  # noqa: E402

GLB = b"glTF" + (2).to_bytes(4, "little") + (20).to_bytes(4, "little") + b"\x00" * 8


def core(d):
    return {k: v for k, v in d.items() if k not in ("stt", "cloudSpeech")}


def talk(client, url, **kw):
    r = client.post(url, **kw)
    assert r.status_code == 202 and r.json()["queued"] is True, r.text
    assert client.app.state.audio.join(10)
    return client.get(f"/api/people/{r.json()['personId']}").json()


@pytest.fixture
def demo(tmp_path):
    store = Store(":memory:")
    app = create_app(store, DemoSource(store), tmp_path, web_dir=tmp_path / "noweb")
    with TestClient(app) as client:
        yield client, store, tmp_path


def test_list_and_detail(demo):
    client, _, _ = demo
    people = client.get("/api/people").json()
    assert [p["name"] for p in people] == ["Sam Lee", "Priya Shah", "Joon Park"]
    assert set(people[0]) == {"id", "name", "role", "tags", "summary", "lastSeen", "hasModel", "thumbClear"}
    detail = client.get("/api/people/1").json()
    assert detail["followups"] and detail["notes"][0]["text"]
    assert detail["modelUrl"] is None and detail["thumbUrl"] == "/api/people/1/thumb.jpg"
    r = client.get("/api/people/1/thumb.jpg")
    assert r.status_code == 200 and r.content[:2] == b"\xff\xd8"


def test_bad_ids(demo):
    client, _, _ = demo
    assert client.get("/api/people/999").status_code == 404
    assert client.get("/api/people/0").status_code == 400
    assert client.get("/api/people/abc").status_code == 400


def test_enrol_requires_consent_and_name(demo):
    client, _, _ = demo
    assert client.post("/api/enrol", json={"name": "Ana"}).status_code == 400
    assert client.post("/api/enrol", json={"name": "Ana", "consent": "   "}).status_code == 400
    assert client.post("/api/enrol", json={"name": "", "consent": "yes"}).status_code == 400
    assert client.post("/api/enrol", json={"name": "x" * 81, "consent": "yes"}).status_code == 400
    assert len(client.get("/api/people").json()) == 3


def test_enrol_success(demo):
    client, _, _ = demo
    r = client.post("/api/enrol", json={"name": "Ana", "consent": "said yes at booth 4", "role": "mentor"})
    assert r.status_code == 201
    pid = r.json()["id"]
    detail = client.get(f"/api/people/{pid}").json()
    assert detail["role"] == "mentor" and detail["consentNote"] == "said yes at booth 4"
    assert isinstance(detail["consentAt"], float)
    assert client.get(f"/api/people/{pid}/thumb.jpg").status_code == 200


def test_notes(demo):
    client, _, _ = demo
    assert client.post("/api/people/1/notes", json={"text": "  "}).status_code == 400
    assert client.post("/api/people/999/notes", json={"text": "hi"}).status_code == 404
    assert client.post("/api/people/1/notes", json={"text": "likes tea"}).status_code == 201
    assert client.get("/api/people/1").json()["notes"][-1]["text"] == "likes tea"


def test_model_upload_validation_and_delete_cascade(demo):
    client, store, tmp = demo
    bad = client.post("/api/people/1/model", files={"file": ("x.glb", b"notaglb" * 4, "model/gltf-binary")})
    assert bad.status_code == 400
    big = client.post("/api/people/1/model", files={"file": ("x.glb", b"glTF" + b"\0" * (25 * 1024 * 1024), "x")})
    assert big.status_code == 413
    r = client.post("/api/people/1/model", files={"file": ("x.glb", GLB, "model/gltf-binary")})
    assert r.json() == {"modelUrl": "/models/1.glb"}
    assert client.get("/models/1.glb").content == GLB
    assert client.get("/api/people").json()[0]["hasModel"] is True
    assert client.delete("/api/people/1").status_code == 204
    assert not (tmp / "models" / "1.glb").exists()
    assert client.get("/api/people/1").status_code == 404
    assert client.get("/models/1.glb").status_code == 404
    assert store.notes(1) == [] and store.thumb(1) is None
    assert client.delete("/api/people/1").status_code == 404


def test_conversation_missing_pipeline(demo, monkeypatch):
    client, _, _ = demo
    monkeypatch.setitem(sys.modules, "notes", None)
    r = client.post("/api/people/1/conversation", files={"file": ("a.wav", b"RIFF0000", "audio/wav")})
    assert r.status_code == 503 and "notes" in r.json()["detail"]


def test_conversation_updates_profile_and_broadcasts(demo, monkeypatch):
    client, _, _ = demo
    seen = {}

    def process_audio(path, person_name, known_notes):
        seen.update(path=path, name=person_name, known=known_notes)
        return {"transcript": "We talked about grippers.", "summary": "New summary",
                "tags": ["grippers"], "followups": ["Email Sam"]}

    monkeypatch.setitem(sys.modules, "notes", types.SimpleNamespace(process_audio=process_audio))
    assert client.post("/api/people/1/conversation", files={"file": ("a.txt", b"x", "text/plain")}).status_code == 400
    with client.websocket_connect("/ws") as ws:
        body = talk(client, "/api/people/1/conversation", files={"file": ("a.webm", b"audio", "audio/webm")})
        for _ in range(100):
            msg = ws.receive_json()
            if msg["type"] == "transcript" and msg["text"] == "We talked about grippers.":
                break
        else:
            pytest.fail("no transcript broadcast")
    assert seen["name"] == "Sam Lee" and seen["path"].endswith(".webm") and seen["known"]
    assert body["summary"] == "New summary" and "grippers" not in body["tags"] and body["followups"] == ["Email Sam"]
    assert body["notes"][-1]["text"] == "We talked about grippers."


def test_conversation_pipeline_error(demo, monkeypatch):
    client, _, _ = demo

    def boom(*a):
        raise RuntimeError("secret detail")

    monkeypatch.setitem(sys.modules, "notes", types.SimpleNamespace(process_audio=boom))
    body = talk(client, "/api/people/1/conversation", files={"file": ("a.wav", b"RIFF", "audio/wav")})
    assert body["summary"] == client.get("/api/people/1").json()["summary"] and "secret" not in str(body)


def test_ws_detections_shape(demo):
    client, _, _ = demo
    with client.websocket_connect("/ws") as ws:
        msg = ws.receive_json()
        while msg["type"] != "detections":
            msg = ws.receive_json()
    assert msg["w"] == 960 and msg["h"] == 540 and msg["live"] is True and "ts" in msg
    face = msg["faces"][0]
    assert set(face) == {"trackId", "box", "personId", "name", "score", "predicted", "thumbClear"} and len(face["box"]) == 4
    assert any(f["personId"] is None and f["name"] is None for f in msg["faces"])


def test_video_route_and_root(demo):
    client, _, _ = demo
    assert client.get("/").status_code == 200
    routes = {getattr(r, "path", None) for r in client.app.routes}
    assert "/video.mjpg" in routes
    assert client.app.state.source.jpeg()[:2] == b"\xff\xd8"


def test_tracker_keeps_ids_while_moving():
    t = Tracker()
    a, b = [100.0, 100.0, 80.0, 100.0], [400.0, 120.0, 80.0, 100.0]
    ids = None
    for step in range(20):
        now = step * 0.1
        dets = [([a[0] + 6 * step, a[1], 80, 100], (1, "Sam", 0.7)), ([b[0] - 6 * step, b[1], 80, 100], None)]
        out = t.update(dets, now)
        cur = {f["personId"]: f["trackId"] for f in out}
        ids = ids or cur
        assert cur == ids
    out = t.update([], 5.0)
    assert out == [] and t.tracks == []


def test_tracker_sticky_identity():
    t = Tracker()
    box = [100.0, 100.0, 80.0, 100.0]
    t.update([(box, (1, "Sam", 0.7))], 0.0)
    out = t.update([(box, (2, "Priya", 0.72))], 0.1)
    assert out[0]["personId"] == 1
    out = t.update([(box, None)], 0.2)
    assert out[0]["personId"] == 1
    for i in range(3):
        out = t.update([(box, (2, "Priya", 0.9))], 0.3 + i * 0.1)
    assert out[0]["personId"] == 2 and out[0]["name"] == "Priya"


def jpeg(w=64, h=48):
    return cv2.imencode(".jpg", np.full((h, w, 3), 128, np.uint8))[1].tobytes()


class NoFaces:
    def find(self, frame):
        return []


def test_ingest_ws(tmp_path):
    store = Store(":memory:")
    source = IngestSource(store, faces=NoFaces())
    app = create_app(store, source, tmp_path, web_dir=tmp_path / "noweb", ingest=True)
    with TestClient(app) as client:
        assert source.detections()["live"] is False
        with client.websocket_connect("/ingest") as ws:
            ws.send_bytes(b"not a jpeg at all")
            assert "JPEG" in ws.receive_json()["error"]
            ws.send_bytes(b"\xff\xd8" + b"\0" * (1024 * 1024))
            assert "1 MB" in ws.receive_json()["error"]
            ws.send_bytes(b"\xff\xd8garbage")
            assert "decoded" in ws.receive_json()["error"]
            frame = jpeg()
            ws.send_bytes(frame)
            ws.send_text("hello")
            assert "binary" in ws.receive_json()["error"]
        assert source.jpeg() == frame and source.live()
        source.detect_once()
        state = source.detections()
        assert state["w"] == 64 and state["h"] == 48 and state["faces"] == []
        assert client.post("/api/enrol", json={"name": "Ana", "consent": "yes"}).status_code == 400


def test_ingest_ws_refused_in_other_modes(demo):
    client, _, _ = demo
    with client.websocket_connect("/ingest") as ws:
        with pytest.raises(Exception):
            ws.receive_bytes()


def test_ingest_audio(tmp_path, monkeypatch):
    store = Store(":memory:")
    pid = store.enrol("Sam", np.ones(128, np.float32), "yes")
    app = create_app(store, IngestSource(store, faces=NoFaces()), tmp_path, web_dir=tmp_path / "noweb", ingest=True)
    monkeypatch.setitem(sys.modules, "notes", types.SimpleNamespace(
        process_audio=lambda p, n, k: {"transcript": "hi", "summary": "s", "tags": [], "followups": []}))
    with TestClient(app) as client:
        body = talk(client, f"/api/ingest/audio?personId={pid}", content=b"RIFFdata",
                    headers={"content-type": "audio/wav"})
        assert body["notes"][-1]["text"] == "hi"
        r = client.post("/api/ingest/audio", content=b"RIFFdata", headers={"content-type": "audio/wav"})
        assert r.status_code == 202 and r.json()["stored"] is False
        r = client.post(f"/api/ingest/audio?personId={pid}", content=b"x" * (10 * 1024 * 1024 + 1),
                        headers={"content-type": "audio/wav"})
        assert r.status_code == 413
        assert client.post("/api/ingest/audio?personId=abc", content=b"RIFF").status_code == 400


def face_row(x, y=100.0, size=120.0, score=0.95):
    return np.array([x, y, size, size * 1.15, x + 30, y + 50, x + 90, y + 50, x + 60, y + 80,
                     x + 40, y + 110, x + 80, y + 110, score], np.float32)


class FakeFaces:
    def __init__(self, rows):
        self.rows = rows

    def find(self, frame):
        return list(self.rows)

    def embed(self, frame, f):
        return np.random.default_rng(int(f[0])).normal(size=128).astype(np.float32)


def room_source(store, rows, text="team said yes", cap=12):
    from sources import RoomConsent
    room = RoomConsent(store, text, cap=cap) if text else None
    src = IngestSource(store, faces=FakeFaces(rows), room=room)
    noise = np.random.default_rng(0).integers(0, 255, (480, 640, 3), dtype=np.uint8)
    src._set_frame(noise, b"\xff\xd8")
    return src, room


def run_steps(src, seconds, start=0.0):
    for i in range(int(seconds * 10) + 1):
        src.detect_once(now=start + i * 0.1)
    return src.detections()


def test_room_consent_off_never_enrols():
    store = Store(":memory:")
    src, _ = room_source(store, [face_row(100)], text=None)
    run_steps(src, 3)
    assert store.list_people() == []


def test_room_consent_enrols_after_stability_window():
    store = Store(":memory:")
    src, _ = room_source(store, [face_row(100)])
    run_steps(src, 0.5)
    assert store.list_people() == []
    state = run_steps(src, 0.5, start=0.6)
    people = store.list_people()
    assert len(people) == 1 and people[0]["name"] == "Guest 1" and people[0]["auto"]
    assert people[0]["consentNote"] == "room consent session: team said yes"
    assert store.thumb(people[0]["id"])[:2] == b"\xff\xd8"
    assert state["faces"][0]["personId"] == people[0]["id"]
    run_steps(src, 1.0, start=3.0)
    assert len(store.list_people()) == 1


def test_room_consent_skips_poor_faces():
    store = Store(":memory:")
    src, _ = room_source(store, [face_row(100, size=50), face_row(400, score=0.5)])
    run_steps(src, 3)
    assert store.list_people() == []


def test_room_consent_cap():
    store = Store(":memory:")
    src, _ = room_source(store, [face_row(20), face_row(200), face_row(400)], cap=2)
    run_steps(src, 3)
    assert store.count_auto() == 2


def test_room_consent_requires_text():
    from sources import RoomConsent
    with pytest.raises(ValueError):
        RoomConsent(Store(":memory:"), "   ")


def test_session_wipe_and_rename(tmp_path):
    store = Store(":memory:")
    keep = store.enrol("Ben", np.ones(128, np.float32), "asked in person")
    src, room = room_source(store, [face_row(100), face_row(400)])
    run_steps(src, 2)
    app = create_app(store, src, tmp_path, web_dir=tmp_path / "noweb", room=room)
    with TestClient(app) as client:
        assert core(client.get("/api/session").json()) == {"roomConsent": True, "text": "team said yes",
                                                           "autoEnrolled": 2}
        with client.websocket_connect("/ws") as ws:
            assert core(ws.receive_json()) == {"type": "session", "roomConsent": True, "text": "team said yes",
                                               "autoEnrolled": 2}
        guest = [p for p in store.list_people() if p["auto"]][0]["id"]
        client.post(f"/api/people/{guest}/notes", json={"text": "hi"})
        client.post(f"/api/people/{guest}/model", files={"file": ("x.glb", GLB, "model/gltf-binary")})
        r = client.patch(f"/api/people/{guest}", json={"name": "Aino", "role": "PM"})
        assert r.status_code == 200 and r.json()["name"] == "Aino" and r.json()["autoEnrolled"] is True
        assert client.patch(f"/api/people/{guest}", json={"name": "  "}).status_code == 400
        assert client.patch(f"/api/people/{guest}", json={}).status_code == 400
        assert client.patch("/api/people/999", json={"name": "x"}).status_code == 404
        assert client.post("/api/session/wipe").status_code == 204
        assert [p["id"] for p in client.get("/api/people").json()] == [keep]
        assert store.notes(guest) == [] and store.thumb(guest) is None
        assert not (tmp_path / "models" / f"{guest}.glb").exists()
        assert client.get("/api/session").json()["autoEnrolled"] == 0


def test_session_off_by_default(demo):
    client, _, _ = demo
    assert core(client.get("/api/session").json()) == {"roomConsent": False, "text": None, "autoEnrolled": 0}
    with client.websocket_connect("/ws") as ws:
        assert ws.receive_json()["type"] == "session"


def test_room_consent_store_is_ephemeral(tmp_path):
    db = tmp_path / "memory.db"
    store, _, temp_dir = server.open_store("camera", str(db), str(tmp_path / "data"), "team said yes", keep=False)
    store.enrol("Guest 1", np.ones(128, np.float32), "room consent session: x", auto=True)
    assert not db.exists() and temp_dir
    kept, _, none_dir = server.open_store("camera", str(db), str(tmp_path / "data"), "team said yes", keep=True)
    assert db.exists() and none_dir is None and kept.list_people() == []
    plain, _, _ = server.open_store("camera", str(db), str(tmp_path / "data"))
    assert plain.count_auto() == 0


def test_demo_room_consent_auto_enrols_late_stranger():
    from sources import RoomConsent
    store = Store(":memory:")
    src = DemoSource(store, room=RoomConsent(store, "demo"))
    t0 = src.t0
    first = src.detections(now=t0 + 1)
    assert len(first["faces"]) == 4 and store.count_auto() == 0
    later = src.detections(now=t0 + 13)
    assert len(later["faces"]) == 5 and store.count_auto() == 2
    assert all(f["personId"] for f in later["faces"])
    plain = DemoSource(Store(":memory:"))
    assert len(plain.detections(now=plain.t0 + 20)["faces"]) == 4


def test_default_auto_text_is_stored_without_claiming_consent():
    from sources import RoomConsent
    store = Store(":memory:")
    room = RoomConsent(store, server.room_text("camera"), prefix="")
    src = IngestSource(store, faces=FakeFaces([face_row(100)]), room=room)
    src._set_frame(np.random.default_rng(0).integers(0, 255, (480, 640, 3), dtype=np.uint8), b"\xff\xd8")
    run_steps(src, 2)
    note = store.list_people()[0]["consentNote"]
    assert note == server.AUTO_TEXT and "individual consent not recorded" in note


def guest_app(tmp_path, monkeypatch, candidates):
    store = Store(":memory:")
    pid = store.enrol("Guest 1", np.ones(128, np.float32), "auto", auto=True, name_source="placeholder")
    mod = types.SimpleNamespace(
        process_audio=lambda p, n, k: {"transcript": "Hi, I'm Aino", "summary": "auto summary",
                                       "tags": ["auto"], "followups": []},
        extract_names=lambda text: candidates)
    monkeypatch.setitem(sys.modules, "notes", mod)
    app = create_app(store, IngestSource(store, faces=NoFaces()), tmp_path, web_dir=tmp_path / "noweb")
    return store, pid, app


def test_names_from_speech_rename_placeholder(tmp_path, monkeypatch):
    store, pid, app = guest_app(tmp_path, monkeypatch, [{"name": "Aino", "confidence": 0.9, "quote": "I'm Aino"},
                                                        {"name": "Bob", "confidence": 0.3, "quote": "Bob"}])
    with TestClient(app) as client:
        body = talk(client, f"/api/ingest/audio?personId={pid}", content=b"RIFFx",
                    headers={"content-type": "audio/wav"})
        assert body["name"] == "Aino" and body["nameSource"] == "audio"
        assert any(n["text"] == "named from speech: 'I'm Aino'" for n in body["notes"])
        assert client.patch(f"/api/people/{pid}", json={"name": "Aino K"}).json()["nameSource"] == "manual"
        store.rename(pid, "Guest 1", source="manual")
        talk(client, f"/api/people/{pid}/conversation", files={"file": ("a.wav", b"RIFF", "audio/wav")})
        assert store.get_person(pid)["name"] == "Guest 1"


def test_names_from_speech_low_confidence_or_missing(tmp_path, monkeypatch):
    store, pid, app = guest_app(tmp_path, monkeypatch, [{"name": "Aino", "confidence": 0.5, "quote": "x"}])
    with TestClient(app) as client:
        talk(client, f"/api/people/{pid}/conversation", files={"file": ("a.wav", b"RIFF", "audio/wav")})
        assert store.get_person(pid)["name"] == "Guest 1"
        del sys.modules["notes"].extract_names
        body = talk(client, f"/api/people/{pid}/conversation", files={"file": ("a.wav", b"RIFF", "audio/wav")})
        assert body["name"] == "Guest 1" and body["notes"][-1]["text"] == "Hi, I'm Aino"


def test_manual_fields_survive_automatic_updates(tmp_path, monkeypatch):
    store, pid, app = guest_app(tmp_path, monkeypatch, [])
    with TestClient(app) as client:
        r = client.patch(f"/api/people/{pid}", json={"summary": " mine ", "tags": ["a", "a", " b "],
                                                      "followups": ["call"], "role": "PM"})
        assert r.json()["tags"] == ["a", "b"] and set(r.json()["edited"]) == {"summary", "tags", "followups", "role"}
        assert client.patch(f"/api/people/{pid}", json={"tags": ["x"] * 13}).status_code == 400
        assert client.patch(f"/api/people/{pid}", json={"summary": "s" * 2001}).status_code == 400
        body = talk(client, f"/api/people/{pid}/conversation", files={"file": ("a.wav", b"RIFF", "audio/wav")})
        assert body["summary"] == "mine" and body["role"] == "PM" and body["tags"] == ["a", "b"]


def test_note_ids_and_delete(demo):
    client, _, _ = demo
    note = client.post("/api/people/1/notes", json={"text": "temp"}).json()
    notes = client.get("/api/people/1").json()["notes"]
    assert notes[-1]["id"] == note["id"]
    assert client.delete(f"/api/people/1/notes/{note['id']}").status_code == 204
    assert all(n["id"] != note["id"] for n in client.get("/api/people/1").json()["notes"])
    assert client.delete(f"/api/people/1/notes/{note['id']}").status_code == 404
    assert client.delete(f"/api/people/2/notes/{notes[0]['id']}").status_code == 404


def test_pinned_snapshot_and_snapshot_list(demo):
    client, store, _ = demo
    png = cv2.imencode(".png", np.full((600, 400, 3), 200, np.uint8))[1].tobytes()
    assert client.post("/api/people/1/snapshot", files={"file": ("a.gif", b"GIF89a", "image/gif")}).status_code == 400
    assert client.post("/api/people/1/snapshot", content=b"\x89PNG\r\n\x1a\nbad").status_code == 400
    r = client.post("/api/people/1/snapshot", files={"file": ("a.png", png, "image/png")})
    assert r.status_code == 200 and r.json()["thumbUrl"].startswith("/api/people/1/thumb.jpg?v=")
    pinned = client.get("/api/people/1/thumb.jpg").content
    assert cv2.imdecode(np.frombuffer(pinned, np.uint8), 1).shape[:2] == (256, 170)
    store.add_snapshot(1, jpeg(), 1e9, clear=True)
    assert client.get("/api/people/1/thumb.jpg").content == pinned
    assert "thumb" in client.get("/api/people/1").json()["edited"]
    snaps = client.get("/api/people/1/snapshots").json()
    assert snaps[0]["pinned"] and len(snaps) == 3
    assert client.get(snaps[1]["url"]).content[:2] == b"\xff\xd8"
    assert client.delete("/api/people/1/snapshot").status_code == 204
    assert client.get("/api/people/1/thumb.jpg").content == jpeg()
    assert client.get("/api/people/1/snapshots/999.jpg").status_code == 404


def test_hotwords_and_warm_up(tmp_path, monkeypatch):
    seen = {}
    store = Store(":memory:")
    pid = store.enrol("Sam", np.ones(128, np.float32), "yes")
    store.enrol("Guest 1", np.ones(128, np.float32), "auto", name_source="placeholder")

    def process_audio(path, person_name, known_notes, hotwords=None):
        seen["hot"] = hotwords
        return {"transcript": "", "summary": "", "tags": ["x"], "followups": []}

    mod = types.SimpleNamespace(process_audio=process_audio, warm_up=lambda: seen.setdefault("warm", True))
    monkeypatch.setitem(sys.modules, "notes", mod)
    app = create_app(store, IngestSource(store, faces=NoFaces()), tmp_path, web_dir=tmp_path / "noweb",
                     warm_notes=True)
    with TestClient(app) as client:
        for _ in range(50):
            if seen.get("warm"):
                break
            time.sleep(0.02)
        assert seen.get("warm") is True
        body = talk(client, f"/api/people/{pid}/conversation", files={"file": ("a.wav", b"RIFF", "audio/wav")})
        assert seen["hot"] == ["Sam"] and body["tags"] == []
