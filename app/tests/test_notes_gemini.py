import json
import sys
import time
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
import notes
import notes_gemini as g

GOOD = {
    "transcript": "Hi, I'm Priya Shah. I will send you the pitch deck tomorrow.",
    "names": [{"name": "priya shah", "confidence": 0.9, "quote": "I'm Priya Shah"}],
    "summary": "Priya Shah pitched a fintech idea. " * 3,
    "followups": ["Priya will send the pitch deck"],
}
AUDIO = (0.1 * np.sin(np.arange(32000) / 7)).astype(np.float32)


class FakeInteractions:
    def __init__(self, replies, delay=0.0, raises=None):
        self.replies = list(replies)
        self.calls = []
        self.delay = delay
        self.raises = raises

    def create(self, **kw):
        self.calls.append(kw)
        time.sleep(self.delay)
        if self.raises:
            raise self.raises
        return type("I", (), {"output_text": self.replies.pop(0)})()


class FakeClient:
    def __init__(self, **kw):
        self.interactions = FakeInteractions(**kw)


@pytest.fixture(autouse=True)
def env(monkeypatch):
    monkeypatch.setenv("NOTES_STT_BACKEND", "gemini")
    monkeypatch.setenv("GEMINI_API_KEY", "fake")
    monkeypatch.delenv("GEMINI_MODEL", raising=False)
    monkeypatch.delenv("GEMINI_MODE", raising=False)
    monkeypatch.setattr(g, "ROOT", Path("/nonexistent-dir"))
    g._set_engine("local")


def use(monkeypatch, client):
    monkeypatch.setattr(g, "_make_client", lambda key, version=None: client)
    return client


def test_single_call_success(monkeypatch):
    c = use(monkeypatch, FakeClient(replies=[json.dumps(GOOD)]))
    out = g.process(AUDIO, "Sam", ["met at demo day"], ["Joon"])
    assert out["transcript"].startswith("Hi, I'm Priya")
    assert len(out["summary"]) <= 280 and out["tags"] == []
    assert out["names"][0]["name"] == "Priya Shah" and out["names"][0]["confidence"] > 0.9
    assert g.engine() == "gemini"
    call = c.interactions.calls[0]
    assert call["model"] == "gemini-4-hydrogen"
    assert call["input"][1]["mime_type"] == "audio/wav"
    assert "untrusted" in call["input"][0]["text"] and "Joon" in call["input"][0]["text"]
    assert call["response_format"]["mime_type"] == "application/json"


def test_model_env_override(monkeypatch):
    monkeypatch.setenv("GEMINI_MODEL", "gemini-3.5-flash-lite")
    c = use(monkeypatch, FakeClient(replies=[json.dumps(GOOD)]))
    g.process(AUDIO, "", [])
    assert c.interactions.calls[0]["model"] == "gemini-3.5-flash-lite"


def test_missing_key_falls_back(monkeypatch):
    monkeypatch.delenv("GEMINI_API_KEY")
    c = use(monkeypatch, FakeClient(replies=[]))
    assert g.process(AUDIO, "", []) is None
    assert c.interactions.calls == [] and g.engine() == "local" and not g.enabled()


def test_malformed_json_falls_back(monkeypatch):
    use(monkeypatch, FakeClient(replies=["not json"]))
    assert g.process(AUDIO, "", []) is None and g.engine() == "local"


def test_api_error_falls_back(monkeypatch):
    use(monkeypatch, FakeClient(replies=[], raises=RuntimeError("boom")))
    assert g.process(AUDIO, "", []) is None


def test_timeout_falls_back(monkeypatch):
    monkeypatch.setattr(g, "TIMEOUT_S", 0.2)
    use(monkeypatch, FakeClient(replies=[json.dumps(GOOD)], delay=1.0))
    t = time.time()
    assert g.process(AUDIO, "", []) is None
    assert time.time() - t < 0.9


def test_20mb_limit(monkeypatch):
    c = use(monkeypatch, FakeClient(replies=[json.dumps(GOOD)]))
    big = np.zeros(11 * 1024 * 1024, dtype=np.float32)
    assert g.process(big, "", []) is None
    assert c.interactions.calls == []


def test_two_step(monkeypatch):
    monkeypatch.setenv("GEMINI_MODE", "two-step")
    c = FakeClient(replies=[GOOD["transcript"], json.dumps({k: v for k, v in GOOD.items() if k != "transcript"})])
    monkeypatch.setattr(g, "_make_client", lambda key, version=None: c)
    out = g.process(AUDIO, "Sam", [], ["Priya Shah"])
    calls = c.interactions.calls
    assert calls[0]["model"] == "gemini-3.5-transcribe"
    assert calls[0]["generation_config"]["transcription_config"]["custom_vocabulary"][0] == "Sam"
    assert calls[1]["model"] == "gemini-4-hydrogen"
    assert out["transcript"] == GOOD["transcript"] and out["names"]


def test_two_step_skips_understanding_without_new_info(monkeypatch):
    monkeypatch.setenv("GEMINI_MODE", "two-step")
    c = FakeClient(replies=["Hello Priya Shah pitch deck tomorrow."])
    monkeypatch.setattr(g, "_make_client", lambda key, version=None: c)
    out = g.process(AUDIO, "", ["Priya Shah pitch deck tomorrow hello"])
    assert len(c.interactions.calls) == 1 and out["transcript"]


def test_clean_names_and_merge():
    names = g.clean_names([{"name": "joon  kim lee extra", "confidence": 3}, {"name": "x"}, "bad"])
    assert names == [{"name": "Joon Kim Lee", "confidence": 1.0, "quote": ""}]
    merged = g.merge_names(
        [{"name": "Sam", "confidence": 0.7, "quote": ""}],
        [{"name": "Sam", "confidence": 0.8, "quote": "I'm Sam"}, {"name": "Priya", "confidence": 0.45, "quote": "q"}],
    )
    assert merged[0]["name"] == "Sam" and merged[0]["quote"] == "I'm Sam" and len(merged) == 2


def test_status_and_engine():
    s = g.status()
    assert s["selected"] == "gemini" and s["gemini_configured"] and s["gemini_active"]
    assert notes.engine() == g.engine() and notes.status()["mode"] == "single"


def test_process_audio_uses_gemini_and_skips_music(monkeypatch):
    c = use(monkeypatch, FakeClient(replies=[json.dumps(GOOD)]))
    monkeypatch.setattr(notes, "_prepare", lambda p, lip=None: AUDIO)
    r = notes.process_audio("x.wav", "Sam", [])
    assert r["transcript"].startswith("Hi") and r["names"]
    monkeypatch.setattr(notes, "_prepare", lambda p, lip=None: None)
    monkeypatch.setattr(notes, "_local", lambda *a, **k: [])
    r = notes.process_audio("x.wav", "Sam", [])
    assert r["transcript"] == "" and len(c.interactions.calls) == 1


def test_process_audio_falls_back_to_local(monkeypatch):
    use(monkeypatch, FakeClient(replies=["garbage"]))
    monkeypatch.setattr(notes, "_prepare", lambda p, lip=None: AUDIO)
    monkeypatch.setattr(notes, "_local", lambda *a, **k: [{"start": 0, "end": 1, "text": "I will send the deck."}])
    r = notes.process_audio("x.wav", "Sam", [])
    assert r["transcript"] == "I will send the deck." and notes.engine() == "local"
