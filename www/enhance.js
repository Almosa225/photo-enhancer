// Automatic photo enhancement: white balance, chroma denoise, local tone (HDR-like),
// clarity, fine sharpening, levels + S-curve, vibrance. Works on RGBA Uint8ClampedArray in place.
// Memory-lean: blurs run in place with one shared scratch buffer (iPhone Safari has tight limits).
(function (global) {
  'use strict';

  function blurH(s, d, w, h, r) {
    const inv = 1 / (2 * r + 1);
    for (let y = 0; y < h; y++) {
      const o = y * w;
      let acc = s[o] * (r + 1);
      for (let i = 1; i <= r; i++) acc += s[o + Math.min(i, w - 1)];
      for (let x = 0; x < w; x++) {
        d[o + x] = acc * inv;
        acc += s[o + Math.min(x + r + 1, w - 1)] - s[o + Math.max(x - r, 0)];
      }
    }
  }
  function blurV(s, d, w, h, r) {
    const inv = 1 / (2 * r + 1);
    for (let x = 0; x < w; x++) {
      let acc = s[x] * (r + 1);
      for (let i = 1; i <= r; i++) acc += s[Math.min(i, h - 1) * w + x];
      for (let y = 0; y < h; y++) {
        d[y * w + x] = acc * inv;
        acc += s[Math.min(y + r + 1, h - 1) * w + x] - s[Math.max(y - r, 0) * w + x];
      }
    }
  }
  // in-place separable box blur, `passes` times (3 passes ~ gaussian); tmp must be same length
  function blurInPlace(a, w, h, r, passes, tmp) {
    if (r < 1) return a;
    for (let p = 0; p < passes; p++) { blurH(a, tmp, w, h, r); blurV(tmp, a, w, h, r); }
    return a;
  }

  function percentile(arr, q, step) {
    const hist = new Uint32Array(1024); let n = 0;
    for (let i = 0; i < arr.length; i += step) { let v = arr[i]; v = v < 0 ? 0 : v > 1 ? 1 : v; hist[(v * 1023) | 0]++; n++; }
    const t = n * q; let acc = 0;
    for (let i = 0; i < 1024; i++) { acc += hist[i]; if (acc >= t) return i / 1023; }
    return 1;
  }
  function channelPercentile(px, ch, q, step4) {
    const hist = new Uint32Array(256); let n = 0;
    for (let j = ch; j < px.length; j += step4) { hist[px[j]]++; n++; }
    const t = n * q; let acc = 0;
    for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= t) return i / 255; }
    return 1;
  }

  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

  async function enhance(px, w, h, onStep, opts) {
    opts = Object.assign({ clarity: 0.5, sharpen: 0.85, denoise: true }, opts || {});
    const n = w * h, step = Math.max(1, Math.floor(n / 300000)), step4 = step * 4;
    const tick = async (label, p) => { if (onStep) await onStep(label, p); };

    // ---- 1. white balance gains (gray world + white patch, gentle), from samples ----
    await tick('نوازن الألوان…', 0.05);
    let gr = 1, gg = 1, gb = 1;
    {
      let sr = 0, sg = 0, sb = 0, cnt = 0;
      for (let j = 0; j < px.length; j += step4) {
        const r = px[j] / 255, g = px[j + 1] / 255, b = px[j + 2] / 255;
        const y = 0.299 * r + 0.587 * g + 0.114 * b;
        if (y > 0.06 && y < 0.94) { sr += r; sg += g; sb += b; cnt++; }
      }
      if (cnt > 100) {
        const m = (sr + sg + sb) / 3;
        const pr = channelPercentile(px, 0, 0.995, step4), pg = channelPercentile(px, 1, 0.995, step4), pb = channelPercentile(px, 2, 0.995, step4);
        const pm = Math.max(pr, pg, pb);
        const gain = (gw, wp) => clamp(1 + 0.3 * ((0.25 * gw + 0.75 * wp) - 1), 0.95, 1.06);
        gr = gain(m / sr, pm / pr); gg = gain(m / sg, pm / pg); gb = gain(m / sb, pm / pb);
        const norm = 0.299 * gr + 0.587 * gg + 0.114 * gb;
        gr /= norm; gg /= norm; gb /= norm;
      }
    }

    // ---- 2. straight to Y / chroma (white balance applied on the fly), chroma denoise ----
    await tick('ننظف التشويش…', 0.18);
    const Y = new Float32Array(n), Cb = new Float32Array(n), Cr = new Float32Array(n);
    const tmp = new Float32Array(n);
    {
      const kr = gr / 255, kg = gg / 255, kb = gb / 255;
      for (let i = 0, j = 0; i < n; i++, j += 4) {
        const r = px[j] * kr, g = px[j + 1] * kg, b = px[j + 2] * kb;
        const y = 0.299 * r + 0.587 * g + 0.114 * b;
        Y[i] = clamp(y, 0, 1); Cb[i] = b - y; Cr[i] = r - y;
      }
    }
    const rc = Math.max(1, Math.round(Math.min(w, h) / 900));
    blurInPlace(Cb, w, h, rc, 2, tmp);
    blurInPlace(Cr, w, h, rc, 2, tmp);
    let work = new Float32Array(n); // reused for every luma blur below
    if (opts.denoise) {
      work.set(Y); blurInPlace(work, w, h, 1, 1, tmp);
      for (let i = 0; i < n; i++) {
        const d = Math.abs(Y[i] - work[i]);
        const k = d < 0.02 ? 0.5 : d < 0.05 ? 0.5 * (0.05 - d) / 0.03 : 0;
        Y[i] = Y[i] + (work[i] - Y[i]) * k;
      }
    }
    const Y0 = new Uint16Array(n); // original luma, compact (only needed for chroma scaling at the end)
    for (let i = 0; i < n; i++) Y0[i] = Y[i] * 65535;

    // ---- 3. local tone mapping (HDR-like): local gamma from blurred base ----
    await tick('نوازن الإضاءة…', 0.32);
    const f = Math.max(1, Math.round(Math.min(w, h) / 160));
    const sw = Math.ceil(w / f), sh = Math.ceil(h / f);
    const base = new Float32Array(sw * sh), sc = new Float32Array(sw * sh);
    for (let y = 0; y < h; y++) {
      const sy = (y / f) | 0;
      for (let x = 0; x < w; x++) { const k = sy * sw + ((x / f) | 0); base[k] += Y[y * w + x]; sc[k]++; }
    }
    for (let k = 0; k < base.length; k++) base[k] /= sc[k];
    blurInPlace(base, sw, sh, Math.max(2, Math.round(Math.min(sw, sh) * 0.06)), 3, sc);
    const hiP = percentile(Y, 0.995, step); // bright parts present => low-key scene, lift gently
    const toneK = hiP > 0.8 ? 0.4 : 0.7;
    for (let y = 0; y < h; y++) {
      const fy = Math.min(sh - 1.001, Math.max(0, (y + 0.5) / f - 0.5)), y0 = fy | 0, ty = fy - y0;
      for (let x = 0; x < w; x++) {
        const fx = Math.min(sw - 1.001, Math.max(0, (x + 0.5) / f - 0.5)), x0 = fx | 0, tx = fx - x0;
        const k = y0 * sw + x0;
        const b = (base[k] * (1 - tx) + base[k + 1] * tx) * (1 - ty) + (base[k + sw] * (1 - tx) + base[k + sw + 1] * tx) * ty;
        const g = clamp(1 + toneK * (b - 0.5), 0.7, 1.3);
        const i = y * w + x;
        Y[i] = Math.pow(Y[i] < 1e-5 ? 1e-5 : Y[i], g);
      }
    }
    // global exposure nudge toward a pleasant mid level
    const meanAfter = (() => { let s = 0, c = 0; for (let i = 0; i < n; i += step) { s += Y[i]; c++; } return s / c; })();
    const gGlob = clamp(Math.log(0.47) / Math.log(clamp(meanAfter, 0.05, 0.95)), 0.6, 1.2);
    const gG = 1 + (gGlob - 1) * (hiP > 0.8 ? 0.25 : 0.85);
    if (Math.abs(gG - 1) > 0.01) for (let i = 0; i < n; i++) Y[i] = Math.pow(Y[i], gG);

    // ---- 4. clarity (mid-frequency local contrast, midtones) ----
    await tick('نبرز التفاصيل…', 0.5);
    const rClar = Math.max(3, Math.round(Math.min(w, h) * 0.012));
    work.set(Y); blurInPlace(work, w, h, rClar, 3, tmp);
    for (let i = 0; i < n; i++) {
      const y = Y[i], mid = 4 * y * (1 - y);
      Y[i] = y + opts.clarity * (y - work[i]) * mid;
    }

    // ---- 5. fine sharpening with noise threshold ----
    await tick('نزيد الحدة…', 0.64);
    const rS = Math.max(1, Math.round(Math.min(w, h) / 1500));
    work.set(Y); blurInPlace(work, w, h, rS, 2, tmp);
    for (let i = 0; i < n; i++) {
      const d = Y[i] - work[i], ad = d < 0 ? -d : d;
      if (ad > 0.006) Y[i] += opts.sharpen * d * Math.min(1, (ad - 0.006) / 0.01);
    }
    work = null;

    // ---- 6. levels + S-curve ----
    await tick('نضبط التباين…', 0.76);
    let lo = Math.min(percentile(Y, 0.003, step), 0.12), hi = Math.max(percentile(Y, 0.997, step), 0.85);
    if (hi - lo < 0.2) { lo = 0; hi = 1; }
    const K = 0.14, inv = 1 / (hi - lo);
    for (let i = 0; i < n; i++) {
      let x = clamp((Y[i] - lo) * inv, 0, 1);
      Y[i] = x * (1 - K) + K * (x * x * (3 - 2 * x));
    }

    // ---- 7. recombine with vibrance ----
    await tick('نخلي الألوان حية…', 0.88);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const y = Y[i];
      const ratio = (y + 0.05) / (Y0[i] / 65535 + 0.05);
      const cs = clamp(Math.sqrt(ratio), 1.0, 1.6);
      let cb = Cb[i] * cs, cr = Cr[i] * cs;
      const s = Math.sqrt(cb * cb + cr * cr);
      const vib = 1.06 + 0.42 * (1 - Math.min(1, s / 0.3)) * Math.min(1, y * 6);
      cb *= vib; cr *= vib;
      const r = y + cr, b = y + cb, g = (y - 0.299 * r - 0.114 * b) / 0.587;
      px[j] = r * 255; px[j + 1] = g * 255; px[j + 2] = b * 255;
    }
    await tick('تم', 1);
  }

  global.PhotoEnhance = { enhance };
})(typeof window !== 'undefined' ? window : globalThis);
