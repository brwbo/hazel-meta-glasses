const CSS = `
.v3d {
  --v3d-bg: #05070c;
  --v3d-ink: #c9dcff;
  --v3d-dim: #6f8fd0;
  --v3d-warn: #ff6b81;
  --v3d-cyan: #22d3ee;
  --v3d-cut: 14px;
  --v3d-font: var(--font-mono, ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace);
  position: relative; width: 100%; height: 100%; min-height: 200px; overflow: hidden; container-type: inline-size;
  background: var(--v3d-bg);
  clip-path: polygon(var(--v3d-cut) 0, 100% 0, 100% calc(100% - var(--v3d-cut)), calc(100% - var(--v3d-cut)) 100%, 0 100%, 0 var(--v3d-cut));
  color: var(--v3d-ink); font: 11px/1.45 var(--v3d-font); font-variant-numeric: tabular-nums;
}
.v3d::after {
  content: ""; position: absolute; inset: 0; pointer-events: none; background: color-mix(in srgb, var(--v3d-accent) 75%, transparent);
  clip-path: polygon(evenodd,
    var(--v3d-cut) 0, 100% 0, 100% calc(100% - var(--v3d-cut)), calc(100% - var(--v3d-cut)) 100%, 0 100%, 0 var(--v3d-cut), var(--v3d-cut) 0,
    calc(var(--v3d-cut) + 0.4px) 1px, 1px calc(var(--v3d-cut) + 0.4px), 1px calc(100% - 1px), calc(100% - var(--v3d-cut) - 0.4px) calc(100% - 1px),
    calc(100% - 1px) calc(100% - var(--v3d-cut) - 0.4px), calc(100% - 1px) 1px, calc(var(--v3d-cut) + 0.4px) 1px);
}
.v3d canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; cursor: grab; outline: none; }
.v3d.is-dragging canvas { cursor: grabbing; }
.v3d-read, .v3d-foot, .v3d-hint, .v3d-toggle, .v3d-scale { position: absolute; margin: 0; }
.v3d-read, .v3d-foot, .v3d-hint, .v3d-scale { pointer-events: none; }
.v3d-read {
  left: 12px; top: 11px; display: grid; grid-template-columns: auto auto; column-gap: 10px;
  padding-left: 8px; border-left: 1px solid color-mix(in srgb, var(--v3d-accent) 70%, transparent);
}
.v3d-read dt { color: var(--v3d-dim); }
.v3d-read dd { margin: 0; white-space: nowrap; }
.v3d-scale {
  left: 12px; top: 112px; bottom: 52px; width: 9px; opacity: 0.8;
  background:
    repeating-linear-gradient(to bottom, var(--v3d-accent) 0 1px, transparent 1px 30px) left / 9px 100% no-repeat,
    repeating-linear-gradient(to bottom, var(--v3d-dim) 0 1px, transparent 1px 6px) left / 4px 100% no-repeat;
}
.v3d-scale i { position: absolute; left: 0; width: 15px; height: 1px; background: var(--v3d-cyan); box-shadow: 0 0 6px var(--v3d-cyan); }
.v3d.is-glitch .v3d-read, .v3d.is-glitch .v3d-foot { animation: v3d-split 380ms steps(5, end) 1; }
@keyframes v3d-split {
  0% { text-shadow: 3px 0 var(--v3d-cyan), -3px 0 var(--v3d-accent); transform: translateX(2px); }
  40% { text-shadow: -2px 0 var(--v3d-cyan), 2px 0 var(--v3d-accent); transform: translateX(-1px); }
  100% { text-shadow: none; transform: none; }
}
.v3d-foot { left: 12px; bottom: 10px; max-width: calc(100% - 24px); }
.v3d-foot p { margin: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.v3d-status { color: var(--v3d-accent); }
.v3d-status.is-error { color: var(--v3d-warn); }
.v3d-status:empty { display: none; }
.v3d-label { padding-left: 8px; border-left: 1px solid var(--v3d-accent); }
.v3d-status + .v3d-label { margin-top: 4px; }
.v3d-hint { right: 12px; bottom: 10px; color: var(--v3d-dim); }
.v3d-toggle {
  right: 10px; top: 10px; min-height: 28px; padding: 4px 10px;
  border: 1px solid color-mix(in srgb, var(--v3d-accent) 55%, transparent); border-radius: 2px;
  background: color-mix(in srgb, var(--v3d-bg) 70%, transparent); color: var(--v3d-ink);
  font: inherit; cursor: pointer; transition: border-color 120ms ease, background-color 120ms ease;
}
.v3d-toggle:hover { border-color: var(--v3d-accent); background: color-mix(in srgb, var(--v3d-accent) 16%, var(--v3d-bg)); }
.v3d-toggle:active { background: color-mix(in srgb, var(--v3d-accent) 28%, var(--v3d-bg)); }
.v3d-toggle:focus-visible { outline: 1px solid var(--v3d-ink); outline-offset: 2px; }
.v3d [hidden] { display: none; }
.v3d.is-failed .v3d-foot { inset: 0; max-width: none; display: grid; place-items: center; padding: 16px; text-align: center; }
.v3d.is-failed .v3d-foot p { white-space: normal; }
@container (max-width: 560px) { .v3d-hint { display: none; } }
@media (pointer: coarse) { .v3d-toggle { min-height: 36px; padding: 6px 12px; } }
@media (prefers-reduced-motion: reduce) { .v3d-toggle { transition: none; } .v3d.is-glitch .v3d-read, .v3d.is-glitch .v3d-foot { animation: none; } }
`;

