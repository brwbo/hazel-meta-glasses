import os
import sqlite3
import sys
import threading
import types
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
import media  # noqa: E402
import server  # noqa: E402
import sources  # noqa: E402
from demo import DemoSource  # noqa: E402
from sources import IngestSource, Tracker, assign_matches  # noqa: E402
from store import Store  # noqa: E402

GLB = b"glTF" + (2).to_bytes(4, "little") + (20).to_bytes(4, "little") + b"\x00" * 8


@pytest.fixture
def client(tmp_path):
    store = Store(":memory:")
    app = server.create_app(store, DemoSource(store), tmp_path, web_dir=tmp_path / "noweb")
    with TestClient(app) as c:
        yield c


def test_foreign_origin_and_host_rejected(client):
    note = {"text": "hi"}
    assert client.post("/api/people/1/notes", json=note).status_code == 201
    assert client.post("/api/people/1/notes", json=note, headers={"origin": "http://localhost:8800"}).status_code == 201
    assert client.post("/api/people/1/notes", json=note, headers={"origin": "https://evil.example"}).status_code == 403
    assert client.post("/api/people/1/notes", json=note, headers={"origin": "null"}).status_code == 403
    assert client.delete("/api/people/1", headers={"origin": "http://evil.example"}).status_code == 403
    assert client.get("/api/people", headers={"origin": "http://evil.example"}).status_code == 200
    assert client.get("/api/people", headers={"host": "evil.example"}).status_code == 403
    assert client.get("/api/people", headers={"host": "127.0.0.1:8800"}).status_code == 200
    with pytest.raises(Exception):
        with client.websocket_connect("/ws", headers={"origin": "http://evil.example"}) as ws:
            ws.receive_json()
    with client.websocket_connect("/ws", headers={"origin": "http://127.0.0.1:8800"}) as ws:
        assert ws.receive_json()["type"] == "session"


def run_main(monkeypatch, capsys, *args):
    seen = {}
    monkeypatch.setitem(sys.modules, "uvicorn", types.SimpleNamespace(run=lambda app, **kw: seen.update(kw)))
    monkeypatch.setitem(sys.modules, "notes", types.SimpleNamespace(engine=lambda: "local"))
    server.main(["--demo", *args])
    return seen["host"], capsys.readouterr().out


def test_binds_localhost_unless_lan(monkeypatch, capsys):
    host, out = run_main(monkeypatch, capsys)
    assert host == "127.0.0.1" and "add --lan" in out and "LAN http" not in out
    host, out = run_main(monkeypatch, capsys, "--lan")
    assert host == "0.0.0.0" and "LAN http" in out


def test_no_store_headers(client):
    client.post("/api/people/1/model", files={"file": ("x.glb", GLB, "model/gltf-binary")})
    for url in ("/api/people", "/api/people/1", "/api/people/1/thumb.jpg", "/api/people/1/snapshots", "/models/1.glb"):
        assert client.get(url).headers["cache-control"] == "no-store", url


def test_secure_delete_and_ids_never_reused():
    s = Store(":memory:")
    assert s.db.execute("PRAGMA secure_delete").fetchone()[0] == 1
    a = s.enrol("A", np.ones(128), "yes")
    s.delete_person(a)
    assert s.enrol("B", np.ones(128), "yes") == a + 1


def test_autoincrement_migration_keeps_rows(tmp_path):
    path = tmp_path / "old.db"
    db = sqlite3.connect(path)
    db.executescript(
        "CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT NOT NULL, consent_at REAL NOT NULL,"
        " consent_note TEXT NOT NULL, embedding BLOB NOT NULL);"
        "CREATE TABLE notes (id INTEGER PRIMARY KEY, person_id INTEGER NOT NULL REFERENCES people(id)"
        " ON DELETE CASCADE, ts REAL NOT NULL, text TEXT NOT NULL);"
    )
    db.execute("INSERT INTO people VALUES (5, 'Old', 1, 'yes', ?)", (np.ones(128, np.float32).tobytes(),))
    db.execute("INSERT INTO notes (person_id, ts, text) VALUES (5, 1, 'kept')")
    db.commit()
    db.close()
    s = Store(str(path))
    sql = s.db.execute("SELECT sql FROM sqlite_master WHERE name = 'people'").fetchone()[0]
    assert "AUTOINCREMENT" in sql and s.get_person(5)["name"] == "Old" and s.notes(5)[0][1] == "kept"
    s.delete_person(5)
    assert s.enrol("New", np.ones(128), "yes") == 6


