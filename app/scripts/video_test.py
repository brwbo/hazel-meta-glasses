import argparse
import asyncio
import io
import json
import re
import socket
import statistics
import subprocess
import sys
import time
import wave
from pathlib import Path

import av
import cv2
import httpx
import numpy as np
import websockets

ROOT = Path(__file__).resolve().parent.parent
FPS = 12.0
LONG_SIDE = 640
JPEG_Q = 60
SR = 16000
HOP = 320
MAX_UTT = 2.5
PRE_ROLL = 0.3
END_SILENCE = 0.45
MIN_UTT = 0.4
BLOCKED_PORTS = {8800, 8801, 8810, 8811, 8834}
CHUNK_RE = re.compile(r"audio chunk: queued ([\d.]+)s, processed ([\d.]+)s")


def port_free(port):
    with socket.socket() as s:
        return s.connect_ex(("127.0.0.1", port)) != 0


def pick_port(start):
    for port in range(start, start + 60):
        if port not in BLOCKED_PORTS and port_free(port):
            return port
    raise SystemExit("no free port found")


def decode_audio(path, start, dur):
    chunks = []
    try:
        with av.open(str(path)) as c:
            stream = next((s for s in c.streams if s.type == "audio"), None)
            if stream is None:
                return np.zeros(0, np.float32)
            res = av.AudioResampler(format="flt", layout="mono", rate=SR)
            try:
                for frame in c.decode(stream):
                    for out in res.resample(frame):
                        chunks.append(out.to_ndarray().reshape(-1))
                    if sum(len(x) for x in chunks) > (start + dur + 1) * SR:
                        break
            except av.error.FFmpegError:
                pass
    except av.error.FFmpegError:
        return np.zeros(0, np.float32)
    if not chunks:
        return np.zeros(0, np.float32)
    audio = np.concatenate(chunks).astype(np.float32)
    return audio[int(start * SR):int((start + dur) * SR)]


def segment(audio):
    n = len(audio) // HOP
    if n == 0:
        return []
    rms = np.sqrt((audio[:n * HOP].reshape(n, HOP) ** 2).mean(axis=1))
    thr = max(0.008, 2.5 * float(np.percentile(rms, 10)))
    hop_s = HOP / SR
    out, begin, quiet = [], None, 0
    for i, loud in enumerate(rms > thr):
        if begin is None:
            if loud:
                begin, quiet = max(0, i - int(PRE_ROLL / hop_s)), 0
            continue
        quiet = 0 if loud else quiet + 1
        length = (i - begin + 1) * hop_s
        if quiet * hop_s >= END_SILENCE or length >= MAX_UTT:
            if length - quiet * hop_s >= MIN_UTT:
                out.append((begin * hop_s, (i + 1) * hop_s))
            begin = None
    if begin is not None and (n - begin) * hop_s >= MIN_UTT:
        out.append((begin * hop_s, n * hop_s))
    return out


def wav_bytes(samples):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((np.clip(samples, -1, 1) * 32767).astype(np.int16).tobytes())
    return buf.getvalue()


class FrameReader:
    def __init__(self, path, start):
        self.cap = cv2.VideoCapture(str(path))
        if not self.cap.isOpened():
            raise SystemExit(f"cannot open {path}")
        self.src_fps = self.cap.get(cv2.CAP_PROP_FPS) or 25.0
        self.index = 0
        self.frame = None
        self.skip_to(start)

    def skip_to(self, t):
        want = int(round(t * self.src_fps))
        while self.index <= want:
            ok, frame = self.cap.read()
            if not ok:
                return False
            self.frame = frame
            self.index += 1
        return True

    def jpeg(self):
        h, w = self.frame.shape[:2]
        s = min(1.0, LONG_SIDE / max(h, w))
        img = self.frame if s >= 1 else cv2.resize(self.frame, (int(w * s), int(h * s)), interpolation=cv2.INTER_AREA)
        return img, cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, JPEG_Q])[1].tobytes()


