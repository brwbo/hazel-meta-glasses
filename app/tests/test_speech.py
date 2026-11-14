import sys
import threading
import types
from pathlib import Path

import numpy as np
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
import media  # noqa: E402
import server  # noqa: E402
from sources import IngestSource  # noqa: E402
from speech import call_kw  # noqa: E402
from store import Store  # noqa: E402

WAV = {"content": b"RIFFdata", "headers": {"content-type": "audio/wav"}}


class InView(IngestSource):
    def __init__(self, store, ids):
        super().__init__(store)
        self.ids = ids

    def detections(self):
        return {"type": "detections", "faces": [{"personId": i, "box": [0, 0, 100 - n, 100 - n]}
                                                for n, i in enumerate(self.ids)]}


def hybrid_app(tmp_path, monkeypatch, gate=None, enrich_result=None, wearer="Ben"):
    calls = {"process": [], "enrich": []}

    def process_audio(path, person_name, known_notes, hotwords=None, lip=None, wearer=None, taken=None):
        calls["process"].append({"hotwords": hotwords, "wearer": wearer, "taken": taken})
        return {"transcript": "Hi, I'm Aino from Helsinki", "summary": "", "followups": []}

    def enrich(person_name, recent_transcript, known_notes, followups, hotwords, wearer, taken):
        if gate is not None:
            gate.wait(5)
        calls["enrich"].append({"name": person_name, "text": recent_transcript, "wearer": wearer, "taken": taken})
        return enrich_result or {"summary": "Aino works in Helsinki", "followups": ["Email Aino"],
                                 "names": [{"name": "Aino", "confidence": 0.9, "quote": "I'm Aino"}]}

    monkeypatch.setitem(sys.modules, "notes", types.SimpleNamespace(process_audio=process_audio, enrich=enrich))
    store = Store(":memory:")
    sam = store.enrol("Sam", np.ones(128), "yes")
    guest = store.enrol("Guest 1", -np.ones(128), "auto", auto=True, name_source="placeholder")
    priya = store.enrol("Priya", np.eye(128)[0], "yes")
    app = server.create_app(store, InView(store, [guest, sam]), tmp_path, web_dir=tmp_path / "noweb", wearer=wearer)
    return app, store, calls, (sam, guest, priya)


def test_hybrid_transcript_first_then_enrich_updates_person(tmp_path, monkeypatch):
    gate = threading.Event()
    app, store, calls, (sam, guest, priya) = hybrid_app(tmp_path, monkeypatch, gate)
    with TestClient(app) as client:
        with client.websocket_connect("/ws") as ws:
            assert client.post(f"/api/ingest/audio?personId={guest}", **WAV).status_code == 202
            assert app.state.audio.join(5)
            assert store.notes(guest)[-1][1] == "Hi, I'm Aino from Helsinki"
            assert store.get_person(guest)["name"] == "Guest 1"
            types_seen = []
            while "transcript" not in types_seen:
                types_seen.append(ws.receive_json()["type"])
            gate.set()
            assert app.state.speech.enrich_queue.join(5)
            while ws.receive_json() != {"type": "person", "id": guest}:
                pass
    p = store.get_person(guest)
    assert p["name"] == "Aino" and p["nameSource"] == "audio" and p["summary"] == "Aino works in Helsinki"
    assert p["followups"] == ["Email Aino"]
    assert calls["process"][0] == {"hotwords": ["Sam"], "wearer": "Ben", "taken": ["Sam", "Priya"]}
    assert calls["enrich"][0]["wearer"] == "Ben" and calls["enrich"][0]["taken"] == ["Sam", "Priya"]


def test_enrich_never_renames_manual_name(tmp_path, monkeypatch):
    app, store, calls, (sam, guest, priya) = hybrid_app(tmp_path, monkeypatch)
    store.rename(guest, "Mia", source="manual")
    with TestClient(app) as client:
        client.post(f"/api/ingest/audio?personId={guest}", **WAV)
        assert app.state.audio.join(5) and app.state.speech.enrich_queue.join(5)
    assert store.get_person(guest)["name"] == "Mia"


