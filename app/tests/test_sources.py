import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
import sources  # noqa: E402
from sources import IngestSource, RoomConsent, Tracker  # noqa: E402
from store import Store  # noqa: E402


def emb(seed):
    return np.random.default_rng(seed).normal(size=128).astype(np.float32)


def det(x, y=100.0, score=0.9, e=None, match=None):
    return {"box": [x, y, 100.0, 120.0], "match": match, "score": score, "good": False, "emb": e}


def test_track_survives_ten_frame_gap_with_embedding():
    t = Tracker()
    e = emb(1)
    for i in range(10):
        out = t.update([det(100 + 5 * i, e=e, match=(7, "Sam", 0.8))], i * 0.1)
    tid = out[0]["trackId"]
    coasted = []
    for i in range(10, 20):
        coasted.append(t.update([], i * 0.1))
    assert coasted[0][0]["predicted"] is True and coasted[0][0]["trackId"] == tid
    assert coasted[0][0]["box"][0] > 145
    out = t.update([det(200, e=e + 0.05 * emb(2))], 2.0)
    assert out[0]["trackId"] == tid and out[0]["personId"] == 7 and out[0]["predicted"] is False


def test_track_survives_gap_without_embedding_by_position():
    t = Tracker()
    for i in range(5):
        t.update([det(300)], i * 0.1)
    tid = t.tracks[0]["id"]
    for i in range(5, 15):
        t.update([], i * 0.1)
    assert t.update([det(310)], 1.5)[0]["trackId"] == tid


def test_track_dropped_after_reacquire_window():
    t = Tracker()
    t.update([det(100, e=emb(1))], 0.0)
    t.update([], 1.0)
    assert t.update([], 2.5) == [] and t.tracks == []
    assert t.update([det(100, e=emb(1))], 2.6)[0]["trackId"] == 2


def test_hysteresis_low_score_keeps_but_never_starts():
    t = Tracker()
    assert t.update([det(100, score=0.6)], 0.0) == []
    tid = t.update([det(100, score=0.9)], 0.1)[0]["trackId"]
    for i in range(2, 12):
        out = t.update([det(100 + i, score=0.55)], i * 0.1)
        assert out[0]["trackId"] == tid and out[0]["predicted"] is False


def test_coasting_boxes_follow_velocity_then_expire():
    t = Tracker()
    for i in range(6):
        t.update([det(100 + 20 * i)], i * 0.1)
    last = t.tracks[0]["box"][0]
    out = t.update([], 0.6)
    assert out[0]["predicted"] and out[0]["box"][0] > last
    assert t.update([], 1.5) == []


def face_row(x, y, size, score, yaw=0.0):
    eye = size * 0.45
    cx = x + size / 2
    return np.array([x, y, size, size * 1.15, cx - eye / 2, y + size * 0.4, cx + eye / 2, y + size * 0.4,
                     cx + yaw * eye, y + size * 0.65, cx - eye / 3, y + size * 0.85, cx + eye / 3, y + size * 0.85,
                     score], np.float32)


class NoisyFaces:
    def __init__(self, seed=0, drop=0.15):
        self.rng = np.random.default_rng(seed)
        self.drop = drop
        self.shapes = []

    def find(self, frame):
        self.shapes.append(frame.shape[:2])
        if self.rng.random() < self.drop:
            return []
        h, w = frame.shape[:2]
        s = w / 1920
        x = (800 + self.rng.normal(0, 6)) * s
        y = (300 + self.rng.normal(0, 6)) * s
        return [face_row(x, y, 240 * s, float(self.rng.uniform(0.72, 0.92)), yaw=float(self.rng.normal(0, 0.1)))]

    def embed(self, frame, f):
        return emb(42) + 0.05 * emb(int(self.rng.integers(1000)))


def noisy_source(store, room=True):
    faces = NoisyFaces()
    src = IngestSource(store, faces=faces, room=RoomConsent(store, "test") if room else None)
    frame = np.random.default_rng(1).integers(0, 255, (1080, 1920, 3), dtype=np.uint8)
    src._set_frame(frame, b"\xff\xd8")
    return src, faces


def test_noisy_real_sized_face_is_enrolled_within_a_second():
    store = Store(":memory:")
    src, faces = noisy_source(store)
    ids = set()
    for i in range(12):
        src.detect_once(now=i * (1 / 12))
        ids |= {f["trackId"] for f in src.detections()["faces"]}
    assert store.count_auto() == 1
    assert len(ids) == 1
    assert max(faces.shapes[0]) == sources.DETECT_SIDE
    box = src.detections()["faces"][0]["box"]
    assert 700 < box[0] < 900 and 200 < box[2] < 280


