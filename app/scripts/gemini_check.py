import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

CLIPS = [
    ("en", None, "Hi, I'm Priya Shah. I will send you the pitch deck tomorrow, and an intro to Joon at the fund.", "Priya"),
    ("fi", "Satu", "Hei, minun nimeni on Aino Virtanen. Lähetän sinulle esityksen huomenna.", "Aino"),
]


def make_clip(tmp, tag, voice, text):
    path = os.path.join(tmp, f"{tag}.m4a")
    cmd = ["say", "-o", path, "--data-format=aac"] + (["-v", voice] if voice else []) + [text]
    subprocess.run(cmd, check=True)
    return path


def timed(fn, runs=3):
    out, times = None, []
    for _ in range(runs):
        t = time.time()
        out = fn()
        times.append(time.time() - t)
    return out, sorted(times)[len(times) // 2]


def main():
    import notes
    import notes_gemini as g

    if g._key() is None:
        print("GEMINI_API_KEY is not set (env or .env). Add it and rerun: ./.venv/bin/python scripts/gemini_check.py")
        return 1
    os.environ["NOTES_STT_BACKEND"] = "gemini"
    notes.warm_up().join()
    rows = []
    with tempfile.TemporaryDirectory() as tmp:
        for tag, voice, text, expect in CLIPS:
            audio = notes._decode(make_clip(tmp, tag, voice, text))
            for label in ("single", "two-step"):
                os.environ["GEMINI_MODE"] = label
                out, sec = timed(lambda: g.process(audio, "", [], []))
                ok = bool(out) and any(expect.lower() in n["name"].lower() for n in out["names"])
                rows.append((tag, label, sec, ok, (out or {}).get("transcript", "FAILED")))
            os.environ["NOTES_STT_BACKEND"] = "mlx"
            segs, sec = timed(lambda: notes._local(audio, [], "", None))
            os.environ["NOTES_STT_BACKEND"] = "gemini"
            text_out = " ".join(s["text"] for s in segs)
            rows.append((tag, "local-mlx", sec, expect.lower() in text_out.lower(), text_out))
    print(f"{'clip':4} {'mode':10} {'sec':>5}  name  transcript")
    for tag, label, sec, ok, tr in rows:
        print(f"{tag:4} {label:10} {sec:5.2f}  {'yes' if ok else 'NO '}   {tr[:70]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
