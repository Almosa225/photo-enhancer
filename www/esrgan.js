// Real-ESRGAN (realesr-general-x4v3, SRVGGNetCompact) running on TensorFlow.js.
// Upscales x4 tile by tile so phone GPUs don't run out of memory.
(function (global) {
  'use strict';
  let W = null;

  function f16ToF32(u16) {
    const out = new Float32Array(u16.length);
    for (let i = 0; i < u16.length; i++) {
      const h = u16[i], s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
      out[i] = e === 0 ? s * Math.pow(2, -14) * (m / 1024)
             : e === 31 ? (m ? NaN : s * Infinity)
             : s * Math.pow(2, e - 15) * (1 + m / 1024);
    }
    return out;
  }

  function load() {
    if (W) return W;
    const src = global.ESRGAN_GENERAL, bin = atob(src.data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const all = f16ToF32(new Uint16Array(bytes.buffer));
    W = {}; let off = 0;
    for (const [name, shape] of src.meta) {
      const n = shape.reduce((a, b) => a * b, 1);
      W[name] = tf.tensor(all.subarray(off, off + n), shape);
      off += n;
    }
    return W;
  }

  function forward(x) { // x: [1,h,w,3] in 0..1
    return tf.tidy(() => {
      let f = x;
      for (let i = 0; i < 33; i++) f = tf.prelu(tf.add(tf.conv2d(f, W['w' + i], 1, 'same'), W['b' + i]), W['a' + i]);
      f = tf.add(tf.conv2d(f, W.wl, 1, 'same'), W.bl);
      f = tf.depthToSpace(f, 4);
      const [, h, w] = x.shape;
      return tf.add(f, tf.image.resizeNearestNeighbor(x, [h * 4, w * 4]));
    });
  }

  // canvas in -> canvas out (x4)
  async function upscale(srcCanvas, onProgress) {
    load();
    const w = srcCanvas.width, h = srcCanvas.height, S = 4;
    const IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const TILE = IOS ? 96 : 128, PAD = 10;
    const sctx = srcCanvas.getContext('2d', { willReadFrequently: true });
    const out = document.createElement('canvas');
    out.width = w * S; out.height = h * S;
    const octx = out.getContext('2d');
    const tiles = [];
    for (let y = 0; y < h; y += TILE) for (let x = 0; x < w; x += TILE) tiles.push([x, y]);
    let done = 0;
    for (const [tx, ty] of tiles) {
      const tw = Math.min(TILE, w - tx), th = Math.min(TILE, h - ty);
      const x0 = Math.max(0, tx - PAD), y0 = Math.max(0, ty - PAD);
      const x1 = Math.min(w, tx + tw + PAD), y1 = Math.min(h, ty + th + PAD);
      const img = sctx.getImageData(x0, y0, x1 - x0, y1 - y0);
      const res = tf.tidy(() => {
        const inp = tf.browser.fromPixels(img).toFloat().div(255).expandDims(0);
        const o = forward(inp).squeeze([0]);
        const cut = o.slice([(ty - y0) * S, (tx - x0) * S, 0], [th * S, tw * S, 3]);
        return cut.clipByValue(0, 1).mul(255).round().cast('int32');
      });
      const data = await tf.browser.toPixels(res);
      res.dispose();
      octx.putImageData(new ImageData(data, tw * S, th * S), tx * S, ty * S);
      done++;
      if (onProgress) onProgress(done / tiles.length);
      await tf.nextFrame();
    }
    return out;
  }

  global.RealESRGAN = { upscale, load };
})(window);
