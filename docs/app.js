// ProgFlash app_final12.js
// Goals:
// 1) Restore moving "stage scan / verify" preview by bringing back the fallback rectangle scan (tile cursor preview).
// 2) Keep RS-relative capture everywhere (matcher.js captureRegion is RS-relative).
// 3) Fix scan area dropdown wiring (scanPreset).
// 4) Avoid Alt1 minimizing: screen overlay is OFF by default. "Test flash" toggles overlay mode.
//    - If overlay mode is OFF: draws green boxes ONLY in the preview.
//    - If overlay mode is ON: attempts Alt1 screen overlay (may minimize on some setups).
//
// Notes from your diag:
// - hasGetRegionImage=false so matcher.js uses alt1.getRegion (base64) which is OK.
//
// Dependencies: matcher.js provides captureRegion + findAnchor + progflashCaptureDiag.

(() => {
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
  const showLockOverlayBtn = $("showLockOverlayBtn");

  const savedLockEl = $("savedLock");
  const scanPresetEl = $("scanPreset");

  const canvas = $("previewCanvas");
  const ctx = canvas ? canvas.getContext("2d", { willReadFrequently: true }) : null;

  function setStatus(v) { if (statusEl) statusEl.textContent = v; }
  function setMode(v) { if (modeEl) modeEl.textContent = v; }
  function setLock(v) { if (lockEl) lockEl.textContent = v; }
  function setProgress(v) { if (progEl) progEl.textContent = v; }
  function dbg(v) { if (dbgEl) dbgEl.textContent = typeof v === "string" ? v : JSON.stringify(v, null, 2); }

  // ---------- Storage ----------
  const LS_LOCK   = "progflash.lockPos";         // {x,y} RS-relative anchor A
  const LS_MULTI  = "progflash.multiAnchorABC";  // learned A/B/C needles + offsets + dialog dims
  const LS_DIALOG = "progflash.dialogRect";      // {x,y,w,h} RS-relative dialog rect
  const LS_BAR    = "progflash.barTemplate";     // per-user learned progress bar template
  const LS_SCAN   = "progflash.scanPreset";      // "top|mid|bot|full"
  const LS_OVL    = "progflash.overlayEnabled";  // "1" or "0"

  function save(key, obj) { try { localStorage.setItem(key, JSON.stringify(obj)); } catch {} }
  function load(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } }
  function del(key) { try { localStorage.removeItem(key); } catch {} }

  function updateSavedLockLabel() {
    if (!savedLockEl) return;
    const p = load(LS_LOCK);
    savedLockEl.textContent = p ? `x=${p.x},y=${p.y}` : "none";
  }

  // ---------- Helpers ----------
  function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

  function getRsSize() { return { w: alt1.rsWidth || 0, h: alt1.rsHeight || 0 }; }
  function getRsOffset() { return { x: alt1.rsX || 0, y: alt1.rsY || 0 }; }

  function rgba(r, g, b, a = 255) {
    return (r & 255) | ((g & 255) << 8) | ((b & 255) << 16) | ((a & 255) << 24);
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

  // ---------- Overlay ----------
  function overlayEnabled() {
    try { return localStorage.getItem(LS_OVL) === "1"; } catch { return false; }
  }
  function setOverlayEnabled(v) {
    try { localStorage.setItem(LS_OVL, v ? "1" : "0"); } catch {}
  }

  function overlayRectAbs(absX, absY, w, h, ms = 900) {
    try {
      const colorNum = 0x00ff00;
      if (typeof alt1.overLayRect === "function") { alt1.overLayRect(absX, absY, w, h, colorNum, 2, ms); return true; }
      if (typeof alt1.overLayRectEx === "function") { alt1.overLayRectEx(absX, absY, w, h, colorNum, 2, ms); return true; }
      if (typeof alt1.overlayRect === "function") { alt1.overlayRect(absX, absY, w, h, colorNum, 2, ms); return true; }
      return false;
    } catch {
      return false;
    }
  }

  function overlayRectRs(rsX, rsY, w, h, ms = 900) {
    const o = getRsOffset();
    return overlayRectAbs(o.x + rsX, o.y + rsY, w, h, ms);
  }

  function overlayTextAbs(absX, absY, text, color = 0xff0000, ms = 900) {
    try {
      if (typeof alt1.overLayText === "function") { alt1.overLayText(text, color, absX, absY, ms); return true; }
      if (typeof alt1.overlayText === "function") { alt1.overlayText(text, color, absX, absY, ms); return true; }
      return false;
    } catch {
      return false;
    }
  }

  function overlayTextRs(rsX, rsY, text, color = 0xff0000, ms = 900) {
    const o = getRsOffset();
    return overlayTextAbs(o.x + rsX, o.y + rsY, text, color, ms);
  }

  // ---------- Preview drawing ----------
  function drawImageScaled(img, label, overlayRects) {
    if (!ctx || !canvas) return;

    if (!img) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "rgba(0,0,0,0.65)";
      ctx.fillRect(0, 0, canvas.width, 28);
      ctx.fillStyle = "white";
      ctx.font = "12px Arial";
      ctx.fillText(label || "No capture", 10, 18);
      return;
    }

    const id = new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);

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

    if (label) {
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      ctx.fillRect(6, 6, Math.min(cw - 12, 980), 20);
      ctx.fillStyle = "white";
      ctx.font = "12px Arial";
      ctx.fillText(label, 12, 21);
    }

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

  // ---------- Scan preset ----------
  function getScanPreset() {
    const saved = (() => { try { return localStorage.getItem(LS_SCAN); } catch { return null; } })();
    const v = (scanPresetEl && scanPresetEl.value) || saved || "top";
    return v || "top";
  }

  function setScanPreset(v) {
    if (scanPresetEl) scanPresetEl.value = v;
    try { localStorage.setItem(LS_SCAN, v); } catch {}
  }

  function getScanAreaConfig() {
    const rs = getRsSize();
    const v = getScanPreset();

    const xMinFrac = 0.12, xMaxFrac = 0.88;
    let y0 = 0, y1 = rs.h;

    if (v === "top") { y0 = 0; y1 = Math.floor(rs.h * 0.62); }
    else if (v === "mid" || v === "middle") { y0 = Math.floor(rs.h * 0.20); y1 = Math.floor(rs.h * 0.85); }
    else if (v === "bot" || v === "bottom") { y0 = Math.floor(rs.h * 0.38); y1 = rs.h; }
    else { y0 = 0; y1 = rs.h; }

    return {
      name: v,
      x0: Math.floor(rs.w * xMinFrac),
      x1: Math.floor(rs.w * xMaxFrac),
      y0, y1
    };
  }

  // ---------- Fallback rectangle scanning (moving preview) ----------
  const TILE = { w: 640, h: 360 };

  const DIALOG_SIZES = [
    { w: 520, h: 200 },
    { w: 500, h: 190 },
    { w: 480, h: 180 }
  ];

  // Progress-bar scoring thresholds.
  // If it struggles to find the bar, try lowering minScore slightly.
  const PB = { minScore: 0.14 };

  const SCAN = {
    // Smaller step -> denser search, better chance to hit the bar at cost of CPU.
    step: 8,
    // Keep a few more good candidates around so we don't miss near-misses.
    shortlist: 8,
    // Combined score needed to trigger an "early confirm" on a tile.
    earlyExitComb: 0.82,
    confirmDelayMs: 180
  };

  // High-level run state (set by Start/Stop buttons).
  let running = false;

  let scanActive = false;
  let scanTimer = null;

  function stopTimers() { if (scanTimer) { clearTimeout(scanTimer); scanTimer = null; } }
  function schedule(ms, fn) { stopTimers(); scanTimer = setTimeout(fn, ms); }

  let scanCursor = null;

  function resetScan() {
    const area = getScanAreaConfig();
    scanCursor = {
      area,
      tx: area.x0,
      ty: area.y0,
      tileIndex: 0,
      best: []
    };
  }

  function pushBest(arr, c) {
    arr.push(c);
    arr.sort((a, b) => b.comb - a.comb);
    if (arr.length > SCAN.shortlist) arr.length = SCAN.shortlist;
  }

  function captureTile(tx, ty, tw, th) {
    const img = captureRegion(tx, ty, tw, th);
    if (img) { img._tileX = tx; img._tileY = ty; }
    return img;
  }

  function scoreProgressBar(sub) {
    const w = sub.width, h = sub.height;
    // Vertical band where we expect the bar (whatever its color is after Alt1's capture).
    const y0 = Math.floor(h * 0.40);
    const y1 = Math.floor(h * 0.75);

    let bestRow = { score: 0, y: Math.floor(h * 0.55), xEdge: 0 };

    for (let y = y0; y < y1; y += 2) {
      const samples = [];
      let sumR = 0, sumG = 0, sumB = 0;

      for (let x = Math.floor(w * 0.10); x < Math.floor(w * 0.90); x += 2) {
        const i = (y * w + x) * 4;
        const r = sub.data[i], g = sub.data[i + 1], b = sub.data[i + 2];
        samples.push({ x, r, g, b });
        sumR += r; sumG += g; sumB += b;
      }

      const total = samples.length;
      if (!total) continue;

      const meanR = sumR / total;
      const meanG = sumG / total;
      const meanB = sumB / total;

      // Treat pixels close to the dominant row color as "bar", regardless of hue.
      // Threshold is fairly loose to cope with compression / lighting.
      const distThreshSq = 55 * 55;

      let hits = 0;
      let lastHitX = 0;
      for (const s of samples) {
        const dr = s.r - meanR;
        const dg = s.g - meanG;
        const db = s.b - meanB;
        const distSq = dr*dr + dg*dg + db*db;
        if (distSq <= distThreshSq) {
          hits++;
          lastHitX = s.x;
        }
      }

      const score = hits / total;
      if (score > bestRow.score) bestRow = { score, y, xEdge: lastHitX };
    }

    return bestRow;
  }

  function scoreCancelBand(sub) {
    // Original RS dialogs often had an orange "Cancel" bar; on many themes this is now grey.
    // We keep this function for diagnostics, but no longer depend on it for locking.
    const w = sub.width, h = sub.height;
    const y0 = Math.floor(h * 0.78);
    const y1 = Math.floor(h * 0.96);

    let hits = 0, total = 0;
    for (let y = y0; y < y1; y += 2) {
      for (let x = Math.floor(w * 0.25); x < Math.floor(w * 0.75); x += 2) {
        const i = (y * w + x) * 4;
        const r = sub.data[i], g = sub.data[i + 1], b = sub.data[i + 2];
        total++;
        const isOrange = (r > 120 && g > 70 && b < 80 && r > g + 15);
        if (isOrange) hits++;
      }
    }
    return total ? hits / total : 0;
  }

  function scoreCloseX(sub) {
    const w = sub.width, h = sub.height;
    const x0 = Math.floor(w * 0.84);
    const y0 = Math.floor(h * 0.05);
    const x1 = Math.floor(w * 0.98);
    const y1 = Math.floor(h * 0.22);

    let hits = 0, total = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * w + x) * 4;
        const r = sub.data[i], g = sub.data[i + 1], b = sub.data[i + 2];
        total++;
        const bright = (r + g + b) > 650;
        if (bright) hits++;
      }
    }
    return total ? hits / total : 0;
  }

  function scoreDialogCandidate(tileImg, rx, ry, rw, rh) {
    const sub = { width: rw, height: rh, data: cropRGBA(tileImg, rx, ry, rw, rh) };

    const pb = scoreProgressBar(sub);
    const cancel = scoreCancelBand(sub);
    const close = scoreCloseX(sub);

    // Rely primarily on the progress bar + close "X". Cancel color varies a lot between themes.
    const comb = pb.score * 0.8 + (close * 0.2);
    return { pb: pb.score, pbY: pb.y, pbXEdge: pb.xEdge, cancel, close, comb };
  }

  // Scan a single full-screen image for the best dialog-like candidate.
  function findBestDialogInImage(img) {
    let best = null;
    const iw = img.width, ih = img.height;

    for (const sz of DIALOG_SIZES) {
      const rw = Math.min(sz.w, iw);
      const rh = Math.min(sz.h, ih);
      if (rw < 320 || rh < 140) continue;

      for (let y = 0; y <= ih - rh; y += SCAN.step) {
        for (let x = 0; x <= iw - rw; x += SCAN.step) {
          const s = scoreDialogCandidate(img, x, y, rw, rh);
          const c = {
            absRect: { x, y, w: rw, h: rh },
            relRect: { x, y, w: rw, h: rh },
            ...s
          };
          if (!best || c.comb > best.comb) best = c;
        }
      }
    }
    return best;
  }

  // Try to locate the dialog by matching a learned bar template first.
  function autoFindWithBarTemplate() {
    const tpl = load(LS_BAR);
    if (!tpl || !tpl.w || !tpl.h || !tpl.b64) return null;

    const rs = getRsSize();
    const hay = captureRegion(0, 0, rs.w, rs.h);
    if (!hay) return null;

    const bytes = b64ToBytes(tpl.b64);
    const needle = makeNeedle(tpl.w, tpl.h, bytes);

    const match = window.findAnchor(hay, needle, {
      minScore: 0.70,
      step: 2,
      ignoreAlphaBelow: 0
    });

    if (!match || !match.ok) return null;

    const barX = match.x;
    const barY = match.y;

    // Recover dialog rect from bar position and stored offsets.
    const dlgX = barX + (typeof tpl.dxDialog === "number" ? tpl.dxDialog : -tpl.rel.x);
    const dlgY = barY + (typeof tpl.dyDialog === "number" ? tpl.dyDialog : -tpl.rel.y);
    const dlgW = tpl.dialogW || (tpl.rel && tpl.rel.w ? tpl.rel.w * 3 : 520);
    const dlgH = tpl.dialogH || (tpl.rel && tpl.rel.h ? tpl.rel.h * 4 : 200);

    const dialogRect = {
      x: clamp(dlgX, 0, Math.max(0, rs.w - 1)),
      y: clamp(dlgY, 0, Math.max(0, rs.h - 1)),
      w: Math.min(dlgW, rs.w),
      h: Math.min(dlgH, rs.h)
    };

    // For preview: capture just around the candidate dialog.
    const imgDialog = captureRegion(dialogRect.x, dialogRect.y, dialogRect.w, dialogRect.h);

    try {
      window.progflashCaptureDiag = Object.assign({}, window.progflashCaptureDiag || {}, {
        lastBarTemplateMatch: {
          score: match.score,
          bar: { x: barX, y: barY, w: tpl.w, h: tpl.h },
          dialogRect
        }
      });
    } catch {}

    return { dialogRect, imgDialog, matchScore: match.score };
  }

  function scanTileForCandidates(tileImg) {
    const out = [];
    const tw = tileImg.width, th = tileImg.height;

    for (const sz of DIALOG_SIZES) {
      const rw = Math.min(sz.w, tw);
      const rh = Math.min(sz.h, th);
      if (rw < 320 || rh < 140) continue;

      for (let y = 0; y <= th - rh; y += SCAN.step) {
        for (let x = 0; x <= tw - rw; x += SCAN.step) {
          const s = scoreDialogCandidate(tileImg, x, y, rw, rh);

          const c = {
            absRect: { x: tileImg._tileX + x, y: tileImg._tileY + y, w: rw, h: rh },
            relRect: { x, y, w: rw, h: rh },
            ...s
          };
          out.push(c);

          // Only trigger early confirm on reasonably strong candidates,
          // but still keep weaker ones around for diagnostics.
          if (s.pb >= PB.minScore && s.comb >= SCAN.earlyExitComb) {
            return { candidates: out, early: c };
          }
        }
      }
    }
    return { candidates: out, early: null };
  }

  function confirmCandidate(c) {
    const r = c.absRect;
    const img1 = captureRegion(r.x, r.y, r.w, r.h);
    if (!img1) return Promise.resolve({ ok: false });

    const pb1 = scoreProgressBar(img1);

    return new Promise(resolve => {
      setTimeout(() => {
        const img2 = captureRegion(r.x, r.y, r.w, r.h);
        if (!img2) { resolve({ ok: false }); return; }

        const pb2 = scoreProgressBar(img2);
        const moved = Math.abs(pb2.xEdge - pb1.xEdge);
        const cancel2 = scoreCancelBand(img2);
        const close2 = scoreCloseX(img2);

        const pbFracY = pb2.y / Math.max(1, (img2.height - 1));
        // Slightly wider vertical band and looser movement threshold.
        const inBand = (pbFracY >= 0.40 && pbFracY <= 0.78);

        const ok =
          (pb2.score >= PB.minScore) &&
          (moved >= 1 || pb2.score >= 0.22) &&
          // Require a reasonable fraction of bright pixels in the close "X" area,
          // but don't depend on any specific cancel color.
          (close2 >= 0.05) &&
          inBand;

        // Expose extra diagnostics for tricky cases.
        try {
          window.progflashCaptureDiag = Object.assign({}, window.progflashCaptureDiag || {}, {
            lastConfirm: {
              ok,
              moved,
              pb1: pb1.score,
              pb2: pb2.score,
              cancel2,
              close2,
              pbFracY,
              minScore: PB.minScore
            }
          });
        } catch {}

        resolve({ ok, pb: pb2.score, moved, cancel: cancel2, close: close2, img2 });
      }, SCAN.confirmDelayMs);
    });
  }

  function learnTripleAnchorFromDialog(dialogRsRect) {
    const img = captureRegion(dialogRsRect.x, dialogRsRect.y, dialogRsRect.w, dialogRsRect.h);
    if (!img) return false;

    const Aw = 80, Ah = 28;
    const Ax = img.width - Aw - 20;
    const Ay = 10;

    const Bw = 140, Bh = 20;
    const Bx = Math.floor((img.width - Bw) / 2);
    const By = Math.floor(img.height * 0.55);

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
      Ax, Ay
    });

    return true;
  }

  // Learn a per-user bar template and dialog offsets from a confirmed dialog rect.
  function learnBarTemplateFromDialog(dialogRsRect) {
    const img = captureRegion(dialogRsRect.x, dialogRsRect.y, dialogRsRect.w, dialogRsRect.h);
    if (!img) return false;

    const pb = scoreProgressBar(img);
    if (!pb || pb.score < PB.minScore) return false;

    // Define a reasonably tight bar rectangle around the best progress-bar row.
    const bw = Math.max(80, Math.floor(img.width * 0.80));
    const bx = Math.floor((img.width - bw) / 2);
    const bh = 14;
    const by = clamp(pb.y - Math.floor(bh / 2), 0, Math.max(0, img.height - bh));

    const bytes = cropRGBA(img, bx, by, bw, bh);

    save(LS_BAR, {
      w: bw,
      h: bh,
      b64: bytesToB64(bytes),
      // Dialog relative location of the bar.
      rel: { x: bx, y: by, w: bw, h: bh },
      dialogW: img.width,
      dialogH: img.height,
      // Offsets to recover the dialog rect from a future bar match.
      dxDialog: dialogRsRect.x - (dialogRsRect.x + bx),
      dyDialog: dialogRsRect.y - (dialogRsRect.y + by),
      // Fractional vertical position of the bar inside the dialog for diagnostics.
      pbFracY: pb.y / Math.max(1, img.height - 1),
      learnedAt: Date.now()
    });

    return true;
  }

  function scanTick() {
    if (!running || !scanActive || !scanCursor) return;

    const area = getScanAreaConfig();
    if (scanCursor.area.name !== area.name) {
      resetScan();
      setStatus(`Auto-finding (scan restart: ${area.name})...`);
      schedule(0, scanTick);
      return;
    }

    if (scanCursor.best.length) {
      const c = scanCursor.best.shift();
      setStatus(`Confirming… (pb=${c.pb.toFixed(2)} comb=${c.comb.toFixed(2)})`);

      confirmCandidate(c).then(conf => {
        if (!running || !scanActive) return;

        if (conf.ok) {
          save(LS_DIALOG, c.absRect);
          learnTripleAnchorFromDialog(c.absRect);

          const s = load(LS_MULTI);
          if (s && typeof s.Ax === "number" && typeof s.Ay === "number") {
            save(LS_LOCK, { x: (c.absRect.x + s.Ax)|0, y: (c.absRect.y + s.Ay)|0 });
            updateSavedLockLabel();
            setLock(`x=${(c.absRect.x + s.Ax)|0}, y=${(c.absRect.y + s.Ay)|0}`);
          } else {
            setLock("learned");
          }

          setProgress("locked");
          setStatus("Locked (from scan confirm)");
          scanActive = false;

          drawImageScaled(conf.img2, `CONFIRMED OK pb=${conf.pb.toFixed(2)}`,
            [{ x: 0, y: 0, w: c.absRect.w, h: c.absRect.h, color: "lime", label: "dialog" }]
          );

          if (overlayEnabled()) overlayRectRs(c.absRect.x, c.absRect.y, c.absRect.w, c.absRect.h, 900);
          return;
        }

        setStatus("Confirm failed (continuing scan)...");
        schedule(0, scanTick);
      });

      return;
    }

    const tx = scanCursor.tx;
    const ty = scanCursor.ty;

    const tw = Math.min(TILE.w, area.x1 - tx);
    const th = Math.min(TILE.h, area.y1 - ty);

    const img = captureTile(tx, ty, tw, th);
    scanCursor.tileIndex++;

    if (img) {
      const { candidates, early } = scanTileForCandidates(img);

      let bestInTile = null;
      if (candidates.length) {
        bestInTile = candidates.reduce((a, b) => (b.comb > a.comb ? b : a));
        pushBest(scanCursor.best, bestInTile);
      }

      // Record diagnostics for this tile so we can see how the scan behaves..
      try {
        window.progflashCaptureDiag = Object.assign({}, window.progflashCaptureDiag || {}, {
          lastScan: {
            preset: area.name,
            tileIndex: scanCursor.tileIndex,
            tileRect: { x: tx, y: ty, w: tw, h: th },
            candidateCount: candidates.length,
            bestComb: bestInTile ? bestInTile.comb : 0,
            bestPb: bestInTile ? bestInTile.pb : 0
          }
        });
      } catch {}

      drawImageScaled(
        img,
        `SCAN tile#${scanCursor.tileIndex} preset=${area.name} best=${bestInTile ? bestInTile.comb.toFixed(2) : "—"} overlay=${overlayEnabled() ? "ON" : "OFF"}`,
        bestInTile ? [{ x: bestInTile.relRect.x, y: bestInTile.relRect.y, w: bestInTile.relRect.w, h: bestInTile.relRect.h, color: "orange", label: "candidate" }] : []
      );

      if (early) pushBest(scanCursor.best, early);
    } else {
      drawImageScaled(null, `SCAN tile#${scanCursor.tileIndex} capture failed`);
    }

    scanCursor.tx += TILE.w;
    if (scanCursor.tx >= area.x1) {
      scanCursor.tx = area.x0;
      scanCursor.ty += TILE.h;
    }

    if (scanCursor.ty >= area.y1) {
      setStatus("Auto find timed out (try changing Scan area preset)");
      scanActive = false;
      try {
        window.progflashCaptureDiag = Object.assign({}, window.progflashCaptureDiag || {}, {
          lastScanEnd: {
            preset: area.name,
            reason: "area_exhausted",
            tilesScanned: scanCursor.tileIndex
          }
        });
      } catch {}
      return;
    }

    schedule(12, scanTick);
  }

  async function startAutoFindInternal() {
    if (!running) return;
    scanActive = true;
    setProgress("—");

    // Phase 1: if we have a learned bar template, try that first.
    setStatus("Auto-finding (bar template)...");
    const tplHit = autoFindWithBarTemplate();
    if (tplHit && tplHit.dialogRect && tplHit.matchScore >= 0.72) {
      const dlg = tplHit.dialogRect;
      const conf = await confirmCandidate({ absRect: dlg, relRect: { x: 0, y: 0, w: dlg.w, h: dlg.h }, pb: 1, comb: 1 });

      if (!running || !scanActive) {
        scanActive = false;
        return;
      }

      if (conf && conf.ok) {
        save(LS_DIALOG, dlg);
        learnTripleAnchorFromDialog(dlg);
        learnBarTemplateFromDialog(dlg);

        const s = load(LS_MULTI);
        if (s && typeof s.Ax === "number" && typeof s.Ay === "number") {
          save(LS_LOCK, { x: (dlg.x + s.Ax)|0, y: (dlg.y + s.Ay)|0 });
          updateSavedLockLabel();
          setLock(`x=${(dlg.x + s.Ax)|0}, y=${(dlg.y + s.Ay)|0}`);
        } else {
          setLock("learned");
        }

        setProgress("locked");
        setStatus("Locked (from bar template)");
        scanActive = false;

        drawImageScaled(conf.img2, `CONFIRMED (template)`,
          [{ x: 0, y: 0, w: dlg.w, h: dlg.h, color: "lime", label: "dialog" }]
        );

        if (overlayEnabled()) overlayRectRs(dlg.x, dlg.y, dlg.w, dlg.h, 900);
        return;
      }
    }

    // Phase 2: fall back to generic single-screen scan.
    setStatus("Auto-finding (single screen scan)...");

    const rs = getRsSize();
    const img = captureRegion(0, 0, rs.w, rs.h);
    if (!img) {
      setStatus("Auto find failed: capture error");
      scanActive = false;
      return;
    }

    const best = findBestDialogInImage(img);

    // Record diagnostics for this one-shot scan.
    try {
      window.progflashCaptureDiag = Object.assign({}, window.progflashCaptureDiag || {}, {
        lastScanOneShot: {
          preset: "full",
          imgSize: { w: img.width, h: img.height },
          bestComb: best ? best.comb : 0,
          bestPb: best ? best.pb : 0
        }
      });
    } catch {}

    if (!best || best.pb < PB.minScore) {
      drawImageScaled(img, "AUTO FIND: no strong progress dialog candidate", []);
      setStatus("No progress dialog found (try moving RS window)");
      scanActive = false;
      return;
    }

    drawImageScaled(
      img,
      `AUTO FIND candidate pb=${best.pb.toFixed(2)} comb=${best.comb.toFixed(2)}`,
      [{ x: best.absRect.x, y: best.absRect.y, w: best.absRect.w, h: best.absRect.h, color: "orange", label: "candidate" }]
    );

    const conf = await confirmCandidate(best);
    if (!running || !scanActive) {
      scanActive = false;
      return;
    }

    if (conf && conf.ok) {
      save(LS_DIALOG, best.absRect);
      learnTripleAnchorFromDialog(best.absRect);
      learnBarTemplateFromDialog(best.absRect);

      const s = load(LS_MULTI);
      if (s && typeof s.Ax === "number" && typeof s.Ay === "number") {
        save(LS_LOCK, { x: (best.absRect.x + s.Ax)|0, y: (best.absRect.y + s.Ay)|0 });
        updateSavedLockLabel();
        setLock(`x=${(best.absRect.x + s.Ax)|0}, y=${(best.absRect.y + s.Ay)|0}`);
      } else {
        setLock("learned");
      }

      setProgress("locked");
      setStatus("Locked (from single scan confirm)");
      scanActive = false;

      drawImageScaled(conf.img2, `CONFIRMED OK pb=${conf.pb.toFixed(2)}`,
        [{ x: 0, y: 0, w: best.absRect.w, h: best.absRect.h, color: "lime", label: "dialog" }]
      );

      if (overlayEnabled()) overlayRectRs(best.absRect.x, best.absRect.y, best.absRect.w, best.absRect.h, 900);
      return;
    }

    setStatus("Confirm failed (no lock)");
    scanActive = false;
  }

  // ---------- Idle capture loop ----------
  let captureTimer = null;
  function startCaptureLoop() {
    if (captureTimer) return;
    captureTimer = setInterval(() => {
      if (!running) return;

      const area = getScanAreaConfig();
      const w = Math.min(560, area.x1 - area.x0);
      const h = Math.min(260, area.y1 - area.y0);
      const img = captureRegion(area.x0, area.y0, w, h);

      if (!scanActive) drawImageScaled(img, `IDLE (${area.name}) overlay=${overlayEnabled() ? "ON" : "OFF"}`, []);

      dbg({
        note: scanActive ? "scan_active" : "idle",
        scanPreset: area.name,
        scanRect: { x: area.x0, y: area.y0, w: area.x1 - area.x0, h: area.y1 - area.y0 },
        captureDiag: window.progflashCaptureDiag || {},
        overlayEnabled: overlayEnabled()
      });
    }, 220);
  }

  function stopCaptureLoop() {
    if (captureTimer) { clearInterval(captureTimer); captureTimer = null; }
  }

  // ---------- Buttons ----------
  function start() {
    if (!window.alt1) { setStatus("Alt1 missing"); dbg("Open inside Alt1."); return; }
    if (!alt1.permissionPixel) { setStatus("No pixel permission"); dbg("Enable pixel permission."); return; }
    if (typeof window.captureRegion !== "function" || typeof window.findAnchor !== "function") {
      setStatus("matcher.js not ready");
      dbg({ captureRegion: typeof window.captureRegion, findAnchor: typeof window.findAnchor });
      return;
    }

    const saved = (() => { try { return localStorage.getItem(LS_SCAN); } catch { return null; } })();
    if (scanPresetEl && saved) scanPresetEl.value = saved;

    running = true;
    setMode("Running");
    setProgress("—");
    startCaptureLoop();

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
    del(LS_LOCK);
    del(LS_DIALOG);
    updateSavedLockLabel();
    setLock("none");
    startAutoFindInternal();
  }

  function clearLock() {
    del(LS_LOCK);
    del(LS_MULTI);
    del(LS_DIALOG);
    del(LS_BAR);
    updateSavedLockLabel();
    setLock("none");
    setStatus("Cleared");
    setProgress("—");
  }

  function showLockOverlay() {
    const dlg = load(LS_DIALOG);
    const lock = load(LS_LOCK);

    // If overlay mode is OFF, only show the lock in the preview to avoid Alt1 minimizing.
    if (!overlayEnabled()) {
      if (dlg && typeof dlg.x === "number" && typeof dlg.y === "number" &&
          typeof dlg.w === "number" && typeof dlg.h === "number") {
        const img = captureRegion(dlg.x, dlg.y, dlg.w, dlg.h);
        drawImageScaled(img, "LOCK PREVIEW (overlay OFF)", [
          { x: 0, y: 0, w: dlg.w, h: dlg.h, color: "lime", label: "dialog" }
        ]);
        setStatus("Showing locked dialog in preview (overlay OFF)");
        return;
      }
      if (lock && typeof lock.x === "number" && typeof lock.y === "number") {
        const rx = Math.max(0, lock.x - 120);
        const ry = Math.max(0, lock.y - 80);
        const rw = 240, rh = 160;
        const img = captureRegion(rx, ry, rw, rh);
        const relX = lock.x - rx;
        const relY = lock.y - ry;
        drawImageScaled(img, "LOCK PREVIEW (overlay OFF)", [
          { x: relX - 10, y: relY - 6, w: 20, h: 12, color: "lime", label: "lock" }
        ]);
        setStatus("Showing lock point in preview (overlay OFF)");
        return;
      }
      setStatus("No lock/dialog stored to show");
      return;
    }

    // Overlay mode ON: try real Alt1 overlay (may minimize on some setups).
    if (!window.alt1) {
      setStatus("Alt1 missing");
      return;
    }
    if (dlg && typeof dlg.x === "number" && typeof dlg.y === "number" &&
        typeof dlg.w === "number" && typeof dlg.h === "number") {
      const ok = overlayRectRs(dlg.x, dlg.y, dlg.w, dlg.h, 1000);
      setStatus(ok ? "Showing locked dialog overlay" : "Overlay failed (check Alt1 overlay permission)");
      return;
    }
    if (lock && typeof lock.x === "number" && typeof lock.y === "number") {
      const ok = overlayRectRs(lock.x - 40, lock.y - 20, 80, 40, 1000);
      setStatus(ok ? "Showing lock point overlay" : "Overlay failed (check Alt1 overlay permission)");
      return;
    }
    setStatus("No lock/dialog stored to show");
  }

  function testFlash() {
    const now = !overlayEnabled();
    setOverlayEnabled(now);
    setStatus(`Overlay mode: ${now ? "ON (may minimize)" : "OFF (preview only)"}`);

    const area = getScanAreaConfig();
    const w = Math.min(560, area.x1 - area.x0);
    const h = Math.min(260, area.y1 - area.y0);
    const img = captureRegion(area.x0, area.y0, w, h);

    drawImageScaled(img, `TEST (${area.name}) overlay=${now ? "ON" : "OFF"}`,
      [{ x: 10, y: 10, w: 120, h: 60, color: "lime", label: "test" }]
    );

    if (now) {
      // Try both a small rectangle and a red "ProgFlash" text as overlay test.
      overlayRectRs(20, 20, 140, 70, 900);
      const rs = getRsSize();
      const cx = Math.floor(rs.w / 2) - 80;
      const cy = Math.floor(rs.h * 0.25);
      overlayTextRs(cx, cy, "ProgFlash", 0xff0000, 900);
    }
  }

  // ---------- Init ----------
  updateSavedLockLabel();
  setMode("Not running");
  setStatus("Idle");
  setLock("none");
  setProgress("—");

  if (scanPresetEl) {
    const saved = (() => { try { return localStorage.getItem(LS_SCAN); } catch { return null; } })();
    if (saved) scanPresetEl.value = saved;

    scanPresetEl.addEventListener("change", () => {
      setScanPreset(scanPresetEl.value);
      setStatus(`Scan area set: ${scanPresetEl.value}`);
      if (scanActive) resetScan();
    });
  }

  if (startBtn) startBtn.onclick = start;
  if (stopBtn) stopBtn.onclick = stop;
  if (autoFindBtn) autoFindBtn.onclick = autoFind;
  if (clearLockBtn) clearLockBtn.onclick = clearLock;
  if (testFlashBtn) testFlashBtn.onclick = testFlash;
  if (showLockOverlayBtn) showLockOverlayBtn.onclick = showLockOverlay;

  dbg({
    note: "app_final12: fallback scan restored (moving preview). Test flash toggles overlay mode to avoid minimize.",
    scanPreset: getScanPreset(),
    overlayEnabled: overlayEnabled()
  });
})();
