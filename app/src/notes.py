import json
import logging
import os
import re
import subprocess
import tempfile
import threading
import time
from collections import Counter
from pathlib import Path

MAX_AUDIO_SECONDS = 120
ROOT = Path(__file__).resolve().parent.parent
FFMPEG = "/opt/homebrew/bin/ffmpeg"
SUMMARY_MAX = 280
TAG_MAX = 6
TAG_LEN = 24
FOLLOWUP_MAX = 5
FOLLOWUP_LEN = 160
NOTE_CTX_MAX = 12
NOTE_CTX_LEN = 600
TRANSCRIPT_CTX_MAX = 12000

_model = None
_model_lock = threading.Lock()
_run_lock = threading.Lock()

STOPWORDS = set(
    "a about above after again all also am an and any are as at be because been before being but by can "
    "could did do does doing down for from had has have having he her here hers him his how i if in into "
    "is it its just like me more most my no nor not now of off on once only or other our out over own "
    "really same she should so some such than that the their them then there these they this those "
    "through to too under until up us very was we were what when where which while who why will with "
    "would you your yeah okay oh um uh well got get going know think said say yes".split()
)
ACTION_RE = re.compile(
    r"\b(send|share|intro|introduce|email|e-mail|follow up|follow-up|promise|will|i'll|we'll|"
    r"let me|remind|call you|text you|connect you|forward|book|schedule)\b",
    re.I,
)


def _load_env():
    key = os.environ.get("ANTHROPIC_API_KEY")
    if key:
        return key
    path = ROOT / ".env"
    try:
        for line in path.read_text().splitlines():
            line = line.strip()
            if line.startswith("export "):
                line = line[7:]
            if line.startswith("ANTHROPIC_API_KEY="):
                value = line.split("=", 1)[1].strip().strip("'\"")
                if value:
                    return value
    except OSError:
        pass
    return None


STT_MODELS = {"large-v3-turbo", "small", "small.en", "medium", "large-v3", "distil-large-v3", "base.en", "base"}
DEFAULT_STT = "small"
MLX_DEFAULT = "mlx-community/whisper-small-mlx-8bit"
MLX_ALIASES = {
    "small": MLX_DEFAULT,
    "small-4bit": "mlx-community/whisper-small-mlx-4bit",
    "large-v3-turbo": "mlx-community/whisper-large-v3-turbo",
    "turbo": "mlx-community/whisper-large-v3-turbo",
    "turbo-q4": "mlx-community/whisper-large-v3-turbo-q4",
}
_models = {}
_PCORES = None


def stt_backend():
    b = os.environ.get("NOTES_STT_BACKEND", "").strip().lower()
    if b in ("faster-whisper", "mlx"):
        return b
    try:
        import importlib.util

        return "mlx" if importlib.util.find_spec("mlx_whisper") else "faster-whisper"
    except Exception:
        return "faster-whisper"


def stt_model_name():
    name = os.environ.get("NOTES_STT_MODEL", "").strip()
    if stt_backend() == "mlx":
        if not name:
            return MLX_DEFAULT
        return MLX_ALIASES.get(name, name if "/" in name else MLX_DEFAULT)
    return name if name in STT_MODELS else DEFAULT_STT