export function injectCss() {
  if (document.getElementById('v3d-style')) return;
  const style = document.createElement('style');
  style.id = 'v3d-style';
  style.textContent = CSS;
  document.head.appendChild(style);
}

function el(tag, className, parent, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  parent.appendChild(node);
  return node;
}

const metres = (v) => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2));

export function buildHud(container, accent) {
  const root = el('div', 'v3d', container);
  root.style.setProperty('--v3d-accent', accent);
  const canvas = el('canvas', '', root);
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', '3D model view. Drag to rotate, pinch to zoom, double-click to reset.');

  const read = el('dl', 'v3d-read', root);
  const row = (name) => {
    el('dt', '', read, name);
    return el('dd', '', read, '-');
  };
  const verts = row('verts');
  const tris = row('tris');
  const box = row('box');
  const rot = row('rot');
  const elev = row('elev');
  const scale = el('div', 'v3d-scale', root);
  const marker = el('i', '', scale);
  root.addEventListener('animationend', () => root.classList.remove('is-glitch'));

  const foot = el('div', 'v3d-foot', root);
  const status = el('p', 'v3d-status', foot);
  status.setAttribute('role', 'status');
  const label = el('p', 'v3d-label', foot);
  label.hidden = true;
  const hint = el('p', 'v3d-hint', root, 'drag to orbit, double-click to reset');
  const toggle = el('button', 'v3d-toggle', root);
  toggle.type = 'button';
  toggle.hidden = true;
  toggle.setAttribute('aria-label', 'Hologram view');

  const setStatus = (text, error = false) => {
    status.textContent = text;
    status.classList.toggle('is-error', error);
  };

  return {
    root,
    canvas,
    toggle,
    setStatus,
    setLabel(text) {
      label.textContent = text == null ? '' : String(text);
      label.hidden = !label.textContent;
    },
    setStats(stats, size) {
      verts.textContent = stats.vertices.toLocaleString('en-GB');
      tris.textContent = stats.triangles.toLocaleString('en-GB');
      box.textContent = `${metres(size.x)} x ${metres(size.y)} x ${metres(size.z)} m`;
    },
    setAngle(deg, elevation) {
      rot.textContent = `${String(deg).padStart(3, '0')}°`;
      elev.textContent = `${elevation}°`;
      marker.style.top = `${Math.min(Math.max(1 - elevation / 70, 0), 1) * 100}%`;
    },
    glitch() {
      root.classList.remove('is-glitch');
      void root.offsetWidth;
      root.classList.add('is-glitch');
    },
    fail(text) {
      canvas.remove();
      toggle.remove();
      read.remove();
      scale.remove();
      hint.remove();
      root.classList.add('is-failed');
      setStatus(text, true);
    },
  };
}
