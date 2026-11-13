import sys
import threading
import time
from pathlib import Path

import cv2
import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
import server  # noqa: E402
from media import AudioQueue, audio_suffix, call_process, image_to_jpeg  # noqa: E402


def test_audio_suffix():
    assert audio_suffix("a.M4A", "") == ".m4a"
    assert audio_suffix("", "audio/webm;codecs=opus") == ".webm"
    assert audio_suffix("", "audio/x-something") == ".audio"
    assert audio_suffix("a.txt", "text/plain") is None


def test_image_to_jpeg_resizes_and_validates():
    png = cv2.imencode(".png", np.zeros((1000, 500, 3), np.uint8))[1].tobytes()
    out = image_to_jpeg(png)
    assert out[:2] == b"\xff\xd8"
    assert cv2.imdecode(np.frombuffer(out, np.uint8), 1).shape[:2] == (256, 128)
    with pytest.raises(ValueError):
        image_to_jpeg(b"GIF89a....")
    with pytest.raises(ValueError):
        image_to_jpeg(b"\xff\xd8\xffgarbage")


def test_audio_queue_is_bounded_and_drops_oldest():
    gate, done = threading.Event(), []

    def handler(job):
        gate.wait(5)
        done.append(job)

    q = AudioQueue(handler, maxlen=2)
    q.start()
    assert q.submit("a") == 0
    deadline = time.time() + 2
    while q.pending() and time.time() < deadline:
        time.sleep(0.01)
    t0 = time.time()
    assert [q.submit(x) for x in "bcde"] == [0, 0, 1, 1]
    assert time.time() - t0 < 0.1
    assert q.pending() == 2 and q.dropped == 2
    gate.set()
    assert q.join(5)
    assert done == ["a", "d", "e"]
    q.stop()


def test_audio_queue_survives_handler_errors():
    seen = []

    def handler(job):
        seen.append(job)
        if job == 1:
            raise RuntimeError("boom")

    q = AudioQueue(handler)
    q.start()
    q.submit(1)
    q.submit(2)
    assert q.join(5) and seen == [1, 2]
    q.stop()


def test_call_process_passes_hotwords_only_when_supported():
    assert call_process(lambda p, n, k: (p, n, k), "f", "Sam", [], ["Sam"]) == ("f", "Sam", [])
    assert call_process(lambda p, n, k, hotwords=None: hotwords, "f", "Sam", [], ["Sam"]) == ["Sam"]



def test_room_text_defaults():
    assert server.room_text("demo") == server.DEMO_ROOM_TEXT
    assert server.room_text("demo", no_auto=True) is None
    assert server.room_text("demo", "Ben's team said yes") == "Ben's team said yes"
    assert server.room_text("camera") == server.AUTO_TEXT and server.room_text("ingest") == server.AUTO_TEXT
    assert server.room_text("ingest", no_auto=True) is None
    assert server.room_text("camera", "team said yes") == "team said yes"
    assert server.room_text("camera", "team said yes", no_auto=True) is None


def test_lan_ip_is_string():
    assert isinstance(server.lan_ip(), str)
