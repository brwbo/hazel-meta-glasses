import { buildAtlas } from './facescan-texture.js';

self.onmessage = async (event) => {
  const { id, job } = event.data;
  try {
    const atlas = await buildAtlas({ ...job, yieldMs: Infinity });
    self.postMessage({ id, atlas }, [atlas.rgba.buffer, atlas.seen.buffer, atlas.covered.buffer]);
  } catch (error) {
    self.postMessage({ id, error: String(error && error.message ? error.message : error) });
  }
};
