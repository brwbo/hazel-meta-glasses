import sys
from fractions import Fraction
from pathlib import Path

import av

frames_dir = Path(sys.argv[1])
target = Path(sys.argv[2])
fps = int(sys.argv[3]) if len(sys.argv) > 3 else 30

files = sorted(frames_dir.glob("f*.jpg"))
if not files:
    raise SystemExit(f"no frames in {frames_dir}")

first = av.open(str(files[0]))
size = next(first.decode(video=0))
first.close()

out = av.open(str(target), "w", options={"movflags": "+faststart"})
stream = out.add_stream("libx264", rate=fps)
stream.width = size.width
stream.height = size.height
stream.pix_fmt = "yuv420p"
stream.time_base = Fraction(1, fps)
stream.codec_context.color_range = 1
stream.options = {"crf": "23", "preset": "slow", "profile": "high", "colorprim": "bt709", "transfer": "bt709", "colormatrix": "bt709"}

for i, path in enumerate(files):
    src = av.open(str(path))
    frame = next(src.decode(video=0))
    src.close()
    frame = frame.reformat(format="rgb24").reformat(format="yuv420p", dst_colorspace="ITU709", dst_color_range="MPEG")
    frame.pts = i
    frame.time_base = Fraction(1, fps)
    for packet in stream.encode(frame):
        out.mux(packet)

for packet in stream.encode():
    out.mux(packet)
out.close()
print(f"wrote {target}: {len(files)} frames, {size.width}x{size.height}, {fps} fps, {len(files) / fps:.2f} s")
