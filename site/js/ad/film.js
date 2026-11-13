import * as THREE from "three";
import { CUT } from "./config.js";
import { clamp, ease, lerp, pulse, seg } from "./util.js";
import { buildGlasses } from "./models/glasses.js";
import { buildPerson } from "./models/person.js";
import { buildBackdrop, buildBrackets, buildDesk, buildPills } from "./models/props.js";
import { buildCard } from "./models/card.js";
import { buildDissolve, buildFall, buildField, buildWipe, SWEEP_N, sweepDistance } from "./models/flakes.js";

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const MIRA = V(0.75, 0, 0);
const FACE = V(0.75, 1.64, 0);
const MOUTH = V(0.52, 1.585, 0.08);
const CARD_POS = V(0.62, 1.57, 0.62);
const CARD_YAW = -Math.PI / 2 + 0.22;

const SHOTS = {
  heroA: [V(1.7, 1.35, 4.6), V(0, 1.0, 0), 30],
  heroB: [V(0.52, 0.99, 1.0), V(0.43, 0.94, 0), 30],
  povA: [V(-1.0, 1.63, 0.03), V(0.75, 1.6, 0), 33],
  povB: [V(-0.72, 1.62, 0), V(0.75, 1.6, 0), 33],
  card: [V(-0.74, 1.6, 0.34), V(0.75, 1.57, 0.3), 33],
  note: [V(-0.55, 1.56, 0.5), V(0.75, 1.56, 0.47), 36],
  noteB: [V(-0.5, 1.56, 0.52), V(0.75, 1.55, 0.48), 36],
  leave: [V(-0.85, 1.66, 0.42), V(0.75, 1.78, 0.36), 36],
  endA: [V(0.25, 1.85, 4.5), V(0, 0.7, 0), 30],
  endB: [V(0, 1.62, 3.95), V(0, 0.66, 0), 30],
};

const KEY = { meet: [V(-2.0, 4.6, -2.6), V(0.7, 1.2, 0), V(3, 2.5, 3)], hero: [V(-3, 5, 3.5), V(0, 0.4, 0), V(3, 2.5, -4)] };
const UP = V(0, 1, 0);
const STILL = { live: 0, px: 0, py: 0, shiftX: 0, shiftY: 0 };

const pos = new THREE.Vector3();
const look = new THREE.Vector3();
const a3 = new THREE.Vector3();
const b3 = new THREE.Vector3();
const c3 = new THREE.Vector3();
const side = new THREE.Vector3();

function mix(from, to, k) {
  pos.lerpVectors(from[0], to[0], k);
  look.lerpVectors(from[1], to[1], k);
  return lerp(from[2], to[2], k);
}