def test_noisy_face_not_enrolled_without_room_mode():
    store = Store(":memory:")
    src, _ = noisy_source(store, room=False)
    for i in range(24):
        src.detect_once(now=i / 12)
    assert store.list_people() == []


def test_snapshot_refined_and_embedding_averaged():
    store = Store(":memory:")
    src, _ = noisy_source(store)
    for i in range(80):
        src.detect_once(now=i / 12)
    pid = store.list_people()[0]["id"]
    snaps = store.snapshots(pid)
    assert 2 <= len(snaps) <= 3
    assert store.thumb(pid)[:2] == b"\xff\xd8"
    assert len(src._embs[pid]) >= 2


def test_yawed_face_quality_is_rejected_for_enrol_but_soft_yaw_passes():
    frame = np.random.default_rng(1).integers(0, 255, (480, 640, 3), dtype=np.uint8)
    q, ok = sources.face_quality(frame, face_row(100, 100, 150, 0.9, yaw=0.25))
    assert ok and q > 0
    assert not sources.face_quality(frame, face_row(100, 100, 150, 0.9, yaw=0.6))[1]
    assert not sources.face_quality(frame, face_row(100, 100, 40, 0.9))[1]


def test_crop_is_square_with_margin_and_clamped():
    x0, y0, side = sources.crop_box((1000, 1000), [400, 400, 100, 120])
    assert side == int(120 * sources.THUMB_PAD)
    assert x0 <= 400 - 30 and x0 + side >= 500 + 30 and y0 <= 400 - 30 and y0 + side >= 520
    assert sources.crop_box((480, 640), [0, 0, 100, 100])[:2] == (0, 0)
    x0, y0, side = sources.crop_box((480, 640), [600, 400, 100, 100])
    assert x0 + side <= 640 and y0 + side <= 480
    frame = np.zeros((480, 640, 3), np.uint8)
    out = sources.cv2.imdecode(np.frombuffer(sources.thumb_jpeg(frame, [300, 200, 80, 90]), np.uint8), 1)
    assert out.shape[:2] == (sources.THUMB_SIDE, sources.THUMB_SIDE)


def clear_setup():
    store = Store(":memory:")
    ref = emb(7)
    pid = store.enrol("A", ref, "yes", thumb=b"\xff\xd8initial")
    src = IngestSource(store, faces=NoisyFaces())
    frame = np.random.default_rng(3).integers(60, 200, (720, 1280, 3), dtype=np.uint8)
    row = face_row(500, 200, 200, 0.95)
    return store, pid, src, frame, row, ref


def test_clear_frame_replaces_occluded_and_flips_once():
    store, pid, src, frame, row, ref = clear_setup()
    occluded = emb(99)
    src._refine(pid, row, occluded, frame, 0.0, True)
    assert store.thumb(pid) != b"\xff\xd8initial" and store.thumb_state(pid)[1] is False
    assert not store.get_person(pid)["thumbClear"]
    src._refine(pid, row, ref + 0.05 * emb(1), frame, 0.1, True)
    clear_thumb = store.thumb(pid)
    assert store.get_person(pid)["thumbClear"] is True
    src._refine(pid, row, occluded, frame, 20.0, True)
    assert store.thumb(pid) == clear_thumb and store.get_person(pid)["thumbClear"] is True


def test_occluded_never_replaces_clear_and_throttle_after_clear():
    store, pid, src, frame, row, ref = clear_setup()
    src._refine(pid, row, ref, frame, 0.0, True)
    first = store.thumb(pid)
    assert store.thumb_state(pid)[1]
    for i in range(1, 30):
        src._refine(pid, row, emb(200 + i), frame, i * 1.0, True)
    assert store.thumb(pid) == first
    src._refine(pid, row, ref, frame, 31.0, True)
    assert store.thumb(pid) == first
    worse = np.random.default_rng(3).integers(60, 200, (720, 1280, 3), dtype=np.uint8)
    worse = sources.cv2.GaussianBlur(worse, (9, 9), 4)
    assert not sources.clarity(worse, row, ref, ref)[1]


def test_clarity_rejects_implausible_landmarks_and_dark_faces():
    frame = np.random.default_rng(3).integers(60, 200, (720, 1280, 3), dtype=np.uint8)
    row = face_row(500, 200, 200, 0.95)
    assert sources.clarity(frame, row, emb(7), emb(7))[1]
    bad = row.copy()
    bad[11], bad[13] = row[5] - 10, row[7] - 10
    assert not sources.clarity(frame, bad, emb(7), emb(7))[1]
    dark = (frame // 8).astype(np.uint8)
    assert not sources.clarity(dark, row, emb(7), emb(7))[1]
    assert not sources.clarity(frame, row, emb(7), None)[1]
