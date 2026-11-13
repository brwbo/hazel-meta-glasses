import { CUT, PERSON } from "./config.js";
import { clamp, ease, pulse, seg } from "./util.js";

const $ = (id) => document.getElementById(id);

export function createOverlay() {
  const caption = $("caption");
  const veil = $("veil");
  const tag = $("chip-tag");
  const speech = $("chip-speech");
  const endParts = [...$("endcard").children];
  const beats = [...document.querySelectorAll("#beats li")].map((li) => ({ text: li.textContent.trim(), a: Number(li.dataset.in), b: Number(li.dataset.out) }));
  let shown = -1;
  let tagText = "";
  let speechText = "";

  const place = (el, a, x, y, extra = "") => {
    el.style.opacity = a.toFixed(3);
    el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) ${extra}`;
  };

  function update(t, anchors) {
    const i = beats.findIndex((b) => t >= b.a && t <= b.b);
    if (i !== shown && i >= 0) {
      caption.textContent = beats[i].text;
      shown = i;
    }
    if (i >= 0) {
      const b = beats[i];
      const a = pulse(t, b.a, b.b, 0.26);
      const rise = 1 - ease.outExpo(seg(t, b.a, b.a + 0.5));
      caption.style.opacity = a.toFixed(3);
      caption.style.transform = `translate3d(0, ${(rise * 22).toFixed(1)}px, 0)`;
      caption.style.filter = a < 0.99 ? `blur(${((1 - a) * 5).toFixed(2)}px)` : "none";
    } else {
      caption.style.opacity = "0";
    }

    const v = Math.max(pulse(t, CUT.meet - 0.3, CUT.meet + 0.32, 0.3), pulse(t, CUT.end - 0.32, CUT.end + 0.34, 0.32));
    veil.style.opacity = clamp(v).toFixed(3);

    const inMeet = t >= CUT.meet && t < CUT.end;
    const named = t >= 3.45;
    const wantTag = named ? PERSON.first : PERSON.tagNew;
    if (wantTag !== tagText) {
      tag.textContent = wantTag;
      tagText = wantTag;
    }
    const tagA = inMeet ? pulse(t, 2.45, CUT.card + 0.45, 0.22) : 0;
    const pop = 1 + 0.16 * Math.sin(clamp((t - 3.45) / 0.3) * Math.PI);
    const tagIn = 1 - ease.outExpo(seg(t, 2.45, 2.85));
    place(tag, tagA, anchors.tag.x, anchors.tag.y - tagIn * 10, `translate(-50%, -100%) scale(${pop.toFixed(3)})`);

    const first = t < 5;
    const wantSpeech = first ? PERSON.hello : PERSON.ask;
    if (wantSpeech !== speechText) {
      speech.textContent = `“${wantSpeech}”`;
      speechText = wantSpeech;
    }
    const [sa, sb] = first ? [2.8, 4.15] : [6.3, 7.85];
    const speechA = inMeet ? pulse(t, sa, sb, 0.2) : 0;
    const grow = 0.86 + 0.14 * ease.outBack(seg(t, sa, sa + 0.35));
    speech.style.transformOrigin = "100% 100%";
    place(speech, speechA, Math.max(anchors.speech.x, speech.offsetWidth + 14), anchors.speech.y, `translate(-100%, -100%) scale(${grow.toFixed(3)})`);

    endParts.forEach((el, n) => {
      const k = seg(t, CUT.end + 0.3 + n * 0.22, CUT.end + 0.9 + n * 0.22);
      const e = ease.outExpo(k);
      el.style.opacity = clamp(k * 1.6).toFixed(3);
      el.style.transform = `translate3d(0, ${((1 - e) * 26).toFixed(1)}px, 0)`;
    });
  }

  return { update };
}
