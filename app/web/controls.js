export function setupControls({ overlay, card, grip, getKeys, pick, clearSel }) {
  function isTyping(el) {
    return el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!isTyping(e.target)) clearSel();
      return;
    }
    if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
    const keys = getKeys();
    if (keys) {
      const k = e.key.toLowerCase();
      if (k === "1" || k === "2" || k === "3") {
        e.preventDefault();
        return keys.tab(["data", "notes", "model"][Number(k) - 1]);
      }
      if (k === "r") {
        e.preventDefault();
        return keys.rename();
      }
      if (k === "e") {
        e.preventDefault();
        return keys.edit();
      }
      if (k === "x") {
        e.preventDefault();
        return keys.del();
      }
    }
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      const list = overlay.ordered();
      if (!list.length) return;
      e.preventDefault();
      let i = list.findIndex((t) => t.id === overlay.cursor);
      if (i < 0) i = e.key === "ArrowRight" ? -1 : list.length;
      i = (i + (e.key === "ArrowRight" ? 1 : -1) + list.length) % list.length;
      overlay.cursor = list[i].id;
      overlay.focus(list[i].id);
    } else if (e.key === "Enter" && e.target.tagName !== "BUTTON" && overlay.cursor != null) {
      e.preventDefault();
      pick(overlay.cursor);
    }
  });

  let drag = null;
  grip.addEventListener("pointerdown", (e) => {
    drag = { y: e.clientY, dy: 0 };
    grip.setPointerCapture(e.pointerId);
    card.classList.add("is-dragging");
  });
  grip.addEventListener("pointermove", (e) => {
    if (!drag) return;
    drag.dy = Math.max(0, e.clientY - drag.y);
    card.style.transform = `translateY(${drag.dy}px)`;
  });
  const endDrag = () => {
    if (!drag) return;
    card.classList.remove("is-dragging");
    const far = drag.dy > 90;
    drag = null;
    card.style.transform = "";
    if (far) clearSel();
  };
  grip.addEventListener("pointerup", endDrag);
  grip.addEventListener("pointercancel", endDrag);
  return { dragging: () => drag != null };
}
