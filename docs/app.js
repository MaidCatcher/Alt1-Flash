// ProgFlash app_final.js
// Final: capture loop restored + rectangle fallback + triple-anchor (A+B+C) fast lock + live overlay boxes
// Depends on matcher.js globals:
//   captureRegion(x,y,w,h)   -> returns wrapped ImageData-like {width,height,data,getPixel(x,y)}
//   findAnchor(haystack, needle, opts)
//
// UI elements expected (ids):
//   startBtn, stopBtn, autoFindBtn, clearLockBtn, testFlashBtn
//   status, mode, lock, progress, debugBox
//   previewCanvas
// Optional:
//   scanAreaSelect (values: "top","middle","bottom","full")

(() => {
  // ---------------- DOM ----------------
  const $ = (id) => document.getElementById(id);

  const statusEl = $("status");
  const modeEl = $("mode");
  const lockEl = $("lock");
  const progEl = $("progress");
  const dbgEl = $("debugBox");

  const startBtn = $("startBtn");
  const stopBtn = $("stopBtn");
  const autoFindBtn = $("autoFindBtn");
  const clearLockBtn = $("clearLockBtn");
  const testFlashBtn = $("testFlashBtn");

  const savedLockEl = $("savedLock");
  const verEl = $("appVersion");
  const buildEl = $("appBuild");
  const loadedAtEl = $("loadedAt");
  const scanAreaSelect = $("scanAreaSelect") || document.querySelector("select"); // optional (fallback to first select)

  const canvas = $("previewCanvas");
  const ctx = canvas ? canvas.getContext("2d", { willReadFrequently: true }) : null;

  const APP_VERSION = "0.6.21";
  const BUILD_ID = "final-" + Date.now();

  function setStatus(v) { if (statusEl) statusEl.textContent = v; }
  function setMode(v) { if (modeEl) modeEl.textContent = v; }
  function setLock(v) { if (lockEl) lockEl.textContent = v; }
  function setProgress(v) { if (progEl) progEl.textContent = v; }
  function dbg(v) {
    if (!dbgEl) return;
    dbgEl.textContent = typeof v === "string" ? v : JSON.stringify(v, null, 2);
  }

  // ---------------- Storage ----------------
  const LS_LOCK = "progflash.lockPos";              // {x,y}
  const LS_MULTI = "progflash.multiAnchorABC";      // anchors + offsets
  const LS_SCANAREA = "progflash.scanArea";         // "top|middle|bottom|full"
  const LS_DIALOG = "progflash.dialogRect";         // {x,y,w,h} dialog bounds

  function save(key, obj) { localStorage.setItem(key, JSON.stringify(obj)); }
  function load(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } }
  function del(key) { localStorage.removeItem(key); }

  function updateSavedLockLabel() {
    if (!savedLockEl) return;
    const p = load(LS_LOCK);
    savedLockEl.textContent = p ? `x=${p.x},y=${p.y}` : "none";
  }

  // ---------------- Utils ----------------
  function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
  function rgba(r, g, b, a) { return (r & 255) | ((g & 255) << 8) | ((b & 255) << 16) | ((a & 255) << 24); 
  // ---------------- Screen overlay (Alt1) ----------------
  // Draws a green rectangle on the RuneScape client (not just the preview).
  // Uses whichever overlay API is available.
  function overlayRectOnScreen(x, y, w, h, ms = 1200) {
    try {
      if (!window.alt1) return false;
      // Some Alt1 builds expose different names; try a few safely.
      const colorNum = 0x00ff00; // green
      if (typeof alt1.overLayRect === "function") {
        // Common signature: (x,y,w,h,color,thickness,ms)
        alt1.overLayRect(x, y, w, h, colorNum, 2, ms);
        return true;
      }
      if (typeof alt1.overLayRectEx === "function") {
        alt1.overLayRectEx(x, y, w, h, colorNum, 2, ms);
        return true;
      }
      if (typeof alt1.overlayRect === "function") {
        alt1.overlayRect(x, y, w, h, colorNum, 2, ms);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  function saveDialogRect(r) {
    if (!r) return;
    save(LS_DIALOG, { x: (r.x|0), y: (r.y|0), w: (r.w|0), h: (r.h|0) });
  }
  function loadDialogRect() {
    const r = load(LS_DIALOG);
    return r && typeof r.x==="number" ? r : null;
  }
}

  function bytesToB64(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }
  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8ClampedArray(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 255;
    return out;
  }

  function makeNeedle(w, h, bytes) {
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

  function getRsSize() {
    return { w: alt1.rsWidth || 0, h: alt1.rsHeight || 0 };
  }

  // ---------------- Preview drawing ----------------
  function drawImageScaled(img, label, overlayRects) {
    if (!ctx || !canvas || !img) return;

    // Convert to ImageData
    const id = new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);

    // Render to temp canvas
    const tmp = document.createElement("canvas");
    tmp.width = img.width;
    tmp.height = img.height;
    const tctx = tmp.getContext("2d", { willReadFrequently: true });
    tctx.putImageData(id, 0, 0);

    const cw = canvas.width, ch = canvas.height;
    const scale = Math.min(cw / img.width, ch / img.height);
    const dw = Math.floor(img.width * scale);
    const dh = Math.floor(img.height * scale);
    const ox = Math.floor((cw - dw) / 2);
    const oy = Math.floor((ch - dh) / 2);

    ctx.clearRect(0, 0, cw, ch);
    ctx.drawImage(tmp, 0, 0, img.width, img.height, ox, oy, dw, dh);

    // Label
    if (label) {
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      ctx.fillRect(6, 6, Math.min(cw - 12, 900), 20);
      ctx.fillStyle = "white";
      ctx.font = "12px Arial";
      ctx.fillText(label, 12, 21);
    }

    // Overlays (rects in img coords)
    if (overlayRects && overlayRects.length) {
      ctx.lineWidth = 2;
      overlayRects.forEach(r => {
        const fx = ox + Math.floor(r.x * scale);
        const fy = oy + Math.floor(r.y * scale);
        const fw = Math.floor(r.w * scale);
        const fh = Math.floor(r.h * scale);
        ctx.strokeStyle = r.color || "lime";
        ctx.strokeRect(fx, fy, fw, fh);
        if (r.label) {
          ctx.fillStyle = r.color || "lime";
          ctx.font = "12px Arial";
          ctx.fillText(r.label, fx + 3, fy - 4);
        }
      });
    }
  }

  // ---------------- Scan area ----------------
  function getScanAreaConfig() {
    const rs = getRsSize();
    const v = (scanAreaSelect && scanAreaSelect.value) || load(LS_SCANAREA) || "top";
    if (scanAreaSelect && scanAreaSelect.value !== v) scanAreaSelect.value = v;

    // Persist on change
    if (scanAreaSelect && !scanAreaSelect._wired) {
      scanAreaSelect._wired = true;
      scanAreaSelect.addEventListener("change", () => save(LS_SCANAREA, scanAreaSelect.value));
    }

    // x bounds always central-ish to reduce noise
    const xMinFrac = 0.12, xMaxFrac = 0.88;
    let y0 = 0, y1 = rs.h;

    if (v === "top") { y0 = 0; y1 = Math.floor(rs.h * 0.62); }
    else if (v === "middle") { y0 = Math.floor(rs.h * 0.20); y1 = Math.floor(rs.h * 0.85); }
    else if (v === "bottom") { y0 = Math.floor(rs.h * 0.38); y1 = rs.h; }
    else { y0 = 0; y1 = rs.h; } // full

    return {
      name: v,
      x0: Math.floor(rs.w * xMinFrac),
      x1: Math.floor(rs.w * xMaxFrac),
      y0, y1
    };
  }

  // ---------------- Crafting dialog features ----------------
  // Progress-bar boundary detector inside a rect (edge/lightness step + horizontal band)
  const PB = {
    bandMinH: 6,
    bandMaxH: 18,
    minWidthFrac: 0.60,
    minScore: 0.16
  };

  function toGray(r, g, b) {
    return (r * 77 + g * 150 + b * 29) >> 8;
  }

  function scoreProgressBar(img) {
    // Tight, dialog-relative progress bar locator.
    // Restricts search to a fixed Y band and scores "bar-likeness" (two relatively-uniform segments with a single boundary).
    const w = img.width, h = img.height;

    // Crafting dialog bar sits in a narrow vertical band; keep a little slack for scaling.
    const yTop = Math.floor(h * 0.54);
    const yBot = Math.floor(h * 0.64);

    // Helper: band-averaged grayscale at x
    function bandGray(x, y) {
      let gsum = 0, cnt = 0;
      for (let yy = -2; yy <= 2; yy++) {
        const ry = clamp(y + yy, 0, h - 1);
        const i = (ry * w + x) * 4;
        gsum += toGray(img.data[i], img.data[i + 1], img.data[i + 2]);
        cnt++;
      }
      return (gsum / cnt) | 0;
    }

    let best = { score: 0, y: 0, xEdge: 0 };

    // Iterate candidate rows in the band
    for (let y = yTop; y <= yBot; y++) {
      // Sample grayscale across the row (step 2 for speed)
      const step = 2;
      const xs = [];
      const gs = [];
      for (let x = 2; x < w - 2; x += step) {
        xs.push(x);
        gs.push(bandGray(x, y));
      }
      if (gs.length < 20) continue;

      // Find strongest single boundary (max gradient)
      let maxGrad = 0;
      let maxIdx = 0;
      for (let i = 1; i < gs.length; i++) {
        const grad = Math.abs(gs[i] - gs[i - 1]);
        if (grad > maxGrad) { maxGrad = grad; maxIdx = i; }
      }

      const xEdge = xs[maxIdx];

      // Reject if boundary too close to ends (not a fill boundary)
      const minFrac = 0.18;
      const maxFrac = 0.90;
      const frac = xEdge / Math.max(1, (w - 1));
      if (frac < minFrac || frac > maxFrac) continue;

      // "Uniformity" of left and right segments: average adjacent abs-diff normalized (lower is better).
      function roughness(i0, i1) {
        if (i1 - i0 < 3) return 1;
        let s = 0, c = 0;
        for (let i = i0 + 1; i < i1; i++) {
          s += Math.abs(gs[i] - gs[i - 1]);
          c++;
        }
        return c ? (s / c) / 255 : 1;
      }

      const rL = roughness(0, maxIdx);
      const rR = roughness(maxIdx, gs.length);

      // Step strength normalized
      const stepScore = maxGrad / 255;

      // Penalize noisy segments heavily; bar segments should be fairly flat.
      const uniformScore = clamp(1.0 - (rL * 2.2 + rR * 2.2) / 2.0, 0, 1);

      // Additional requirement: boundary spans a meaningful portion of width (bar-like)
      const widthScore = clamp((frac - 0.15) / 0.35, 0, 1);

      const score = stepScore * 0.65 + uniformScore * 0.25 + widthScore * 0.10;

      if (score > best.score) best = { score, y, xEdge };
    }

    return best;
  }

  // Cancel button detector (warm/orange band) – mild, acts as boost not hard requirement
  function scoreCancelBand(img) {
    const w = img.width, h = img.height;
    const y0 = Math.floor(h * 0.70);
    const y1 = Math.floor(h * 0.92);
    let best = 0;

    for (let y = y0; y < y1; y++) {
      let warm = 0, total = 0;
      for (let x = 0; x < w; x += 2) {
        const i = (y * w + x) * 4;
        const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
        // warm-ish heuristic
        if (r > 110 && g > 60 && b < 80 && r > g && g > b) warm++;
        total++;
      }
      const frac = total ? warm / total : 0;
      if (frac > best) best = frac;
    }
    return best; // 0..1
  }

  // Close X detector (high-contrast in top-right small patch)
  function scoreCloseX(img) {
    const w = img.width, h = img.height;
    const pw = Math.min(34, w), ph = Math.min(34, h);
    const x0 = w - pw, y0 = 0;

    let edges = 0, total = 0;
    for (let y = y0 + 1; y < y0 + ph - 1; y++) {
      for (let x = x0 + 1; x < x0 + pw - 1; x++) {
        const i = (y * w + x) * 4;
        const c = toGray(img.data[i], img.data[i + 1], img.data[i + 2]);
        const ir = (y * w + (x + 1)) * 4;
        const id = ((y + 1) * w + x) * 4;
        const dx = Math.abs(c - toGray(img.data[ir], img.data[ir + 1], img.data[ir + 2]));
        const dy = Math.abs(c - toGray(img.data[id], img.data[id + 1], img.data[id + 2]));
        if (dx + dy > 70) edges++;
        total++;
      }
    }
    return total ? edges / total : 0;
  }

  // ---------------- Rectangle scanning (fallback) ----------------
  // We scan tiles and inside each tile scan for fixed dialog sizes using quick progress score.
  const TILE = { w: 640, h: 360 };
  const DIALOG_SIZES = [
    { w: 520, h: 200 },
    { w: 500, h: 190 },
    { w: 480, h: 180 }
  ];

  const SCAN = {
    step: 12,            // window step inside tile
    shortlist: 4,
    earlyExitComb: 0.88,
    confirmDelayMs: 200
  };

  let running = false;
  let scanActive = false;
  let scanTimer = null;

  function stopTimers() {
    if (scanTimer) { clearTimeout(scanTimer); scanTimer = null; }
  }
  function schedule(ms, fn) {
    stopTimers();
    scanTimer = setTimeout(fn, ms);
  }

  function captureTile(tx, ty, tw, th) {
    const img = captureRegion(tx, ty, tw, th);
    if (img) {
      img._absX = tx;
      img._absY = ty;
    }
    return img;
  }

  function scoreDialogCandidate(tileImg, rx, ry, rw, rh) {
    // crop a small downsample region for scoring
    const sub = {
      width: rw,
      height: rh,
      data: cropRGBA(tileImg, rx, ry, rw, rh)
    };

    const pb = scoreProgressBar(sub);          // 0..1
    const cancel = scoreCancelBand(sub);       // 0..1
    const close = scoreCloseX(sub);            // 0..1

    // combine: pb primary, close/cancel add confidence
    const comb = pb.score * 0.75 + Math.max(cancel * 0.6, close * 0.9) * 0.25;

    return { pb: pb.score, cancel, close, comb };
  }

  function scanTileForCandidates(tileImg) {
    const out = [];
    const tw = tileImg.width, th = tileImg.height;

    for (const sz of DIALOG_SIZES) {
      const rw = Math.min(sz.w, tw);
      const rh = Math.min(sz.h, th);
      if (rw < 320 || rh < 140) continue;

      const step = SCAN.step;
      for (let y = 0; y <= th - rh; y += step) {
        for (let x = 0; x <= tw - rw; x += step) {
          const s = scoreDialogCandidate(tileImg, x, y, rw, rh);
          if (s.pb < PB.minScore) continue;

          out.push({
            absRect: { x: tileImg._absX + x, y: tileImg._absY + y, w: rw, h: rh },
            relRect: { x, y, w: rw, h: rh },
            ...s
          });

          if (s.comb >= SCAN.earlyExitComb) {
            return { candidates: out, early: out[out.length - 1] };
          }
        }
      }
    }
    return { candidates: out, early: null };
  }

  function confirmCandidate(c) {
    // confirm after a short delay using another capture of same rect
    const r = c.absRect;
    const img1 = captureRegion(r.x, r.y, r.w, r.h);
    if (!img1) return { ok: false };

    const pb1 = scoreProgressBar(img1);

    return new Promise(resolve => {
      setTimeout(() => {
        const img2 = captureRegion(r.x, r.y, r.w, r.h);
        if (!img2) { resolve({ ok: false }); return; }

        const pb2 = scoreProgressBar(img2);
        const moved = Math.abs(pb2.xEdge - pb1.xEdge);

        const cancel2 = scoreCancelBand(img2);
        const close2 = scoreCloseX(img2);

        const ok = (pb2.score >= PB.minScore) && (moved >= 2 || pb2.score >= 0.28) && (cancel2 >= 0.08 || close2 >= 0.10);

        resolve({ ok, pb: pb2.score, moved, cancel: cancel2, close: close2, img2 });
      }, SCAN.confirmDelayMs);
    });
  }

  // ---------------- Triple-anchor (fast lock) ----------------
  function learnTripleAnchorFromDialog(dialogAbsRect) {
    const img = captureRegion(dialogAbsRect.x, dialogAbsRect.y, dialogAbsRect.w, dialogAbsRect.h);
    if (!img) return false;

    // A: top-right frame patch (stable)
    const Aw = 80, Ah = 28;
    const Ax = img.width - Aw - 20;
    const Ay = 10;

    // B: progress bar frame area (stable)
    const Bw = 120, Bh = 20;
    const Bx = Math.floor((img.width - Bw) / 2);
    const By = Math.floor(img.height * 0.55);

    // C: close X patch (top-right corner)
    const Cw = 26, Ch = 26;
    const Cx = img.width - Cw - 10;
    const Cy = 10;

    const bytesA = cropRGBA(img, Ax, Ay, Aw, Ah);
    const bytesB = cropRGBA(img, Bx, By, Bw, Bh);
    const bytesC = cropRGBA(img, Cx, Cy, Cw, Ch);

    save(LS_MULTI, {
      A: { w: Aw, h: Ah, b64: bytesToB64(bytesA) },
      B: { w: Bw, h: Bh, b64: bytesToB64(bytesB) },
      C: { w: Cw, h: Ch, b64: bytesToB64(bytesC) },
      dxB: (Bx - Ax), dyB: (By - Ay),
      dxC: (Cx - Ax), dyC: (Cy - Ay),
      dialogW: img.width, dialogH: img.height,
      Ax: Ax, Ay: Ay
    });

    dbg({ learnedAnchors: true });
    return true;
  }

  function tryTripleAnchorFastLock() {
    const s = load(LS_MULTI);
    if (!s) return false;

    const rs = getRsSize();
    if (!rs.w || !rs.h) return false;

    const A = makeNeedle(s.A.w, s.A.h, b64ToBytes(s.A.b64));
    const B = makeNeedle(s.B.w, s.B.h, b64ToBytes(s.B.b64));
    const C = makeNeedle(s.C.w, s.C.h, b64ToBytes(s.C.b64));

    const area = getScanAreaConfig();
    const searchRect = { x: area.x0, y: area.y0, w: area.x1 - area.x0, h: area.y1 - area.y0 };
    const searchImg = captureRegion(searchRect.x, searchRect.y, searchRect.w, searchRect.h);
    if (!searchImg) return false;

    const mA = findAnchor(searchImg, A, { tolerance: 55, step: 2, minScore: 0.02 });
    if (!mA?.ok || mA.score < 0.72) return false;

    const ax = searchRect.x + mA.x;
    const ay = searchRect.y + mA.y;

    // Predict B/C from A
    const bx = ax + s.dxB, by = ay + s.dyB;
    const cx = ax + s.dxC, cy = ay + s.dyC;

    // Containment gate: predicted B/C must be inside the dialog bounds (with padding).
    // This prevents false positives where A matches something but B/C land outside the actual dialog.
    if (s.dialogW && s.dialogH && typeof s.Ax === "number" && typeof s.Ay === "number") {
      const dialogX = ax - s.Ax;
      const dialogY = ay - s.Ay;
      const padIn = 10;

      const inside = (x, y, w, h) =>
        (x >= dialogX - padIn) &&
        (y >= dialogY - padIn) &&
        (x + w <= dialogX + s.dialogW + padIn) &&
        (y + h <= dialogY + s.dialogH + padIn);

      if (!inside(bx, by, s.B.w, s.B.h) || !inside(cx, cy, s.C.w, s.C.h)) return false;
    }


    const pad = 8;

    const imgB = captureRegion(bx - pad, by - pad, s.B.w + pad * 2, s.B.h + pad * 2);
    if (!imgB) return false;
    const mB = findAnchor(imgB, B, { tolerance: 55, step: 1, minScore: 0.02 });
    if (!mB?.ok || mB.score < 0.70) return false;

    const imgC = captureRegion(cx - pad, cy - pad, s.C.w + pad * 2, s.C.h + pad * 2);
    const mC = imgC ? findAnchor(imgC, C, { tolerance: 60, step: 1, minScore: 0.02 }) : null;
    const cOK = !!(mC?.ok && mC.score >= 0.65);

    if (!cOK && !(mA.score >= 0.80 && mB.score >= 0.78)) return false;

    // lock at A absolute
    save(LS_LOCK, { x: ax, y: ay });
    updateSavedLockLabel();

    setLock(`x=${ax}, y=${ay}`);
    setStatus("Locked (fast A+B+C)");
    setProgress("locked");

          // Screen overlay: draw the confirmed dialog on the RS client
          overlayRectOnScreen(c.absRect.x, c.absRect.y, c.absRect.w, c.absRect.h, 1200);
          saveDialogRect(c.absRect);


    // Screen overlay: draw dialog rectangle if we know dialog geometry
    if (s.dialogW && s.dialogH) {
      const dialogX = ax - (s.Ax || 0);
      const dialogY = ay - (s.Ay || 0);
      overlayRectOnScreen(dialogX, dialogY, s.dialogW, s.dialogH, 1200);
      saveDialogRect({x:dialogX,y:dialogY,w:s.dialogW,h:s.dialogH});
    }


    // Live overlay boxes in preview (draw in RS coords onto a full-screen downscaled preview)
    // We'll draw a lightweight preview of the search region and overlays.
    const overlays = [
      { x: mA.x, y: mA.y, w: s.A.w, h: s.A.h, color: "#00ffff", label: "A" },
      { x: (bx - searchRect.x), y: (by - searchRect.y), w: s.B.w, h: s.B.h, color: "#00ff00", label: "B" },
      { x: (cx - searchRect.x), y: (cy - searchRect.y), w: s.C.w, h: s.C.h, color: "#ff9900", label: "C" }
    ];
    drawImageScaled(searchImg, `FAST A=${mA.score.toFixed(2)} B=${mB.score.toFixed(2)} C=${cOK?"ok":"—"}`, overlays);

    return true;
  }

  // ---------------- Capture loop (restored) ----------------
  // This is the heart-beat that keeps preview alive and provides a place to show overlays.
  let captureTimer = null;
  function startCaptureLoop() {
    if (captureTimer) return;
    captureTimer = setInterval(() => {
      // If scanning is active, scanTick() handles preview.
      // Otherwise, show a small "alive" capture to avoid black preview.
      if (!running || scanActive) return;

      // If locked, update progress by sampling the dialog rect
      const drect = loadDialogRect();
      if (drect) {
        const img = captureRegion(drect.x, drect.y, drect.w, drect.h);
        if (img) {
          const pb = scoreProgressBar(img);
          const pct = clamp(pb.xEdge / Math.max(1, (img.width - 1)), 0, 1);
          // Update UI
          const pctTxt = Math.round(pct * 100) + "%";
          setProgress(pctTxt);

          // Flash on completion or big jump
          const last = window._pf_lastPct ?? null;
          window._pf_lastPct = pct;

          if (pct >= 0.985) {
            overlayRectOnScreen(drect.x, drect.y, drect.w, drect.h, 900);
          } else if (last !== null && Math.abs(pct - last) >= 0.12) {
            overlayRectOnScreen(drect.x, drect.y, drect.w, drect.h, 450);
          }

          // Preview with A/B/C overlay if available
          const s = load(LS_MULTI);
          const overlays = [];
          if (s && typeof s.Ax === "number") {
            overlays.push({ x: s.Ax, y: s.Ay, w: s.A.w, h: s.A.h, color: "#00ffff", label: "A" });
            overlays.push({ x: s.Ax + s.dxB, y: s.Ay + s.dyB, w: s.B.w, h: s.B.h, color: "#00ff00", label: "B" });
            overlays.push({ x: s.Ax + s.dxC, y: s.Ay + s.dyC, w: s.C.w, h: s.C.h, color: "#ff9900", label: "C" });
          }
          drawImageScaled(img, `LOCKED pb=${pb.score.toFixed(2)} pct=${pctTxt}`, overlays);
          return;
        }
      }


      const rs = getRsSize();
      if (!rs.w || !rs.h) return;

      const area = getScanAreaConfig();
      const w = Math.min(560, area.x1 - area.x0);
      const h = Math.min(260, area.y1 - area.y0);
      const img = captureRegion(area.x0, area.y0, w, h);
      if (img) drawImageScaled(img, `IDLE preview (${area.name})`, []);
    }, 200);
  }

  function stopCaptureLoop() {
    if (captureTimer) { clearInterval(captureTimer); captureTimer = null; }
  }

  // ---------------- Rectangle scan loop ----------------
  let scanCursor = null;

  function resetScan() {
    const rs = getRsSize();
    const area = getScanAreaConfig();
    scanCursor = {
      rs,
      area,
      tx: area.x0,
      ty: area.y0,
      tileIndex: 0,
      best: []
    };
  }

  function pushBest(list, cand) {
    list.push(cand);
    list.sort((a, b) => b.comb - a.comb);
    if (list.length > SCAN.shortlist) list.length = SCAN.shortlist;
  }

  async function scanTick() {
    if (!running || !scanActive) return;

    const rs = scanCursor.rs;
    const area = scanCursor.area;

    if (scanCursor.ty >= area.y1) {
      // done scanning pass: confirm best candidates in order
      const list = scanCursor.best.slice();
      if (!list.length) {
        setStatus("No candidates (retry)...");
        scanActive = false;
        schedule(250, () => startAutoFindInternal());
        return;
      }

      for (const c of list) {
        setStatus(`Confirming comb=${c.comb.toFixed(2)} pb=${c.pb.toFixed(2)}...`);
        const conf = await confirmCandidate(c);
        if (conf.ok) {
          // Learn anchors and lock
          learnTripleAnchorFromDialog(c.absRect);

          // Lock uses top-left of Anchor A; we don't know A yet in fallback. Store dialog rect top-left for now.
          // Store lock as Anchor-A position (more stable + consistent with fast-lock)
          {
            const s = load(LS_MULTI);
            const ax = s && typeof s.Ax === "number" ? (c.absRect.x + s.Ax) : c.absRect.x;
            const ay = s && typeof s.Ay === "number" ? (c.absRect.y + s.Ay) : c.absRect.y;
            save(LS_LOCK, { x: ax, y: ay });
            updateSavedLockLabel();
            setLock(`x=${ax}, y=${ay}`);
          }
          setStatus(`Locked (fallback) pb=${conf.pb.toFixed(2)} moved=${conf.moved}`);
          setProgress("locked");

          // Preview of confirmed dialog with A/B/C overlay if learned
          const s = load(LS_MULTI);
          const overlays = [];
          if (s) {
            // overlays in dialog-local coords (learn patches are local; reconstruct their rects)
            const Ax = (c.absRect.w - s.A.w - 20);
            const Ay = 10;
            const Bx = Math.floor((c.absRect.w - s.B.w) / 2);
            const By = Math.floor(c.absRect.h * 0.55);
            const Cx = (c.absRect.w - s.C.w - 10);
            const Cy = 10;
            overlays.push({ x: Ax, y: Ay, w: s.A.w, h: s.A.h, color: "#00ffff", label: "A" });
            overlays.push({ x: Bx, y: By, w: s.B.w, h: s.B.h, color: "#00ff00", label: "B" });
            overlays.push({ x: Cx, y: Cy, w: s.C.w, h: s.C.h, color: "#ff9900", label: "C" });
          }
          drawImageScaled(conf.img2, `CONFIRM OK pb=${conf.pb.toFixed(2)}`, overlays);

          scanActive = false;
          return;
        }
      }

      setStatus("Confirm failed (retry)...");
      scanActive = false;
      schedule(250, () => startAutoFindInternal());
      return;
    }

    // next tile
    const tx = scanCursor.tx;
    const ty = scanCursor.ty;

    const tw = Math.min(TILE.w, area.x1 - tx);
    const th = Math.min(TILE.h, area.y1 - ty);

    const img = captureTile(tx, ty, tw, th);
    scanCursor.tileIndex++;

    if (img) {
      const { candidates, early } = scanTileForCandidates(img);
      // preview: show tile and best rect in it (if any)
      let bestInTile = null;
      if (candidates.length) {
        bestInTile = candidates.reduce((a, b) => (b.comb > a.comb ? b : a));
        pushBest(scanCursor.best, bestInTile);
      }
      drawImageScaled(
        img,
        `SCAN tile#${scanCursor.tileIndex} best=${bestInTile ? bestInTile.comb.toFixed(2) : "—"}`,
        bestInTile ? [{ x: bestInTile.relRect.x, y: bestInTile.relRect.y, w: bestInTile.relRect.w, h: bestInTile.relRect.h, color: "orange", label: "dlg" }] : []
      );

      if (early) {
        // push and jump to confirmation stage
        pushBest(scanCursor.best, early);
        scanCursor.ty = area.y1;
        scanCursor.tx = area.x0;
        schedule(0, scanTick);
        return;
      }
    }

    // advance cursor
    scanCursor.tx += TILE.w;
    if (scanCursor.tx >= area.x1) {
      scanCursor.tx = area.x0;
      scanCursor.ty += TILE.h;
    }

    schedule(15, scanTick);
  }

  function startAutoFindInternal() {
    if (!running) return;
    scanActive = true;
    setStatus("Auto-finding (fallback scan)...");
    setProgress("—");
    resetScan();
    schedule(0, scanTick);
  }

  // ---------------- Buttons ----------------
  function start() {
    if (!window.alt1) { setStatus("Alt1 missing"); dbg("Open inside Alt1."); return; }
    if (!alt1.permissionPixel) { setStatus("No pixel permission"); dbg("Enable pixel permission."); return; }
    if (typeof window.captureRegion !== "function" || typeof window.findAnchor !== "function") {
      setStatus("matcher.js not ready");
      dbg({ captureRegion: typeof window.captureRegion, findAnchor: typeof window.findAnchor });
      return;
    }

    running = true;
    setMode("Running");
    setProgress("—");

    startCaptureLoop();

    setStatus("Fast lock...");
    if (tryTripleAnchorFastLock()) return;

    // If no anchors yet, do not auto-start scanning unless user clicks Auto find.
    setStatus("Idle (press Auto find)");
  }

  function stop() {
    running = false;
    scanActive = false;
    stopTimers();
    stopCaptureLoop();
    setMode("Not running");
    setStatus("Idle");
    setProgress("—");
  }

  function autoFind() {
    if (!running) start();
    // always clear lock for a fresh learn
    del(LS_LOCK);
    del(LS_DIALOG);
    window._pf_lastPct = null;
    updateSavedLockLabel();
    startAutoFindInternal();
  }

  function clearLock() {
    del(LS_LOCK);
    del(LS_MULTI);
    del(LS_DIALOG);
    window._pf_lastPct = null;
    updateSavedLockLabel();
    setLock("none");
    setStatus("Cleared");
    setProgress("—");
  }
  // ---------------- Init UI ----------------
  // Note: index.html owns the displayed version/build text.
  // app.js no longer overwrites it.

  updateSavedLockLabel();
  setMode("Not running");
  setStatus("Idle");
  setLock("none");
  setProgress("—");

  if (startBtn) startBtn.onclick = start;
  if (stopBtn) stopBtn.onclick = stop;
  if (autoFindBtn) autoFindBtn.onclick = autoFind;
  if (clearLockBtn) clearLockBtn.onclick = clearLock;
  if (testFlashBtn) testFlashBtn.onclick = () => {
    const d=loadDialogRect();
    if(d){ overlayRectOnScreen(d.x,d.y,d.w,d.h,900); return; }
    const rs=getRsSize();
    overlayRectOnScreen(Math.floor(rs.w*0.25), Math.floor(rs.h*0.25), Math.floor(rs.w*0.5), Math.floor(rs.h*0.15), 900);
  };

  dbg({
    version: APP_VERSION,
    build: BUILD_ID,
    note: "captureRegion() uses alt1.getRegion internally (correct). This file uses captureRegion for all captures."
  });
})();
