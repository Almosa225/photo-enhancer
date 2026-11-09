// Video enhancement on the GPU (WebGL2 shader): exposure, local tone (HDR-like), clarity,
// sharpening, levels + S-curve, white balance, vibrance. Plays the clip once, renders each
// frame through the shader and records the canvas together with the original audio.
(function (global) {
  'use strict';

  const VS = `#version 300 es
  in vec2 p; out vec2 uv;
  void main(){ uv = vec2((p.x+1.)*.5, 1.-(p.y+1.)*.5); gl_Position = vec4(p,0.,1.); }`;

  const FS = `#version 300 es
  precision highp float;
  in vec2 uv; out vec4 o;
  uniform sampler2D t; uniform vec2 px;
  uniform vec3 wb; uniform float lo, hi, gExp, toneK, lodBase, lodMid, clarity, sharp;
  const vec3 L = vec3(.299,.587,.114);
  float luma(vec3 c){ return dot(c*wb, L); }
  void main(){
    vec3 c = texture(t, uv).rgb * wb;
    float Y = clamp(dot(c, L), 0., 1.);
    // chroma from a slightly blurred level: removes colour noise
    vec3 cb = textureLod(t, uv, 1.2).rgb * wb;
    vec3 ch = cb - dot(cb, L);
    // light luma denoise where the image is flat (keeps edges)
    float n4 = .25*(luma(texture(t, uv+vec2(px.x,0.)).rgb) + luma(texture(t, uv-vec2(px.x,0.)).rgb)
                  + luma(texture(t, uv+vec2(0.,px.y)).rgb) + luma(texture(t, uv-vec2(0.,px.y)).rgb));
    float d = Y - n4;
    Y = mix(Y, n4, .6*(1.-smoothstep(.02, .06, abs(d))));
    // local base (big blur from mipmaps) -> local gamma, like HDR
    float base = luma(textureLod(t, uv, lodBase).rgb);
    float g = clamp(1. + toneK*(base-.5), .7, 1.3);
    float Yt = pow(max(Y, 1e-4), g * gExp);
    // clarity: mid-frequency local contrast
    float mid = luma(textureLod(t, uv, lodMid).rgb);
    float midT = pow(max(mid,1e-4), g * gExp);
    Yt += clarity * (Yt - midT) * 4.*Yt*(1.-Yt);
    // fine sharpening (4-neighbour unsharp)
    Yt += sharp * d * smoothstep(.012, .035, abs(d));
    // levels + gentle S-curve
    float x = clamp((Yt-lo)/(hi-lo), 0., 1.);
    x = x*.86 + .14*(x*x*(3.-2.*x));
    // chroma: follow brightening + vibrance (dull colours boosted more)
    float cs = clamp(sqrt((x+.05)/(Y+.05)), 1., 1.6);
    ch *= cs;
    float s = length(ch.rb - vec2(ch.g));
    ch *= 1.06 + .4*(1.-min(1., s/.3))*min(1., x*6.);
    o = vec4(clamp(vec3(x) + ch, 0., 1.), 1.);
  }`;

  function compile(gl, type, src) {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }

  // Scene statistics from a few sample frames (cheap readback at 96px)
  async function analyse(video, samples) {
    const c = document.createElement('canvas'), W = 96, H = Math.max(1, Math.round(96 * video.videoHeight / video.videoWidth));
    c.width = W; c.height = H;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    const hist = new Uint32Array(256); let sr = 0, sg = 0, sb = 0, cnt = 0, pr = [], pg = [], pb = [];
    for (const tt of samples) {
      await seek(video, tt);
      ctx.drawImage(video, 0, 0, W, H);
      const d = ctx.getImageData(0, 0, W, H).data;
      for (let i = 0; i < d.length; i += 4) {
        const y = (d[i]*77 + d[i+1]*150 + d[i+2]*29) >> 8; hist[y]++;
        if (y > 15 && y < 240) { sr += d[i]; sg += d[i+1]; sb += d[i+2]; cnt++; }
        pr.push(d[i]); pg.push(d[i+1]); pb.push(d[i+2]);
      }
    }
    const total = hist.reduce((a, b) => a + b, 0);
    const pct = q => { let a = 0; for (let v = 0; v < 256; v++) { a += hist[v]; if (a >= total*q) return v/255; } return 1; };
    const p995 = arr => { arr.sort((a, b) => a - b); return arr[Math.floor(arr.length*.995)] / 255; };
    let wb = [1, 1, 1];
    if (cnt > 50) {
      const m = (sr + sg + sb) / 3, mr = p995(pr), mg = p995(pg), mb = p995(pb), pm = Math.max(mr, mg, mb);
      const gain = (gw, wp) => Math.min(1.06, Math.max(0.95, 1 + 0.3*((0.25*gw + 0.75*wp) - 1)));
      wb = [gain(m/sr, pm/mr), gain(m/sg, pm/mg), gain(m/sb, pm/mb)];
      const nrm = 0.299*wb[0] + 0.587*wb[1] + 0.114*wb[2]; wb = wb.map(v => v / nrm);
    }
    const hiP = pct(0.995);
    let mean = 0; for (let v = 0; v < 256; v++) mean += v * hist[v]; mean = mean / total / 255;
    const lowKey = hiP > 0.8;
    const toneK = lowKey ? 0.4 : 0.7;
    let gExp = Math.log(0.47) / Math.log(Math.min(0.95, Math.max(0.05, mean)));
    gExp = Math.min(1.2, Math.max(0.6, gExp)); gExp = 1 + (gExp - 1) * (lowKey ? 0.25 : 0.7);
    let lo = Math.min(pct(0.003), 0.12), hi = Math.max(pct(0.997), 0.85);
    if (hi - lo < 0.2) { lo = 0; hi = 1; }
    return { wb, toneK, gExp, lo, hi };
  }

  function seek(video, tt) {
    return new Promise(res => {
      const done = () => { video.removeEventListener('seeked', done); res(); };
      video.addEventListener('seeked', done); video.currentTime = tt;
    });
  }

  function pickMime() {
    const list = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a', 'video/mp4',
                  'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
    if (!global.MediaRecorder) return null;
    for (const m of list) if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) return m;
    return '';
  }

  // Enhance a video File. opts: { maxLong, onProgress(p), onStage(text), preview canvas container }
  async function enhanceVideo(file, opts) {
    opts = Object.assign({ maxLong: 1920 }, opts || {});
    const mime = pickMime();
    if (mime === null) throw new Error('no-recorder');

    const video = document.createElement('video');
    video.playsInline = true; video.setAttribute('playsinline', ''); video.preload = 'auto';
    video.crossOrigin = 'anonymous';
    const url = URL.createObjectURL(file);
    video.src = url;
    await new Promise((res, rej) => { video.onloadedmetadata = res; video.onerror = () => rej(new Error('load')); });
    await new Promise(res => { if (video.readyState >= 2) res(); else video.onloadeddata = res; });
    const dur = video.duration;

    // Audio first, while we are still close to the user's tap (iPhone needs that to allow audio)
    let actx = null, audioTracks = [];
    try {
      const AC = global.AudioContext || global.webkitAudioContext;
      actx = opts.audioContext || new AC();
      if (actx.state === 'suspended') await actx.resume();
      const src = actx.createMediaElementSource(video);
      const dest = actx.createMediaStreamDestination();
      src.connect(dest); // not connected to speakers: silent while recording
      audioTracks = dest.stream.getAudioTracks();
    } catch (e) { console.warn('audio', e); }

    opts.onStage && opts.onStage('نحلل الإضاءة والألوان…');
    const n = 5, samples = []; for (let i = 0; i < n; i++) samples.push(Math.min(dur - 0.05, dur * (i + 0.5) / n));
    const st = await analyse(video, samples);
    await seek(video, 0);

    // output size (even numbers for encoders)
    const vw = video.videoWidth, vh = video.videoHeight, s = Math.min(1, opts.maxLong / Math.max(vw, vh));
    const W = Math.round(vw * s / 2) * 2, H = Math.round(vh * s / 2) * 2;
    const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
    const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true, premultipliedAlpha: false });
    if (!gl) throw new Error('webgl2');
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS)); gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog); gl.useProgram(prog);
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const U = name => gl.getUniformLocation(prog, name);
    const levels = Math.log2(Math.max(vw, vh));
    gl.uniform1i(U('t'), 0);
    gl.uniform2f(U('px'), 1 / vw, 1 / vh);
    gl.uniform3f(U('wb'), st.wb[0], st.wb[1], st.wb[2]);
    gl.uniform1f(U('lo'), st.lo); gl.uniform1f(U('hi'), st.hi);
    gl.uniform1f(U('gExp'), st.gExp); gl.uniform1f(U('toneK'), st.toneK);
    gl.uniform1f(U('lodBase'), Math.max(0, levels - 3.2));  // ~1/9 of the frame
    gl.uniform1f(U('lodMid'), Math.max(0, levels - 6.3));   // ~1% of the frame
    gl.uniform1f(U('clarity'), 0.35);
    gl.uniform1f(U('sharp'), vw > 1400 ? 0.9 : 0.7);
    gl.viewport(0, 0, W, H);

    const draw = () => {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };
    draw();
    if (opts.preview) { opts.preview.innerHTML = ''; canvas.className = 'vprev'; opts.preview.appendChild(canvas); }

    // record canvas + original audio
    const fps = 30;
    const vstream = canvas.captureStream(fps);
    const stream = new MediaStream([...vstream.getVideoTracks(), ...audioTracks]);
    const rec = new MediaRecorder(stream, Object.assign({ videoBitsPerSecond: W * H > 1.5e6 ? 14e6 : 8e6, audioBitsPerSecond: 160000 }, mime ? { mimeType: mime } : {}));
    const chunks = [];
    rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    const stopped = new Promise(res => { rec.onstop = res; });

    opts.onStage && opts.onStage('نحسّن الفيديو…');
    rec.start(1000);
    let raf = 0, alive = true;
    const loop = () => {
      if (!alive) return;
      draw();
      opts.onProgress && opts.onProgress(Math.min(1, video.currentTime / dur));
      if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(loop);
      else raf = requestAnimationFrame(loop);
    };
    const ended = new Promise(res => { video.onended = res; });
    await video.play();
    loop();
    await ended;
    alive = false; cancelAnimationFrame(raf);
    draw();
    await new Promise(r => setTimeout(r, 250));
    rec.stop();
    await stopped;
    try { if (!opts.audioContext && actx) actx.close(); } catch (e) {}
    URL.revokeObjectURL(url);
    const type = rec.mimeType || mime || 'video/webm';
    const blob = new Blob(chunks, { type: type.split(';')[0] });
    return { blob, width: W, height: H, ext: /mp4/.test(type) ? 'mp4' : 'webm', hasAudio: audioTracks.length > 0, duration: dur };
  }

  global.VideoEnhance = { enhanceVideo };
})(window);
