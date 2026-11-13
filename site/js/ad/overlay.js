import { CUT, PERSON } from "./config.js";
import { clamp, ease, pulse, seg } from "./util.js";

export function createOverlay({ veil, tag, speech, hero, beats, rail }) {
  const items = beats.map((li) => ({ el: li, a: Number(li.dataset.in), b: Number(li.dataset.out) }));
  const ticks = rail ? [...rail.children] : [];
  let tagText = "";
  let speechText = "";
  let active = -2;

  const place = (el, a, x, y, extra = "") => {
    el.style.opacity = a.toFixed(3);
    el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) ${extra}`;
  };

  function update(t, anchors) {
    let current = -1;
    items.forEach((b, i) => {
      const a = pulse(t, b.a, b.b, 0.26);
      const rise = 1 - ease.outExpo(seg(t, b.a, b.a + 0.5));
      b.el.style.opacity = a.toFixed(3);
      b.el.style.transform = `translate3d(0, ${(rise * 22).toFixed(1)}px, 0)`;
      b.el.style.filter = a < 0.99 ? `blur(${((1 - a) * 5).toFixed(2)}px)` : "none";
      b.el.style.visibility = a > 0.005 ? "visible" : "hidden";
      if (a > 0.5) current = i;
    });
    if (current !== active) {
      active = current;
      ticks.forEach((el, i) => el.classList.toggle("is-on", i === current));
    }
    if (rail) rail.style.opacity = clamp(seg(t, CUT.meet + 0.2, CUT.meet + 0.6) * (1 - seg(t, CUT.dissolve, CUT.dissolve + 0.4))).toFixed(3);

    const v = Math.max(pulse(t, CUT.meet - 0.3, CUT.meet + 0.32, 0.3), seg(t, CUT.end - 0.32, CUT.end));
    veil.style.opacity = clamp(v).toFixed(3);

    const out = seg(t, 1.0, 1.4);
    hero.style.opacity = (1 - out).toFixed(3);
    hero.style.transform = `translate3d(0, ${(-out * 28).toFixed(1)}px, 0)`;
    hero.style.visibility = out < 1 ? "visible" : "hidden";

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
  }

  return { update };
}
