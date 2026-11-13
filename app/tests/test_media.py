import sys
import threading
import time
from pathlib import Path

import cv2
import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
import server  # noqa: E402
from media import AudioQueue, audio_suffix, call_process, image_to_jpeg  # noqa: E402


def test_audio_suffix():
    assert audio_suffix("a.M4A", "") == ".m4a"
    assert audio_suffix("", "audio/webm;codecs=opus") == ".webm"
    assert audio_suffix("", "audio/x-something") == ".audio"
    assert audio_suffix("a.txt", "text/plain") is None


def test_image_to_jpeg_resizes_and_validates():
    png = cv2.imencode(".png", np.zeros((1000, 500, 3), np.uint8))[1].tobytes()
    out = image_to_jpeg(png)
    assert out[:2] == b"\xff\xd8"
    assert cv2.imdecode(np.frombuffer(out, np.uint8), 1).shape[:2] == (256, 128)
    with pytest.raises(ValueError):
        image_to_jpeg(b"GIF89a....")
    with pytest.raises(ValueError):
        image_to_jpeg(b"\xff\xd8\xffgarbage")


def test_audio_queue_is_bounded_and_drops_oldest():
    gate, done = threading.Event(), []

    def handler(job):
        gate.wait(5)
        done.append(job)

    q = AudioQueue(handler, maxlen=2)
    q.start()
    assert q.submit("a") == 0
    deadline = time.time() + 2
    while q.pending() and time.time() < deadline:
        time.sleep(0.01)
    t0 = time.time()
    assert [q.submit(x) for x in "bcde"] == [0, 0, 1, 1]
    assert time.time() - t0 < 0.1
    assert q.pending() == 2 and q.dropped == 2
    gate.set()
    assert q.join(5)
    assert done == ["a", "d", "e"]
    q.stop()


def test_audio_queue_survives_handler_errors():
    seen = []

    def handler(job):
        seen.append(job)
        if job == 1:
            raise RuntimeError("boom")

    q = AudioQueue(handler)
    q.start()
    q.submit(1)
    q.submit(2)
    assert q.join(5) and seen == [1, 2]
    q.stop()


def test_call_process_passes_hotwords_only_when_supported():
    assert call_process(lambda p, n, k: (p, n, k), "f", "Sam", [], ["Sam"]) == ("f", "Sam", [])
    assert call_process(lambda p, n, k, hotwords=None: hotwords, "f", "Sam", [], ["Sam"]) == ["Sam"]



def test_room_text_defaults():
    assert server.room_text("demo") == server.DEMO_ROOM_TEXT
    assert server.room_text("demo", no_auto=True) is None
    assert server.room_text("demo", "Ben's team said yes") == "Ben's team said yes"
    assert server.room_text("camera") == server.AUTO_TEXT and server.room_text("ingest") == server.AUTO_TEXT
    assert server.room_text("ingest", no_auto=True) is None
    assert server.room_text("camera", "team said yes") == "team said yes"
    assert server.room_text("camera", "team said yes", no_auto=True) is None


def test_lan_ip_is_string():
    assert isinstance(server.lan_ip(), str)


def test_lip_gate():
    import media
    assert media.lip_gate(None) is None and media.lip_gate(0.9) is None
    assert media.lip_gate(media.LIP_MIN - 0.01) == "lips"
    for bad in (-0.1, 1.5, float("nan")):
        with pytest.raises(Exception):
            media.lip_gate(bad)


def test_call_process_passes_lip_only_when_supported():
    assert call_process(lambda p, n, k, hotwords=None: hotwords, "f", "S", [], ["S"], 0.8) == ["S"]
    assert call_process(lambda p, n, k, lip=None: lip, "f", "S", [], [], 0.8) == 0.8
    assert call_process(lambda p, n, k, **kw: kw, "f", "S", [], ["S"], 0.8) == {"hotwords": ["S"], "lip": 0.8}
    assert call_process(lambda p, n, k, **kw: kw, "f", "S", [], [], None) == {"hotwords": []}


def test_low_lip_chunks_dropped_before_transcription(tmp_path, monkeypatch):
    import types
    from fastapi.testclient import TestClient
    from sources import IngestSource
    from store import Store
    calls = []

    def process_audio(path, name, known, hotwords=None, lip=None):
        calls.append(lip)
        return {"transcript": "hello", "summary": "", "tags": [], "followups": []}

    monkeypatch.setitem(sys.modules, "notes", types.SimpleNamespace(process_audio=process_audio))
    store = Store(":memory:")
    pid = store.enrol("Sam", np.ones(128, np.float32), "yes")
    app = server.create_app(store, IngestSource(store), tmp_path, web_dir=tmp_path / "noweb")
    wav = {"content": b"RIFFdata", "headers": {"content-type": "audio/wav"}}
    with TestClient(app) as client:
        r = client.post(f"/api/ingest/audio?personId={pid}&lip=0.1", **wav)
        assert r.status_code == 202 and r.json() == {"queued": False, "reason": "lips", "personId": pid}
        r = client.post(f"/api/people/{pid}/conversation?lip=0.2", files={"file": ("a.wav", b"RIFF", "audio/wav")})
        assert r.json()["reason"] == "lips"
        assert client.post(f"/api/ingest/audio?personId={pid}&lip=2", **wav).status_code == 400
        assert client.post(f"/api/ingest/audio?personId={pid}&lip=abc", **wav).status_code == 400
        assert client.post(f"/api/ingest/audio?personId={pid}&lip=0.8", **wav).json()["queued"] is True
        assert client.post(f"/api/ingest/audio?personId={pid}", **wav).json()["queued"] is True
        assert app.state.audio.join(5)
    assert calls == [0.8, None]
    assert [t for _, t in store.notes(pid)] == ["hello", "hello"]
