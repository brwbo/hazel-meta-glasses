import logging
import threading
import time

import cv2
import numpy as np

log = logging.getLogger("face-context")
MAX_FRAME = 1024 * 1024
STALE_AFTER = 2.0
DETECT_SIDE = 640
START_SCORE = 0.7
KEEP_SCORE = 0.5
COAST = 0.8
REACQUIRE = 2.0
REID_SIM = 0.45
FILTER_POS = 0.6
FILTER_VEL = 0.3
COAST_DAMP = 0.8
ENROL_HOLD = 0.7
BAD_FRAMES = 4
ENROL_MIN_SIZE = 60
ENROL_MIN_SCORE = 0.7
MAX_YAW_OFFSET = 0.4
MIN_EYE_RATIO = 0.2
MIN_SHARP = 12.0
SHARP_SIZE = 112
REFINE_MATCH = 0.5
EMB_KEEP = 3
AUTO_CAP = 12
CLEAR_DET = 0.9
CLEAR_FRONTAL = 0.6
CLEAR_SHARP = 30.0
CLEAR_BRIGHT = (50.0, 210.0)
CLEAR_SIZE = 90
CLEAR_SELF = 0.6
CLEAR_BETTER = 1.2
CLEAR_INTERVAL = 5.0
THUMB_SIDE = 256
THUMB_PAD = 1.6


def crop_box(shape, box):
    fh, fw = shape[:2]
    x, y, w, h = [float(v) for v in box]
    side = int(min(max(w, h) * THUMB_PAD, fw, fh))
    cx, cy = x + w / 2, y + h / 2 - 0.1 * h
    x0 = int(min(max(0, cx - side / 2), fw - side))
    y0 = int(min(max(0, cy - side / 2), fh - side))
    return x0, y0, side


def thumb_jpeg(frame, box):
    x0, y0, side = crop_box(frame.shape, box)
    if side <= 0:
        return None
    crop = cv2.resize(frame[y0:y0 + side, x0:x0 + side], (THUMB_SIDE, THUMB_SIDE), interpolation=cv2.INTER_AREA)
    return cv2.imencode(".jpg", crop, [cv2.IMWRITE_JPEG_QUALITY, 88])[1].tobytes()


def landmarks_plausible(f):
    x, y, w, h = [float(v) for v in f[:4]]
    rex, rey, lex, ley, nx, ny, rmx, rmy, lmx, lmy = (float(v) for v in f[4:14])
    inside = all(x <= px <= x + w and y <= py <= y + h for px, py in
                 ((rex, rey), (lex, ley), (nx, ny), (rmx, rmy), (lmx, lmy)))
    eye_y, mouth_y = (rey + ley) / 2, (rmy + lmy) / 2
    eye_w, mouth_w = abs(lex - rex), abs(lmx - rmx)
    return (inside and eye_y < ny < mouth_y and eye_y < y + 0.65 * h and mouth_y > y + 0.5 * h
            and eye_w > 0 and 0.4 <= mouth_w / eye_w <= 1.6)


def clarity(frame, f, emb=None, ref=None):
    x, y, w, h = [float(v) for v in f[:4]]
    rex, lex, nx = float(f[4]), float(f[6]), float(f[8])
    eye = abs(lex - rex)
    frontal = max(0.0, 1.0 - abs(nx - (rex + lex) / 2) / (2 * MAX_YAW_OFFSET * eye)) if eye else 0.0
    crop = frame[max(0, int(y)):int(y + h), max(0, int(x)):int(x + w)]
    if crop.size == 0:
        return 0.0, False
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY) if crop.ndim == 3 else crop
    gray = cv2.resize(gray, (SHARP_SIZE, SHARP_SIZE))
    sharp = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    bright = float(gray.mean())
    selfsim = cosine(emb, ref) if ref is not None else 0.0
    det = float(f[14])
    in_range = CLEAR_BRIGHT[0] <= bright <= CLEAR_BRIGHT[1]
    score = (max(selfsim, 0.05) ** 2 * frontal * det * min(1.0, sharp / (3 * CLEAR_SHARP))
             * min(1.0, min(w, h) / (2 * CLEAR_SIZE)) * (1.0 if in_range else 0.5))
    clear = (det >= CLEAR_DET and frontal >= CLEAR_FRONTAL and sharp >= CLEAR_SHARP and in_range
             and min(w, h) >= CLEAR_SIZE and selfsim >= CLEAR_SELF and landmarks_plausible(f))
    return score, clear


