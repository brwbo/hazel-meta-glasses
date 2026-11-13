const MAX_BYTES = 25 * 1024 * 1024;
const CM_TO_M = 0.01;

export function atlasCanvas(atlas) {
  const canvas = document.createElement('canvas');
  canvas.width = atlas.size;
  canvas.height = atlas.size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas is unavailable');
  ctx.putImageData(new ImageData(atlas.rgba, atlas.size, atlas.size), 0, 0);
  return canvas;
}

export async function buildMesh({ positions, uvs, indices, canvas }) {
  const THREE = await import('three');
  const scaled = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i++) scaled[i] = positions[i] * CM_TO_M;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(scaled, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(Float32Array.from(uvs), 2));
  geometry.setIndex(new THREE.BufferAttribute(Uint16Array.from(indices), 1));
  geometry.computeVertexNormals();
  const map = new THREE.CanvasTexture(canvas);
  map.flipY = false;
  map.colorSpace = THREE.SRGBColorSpace;
  map.userData.mimeType = 'image/jpeg';
  const material = new THREE.MeshStandardMaterial({ map, roughness: 0.9, metalness: 0, side: THREE.DoubleSide });
  material.name = 'face-scan';
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'face-scan-mask';
  return mesh;
}

export async function exportGlb(model) {
  const canvas = model.canvas || atlasCanvas(model.atlas);
  const mesh = await buildMesh({ ...model, canvas });
  const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
  const buffer = await new GLTFExporter().parseAsync(mesh, { binary: true });
  mesh.geometry.dispose();
  mesh.material.map.dispose();
  mesh.material.dispose();
  const blob = new Blob([buffer], { type: 'model/gltf-binary' });
  if (blob.size > MAX_BYTES) throw new Error('scan is larger than the 25 MB upload limit');
  return blob;
}

export async function uploadGlb(blob, personId, apiBase = '') {
  const form = new FormData();
  form.append('file', blob, `face-scan-${personId}.glb`);
  const res = await fetch(`${apiBase}/api/people/${encodeURIComponent(personId)}/model`, { method: 'POST', body: form });
  if (!res.ok) {
    const error = new Error(`upload failed with status ${res.status}`);
    error.status = res.status;
    throw error;
  }
  const body = await res.json();
  return body.modelUrl;
}