export function createFilm(stage) {
  const { scene, camera } = stage;
  const hero = new THREE.Group();
  const meet = new THREE.Group();
  scene.add(hero, meet);

  const glasses = buildGlasses();
  hero.add(glasses.group);
  const heroBackdrop = buildBackdrop();
  heroBackdrop.position.set(0, 0, -4.6);
  hero.add(heroBackdrop);
  const heroField = buildField({ count: 150, clusters: 12, min: [-4.5, 0.25, -4], max: [4.5, 3.4, 2.6], scale: [0.03, 0.06], seed: 9, keepOut: (p) => Math.abs(p[0]) < 1.3 && p[1] > 0.4 && p[1] < 1.7 && p[2] > -1.2 });
  hero.add(heroField.group);
  const fall = buildFall({ t0: CUT.end - 0.1, spread: 1.0 });
  hero.add(fall.group);

  const mira = buildPerson();
  mira.group.position.copy(MIRA);
  mira.group.rotation.y = -Math.PI / 2;
  meet.add(mira.group);
  const desk = buildDesk();
  desk.position.set(2.15, 0, -0.95);
  desk.rotation.y = -Math.PI / 2 + 0.4;
  meet.add(desk);
  const meetBackdrop = buildBackdrop();
  meetBackdrop.position.set(4.4, 0, -0.2);
  meetBackdrop.rotation.y = -Math.PI / 2;
  meet.add(meetBackdrop);
  const meetField = buildField({ count: 190, clusters: 14, min: [-0.2, 0.6, -2.6], max: [3.8, 2.8, 2.6], scale: [0.011, 0.022], seed: 21, keepOut: (p) => p[0] < 1.3 && p[1] > 1.15 && p[1] < 2.1 && p[2] > -0.6 && p[2] < 1.2 });
  meet.add(meetField.group);

  const card = buildCard(stage.renderer);
  meet.add(card.group);
  const clip = new THREE.Plane(new THREE.Vector3(0, 1, 0), 100);
  card.materials.forEach((m) => {
    m.clippingPlanes = [clip];
  });
  const brackets = buildBrackets();
  meet.add(brackets.group);
  const pills = buildPills();
  meet.add(pills.group);
  const dissolve = buildDissolve();
  meet.add(dissolve.mesh);

  const wipe = buildWipe();
  camera.add(wipe.mesh);

  const anchors = { tag: { x: 0, y: 0 }, speech: { x: 0, y: 0 } };
  const noteTarget = card.px(330, 800);

  function cameraAt(t, view) {
    let fov;
    let sway = 0.035;
    if (t < CUT.meet) {
      const k = seg(t, 0, CUT.meet);
      fov = mix(SHOTS.heroA, SHOTS.heroB, 0.22 * k + 0.78 * ease.in(k));
      sway = lerp(0.3, 0.03, ease.inOut(seg(t, 0.95, CUT.meet)));
    } else if (t < CUT.end) {
      fov = mix(SHOTS.povA, SHOTS.povB, ease.outExpo(seg(t, CUT.meet, CUT.meet + 1.6)));
      const steps = [
        [SHOTS.card, ease.inOut(seg(t, CUT.card - 0.1, CUT.card + 0.8))],
        [SHOTS.note, ease.inOut(seg(t, CUT.note - 0.1, CUT.note + 0.8))],
        [SHOTS.noteB, seg(t, CUT.note + 0.8, CUT.dissolve)],
        [SHOTS.leave, ease.inOut(seg(t, CUT.dissolve, CUT.end + 0.2))],
      ];
      steps.forEach(([shot, k]) => {
        if (k <= 0) return;
        pos.lerp(shot[0], k);
        look.lerp(shot[1], k);
        fov = lerp(fov, shot[2], k);
      });
    } else {
      fov = mix(SHOTS.endA, SHOTS.endB, ease.outExpo(seg(t, CUT.end, CUT.end + 2.4)));
      sway = 0.2;
    }
    side.subVectors(look, pos).cross(UP).normalize();
    pos.addScaledVector(side, view.px * sway);
    pos.y -= view.py * sway * 0.5;
    stage.setShot(pos, look, fov);
    const { w, h } = stage.size;
    if (view.shiftX || view.shiftY) camera.setViewOffset(w, h, -view.shiftX * w, -view.shiftY * h, w, h);
    else if (camera.view) camera.clearViewOffset();
    camera.updateMatrixWorld(true);
  }

  function heroAt(t, view) {
    const live = view.live;
    const end = t >= CUT.end;
    const g = glasses.group;
    if (!end) {
      const k = seg(t, 0, CUT.meet);
      const free = 1 - ease.inOut(seg(t, 0.95, CUT.meet));
      g.scale.setScalar(1);
      g.position.set(0, 1.0 + Math.sin(live * 2.2) * 0.012, 0);
      g.rotation.set(0.04 * (1 - k) + view.py * 0.1 * free, lerp(0.62, 0.08, ease.out(k)) + view.px * 0.2 * free, 0.03 * (1 - k));
      glasses.setGlow(ease.out(seg(t, 0.2, 0.85)));
    } else {
      const drop = ease.outBack(seg(t, CUT.end, CUT.end + 0.55));
      g.scale.setScalar(1.25);
      g.position.set(0, 0.3 + (1 - drop) * 0.5, -0.2);
      g.rotation.set(-0.05, 0.42 - (1 - drop) * 0.2, 0);
      glasses.setGlow(0.82 + 0.18 * Math.sin(live * 3.2));
    }
    heroField.group.visible = !end;
    fall.group.visible = end;
    if (end) fall.update(t);
    else heroField.update(live);
  }

  function meetAt(t, view) {
    const live = view.live;
    const talk = pulse(t, 2.85, 3.8, 0.15) + pulse(t, 6.35, 7.7, 0.15);
    mira.group.position.y = Math.sin(live * 1.7) * 0.004;
    mira.group.position.x = MIRA.x + (1 - ease.outExpo(seg(t, CUT.meet - 0.2, CUT.meet + 1.1))) * 0.22;
    mira.head.rotation.set(Math.sin(live * 9) * 0.035 * talk + 0.03, Math.sin(live * 1.3) * 0.07 + 0.25 * ease.inOut(seg(t, CUT.card + 0.2, CUT.card + 1.0)) * (1 - ease.inOut(seg(t, 6.2, 6.8))), Math.sin(live * 1.1 + 1) * 0.03);
    meetField.update(live);

    const lock = seg(t, 2.15, 2.55);
    const half = lerp(0.44, 0.178, ease.outBack(lock)) * (1 + 0.04 * Math.sin(clamp((t - 2.55) / 0.3) * Math.PI));
    const dim = 1 - 0.45 * seg(t, CUT.card, CUT.card + 0.5);
    brackets.set(half, seg(t, 2.15, 2.32) * dim * (1 - seg(t, CUT.dissolve, CUT.dissolve + 0.3)));
    brackets.group.position.set(FACE.x - 0.2, FACE.y - 0.005 + mira.group.position.y, FACE.z);
    brackets.group.quaternion.copy(camera.quaternion);

    const slide = seg(t, CUT.card + 0.05, CUT.card + 0.85);
    const s = ease.outExpo(slide);
    card.group.visible = slide > 0 && t < CUT.end;
    card.group.position.set(CARD_POS.x, CARD_POS.y + Math.sin(live * 1.4) * 0.006 - (1 - s) * 0.12, CARD_POS.z + (1 - s) * 1.25);
    card.group.rotation.set(0, CARD_YAW - (1 - ease.outBack(slide)) * 1.25 + Math.sin(live * 0.9) * 0.025, (1 - s) * 0.18);
    card.group.scale.setScalar(lerp(0.8, 1, s));
    card.update({
      nameChars: Math.round(seg(t, 4.7, 5.4) * 12),
      role: ease.out(seg(t, 5.4, 5.75)),
      summary: seg(t, 5.65, 6.45),
      note: ease.inOut(seg(t, 7.7, 8.55)),
      fu0: ease.out(seg(t, 8.5, 8.75)),
      tick0: seg(t, 8.95, 9.2),
      fu1: ease.out(seg(t, 8.7, 8.95)),
      tick1: seg(t, 9.35, 9.6),
    });

    card.group.updateWorldMatrix(true, false);
    const gone = seg(t, CUT.dissolve, CUT.dissolve + 0.75);
    a3.copy(SWEEP_N).transformDirection(card.group.matrixWorld);
    b3.copy(SWEEP_N).multiplyScalar(sweepDistance(gone)).applyMatrix4(card.group.matrixWorld);
    clip.setFromNormalAndCoplanarPoint(a3, b3);
    card.shadowMat.opacity = 0.5 * s * (1 - gone);
    dissolve.update(t, CUT.dissolve, 0.75, card.group);

    c3.copy(noteTarget).applyMatrix4(card.group.matrixWorld);
    pills.pills.forEach((p, i) => {
      const k = seg(t, 7.0 + i * 0.1, 7.6 + i * 0.1);
      p.visible = k > 0 && k < 1;
      if (!p.visible) return;
      const e = ease.inOut(k);
      a3.lerpVectors(MOUTH, c3, e);
      a3.y += Math.sin(e * Math.PI) * (0.1 + (i % 2) * 0.04);
      a3.x -= Math.sin(e * Math.PI) * 0.12;
      p.position.copy(a3);
      p.rotation.set(0, e * 4 + i, Math.PI / 2 + e * 3);
      p.scale.setScalar(Math.sin(k * Math.PI));
    });
  }

  function update(t, view = STILL) {
    const inMeet = t >= CUT.meet && t < CUT.end;
    hero.visible = !inMeet;
    meet.visible = inMeet;
    cameraAt(t, view);
    if (inMeet) {
      stage.setKey(KEY.meet[0], KEY.meet[1], KEY.meet[2]);
      meetAt(t, view);
      a3.copy(camera.up).applyQuaternion(camera.quaternion).multiplyScalar(0.235).add(brackets.group.position);
      Object.assign(anchors.tag, stage.project(a3));
      Object.assign(anchors.speech, stage.project(a3.set(MOUTH.x, 1.69, -0.2)));
    } else {
      stage.setKey(KEY.hero[0], KEY.hero[1], KEY.hero[2]);
      heroAt(t, view);
    }
    wipe.update(seg(t, CUT.meet - 0.55, CUT.meet + 0.5), 1);
    if (t > CUT.dissolve) wipe.update(seg(t, CUT.end - 0.6, CUT.end + 0.5), -1);
    stage.render();
  }

  return { update, anchors };
}