def face_quality(frame, f, scale=1.0):
    x, y, w, h = [float(v) for v in f[:4]]
    rex, rey, lex, ley, nx = (float(v) for v in f[4:9])
    eye = float(np.hypot(lex - rex, ley - rey))
    if eye <= 0 or w <= 0:
        return 0.0, False
    offset = abs(nx - (rex + lex) / 2) / eye
    frontal = max(0.0, 1.0 - offset / (2 * MAX_YAW_OFFSET))
    crop = frame[max(0, int(y)):int(y + h), max(0, int(x)):int(x + w)]
    if crop.size == 0:
        return 0.0, False
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY) if crop.ndim == 3 else crop
    sharp = float(cv2.Laplacian(cv2.resize(gray, (SHARP_SIZE, SHARP_SIZE)), cv2.CV_64F).var())
    ok = (min(w, h) * scale >= ENROL_MIN_SIZE and float(f[14]) >= ENROL_MIN_SCORE and offset <= MAX_YAW_OFFSET
          and eye >= MIN_EYE_RATIO * w and sharp >= MIN_SHARP)
    return sharp * frontal, ok


def cosine(a, b):
    if a is None or b is None:
        return 0.0
    d = float(np.linalg.norm(a) * np.linalg.norm(b))
    return float(np.dot(a, b) / d) if d else 0.0


class RoomConsent:
    def __init__(self, store, text, cap=AUTO_CAP, hold=ENROL_HOLD, prefix="room consent session: "):
        text = (text or "").strip()
        if not text:
            raise ValueError("room consent text is required")
        self.store, self.text, self.cap, self.hold = store, text[:300], cap, hold
        self.prefix = prefix
        self.lock = threading.Lock()
        self.n = store.count_auto()

    @property
    def note(self):
        return f"{self.prefix}{self.text}"

    def count(self):
        return self.store.count_auto()

    def enrol(self, embedding, thumb, score=0.0, clear=False):
        with self.lock:
            if self.store.count_auto() >= self.cap:
                return None
            self.n += 1
            name = f"Guest {self.n}"
            pid = self.store.enrol(name, embedding, self.note, thumb=thumb, auto=True, name_source="placeholder",
                                   thumb_score=score, thumb_clear=clear)
            return pid, name


def _det(d):
    if isinstance(d, dict):
        return d
    return {"box": list(d[0]), "match": d[1], "good": len(d) > 2 and bool(d[2]),
            "score": d[3] if len(d) > 3 else 1.0, "emb": d[4] if len(d) > 4 else None}