def test_audio_queue_purge_and_delete_purges(tmp_path, monkeypatch):
    gate, done = threading.Event(), []
    q = media.AudioQueue(lambda job: (gate.wait(5), done.append(job)), maxlen=3)
    q.start()
    q.submit((9, "x"))
    while q.pending():
        pass
    q.submit((1, "a"))
    q.submit((2, "b"))
    assert q.purge(1) == 1 and q.pending() == 1
    gate.set()
    assert q.join(5) and [j[0] for j in done] == [9, 2]
    q.stop()


def test_delete_route_purges_queue_and_embs(tmp_path, monkeypatch):
    gate = threading.Event()
    monkeypatch.setitem(sys.modules, "notes", types.SimpleNamespace(
        process_audio=lambda *a, **k: gate.wait(5) and {"transcript": "late"}))
    store = Store(":memory:")
    a = store.enrol("A", np.ones(128), "yes")
    b = store.enrol("B", -np.ones(128), "yes")
    src = IngestSource(store)
    src._embs[b] = [(1.0, np.ones(128))]
    app = server.create_app(store, src, tmp_path, web_dir=tmp_path / "noweb")
    wav = {"content": b"RIFFx", "headers": {"content-type": "audio/wav"}}
    with TestClient(app) as c:
        c.post(f"/api/ingest/audio?personId={a}", **wav)
        c.post(f"/api/ingest/audio?personId={b}", **wav)
        assert c.delete(f"/api/people/{b}").status_code == 204
        assert app.state.audio.pending() == 0 and b not in src._embs
        gate.set()
        assert app.state.audio.join(5)


def test_identity_decays_and_forced_switch():
    t = Tracker()
    box = [100.0, 100.0, 80.0, 100.0]
    t.update([(box, (1, "Sam", 0.95))], 0.0)
    for i in range(1, 5):
        out = t.update([(box, (2, "Priya", 0.2))], i * 0.1)
        assert out[0]["personId"] == 1
    assert t.tracks[0]["score"] == pytest.approx(0.95 * 0.7 ** 4)
    out = t.update([(box, (2, "Priya", 0.2))], 0.5)
    assert out[0]["personId"] == 2


def test_assign_matches_one_to_one_and_margin():
    ranked = [[(1, "A", 0.9), (2, "B", 0.5)], [(1, "A", 0.8), (2, "B", 0.7)], [(1, "A", 0.6)]]
    matches, margins = assign_matches(ranked)
    assert [m and m[0] for m in matches] == [1, 2, None]
    assert margins[0] == pytest.approx(0.4) and margins[1] == pytest.approx(-0.1)


def test_refine_skipped_when_margin_small(monkeypatch):
    store = Store(":memory:")
    a = store.enrol("A", np.ones(128), "yes")
    store.enrol("B", np.ones(128) + 0.01, "yes")
    calls = []

    class Faces:
        def find(self, frame):
            return [np.array([100, 100, 150, 170, 140, 160, 200, 160, 170, 200, 145, 240, 195, 240, 0.95], np.float32)]

        def embed(self, frame, f):
            return np.ones(128, np.float32)

    src = IngestSource(store, faces=Faces())
    monkeypatch.setattr(src, "_refine", lambda pid, f, e, fr, now, ok: calls.append(ok))
    src._set_frame(np.full((480, 640, 3), 120, np.uint8))
    src.detect_once()
    assert calls == [False] and src.detections()["faces"][0]["personId"] == a


def test_video_jpeg_lazy_and_downscaled():
    src = IngestSource(Store(":memory:"))
    src._set_frame(np.zeros((1080, 1920, 3), np.uint8))
    assert src._jpeg is None
    out = sources.cv2.imdecode(np.frombuffer(src.jpeg(), np.uint8), 1)
    assert out.shape[1] == sources.VIDEO_MAX_WIDTH and src.jpeg() is src.jpeg()


def test_enrol_returns_409_for_known_face(tmp_path):
    store = Store(":memory:")
    first = store.enrol("Sam", np.ones(128), "yes")
    src = IngestSource(store)
    src.capture_face = lambda: (np.ones(128, np.float32), b"\xff\xd8x")
    app = server.create_app(store, src, tmp_path, web_dir=tmp_path / "noweb")
    with TestClient(app) as c:
        r = c.post("/api/enrol", json={"name": "Sam again", "consent": "yes"})
        assert r.status_code == 409 and r.json()["id"] == first
    assert len(store.list_people()) == 1


def test_limits_and_env():
    assert media.LIP_MIN == 0.25
    assert os.environ.get("OPENCV_IO_MAX_IMAGE_PIXELS") == "40000000"
