import * as THREE from 'three';

const HOLO_VERT = `
#include <common>
#include <skinning_pars_vertex>
uniform float uGlitch;
uniform float uSeed;
uniform float uShift;
varying vec3 vN;
varying vec3 vV;
varying float vY;
varying float vDepth;
void main() {
  #include <beginnormal_vertex>
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  #include <defaultnormal_vertex>
  #include <begin_vertex>
  #include <skinning_vertex>
  #include <project_vertex>
  vN = normalize(transformedNormal);
  vV = normalize(-mvPosition.xyz);
  vDepth = -mvPosition.z;
  vY = (modelMatrix * vec4(transformed, 1.0)).y;
  float band = step(0.45, fract(vY * 4.0 + uSeed));
  gl_Position.x += uGlitch * gl_Position.w * (uShift * 0.035 * (0.35 + band) + 0.03 * (band - 0.5));
}`;

const HOLO_FRAG = `
uniform vec3 uColor;
uniform vec2 uDepth;
uniform float uScan;
uniform float uReveal;
uniform float uBoost;
uniform float uWire;
uniform float uGlitch;
uniform float uShift;
varying vec3 vN;
varying vec3 vV;
varying float vY;
varying float vDepth;
void main() {
  if (vY > uReveal) discard;
  float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.5);
  float scan = smoothstep(0.06, 0.0, abs(vY - uScan));
  float front = smoothstep(0.1, 0.0, uReveal - vY);
  float depth = 1.0 - 0.72 * smoothstep(uDepth.x, uDepth.y, vDepth);
  float a = mix(f * 0.8 + 0.03 + scan * 0.3, 0.26 + scan * 0.45, uWire) * depth + front * 0.7;
  vec3 c = mix(uColor, vec3(1.0), clamp(f * 0.35 * (1.0 - uWire) + scan * 0.6 + front * 0.7, 0.0, 1.0));
  c = mix(c, mix(vec3(0.11, 0.3, 0.95), uColor, step(0.0, uShift)), uGlitch * 0.8);
  gl_FragColor = vec4(c, a * uBoost);
}`;

const POINT_VERT = `
uniform vec2 uDepth;
uniform float uSize;
uniform float uScan;
uniform float uAssemble;
uniform float uGlitch;
uniform float uSeed;
varying float vS;
varying float vFade;
void main() {
  vec3 h = fract(sin(vec3(
    dot(position, vec3(12.9898, 78.233, 37.719)),
    dot(position, vec3(39.346, 11.135, 83.155)),
    dot(position, vec3(73.156, 52.235, 9.151)))) * 43758.5453) - 0.5;
  float k = 1.0 - uAssemble;
  vec4 w = modelMatrix * vec4(position, 1.0);
  w.xyz += normalize(h + 0.0001) * k * k * (0.35 + abs(h.y) * 1.6);
  w.y += k * k * h.x * 0.4;
  vS = smoothstep(0.14, 0.0, abs(w.y - uScan));
  vec4 mv = viewMatrix * w;
  vFade = (1.0 - 0.8 * smoothstep(uDepth.x, uDepth.y, -mv.z)) * (0.25 + 0.75 * uAssemble);
  gl_PointSize = uSize * (1.0 + vS * 0.9 + k * 0.8) / -mv.z;
  gl_Position = projectionMatrix * mv;
  float band = step(0.45, fract(w.y * 4.0 + uSeed));
  gl_Position.x += uGlitch * gl_Position.w * (0.035 * (0.35 + band) + 0.03 * (band - 0.5));
}`;

const POINT_FRAG = `
uniform vec3 uColor;
uniform float uBoost;
uniform float uGlitch;
varying float vS;
varying float vFade;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.1, d);
  vec3 c = mix(mix(uColor, vec3(1.0), vS * 0.7 + 0.12), vec3(0.13, 0.83, 0.93), uGlitch);
  gl_FragColor = vec4(c, a * (0.7 + vS * 0.3) * vFade * uBoost);
}`;

export const additive = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending };

