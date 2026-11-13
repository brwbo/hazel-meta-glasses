import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
from faces import Faces  # noqa: E402


def test_blank_frame_has_no_faces():
    assert Faces().find(np.zeros((480, 640, 3), dtype=np.uint8)) == []
