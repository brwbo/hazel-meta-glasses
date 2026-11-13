import importlib
import inspect
import logging
import threading
import time
from collections import deque
from pathlib import Path

import cv2
import numpy as np
from fastapi import HTTPException

log = logging.getLogger("face-context")
LIP_MIN = 0.35

AUDIO_EXT = {".wav", ".mp3", ".m4a", ".mp4", ".webm", ".ogg", ".oga", ".aac", ".flac", ".caf"}
AUDIO_TYPES = {"audio/wav": ".wav", "audio/x-wav": ".wav", "audio/wave": ".wav", "audio/mpeg": ".mp3",
               "audio/mp4": ".m4a", "audio/x-m4a": ".m4a", "audio/aac": ".aac", "audio/webm": ".webm",
               "audio/ogg": ".ogg", "audio/flac": ".flac", "audio/x-caf": ".caf"}


async def first_upload(request, limit):
    size = request.headers.get("content-length")
    if size and size.isdigit() and int(size) > limit + 65536:
        raise HTTPException(413, f"upload larger than {limit // (1024 * 1024)} MB")
    form = await request.form(max_files=1, max_fields=10)
    for value in form.values():
        if hasattr(value, "read") and hasattr(value, "filename"):
            data = await value.read(limit + 1)
            if len(data) > limit:
                raise HTTPException(413, f"upload larger than {limit // (1024 * 1024)} MB")
            return value.filename or "", value.content_type or "", data
    raise HTTPException(400, "multipart file part is required")


async def read_body(request, limit):
    size = request.headers.get("content-length")
    if size and size.isdigit() and int(size) > limit:
        raise HTTPException(413, f"body larger than {limit // (1024 * 1024)} MB")
    data = b""
    async for chunk in request.stream():
        data += chunk
        if len(data) > limit:
            raise HTTPException(413, f"body larger than {limit // (1024 * 1024)} MB")
    return data


def audio_suffix(filename, content_type):
    ext = Path(filename).suffix.lower()
    if ext in AUDIO_EXT:
        return ext
    base = content_type.split(";")[0].strip().lower()
    if base in AUDIO_TYPES:
        return AUDIO_TYPES[base]
    if base.startswith("audio/") or base == "video/webm":
        return ".webm" if "webm" in base else ".audio"
    return None


def image_to_jpeg(data, side=256):
    if not (data[:3] == b"\xff\xd8\xff" or data[:8] == b"\x89PNG\r\n\x1a\n"):
        raise ValueError("upload a JPEG or PNG image")
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("image could not be decoded")
    h, w = img.shape[:2]
    s = side / max(h, w)
    img = cv2.resize(img, (max(1, int(w * s)), max(1, int(h * s))), interpolation=cv2.INTER_AREA)
    return cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 88])[1].tobytes()


def lip_gate(lip, pid=None):
    if lip is None:
        return None
    if not (0.0 <= lip <= 1.0):
        raise HTTPException(400, "lip must be a number between 0 and 1")
    if lip < LIP_MIN:
        log.info("audio chunk dropped: lip activity %.2f below %.2f (person %s)", lip, LIP_MIN, pid)
        return "lips"
    return None


def call_process(process, path, name, known, hotwords, lip=None):
    try:
        params = inspect.signature(process).parameters
    except (TypeError, ValueError):
        params = {}
    any_kw = any(p.kind is inspect.Parameter.VAR_KEYWORD for p in params.values())
    kw = {}
    if "hotwords" in params or any_kw:
        kw["hotwords"] = hotwords
    if lip is not None and ("lip" in params or any_kw):
        kw["lip"] = lip
    return process(path, name, known, **kw)


def warm_up_notes():
    try:
        warm = getattr(importlib.import_module("notes"), "warm_up", None)
        if callable(warm):
            warm()
    except Exception as exc:
        log.warning("notes warm-up skipped: %s", type(exc).__name__)


class AudioQueue:
    def __init__(self, handler, maxlen=2):
        self.handler, self.maxlen = handler, maxlen
        self.items = deque()
        self.cond = threading.Condition()
        self.busy = False
        self.running = False
        self.dropped = 0

    def start(self):
        with self.cond:
            if self.running:
                return
            self.running = True
        threading.Thread(target=self._run, name="audio-worker", daemon=True).start()

    def stop(self):
        with self.cond:
            self.running = False
            self.cond.notify_all()

    def submit(self, job):
        with self.cond:
            dropped = 0
            while len(self.items) >= self.maxlen:
                self.items.popleft()
                dropped += 1
            self.dropped += dropped
            if dropped:
                log.info("audio queue full: dropped %d oldest chunk(s)", dropped)
            self.items.append((time.time(), job))
            self.cond.notify_all()
            return dropped

    def pending(self):
        with self.cond:
            return len(self.items)

    def join(self, timeout=10.0):
        end = time.time() + timeout
        with self.cond:
            while self.items or self.busy:
                left = end - time.time()
                if left <= 0:
                    return False
                self.cond.wait(left)
        return True

    def _run(self):
        while True:
            with self.cond:
                while self.running and not self.items:
                    self.cond.wait()
                if not self.running:
                    return
                queued_at, job = self.items.popleft()
                self.busy = True
            start = time.time()
            try:
                self.handler(job)
            except Exception as exc:
                log.warning("audio chunk failed: %s", type(exc).__name__)
            finally:
                log.info("audio chunk: queued %.2fs, processed %.2fs, %d pending",
                         start - queued_at, time.time() - start, self.pending())
                with self.cond:
                    self.busy = False
                    self.cond.notify_all()
