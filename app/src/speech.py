import importlib
import inspect
import logging
import tempfile
import time
from pathlib import Path

from media import AudioQueue

log = logging.getLogger("face-context")
MAX_HOTWORDS = 5
RECENT_SECONDS = 20.0


def call_kw(fn, *args, **kw):
    try:
        params = inspect.signature(fn).parameters
    except (TypeError, ValueError):
        params = {}
    if not any(p.kind is inspect.Parameter.VAR_KEYWORD for p in params.values()):
        kw = {k: v for k, v in kw.items() if k in params}
    return fn(*args, **kw)


class Speech:
    def __init__(self, store, source, emit, wearer=None):
        self.store, self.source, self.emit, self.wearer = store, source, emit, wearer
        self.audio = AudioQueue(self.process_chunk, maxlen=2)
        self.enrich_queue = AudioQueue(self.enrich, maxlen=4, dedupe=True)

    def start(self):
        self.audio.start()
        self.enrich_queue.start()

    def stop(self):
        self.audio.stop()
        self.enrich_queue.stop()

    def purge(self, pid):
        return self.audio.purge(pid) + self.enrich_queue.purge(pid)

    def named(self):
        return {p["id"]: p["name"] for p in self.store.list_people() if p["nameSource"] != "placeholder"}

    def in_view(self, named):
        ids = []
        for face in sorted(self.source.detections().get("faces", []), key=lambda f: -f["box"][2] * f["box"][3]):
            if face.get("personId") in named and face["personId"] not in ids:
                ids.append(face["personId"])
        return [named[i] for i in ids[:MAX_HOTWORDS]]

    def context(self, pid):
        named = self.named()
        return {"hotwords": self.in_view(named), "wearer": self.wearer,
                "taken": [n for i, n in named.items() if i != pid]}

    def process_chunk(self, job):
        pid, suffix, data, lip = job
        person = self.store.get_person(pid)
        if person is None:
            return
        notes_mod = importlib.import_module("notes")
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp.write(data)
        try:
            known = [text for _, text in self.store.notes(pid)]
            result = call_kw(notes_mod.process_audio, tmp.name, person["name"], known, lip=lip, **self.context(pid))
        finally:
            Path(tmp.name).unlink(missing_ok=True)
        if not isinstance(result, dict) or not self.store.exists(pid):
            return
        transcript = str(result.get("transcript") or "").strip()[:20000]
        if transcript:
            ts = self.store.add_note(pid, transcript)
            self.emit({"type": "transcript", "personId": pid, "text": transcript, "ts": ts})
        if callable(getattr(notes_mod, "enrich", None)):
            if transcript:
                self.enrich_queue.submit((pid, transcript))
            return
        self.apply(pid, result, transcript, notes_mod)

    def enrich(self, job):
        pid, transcript = job
        person = self.store.get_person(pid)
        if person is None:
            return
        notes_mod = importlib.import_module("notes")
        notes = self.store.notes(pid)
        recent = " ".join(text for ts, text in notes if ts >= time.time() - RECENT_SECONDS) or transcript
        result = call_kw(notes_mod.enrich, person_name=person["name"], recent_transcript=recent,
                         known_notes=[text for _, text in notes], followups=person["followups"], **self.context(pid))
        if isinstance(result, dict) and result.get("source") != "throttled" and self.store.exists(pid):
            self.apply(pid, result, None, notes_mod)

    def apply(self, pid, result, transcript, notes_mod):
        names = result.get("names")
        if not isinstance(names, list):
            names = []
            extract = getattr(notes_mod, "extract_names", None)
            if transcript and callable(extract):
                try:
                    names = call_kw(extract, transcript, wearer=self.wearer, taken=self.context(pid)["taken"])
                except Exception as exc:
                    log.warning("name extraction failed: %s", type(exc).__name__)
        if named := self.store.name_from_speech(pid, names):
            self.source.renamed(pid, named)
        summary, followups = result.get("summary"), result.get("followups")
        self.store.update_profile(pid, summary=summary if isinstance(summary, str) and summary.strip() else None,
                                  followups=followups if isinstance(followups, list) else None)
        self.emit({"type": "person", "id": pid})