class Run:
    def __init__(self, clip, args, out):
        self.clip, self.args, self.out = clip, args, out
        self.start, self.dur = float(clip.get("start", 0)), float(min(clip.get("dur", args.max_dur), args.max_dur))
        self.frames, self.dets, self.transcripts, self.sessions = [], [], [], []
        self.audio_log, self.cpu, self.people_poll = [], [], []
        self.latest_faces = []
        self.samples = {}
        self.done = False

    async def send_frames(self, base):
        reader = FrameReader(self.clip["file"], self.start)
        total = int(self.dur * FPS)
        sample_at = {int(total * f) for f in (0.1, 0.3, 0.5, 0.7, 0.9)}
        async with websockets.connect(f"ws://127.0.0.1:{self.args.port}/ingest", max_size=None) as ws:
            self.t0 = time.time()
            for k in range(total):
                if not await asyncio.to_thread(reader.skip_to, self.start + k / FPS):
                    break
                img, data = await asyncio.to_thread(reader.jpeg)
                delay = self.t0 + k / FPS - time.time()
                if delay > 0:
                    await asyncio.sleep(delay)
                await ws.send(data)
                self.frames.append((k, time.time()))
                if k in sample_at:
                    self.samples[k] = (time.time(), img.copy())
        self.t_end = time.time()

    async def listen(self):
        async with websockets.connect(f"ws://127.0.0.1:{self.args.port}/ws", max_size=None) as ws:
            while not self.done:
                try:
                    msg = json.loads(await asyncio.wait_for(ws.recv(), 0.5))
                except asyncio.TimeoutError:
                    continue
                except websockets.ConnectionClosed:
                    break
                now = time.time()
                kind = msg.get("type")
                if kind == "detections":
                    if msg.get("live"):
                        self.latest_faces = msg["faces"]
                        if not self.dets or self.dets[-1][1] != msg["ts"]:
                            self.dets.append((now, msg["ts"], msg["faces"]))
                    else:
                        self.latest_faces = []
                elif kind == "transcript":
                    self.transcripts.append({"t": now, "personId": msg.get("personId"), "text": msg.get("text", "")})
                elif kind == "session":
                    self.sessions.append(msg)

    async def send_audio(self, client, audio):
        for a, b in segment(audio):
            while not hasattr(self, "t0"):
                await asyncio.sleep(0.02)
            delay = self.t0 + b - time.time()
            if delay > 0:
                await asyncio.sleep(delay)
            if hasattr(self, "t_end"):
                break
            enrolled = [f for f in self.latest_faces if f.get("personId")]
            entry = {"start": round(a, 2), "end": round(b, 2), "inView": len(enrolled)}
            params = {}
            if self.args.mode == "page":
                if len(enrolled) != 1:
                    entry["sent"] = False
                    self.audio_log.append(entry)
                    continue
                params["personId"] = enrolled[0]["personId"]
            body = wav_bytes(audio[int(a * SR):int(b * SR)])
            sent = time.time()
            try:
                r = await client.post("/api/ingest/audio", params=params, content=body,
                                      headers={"Content-Type": "audio/wav"})
                entry.update(sent=True, t=sent, status=r.status_code, reply=r.json())
            except (httpx.HTTPError, ValueError) as exc:
                entry.update(sent=True, t=sent, status=0, reply={"error": type(exc).__name__})
            self.audio_log.append(entry)

    async def poll(self, client, pid):
        while not self.done:
            try:
                people = (await client.get("/api/people")).json()
                self.people_poll.append((time.time(), [(p["id"], p["name"], p["thumbClear"]) for p in people]))
            except (httpx.HTTPError, ValueError):
                pass
            ps = await asyncio.to_thread(subprocess.run, ["ps", "-o", "%cpu=,rss=", "-p", str(pid)],
                                         capture_output=True, text=True)
            parts = ps.stdout.split()
            if len(parts) == 2:
                self.cpu.append((float(parts[0]), int(parts[1]) / 1024))
            await asyncio.sleep(1.0)

    async def go(self, server_pid):
        audio = np.zeros(0, np.float32) if self.args.mode == "off" else decode_audio(self.clip["file"], self.start, self.dur)
        self.audio_secs = len(audio) / SR
        async with httpx.AsyncClient(base_url=f"http://127.0.0.1:{self.args.port}", timeout=20) as client:
            side = [asyncio.create_task(self.listen()), asyncio.create_task(self.poll(client, server_pid))]
            await asyncio.sleep(0.5)
            await asyncio.gather(self.send_frames(None), self.send_audio(client, audio))
            quiet_since, seen = time.time(), len(self.transcripts)
            while time.time() - self.t_end < 45 and time.time() - quiet_since < 7:
                await asyncio.sleep(0.5)
                if len(self.transcripts) != seen:
                    quiet_since, seen = time.time(), len(self.transcripts)
            self.people = []
            for p in (await client.get("/api/people")).json():
                full = (await client.get(f"/api/people/{p['id']}")).json()
                thumb = await client.get(f"/api/people/{p['id']}/thumb.jpg")
                if thumb.status_code == 200:
                    (self.out / f"thumb_{p['id']}.jpg").write_bytes(thumb.content)
                self.people.append({"id": p["id"], "name": full["name"], "nameSource": full.get("nameSource"),
                                    "thumbClear": full.get("thumbClear"), "consentAt": full.get("consentAt"),
                                    "notes": [n["text"] for n in full.get("notes", [])]})
            self.done = True
            await asyncio.gather(*side, return_exceptions=True)


