// ProgFlash app_e.js
// Improvements:
// - Top/center bounded scan (top 62%, center 70% width)
// - Candidate shortlist per pass (top N) then sequential 2-frame confirm
// - Early-exit during scan when a very strong candidate is found
// - Scan area presets (Top/Middle/Bottom/Full) via #scanPreset + localStorage
// - Slightly looser single-frame checks, stronger 2-frame confirm
// - Anchor learned from stable top-right frame patch near Close X (avoids moving bar/text)
//
// Requires matcher.js to provide globals:
//   captureRegion(x,y,w,h) -> {width,height,data:Uint8ClampedArray}
//   findAnchor(haystackImg, needleImg, opts) -> {ok, x, y, score}
//
// index.html expected element IDs:
//   status, mode, lock, progress, debugBox, savedLock
//   startBtn, stopBtn, autoFindBtn, clearLockBtn, testFlashBtn
//   previewCanvas

(() => {
  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const statusEl = $("status");
  const modeEl = $("mode");
  const lockEl = $("lock");
  const progEl = $("progress");
  const dbgEl = $("debugBox");
  const savedLockEl = $("savedLock");

  const scanPresetEl = $("scanPreset");

  const startBtn = $("startBtn");
  const stopBtn = $("stopBtn");
  const autoFindBtn = $("autoFindBtn");
  const clearLockBtn = $("clearLockBtn");
  const testBtn = $("testFlashBtn");

  const canvas = $("previewCanvas");
  const ctx = canvas?.getContext("2d", { willReadFrequently: true });

  function setStatus(v) { if (statusEl) statusEl.textContent = v; }
  function setMode(v) { if (modeEl) modeEl.textContent = v; }
  function setLock(v) { if (lockEl) lockEl.textContent = v; }
  function setProgress(v) { if (progEl) progEl.textContent = v; }
  function dbg(v) { if (dbgEl) dbgEl.textContent = String(v); }

  const APP_VERSION = window.APP_VERSION || "0.6.7-e";
  const BUILD_ID = window.BUILD_ID || ("build-" + Date.now());

  // ---------- Storage ----------
  const LS_LOCK_POS = "progflash.lockPos";       // {x,y}
  const LS_ANCHOR = "progflash.learnedAnchor";   // {w,h,rgbaBase64}
  const LS_SCAN_PRESET = "progflash.scanPreset"; // "top" | "mid" | "bot" | "full"

  function loadJSON(key) { try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null; } catch { return null; } }
  function saveJSON(key, obj) { try { localStorage.setItem(key, JSON.stringify(obj)); } catch {} }
  function delKey(key) { try { localStorage.removeItem(key); } catch {} }

  function updateSavedLockLabel() {
    if (!savedLockEl) return;
    const lp = loadJSON(LS_LOCK_POS);
    savedLockEl.textContent = lp ? `x=${lp.x}, y=${lp.y}` : "none";
  }

  function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

  function getRsSize() {
    return { w: alt1.rsWidth || 0, h: alt1.rsHeight || 0 };
  }

  function captureRect(r) {
    const img = captureRegion(r.x, r.y, r.w, r.h);
    return { rect: r, img };
  }

  // ---------- Preview ----------
  function drawRegionPreview(regionImg, label, rectRel, strokeStyle) {
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!regionImg) {
      ctx.fillStyle = "black";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "white";
      ctx.font = "12px Arial";
      ctx.fillText(label || "no image", 12, 21);
      return;
    }

    const srcW = regionImg.width, srcH = regionImg.height;
    const imageData = new ImageData(new Uint8ClampedArray(regionImg.data), srcW, srcH);

    const cw = canvas.width, ch = canvas.height;
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
    ctx.fillRect(6, 6, Math.min(cw - 12, 760), 20);
    ctx.fillStyle = "white";
    ctx.font = "12px Arial";
    ctx.fillText(label || "", 12, 21);

    if (rectRel) {
      const fx = offX + Math.floor(rectRel.x * scale);
      const fy = offY + Math.floor(rectRel.y * scale);
      const fw = Math.floor(rectRel.w * scale);
      const fh = Math.floor(rectRel.h * scale);
      ctx.lineWidth = 2;
      ctx.strokeStyle = strokeStyle || "orange";
      ctx.strokeRect(fx, fy, fw, fh);
    }
  }

  // ---------- Bytes helpers ----------
  function bytesToBase64(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }
  function base64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8ClampedArray(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 255;
    return out;
  }

  function cropRGBA(img, x, y, w, h) {
    const out = new Uint8ClampedArray(w * h * 4);
    let k = 0;
    for (let yy = 0; yy < h; yy++) {
      for (let xx = 0; xx < w; xx++) {
        const si = ((y + yy) * img.width + (x + xx)) * 4;
        out[k++] = img.data[si];
        out[k++] = img.data[si + 1];
        out[k++] = img.data[si + 2];
        out[k++] = img.data[si + 3];
      }
    }
    return out;
  }

  function makeNeedleFromRGBA(w, h, bytes) {
    const rgba = (r, g, b, a) => (r & 255) | ((g & 255) << 8) | ((b & 255) << 16) | ((a & 255) << 24);
    return {
      width: w,
      height: h,
      data: bytes,
      getPixel(x, y) {
        if (x < 0 || y < 0 || x >= w || y >= h) return 0;
        const i = (y * w + x) * 4;
        return rgba(bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]);
      }
    };
  }

  // ---------- State ----------
  let running = false;
  let loopHandle = null;
  function stopLoop() { if (loopHandle) clearTimeout(loopHandle); loopHandle = null; }
  function schedule(ms, fn) { stopLoop(); loopHandle = setTimeout(fn, ms); }

  function setLockedAt(x, y, note) {
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
      note: note || "Locked"
    }, null, 2));

    running = false;
    stopLoop();
  }

  function clearLock() {
    delKey(LS_LOCK_POS);
    delKey(LS_ANCHOR);
    updateSavedLockLabel();
    setLock("none");
    setProgress("—");
    setStatus("Saved lock cleared");
  }

  // ---------- Detection config ----------
  const SCAN = {
    tileW: 640,
    tileH: 360,
    // default bounds (Top preset)
    yStartFrac: 0.00,
    yMaxFrac: 0.62,
    xMinFrac: 0.15,
    xMaxFrac: 0.85,
    // shortlist per pass
    shortlistN: 6,
    // Early-exit: once best combined score passes this threshold,
    // stop scanning more tiles and start confirming immediately.
    earlyExitComb: 0.92
  };

  function getScanPreset() {
    // Priority: UI select -> localStorage -> default
    const ui = scanPresetEl && scanPresetEl.value ? String(scanPresetEl.value) : null;
    const saved = (() => { try { return localStorage.getItem(LS_SCAN_PRESET); } catch { return null; } })();
    return (ui || saved || "top").toLowerCase();
  }

  function applyScanPreset(preset, rs) {
    // 4 options: top, mid, bot, full
    // NOTE: Keep a center bias for the three positional presets.
    switch (preset) {
      case "mid":
      case "middle":
        return { yStartFrac: 0.18, yMaxFrac: 0.82, xMinFrac: 0.12, xMaxFrac: 0.88 };
      case "bot":
      case "bottom":
        return { yStartFrac: 0.38, yMaxFrac: 1.00, xMinFrac: 0.12, xMaxFrac: 0.88 };
      case "full":
        return { yStartFrac: 0.00, yMaxFrac: 1.00, xMinFrac: 0.00, xMaxFrac: 1.00 };
      case "top":
      default:
        return { yStartFrac: 0.00, yMaxFrac: 0.62, xMinFrac: 0.15, xMaxFrac: 0.85 };
    }
  }

  const RECT = {
    ds: 4,
    edgeThr: 26,
    scanStep: 3,
    ring: 14,
    // Window-like sizes
    sizes: [
      { w: 470, h: 190 },
      { w: 450, h: 180 },
      { w: 430, h: 175 },
      { w: 410, h: 165 },
      { w: 390, h: 160 },
      { w: 370, h: 150 },
      { w: 350, h: 140 }
    ],
    minRectScore: 0.008
  };

  const PB = {
    // progress-bar signature (single frame)
    minScore: 0.16,     // looser than before
    minDiff: 18,
    minWidthFrac: 0.55,
    yBandTopFrac: 0.30,
    yBandBotFrac: 0.70,
    rowStep: 2,
    xStep: 2
  };

  const CANCEL = {
    // warm/orange button detector
    minWarmFrac: 0.10,
    minBandWFrac: 0.45,
    minBandH: 12,
    yTopFrac: 0.62,
    yBotFrac: 0.92
  };

  const CLOSEX = {
    // edge-only "X" in top-right
    box: 26,
    inset: 6,
    minDiagHits: 10
  };

  const CONFIRM = {
    delayMs: 200,
    minBoundaryMovePx: 2,
    // if movement low, accept only if pbScore is very strong AND cancel/close found in both frames
    pbStrong: 0.32
  };

  const VERIFY = {
    pad: 320,
    step: 2,
    tolerance: 55,
    minAccept: 0.72
  };

  // ---------- Edge integral ----------
  function toGray(r, g, b) { return (r * 77 + g * 150 + b * 29) >> 8; }

  function buildEdgeIntegral(img, ds, edgeThr) {
    const W = Math.floor(img.width / ds);
    const H = Math.floor(img.height / ds);
    const gray = new Uint8Array(W * H);

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const sx = x * ds, sy = y * ds;
        const i = (sy * img.width + sx) * 4;
        gray[y * W + x] = toGray(img.data[i], img.data[i + 1], img.data[i + 2]);
      }
    }

    const edge = new Uint8Array(W * H);
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const c = gray[y * W + x];
        const dx = Math.abs(c - gray[y * W + (x + 1)]);
        const dy = Math.abs(c - gray[(y + 1) * W + x]);
        edge[y * W + x] = (dx + dy >= edgeThr) ? 1 : 0;
      }
    }

    const IW = W + 1;
    const ii = new Uint32Array((W + 1) * (H + 1));
    for (let y = 1; y <= H; y++) {
      let rowsum = 0;
      const rowOff = y * IW;
      const prevOff = (y - 1) * IW;
      const eOff = (y - 1) * W;
      for (let x = 1; x <= W; x++) {
        rowsum += edge[eOff + (x - 1)];
        ii[rowOff + x] = ii[prevOff + x] + rowsum;
      }
    }
    return { W, H, ii, ds };
  }

  function rectSum(ii, IW, x, y, w, h) {
    const x2 = x + w, y2 = y + h;
    return ii[y2 * IW + x2] - ii[y2 * IW + x] - ii[y * IW + x2] + ii[y * IW + x];
  }

  function scoreWindow(iiObj, x, y, w, h, ring) {
    const IW = iiObj.W + 1;
    const inside = rectSum(iiObj.ii, IW, x, y, w, h);
    const insideD = inside / Math.max(1, w * h);

    const rx = clamp(x - ring, 0, iiObj.W - 1);
    const ry = clamp(y - ring, 0, iiObj.H - 1);
    const rx2 = clamp(x + w + ring, 0, iiObj.W);
    const ry2 = clamp(y + h + ring, 0, iiObj.H);
    const rw = Math.max(1, rx2 - rx);
    const rh = Math.max(1, ry2 - ry);

    const outer = rectSum(iiObj.ii, IW, rx, ry, rw, rh);
    const outerD = outer / Math.max(1, rw * rh);

    return insideD - outerD * 0.75;
  }

  // ---------- Feature tests inside a rect ----------
  function progressBarSignature(img, rect) {
    const x0 = rect.x | 0, y0 = rect.y | 0, w = rect.w | 0, h = rect.h | 0;
    const minBandW = Math.floor(w * PB.minWidthFrac);

    const yStart = y0 + Math.floor(h * PB.yBandTopFrac);
    const yEnd = y0 + Math.floor(h * PB.yBandBotFrac);

    let bestScore = 0;
    let bestBoundaryX = -1;

    // Evaluate multiple rows; look for strongest left/right step.
    for (let y = yStart; y < yEnd; y += PB.rowStep) {
      const yy = clamp(y, 0, img.height - 1);
      const row = new Uint16Array(w);

      // luminance samples
      for (let xx = 0; xx < w; xx += PB.xStep) {
        const sx = x0 + xx;
        if (sx < 0 || sx >= img.width) continue;
        const i = (yy * img.width + sx) * 4;
        const g = toGray(img.data[i], img.data[i + 1], img.data[i + 2]);
        row[xx] = g;
      }

      // find best boundary by comparing left/right means
      const win = Math.max(minBandW, Math.floor(w * 0.65));
      const leftN = Math.max(8, Math.floor(win * 0.25));
      const rightN = leftN;

      for (let bx = Math.floor(w * 0.25); bx < Math.floor(w * 0.85); bx += PB.xStep) {
        const l0 = clamp(bx - leftN, 0, w - 1);
        const l1 = clamp(bx - 1, 0, w - 1);
        const r0 = clamp(bx + 1, 0, w - 1);
        const r1 = clamp(bx + rightN, 0, w - 1);

        // compute means (sparse steps)
        let ls = 0, ln = 0;
        for (let x = l0; x <= l1; x += PB.xStep) { ls += row[x] || 0; ln++; }
        let rs = 0, rn = 0;
        for (let x = r0; x <= r1; x += PB.xStep) { rs += row[x] || 0; rn++; }
        if (!ln || !rn) continue;

        const lm = ls / ln, rm = rs / rn;
        const diff = Math.abs(lm - rm);

        if (diff < PB.minDiff) continue;

        // normalize by 255 and slight preference for boundaries away from edges
        const centerBias = 1.0 - Math.abs((bx / w) - 0.55) * 0.8;
        const sc = (diff / 255) * centerBias;

        if (sc > bestScore) {
          bestScore = sc;
          bestBoundaryX = bx;
        }
      }
    }

    return { ok: bestScore >= PB.minScore, score: bestScore, boundaryX: bestBoundaryX };
  }

  function cancelButtonSignature(img, rect) {
    const x0 = rect.x | 0, y0 = rect.y | 0, w = rect.w | 0, h = rect.h | 0;

    const yStart = y0 + Math.floor(h * CANCEL.yTopFrac);
    const yEnd = y0 + Math.floor(h * CANCEL.yBotFrac);
    const bandH = Math.max(CANCEL.minBandH, Math.floor(h * 0.18));
    const bandW = Math.max(Math.floor(w * CANCEL.minBandWFrac), Math.floor(w * 0.40));

    // Search a few horizontal bands near bottom; look for warm pixels dominance.
    let best = 0;
    for (let yy = yStart; yy < Math.min(yEnd, y0 + h - bandH); yy += 3) {
      const y1 = yy + bandH;
      const cxStart = x0 + Math.floor((w - bandW) * 0.2);
      const cxEnd = x0 + Math.floor((w - bandW) * 0.8);

      for (let xx = cxStart; xx <= cxEnd; xx += 6) {
        let warm = 0, total = 0;
        for (let y = yy; y < y1; y += 2) {
          const sy = y;
          if (sy < 0 || sy >= img.height) continue;
          for (let x = xx; x < xx + bandW; x += 2) {
            const sx = x;
            if (sx < 0 || sx >= img.width) continue;
            const i = (sy * img.width + sx) * 4;
            const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
            // "warm/orange" heuristic: red high, green mid, blue low
            if (r > 120 && g > 60 && b < 90 && (r - b) > 60) warm++;
            total++;
          }
        }
        if (!total) continue;
        const frac = warm / total;
        if (frac > best) best = frac;
      }
    }

    return { ok: best >= CANCEL.minWarmFrac, score: best };
  }

  function closeXSignature(img, rect) {
    const x0 = rect.x | 0, y0 = rect.y | 0, w = rect.w | 0;
    const box = CLOSEX.box;
    const inset = CLOSEX.inset;

    const rx = x0 + w - box - inset;
    const ry = y0 + inset;

    let hits1 = 0, hits2 = 0, samples = 0;

    for (let t = 0; t < box; t++) {
      const xA = rx + t;
      const yA = ry + t;
      const xB = rx + t;
      const yB = ry + (box - 1 - t);

      if (xA < 1 || xA >= img.width - 1 || yA < 1 || yA >= img.height - 1) continue;
      if (xB < 1 || xB >= img.width - 1 || yB < 1 || yB >= img.height - 1) continue;

      const iA = (yA * img.width + xA) * 4;
      const iAr = (yA * img.width + (xA + 1)) * 4;
      const iAd = ((yA + 1) * img.width + xA) * 4;

      const a = toGray(img.data[iA], img.data[iA + 1], img.data[iA + 2]);
      const ax = toGray(img.data[iAr], img.data[iAr + 1], img.data[iAr + 2]);
      const ay = toGray(img.data[iAd], img.data[iAd + 1], img.data[iAd + 2]);
      const gradA = Math.abs(a - ax) + Math.abs(a - ay);

      const iB0 = (yB * img.width + xB) * 4;
      const iBr = (yB * img.width + (xB + 1)) * 4;
      const iBd = ((yB + 1) * img.width + xB) * 4;

      const b0 = toGray(img.data[iB0], img.data[iB0 + 1], img.data[iB0 + 2]);
      const bx = toGray(img.data[iBr], img.data[iBr + 1], img.data[iBr + 2]);
      const by = toGray(img.data[iBd], img.data[iBd + 1], img.data[iBd + 2]);
      const gradB = Math.abs(b0 - bx) + Math.abs(b0 - by);

      if (gradA > 40) hits1++;
      if (gradB > 40) hits2++;
      samples++;
    }

    const ok = (hits1 >= CLOSEX.minDiagHits && hits2 >= CLOSEX.minDiagHits);
    const score = samples ? ((hits1 + hits2) / (2 * samples)) : 0;
    return { ok, score };
  }

  // ---------- Candidate evaluation ----------
  function evaluateRectCandidate(img, iiObj, rx, ry, rw, rh) {
    const ring = Math.max(2, Math.floor(RECT.ring / iiObj.ds));
    const rectScore = scoreWindow(iiObj, rx, ry, rw, rh, ring);

    if (rectScore < RECT.minRectScore) return null;

    const rect = { x: rx * iiObj.ds, y: ry * iiObj.ds, w: rw * iiObj.ds, h: rh * iiObj.ds };

    const pb = progressBarSignature(img, rect);
    if (!pb.ok) return null;

    const cancel = cancelButtonSignature(img, rect);
    const closex = closeXSignature(img, rect);

    if (!(cancel.ok || closex.ok)) return null;

    // Combined score: pb dominates, then cancel/close, then rectScore
    const comb = (pb.score * 1.6) + (rectScore * 0.8) + (cancel.ok ? (0.18 + cancel.score * 0.6) : 0) + (closex.ok ? (0.10 + closex.score * 0.5) : 0);

    return {
      rectScore,
      pbScore: pb.score,
      pbBoundaryX: pb.boundaryX,
      cancelScore: cancel.score,
      cancelOk: cancel.ok,
      closeOk: closex.ok,
      closeScore: closex.score,
      comb,
      rect
    };
  }

  function findTileCandidates(img) {
    const iiObj = buildEdgeIntegral(img, RECT.ds, RECT.edgeThr);
    const { W, H, ds } = iiObj;

    const sizes = RECT.sizes.map(s => ({
      w: Math.max(14, Math.floor(s.w / ds)),
      h: Math.max(12, Math.floor(s.h / ds))
    }));

    // Keep a small list per tile
    const tileKeep = 4;
    const best = [];

    function pushCand(c) {
      best.push(c);
      best.sort((a, b) => b.comb - a.comb);
      if (best.length > tileKeep) best.length = tileKeep;
    }

    for (const sz of sizes) {
      const ww = sz.w, hh = sz.h;
      if (ww >= W || hh >= H) continue;

      for (let y = 0; y <= H - hh; y += RECT.scanStep) {
        for (let x = 0; x <= W - ww; x += RECT.scanStep) {
          const c = evaluateRectCandidate(img, iiObj, x, y, ww, hh);
          if (c) pushCand(c);
        }
      }
    }
    return best;
  }

  // ---------- Scan pass (incremental tiles) ----------
  let scan = null;

  function initScan() {
    const rs = getRsSize();
    if (!rs.w || !rs.h) return false;

    const preset = getScanPreset();
    const bounds = applyScanPreset(preset, rs);

    const yStart = Math.floor(rs.h * bounds.yStartFrac);
    const yMax = Math.floor(rs.h * bounds.yMaxFrac);
    const xMin = Math.floor(rs.w * bounds.xMinFrac);
    const xMax = Math.floor(rs.w * bounds.xMaxFrac);

    // Clamp
    const yStartC = clamp(yStart, 0, rs.h - 1);
    const yMaxC = clamp(yMax, yStartC + 1, rs.h);
    const xMinC = clamp(xMin, 0, rs.w - 1);
    const xMaxC = clamp(xMax, xMinC + 1, rs.w);

    scan = {
      rs,
      preset,
      xMin: xMinC,
      xMax: xMaxC,
      yStart: yStartC,
      yMax: yMaxC,
      tx: xMinC,
      ty: yStartC,
      tileIndex: 0,
      cands: [],
      earlyExit: false
    };
    return true;
  }

  function scanStepOneTile() {
    const rs = scan.rs;

    if (scan.ty >= scan.yMax) return { done: true, early: !!scan.earlyExit };

    if (scan.tx >= scan.xMax) {
      scan.tx = scan.xMin;
      scan.ty += SCAN.tileH;
      return { done: false };
    }

    const tx = scan.tx;
    const ty = scan.ty;
    scan.tx += SCAN.tileW;
    scan.tileIndex++;

    const w = Math.min(SCAN.tileW, scan.xMax - tx);
    const h = Math.min(SCAN.tileH, scan.yMax - ty);
    const cap = captureRect({ x: tx, y: ty, w, h });

    if (!cap.img) {
      drawRegionPreview(null, `CAPTURE FAIL tile#${scan.tileIndex}`, null);
      return { done: false };
    }

    // Find candidates in this tile
    const tileCands = findTileCandidates(cap.img);

    // Convert to absolute coords and merge into global list
    for (const c of tileCands) {
      const abs = {
        ...c,
        absRect: { x: tx + c.rect.x, y: ty + c.rect.y, w: c.rect.w, h: c.rect.h }
      };
      scan.cands.push(abs);
    }

    // Keep global shortlist a bit larger during scan, prune later
    scan.cands.sort((a, b) => b.comb - a.comb);
    if (scan.cands.length > 20) scan.cands.length = 20;

    // Early exit: if we already have a very strong candidate, stop scanning more tiles.
    const bestNow = scan.cands[0];
    if (bestNow && bestNow.comb >= SCAN.earlyExitComb) {
      scan.ty = scan.yMax; // forces done on next tick
      scan.earlyExit = { tile: scan.tileIndex, comb: bestNow.comb };
    }

    // Preview best candidate so far
    const best = scan.cands[0];
    if (best) {
      drawRegionPreview(
        cap.img,
        `SCAN tile#${scan.tileIndex} best comb=${best.comb.toFixed(3)} pb=${best.pbScore.toFixed(3)} cancel=${best.cancelOk ? best.cancelScore.toFixed(2) : "no"} close=${best.closeOk ? best.closeScore.toFixed(2) : "no"}`,
        // show best candidate if it's within this tile; else show none
        (best.absRect.x >= tx && best.absRect.x < tx + w && best.absRect.y >= ty && best.absRect.y < ty + h)
          ? { x: best.absRect.x - tx, y: best.absRect.y - ty, w: best.absRect.w, h: best.absRect.h }
          : null,
        "orange"
      );
    } else {
      drawRegionPreview(cap.img, `SCAN tile#${scan.tileIndex} (no candidates)`, null);
    }

    setProgress(`tile ${scan.tileIndex}`);

    // If early-exit was set above, finish immediately; the caller will start confirming.
    if (scan.earlyExit) {
      setStatus(`Early exit: strong candidate comb=${bestNow.comb.toFixed(3)} (preset ${scan.preset})`);
      return { done: true, early: true };
    }

    return { done: false };
  }

  // ---------- Two-frame confirm ----------
  function featurePack(img, absRect) {
    const rectRel = { x: 0, y: 0, w: img.width, h: img.height };
    // Here img is already a capture of rect; so rectRel is full.
    const pb = progressBarSignature(img, rectRel);
    const cancel = cancelButtonSignature(img, rectRel);
    const closex = closeXSignature(img, rectRel);
    return { pb, cancel, closex };
  }

  function confirmCandidate(absRect, onDone) {
    // Capture 1
    const cap1 = captureRect(absRect);
    if (!cap1.img) return onDone(false, { why: "cap1 fail" });

    const f1 = featurePack(cap1.img, absRect);
    const ok1 = f1.pb.ok && (f1.cancel.ok || f1.closex.ok);
    if (!ok1) return onDone(false, { why: "features1 fail", f1 });

    // Capture 2 after delay
    schedule(CONFIRM.delayMs, () => {
      const cap2 = captureRect(absRect);
      if (!cap2.img) return onDone(false, { why: "cap2 fail" });

      const f2 = featurePack(cap2.img, absRect);
      const ok2 = f2.pb.ok && (f2.cancel.ok || f2.closex.ok);
      if (!ok2) return onDone(false, { why: "features2 fail", f1, f2 });

      const b1 = f1.pb.boundaryX;
      const b2 = f2.pb.boundaryX;
      const move = (b1 >= 0 && b2 >= 0) ? Math.abs(b2 - b1) : 0;

      const accept = (move >= CONFIRM.minBoundaryMovePx) || (f1.pb.score >= CONFIRM.pbStrong && f2.pb.score >= CONFIRM.pbStrong);

      onDone(accept, { move, f1, f2 });
    });
  }

  // ---------- Learn stable anchor ----------
  function learnAnchorFromAbsRect(absRect) {
    // Capture the dialog rect and take a stable patch near top-right frame (left of X).
    const cap = captureRect(absRect);
    if (!cap.img) return false;

    const padX = 96, padY = 10;
    const patchW = 86, patchH = 28;

    let px = cap.img.width - padX;
    let py = padY;
    px = clamp(px, 0, Math.max(0, cap.img.width - patchW));
    py = clamp(py, 0, Math.max(0, cap.img.height - patchH));

    const bytes = cropRGBA(cap.img, px, py, patchW, patchH);

    saveJSON(LS_ANCHOR, { w: patchW, h: patchH, rgbaBase64: bytesToBase64(bytes) });

    // Lock pos should be absolute coordinates of anchor patch top-left on screen:
    const ax = absRect.x + px;
    const ay = absRect.y + py;
    saveJSON(LS_LOCK_POS, { x: ax, y: ay });
    updateSavedLockLabel();

    return true;
  }

  // ---------- Verify saved anchor once ----------
  function verifySavedAnchorOnce() {
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

  // ---------- Auto-find main ----------
  function runAutoFind() {
    if (!running) return;

    setMode("Running");
    setStatus("Auto-finding (bounded scan + shortlist)…");
    setLock("none");
    setProgress("—");

    if (!initScan()) {
      setStatus("Auto-find: bad RS dims");
      schedule(600, runAutoFind);
      return;
    }

    const scanTick = () => {
      if (!running) return;

      const step = scanStepOneTile();
      if (!step.done) {
        schedule(12, scanTick);
        return;
      }

      // Scan pass finished: prune shortlist to N
      const list = (scan.cands || []).slice(0).sort((a, b) => b.comb - a.comb).slice(0, SCAN.shortlistN);
      if (!list.length) {
        setStatus("Auto-find: no candidates (retry)...");
        dbg(JSON.stringify({ stage: "scan", ok: false, note: "No candidates in bounded region." }, null, 2));
        schedule(450, runAutoFind);
        return;
      }

      let idx = 0;

      const tryNext = () => {
        if (!running) return;

        if (idx >= list.length) {
          setStatus("Auto-find: shortlist failed (retry)...");
          dbg(JSON.stringify({ stage: "confirm", ok: false, note: "All shortlist candidates failed 2-frame confirm." }, null, 2));
          schedule(450, runAutoFind);
          return;
        }

        const c = list[idx++];
        const absRect = c.absRect;

        setStatus(`Confirming candidate ${idx}/${list.length} comb=${c.comb.toFixed(3)} pb=${c.pbScore.toFixed(3)}…`);
        setProgress(`confirm ${idx}/${list.length}`);

        confirmCandidate(absRect, (ok, details) => {
          if (!running) return;
          if (!ok) {
            dbg(JSON.stringify({ stage: "confirm", ok: false, idx: idx - 1, comb: c.comb, details }, null, 2));
            // try next immediately
            schedule(0, tryNext);
            return;
          }

          // Learn anchor and verify immediately
          const learned = learnAnchorFromAbsRect(absRect);
          if (!learned) {
            dbg(JSON.stringify({ stage: "learn", ok: false, note: "Learn anchor failed" }, null, 2));
            schedule(0, tryNext);
            return;
          }

          setStatus("Verifying learned anchor…");
          if (verifySavedAnchorOnce()) return;

          dbg(JSON.stringify({ stage: "verify", ok: false, note: "Verify failed after learn", details }, null, 2));
          schedule(0, tryNext);
        });
      };

      schedule(0, tryNext);
    };

    schedule(0, scanTick);
  }

  async function start() {
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

    // clear any partial state
    runAutoFind();
  }

  function stop() {
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
    runAutoFind();
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
    scanPreset: (() => { try { return localStorage.getItem(LS_SCAN_PRESET) || "top"; } catch { return "top"; } })(),
    scanPresets: { top: "top 62% + center 70%", mid: "middle", bot: "bottom", full: "full screen" },
    earlyExitComb: SCAN.earlyExitComb,
    shortlist: SCAN.shortlistN,
    note: "app_e: scan presets + early-exit + shortlist + stronger 2-frame confirm; anchor from stable top-right frame patch."
  }, null, 2));
})();
