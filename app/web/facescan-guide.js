const BLUE = '59, 130, 246';
const PALE = '141, 189, 255';
const RAD = Math.PI / 180;
const HINT_TEXT = {
  'turn left': 'turn head left',
  'turn right': 'turn head right',
  'look up': 'look up a little',
  'look down': 'look down a little',
  'hold still': 'hold still',
  done: 'enough angles captured',
};

function surface(target) {
  if (target instanceof HTMLCanvasElement) return target;
  let canvas = target.querySelector(':scope > canvas[data-facescan-guide]');
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.dataset.facescanGuide = '';
    canvas.style.cssText = 'display:block;width:100%;height:100%;pointer-events:none';
    target.append(canvas);
  }
  return canvas;
}

function project(yaw, pitch, cx, cy, r) {
  return [cx + r * Math.sin(yaw * RAD) * Math.cos(pitch * RAD), cy - r * Math.sin(pitch * RAD)];
}

function cellPath(ctx, cell, cx, cy, r, gap) {
  const hy = cell.halfYaw || 7.5, hp = cell.halfPitch || 10;
  const y0 = cell.yaw - hy + gap, y1 = cell.yaw + hy - gap;
  const p0 = cell.pitch - hp + gap, p1 = cell.pitch + hp - gap;
  ctx.beginPath();
  const steps = 4;
  for (let i = 0; i <= steps; i++) {
    const [x, y] = project(y0, p0 + ((p1 - p0) * i) / steps, cx, cy, r);
    if (i) ctx.lineTo(x, y);
    else ctx.moveTo(x, y);
  }
  for (let i = steps; i >= 0; i--) {
    const [x, y] = project(y1, p0 + ((p1 - p0) * i) / steps, cx, cy, r);
    ctx.lineTo(x, y);
  }
  ctx.closePath();
}

export function renderScanGuide(target, progress, { subtle = false, label = true } = {}) {
  const canvas = surface(target);
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth || canvas.width / dpr || 160;
  const h = canvas.clientHeight || canvas.height / dpr || 160;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const hint = progress ? progress.hint : 'hold still';
  const text = HINT_TEXT[hint] || '';
  canvas.setAttribute('role', 'img');
  const pct = Math.round(((progress && progress.coverage) || 0) * 100);
  canvas.setAttribute('aria-label', `Face scan ${pct} percent of angles captured. ${text}.`);
  if (!progress) return canvas;

  const showLabel = label && Math.min(w, h) >= 96;
  const textRoom = showLabel ? 20 : 0;
  const outer = Math.max(8, Math.min(w, h - textRoom) / 2 - 3);
  const cx = w / 2, cy = (h - textRoom) / 2;
  const dim = subtle ? 0.6 : 1;
  const stroke = Math.max(1.5, outer * 0.045);

  const targets = progress.targets || 7;
  const met = Math.round(progress.coverage * targets);
  const arc = (Math.PI * 2) / targets;
  const pad = 0.05;
  ctx.lineWidth = stroke;
  ctx.lineCap = 'butt';
  for (let i = 0; i < targets; i++) {
    const a0 = -Math.PI / 2 + i * arc + pad, a1 = -Math.PI / 2 + (i + 1) * arc - pad;
    ctx.strokeStyle = i < met ? `rgba(${BLUE}, ${0.95 * dim})` : `rgba(${BLUE}, ${0.22 * dim})`;
    ctx.beginPath();
    ctx.arc(cx, cy, outer - stroke / 2, a0, a1);
    ctx.stroke();
  }

  const r = outer - stroke * 2.6;
  if (r > 14) {
    ctx.lineWidth = 1;
    for (const cell of progress.cells) {
      cellPath(ctx, cell, cx, cy, r, 1.4);
      if (cell.filled) {
        ctx.fillStyle = `rgba(${BLUE}, ${(cell.required ? 0.9 : 0.6) * dim})`;
        ctx.fill();
      } else {
        ctx.strokeStyle = `rgba(${BLUE}, ${(cell.required ? 0.55 : 0.2) * dim})`;
        ctx.stroke();
      }
    }
    if (Number.isFinite(progress.yaw)) {
      const yaw = Math.max(-65, Math.min(65, progress.yaw)), pitch = Math.max(-30, Math.min(30, progress.pitch));
      const [x, y] = project(yaw, pitch, cx, cy, r);
      ctx.fillStyle = `rgba(${PALE}, ${dim})`;
      ctx.beginPath();
      ctx.arc(x, y, Math.max(1.5, r * 0.035), 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = `rgba(4, 6, 11, 0.9)`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(x, y, Math.max(1.5, r * 0.035) + 1.5, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  if (showLabel) {
    ctx.font = '11px ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0.08em';
    ctx.fillStyle = `rgba(${PALE}, ${subtle ? 0.85 : 1})`;
    ctx.fillText(`${text.toUpperCase()}  ${pct}%`, cx, h - 5, w - 8);
  }
  return canvas;
}
