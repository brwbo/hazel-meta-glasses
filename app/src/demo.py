import math
import random
import threading
import time

import cv2
import numpy as np

W, H = 960, 540
FPS = 15.0

PEOPLE = [
    {
        "name": "Sam Lee",
        "role": "Robotics researcher, Aalto University",
        "tags": ["robotics", "aalto", "manipulation", "ros2"],
        "summary": "Works on grasping for soft robot hands at Aalto. Met at the Junction opening talk; interested in using vision for tactile feedback.",
        "followups": ["Send the paper on soft grippers", "Ask about the lab open day in December"],
        "notes": [
            (3 * 86400, "Met at the opening keynote. Building a soft gripper that learns from failed grasps."),
            (2 * 86400, "Recommended the ROS2 Jazzy migration guide. Prefers Signal over email."),
            (3600, "Said the lab might lend us a depth camera for the demo."),
        ],
        "skin": (150, 180, 215),
        "shirt": (160, 90, 40),
    },
    {
        "name": "Priya Shah",
        "role": "Founder, climate data startup",
        "tags": ["climate", "founder", "satellite data", "fundraising"],
        "summary": "Runs a small startup turning satellite methane data into reports for city councils. Hiring a frontend engineer and looking for pilot cities.",
        "followups": ["Intro to the Helsinki city data team", "Share our demo video after the event"],
        "notes": [
            (5 * 86400, "Pitched at the climate track mixer. Two pilot cities in Finland so far."),
            (86400, "Raising a pre-seed round in January. Wants feedback on the dashboard UX."),
        ],
        "skin": (110, 140, 185),
        "shirt": (70, 140, 60),
    },
    {
        "name": "Joon Park",
        "role": "Design student",
        "tags": ["design", "interaction", "student", "3d"],
        "summary": "Second year interaction design student. Makes 3D portraits from phone scans and wants to try them in AR glasses.",
        "followups": ["Ask for the photogrammetry workflow", "Invite to the team for the next hackathon"],
        "notes": [
            (2 * 86400, "Showed a phone-scanned 3D portrait that looked better than ours."),
            (1800, "Uses Blender plus Reality Scan; exports glb under 10 MB."),
        ],
        "skin": (135, 165, 200),
        "shirt": (60, 60, 150),
    },
]

LINES = {
    "Sam Lee": [
        "The gripper finally picked up a raspberry without crushing it.",
        "We should compare notes on depth sensing after the judging.",
    ],
    "Priya Shah": [
        "Our next pilot city wants weekly methane reports.",
        "If your demo works on glasses, I would love to try it at the climate booth.",
    ],
    "Joon Park": [
        "I can scan your heads tonight if you want better 3D models.",
        "The glb export keeps the textures if you bake them first.",
    ],
}
GENERIC = ["Nice to meet you, what are you building this weekend?", "Let's keep in touch after Junction."]


def _path(seed):
    rng = random.Random(seed)
    return {
        "ax": rng.uniform(260, 380),
        "ay": rng.uniform(40, 110),
        "wx": rng.uniform(0.18, 0.32) * rng.choice([-1, 1]),
        "wy": rng.uniform(0.3, 0.55),
        "px": rng.uniform(0, 2 * math.pi),
        "py": rng.uniform(0, 2 * math.pi),
        "size": rng.uniform(95, 130),
    }


def draw_person(img, cx, cy, size, skin, shirt):
    hw, hh = int(size * 0.42), int(size * 0.55)
    cv2.ellipse(img, (int(cx), int(cy + size * 1.25)), (int(size * 0.95), int(size * 0.7)), 0, 180, 360, shirt, -1, cv2.LINE_AA)
    cv2.ellipse(img, (int(cx), int(cy)), (hw, hh), 0, 0, 360, skin, -1, cv2.LINE_AA)
    hair = tuple(int(c * 0.35) for c in skin)
    cv2.ellipse(img, (int(cx), int(cy - hh * 0.35)), (hw, int(hh * 0.7)), 0, 180, 360, hair, -1, cv2.LINE_AA)
    for dx in (-0.4, 0.4):
        cv2.circle(img, (int(cx + dx * hw), int(cy - hh * 0.05)), max(2, int(size * 0.045)), (40, 40, 40), -1, cv2.LINE_AA)
    cv2.ellipse(img, (int(cx), int(cy + hh * 0.45)), (int(hw * 0.35), int(hh * 0.1)), 0, 0, 180, (70, 70, 140), 2, cv2.LINE_AA)


def make_thumb(person, size=192):
    img = np.full((size, size, 3), (60, 52, 46), np.uint8)
    draw_person(img, size / 2, size * 0.45, size * 0.62, person["skin"], person["shirt"])
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 85])
    return buf.tobytes()


def seed(store):
    rng = np.random.default_rng(7)
    ids = []
    now = time.time()
    for p in PEOPLE:
        pid = store.enrol(p["name"], rng.normal(size=128).astype(np.float32), "demo person, fictional", p["role"],
                          make_thumb(p), thumb_clear=True)
        store.update_profile(pid, summary=p["summary"], tags=p["tags"], followups=p["followups"])
        for ago, text in p["notes"]:
            store.add_note(pid, text, ts=now - ago)
        ids.append(pid)
    return ids


