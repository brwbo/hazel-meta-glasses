import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { createHolo, createBust, meshStats, samplePoints, disposeTree } from './viewer3d-holo.js';
import { createStage } from './viewer3d-stage.js';
import { injectCss, buildHud } from './viewer3d-hud.js';

const DRACO_FALLBACK = 'https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/libs/draco/gltf/';
const WIRE_TRIANGLE_LIMIT = 300000;
const INTRO_SECONDS = 1.3;
const BACKGROUND = 0x05070c;
const DEFAULT_DIR = new THREE.Vector3(0.38, 0.2, 1).normalize();
const smooth = (t) => t * t * (3 - 2 * t);

function dracoPath() {
  try {
    return import.meta.resolve('three/addons/libs/draco/gltf/');
  } catch {
    return DRACO_FALLBACK;
  }
}

export function mountViewer(container, { accent = '#3b82f6' } = {}) {
  injectCss();
  const hud = buildHud(container, accent);
  const { root, canvas, toggle } = hud;

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
  } catch {
    hud.fail('3d view unavailable: this browser has webgl turned off');
    return { setModel() {}, setLabel: hud.setLabel, dispose: () => root.remove() };
  }

  const coarse = window.matchMedia('(pointer: coarse)').matches;
  const pointCap = coarse ? 14000 : 40000;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(BACKGROUND, 1);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.05, 100);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const envTarget = pmrem.fromScene(room, 0.04);
  scene.environment = envTarget.texture;
  scene.environmentIntensity = 0.7;
  disposeTree(room);
  pmrem.dispose();
  const key = new THREE.DirectionalLight(0xffffff, 2);
  key.position.set(2, 4, 3);
  scene.add(key, new THREE.HemisphereLight(0xdbe7ff, 0x0b1020, 0.8));

  const holo = createHolo(accent);
  const stage = createStage(accent);
  scene.add(stage.group);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = false;
  controls.zoomSpeed = 0.8;
  controls.autoRotateSpeed = 0.9;
  controls.maxPolarAngle = Math.PI * 0.52;
  controls.minPolarAngle = Math.PI * 0.12;
  canvas.style.touchAction = 'pan-y';

  const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  const sphere = new THREE.Sphere(new THREE.Vector3(0, 0.9, 0), 1.2);
  const focus = sphere.center.clone();
  const loader = new GLTFLoader();
  const draco = new DRACOLoader();
  draco.setDecoderPath(dracoPath());
  loader.setDRACOLoader(draco);
  loader.setMeshoptDecoder(MeshoptDecoder);

  let content = null;
  let models = [];
  let mixer = null;
  let holoMode = true;
  let token = 0;
  let disposed = false;
  let visible = true;
  let dragging = false;
  let hovering = false;
  let resumeAt = 0;
  let pulse = 1;
  let clock = 0;
  let top = 2;
  let fitDist = 5;
  let reset = null;
  let shownAngle = -1;
  let shownElev = -999;
  let raf = 0;
  let last = 0;

  function fitDistance() {
    const v = THREE.MathUtils.degToRad(camera.fov) / 2;
    const h = Math.atan(Math.tan(v) * camera.aspect);
    const narrow = root.clientWidth < 480;
    focus.copy(sphere.center);
    if (narrow) focus.y += sphere.radius * 0.14;
    return (sphere.radius / Math.sin(Math.min(v, h))) * (narrow ? 1.1 : 0.98);
  }

  function refit(direction) {
    const offset = camera.position.clone().sub(controls.target);
    const zoom = direction ? 1 : THREE.MathUtils.clamp(offset.length() / fitDist, 0.5, 1.9);
    const dir = direction || offset.normalize();
    fitDist = fitDistance();
    controls.minDistance = fitDist * 0.5;
    controls.maxDistance = fitDist * 1.9;
    controls.target.copy(focus);
    camera.position.copy(focus).addScaledVector(dir, fitDist * zoom);
    camera.near = fitDist / 60;
    camera.far = fitDist * 24;
    camera.updateProjectionMatrix();
    controls.update();
  }

  function resize() {
    const w = root.clientWidth;
    const h = root.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    holo.shared.uSize.value = h * renderer.getPixelRatio() * 0.017;
    refit();
    render();
  }

  function applyMode() {
    for (const { mesh, wire, points } of models) {
      mesh.material = holoMode ? holo.fill : mesh.userData.orig;
      if (wire) wire.visible = holoMode;
      points.visible = holoMode;
    }
    toggle.textContent = holoMode ? 'view: hologram' : 'view: original';
    toggle.setAttribute('aria-pressed', String(holoMode));
    kick();
  }

  function prepare(gltf) {
    const holder = new THREE.Group();
    const meshes = [];
    gltf.scene.traverse((o) => {
      if (o.isMesh) meshes.push(o);
    });
    const stats = meshStats(meshes);
    const withWire = stats.triangles <= WIRE_TRIANGLE_LIMIT;
    const stride = Math.max(1, Math.ceil(stats.vertices / pointCap));
    for (const mesh of meshes) {
      if (!mesh.geometry.attributes.normal) mesh.geometry.computeVertexNormals();
      mesh.userData.orig = mesh.material;
      let wire = null;
      if (withWire && !mesh.isInstancedMesh) {
        wire = mesh.isSkinnedMesh ? new THREE.SkinnedMesh(mesh.geometry, holo.wire) : new THREE.Mesh(mesh.geometry, holo.wire);
        if (mesh.isSkinnedMesh) wire.bind(mesh.skeleton, mesh.bindMatrix);
        wire.frustumCulled = mesh.frustumCulled;
        mesh.add(wire);
      }
      const points = samplePoints(mesh, stride, holo.points);
      mesh.add(points);
      models.push({ mesh, wire, points });
    }
    holder.add(gltf.scene);
    const box = new THREE.Box3().setFromObject(gltf.scene);
    if (box.isEmpty()) throw new Error('empty model');
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    gltf.scene.position.set(-center.x, -box.min.y, -center.z);
    holder.scale.setScalar(1.7 / Math.max(size.x, size.y, size.z));
    holder.userData.stats = stats;
    holder.userData.metres = 1 / holder.scale.x;
    if (gltf.animations.length && !motionQuery.matches) {
      mixer = new THREE.AnimationMixer(gltf.scene);
      mixer.clipAction(gltf.animations[0]).play();
    }
    return holder;
  }

  function clearContent() {
    if (mixer) mixer.stopAllAction();
    mixer = null;
    models = [];
    if (content) disposeTree(content, holo.all);
    content = null;
  }

  function show(gltf) {
    clearContent();
    if (gltf) {
      try {
        content = prepare(gltf);
      } catch {
        disposeTree(gltf.scene, holo.all);
        mixer = null;
        models = [];
        gltf = null;
        hud.setStatus('model could not be displayed', true);
      }
    }
    if (!gltf) content = createBust(holo);
    scene.add(content);
    const box = new THREE.Box3().setFromObject(content);
    box.getBoundingSphere(sphere);
    sphere.center.x = 0;
    sphere.center.z = 0;
    top = box.max.y;
    hud.setStats(content.userData.stats, box.getSize(new THREE.Vector3()).multiplyScalar(content.userData.metres));
    toggle.hidden = !gltf;
    pulse = 0;
    clock = 0;
    if (!motionQuery.matches) hud.glitch();
    reset = null;
    applyMode();
    refit(DEFAULT_DIR);
  }

  function setModel(url) {
    if (disposed) return;
    const id = ++token;
    if (!url) {
      hud.setStatus('');
      show(null);
      return;
    }
    hud.setStatus('loading model');
    loader.load(
      url,
      (gltf) => {
        if (id !== token || disposed) {
          disposeTree(gltf.scene);
          return;
        }
        hud.setStatus('');
        show(gltf);
      },
      (e) => {
        if (id === token && e.total) hud.setStatus(`loading model ${Math.round((e.loaded / e.total) * 100)}%`);
      },
      () => {
        if (id !== token || disposed) return;
        show(null);
        hud.setStatus('model failed to load, showing default', true);
      },
    );
  }

  function render() {
    if (!disposed) renderer.render(scene, camera);
  }

  const active = () => !disposed && visible && !document.hidden;

  function stepReset(dt, still) {
    if (!reset) return;
    reset.t = still ? 1 : Math.min(reset.t + dt / 0.6, 1);
    const e = smooth(reset.t);
    const dir = reset.dir.clone().lerp(DEFAULT_DIR, e).normalize();
    camera.position.copy(focus).addScaledVector(dir, THREE.MathUtils.lerp(reset.dist, fitDist, e));
    if (reset.t >= 1) reset = null;
  }

  function frame(now) {
    raf = 0;
    if (!active()) return;
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    const still = motionQuery.matches;
    const u = holo.shared;
    clock += dt;
    controls.autoRotate = !still && !dragging && !reset && now >= resumeAt;
    const intro = still ? 1 : Math.min(clock / INTRO_SECONDS, 1);
    let scanY = null;
    u.uAssemble.value = 1 - (1 - intro) ** 3;
    const flick = Math.floor(clock * 24);
    u.uGlitch.value = still || clock > 0.42 ? 0 : (1 - clock / 0.42) * (0.35 + 0.65 * Math.abs(Math.sin(flick * 91.7)));
    u.uSeed.value = Math.abs(Math.sin(flick * 37.3));
    if (intro < 1) {
      scanY = THREE.MathUtils.lerp(-0.05, top + 0.05, smooth(intro));
      u.uReveal.value = scanY;
      u.uScan.value = -10;
    } else {
      const cycle = (clock - INTRO_SECONDS) % 7.5;
      if (!still && cycle > 4.3) scanY = THREE.MathUtils.lerp(top + 0.05, -0.05, (cycle - 4.3) / 3.2);
      u.uReveal.value = 1000;
      u.uScan.value = scanY === null ? -10 : scanY;
    }
    const boost = hovering || dragging ? 1.3 : 1;
    u.uBoost.value += (boost - u.uBoost.value) * (still ? 1 : Math.min(dt * 8, 1));
    if (pulse < 1) pulse = still ? 1 : Math.min(pulse + dt / 0.9, 1);
    stage.update({ dt, still, pulse, scanY, center: sphere.center, radius: sphere.radius });
    if (mixer) mixer.update(dt);
    stepReset(dt, still);
    controls.update(dt);
    const dist = camera.position.distanceTo(sphere.center);
    u.uDepth.value.set(dist - sphere.radius * 0.55, dist + sphere.radius);
    const angle = Math.round((THREE.MathUtils.radToDeg(controls.getAzimuthalAngle()) + 360) % 360) % 360;
    const elev = Math.round(90 - THREE.MathUtils.radToDeg(controls.getPolarAngle()));
    if (angle !== shownAngle || elev !== shownElev) hud.setAngle((shownAngle = angle), (shownElev = elev));
    render();
    raf = requestAnimationFrame(frame);
  }

  function kick() {
    if (raf || !active()) return;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }

  const onToggle = () => {
    holoMode = !holoMode;
    applyMode();
  };
  const onStart = () => {
    dragging = true;
    reset = null;
    root.classList.add('is-dragging');
  };
  const onEnd = () => {
    dragging = false;
    resumeAt = performance.now() + 2500;
    root.classList.remove('is-dragging');
  };
  const onEnter = () => {
    hovering = true;
  };
  const onLeave = () => {
    hovering = false;
  };
  const onWheel = (e) => {
    if (!e.ctrlKey) e.stopPropagation();
  };
  const onReset = () => {
    const offset = camera.position.clone().sub(focus);
    reset = { t: 0, dist: offset.length(), dir: offset.normalize() };
    resumeAt = performance.now() + 1500;
  };
  const onLost = (e) => {
    e.preventDefault();
    hud.setStatus('3d view paused: graphics context was lost', true);
  };
  const onRestored = () => {
    hud.setStatus('');
    kick();
  };

  toggle.addEventListener('click', onToggle);
  controls.addEventListener('start', onStart);
  controls.addEventListener('end', onEnd);
  root.addEventListener('wheel', onWheel, true);
  canvas.addEventListener('dblclick', onReset);
  canvas.addEventListener('pointerenter', onEnter);
  canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);
  document.addEventListener('visibilitychange', kick);
  motionQuery.addEventListener('change', kick);

  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(root);
  const viewObserver = new IntersectionObserver((entries) => {
    visible = entries[entries.length - 1].isIntersecting;
    kick();
  });
  viewObserver.observe(root);

  show(null);
  resize();
  kick();

  function dispose() {
    if (disposed) return;
    disposed = true;
    token++;
    cancelAnimationFrame(raf);
    resizeObserver.disconnect();
    viewObserver.disconnect();
    document.removeEventListener('visibilitychange', kick);
    motionQuery.removeEventListener('change', kick);
    controls.dispose();
    clearContent();
    stage.dispose();
    holo.dispose();
    envTarget.dispose();
    draco.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
    root.remove();
  }

  return { setModel, setLabel: hud.setLabel, dispose };
}
