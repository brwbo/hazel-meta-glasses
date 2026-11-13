import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
from store import ConsentRequired, Store  # noqa: E402


def vec(seed):
    return np.random.default_rng(seed).normal(size=128).astype(np.float32)


def test_enrol_requires_consent():
    s = Store(":memory:")
    with pytest.raises(ConsentRequired):
        s.enrol("Sam", vec(1), "")
    assert s.people() == []


def test_match_finds_enrolled_and_ignores_strangers():
    s = Store(":memory:")
    s.enrol("Sam", vec(1), "verbal yes, Nov 13")
    assert s.match(vec(1))[1] == "Sam"
    assert s.match(vec(2)) is None


def test_delete_removes_person_and_notes():
    s = Store(":memory:")
    pid = s.enrol("Sam", vec(1), "verbal yes")
    s.add_note(pid, "likes robotics")
    s.delete_person(pid)
    assert s.people() == []
    assert s.notes(pid) == []


def test_migrates_old_schema_and_profile_roundtrip(tmp_path):
    import sqlite3
    path = tmp_path / "old.db"
    db = sqlite3.connect(path)
    db.executescript(
        "CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT NOT NULL, consent_at REAL NOT NULL,"
        " consent_note TEXT NOT NULL, embedding BLOB NOT NULL);"
        "CREATE TABLE notes (id INTEGER PRIMARY KEY, person_id INTEGER NOT NULL REFERENCES people(id)"
        " ON DELETE CASCADE, ts REAL NOT NULL, text TEXT NOT NULL);"
    )
    db.execute("INSERT INTO people (name, consent_at, consent_note, embedding) VALUES ('Old', 1, 'yes', ?)",
               (vec(1).tobytes(),))
    db.commit()
    db.close()
    s = Store(str(path))
    old = s.get_person(1)
    assert old["name"] == "Old" and old["tags"] == [] and old["modelPath"] is None
    s.update_profile(1, summary="hi", tags=["a", "a", " b "], followups=["call"], role="dev")
    p = Store(str(path)).get_person(1)
    assert (p["summary"], p["tags"], p["followups"], p["role"]) == ("hi", ["a", "b"], ["call"], "dev")


def test_delete_returns_model_path_and_clears_thumb():
    s = Store(":memory:")
    pid = s.enrol("Sam", vec(1), "yes", role="r", thumb=b"\xff\xd8x")
    s.set_model_path(pid, "/tmp/x.glb")
    s.seen(pid)
    assert s.get_person(pid)["lastSeen"] is not None
    assert s.delete_person(pid) == "/tmp/x.glb"
    assert s.thumb(pid) is None and s.get_person(pid) is None and s.list_people() == []
