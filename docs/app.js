// ProgFlash app.js — Adaptive anchor with rectangle + progress-bar detector.
// Stage A: incremental scan tiles for "window-like" rectangles via edge-density scoring,
//          then filter/score by presence of a horizontal progress bar inside the rectangle.
// Stage B: 2-frame confirmation (progress boundary moves) before learning/saving anchor.
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
  function drawRegionPreview(regionImg, label, rect /* relative */, strokeStyle, extra){
    if (!canvas) return;
    const cw = canvas.width, ch = canvas.height;
    ctx.clearRect(0,0,cw,ch);

    if (!regionImg) {
      ctx.fillStyle = "rgba(0,0,0,0.7)";
      ctx.fillRect(0,0,cw,ch);
      ctx.fillStyle = "white";
      ctx.font = "12px Arial";
      ctx.fillText(label || "no image", 10, 18);
      return;
    }

    const srcW = regionImg.width, srcH = regionImg.height;
    const imageData = new ImageData(new Uint8ClampedArray(regionImg.data), srcW, srcH);

    const scale = Math.min(cw / srcW, ch / srcH);
    const drawW = Math.floor(srcW * scale);
    const drawH = Math.floor(srcH * scale);
    const offX = Math.floor((cw - drawW) / 2);
    const offY = Math.floor((ch - drawH) / 2);

    const tmp = document.createElement("canvas");
    tmp.width = srcW; tmp.height = srcH;
    const tctx = tmp.getContext("2d", { willReadFrequently: true });
    tctx.putImageData(imageData, 0, 0);

    ctx.drawImage(tmp, 0, 0, srcW, srcH, offX, offY, drawW, drawH);

    // label
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(6,6,Math.min(cw-12, 760),20);
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

      if (extra && extra.bar) {
        const bx = rect.x + extra.bar.x;
        const by = rect.y + extra.bar.y;
        const bw = extra.bar.w;
        const bh = extra.bar.h;
        const bfx = offX + Math.floor(bx * scale);
        const bfy = offY + Math.floor(by * scale);
        const bfw = Math.floor(bw * scale);
        const bfh = Math.floor(bh * scale);

        // bar box
        ctx.lineWidth = 2;
        ctx.strokeStyle = "rgba(0,255,255,0.9)";
        ctx.strokeRect(bfx, bfy, bfw, bfh);

        // boundary line
        if (typeof extra.bar.boundaryX === "number") {
          const lx = offX + Math.floor((rect.x + extra.bar.boundaryX) * scale);
          ctx.strokeStyle = "rgba(255,255,0,0.95)";
          ctx.beginPath();
          ctx.moveTo(lx, bfy);
          ctx.lineTo(lx, bfy + bfh);
          ctx.stroke();
        }
      }
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
  // ------------------------------------------------------------
  const TILE = { w: 640, h: 360 };

  const RECT = {
    ds: 4,
    edgeThr: 28,
    scanStep: 3,
    sizes: [
      { w: 460, h: 185 },
      { w: 440, h: 170 },
      { w: 420, h: 160 },
      { w: 400, h: 150 },
      { w: 380, h: 145 },
      { w: 360, h: 140 },
      { w: 340, h: 130 }
    ],
    ring: 14,
    minScore: 0.010,

    // Prefer TOP if close.
    topBias: 0.050,

    // Keep top candidates per tile (rect score)
    keepTopN: 8
  };

  // ------------------------------------------------------------
  // Stage A.5: progress-bar signature inside candidate rectangle
  // ------------------------------------------------------------
  const PB = {
    xStep: 2,
    yStep: 2,
    stripeHeights: [8,10,12,14],
    yBandMin: 0.25,     // search between 25%..75% of rect height
    yBandMax: 0.75,
    minBarWidthFrac: 0.60,
    minDiff: 22,        // min left/right luminance step (0..255)
    minScore: 0.10,     // min normalized progress score
    smoothWin: 5,
    boundaryMinFrac: 0.18,
    boundaryMaxFrac: 0.82
  };

  // Two-frame confirmation
  const PB2 = {
    delayMs: 140,
    minBoundaryMovePx: 3,     // crafting bars move steadily; 3px is a safe nudge
    strongSingleFrameScore: 0.22 // if very strong, allow lock even if movement is tiny (paused)
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

  // Return top N rectangle candidates by rect score (relative to tile).
  function findRectangleCandidatesInTile(img){
    const iiObj = buildEdgeIntegral(img, RECT.ds, RECT.edgeThr);
    const { W, H, ds } = iiObj;

    const sizes = RECT.sizes.map(s => ({
      w: Math.max(12, Math.floor(s.w / ds)),
      h: Math.max(10, Math.floor(s.h / ds))
    }));

    const ring = Math.max(2, Math.floor(RECT.ring / ds));
    const best = []; // [{score,x,y,w,h}] in ds space

    function pushCandidate(c){
      best.push(c);
      best.sort((a,b)=>b.score-a.score);
      if (best.length > RECT.keepTopN) best.length = RECT.keepTopN;
    }

    for (const sz of sizes) {
      const ww = sz.w, hh = sz.h;
      if (ww >= W || hh >= H) continue;

      for (let y=0; y<=H-hh; y+=RECT.scanStep) {
        for (let x=0; x<=W-ww; x+=RECT.scanStep) {
          const sc = scoreWindow(iiObj, x, y, ww, hh, ring);
          if (sc <= RECT.minScore) continue;

          // small pruning: only keep if it can compete
          if (best.length < RECT.keepTopN || sc > best[best.length-1].score) {
            pushCandidate({ score: sc, x, y, w: ww, h: hh });
          }
        }
      }
    }

    // Convert to pixel space.
    return best.map(c => ({
      rectScore: c.score,
      x: c.x * ds,
      y: c.y * ds,
      w: c.w * ds,
      h: c.h * ds
    }));
  }

  function smooth1D(arr, win){
    if (win <= 1) return arr.slice();
    const out = new Float32Array(arr.length);
    const half = Math.floor(win/2);
    for (let i=0;i<arr.length;i++){
      let s=0, n=0;
      const a = Math.max(0, i-half);
      const b = Math.min(arr.length-1, i+half);
      for (let j=a;j<=b;j++){ s += arr[j]; n++; }
      out[i] = s / n;
    }
    return out;
  }

  // Score progress bar inside rect (relative to tile image).
  // Returns {ok, score, boundaryX, bar:{x,y,w,h}} where boundaryX is relative to rect (not bar).
  function scoreProgressBarInRect(tileImg, rect){
    const data = tileImg.data;
    const imgW = tileImg.width, imgH = tileImg.height;

    // Sanity clamp rect to tile.
    const rx = clamp(rect.x|0, 0, imgW-1);
    const ry = clamp(rect.y|0, 0, imgH-1);
    const rw = clamp(rect.w|0, 10, imgW - rx);
    const rh = clamp(rect.h|0, 10, imgH - ry);

    const minBarW = Math.floor(rw * PB.minBarWidthFrac);
    const xMargin = Math.max(6, Math.floor(rw * 0.06));

    const y0 = ry + Math.floor(rh * PB.yBandMin);
    const y1 = ry + Math.floor(rh * PB.yBandMax);

    let best = { score: -1, boundaryX: null, bar: null, diff: 0 };

    for (let sy = y0; sy <= y1; sy += PB.yStep) {
      for (const sh of PB.stripeHeights) {
        const stripeH = sh;
        const stripeY = sy;
        if (stripeY < ry || stripeY + stripeH >= ry + rh) continue;

        // sample stripe into 1D luma profile across x
        const xs = rx + xMargin;
        const xe = rx + rw - xMargin;
        if (xe - xs < minBarW) continue;

        const step = PB.xStep;
        const len = Math.floor((xe - xs) / step);
        if (len < 60) continue;

        const profile = new Float32Array(len);
        const varAcc = new Float32Array(len);

        for (let i=0;i<len;i++){
          const x = xs + i*step;

          // average luminance over stripe height, and estimate vertical variance
          let sum = 0;
          let sumSq = 0;
          let n = 0;

          for (let yy=0; yy<stripeH; yy+=2){
            const y = stripeY + yy;
            const p = (y*imgW + x) * 4;
            const lum = toGray(data[p], data[p+1], data[p+2]);
            sum += lum;
            sumSq += lum*lum;
            n++;
          }
          const mean = sum / Math.max(1,n);
          const varr = (sumSq / Math.max(1,n)) - mean*mean;

          profile[i] = mean;
          varAcc[i] = varr;
        }

        const sm = smooth1D(profile, PB.smoothWin);

        // boundary search between fractions
        const bMin = Math.floor(len * PB.boundaryMinFrac);
        const bMax = Math.floor(len * PB.boundaryMaxFrac);

        const win = Math.max(4, Math.floor(10 / step)); // ~10px neighborhood
        let localBest = { score: -1, bi: -1, diff: 0, noise: 999 };

        for (let bi=bMin; bi<=bMax; bi++){
          const l0 = Math.max(0, bi - win);
          const l1 = bi - 1;
          const r0 = bi + 1;
          const r1 = Math.min(len-1, bi + win);

          if (l1 - l0 < 2 || r1 - r0 < 2) continue;

          let ls=0, ln=0, rs=0, rn=0;
          let lVar=0, rVar=0;

          for (let i=l0;i<=l1;i++){ ls += sm[i]; lVar += varAcc[i]; ln++; }
          for (let i=r0;i<=r1;i++){ rs += sm[i]; rVar += varAcc[i]; rn++; }

          const lm = ls/ln;
          const rm = rs/rn;
          const diff = Math.abs(lm - rm);

          if (diff < PB.minDiff) continue;

          // noise estimate: lower is better
          const noise = Math.sqrt((lVar/ln + rVar/rn) * 0.5);

          // score: step strength minus noise penalty
          const sc = (diff / 255) - (noise / 255) * 0.35;

          if (sc > localBest.score) localBest = { score: sc, bi, diff, noise };
        }

        if (localBest.score > best.score) {
          const boundaryX = (xs - rx) + localBest.bi * step; // relative to rect
          best = {
            score: localBest.score,
            boundaryX,
            diff: localBest.diff,
            bar: {
              x: xs - rx,
              y: stripeY - ry,
              w: xe - xs,
              h: stripeH,
              boundaryX: boundaryX
            }
          };
        }
      }
    }

    const ok = best.score >= PB.minScore;
    return { ok, score: best.score, boundaryX: best.boundaryX, bar: best.bar, diff: best.diff };
  }

  // Choose best candidate in tile by (rectScore + progressScore*weight) with progress gating.
  
// Choose best candidate in tile by (rectScore + progressScore + cancelScore + closeXScore) with gating.
function pickBestProgressCandidate(tileImg){
  const candidates = findRectangleCandidatesInTile(tileImg);
  if (!candidates.length) return null;

  // Weights: progress is primary, cancel + close-x confirm it's the crafting dialog.
  const wPB = 0.85;
  const wCancel = 0.75;
  const wClose = 0.35;

  let best = null;

  for (const r of candidates){
    const pb = scoreProgressBarInRect(tileImg, r);
    if (!pb.ok) continue;

    const cancel = scoreCancelButtonInRect(tileImg, r);
    const closex = scoreCloseXInRect(tileImg, r);

    // Gate: must look like a progress dialog, not just any long horizontal bar.
    // Accept if at least one of (cancel or close-x) is present; prefer both.
    if (!cancel.ok && !closex.ok) continue;

    const combined = r.rectScore + pb.score * wPB + cancel.score * wCancel + closex.score * wClose;

    const cur = {
      rect: { x: r.x, y: r.y, w: r.w, h: r.h },
      rectScore: r.rectScore,
      pbScore: pb.score,
      cancelScore: cancel.score,
      closeScore: closex.score,
      combinedScore: combined,
      pb,
      cancel,
      closex
    };

    if (!best || cur.combinedScore > best.combinedScore) best = cur;
  }

  return best;
}



// Stage A.6: detect "Cancel" button (warm/orange bar) near bottom-center of the window.
// Uses simple RGB rules (theme/gamma tolerant) and checks for a wide warm band.
function scoreCancelButtonInRect(tileImg, rect){
  const data = tileImg.data;
  const imgW = tileImg.width;
  const imgH = tileImg.height;

  const rx = clamp(rect.x|0, 0, imgW-1);
  const ry = clamp(rect.y|0, 0, imgH-1);
  const rw = clamp(rect.w|0, 1, imgW-rx);
  const rh = clamp(rect.h|0, 1, imgH-ry);

  // Search bottom band of the dialog
  const y0 = ry + Math.floor(rh * 0.68);
  const y1 = ry + Math.floor(rh * 0.94);
  const x0 = rx + Math.floor(rw * 0.12);
  const x1 = rx + Math.floor(rw * 0.88);

  const step = 2;
  let bestRowFrac = 0;

  for (let y = y0; y <= y1; y += step){
    let warm = 0;
    let total = 0;

    for (let x = x0; x <= x1; x += step){
      const p = (y*imgW + x) * 4;
      const r = data[p], g = data[p+1], b = data[p+2];

      // "Warm orange" heuristic:
      // - red dominant, green moderately high, blue lower
      // - avoid very dark pixels
      const isWarm =
        r >= 120 &&
        g >= 70 &&
        (r - b) >= 55 &&
        (r - g) >= 10 &&
        (g - b) >= 10;

      warm += isWarm ? 1 : 0;
      total++;
    }

    const frac = total ? (warm / total) : 0;
    if (frac > bestRowFrac) bestRowFrac = frac;
  }

  // OK if we see at least one fairly wide warm band row.
  const ok = bestRowFrac >= 0.18;

  return { ok, score: bestRowFrac };
}

// Stage A.7: detect close "X" in the top-right corner of the window (edge-only).
// We score diagonal edge density in a small corner patch.
function scoreCloseXInRect(tileImg, rect){
  const data = tileImg.data;
  const imgW = tileImg.width;
  const imgH = tileImg.height;

  const rx = clamp(rect.x|0, 0, imgW-1);
  const ry = clamp(rect.y|0, 0, imgH-1);
  const rw = clamp(rect.w|0, 1, imgW-rx);
  const rh = clamp(rect.h|0, 1, imgH-ry);

  // Corner region size (scaled by dialog size, clamped)
  const size = clamp(Math.floor(Math.min(rw, rh) * 0.22), 18, 30);

  const cx = clamp(rx + rw - size - 2, 0, imgW - size);
  const cy = clamp(ry + 2, 0, imgH - size);

  // Build a tiny edge map using luminance diffs
  const thr = 22;
  const edge = new Uint8Array(size * size);

  function lumAt(x,y){
    const p = ((cy+y)*imgW + (cx+x)) * 4;
    return toGray(data[p], data[p+1], data[p+2]);
  }

  for (let y=0; y<size; y++){
    for (let x=0; x<size; x++){
      const c = lumAt(x,y);
      const r = (x+1 < size) ? lumAt(x+1,y) : c;
      const d = (y+1 < size) ? lumAt(x,y+1) : c;
      const m = Math.abs(c - r) + Math.abs(c - d);
      edge[y*size + x] = (m >= thr) ? 1 : 0;
    }
  }

  // Score along the two diagonals with a small thickness
  const thick = 2;
  let d1 = 0, d2 = 0, maxd = 0;

  for (let i=0; i<size; i++){
    for (let t=-thick; t<=thick; t++){
      const x1 = i + t;
      const y1 = i;
      const x2 = (size - 1 - i) + t;
      const y2 = i;

      if (x1 >= 0 && x1 < size) { d1 += edge[y1*size + x1]; maxd++; }
      if (x2 >= 0 && x2 < size) { d2 += edge[y2*size + x2]; /* maxd already counts */ }
    }
  }

  // Normalize separately (d2 uses same count as d1 approximately)
  const denom = Math.max(1, maxd);
  const d1n = d1 / denom;
  const d2n = d2 / denom;

  // Require both diagonals to be present to avoid false positives (single diagonal borders).
  const ok = (d1n >= 0.22 && d2n >= 0.22);

  return { ok, score: (d1n + d2n) * 0.5, d1: d1n, d2: d2n, corner: { x: cx, y: cy, w: size, h: size } };
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
      // TOP-first policy: if we found any TOP candidate, ignore bottom entirely.
      const best = scan.bestTop || scan.bestBottom || null;
      return { done: true, hit: best };
    }

    const half = halves[scan.halfIdx];

    // If finished this half
    if (scan.ty >= half.y1) {
      // Early stop: after TOP half, if we have a TOP candidate, stop scanning.
      if (half.name === "TOP" && scan.bestTop) {
        scan.halfIdx = halves.length;
        return { done: true, hit: scan.bestTop };
      }

      scan.halfIdx++;
      if (scan.halfIdx < halves.length) {
        scan.ty = scan.halves[scan.halfIdx].y0;
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

    const best = pickBestProgressCandidate(cap.img);

    if (best) {
      drawRegionPreview(
        cap.img,
        `SCAN ${half.name} tile#${scan.tileIndex} rect=${best.rectScore.toFixed(3)} pb=${best.pbScore.toFixed(3)} ca=${best.cancelScore.toFixed(3)} x=${best.closeScore.toFixed(3)} comb=${best.combinedScore.toFixed(3)}`,
        best.rect,
        "orange",
        { bar: best.pb.bar }
      );

      const hit = {
        half: half.name,
        score: best.combinedScore,
        rectScore: best.rectScore,
        pbScore: best.pbScore,
        cancelScore: best.cancelScore,
        closeScore: best.closeScore,
        cancel: best.cancel,
        closex: best.closex,
        absX: tx + best.rect.x,
        absY: ty + best.rect.y,
        w: best.rect.w,
        h: best.rect.h,
        pb: best.pb
      };

      if (half.name === "TOP") {
        if (!scan.bestTop || hit.score > scan.bestTop.score) scan.bestTop = hit;
      } else {
        if (!scan.bestBottom || hit.score > scan.bestBottom.score) scan.bestBottom = hit;
      }
    } else {
      drawRegionPreview(
        cap.img,
        `SCAN ${half.name} tile#${scan.tileIndex} (no progress-bar candidate)`,
        null,
        null,
        null
      );
    }

    return { done: false, hit: null };
  }

  // ------------------------------------------------------------
  // Stage B: 2-frame confirmation + learn anchor
  // ------------------------------------------------------------
  function computeBoundaryFromAbsRect(absRect){
    const cap = captureRect(absRect);
    if (!cap.img) return null;

    // Run detector on full captured rect as a tile; force candidate to whole region.
    const pb = scoreProgressBarInRect(cap.img, { x: 0, y: 0, w: absRect.w, h: absRect.h });
    if (!pb.ok) return null;

    return { boundaryX: pb.boundaryX, pbScore: pb.score, pb, img: cap.img };
  }

  function learnAnchorFromAbsRect(absRect){
    const rs = getRsSize();
    if (!rs.w || !rs.h) return false;

    // Learn a SMALL, STABLE anchor inside the dialog frame (avoid moving bar/text).
    // This dramatically improves verify stability.
    const AN = {
      w: 240,
      h: 70,
      offX: 18,   // from dialog left
      offY: 10    // from dialog top
    };

    let ax = absRect.x + AN.offX;
    let ay = absRect.y + AN.offY;
    let aw = AN.w;
    let ah = AN.h;

    // Clamp to screen
    ax = clamp(ax, 0, rs.w - 1);
    ay = clamp(ay, 0, rs.h - 1);
    aw = clamp(aw, 20, rs.w - ax);
    ah = clamp(ah, 20, rs.h - ay);

    const cap = captureRect({ x: ax, y: ay, w: aw, h: ah });
    if (!cap.img) return false;

    const bytes = cropRGBA(cap.img, 0, 0, aw, ah);
    saveJSON(LS_ANCHOR, { w: aw, h: ah, rgbaBase64: bytesToBase64(bytes) });

    // Save anchor origin (not the whole dialog)
    saveJSON(LS_LOCK_POS, { x: ax, y: ay });
    updateSavedLockLabel();

    dbg(JSON.stringify({
      learned: true,
      anchor: { x: ax, y: ay, w: aw, h: ah },
      fromDialog: absRect
    }, null, 2));

    return true;
  }

  function confirmThenLearn(hit, doneCb){
    // First frame boundary
    const absRect = { x: hit.absX, y: hit.absY, w: hit.w, h: hit.h };
    const b1 = computeBoundaryFromAbsRect(absRect);

    if (!b1) {
      dbg(JSON.stringify({ stage: "pb2", ok: false, reason: "no boundary on frame1", hit }, null, 2));
      doneCb(false);
      return;
    }

    // Second frame boundary after delay
    schedule(PB2.delayMs, () => {
      if (!running) { doneCb(false); return; }

      const b2 = computeBoundaryFromAbsRect(absRect);
      if (!b2) {
        dbg(JSON.stringify({ stage: "pb2", ok: false, reason: "no boundary on frame2", hit }, null, 2));
        doneCb(false);
        return;
      }

      
// Re-check dialog-specific cues on frame2 to avoid drifting onto other panels.
const relRect = { x: 0, y: 0, w: absRect.w, h: absRect.h };
const c2 = scoreCancelButtonInRect(b2.img, relRect);
const x2 = scoreCloseXInRect(b2.img, relRect);
if (!c2.ok && !x2.ok) {
  dbg(JSON.stringify({ stage: "pb2", ok: false, reason: "no cancel/closex on frame2", c2, x2, hit }, null, 2));
  doneCb(false);
  return;
}

const move = Math.abs((b2.boundaryX ?? 0) - (b1.boundaryX ?? 0));
      const okMove = move >= PB2.minBoundaryMovePx;

      const okStrong = (b1.pbScore >= PB2.strongSingleFrameScore) || (b2.pbScore >= PB2.strongSingleFrameScore);

      drawRegionPreview(
        b2.img,
        `CONFIRM pb1=${b1.pbScore.toFixed(3)} pb2=${b2.pbScore.toFixed(3)} move=${move.toFixed(1)}px ${okMove || okStrong ? "OK" : "MISS"}`,
        { x: 0, y: 0, w: absRect.w, h: absRect.h },
        okMove || okStrong ? "lime" : "red",
        { bar: b2.pb.bar }
      );

      if (!(okMove || okStrong)) {
        dbg(JSON.stringify({ stage: "pb2", ok: false, move, b1: b1.pbScore, b2: b2.pbScore, hit }, null, 2));
        doneCb(false);
        return;
      }

      const learned = learnAnchorFromAbsRect(absRect);
      dbg(JSON.stringify({ stage: "pb2", ok: true, move, learned, hit }, null, 2));
      doneCb(learned);
    });
  }

  // ------------------------------------------------------------
  // Stage C: verify saved anchor once
  // ------------------------------------------------------------
  const VERIFY = {
    pad: 260,
    step: 2,
    tolerance: 55,
    minAccept: 0.68
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
  // Main auto-find loop
  // ------------------------------------------------------------
  function runAutoFindLoop(){
    if (!running) return;

    setMode("Running");
    setStatus("Auto-finding (progress window)…");
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

      if (!step.done) {
        schedule(15, tick);
        return;
      }

      const hit = step.hit;
      if (!hit) {
        setStatus("Auto-find: no progress-window candidate (retrying)...");
        dbg(JSON.stringify({ stage: "scan", ok: false, note: "Retry in 600ms" }, null, 2));
        schedule(600, runAutoFindLoop);
        return;
      }

      setStatus(`Candidate found (${hit.half}) rect=${hit.rectScore.toFixed(3)} pb=${hit.pbScore.toFixed(3)} ca=${hit.cancelScore.toFixed(3)} x=${hit.closeScore.toFixed(3)}. Confirming…`);

      confirmThenLearn(hit, (okLearned) => {
        if (!running) return;

        if (!okLearned) {
          setStatus("Confirm/learn failed (retrying)...");
          schedule(600, runAutoFindLoop);
          return;
        }

        setStatus("Verifying learned anchor…");
        if (verifySavedAnchorOnce()) return;

        setStatus("Learned anchor verify failed (retrying)...");
        schedule(600, runAutoFindLoop);
      });
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
    note: "Auto-find uses rectangle+progress-bar signature; confirms via 2-frame boundary movement before learning."
  }, null, 2));
})();
