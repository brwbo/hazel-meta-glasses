import logging
import os
import re
import threading

log = logging.getLogger("face-context")
MODEL = os.environ.get("HAZEL_LLM", "mlx-community/Qwen2.5-1.5B-Instruct-4bit")
SYSTEM_PROMPT = (
    "You summarise what is known about a person from short notes of what they said. Write one or two short "
    "sentences about the person, in the third person, using their name. Include every fact in the notes, such as "
    "where they are from, where they live, their job and their interests. Do not repeat the notes word for word. "
    "Never use the words he, she, his or her: use the name or the word they. Do not add anything that is not in the notes."
)
EXAMPLE = (
    "Name: Sam Lee\nNotes:\n- I'm from Tampere.\n- I study physics at Aalto.\n- Robotics club on Fridays.",
    "Sam Lee is from Tampere and studies physics at Aalto, and goes to a robotics club on Fridays.",
)
GENDERED = re.compile(r"\b(?:he|she|his|her|hers|him|himself|herself)\b", re.I)
INTRO = re.compile(r"^(?:hello|hi|hey)?[,!. ]*my name(?: is|'s)\b", re.I)
_state = {"model": None, "tok": None, "failed": False, "loading": False}
_lock = threading.Lock()
SKIP = re.compile(r"^named from speech", re.I)
ALLOWED_CAPS = {"he", "she", "they", "his", "her", "their", "the", "a", "an", "this", "it", "its"}


def enabled():
    return os.environ.get("HAZEL_LOCAL_LLM", "1") != "0" and not _state["failed"]


def load():
    with _lock:
        if _state["model"] is not None or _state["failed"]:
            return
        try:
            from mlx_lm import load as _load

            _state["model"], _state["tok"] = _load(MODEL)
        except Exception as exc:
            _state["failed"] = True
            log.warning("local summary model unavailable: %s", type(exc).__name__)


def warm():
    if not enabled():
        return
    load()
    if _state["model"] is not None:
        summarise("Sam", ["Hello, my name is Sam.", "I was born in Tampere."])


def valid(summary, name, texts):
    if not summary or len(summary) > 320 or "\n" in summary or GENDERED.search(summary):
        return False
    known = {w.lower() for w in re.findall(r"[A-Za-z][A-Za-z'-]+", " ".join(texts) + " " + str(name or ""))}
    for word in re.findall(r"(?<![.!?]\s)(?<!^)\b[A-Z][a-z]{2,}\b", summary):
        if word.lower() not in known and word.lower() not in ALLOWED_CAPS:
            return False
    return True


def summarise(name, texts):
    if not enabled() or _state["model"] is None:
        if enabled() and not _state["loading"]:
            _state["loading"] = True
            threading.Thread(target=load, daemon=True).start()
        return None
    notes = list(dict.fromkeys(str(t).strip() for t in texts if str(t).strip() and not SKIP.match(str(t).strip())))
    if not any(not INTRO.match(n) for n in notes):
        return None
    try:
        from mlx_lm import generate

        who = str(name).strip() if name and not re.fullmatch(r"guest \d+", str(name).strip(), re.I) else "this person"
        messages = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": EXAMPLE[0]},
            {"role": "assistant", "content": EXAMPLE[1]},
            {"role": "user", "content": f"Name: {who}\nNotes:\n- " + "\n- ".join(notes[-12:])},
        ]
        prompt = _state["tok"].apply_chat_template(messages, add_generation_prompt=True, tokenize=False)
        with _lock:
            out = generate(_state["model"], _state["tok"], prompt=prompt, max_tokens=70, verbose=False)
        out = " ".join(out.split()).strip(" \"'")
        if out and out[-1] not in ".!?" and max(out.rfind("."), out.rfind("!"), out.rfind("?")) > 0:
            out = out[: max(out.rfind("."), out.rfind("!"), out.rfind("?")) + 1]
        return out if valid(out, name, notes) else None
    except Exception as exc:
        log.warning("local summary failed: %s", type(exc).__name__)
        return None
