"""Opt-in face memory. Usage:
  python src/cli.py enrol "Sam" --consent "said yes verbally, 13 Nov"
  python src/cli.py recognise
  python src/cli.py list
  python src/cli.py delete "Sam"
Only people enrolled with a consent note are ever recognised. Unknown faces are not stored.
"""
import argparse
import sys
from pathlib import Path

import cv2

sys.path.insert(0, str(Path(__file__).resolve().parent))
from faces import Faces  # noqa: E402
from store import Store  # noqa: E402


def open_camera(index=0):
    cam = cv2.VideoCapture(index)
    if not cam.isOpened():
        sys.exit("Could not open the camera. Allow camera access for your terminal in System Settings.")
    return cam


def enrol(store, name, consent):
    faces, cam = Faces(), open_camera()
    print(f"Enrolling {name}. Face the camera alone, press SPACE to capture, Q to cancel.")
    while True:
        ok, frame = cam.read()
        if not ok:
            break
        found = faces.find(frame)
        shown = frame.copy()
        for f in found:
            x, y, w, h = map(int, f[:4])
            cv2.rectangle(shown, (x, y), (x + w, y + h), (0, 255, 0), 2)
        cv2.imshow("enrol", shown)
        key = cv2.waitKey(1) & 0xFF
        if key == ord("q"):
            break
        if key == ord(" "):
            if len(found) != 1:
                print("Need exactly one face in view.")
                continue
            store.enrol(name, faces.embed(frame, found[0]), consent)
            print(f"Enrolled {name}.")
            break
    cam.release()
    cv2.destroyAllWindows()


def recognise(store):
    faces, cam = Faces(), open_camera()
    print("Recognising enrolled people only. Press Q to quit.")
    while True:
        ok, frame = cam.read()
        if not ok:
            break
        for f in faces.find(frame):
            match = store.match(faces.embed(frame, f))
            x, y, w, h = map(int, f[:4])
            label = f"{match[1]} ({match[2]:.2f})" if match else "not enrolled"
            colour = (0, 255, 0) if match else (128, 128, 128)
            cv2.rectangle(frame, (x, y), (x + w, y + h), colour, 2)
            cv2.putText(frame, label, (x, y - 8), cv2.FONT_HERSHEY_SIMPLEX, 0.6, colour, 2)
        cv2.imshow("recognise", frame)
        if cv2.waitKey(1) & 0xFF == ord("q"):
            break
    cam.release()
    cv2.destroyAllWindows()


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--db", default="memory.db")
    sub = p.add_subparsers(dest="cmd", required=True)
    e = sub.add_parser("enrol")
    e.add_argument("name")
    e.add_argument("--consent", required=True, help="how and when the person agreed")
    sub.add_parser("recognise")
    sub.add_parser("list")
    d = sub.add_parser("delete")
    d.add_argument("name")
    args = p.parse_args()
    store = Store(args.db)
    if args.cmd == "enrol":
        enrol(store, args.name, args.consent)
    elif args.cmd == "recognise":
        recognise(store)
    elif args.cmd == "list":
        for pid, name, _ in store.people():
            print(pid, name)
    elif args.cmd == "delete":
        for pid, name, _ in store.people():
            if name == args.name:
                store.delete_person(pid)
                print(f"Deleted {name} and their notes.")


if __name__ == "__main__":
    main()