def _cpu_threads():
    global _PCORES
    if _PCORES is None:
        try:
            out = subprocess.run(["sysctl", "-n", "hw.perflevel0.physicalcpu"], capture_output=True, text=True)
            _PCORES = max(1, int(out.stdout.strip()))
        except Exception:
            _PCORES = max(1, (os.cpu_count() or 4) // 2)
    return _PCORES


def _get_model():
    if stt_backend() == "mlx":
        return _warm_mlx()
    name = stt_model_name()
    with _model_lock:
        if name not in _models:
            from faster_whisper import WhisperModel

            _models[name] = WhisperModel(name, device="cpu", compute_type="int8", cpu_threads=_cpu_threads())
        return _models[name]


def _warm_mlx():
    import numpy as np

    name = stt_model_name()
    with _model_lock:
        if name not in _models:
            import mlx_whisper

            mlx_whisper.transcribe(np.zeros(16000, dtype=np.float32), path_or_hf_repo=name, verbose=None)
            noise = np.random.default_rng(0).normal(0, 0.05, 40000).astype(np.float32)
            lang = os.environ.get("NOTES_STT_LANG", "").strip() or ("en" if name.endswith(".en") else None)
            mlx_whisper.transcribe(
                noise, path_or_hf_repo=name, language=lang, initial_prompt="Names: Sam.",
                condition_on_previous_text=False, temperature=0.0, no_speech_threshold=None,
                logprob_threshold=None, compression_ratio_threshold=None, verbose=None,
            )
            _models[name] = name
        return _models[name]


def warm_up():
    def run():
        started = time.time()
        try:
            import numpy as np

            try:
                from notes_audio import speech_probs
            except ImportError:
                from .notes_audio import speech_probs
            speech_probs(np.zeros(8192, dtype=np.float32))
            try:
                from notes_audio import analyse
            except ImportError:
                from .notes_audio import analyse
            analyse(np.random.default_rng(1).normal(0, 0.05, 40000).astype(np.float32))
        except Exception:
            pass
        try:
            _get_model()
        except Exception:
            pass
        logging.getLogger("face-context").info("speech ready after %.1fs", time.time() - started)

    t = threading.Thread(target=run, name="stt-warmup", daemon=True)
    t.start()
    return t


def _hints(hotwords, person_name):
    names = []
    for n in list(hotwords or []) + ([person_name] if person_name else []):
        n = " ".join(str(n).split())[:60]
        if n and n.lower() not in (x.lower() for x in names):
            names.append(n)
    names = names[:20]
    if not names:
        return None, None
    return "Conversation in English or Finnish. Names: " + ", ".join(names) + ".", " ".join(names)


def _segment_ok(no_speech, avg_logprob, lenient):
    return no_speech < (0.6 if lenient else 0.5) and avg_logprob > (-1.3 if lenient else -1.0)


def _run_transcribe(model, audio, hotwords=None, person_name=None, lenient=False):
    prompt, hot = _hints(hotwords, person_name)
    lang = os.environ.get("NOTES_STT_LANG", "").strip() or None
    if lang is None and stt_model_name().endswith(".en"):
        lang = "en"
    if stt_backend() == "mlx" and isinstance(model, str):
        import mlx_whisper

        r = mlx_whisper.transcribe(
            audio,
            path_or_hf_repo=model,
            language=lang,
            condition_on_previous_text=False,
            initial_prompt=prompt,
            word_timestamps=False,
            no_speech_threshold=0.6 if lenient else 0.5,
            logprob_threshold=-1.0 if lenient else -0.8,
            compression_ratio_threshold=2.4 if lenient else 2.2,
            temperature=0.0,
            verbose=None,
        )
        return [
            {"start": float(s["start"]), "end": float(s["end"]), "text": s["text"].strip()}
            for s in r.get("segments", [])
            if s["text"].strip() and _segment_ok(s.get("no_speech_prob", 0.0), s.get("avg_logprob", 0.0), lenient)
        ]
    segments, _ = model.transcribe(
        audio,
        language=lang,
        beam_size=1,
        without_timestamps=True,
        vad_filter=True,
        condition_on_previous_text=False,
        initial_prompt=prompt,
        hotwords=hot,
        no_speech_threshold=0.6 if lenient else 0.5,
        log_prob_threshold=-1.0 if lenient else -0.8,
        compression_ratio_threshold=2.4 if lenient else 2.2,
        temperature=0.0,
    )
    return [
        {"start": float(s.start), "end": float(s.end), "text": s.text.strip()}
        for s in segments
        if s.text.strip() and _segment_ok(getattr(s, "no_speech_prob", 0.0), getattr(s, "avg_logprob", 0.0), lenient)
    ]


def _decode_av(path):
    import av
    import numpy as np

    chunks = []
    total = 0
    limit = MAX_AUDIO_SECONDS * 16000
    with av.open(path, mode="r") as container:
        stream = next(s for s in container.streams if s.type == "audio")
        resampler = av.AudioResampler(format="flt", layout="mono", rate=16000)
        for frame in container.decode(stream):
            for out in resampler.resample(frame):
                chunks.append(out.to_ndarray().reshape(-1))
                total += chunks[-1].size
            if total >= limit:
                break
    if not chunks:
        raise RuntimeError("no audio decoded")
    return np.concatenate(chunks).astype(np.float32)[:limit]


def _decode_ffmpeg(path):
    import numpy as np

    if not os.path.exists(FFMPEG):
        raise RuntimeError("ffmpeg not found")
    proc = subprocess.run(
        [FFMPEG, "-nostdin", "-i", path, "-f", "f32le", "-t", str(MAX_AUDIO_SECONDS), "-ac", "1", "-ar", "16000", "-"],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    if proc.returncode != 0 or not proc.stdout:
        raise RuntimeError("ffmpeg could not decode audio")
    return np.frombuffer(proc.stdout, dtype=np.float32)[: MAX_AUDIO_SECONDS * 16000]


def _decode(path):
    try:
        return _decode_av(path)
    except Exception:
        return _decode_ffmpeg(path)


def _prepare(path, lip=None):
    path = str(path)
    if not os.path.isfile(path):
        raise FileNotFoundError("audio file not found")
    try:
        from notes_audio import gate
    except ImportError:
        from .notes_audio import gate
    return gate(_decode(path), lip)


def _local(audio, hotwords, person_name, lip):
    if audio is None:
        return []
    model = _get_model()
    with _run_lock:
        return _run_transcribe(model, audio, hotwords, person_name, lenient=lip is not None and lip >= 0.5)


def transcribe(path, hotwords=None, person_name=None, lip=None):
    return _local(_prepare(path, lip), hotwords, person_name, lip)


def _sentences(text):
    parts = re.split(r"(?<=[.!?])\s+|\n+", text.strip())
    return [p.strip() for p in parts if len(p.strip()) > 2]


def _words(text):
    return [w for w in re.findall(r"[a-z][a-z'-]{2,}", text.lower()) if w not in STOPWORDS]


def _clip(text, limit):
    text = " ".join(str(text).split())
    if len(text) <= limit:
        return text
    cut = text[: limit - 1].rsplit(" ", 1)[0].rstrip(",;:- ")
    return (cut or text[: limit - 1]) + "…"


def _clean_tag(tag):
    tag = re.sub(r"[^a-z0-9 -]", "", str(tag).lower()).strip()
    tag = re.sub(r"\s+", " ", tag)
    return tag[:TAG_LEN].strip()


def _clean_list(items, limit, length, tags=False):
    out = []
    seen = set()
    if not isinstance(items, list):
        return out
    for item in items:
        if not isinstance(item, str):
            continue
        item = _clean_tag(item) if tags else _clip(item, length)
        key = item.lower()
        if item and key not in seen:
            seen.add(key)
            out.append(item)
        if len(out) >= limit:
            break
    return out


def validate_result(data):
    if not isinstance(data, dict):
        raise ValueError("not an object")
    summary = data.get("summary")
    if not isinstance(summary, str) or not summary.strip():
        raise ValueError("missing summary")
    return {
        "summary": _clip(summary, SUMMARY_MAX),
        "tags": [],
        "followups": _clean_list(data.get("followups"), FOLLOWUP_MAX, FOLLOWUP_LEN),
    }


def _extract_json(text):
    text = text.strip()
    fence = re.search(r"```(?:json)?\s*(.*?)```", text, re.S)
    if fence:
        text = fence.group(1).strip()
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end <= start:
        raise ValueError("no json object")
    return json.loads(text[start : end + 1])


def parse_model_output(text):
    return validate_result(_extract_json(text))


def merge_with_known(result, known_notes):
    return {"summary": result["summary"], "tags": [], "followups": result["followups"]}


def fallback_summarise(person_name, transcript, known_notes):
    sents = _sentences(transcript)
    known_notes = [str(n) for n in (known_notes or []) if str(n).strip()]
    counts = Counter(_words(transcript))
    for note in known_notes:
        counts.update({w: 0.5 for w in _words(note)})
    summary = ""
    if sents:
        scored = []
        for i, s in enumerate(sents):
            ws = _words(s)
            score = sum(counts[w] for w in ws) / (len(ws) + 3) if ws else 0
            scored.append((score, i, s))
        picks = {0}
        rest = sorted((t for t in scored if t[1] != 0), key=lambda t: -t[0])
        if rest:
            picks.add(rest[0][1])
        chosen = []
        for i in sorted(picks):
            candidate = " ".join(chosen + [sents[i]])
            if len(candidate) <= SUMMARY_MAX or not chosen:
                chosen.append(sents[i])
        summary = " ".join(chosen)
    if not summary:
        summary = f"Spoke with {person_name}." if person_name else "No speech captured."
    if known_notes:
        prior = _sentences(re.sub(r"#\w+", "", known_notes[-1]))
        if prior and len(summary) + len(prior[0]) + 10 <= SUMMARY_MAX:
            summary = f"{summary} Earlier: {prior[0]}"
    followups = [s for s in sents if ACTION_RE.search(s)]
    return merge_with_known(
        validate_result({"summary": summary, "tags": [], "followups": followups}),
        known_notes,
    )


def _make_client(key):
    import anthropic

    return anthropic.Anthropic(api_key=key, timeout=30.0, max_retries=1)


def summarise(person_name, transcript, known_notes):
    transcript = (transcript or "").strip()
    known_notes = list(known_notes or [])
    g = _gemini()
    key = _load_env() if g.cloud_allowed() else None
    if key and transcript:
        try:
            client = _make_client(key)
            model = os.environ.get("NOTES_MODEL", "claude-haiku-5-5")
            return llm_summarise(client, model, person_name, transcript, known_notes)
        except Exception as exc:
            g.log_fallback("anthropic", exc)
    return fallback_summarise(person_name, transcript, known_notes)


def _gemini():
    try:
        import notes_gemini
    except ImportError:
        from . import notes_gemini
    return notes_gemini


def engine():
    return _gemini().engine()


def status():
    return _gemini().status()


def enrich(person_name, recent_transcript, known_notes=None, followups=None, hotwords=None, wearer=None, taken=None):
    try:
        from notes_enrich import enrich as _enrich
    except ImportError:
        from .notes_enrich import enrich as _enrich
    return _enrich(person_name, recent_transcript, known_notes, followups, hotwords, wearer, taken)


def process_audio(path, person_name, known_notes, hotwords=None, lip=None, wearer=None, taken=None):
    g = _gemini()
    if taken is None:
        taken = [h for h in (hotwords or []) if str(h).lower() != str(person_name or "").lower()]
    if g.audio_enabled():
        audio = _prepare(path, lip)
        out = (
            g.process(audio, person_name, known_notes, hotwords, wearer, taken) if audio is not None else None
        )
        if out is not None:
            return out
        segments = _local(audio, hotwords, person_name, lip)
    elif lip is not None:
        segments = transcribe(path, hotwords=hotwords, person_name=person_name, lip=lip)
    elif hotwords or person_name:
        segments = transcribe(path, hotwords=hotwords, person_name=person_name)
    else:
        segments = transcribe(path)
    transcript = " ".join(s["text"] for s in segments).strip()
    if g.enabled():
        base = fallback_summarise(person_name, transcript, known_notes)
        names = extract_names(transcript, wearer, taken, confirm=False)
        return {**base, "transcript": transcript, "tags": [], "names": names}
    result = summarise(person_name, transcript, known_notes)
    return {
        "transcript": transcript,
        "summary": result["summary"],
        "tags": result["tags"],
        "followups": result["followups"],
    }


try:
    from notes_names import extract_names, filter_names
except ImportError:
    from .notes_names import extract_names, filter_names

try:
    from notes_llm import SYSTEM_PROMPT, llm_summarise
except ImportError:
    from .notes_llm import SYSTEM_PROMPT, llm_summarise
