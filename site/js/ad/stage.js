import * as THREE from "three";
import { RoomEnvironment } from "three/addons/RoomEnvironment.js";
import { clamp, lerp, tok } from "./util.js";

const BASE_ASPECT = 16 / 9;

export function createStage(canvas, { exportMode = false } = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: exportMode, powerPreference: "high-performance" });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.02;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.localClippingEnabled = true;
  renderer.setClearColor(new THREE.Color(tok("--color-paper")), 1);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(new THREE.Color(tok("--color-paper")), 5.5, 15);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.42;

  const camera = new THREE.PerspectiveCamera(30, BASE_ASPECT, 0.05, 60);
  scene.add(camera);

  scene.add(new THREE.HemisphereLight(new THREE.Color(tok("--color-paper-2")), new THREE.Color(tok("--c-oat")), 1.25));
  const key = new THREE.DirectionalLight(new THREE.Color(tok("--color-paper-2")), 2.5);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = -5;
  key.shadow.camera.right = 5;
  key.shadow.camera.top = 5;
  key.shadow.camera.bottom = -5;
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 16;
  key.shadow.bias = -0.0005;
  key.shadow.normalBias = 0.02;
  key.shadow.radius = 5;
  scene.add(key, key.target);
  const rim = new THREE.DirectionalLight(new THREE.Color(tok("--c-sage-soft")), 0.9);
  scene.add(rim, rim.target);

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.ShadowMaterial({ color: new THREE.Color(tok("--c-ground-shadow")), opacity: 0.3 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const size = { w: 1, h: 1 };
  let shotFov = 30;

  const applyFov = () => {
    const a = size.w / size.h;
    let tanV = Math.tan(THREE.MathUtils.degToRad(shotFov) / 2);
    if (a < BASE_ASPECT) {
      const crop = lerp(1, 0.6, clamp((BASE_ASPECT - a) / (BASE_ASPECT - 0.46)));
      tanV = Math.min(tanV * (BASE_ASPECT / a) * crop, Math.tan(THREE.MathUtils.degToRad(39)));
    }
    camera.fov = THREE.MathUtils.radToDeg(Math.atan(tanV) * 2);
    camera.aspect = a;
    camera.updateProjectionMatrix();
  };

  const resize = () => {
    const rect = canvas.parentElement.getBoundingClientRect();
    size.w = Math.max(1, Math.round(rect.width));
    size.h = Math.max(1, Math.round(rect.height));
    renderer.setPixelRatio(exportMode ? 1 : Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(size.w, size.h, false);
    applyFov();
  };

  const setShot = (pos, look, fov) => {
    camera.position.copy(pos);
    camera.lookAt(look);
    shotFov = fov;
    applyFov();
    camera.updateMatrixWorld(true);
  };

  const setKey = (pos, target, rimPos) => {
    key.position.copy(pos);
    key.target.position.copy(target);
    rim.position.copy(rimPos);
    rim.target.position.copy(target);
  };

  const v = new THREE.Vector3();
  const project = (world) => {
    v.copy(world).project(camera);
    return { x: (v.x * 0.5 + 0.5) * size.w, y: (-v.y * 0.5 + 0.5) * size.h, behind: v.z > 1 };
  };

  resize();
  return { renderer, scene, camera, size, resize, setShot, setKey, project, render: () => renderer.render(scene, camera) };
}