def draw_samples(run):
    counts = []
    for k, (sent, img) in sorted(run.samples.items()):
        after = [d for d in run.dets if d[0] >= sent]
        faces = after[min(1, len(after) - 1)][2] if after else []
        for f in faces:
            x, y, w, h = [int(v) for v in f["box"]]
            colour = (0, 200, 255) if f["predicted"] else ((0, 255, 0) if f["personId"] else (0, 0, 255))
            cv2.rectangle(img, (x, y), (x + w, y + h), colour, 2)
            cv2.putText(img, f"t{f['trackId']} p{f['personId']}", (x, max(12, y - 4)),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.45, colour, 1)
        cv2.imwrite(str(run.out / f"sample_{k:04d}.jpg"), img)
        counts.append(sum(1 for f in faces if not f["predicted"]))
    return counts


def pct(values, q):
    return round(float(np.percentile(values, q)), 3) if values else None


def metrics(run, log_text):
    dets, frames = run.dets, run.frames
    send_times = np.array([t for _, t in frames]) if frames else np.zeros(0)
    obs = [f for _, _, faces in dets for f in faces]
    real = [f for f in obs if not f["predicted"]]
    with_face = sum(1 for _, _, faces in dets if any(not f["predicted"] for f in faces))
    lat, age = [], []
    for recv, ts, _ in dets:
        i = int(np.searchsorted(send_times, ts, side="right")) - 1
        if i >= 0:
            lat.append(recv - send_times[i])
            age.append(recv - ts)
    tracks_of, pids_of, first_track, first_pid = {}, {}, {}, {}
    last, jitter, shared = {}, [], 0
    for recv, ts, faces in dets:
        ids = [f["personId"] for f in faces if f["personId"] and not f["predicted"]]
        shared += len(ids) != len(set(ids))
        for f in faces:
            tid, pid = f["trackId"], f["personId"]
            first_track.setdefault(tid, ts)
            if pid:
                tracks_of.setdefault(pid, [])
                if tid not in tracks_of[pid]:
                    tracks_of[pid].append(tid)
                pids_of.setdefault(tid, [])
                if not pids_of[tid] or pids_of[tid][-1] != pid:
                    pids_of[tid].append(pid)
                if pid not in first_pid:
                    first_pid[pid] = (ts, tid)
            if f["predicted"]:
                last.pop(tid, None)
                continue
            x, y, w, h = f["box"]
            c = (x + w / 2, y + h / 2, max(w, h, 1.0))
            hist = last.setdefault(tid, [])
            hist.append(c)
            if len(hist) >= 3:
                a, b, d = hist[-3:]
                jitter.append(float(np.hypot(a[0] - 2 * b[0] + d[0], a[1] - 2 * b[1] + d[1]) / d[2]))
    enrol_delay = [round(ts - first_track[tid], 2) for ts, tid in first_pid.values()]
    sent = [a for a in run.audio_log if a.get("sent")]
    queued = [a for a in sent if a.get("reply", {}).get("queued")]
    chunk_lat = [(float(q), float(p)) for q, p in CHUNK_RE.findall(log_text) if float(p) >= 0.01]
    people = run.people
    return {
        "id": run.clip["id"], "mode": run.args.mode, "label": run.args.label, "clipSeconds": run.dur,
        "framesSent": len(frames),
        "sendFps": round(len(frames) / max(1e-6, frames[-1][1] - frames[0][1]), 2) if len(frames) > 1 else 0,
        "detectPasses": len(dets),
        "detectHz": round(len(dets) / max(1e-6, dets[-1][1] - dets[0][1]), 2) if len(dets) > 1 else 0,
        "detectionRate": round(with_face / len(dets), 3) if dets else 0,
        "facesPerPass": round(len(real) / len(dets), 2) if dets else 0,
        "sampleFaceCounts": draw_samples(run),
        "truth": run.clip.get("truth"),
        "tracksCreated": len(first_track),
        "peopleEnrolled": len(people),
        "truePeople": run.clip.get("people"),
        "trackSwitchesPerPerson": {str(p): len(t) - 1 for p, t in tracks_of.items()},
        "identityChangesOnTrack": sum(len(p) - 1 for p in pids_of.values()),
        "sameIdOnTwoFacesPasses": shared,
        "enrolDelaySec": enrol_delay,
        "firstEnrolAfterStart": round(min(v[0] for v in first_pid.values()) - run.t0, 2) if first_pid else None,
        "thumbClearPeople": round(sum(1 for p in people if p["thumbClear"]) / len(people), 2) if people else None,
        "thumbClearObs": round(sum(1 for f in obs if f.get("thumbClear")) / len(obs), 3) if obs else None,
        "predictedShare": round(sum(1 for f in obs if f["predicted"]) / len(obs), 3) if obs else None,
        "enrolledShare": round(sum(1 for f in real if f["personId"]) / len(real), 3) if real else None,
        "jitterMedian": pct(jitter, 50), "jitterP95": pct(jitter, 95),
        "latencyMedian": pct(lat, 50), "latencyP95": pct(lat, 95),
        "detectComputeMedian": pct(age, 50), "detectComputeP95": pct(age, 95),
        "cpuMean": round(statistics.mean(c for c, _ in run.cpu), 1) if run.cpu else None,
        "cpuMax": max((c for c, _ in run.cpu), default=None),
        "rssMaxMB": round(max((m for _, m in run.cpu), default=0)),
        "audioSeconds": round(run.audio_secs, 1),
        "chunksCut": len(run.audio_log), "chunksSent": len(sent), "chunksQueued": len(queued),
        "chunksSkippedByRule": len(run.audio_log) - len(sent),
        "chunksNoPerson": sum(1 for a in sent if a.get("reply", {}).get("stored") is False),
        "chunksDroppedByQueue": sum(a.get("reply", {}).get("dropped", 0) for a in sent),
        "chunksProcessed": len(chunk_lat),
        "transcripts": len(run.transcripts),
        "queueWaitMedian": pct([q for q, _ in chunk_lat], 50), "queueWaitMax": pct([q for q, _ in chunk_lat], 100),
        "sttMedian": pct([p for _, p in chunk_lat], 50), "sttP95": pct([p for _, p in chunk_lat], 95),
        "audioToTranscriptMedian": pct([q + p for q, p in chunk_lat], 50),
        "audioToTranscriptP95": pct([q + p for q, p in chunk_lat], 95),
        "transcriptText": [{"at": round(t["t"] - run.t0, 1), "personId": t["personId"], "text": t["text"]}
                           for t in run.transcripts],
        "people": [{k: p[k] for k in ("id", "name", "nameSource", "thumbClear")} | {"notes": len(p["notes"])}
                   for p in people],
        "audioLog": [{k: v for k, v in a.items() if k != "t"} for a in run.audio_log],
        "serverErrors": [line for line in log_text.splitlines()
                         if "WARNING" in line or "ERROR" in line or "Traceback" in line][:20],
    }