def test_enrich_queue_dedupes_per_person_and_drops_oldest():
    gate, done = threading.Event(), []
    q = media.AudioQueue(lambda job: (gate.wait(5), done.append(job)), maxlen=4, dedupe=True)
    q.start()
    q.submit((0, "busy"))
    while q.pending():
        pass
    for job in [(1, "a"), (2, "b"), (1, "c"), (3, "d"), (4, "e"), (5, "f")]:
        q.submit(job)
    assert [j for _, j in q.items] == [(1, "c"), (3, "d"), (4, "e"), (5, "f")] and q.dropped == 1
    gate.set()
    assert q.join(5)
    assert (1, "a") not in done and (1, "c") in done and len(done) == 5
    q.stop()


def test_enrich_failure_does_not_block_audio(tmp_path, monkeypatch):
    app, store, calls, (sam, guest, priya) = hybrid_app(tmp_path, monkeypatch, enrich_result="bad")
    with TestClient(app) as client:
        for _ in range(3):
            client.post(f"/api/ingest/audio?personId={guest}", **WAV)
            assert app.state.audio.join(5)
        assert app.state.speech.enrich_queue.join(5)
    assert len(store.notes(guest)) == 3 and store.get_person(guest)["name"] == "Guest 1"


def test_call_kw_filters_by_signature():
    assert call_kw(lambda a, b=None: (a, b), 1, b=2, c=3) == (1, 2)
    assert call_kw(lambda a, **kw: kw, 1, b=2) == {"b": 2}


def test_session_hybrid_reports_text_only_cloud(monkeypatch):
    monkeypatch.setitem(sys.modules, "notes", types.SimpleNamespace(
        engine=lambda: "gemini", status=lambda: {"cloud": True}, enrich=lambda **kw: {}))
    assert media.speech_status() == {"stt": "gemini", "cloudSpeech": True, "audioToCloud": False}
    assert "only transcript TEXT" in media.speech_banner()
    monkeypatch.setitem(sys.modules, "notes", types.SimpleNamespace(
        engine=lambda: "gemini", status=lambda: {"cloud": True, "audio_to_cloud": True}, enrich=lambda **kw: {}))
    assert media.speech_status()["audioToCloud"] is True


def test_wearer_flag_and_env(monkeypatch, capsys):
    seen = {}
    real = server.create_app
    monkeypatch.setattr(server, "create_app", lambda *a, **kw: seen.update(kw) or real(*a, **kw))
    monkeypatch.setitem(sys.modules, "uvicorn", types.SimpleNamespace(run=lambda *a, **k: None))
    monkeypatch.setitem(sys.modules, "notes", types.SimpleNamespace(engine=lambda: "local"))
    server.main(["--demo", "--wearer", "Ben"])
    assert seen["wearer"] == "Ben"
    monkeypatch.setenv("HAZEL_WEARER", "Ana")
    server.main(["--demo"])
    assert seen["wearer"] == "Ana"


def test_session_hybrid_with_local_engine_still_reports_cloud(monkeypatch):
    monkeypatch.setitem(sys.modules, "notes", types.SimpleNamespace(
        engine=lambda: "local", status=lambda: {"cloud": True, "audio_to_cloud": False}, enrich=lambda **kw: {}))
    assert media.speech_status() == {"stt": "local", "cloudSpeech": True, "audioToCloud": False}
    monkeypatch.setitem(sys.modules, "notes", types.SimpleNamespace(
        engine=lambda: "local", status=lambda: {"cloud": False, "audio_to_cloud": False}))
    assert media.speech_status() == {"stt": "local", "cloudSpeech": False, "audioToCloud": False}


def test_throttled_enrich_is_not_applied(tmp_path, monkeypatch):
    app, store, calls, (sam, guest, priya) = hybrid_app(tmp_path, monkeypatch, enrich_result={
        "summary": "rules", "followups": [], "source": "throttled",
        "names": [{"name": "Aino", "confidence": 0.9, "quote": "x"}]})
    with TestClient(app) as client:
        client.post(f"/api/ingest/audio?personId={guest}", **WAV)
        assert app.state.audio.join(5) and app.state.speech.enrich_queue.join(5)
    assert store.get_person(guest)["name"] == "Guest 1" and store.get_person(guest)["summary"] == ""
    assert calls["enrich"][0]["text"] == "Hi, I'm Aino from Helsinki"