class Tracker:
    def __init__(self, coast=COAST, reacquire=REACQUIRE, switch_frames=3, switch_margin=0.05):
        self.coast, self.reacquire = coast, reacquire
        self.switch_frames, self.switch_margin = switch_frames, switch_margin
        self.tracks = []
        self.next_id = 1

    def forget(self, pid):
        for t in self.tracks:
            if t["pid"] == pid:
                t["pid"], t["name"], t["score"], t["good"] = None, None, 0.0, None

    def rename(self, pid, name):
        for t in self.tracks:
            if t["pid"] == pid:
                t["name"] = name

    def ready(self, now, hold):
        return [t for t in self.tracks
                if t["seen"] == now and t["pid"] is None and t["good"] is not None and t.get("bad", 0) == 0
                and now - t["good"] >= hold]

    def snapshot(self, now):
        return [{"trackId": t["id"], "box": [round(v, 1) for v in t["box"]], "personId": t["pid"],
                 "name": t["name"], "score": round(t["score"], 3) if t["pid"] else 0.0,
                 "predicted": t["seen"] != now}
                for t in self.tracks if now - t["seen"] <= self.coast]

    def _identity(self, t, match):
        if match is None:
            t["cand"] = None
            return
        pid, name, score = match
        if t["pid"] is None or t["pid"] == pid:
            t["pid"], t["name"], t["score"], t["cand"] = pid, name, score, None
            return
        cand = t["cand"]
        if cand and cand[0] == pid:
            cand[2] += 1
            cand[1] = score
        else:
            cand = t["cand"] = [pid, score, 1, name]
        if cand[2] >= self.switch_frames and cand[1] > t["score"] + self.switch_margin:
            t["pid"], t["score"], t["name"], t["cand"] = pid, cand[1], cand[3], None

    def _observe(self, t, d, di, now, restore=False):
        dt = max(0.02, t.get("dt", 0.1))
        if restore:
            t["box"], t["v"] = list(d["box"]), [0.0, 0.0]
        else:
            res = [m - p for m, p in zip(d["box"], t["box"])]
            t["box"] = [p + FILTER_POS * r for p, r in zip(t["box"], res)]
            limit = 3.0 * max(t["box"][2], t["box"][3])
            t["v"] = [float(np.clip(v + FILTER_VEL * r / dt, -limit, limit)) for v, r in zip(t["v"], res[:2])]
        t["seen"] = t["t"] = now
        t["det"] = di
        if d.get("emb") is not None:
            t["emb"] = d["emb"]
        self._identity(t, d["match"])
        self._good(t, bool(d.get("good")), now)

    def _good(self, t, ok, now):
        if ok:
            t["good"] = t["good"] if t["good"] is not None else now
            t["bad"] = 0
            return
        t["bad"] = t.get("bad", 0) + 1
        if t["bad"] > BAD_FRAMES:
            t["good"] = None

    def update(self, dets, now):
        dets = [_det(d) for d in dets]
        for t in self.tracks:
            dt = t["dt"] = max(0.0, now - t["t"])
            t["box"] = [t["box"][0] + t["v"][0] * dt, t["box"][1] + t["v"][1] * dt, t["box"][2], t["box"][3]]
            t["t"] = now
        active = [t for t in self.tracks if now - t["seen"] <= self.coast]
        pairs = []
        for ti, t in enumerate(active):
            tx, ty, tw, th = t["box"]
            for di, d in enumerate(dets):
                if d["score"] < KEEP_SCORE:
                    continue
                box = d["box"]
                o = iou(t["box"], box)
                dist = np.hypot(tx + tw / 2 - box[0] - box[2] / 2, ty + th / 2 - box[1] - box[3] / 2)
                limit = 0.9 * max(tw, th, 1.0)
                if o > 0.1 or dist < limit:
                    pairs.append((o + max(0.0, 1 - dist / limit), ti, di))
        used_t, used_d = set(), set()
        for _, ti, di in sorted(pairs, reverse=True):
            if ti not in used_t and di not in used_d:
                used_t.add(ti)
                used_d.add(di)
                self._observe(active[ti], dets[di], di, now)
        for ti, t in enumerate(active):
            if ti not in used_t:
                t["v"] = [v * COAST_DAMP for v in t["v"]]
                self._good(t, False, now)
        for di, d in enumerate(dets):
            if di in used_d or d["score"] < START_SCORE:
                continue
            lost = [t for t in self.tracks if t["seen"] < now]
            best, best_sim = None, 0.0
            for t in lost:
                sim = cosine(d.get("emb"), t.get("emb"))
                if d["match"] and t["pid"] == d["match"][0]:
                    sim = max(sim, 1.0)
                if d.get("emb") is None or t.get("emb") is None:
                    tx, ty, tw, th = t["box"]
                    bx, by, bw, bh = d["box"]
                    dist = np.hypot(tx + tw / 2 - bx - bw / 2, ty + th / 2 - by - bh / 2)
                    sim = max(sim, REID_SIM if dist < 1.5 * max(tw, th) else 0.0)
                if sim >= REID_SIM and sim > best_sim:
                    best, best_sim = t, sim
            if best is not None:
                self._observe(best, d, di, now, restore=True)
                continue
            t = {"id": self.next_id, "box": list(d["box"]), "v": [0.0, 0.0], "seen": now, "t": now, "pid": None,
                 "name": None, "score": 0.0, "cand": None, "good": None, "emb": None}
            self.next_id += 1
            self._observe(t, d, di, now, restore=True)
            self.tracks.append(t)
        self.tracks = [t for t in self.tracks if now - t["seen"] <= self.reacquire]
        return self.snapshot(now)


