import * as THREE from 'three';
import { POSITIONS, UVS, INDICES, VERTEX_COUNT } from './facescan-topology.js';
import { rotationFromAngles } from './facescan-math.js';

export const FRAME = 400;
const SCALE = 15;
const OFFSET = [200, -195, 0];

export function makeSubject() {
  const positions = new Float32Array(POSITIONS.length);
  for (let i = 0; i < VERTEX_COUNT; i++) {
    const x = POSITIONS[i * 3], y = POSITIONS[i * 3 + 1], z = POSITIONS[i * 3 + 2];
    const bump = Math.exp(-(x * x + (y + 2) * (y + 2)) / 6);
    positions[i * 3] = x * 1.07 + 0.15 * Math.sin(y * 0.6);
    positions[i * 3 + 1] = y * 0.95;
    positions[i * 3 + 2] = z * 1.1 + bump * 0.8;
  }
  const size = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const base = ctx.createLinearGradient(0, 0, size, size);
  base.addColorStop(0, '#d9a07c');
  base.addColorStop(0.5, '#c98b6a');
  base.addColorStop(1, '#a86f58');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = 'rgba(70, 40, 30, 0.55)';
  ctx.lineWidth = 2;
  for (let i = 32; i < size; i += 64) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i, size);
    ctx.moveTo(0, i);
    ctx.lineTo(size, i);
    ctx.stroke();
  }
  const dots = ['#2f6fd0', '#d04a3a', '#3fa66a', '#e0c040'];
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      ctx.fillStyle = dots[(x + y * 3) % 4];
      ctx.beginPath();
      ctx.arc(64 + x * 128, 64 + y * 128, 12, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.fillStyle = '#3a2520';
  ctx.font = 'bold 72px sans-serif';
  ctx.fillText('A', 250, 560);
  ctx.fillText('B', 720, 560);
  return { positions, canvas, truth: ctx.getImageData(0, 0, size, size) };
}

export function makeRenderer(subject) {
  const gl = document.createElement('canvas');
  const renderer = new THREE.WebGLRenderer({ canvas: gl, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(FRAME, FRAME, false);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x20242c);
  const camera = new THREE.OrthographicCamera(0, FRAME, 0, -FRAME, 1, 5000);
  camera.position.z = 2000;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(subject.positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(Float32Array.from(UVS), 2));
  geometry.setIndex(new THREE.BufferAttribute(Uint16Array.from(INDICES), 1));
  const map = new THREE.CanvasTexture(subject.canvas);
  map.flipY = false;
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 8;
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ map, side: THREE.DoubleSide }));
  mesh.matrixAutoUpdate = false;
  scene.add(mesh);

  function render(yaw, pitch, { blur = 0, brightness = 1, noise = 0.25, target } = {}) {
    const R = rotationFromAngles(yaw, pitch);
    const s = SCALE, t = OFFSET;
    mesh.matrix.set(s * R[0], s * R[1], s * R[2], t[0], s * R[3], s * R[4], s * R[5], t[1], s * R[6], s * R[7], s * R[8], t[2], 0, 0, 0, 1);
    mesh.matrixWorldNeedsUpdate = true;
    renderer.render(scene, camera);
    const canvas = target || document.createElement('canvas');
    canvas.width = canvas.height = FRAME;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const filters = [];
    if (blur) filters.push(`blur(${blur}px)`);
    if (brightness !== 1) filters.push(`brightness(${brightness})`);
    ctx.filter = filters.join(' ') || 'none';
    ctx.drawImage(gl, 0, 0);
    ctx.filter = 'none';
    const landmarks = [];
    let seed = Math.round((yaw + 90) * 131 + (pitch + 90) * 7) + 1;
    const rand = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647 - 0.5;
    };
    for (let i = 0; i < VERTEX_COUNT; i++) {
      const x = subject.positions[i * 3], y = subject.positions[i * 3 + 1], z = subject.positions[i * 3 + 2];
      const cx = s * (R[0] * x + R[1] * y + R[2] * z) + t[0] + rand() * noise * 2;
      const cy = s * (R[3] * x + R[4] * y + R[5] * z) + t[1] + rand() * noise * 2;
      const cz = s * (R[6] * x + R[7] * y + R[8] * z) + t[2] + rand() * noise * 4;
      landmarks.push({ x: cx / FRAME, y: -cy / FRAME, z: -cz / FRAME });
    }
    for (let i = 0; i < 10; i++) landmarks.push({ x: 0.5, y: 0.5, z: 0 });
    const matrix = Float32Array.from([R[0], R[3], R[6], 0, R[1], R[4], R[7], 0, R[2], R[5], R[8], 0, 0, 0, -40, 1]);
    return { canvas, image: ctx.getImageData(0, 0, FRAME, FRAME), landmarks, matrix, yaw, pitch };
  }

  return { render, dispose: () => renderer.dispose() };
}

export function fakeVisionModuleUrl() {
  const code = `
    export const FilesetResolver = { forVisionTasks: async () => ({}) };
    export const FaceLandmarker = { createFromOptions: async (_, options) => {
      if (!options.baseOptions.modelAssetBuffer || !options.outputFacialTransformationMatrixes) throw new Error('bad options');
      return { detect: (canvas) => window.__fakeDetect(canvas), close() {} };
    } };
  `;
  return URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
}
