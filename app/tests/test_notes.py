import json
import math
import struct
import sys
import wave
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
import notes


@pytest.fixture(autouse=True)
def no_key(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setattr(notes, "ROOT", Path("/nonexistent-dir"))


TEXT = (
    "Hi, I'm Sam and I run a robotics startup in Helsinki. We build warehouse robots for grocery chains. "
    "I will send you the pitch deck tomorrow. Can you do an intro to your friend at the logistics fund? "
    "The weather was nice. I'll email the demo video on Friday."
)


def test_fallback_shape_and_caps():
    r = notes.summarise("Sam", TEXT, [])
    assert set(r) == {"summary", "tags", "followups"}
    assert 0 < len(r["summary"]) <= 280
    assert r["tags"] == []
    assert any("pitch deck" in f for f in r["followups"])
    assert any("email" in f for f in r["followups"])
    assert len(r["followups"]) <= 5


def test_fallback_empty_transcript():
    r = notes.summarise("Sam", "", [])
    assert r["summary"] and r["followups"] == []


def test_fallback_merges_known_notes():
    r = notes.summarise("Sam", "Hello there. Nice weather.", ["Met at the demo day. #robotics #funding"])
    assert r["tags"] == []


def test_validate_caps_and_cleaning():
    data = {
        "summary": "x" * 500,
        "tags": ["Robotics!", "robotics", "AI  Safety", "a", "b", "c", "d", "e", 5],
        "followups": ["f%d" % i for i in range(9)],
    }
    r = notes.validate_result(data)
    assert len(r["summary"]) <= 280
    assert r["tags"] == []
    assert len(r["followups"]) == 5


def test_validate_rejects_bad():
    with pytest.raises(ValueError):
        notes.validate_result({"tags": []})
    with pytest.raises(ValueError):
        notes.validate_result([])


def test_parse_fenced_json():
    out = notes.parse_model_output('```json\n{"summary": "ok", "tags": ["A"], "followups": []}\n```')
    assert out == {"summary": "ok", "tags": [], "followups": []}


class FakeClient:
    def __init__(self, replies):
        self.replies = list(replies)
        self.calls = []
        self.messages = self

    def create(self, **kw):
        self.calls.append(kw)
        text = self.replies.pop(0)
        return type("R", (), {"content": [type("B", (), {"text": text})()]})()


def test_llm_retry_once_then_success():
    good = json.dumps({"summary": "fine", "tags": ["x"], "followups": ["send deck"]})
    c = FakeClient(["not json", good])
    r = notes.llm_summarise(c, "m", "Sam", "hello", ["old #prior"])
    assert r["summary"] == "fine" and r["tags"] == []
    assert len(c.calls) == 2
    assert "tags" not in c.calls[0]["system"]
    assert "untrusted" in c.calls[0]["system"]
    assert "old #prior" in c.calls[0]["messages"][0]["content"]


def test_llm_two_failures_raise_and_summarise_falls_back(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "fake")
    c = FakeClient(["nope", "still nope"])
    monkeypatch.setattr(notes, "_make_client", lambda key: c)
    r = notes.summarise("Sam", TEXT, [])
    assert len(c.calls) == 2
    assert r["summary"] and any("deck" in f for f in r["followups"])


def test_summarise_uses_llm_when_key(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "fake")
    monkeypatch.setenv("NOTES_MODEL", "custom-model")
    c = FakeClient([json.dumps({"summary": "llm", "tags": [], "followups": []})])
    monkeypatch.setattr(notes, "_make_client", lambda key: c)
    assert notes.summarise("Sam", TEXT, [])["summary"] == "llm"
    assert c.calls[0]["model"] == "custom-model"


def test_key_from_env_file(tmp_path, monkeypatch):
    (tmp_path / ".env").write_text('ANTHROPIC_API_KEY="abc"\n')
    monkeypatch.setattr(notes, "ROOT", tmp_path)
    assert notes._load_env() == "abc"


def test_process_audio_with_fake_transcribe(monkeypatch, capsys):
    monkeypatch.setattr(
        notes,
        "transcribe",
        lambda p, **kw: [{"start": 0, "end": 1, "text": "Hello there."}, {"start": 1, "end": 2, "text": "I will send the deck."}],
    )
    r = notes.process_audio("x.wav", "Sam", [])
    assert r["transcript"] == "Hello there. I will send the deck."
    assert set(r) == {"transcript", "summary", "tags", "followups"}
    assert capsys.readouterr().out == ""


def test_transcribe_missing_file():
    with pytest.raises(FileNotFoundError):
        notes.transcribe("/nonexistent.wav")


def test_transcribe_end_to_end(tmp_path, monkeypatch):
    monkeypatch.setenv("NOTES_STT_BACKEND", "faster-whisper")
    monkeypatch.setenv("NOTES_STT_MODEL", "base.en")
    try:
        notes._get_model()
    except Exception:
        pytest.skip("whisper model unavailable")
    p = tmp_path / "tone.wav"
    with wave.open(str(p), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(b"".join(struct.pack("<h", int(3000 * math.sin(i / 10))) for i in range(16000)))
    segs = notes.transcribe(str(p))
    assert isinstance(segs, list)
    for s in segs:
        assert set(s) == {"start", "end", "text"}


NAME_CASES = [
    ("Hi, I'm Sam.", "Sam", 0.8),
    ("My name is Priya Shah and I work in fintech.", "Priya Shah", 0.9),
    ("This is Joon", "Joon", 0.7),
    ("Just call me Alex", "Alex", 0.8),
    ("Sam here. Quick question.", "Sam", 0.6),
    ("Moi, olen... I am Aino-Maria Virtanen", "Aino-Maria Virtanen", 0.8),
    ("my name is priya", "Priya", 0.9),
    ("I'm MIKKO from Espoo", "Mikko", 0.8),
]


@pytest.mark.parametrize("text,name,minconf", NAME_CASES)
def test_extract_names_positive(text, name, minconf):
    r = notes.extract_names(text)
    assert r and r[0]["name"] == name
    assert r[0]["confidence"] >= minconf
    assert r[0]["quote"]


@pytest.mark.parametrize(
    "text",
    [
        "I'm fine, thanks.",
        "I'm not sure about that.",
        "This is great!",
        "I am Finnish and I'm happy",
        "I'm sorry, this is the worst",
        "I'm going to Helsinki",
        "",
    ],
)
def test_extract_names_false_positives(text):
    assert notes.extract_names(text) == []


def test_addressed_name_is_low_confidence():
    r = notes.extract_names("Nice to meet you, Priya.")
    assert r[0]["name"] == "Priya" and r[0]["confidence"] <= 0.5


def test_sorted_and_deduped_and_capped():
    r = notes.extract_names("Nice to meet you, Priya. I'm Sam Lee Wong Chan Jr. My name is Sam Lee Wong.")
    assert [x["confidence"] for x in r] == sorted((x["confidence"] for x in r), reverse=True)
    assert all(len(x["name"].split()) <= 3 for x in r)
    assert len({x["name"].lower() for x in r}) == len(r)


def test_extract_names_model_filters(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "fake")
    c = FakeClient([json.dumps({"confirmed": ["Sam"]})])
    monkeypatch.setattr(notes, "_make_client", lambda key: c)
    r = notes.extract_names("I'm Sam. Nice to meet you, Priya.")
    assert [x["name"] for x in r] == ["Sam"]
    assert "untrusted" in c.calls[0]["system"]


def test_extract_names_model_failure_keeps_rules(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "fake")
    monkeypatch.setattr(notes, "_make_client", lambda key: FakeClient(["bad", "bad"]))
    assert notes.extract_names("I'm Sam")[0]["name"] == "Sam"


def test_stt_model_selection(monkeypatch):
    monkeypatch.setenv("NOTES_STT_BACKEND", "faster-whisper")
    monkeypatch.delenv("NOTES_STT_MODEL", raising=False)
    assert notes.stt_model_name() == "small"
    monkeypatch.setenv("NOTES_STT_MODEL", "small.en")
    assert notes.stt_model_name() == "small.en"
    monkeypatch.setenv("NOTES_STT_MODEL", "bogus")
    assert notes.stt_model_name() == "small"
    monkeypatch.setenv("NOTES_STT_BACKEND", "mlx")
    monkeypatch.delenv("NOTES_STT_MODEL", raising=False)
    assert notes.stt_model_name() == notes.MLX_DEFAULT
    monkeypatch.setenv("NOTES_STT_MODEL", "turbo")
    assert notes.stt_model_name().endswith("whisper-large-v3-turbo")


def test_gate_silence_and_lip():
    import numpy as np
    import notes_audio as na

    assert na.gate(np.zeros(32000, dtype=np.float32)) is None
    assert na.gate(np.ones(32000, dtype=np.float32) * 0.2, lip=0.05) is None


def test_gate_rejects_music_like():
    import numpy as np
    import notes_audio as na

    tt = np.arange(5 * 16000) / 16000
    music = np.zeros_like(tt)
    for i, f in enumerate([220, 277, 330, 440]):
        env = np.sin(np.pi * ((tt * 2 + i * 0.25) % 1)) ** 2
        for h in (1, 2, 3, 4):
            music += env * np.sin(2 * np.pi * f * h * tt) / h
    music = (0.3 * music / np.abs(music).max()).astype(np.float32)
    assert na.gate(music) is None


def test_music_score_and_segment_filter():
    import notes_audio as na

    assert na.music_score({"tone": 0.3, "beat": 0.1, "band": 0.5}) >= 1.0
    assert na.music_score({"tone": 0.0, "beat": 0.1, "band": 0.5}) == 0.0
    assert not notes._segment_ok(0.9, -0.2, False)
    assert not notes._segment_ok(0.1, -1.5, False)
    assert notes._segment_ok(0.1, -0.4, False)


def test_process_audio_passes_lip(monkeypatch):
    seen = []
    monkeypatch.setattr(notes, "transcribe", lambda p, **kw: seen.append(kw) or [{"start": 0, "end": 1, "text": "Hello."}])
    notes.process_audio("x", "Sam", [], lip=0.7)
    assert seen[0]["lip"] == 0.7


class FakeWhisper:
    def transcribe(self, audio, **kw):
        self.kw = kw
        seg = type("S", (), {"start": 0.0, "end": 1.0, "text": " hi "})()
        return [seg], None


def test_hints_and_options(monkeypatch):
    monkeypatch.setenv("NOTES_STT_BACKEND", "faster-whisper")
    monkeypatch.setenv("NOTES_STT_MODEL", "small")
    monkeypatch.delenv("NOTES_STT_LANG", raising=False)
    m = FakeWhisper()
    out = notes._run_transcribe(m, None, ["Priya Shah", "Joon"], "Sam")
    assert out[0]["text"] == "hi"
    assert m.kw["language"] is None and m.kw["vad_filter"] is True
    assert m.kw["condition_on_previous_text"] is False
    assert "Priya Shah" in m.kw["initial_prompt"] and "Sam" in m.kw["hotwords"]
    monkeypatch.setenv("NOTES_STT_LANG", "fi")
    notes._run_transcribe(m, None)
    assert m.kw["language"] == "fi" and m.kw["initial_prompt"] is None


def test_warm_up_thread(monkeypatch):
    calls = []
    monkeypatch.setattr(notes, "_get_model", lambda: calls.append(1))
    notes.warm_up().join(2)
    assert calls == [1]


def test_process_audio_old_and_new_signature(monkeypatch):
    seen = []
    monkeypatch.setattr(notes, "transcribe", lambda p, **kw: seen.append(kw) or [{"start": 0, "end": 1, "text": "Hello."}])
    notes.process_audio("x", "Sam", [], hotwords=["Priya"])
    assert seen[0]["hotwords"] == ["Priya"]
