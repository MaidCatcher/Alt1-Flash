// ProgFlash app.js — Adaptive anchor with rectangle (edge-density) auto-detect.
// No shipped PNG templates. No color heuristics.
// Stage A: incremental scan tiles for "window-like" rectangles via edge-density scoring (gamma/theme safe).
// Stage B: learn an anchor chunk (captured from user's pixels) around the best rectangle.
// Stage C: on Start, verify saved anchor once; if ok, lock and stop scanning.
//
// Requires matcher.js to provide: captureRegion(x,y,w,h) and findAnchor(haystack, needle, opts)

(() => {
  // ---------- DOM ----------
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
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  function setStatus(v){ if (statusEl) statusEl.textContent = v; }
  function setMode(v){ if (modeEl) modeEl.textContent = v; }
  function setLock(v){ if (lockEl) lockEl.textContent = v; }
  function setProgress(v){ if (progEl) progEl.textContent = v; }
  function dbg(v){ if (dbgEl) dbgEl.textContent = String(v); }

  const APP_VERSION = window.APP_VERSION || "unknown";
  const BUILD_ID = window.BUILD_ID || ("build-" + Date.now());

  // ---------- Storage ----------
  const LS_LOCK_POS = "progflash.lockPos";       // {x,y} anchor origin (top-left of learned anchor in screen coords)
  const LS_ANCHOR   = "progflash.learnedAnchor"; // {w,h,rgbaBase64}

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

  function getRsSize(){
    return { w: alt1.rsWidth || 0, h: alt1.rsHeight || 0 };
  }

  function captureRect(r){
    const img = captureRegion(r.x, r.y, r.w, r.h);
    return { rect: r, img };
  }

  // ---------- Preview ----------
  function drawRegionPreview(regionImg, label, rect /* relative */, strokeStyle){
    if (!regionImg || !canvas) return;

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

    // label
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(6,6,Math.min(cw-12, 740),20);
    ctx.fillStyle = "white";
    ctx.font = "12px Arial";
    ctx.fillText(label, 12, 21);

    if (rect) {
      const fx = offX + Math.floor(rect.x * scale);
      const fy = offY + Math.floor(rect.y * scale);
      const fw = Math.floor(rect.w * scale);
      const fh = Math.floor(rect.h * scale);
      ctx.lineWidth = 2;
      ctx.strokeStyle = strokeStyle || "orange";
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

  function cropRGBA(img, x, y, w, h){
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

  function setLockedAt(x, y, note){
    saveJSON(LS_LOCK_POS, { x, y });
    updateSavedLockLabel();

    setStatus("Locked (scanning stopped)");
    setMode("Running");
    setLock(`x=${x}, y=${y}`);
    setProgress("locked");

    dbg(JSON.stringify({
      app: { version: APP_VERSION, build: BUILD_ID },
      locked: true,
      lockPos: { x, y },
      note: note || "Scanning stopped until Auto find is pressed."
    }, null, 2));

    stopLoop();
  }

  function clearLock(){
    delKey(LS_LOCK_POS);
    delKey(LS_ANCHOR);
    updateSavedLockLabel();
    setLock("none");
    setProgress("—");
    setStatus("Saved lock cleared");
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

  // ------------------------------------------------------------
  // Stage A: rectangle detection via edge-density scoring
  // (Incremental: one tile per tick so preview is truthful and UI doesn't stall)
  // ------------------------------------------------------------
  const TILE = { w: 640, h: 360 };

  const RECT = {
    ds: 4,
    edgeThr: 28,
    scanStep: 3,
    sizes: [
      { w: 440, h: 165 },
      { w: 420, h: 155 },
      { w: 400, h: 150 },
      { w: 380, h: 145 },
      { w: 360, h: 140 },
      { w: 340, h: 130 }
    ],
    ring: 14,
    minScore: 0.010,

    // If TOP has any ok candidate, prefer TOP even if bottom is slightly higher.
    topBias: 0.006
  };

  function toGray(r,g,b){
    return (r*77 + g*150 + b*29) >> 8;
  }

  function buildEdgeIntegral(img, ds, edgeThr){
    const W = Math.floor(img.width / ds);
    const H = Math.floor(img.height / ds);
    const gray = new Uint8Array(W * H);

    for (let y=0; y<H; y++){
      for (let x=0; x<W; x++){
        const sx = x*ds;
        const sy = y*ds;
        const i = (sy*img.width + sx) * 4;
        const g = toGray(img.data[i], img.data[i+1], img.data[i+2]);
        gray[y*W + x] = g;
      }
    }

    const edge = new Uint8Array(W * H);
    for (let y=1; y<H-1; y++){
      for (let x=1; x<W-1; x++){
        const c = gray[y*W + x];
        const dx = Math.abs(c - gray[y*W + (x+1)]);
        const dy = Math.abs(c - gray[(y+1)*W + x]);
        const m = dx + dy;
        edge[y*W + x] = (m >= edgeThr) ? 1 : 0;
      }
    }

    const IW = W + 1;
    const ii = new Uint32Array((W+1) * (H+1));
    for (let y=1; y<=H; y++){
      let rowsum = 0;
      const rowOff = y*IW;
      const prevOff = (y-1)*IW;
      const eOff = (y-1)*W;
      for (let x=1; x<=W; x++){
        rowsum += edge[eOff + (x-1)];
        ii[rowOff + x] = ii[prevOff + x] + rowsum;
      }
    }
    return { W, H, ii, ds };
  }

  function rectSum(ii, IW, x, y, w, h){
    const x2 = x + w;
    const y2 = y + h;
    return ii[y2*IW + x2] - ii[y2*IW + x] - ii[y*IW + x2] + ii[y*IW + x];
  }

  function scoreWindow(iiObj, x, y, w, h, ring){
    const { W, ii } = iiObj;
    const IW = W + 1;

    const inside = rectSum(ii, IW, x, y, w, h);
    const insideArea = Math.max(1, w*h);
    const insideD = inside / insideArea;

    const rx = clamp(x - ring, 0, W-1);
    const ry = clamp(y - ring, 0, iiObj.H-1);
    const rx2 = clamp(x + w + ring, 0, W);
    const ry2 = clamp(y + h + ring, 0, iiObj.H);
    const rw = Math.max(1, rx2 - rx);
    const rh = Math.max(1, ry2 - ry);

    const outer = rectSum(ii, IW, rx, ry, rw, rh);
    const outerArea = Math.max(1, rw*rh);
    const outerD = outer / outerArea;

    return insideD - outerD * 0.75;
  }

  function findBestRectangleInTile(img){
    const iiObj = buildEdgeIntegral(img, RECT.ds, RECT.edgeThr);
    const { W, H, ds } = iiObj;

    const sizes = RECT.sizes.map(s => ({
      w: Math.max(12, Math.floor(s.w / ds)),
      h: Math.max(10, Math.floor(s.h / ds))
    }));

    const ring = Math.max(2, Math.floor(RECT.ring / ds));
    let best = { score: -1e9, x: 0, y: 0, w: 0, h: 0 };

    for (const sz of sizes) {
      const ww = sz.w, hh = sz.h;
      if (ww >= W || hh >= H) continue;

      for (let y=0; y<=H-hh; y+=RECT.scanStep) {
        for (let x=0; x<=W-ww; x+=RECT.scanStep) {
          const sc = scoreWindow(iiObj, x, y, ww, hh, ring);
          if (sc > best.score) best = { score: sc, x, y, w: ww, h: hh };
        }
      }
    }

    return {
      ok: best.score >= RECT.minScore,
      score: best.score,
      x: best.x * ds,
      y: best.y * ds,
      w: best.w * ds,
      h: best.h * ds
    };
  }

  // Incremental scan cursor
  let scan = null;

  function stageAResetScan(){
    const rs = getRsSize();
    if (!rs.w || !rs.h) return false;

    scan = {
      rs,
      halves: [
        { name: "TOP", y0: 0, y1: Math.floor(rs.h / 2) },
        { name: "BOTTOM", y0: Math.floor(rs.h / 2), y1: rs.h }
      ],
      halfIdx: 0,
      tx: 0,
      ty: 0,
      tileIndex: 0,
      bestTop: null,
      bestBottom: null
    };

    scan.ty = scan.halves[0].y0;
    scan.tx = 0;
    return true;
  }

  function stageAStepOneTile(){
    if (!scan) return { done: true, hit: null };

    const { rs, halves } = scan;

    // If finished all halves
    if (scan.halfIdx >= halves.length) {
      // Prefer TOP if it has any ok candidate, unless bottom beats it by a lot.
      let best = scan.bestTop || scan.bestBottom || null;
      if (scan.bestTop && scan.bestBottom) {
        if (scan.bestBottom.score > scan.bestTop.score + RECT.topBias) best = scan.bestBottom;
        else best = scan.bestTop;
      }
      return { done: true, hit: best };
    }

    const half = halves[scan.halfIdx];

    // If finished this half (ty past end)
    if (scan.ty >= half.y1) {
      scan.halfIdx++;
      if (scan.halfIdx < halves.length) {
        scan.ty = halves[scan.halfIdx].y0;
        scan.tx = 0;
      }
      return { done: false, hit: null };
    }

    // If finished row, move to next row
    if (scan.tx >= rs.w) {
      scan.tx = 0;
      scan.ty += TILE.h;
      return { done: false, hit: null };
    }

    const tx = scan.tx;
    const ty = scan.ty;
    scan.tx += TILE.w;
    scan.tileIndex++;

    const w = Math.min(TILE.w, rs.w - tx);
    const h = Math.min(TILE.h, half.y1 - ty);
    const cap = captureRect({ x: tx, y: ty, w, h });
    if (!cap.img) {
      drawRegionPreview(null, `CAPTURE FAIL ${half.name} tile#${scan.tileIndex}`, null);
      return { done: false, hit: null };
    }

    const r = findBestRectangleInTile(cap.img);

    drawRegionPreview(
      cap.img,
      `SCAN ${half.name} tile#${scan.tileIndex} (${tx},${ty}) score=${r.score.toFixed(3)}`,
      r.ok ? { x: r.x, y: r.y, w: r.w, h: r.h } : null,
      r.ok ? "orange" : null
    );

    if (r.ok) {
      const hit = { score: r.score, absX: tx + r.x, absY: ty + r.y, w: r.w, h: r.h, half: half.name };
      if (half.name === "TOP") {
        if (!scan.bestTop || hit.score > scan.bestTop.score) scan.bestTop = hit;
      } else {
        if (!scan.bestBottom || hit.score > scan.bestBottom.score) scan.bestBottom = hit;
      }
    }

    return { done: false, hit: null };
  }

  // ------------------------------------------------------------
  // Stage B: learn anchor from detected rectangle
  // ------------------------------------------------------------
  function learnAnchorFromRect(hit){
    const rs = getRsSize();
    if (!rs.w || !rs.h) return false;

    const padL = 30, padT = 30, padR = 30, padB = 30;

    let ax = hit.absX - padL;
    let ay = hit.absY - padT;
    let aw = hit.w + padL + padR;
    let ah = hit.h + padT + padB;

    ax = clamp(ax, 0, rs.w - 1);
    ay = clamp(ay, 0, rs.h - 1);
    aw = clamp(aw, 20, rs.w - ax);
    ah = clamp(ah, 20, rs.h - ay);

    const cap = captureRect({ x: ax, y: ay, w: aw, h: ah });
    if (!cap.img) return false;

    const bytes = cropRGBA(cap.img, 0, 0, aw, ah);
    saveJSON(LS_ANCHOR, { w: aw, h: ah, rgbaBase64: bytesToBase64(bytes) });

    saveJSON(LS_LOCK_POS, { x: ax, y: ay });
    updateSavedLockLabel();

    dbg(JSON.stringify({
      learned: true,
      anchor: { x: ax, y: ay, w: aw, h: ah },
      rect: hit
    }, null, 2));

    return true;
  }

  // ------------------------------------------------------------
  // Stage C: verify saved anchor once
  // ------------------------------------------------------------
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

    if (!ok) {
      dbg(JSON.stringify({
        verify: { ok: false, score: m?.score ?? 0 },
        savedLock: lockPos,
        note: "Saved anchor not found near saved lock."
      }, null, 2));
      return false;
    }

    const foundAnchorAbsX = cap.rect.x + m.x;
    const foundAnchorAbsY = cap.rect.y + m.y;

    setLockedAt(foundAnchorAbsX, foundAnchorAbsY, `Verified learned anchor (score ${(m.score).toFixed(2)}).`);
    return true;
  }

  // ------------------------------------------------------------
  // Main loop
  // ------------------------------------------------------------
  function runAutoFindLoop(){
    if (!running) return;

    setMode("Running");
    setStatus("Auto-finding (rectangle detect)…");
    setLock("none");
    setProgress("—");

    if (!stageAResetScan()) {
      setStatus("Auto-find: bad RS dims");
      schedule(600, runAutoFindLoop);
      return;
    }

    const tick = () => {
      if (!running) return;

      const step = stageAStepOneTile();

      // Still scanning
      if (!step.done) {
        // 0ms can still be okay, but 15–25ms keeps UI very responsive.
        schedule(15, tick);
        return;
      }

      // Done scanning all tiles
      const hit = step.hit;
      if (!hit) {
        setStatus("Auto-find: no rectangle yet (retrying)...");
        dbg(JSON.stringify({ stage: "rect", ok: false, note: "Retry in 600ms" }, null, 2));
        schedule(600, runAutoFindLoop);
        return;
      }

      setStatus(`Rectangle hit (${hit.half}) score ${hit.score.toFixed(3)}. Learning anchor…`);

      const ok = learnAnchorFromRect(hit);
      if (!ok) {
        setStatus("Auto-find: capture failed (retrying)...");
        schedule(600, runAutoFindLoop);
        return;
      }

      setStatus("Verifying learned anchor…");
      if (verifySavedAnchorOnce()) return;

      setStatus("Learned anchor verify failed (retrying)...");
      schedule(600, runAutoFindLoop);
    };

    schedule(0, tick);
  }

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

  // ---------- Buttons ----------
  if (startBtn) startBtn.onclick = () => start().catch(e => dbg(String(e)));
  if (stopBtn) stopBtn.onclick = () => stop();
  if (autoFindBtn) autoFindBtn.onclick = () => {
    running = true;
    delKey(LS_LOCK_POS);
    delKey(LS_ANCHOR);
    updateSavedLockLabel();
    runAutoFindLoop();
  };
  if (clearLockBtn) clearLockBtn.onclick = () => clearLock();
  if (testBtn) testBtn.onclick = () => alert("flash test");

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
    note: "Rectangle mode: incremental scan so preview matches scan order; learns anchor once, then Start verifies and stops scanning."
  }, null, 2));
})();
