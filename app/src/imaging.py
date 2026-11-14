import os

os.environ.setdefault("OPENCV_IO_MAX_IMAGE_PIXELS", "40000000")
import cv2  # noqa: E402
import numpy as np  # noqa: E402


def crop_box(shape, box, pad=1.6):
    fh, fw = shape[:2]
    x, y, w, h = [float(v) for v in box]
    side = int(min(max(w, h) * pad, fw, fh))
    cx, cy = x + w / 2, y + h / 2 - 0.1 * h
    x0 = int(min(max(0, cx - side / 2), fw - side))
    y0 = int(min(max(0, cy - side / 2), fh - side))
    return x0, y0, side


def square_jpeg(frame, box, side_px=256, pad=1.6):
    x0, y0, side = crop_box(frame.shape, box, pad)
    if side <= 0:
        return None
    crop = cv2.resize(frame[y0:y0 + side, x0:x0 + side], (side_px, side_px), interpolation=cv2.INTER_AREA)
    return cv2.imencode(".jpg", crop, [cv2.IMWRITE_JPEG_QUALITY, 88])[1].tobytes()


def video_jpeg(frame, max_width=960, quality=80):
    h, w = frame.shape[:2]
    if w > max_width:
        frame = cv2.resize(frame, (max_width, max(1, int(h * max_width / w))), interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, quality])
    return buf.tobytes() if ok else None


def landmarks_plausible(f):
    x, y, w, h = [float(v) for v in f[:4]]
    rex, rey, lex, ley, nx, ny, rmx, rmy, lmx, lmy = (float(v) for v in f[4:14])
    inside = all(x <= px <= x + w and y <= py <= y + h for px, py in
                 ((rex, rey), (lex, ley), (nx, ny), (rmx, rmy), (lmx, lmy)))
    eye_y, mouth_y = (rey + ley) / 2, (rmy + lmy) / 2
    eye_w, mouth_w = abs(lex - rex), abs(lmx - rmx)
    return (inside and eye_y < ny < mouth_y and eye_y < y + 0.65 * h and mouth_y > y + 0.5 * h
            and eye_w > 0 and 0.4 <= mouth_w / eye_w <= 1.6)


def cosine(a, b):
    if a is None or b is None:
        return 0.0
    d = float(np.linalg.norm(a) * np.linalg.norm(b))
    return float(np.dot(a, b) / d) if d else 0.0


def iou(a, b):
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    ix = max(0.0, min(ax + aw, bx + bw) - max(ax, bx))
    iy = max(0.0, min(ay + ah, by + bh) - max(ay, by))
    inter = ix * iy
    union = aw * ah + bw * bh - inter
    return inter / union if union > 0 else 0.0