def iou(a, b):
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    ix = max(0.0, min(ax + aw, bx + bw) - max(ax, bx))
    iy = max(0.0, min(ay + ah, by + bh) - max(ay, by))
    inter = ix * iy
    union = aw * ah + bw * bh - inter
    return inter / union if union > 0 else 0.0


class LiveSource:
    def __init__(self, store, faces=None, rate=12.0, room=None):
        self.store, self.rate, self.room = store, rate, room
        self._faces = faces
        self.faces_lock = threading.Lock()
        self.frame, self._jpeg, self.frame_ts = None, None, 0.0
        self.tracker = Tracker()
        self.track_lock = threading.Lock()
        self._embs = {}
        self._fps, self._count, self._fps_t = 0.0, 0, time.time()
        self._state = {"type": "detections", "w": 0, "h": 0, "fps": 0.0, "ts": time.time(), "live": False, "faces": []}
        self.running = False

    @property
    def faces(self):
        if self._faces is None:
            from faces import Faces
            self._faces = Faces()
            det = getattr(self._faces, "det", None)
            if det is not None and hasattr(det, "setScoreThreshold"):
                det.setScoreThreshold(KEEP_SCORE)
        return self._faces

    def _set_frame(self, frame, jpeg=None):
        if jpeg is None:
            ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
            jpeg = buf.tobytes() if ok else None
        self.frame, self._jpeg, self.frame_ts = frame, jpeg, time.time()
        self._count += 1
        if self.frame_ts - self._fps_t >= 1.0:
            self._fps = self._count / (self.frame_ts - self._fps_t)
            self._count, self._fps_t = 0, self.frame_ts

    def live(self):
        return self.frame is not None and time.time() - self.frame_ts < STALE_AFTER

    def jpeg(self):
        return self._jpeg

    def _find(self, frame):
        h, w = frame.shape[:2]
        s = min(1.0, DETECT_SIDE / max(h, w))
        small = frame if s >= 1.0 else cv2.resize(frame, (int(w * s), int(h * s)), interpolation=cv2.INTER_AREA)
        rows = []
        for f in self.faces.find(small):
            full = np.array(f, dtype=np.float32).copy()
            full[:14] /= s
            rows.append(full)
        return rows, s

    def _refine(self, pid, f, emb, frame, now, refine_emb):
        score, clear = clarity(frame, f, emb, self.store.embedding(pid))
        best, is_clear, last = self.store.thumb_state(pid)
        if is_clear:
            take = clear and score > best * CLEAR_BETTER and now - last >= CLEAR_INTERVAL
        else:
            take = clear or score > best
        if take:
            jpeg = thumb_jpeg(frame, f[:4])
            if jpeg:
                self.store.add_snapshot(pid, jpeg, score, now, clear=clear)
        if not (take and clear and refine_emb):
            return
        keep = sorted(self._embs.get(pid, []) + [(score, np.asarray(emb, np.float32).ravel())], key=lambda e: -e[0])
        self._embs[pid] = keep[:EMB_KEEP]
        if len(self._embs[pid]) > 1:
            vecs = [e / (np.linalg.norm(e) or 1.0) for _, e in self._embs[pid]]
            self.store.set_embedding(pid, np.mean(vecs, axis=0))

    def detect_once(self, now=None):
        frame, now = self.frame, time.time() if now is None else now
        dets = []
        if frame is not None and self.live():
            with self.faces_lock:
                rows, s = self._find(frame)
                for f in rows:
                    emb = self.faces.embed(frame, f)
                    match = self.store.match(emb)
                    q, ok = face_quality(frame, f, s)
                    if match:
                        self.store.seen(match[0], now)
                        self._refine(match[0], f, emb, frame, now, match[2] >= REFINE_MATCH)
                    dets.append({"box": [float(v) for v in f[:4]], "match": match, "score": float(f[14]),
                                 "good": self.room is not None and match is None and ok, "emb": emb, "q": q,
                                 "row": f})
        with self.track_lock:
            faces = self.tracker.update(dets, now)
            if self.room is not None:
                for t in self.tracker.ready(now, self.room.hold):
                    d = dets[t["det"]]
                    made = self.room.enrol(d["emb"], thumb_jpeg(frame, d["box"]), clarity(frame, d["row"])[0])
                    if made is None:
                        break
                    t["pid"], t["name"], t["score"], t["good"] = made[0], made[1], 1.0, None
                    self._embs[made[0]] = [(d["q"], np.asarray(d["emb"], np.float32).ravel())]
                faces = self.tracker.snapshot(now)
        for face in faces:
            face["thumbClear"] = bool(face["personId"]) and self.store.thumb_state(face["personId"])[1]
        h, w = frame.shape[:2] if frame is not None else (0, 0)
        self._state = {"type": "detections", "w": int(w), "h": int(h), "fps": round(self._fps, 1),
                       "ts": now, "live": self.live(), "faces": faces}

    def _detect_loop(self):
        while self.running:
            start = time.time()
            try:
                self.detect_once()
            except Exception as exc:
                log.warning("detection error: %s", type(exc).__name__)
            time.sleep(max(0.0, 1 / self.rate - (time.time() - start)))

    def start(self):
        self.running = True
        threading.Thread(target=self._detect_loop, daemon=True).start()

    def stop(self):
        self.running = False

    def detections(self):
        state = dict(self._state)
        state["live"] = self.live()
        return state

    def capture_face(self):
        frame = self.frame
        if frame is None or not self.live():
            raise ValueError("no camera frame available")
        with self.faces_lock:
            found = [f for f in self._find(frame)[0] if f[14] >= START_SCORE]
            if len(found) != 1:
                raise ValueError(f"need exactly one face in view, found {len(found)}")
            emb = self.faces.embed(frame, found[0])
        return emb, thumb_jpeg(frame, found[0][:4])

    def enrolled(self, pid, name):
        pass

    def forgot(self, pid):
        self._embs.pop(pid, None)
        with self.track_lock:
            self.tracker.forget(pid)

    def renamed(self, pid, name):
        with self.track_lock:
            self.tracker.rename(pid, name)

    def transcript(self):
        return None


class CameraSource(LiveSource):
    def __init__(self, store, index=0, **kw):
        super().__init__(store, **kw)
        self.cam = cv2.VideoCapture(index)
        if not self.cam.isOpened():
            raise RuntimeError("could not open the camera; allow camera access for your terminal")

    def _capture_loop(self):
        while self.running:
            ok, frame = self.cam.read()
            if ok:
                self._set_frame(frame)
            else:
                time.sleep(0.05)
        self.cam.release()

    def start(self):
        super().start()
        threading.Thread(target=self._capture_loop, daemon=True).start()


class IngestSource(LiveSource):
    def push_jpeg(self, data):
        if len(data) > MAX_FRAME:
            raise ValueError("frame larger than 1 MB")
        if data[:2] != b"\xff\xd8":
            raise ValueError("not a JPEG")
        frame = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
        if frame is None:
            raise ValueError("JPEG could not be decoded")
        self._set_frame(frame, bytes(data))
