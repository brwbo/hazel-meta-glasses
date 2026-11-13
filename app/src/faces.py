"""Face detection and embedding using OpenCV's YuNet detector and SFace recogniser."""
from pathlib import Path

import cv2

MODELS = Path(__file__).resolve().parent.parent / "models"


class Faces:
    def __init__(self):
        newer = MODELS / "face_detection_yunet_2026may.onnx"
        older = MODELS / "face_detection_yunet_2023mar.onnx"
        self.det = cv2.FaceDetectorYN.create(
            str(newer if newer.exists() else older), "", (320, 320), 0.8, 0.3, 5000
        )
        self.rec = cv2.FaceRecognizerSF.create(
            str(MODELS / "face_recognition_sface_2021dec.onnx"), ""
        )

    def find(self, frame):
        h, w = frame.shape[:2]
        self.det.setInputSize((w, h))
        _, faces = self.det.detect(frame)
        return [] if faces is None else list(faces)

    def embed(self, frame, face):
        aligned = self.rec.alignCrop(frame, face)
        return self.rec.feature(aligned).ravel()