def start_server(root, port, log_path):
    log = open(log_path, "w")
    proc = subprocess.Popen(
        [str(ROOT / ".venv/bin/python"), str(Path(root) / "src/server.py"), "--source", "ingest", "--port", str(port),
         "--host", "127.0.0.1", "--no-cloud-speech"],
        cwd=str(Path(log_path).parent), stdout=log, stderr=subprocess.STDOUT)
    deadline = time.time() + 60
    while time.time() < deadline:
        if proc.poll() is not None:
            raise SystemExit(f"server exited early, see {log_path}")
        try:
            if httpx.get(f"http://127.0.0.1:{port}/api/session", timeout=2).status_code == 200:
                return proc, log
        except httpx.HTTPError:
            time.sleep(0.5)
    proc.terminate()
    raise SystemExit("server did not come up")


def stop_server(proc, log):
    proc.terminate()
    try:
        proc.wait(10)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(5)
    log.close()


def run_clip(clip, args):
    out = Path(args.out) / args.label / f"{clip['id']}_{args.mode}"
    out.mkdir(parents=True, exist_ok=True)
    args.port = pick_port(args.base_port)
    log_path = out / "server.log"
    proc, log = start_server(args.root, args.port, log_path)
    run = Run(clip, args, out)
    try:
        time.sleep(args.warm)
        asyncio.run(run.go(proc.pid))
    finally:
        stop_server(proc, log)
    result = metrics(run, log_path.read_text(errors="replace"))
    (out / "trace.json").write_text(json.dumps([[round(ts - run.t0, 3), faces] for _, ts, faces in run.dets]))
    (out / "result.json").write_text(json.dumps(result, indent=1, ensure_ascii=False))
    return result


