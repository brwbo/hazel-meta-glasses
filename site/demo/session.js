import { h, api } from "./util.js";

export function setupSession({ indicator, slot, onWiped }) {
  let data = { roomConsent: false, text: "", autoEnrolled: 0 };
  let confirming = false;
  let peopleCount = 0;

  const count = () => {
    const a = data.autoEnrolled;
    if (Array.isArray(a)) return a.length;
    if (typeof a === "number") return a;
    return peopleCount;
  };

  const open = (on) => {
    slot.hidden = !on || !data.roomConsent;
    indicator.setAttribute("aria-expanded", String(!slot.hidden));
    if (!slot.hidden) slot.querySelector("button")?.focus();
  };
  indicator.addEventListener("click", () => open(slot.hidden));
  document.addEventListener("pointerdown", (e) => {
    if (!slot.hidden && !slot.contains(e.target) && !indicator.contains(e.target)) open(false);
  });
  slot.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      open(false);
      indicator.focus();
    }
  });

  const render = () => {
    const on = !!data.roomConsent;
    indicator.hidden = !on;
    if (!on) {
      slot.hidden = true;
      return;
    }
    const full = `Room consent session active${data.text ? `: ${data.text}` : ""}`;
    indicator.title = full;
    indicator.setAttribute("aria-label", `${full}. Open session controls.`);
    const n = count();
    const head = [
      h("p", { class: "micro", text: "Room consent session" }),
      data.text ? h("p", { class: "session-text", text: data.text }) : null,
      h("p", { class: "hint", text: `${n} ${n === 1 ? "person" : "people"} captured in this session.` }),
    ];
    if (!confirming) {
      slot.replaceChildren(...head.filter(Boolean),
        h("button", { type: "button", class: "btn btn-danger-ghost", onclick: () => { confirming = true; render(); } }, h("span", { text: "Wipe all" })));
      return;
    }
    const err = h("p", { class: "form-error", role: "alert" });
    const go = h("button", { type: "button", class: "btn btn-danger" }, h("span", { text: "Wipe for good" }));
    const cancel = h("button", { type: "button", class: "btn btn-ghost", onclick: () => { confirming = false; render(); } }, h("span", { text: "Cancel" }));
    go.addEventListener("click", async () => {
      go.disabled = true;
      try {
        await api.wipe();
        confirming = false;
        await refresh();
        onWiped();
      } catch (e) {
        go.disabled = false;
        err.textContent = e.message;
      }
    });
    slot.replaceChildren(...head.filter(Boolean),
      h("p", { class: "session-text", text: `Delete all ${n} profiles, faces and notes from this session? This cannot be undone.` }),
      h("div", { class: "row" }, go, cancel), err);
    if (!slot.hidden) cancel.focus();
  };

  async function refresh() {
    try {
      const s = await api.session();
      if (s && typeof s === "object") data = { ...data, ...s };
    } catch {
      data = { ...data };
    }
    render();
  }

  return {
    refresh,
    message(msg) {
      data = { ...data, roomConsent: !!msg.roomConsent, text: msg.text ?? data.text };
      if (msg.autoEnrolled != null) data.autoEnrolled = msg.autoEnrolled;
      if (!confirming) render();
    },
    setPeople(n) {
      peopleCount = n;
      if (!confirming) render();
    },
  };
}
