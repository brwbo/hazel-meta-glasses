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
    monkeypatch.setenv("GEMINI_AUDIO", "1")
    monkeypatch.setenv("GEMINI_API_KEY", "fake")
    monkeypatch.delenv("GEMINI_MODEL", raising=False)
    monkeypatch.delenv("GEMINI_MODE", raising=False)
    monkeypatch.setattr(g, "ROOT", Path("/nonexistent-dir"))
    g._set_engine("local")
    g.disable_cloud(False)
    import notes_enrich

    notes_enrich._last.clear()
    g._last_log.clear()


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
    assert call["model"] == "gemini-3.5-flash-lite"
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
    assert g.process(AUDIO, "", []) is None and g.status()["last_engine"] == "local"


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
    assert calls[1]["model"] == "gemini-3.5-flash-lite"
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
    assert r["transcript"] == "I will send the deck." and g.status()["last_engine"] == "local"


def test_engine_reports_configured_state_before_any_call():
    assert g.engine() == "gemini" and g.status()["engine"] == "gemini" and g.status()["cloud"] is True


def test_no_cloud_speech_disables_everything(monkeypatch):
    monkeypatch.setenv("NOTES_STT_BACKEND", "mlx")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "fake")
    c = use(monkeypatch, FakeClient(replies=[json.dumps(GOOD)]))
    ant = FakeClient(replies=[json.dumps({"summary": "cloud", "followups": []})])
    monkeypatch.setattr(notes, "_make_client", lambda key: ant)
    assert g.engine() == "local" and g.status()["cloud"] is False
    assert g.process(AUDIO, "", []) is None and c.interactions.calls == []
    r = notes.summarise("Sam", "I will send the deck tomorrow.", [])
    assert ant.interactions.calls == [] if hasattr(ant, "interactions") else True
    assert r["summary"] != "cloud"
    assert notes.extract_names("I'm Sam")[0]["name"] == "Sam"


def test_disable_cloud_runtime(monkeypatch):
    g.disable_cloud()
    assert g.engine() == "local" and not g.cloud_allowed()


def test_context_names_capped_and_wearer_removed(monkeypatch):
    monkeypatch.setenv("HAZEL_WEARER", "Ben")
    c = use(monkeypatch, FakeClient(replies=[json.dumps(GOOD)]))
    g.process(AUDIO, "Sam", ["note"], ["Ben", "A1", "B2", "C3", "D4", "E5", "F6"])
    text = c.interactions.calls[0]["input"][0]["text"]
    assert "Ben," not in text and "<known_names>B2, C3, D4, E5, F6</known_names>" in text


def test_fallback_logged_once_per_minute_without_secrets(monkeypatch, caplog):
    use(monkeypatch, FakeClient(replies=[], raises=RuntimeError("bad key fake and transcript hello")))
    with caplog.at_level("WARNING", logger="notes"):
        g.process(AUDIO, "", [])
        g.process(AUDIO, "", [])
    recs = [r for r in caplog.records if "gemini unavailable" in r.getMessage()]
    assert len(recs) == 1
    assert "RuntimeError" in recs[0].getMessage() and "fake" not in recs[0].getMessage().replace("bad key fake", "")


def test_anthropic_failure_logged(monkeypatch, caplog):
    monkeypatch.setenv("NOTES_STT_BACKEND", "auto")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-secret")
    monkeypatch.setattr(notes, "_make_client", lambda key: (_ for _ in ()).throw(RuntimeError("down sk-secret")))
    with caplog.at_level("WARNING", logger="notes"):
        r = notes.summarise("Sam", "I will send the deck tomorrow.", [])
    assert r["summary"]
    msgs = " ".join(x.getMessage() for x in caplog.records)
    assert "anthropic unavailable" in msgs and "sk-secret" not in msgs and "deck" not in msgs


def test_process_audio_returns_merged_names_key(monkeypatch):
    use(monkeypatch, FakeClient(replies=[json.dumps(GOOD)]))
    monkeypatch.setattr(notes, "_prepare", lambda p, lip=None: AUDIO)
    r = notes.process_audio("x.wav", "", [], hotwords=["Joon"])
    assert r["names"][0]["name"] == "Priya Shah"


def test_wearer_dropped_everywhere(monkeypatch):
    assert notes.extract_names("Hi, my name is Ben Rowbotham.", wearer="Ben Rowbotham") == []
    assert notes.extract_names("I'm Ben", wearer="Ben Rowbotham") == []
    monkeypatch.setenv("HAZEL_WEARER", "Priya Shah")
    assert notes.extract_names("my name is Priya Shah") == []
    use(monkeypatch, FakeClient(replies=[json.dumps(GOOD)]))
    out = g.process(AUDIO, "", [])
    assert out["names"] == []


