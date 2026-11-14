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


def main():
    import notes
    import notes_enrich as ne
    import notes_gemini as g

    if g._key() is None:
        print("GEMINI_API_KEY is not set (env or .env). Add it and rerun: ./.venv/bin/python scripts/gemini_check.py")
        return 1
    os.environ["NOTES_STT_BACKEND"] = "auto"
    notes.warm_up().join()
    print(f"model={g.model_id()} audio_to_cloud={g.status()['audio_to_cloud']}")
    print(f"{'clip':4} {'level':8} {'local_s':>8} {'enrich_s':>9} {'total_s':>8}  source    name  summary")
    with tempfile.TemporaryDirectory() as tmp:
        for tag, voice, text, expect in CLIPS:
            path = make_clip(tmp, tag, voice, text)
            for level in ("minimal", "low", "off"):
                ne.THINKING = None if level == "off" else level
                ne._last.clear()
                t0 = time.time()
                r = notes.process_audio(path, "", [], hotwords=[])
                t1 = time.time()
                e = notes.enrich("", r["transcript"], [], [], [], None, [])
                t2 = time.time()
                ok = any(expect.lower() in n["name"].lower() for n in e["names"])
                print(
                    f"{tag:4} {level:8} {t1 - t0:8.2f} {t2 - t1:9.2f} {t2 - t0:8.2f}  {e['source']:9} "
                    f"{'yes' if ok else 'NO '}   {e['summary'][:60]}"
                )
    return 0


if __name__ == "__main__":
    sys.exit(main())