export function createHolo(accent) {
  const shared = {
    uColor: { value: new THREE.Color(accent) },
    uDepth: { value: new THREE.Vector2(1, 10) },
    uScan: { value: -10 },
    uReveal: { value: 1000 },
    uAssemble: { value: 1 },
    uGlitch: { value: 0 },
    uSeed: { value: 0 },
    uBoost: { value: 1 },
    uSize: { value: 8 },
  };
  const make = (wire) => new THREE.ShaderMaterial({
    uniforms: { ...shared, uWire: { value: wire ? 1 : 0 }, uShift: { value: wire ? -1 : 0 } },
    vertexShader: HOLO_VERT,
    fragmentShader: HOLO_FRAG,
    side: THREE.DoubleSide,
    wireframe: wire,
    ...additive,
  });
  const fill = make(false);
  const wire = make(true);
  const points = new THREE.ShaderMaterial({ uniforms: shared, vertexShader: POINT_VERT, fragmentShader: POINT_FRAG, ...additive });
  const all = new Set([fill, wire, points]);
  return { shared, fill, wire, points, all, dispose: () => all.forEach((m) => m.dispose()) };
}

export function meshStats(meshes) {
  let vertices = 0;
  let triangles = 0;
  for (const m of meshes) {
    const g = m.geometry;
    const n = m.isInstancedMesh ? m.count : 1;
    vertices += g.attributes.position.count * n;
    triangles += ((g.index ? g.index.count : g.attributes.position.count) / 3) * n;
  }
  return { vertices, triangles: Math.floor(triangles) };
}

export function samplePoints(mesh, stride, material) {
  const src = mesh.geometry.attributes.position;
  const count = Math.ceil(src.count / stride);
  const out = new Float32Array(count * 3);
  for (let i = 0, j = 0; i < src.count; i += stride, j += 3) {
    out[j] = src.getX(i);
    out[j + 1] = src.getY(i);
    out[j + 2] = src.getZ(i);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(out, 3));
  if (mesh.geometry.boundingSphere) geo.boundingSphere = mesh.geometry.boundingSphere.clone();
  const points = new THREE.Points(geo, material);
  points.frustumCulled = false;
  return points;
}

function shapeHead(geo) {
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    const taper = y < 0 ? 1 + y * 1.1 : 1;
    p.setXYZ(i, p.getX(i) * 0.84 * taper, y * 1.12, p.getZ(i) * 0.94 * (y < 0 ? 1 + y * 0.5 : 1));
  }
  geo.translate(0, 1.56, 0);
  geo.computeVertexNormals();
  return geo;
}

function torso(segments, steps) {
  const profile = new THREE.SplineCurve([
    new THREE.Vector2(0.17, 1.3),
    new THREE.Vector2(0.18, 1.14),
    new THREE.Vector2(0.3, 1.06),
    new THREE.Vector2(0.66, 0.96),
    new THREE.Vector2(0.84, 0.8),
    new THREE.Vector2(0.88, 0.5),
    new THREE.Vector2(0.84, 0.2),
    new THREE.Vector2(0.8, 0),
  ]).getPoints(steps);
  const geo = new THREE.LatheGeometry(profile, segments);
  geo.scale(1, 1, 0.52);
  geo.computeVertexNormals();
  return geo;
}

export function createBust(holo) {
  const group = new THREE.Group();
  const coarse = [shapeHead(new THREE.IcosahedronGeometry(0.36, 1)), torso(10, 7)];
  const dense = [shapeHead(new THREE.SphereGeometry(0.36, 30, 20)), torso(40, 26)];
  const solids = [];
  for (const geo of coarse) {
    const fill = new THREE.Mesh(geo, holo.fill);
    solids.push(fill);
    group.add(fill, new THREE.Mesh(geo, holo.wire));
  }
  for (const geo of dense) {
    const points = new THREE.Points(geo, holo.points);
    points.frustumCulled = false;
    group.add(points);
  }
  group.userData.stats = meshStats(solids);
  group.userData.metres = 0.3;
  return group;
}

function disposeMaterial(material, keep) {
  if (!material || keep.has(material)) return;
  for (const value of Object.values(material)) if (value && value.isTexture) value.dispose();
  if (material.uniforms) {
    for (const u of Object.values(material.uniforms)) if (u.value && u.value.isTexture) u.value.dispose();
  }
  material.dispose();
}

export function disposeTree(root, keep = new Set()) {
  root.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.skeleton) o.skeleton.dispose();
    for (const m of [o.material, o.userData.orig]) {
      if (Array.isArray(m)) m.forEach((x) => disposeMaterial(x, keep));
      else disposeMaterial(m, keep);
    }
  });
  root.removeFromParent();
}