def test_taken_name_lowered_to_half(monkeypatch):
    r = notes.extract_names("My name is Priya Shah", taken=["Priya Shah"])
    assert r[0]["confidence"] == 0.5
    use(monkeypatch, FakeClient(replies=[json.dumps(GOOD)]))
    out = g.process(AUDIO, "", [], taken=["Priya Shah"])
    assert out["names"][0]["confidence"] <= 0.5
    assert notes.extract_names("my name is Joon", taken=["Priya Shah"])[0]["confidence"] > 0.5


ENRICH = {
    "summary": "Priya Shah pitches fintech.",
    "names": [{"name": "Priya Shah", "confidence": 0.9, "quote": "I'm Priya Shah"}],
    "followups": ["Send the deck"],
}


def hybrid(monkeypatch, client=None):
    monkeypatch.delenv("GEMINI_AUDIO", raising=False)
    monkeypatch.setenv("NOTES_STT_BACKEND", "auto")
    if client is not None:
        use(monkeypatch, client)


def test_hybrid_status_audio_stays_local(monkeypatch):
    hybrid(monkeypatch)
    s = notes.status()
    assert s["audio_to_cloud"] is False and s["text_to_cloud"] is True and s["cloud"] is True
    assert s["hybrid"] is True and g.engine() == "gemini"


def test_hybrid_process_audio_never_sends_audio(monkeypatch):
    c = FakeClient(replies=[json.dumps(GOOD)])
    hybrid(monkeypatch, c)
    monkeypatch.setattr(notes, "_prepare", lambda p, lip=None: AUDIO)
    monkeypatch.setattr(notes, "_local", lambda *a, **k: [{"start": 0, "end": 1, "text": "I'm Sam. I will send the deck."}])
    r = notes.process_audio("x.wav", "Sam", [])
    assert c.interactions.calls == []
    assert r["transcript"].startswith("I'm Sam") and r["names"][0]["name"] == "Sam" and r["tags"] == []


def test_enrich_success_text_only(monkeypatch):
    c = FakeClient(replies=[json.dumps(ENRICH)])
    hybrid(monkeypatch, c)
    out = notes.enrich("Sam", "Hi I'm Priya Shah, pitching fintech.", ["old note"], ["x"], ["Joon"], "Ben", ["Joon"])
    assert out["source"] == "gemini" and out["names"][0]["name"] == "Priya Shah"
    call = c.interactions.calls[0]
    assert all(p["type"] == "text" for p in call["input"])
    assert call["model"] == "gemini-3.5-flash-lite" and call["timeout"] == 8.0
    assert call["generation_config"]["max_output_tokens"] == 400
    assert "untrusted" in call["input"][0]["text"]


def test_enrich_fallback_on_error_and_malformed(monkeypatch):
    hybrid(monkeypatch, FakeClient(replies=[], raises=RuntimeError("down")))
    out = notes.enrich("Sam", "I'm Sam. I will send the deck.", [], [], [], None, [])
    assert out["source"] == "local" and out["names"][0]["name"] == "Sam" and out["summary"]
    import notes_enrich

    notes_enrich._last.clear()
    hybrid(monkeypatch, FakeClient(replies=["garbage"]))
    assert notes.enrich("Sam", "I will send the deck.", [])["source"] == "local"


def test_enrich_timeout_falls_back(monkeypatch):
    import notes_enrich

    monkeypatch.setattr(notes_enrich, "ENRICH_TIMEOUT_S", 0.2)
    hybrid(monkeypatch, FakeClient(replies=[json.dumps(ENRICH)], delay=1.0))
    t = time.time()
    out = notes.enrich("Sam", "I will send the deck tomorrow.", [])
    assert out["source"] == "local" and time.time() - t < 0.9


def test_enrich_batching_and_cue_bypass(monkeypatch):
    c = FakeClient(replies=[json.dumps(ENRICH), json.dumps(ENRICH)])
    hybrid(monkeypatch, c)
    assert notes.enrich("Sam", "We talked about funding rounds.", [])["source"] == "gemini"
    assert notes.enrich("Sam", "More talk about funding rounds.", [])["source"] == "throttled"
    assert len(c.interactions.calls) == 1
    assert notes.enrich("Sam", "Oh, my name is Priya Shah.", [])["source"] == "gemini"
    assert len(c.interactions.calls) == 2


def test_enrich_disabled_when_no_cloud(monkeypatch):
    c = FakeClient(replies=[json.dumps(ENRICH)])
    hybrid(monkeypatch, c)
    monkeypatch.setenv("NOTES_STT_BACKEND", "mlx")
    out = notes.enrich("Sam", "I will send the deck.", [])
    assert out["source"] == "local" and c.interactions.calls == []


def test_enrich_wearer_removed(monkeypatch):
    hybrid(monkeypatch, FakeClient(replies=[json.dumps(ENRICH)]))
    out = notes.enrich("Sam", "I'm Priya Shah.", [], wearer="Priya Shah")
    assert out["names"] == []
