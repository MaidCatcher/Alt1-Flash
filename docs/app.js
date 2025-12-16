// ProgFlash app.js — Adaptive (learned) anchor, no shipped templates.
// Auto-find learns an anchor once (from the user's own pixels), saves it, then stops scanning.
// Start: verifies saved anchor once; if not found, runs Auto find loop.
// Auto find: runs heuristic scan (red X cluster) + learns anchor.
// Clear lock: deletes saved lock+anchor.
//
// Requires matcher.js to provide: captureRegion(x,y,w,h) and findAnchor(hay, needle, opts)

(function () {
  // ---------- UI ----------
  const statusEl = document.getElementById("status");
  const modeEl   = document.getElementById("mode");
  const lockEl   = document.getElementById("lock");
  const progEl   = document.getElementById("progress");
  const dbgEl    = document.getElementById("debugBox");

  const startBtn = document.getElementById("startBtn");
  const stopBtn  = document.getElementById("stopBtn");
  const autoFindBtn = document.getElementById("autoFindBtn");
  const clearLockBtn = document.getElementById("clearLockBtn");
  const testBtn  = document.getElementById("testFlashBtn");

  const savedLockEl = document.getElementById("savedLock");

  const canvas = document.getElementById("previewCanvas");
  const ctx = canvas ? canvas.getContext("2d", { willReadFrequently: true }) : null;

  function setStatus(v){ if (statusEl) statusEl.textContent = v; }
  function setMode(v){ if (modeEl) modeEl.textContent = v; }
  function setLock(v){ if (lockEl) lockEl.textContent = v; }
  function setProgress(v){ if (progEl) progEl.textContent = v; }
  function dbg(v){ if (dbgEl) dbgEl.textContent = String(v); }

  // ---------- Version ----------
  const APP_VERSION = window.APP_VERSION || "adaptive";
  const BUILD_ID = window.BUILD_ID || ("build-" + Date.now());

  // ---------- Storage ----------
  const LS_LOCK_POS = "progflash.lockPos";        // {x,y} (approx X location)
  const LS_ANCHOR   = "progflash.learnedAnchor";  // {w,h,rgbaBase64,dx,dy}

  function loadJSON(key){
    try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null; } catch { return null; }
  }
  function saveJSON(key, obj){
    try { localStorage.setItem(key, JSON.stringify(obj)); } catch {}
  }
  function delKey(key){
    try { localStorage.removeItem(key); } catch {}
  }
  function clamp(n,a,b){ return Math.max(a, Math.min(b,n)); }

  function updateSavedLockLabel(){
    if (!savedLockEl) return;
    const lp = loadJSON(LS_LOCK_POS);
    savedLockEl.textContent = lp ? `x=${lp.x},y=${lp.y}` : "none";
  }

  // ---------- Capture helpers ----------
  function getRsSize(){
    return { w: (window.alt1 && alt1.rsWidth) ? alt1.rsWidth : 0, h: (window.alt1 && alt1.rsHeight) ? alt1.rsHeight : 0 };
  }

  function captureRect(r){
    const img = captureRegion(r.x, r.y, r.w, r.h);
    return { rect: r, img };
  }

  // ---------- Preview ----------
  function drawRegionPreview(regionImg, label, rect /* relative */, strokeStyle){
    if (!ctx || !canvas || !regionImg) return;

    const srcW = regionImg.width, srcH = regionImg.height;
    const imageData = new ImageData(new Uint8ClampedArray(regionImg.data), srcW, srcH);

    const cw = canvas.width, ch = canvas.height;
    const scale = Math.min(cw / srcW, ch / srcH);
    const drawW = Math.floor(srcW * scale);
    const drawH = Math.floor(srcH * scale);
    const offX = Math.floor((cw - drawW) / 2);
    const offY = Math.floor((ch - drawH) / 2);

    ctx.clearRect(0,0,cw,ch);

    const tmp = document.createElement("canvas");
    tmp.width = srcW; tmp.height = srcH;
    const tctx = tmp.getContext("2d", { willReadFrequently: true });
    tctx.putImageData(imageData, 0, 0);

    ctx.drawImage(tmp, 0, 0, srcW, srcH, offX, offY, drawW, drawH);

    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(6,6,Math.min(cw-12, 520),20);
    ctx.fillStyle = "white";
    ctx.font = "12px Arial";
    ctx.fillText(label, 12, 21);

    if (rect) {
      const fx = offX + Math.floor(rect.x * scale);
      const fy = offY + Math.floor(rect.y * scale);
      const fw = Math.floor(rect.w * scale);
      const fh = Math.floor(rect.h * scale);
      ctx.lineWidth = 2;
      ctx.strokeStyle = strokeStyle || "deepskyblue";
      ctx.strokeRect(fx, fy, fw, fh);
    }
  }

  // ---------- Learned anchor helpers ----------
  function bytesToBase64(bytes){
    let s = "";
    for (let i=0;i<bytes.length;i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }
  function base64ToBytes(b64){
    const bin = atob(b64);
    const out = new Uint8ClampedArray(bin.length);
    for (let i=0;i<bin.length;i++) out[i] = bin.charCodeAt(i) & 255;
    return out;
  }
  function rgba(r,g,b,a){ return (r&255) | ((g&255)<<8) | ((b&255)<<16) | ((a&255)<<24); }
  function makeNeedleFromRGBA(w,h,bytes){
    return {
      width: w,
      height: h,
      data: bytes,
      getPixel(x,y){
        if (x < 0 || y < 0 || x >= w || y >= h) return 0;
        const i = (y*w + x) * 4;
        return rgba(bytes[i], bytes[i+1], bytes[i+2], bytes[i+3]);
      }
    };
  }

  function cropRGBAFromCapture(img, x, y, w, h){
    const bytes = new Uint8ClampedArray(w*h*4);
    let idx = 0;
    for (let yy=0; yy<h; yy++){
      for (let xx=0; xx<w; xx++){
        const si = ((y+yy) * img.width + (x+xx)) * 4;
        bytes[idx++] = img.data[si+0];
        bytes[idx++] = img.data[si+1];
        bytes[idx++] = img.data[si+2];
        bytes[idx++] = img.data[si+3];
      }
    }
    return bytes;
  }

  // ---------- Loop ----------
  let running = false;
  let loopHandle = null;

  function stopLoop(){
    if (loopHandle) clearTimeout(loopHandle);
    loopHandle = null;
  }
  function schedule(ms, fn){
    stopLoop();
    loopHandle = setTimeout(fn, ms);
  }

  // ---------- Heuristic: red X cluster ----------
  const TILE = { w: 640, h: 360 };
  const RED_SCAN = {
    step: 4,
    neigh: 14,
    minScore: 8
  };

  // FIXED: function name is isRedish (no isRedX mismatch)
  function isRedish(r,g,b){
    // gamma-tolerant "redness"
    const maxGB = Math.max(g, b);
    return (r - maxGB) > 45 && r > 80;
  }

  function findRedClusterInImage(img){
    const w = img.width, h = img.height;
    const data = img.data;

    const pts = [];
    for (let y = 0; y < h; y += RED_SCAN.step) {
      for (let x = 0; x < w; x += RED_SCAN.step) {
        const i = (y * w + x) * 4;
        const r = data[i+0], g = data[i+1], b = data[i+2];
        if (isRedish(r,g,b)) pts.push({ x, y });
      }
    }
    if (pts.length === 0) return null;

    const N = RED_SCAN.neigh;
    let best = { score: 0, x: 0, y: 0 };

    // Slight subsample for speed if tons of points
    const candidates = pts.length > 900 ? pts.filter((_,i)=> i % 3 === 0) : pts;

    for (const p of candidates) {
      let score = 0;
      for (const q of pts) {
        if (Math.abs(q.x - p.x) <= N && Math.abs(q.y - p.y) <= N) score++;
      }
      if (score > best.score) best = { score, x: p.x, y: p.y };
    }

    return best.score >= RED_SCAN.minScore ? best : null;
  }

  function heuristicFindRedX(){
    const rs = getRsSize();
    if (!rs.w || !rs.h) return null;

    const halves = [
      { name: "TOP",    y0: 0,                y1: Math.floor(rs.h / 2) },
      { name: "BOTTOM", y0: Math.floor(rs.h / 2), y1: rs.h }
    ];

    let globalBest = null;

    for (const half of halves) {
      let tileIndex = 0;
      for (let ty = half.y0; ty < half.y1; ty += TILE.h) {
        for (let tx = 0; tx < rs.w; tx += TILE.w) {
          tileIndex++;

          const w = Math.min(TILE.w, rs.w - tx);
          const h = Math.min(TILE.h, half.y1 - ty);

          const cap = captureRect({ x: tx, y: ty, w, h });
          if (!cap.img) continue;

          const cand = findRedClusterInImage(cap.img);

          drawRegionPreview(
            cap.img,
            `HEUR ${half.name} tile#${tileIndex} (${tx},${ty}) ${cand ? `score=${cand.score}` : "score=0"}`,
            cand ? { x: cand.x - 6, y: cand.y - 6, w: 12, h: 12 } : null,
            cand ? "orange" : null
          );

          if (cand) {
            const hit = { absX: tx + cand.x, absY: ty + cand.y, score: cand.score, half: half.name };
            if (!globalBest || hit.score > globalBest.score) globalBest = hit;
            if (hit.score >= RED_SCAN.minScore + 10) return hit;
          }
        }
      }
      if (globalBest && globalBest.half === "TOP") return globalBest;
    }

    return globalBest;
  }

  // ---------- Learn anchor ----------
  function learnAnchorFromRedX(xAbs, yAbs){
    const rs = getRsSize();
    if (!rs.w || !rs.h) return false;

    // Capture a generous stable chunk around the close button area.
    const dx = 30;
    const dy = 30;
    const aw = 360;
    const ah = 220;

    let ax = xAbs - dx;
    let ay = yAbs - dy;
    ax = clamp(ax, 0, rs.w - 1);
    ay = clamp(ay, 0, rs.h - 1);

    const w = clamp(aw, 1, rs.w - ax);
    const h = clamp(ah, 1, rs.h - ay);

    const cap = captureRect({ x: ax, y: ay, w, h });
    if (!cap.img) return false;

    const bytes = cropRGBAFromCapture(cap.img, 0, 0, w, h);
    saveJSON(LS_ANCHOR, { w, h, rgbaBase64: bytesToBase64(bytes), dx, dy });
    saveJSON(LS_LOCK_POS, { x: xAbs, y: yAbs });
    updateSavedLockLabel();
    return true;
  }

  // ---------- Verify anchor ----------
  const VERIFY = {
    pad: 320,
    step: 2,
    tolerance: 55,
    minAccept: 0.72
  };

  function verifySavedAnchorOnce(){
    const lockPos = loadJSON(LS_LOCK_POS);
    const stored = loadJSON(LS_ANCHOR);
    if (!lockPos || !stored) return false;

    const rs = getRsSize();
    if (!rs.w || !rs.h) return false;

    const needle = makeNeedleFromRGBA(stored.w, stored.h, base64ToBytes(stored.rgbaBase64));

    const pad = VERIFY.pad;
    let rx = Math.floor(lockPos.x - pad);
    let ry = Math.floor(lockPos.y - pad);
    rx = clamp(rx, 0, rs.w - 1);
    ry = clamp(ry, 0, rs.h - 1);
    const rw = clamp(pad * 2, 1, rs.w - rx);
    const rh = clamp(pad * 2, 1, rs.h - ry);

    const cap = captureRect({ x: rx, y: ry, w: rw, h: rh });
    if (!cap.img) return false;

    const m = findAnchor(cap.img, needle, {
      tolerance: VERIFY.tolerance,
      minScore: 0.01,
      step: VERIFY.step,
      ignoreAlphaBelow: 0
    });

    const ok = !!(m && m.ok && typeof m.score === "number" && m.score >= VERIFY.minAccept);

    drawRegionPreview(
      cap.img,
      `VERIFY score=${(m?.score ?? 0).toFixed(2)} ${ok ? "OK" : "MISS"}`,
      ok ? { x: m.x, y: m.y, w: needle.width, h: needle.height } : null,
      ok ? "lime" : "red"
    );

    if (!ok) return false;

    const foundAnchorAbsX = cap.rect.x + m.x;
    const foundAnchorAbsY = cap.rect.y + m.y;

    const xCornerX = foundAnchorAbsX + stored.dx;
    const xCornerY = foundAnchorAbsY + stored.dy;

    // update lock
    saveJSON(LS_LOCK_POS, { x: xCornerX, y: xCornerY });
    updateSavedLockLabel();

    setStatus("Locked (scanning stopped)");
    setMode("Running");
    setLock(`x=${xCornerX}, y=${xCornerY}`);
    setProgress("locked");
    dbg(JSON.stringify({ verify: { ok: true, score: m.score }, lockPos: { x: xCornerX, y: xCornerY } }, null, 2));

    stopLoop();
    return true;
  }

  // ---------- Main auto-find loop ----------
  function runAutoFindLoop(){
    if (!running) return;

    setMode("Running");
    setStatus("Auto-finding (red X heuristic)…");
    setLock("none");
    setProgress("—");

    schedule(0, () => {
      if (!running) return;

      const hit = heuristicFindRedX();
      if (!hit) {
        setStatus("Auto-find: not found yet (retrying)...");
        dbg(JSON.stringify({ heuristic: "fail", note: "Retry in 600ms" }, null, 2));
        schedule(600, runAutoFindLoop);
        return;
      }

      setStatus(`Heuristic hit (score ${hit.score}). Learning anchor…`);

      const learned = learnAnchorFromRedX(hit.absX, hit.absY);
      if (!learned) {
        setStatus("Auto-find: capture failed (retrying)...");
        schedule(600, runAutoFindLoop);
        return;
      }

      setStatus("Verifying learned anchor…");
      if (verifySavedAnchorOnce()) return;

      setStatus("Learned anchor verify failed (retrying)...");
      schedule(600, runAutoFindLoop);
    });
  }

  // ---------- Controls ----------
  async function start(){
    if (!window.alt1) { setStatus("Alt1 missing"); dbg("Open inside Alt1 Toolkit."); return; }
    if (!alt1.permissionPixel) { setStatus("No pixel permission"); dbg("Enable Alt1 pixel permission."); return; }
    if (typeof captureRegion !== "function" || typeof findAnchor !== "function") {
      setStatus("matcher.js not ready");
      dbg(JSON.stringify({ captureRegion: typeof captureRegion, findAnchor: typeof findAnchor }, null, 2));
      return;
    }

    running = true;

    setStatus("Checking saved lock…");
    if (verifySavedAnchorOnce()) return;

    runAutoFindLoop();
  }

  function stop(){
    running = false;
    stopLoop();
    setMode("Not running");
    setStatus("Idle");
    setLock("none");
    setProgress("—");
  }

  function clear(){
    delKey(LS_LOCK_POS);
    delKey(LS_ANCHOR);
    updateSavedLockLabel();
    setStatus("Saved lock cleared");
    setLock("none");
    setProgress("—");
  }

  // ---------- Wire buttons ----------
  if (testBtn) testBtn.onclick = () => alert("flash test");
  if (startBtn) startBtn.onclick = () => start().catch(e => dbg(String(e)));
  if (stopBtn) stopBtn.onclick = () => stop();
  if (autoFindBtn) autoFindBtn.onclick = () => { running = true; clear(); runAutoFindLoop(); };
  if (clearLockBtn) clearLockBtn.onclick = () => clear();

  // ---------- Init ----------
  updateSavedLockLabel();
  setStatus("Idle");
  setMode("Not running");
  setLock("none");
  setProgress("—");
  dbg(JSON.stringify({
    app: { version: APP_VERSION, build: BUILD_ID },
    savedLock: loadJSON(LS_LOCK_POS),
    hasAnchor: !!loadJSON(LS_ANCHOR),
    note: "Adaptive mode: Auto find learns anchor once, then Start verifies and stops scanning."
  }, null, 2));
})();