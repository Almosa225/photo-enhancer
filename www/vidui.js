// Photo / Video tabs and the video flow (pick -> ready -> working -> result -> save)
(() => {
  const $ = id => document.getElementById(id);
  const IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  let vFile = null, srcURL = null, outURL = null, outBlob = null, outExt = 'mp4', vBusy = false;

  // ---- tabs ----
  const tabs = $('tabs');
  tabs.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b || vBusy || window.__imgBusy) return;
    tabs.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    const vid = b.dataset.mode === 'vid';
    $('imgMode').style.display = vid ? 'none' : '';
    $('vidMode').style.display = vid ? '' : 'none';
  });
  const lockTabs = on => tabs.querySelectorAll('button').forEach(x => { x.disabled = on; });

  const vshow = which => {
    $('vPick').style.display = which === 'pick' ? '' : 'none';
    $('vReady').style.display = which === 'ready' ? 'flex' : 'none';
    $('vWork').style.display = which === 'work' ? 'flex' : 'none';
    $('vResult').style.display = which === 'result' ? 'flex' : 'none';
  };
  vshow('pick');
  const fmt = s => { s = Math.round(s); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  const hint = (t, err) => { const el = $('vPickHint'); el.textContent = t; el.classList.toggle('err', !!err); };
  const MAX_SEC = 180;

  // ---- pick ----
  $('vfile').addEventListener('change', e => {
    const f = e.target.files[0]; if (!f) return;
    vFile = f;
    if (srcURL) URL.revokeObjectURL(srcURL);
    srcURL = URL.createObjectURL(f);
    const v = $('vSrc'); v.src = srcURL;
    v.onloadedmetadata = () => {
      $('vDur').textContent = fmt(v.duration);
      $('vRes').textContent = v.videoWidth + ' × ' + v.videoHeight;
      if (v.duration > MAX_SEC) {
        vshow('pick'); hint('المقطع أطول من 3 دقائق. اختر مقطع أقصر.', true); return;
      }
      $('vReadyMsg').textContent = 'المعالجة تاخذ تقريباً ' + fmt(v.duration) + ' (نفس مدة الفيديو). خلّ الصفحة مفتوحة والشاشة شغالة.';
      vshow('ready');
    };
    v.onerror = () => { vshow('pick'); hint('ما قدرنا نفتح هذا الفيديو. جرّب مقطع ثاني.', true); };
  });
  $('vCancel').addEventListener('click', () => { $('vfile').value = ''; vshow('pick'); $('vfile').click(); });

  // ---- go ----
  $('vGo').addEventListener('click', async () => {
    if (!vFile || vBusy) return;
    vBusy = true; lockTabs(true);
    // Audio context created inside the tap so phones allow recording the sound
    let actx = null;
    try { const AC = window.AudioContext || window.webkitAudioContext; actx = new AC(); actx.resume(); } catch (e) {}
    $('vSrc').pause();
    vshow('work'); $('vStage').textContent = 'نجهّز الفيديو…'; $('vBar').style.width = '2%';
    let wake = null;
    try { if (navigator.wakeLock) wake = await navigator.wakeLock.request('screen'); } catch (e) {}
    try {
      const r = await VideoEnhance.enhanceVideo(vFile, {
        maxLong: 1920,
        audioContext: actx,
        preview: $('vPrev'),
        onStage: t => { $('vStage').textContent = t; },
        onProgress: p => { $('vBar').style.width = Math.round(4 + p * 94) + '%'; $('vStage').textContent = 'نحسّن الفيديو… ' + Math.round(p * 100) + '%'; }
      });
      outBlob = r.blob; outExt = r.ext;
      if (outURL) URL.revokeObjectURL(outURL);
      outURL = URL.createObjectURL(outBlob);
      const o = $('vOut'); o.src = outURL; o.muted = false;
      $('vShowAfter').classList.add('on'); $('vShowBefore').classList.remove('on');
      $('vMsg').textContent = r.hasAudio ? '' : 'ملاحظة: الفيديو طلع بدون صوت على هذا الجهاز.';
      $('vMsg').className = 'msg';
      vshow('result');
    } catch (e) {
      console.error(e);
      vshow('pick');
      hint(e && e.message === 'no-recorder' ? 'متصفحك ما يدعم حفظ الفيديو. حدّث النظام أو جرّب متصفح ثاني.' : 'صار خطأ أثناء تحسين الفيديو. جرّب مرة ثانية أو مقطع أقصر.', true);
    } finally {
      vBusy = false; lockTabs(false);
      try { wake && wake.release(); } catch (e) {}
      try { actx && actx.close(); } catch (e) {}
    }
  });

  // ---- before / after toggle (keeps the playback position) ----
  const swap = after => {
    const o = $('vOut'), t = o.currentTime, playing = !o.paused;
    o.src = after ? outURL : srcURL;
    o.onloadedmetadata = () => { try { o.currentTime = t; } catch (e) {} if (playing) o.play().catch(() => {}); };
    $('vShowAfter').classList.toggle('on', after); $('vShowBefore').classList.toggle('on', !after);
  };
  $('vShowAfter').addEventListener('click', () => swap(true));
  $('vShowBefore').addEventListener('click', () => swap(false));

  // ---- save ----
  $('vSave').addEventListener('click', async () => {
    if (!outBlob) return;
    const base = 'enhanced-video-' + Date.now(), name = base + '.' + outExt;
    const msg = (t, err) => { $('vMsg').textContent = t; $('vMsg').className = 'msg' + (err ? ' err' : ''); };
    const N = window.NativeApp;
    if (N && N.isNative && N.isNative()) {
      $('vSave').disabled = true; msg('نحفظ الفيديو…');
      try { await N.saveVideoToGallery(outBlob, base, outExt); msg('تم حفظ الفيديو في المعرض ✅'); }
      catch (e) { console.error(e); try { await N.shareFile(outBlob, name); msg(''); } catch (e2) { msg('ما قدرنا نحفظ الفيديو. حاول مرة ثانية.', true); } }
      finally { $('vSave').disabled = false; }
      return;
    }
    try {
      const file = new File([outBlob], name, { type: outBlob.type || 'video/mp4' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file] });
        msg('اختر "حفظ الفيديو" عشان ينحفظ في الصور.');
        return;
      }
    } catch (e) { if (e && e.name === 'AbortError') return; }
    const a = document.createElement('a'); a.href = outURL; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    msg(IS_IOS ? 'إذا ما نزل، اضغط مطولاً على الفيديو واختر حفظ.' : 'نزل الفيديو في مجلد التنزيلات.');
  });

  $('vAgain').addEventListener('click', () => { $('vfile').value = ''; outBlob = null; vshow('pick'); $('vfile').click(); });
})();