class DemoSource:
    def __init__(self, store, room=None, room_hold=4.0, late=8.0):
        self.store, self.room, self.room_hold = store, room, room_hold
        self.lock = threading.Lock()
        self.slots = []
        for i, (p, pid) in enumerate(zip(PEOPLE, seed(store))):
            self.slots.append({"track": i + 1, "pid": pid, "name": p["name"], "look": p, "path": _path(i * 11 + 3),
                               "born": 0.0})
        self._next_track = len(self.slots) + 1
        self.t0 = time.time()
        self._add_stranger()
        if room is not None:
            self._add_stranger(born=self.t0 + late)
        self._jpeg = None
        self._running = False
        self._thread = None
        self._last_line = 0.0

    def _add_stranger(self, born=None):
        rng = random.Random(self._next_track)
        look = {"skin": (rng.randint(100, 170), rng.randint(130, 190), rng.randint(170, 225)),
                "shirt": (rng.randint(40, 200), rng.randint(40, 200), rng.randint(40, 200))}
        self.slots.append({"track": self._next_track, "pid": None, "name": None, "look": look,
                           "path": _path(self._next_track * 17 + 5), "born": time.time() if born is None else born})
        self._next_track += 1

    def _pos(self, slot, t):
        p = slot["path"]
        cx = W / 2 + p["ax"] * math.sin(p["wx"] * t + p["px"])
        cy = H * 0.42 + p["ay"] * math.sin(p["wy"] * t + p["py"])
        return cx, cy, p["size"]

    def _render(self, t):
        y = np.linspace(0, 1, H, dtype=np.float32)[:, None]
        x = np.linspace(0, 1, W, dtype=np.float32)[None, :]
        shift = 0.5 + 0.5 * math.sin(t * 0.2)
        img = np.empty((H, W, 3), np.uint8)
        img[..., 0] = (70 + 50 * y + 20 * x * shift).astype(np.uint8)
        img[..., 1] = (55 + 35 * y + 15 * shift).astype(np.uint8)
        img[..., 2] = (45 + 30 * x + 25 * (1 - y)).astype(np.uint8)
        cv2.rectangle(img, (0, int(H * 0.78)), (W, H), (40, 45, 50), -1)
        with self.lock:
            slots = [s for s in self.slots if s["born"] <= self.t0 + t]
        for slot in sorted(slots, key=lambda s: self._pos(s, t)[2]):
            cx, cy, size = self._pos(slot, t)
            draw_person(img, cx, cy, size, slot["look"]["skin"], slot["look"]["shirt"])
        return img

    def _loop(self):
        while self._running:
            start = time.time()
            ok, buf = cv2.imencode(".jpg", self._render(start - self.t0), [cv2.IMWRITE_JPEG_QUALITY, 80])
            if ok:
                self._jpeg = buf.tobytes()
            time.sleep(max(0.0, 1 / FPS - (time.time() - start)))

    def start(self):
        if self._running:
            return
        self._running = True
        self._jpeg = cv2.imencode(".jpg", self._render(0.0))[1].tobytes()
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def stop(self):
        self._running = False

    def jpeg(self):
        return self._jpeg

    def _auto_enrol(self, now):
        with self.lock:
            ready = [s for s in self.slots if s["pid"] is None and s["born"] <= now - self.room_hold]
        for s in ready:
            made = self.room.enrol(np.random.default_rng(s["track"] + 1000).normal(size=128).astype(np.float32),
                                   make_thumb(s["look"]), clear=True)
            if made is None:
                return
            with self.lock:
                s["pid"], s["name"] = made

    def detections(self, now=None):
        now = time.time() if now is None else now
        t = now - self.t0
        faces = []
        if self.room is not None:
            self._auto_enrol(now)
        with self.lock:
            slots = [s for s in self.slots if s["born"] <= now]
        for slot in slots:
            cx, cy, size = self._pos(slot, t)
            bw, bh = size * 0.84, size * 1.1
            pid = slot["pid"]
            if pid is not None:
                self.store.seen(pid, now)
            faces.append({
                "trackId": slot["track"],
                "box": [round(cx - bw / 2, 1), round(cy - bh / 2, 1), round(bw, 1), round(bh, 1)],
                "personId": pid,
                "name": slot["name"] if pid is not None else None,
                "score": round(0.62 + 0.08 * math.sin(t + slot["track"]), 3) if pid is not None else 0.0,
                "predicted": False,
                "thumbClear": pid is not None,
            })
        return {"type": "detections", "w": W, "h": H, "fps": FPS, "ts": now, "live": True, "faces": faces}

    def capture_face(self):
        now = time.time()
        with self.lock:
            free = [s for s in self.slots if s["pid"] is None and s["born"] <= now]
        if len(free) != 1:
            raise ValueError(f"need exactly one unenrolled face in view, found {len(free)}")
        look = free[0]["look"]
        emb = np.random.default_rng(free[0]["track"]).normal(size=128).astype(np.float32)
        return emb, make_thumb(look)

    def enrolled(self, pid, name):
        with self.lock:
            for s in self.slots:
                if s["pid"] is None and s["born"] <= time.time():
                    s["pid"], s["name"] = pid, name
                    break
            if len(self.slots) < 6:
                self._add_stranger()

    def forgot(self, pid):
        with self.lock:
            for s in self.slots:
                if s["pid"] == pid:
                    s["pid"], s["name"], s["born"] = None, None, time.time()
            free = [s for s in self.slots if s["pid"] is None]
            for extra in free[1:]:
                self.slots.remove(extra)

    def renamed(self, pid, name):
        with self.lock:
            for s in self.slots:
                if s["pid"] == pid:
                    s["name"] = name

    def transcript(self, interval=20.0):
        now = time.time()
        if now - self._last_line < interval:
            return None
        self._last_line = now
        with self.lock:
            bound = [s for s in self.slots if s["pid"] is not None]
        if not bound:
            return None
        s = random.choice(bound)
        text = random.choice(LINES.get(s["name"], GENERIC))
        return {"type": "transcript", "personId": s["pid"], "text": text, "ts": now}
