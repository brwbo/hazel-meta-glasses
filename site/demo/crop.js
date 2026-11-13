export function cropFace(overlay, trackId, src) {
  const tr = overlay.tracks.get(trackId);
  if (!tr || !src) return null;
  const nw = src.naturalWidth || src.width;
  const nh = src.naturalHeight || src.height;
  if (!nw || !nh) return null;
  const k = nw / overlay.w;
  const [x, y, w, hh] = tr.last;
  const side = Math.max(w, hh) * 1.9 * k;
  const cx = (x + w / 2) * k;
  const cy = (y + hh * 0.42) * k;
  try {
    const c = document.createElement("canvas");
    c.width = c.height = 192;
    c.getContext("2d").drawImage(src, cx - side / 2, cy - side / 2, side, side, 0, 0, 192, 192);
    return c.toDataURL("image/jpeg", 0.85);
  } catch {
    return null;
  }
}