def summary_line(r):
    switches = sum(r["trackSwitchesPerPerson"].values())
    return (f"{r['id']:<12} {r['mode']:<5} frames={r['framesSent']} det={r['detectionRate']} faces/pass={r['facesPerPass']} "
            f"samples={r['sampleFaceCounts']} truth={r['truth']} people={r['peopleEnrolled']}/{r['truePeople']} "
            f"tracks={r['tracksCreated']} switches={switches} idchg={r['identityChangesOnTrack']} "
            f"shared={r['sameIdOnTwoFacesPasses']} "
            f"enrol={r['firstEnrolAfterStart']} clear={r['thumbClearPeople']} pred={r['predictedShare']} "
            f"jit={r['jitterMedian']}/{r['jitterP95']} lat={r['latencyMedian']}/{r['latencyP95']} hz={r['detectHz']} "
            f"cpu={r['cpuMean']}/{r['cpuMax']} chunks={r['chunksCut']}/{r['chunksSent']}/{r['chunksProcessed']} "
            f"drop={r['chunksDroppedByQueue']} tx={r['transcripts']} a2t={r['audioToTranscriptMedian']}/"
            f"{r['audioToTranscriptP95']} names={[p['name'] for p in r['people']]}")


def main():
    p = argparse.ArgumentParser(description="replay videos into a throwaway ingest server and measure it")
    p.add_argument("--manifest", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--only", default="")
    p.add_argument("--label", default="run")
    p.add_argument("--root", default=str(ROOT))
    p.add_argument("--mode", choices=["page", "auto", "off"], default="page")
    p.add_argument("--base-port", type=int, default=8821)
    p.add_argument("--max-dur", type=float, default=60.0)
    p.add_argument("--warm", type=float, default=12.0)
    args = p.parse_args()
    clips = json.loads(Path(args.manifest).read_text())
    only = {x for x in args.only.split(",") if x}
    for clip in clips:
        if only and clip["id"] not in only:
            continue
        if not Path(clip["file"]).is_file():
            print(f"{clip['id']}: file missing, skipped", flush=True)
            continue
        print(summary_line(run_clip(clip, args)), flush=True)


if __name__ == "__main__":
    sys.exit(main())
