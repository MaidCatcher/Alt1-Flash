// ProgFlash app_final11.js
// Changes vs final10:
// - Scan preset dropdown is wired explicitly at init; changes take effect immediately and update debug.
// - "Test flash" no longer calls overlay directly inside the click handler (which can minimize/focus Alt1).
//   Instead it sets a flag; the capture loop performs the overlay on the next tick.
// - Adds an always-updating debug line showing the *current scan rect* (RS-relative) and capture diagnostics.
//
// Coordinate spaces:
// - captureRegion(x,y,w,h) is RS-relative (matcher.js converts to absolute for Alt1 getRegionImage).
// - overlayRect is absolute; we convert RS-relative -> absolute by adding alt1.rsX/alt1.rsY.

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

  const savedLockEl = $("savedLock");
  const scanPresetEl = $("scanPreset");

  const canvas = $("previewCanvas");
  const ctx = canvas ? canvas.getContext("2d", { willReadFrequently: true }) : null;

  function setStatus(v) { if (statusEl) statusEl.textContent = v; }
  function setMode(v) { if (modeEl) modeEl.textContent = v; }
  function setLock(v) { if (lockEl) lockEl.textContent = v; }
  function setProgress(v) { if (progEl) progEl.textContent = v; }
  function dbg(v) {
    if (!dbgEl) return;
    dbgEl.textContent = typeof v === "string" ? v : JSON.stringify(v, null, 2);
  }

  const LS_LOCK   = "progflash.lockPos";         // {x,y} RS-relative
  const LS_MULTI  = "progflash.multiAnchorABC";
  const LS_DIALOG = "progflash.dialogRect";      // {x,y,w,h} RS-relative
  const LS_SCAN   = "progflash.scanPreset";

  function save(key, obj) { try { localStorage.setItem(key, JSON.stringify(obj)); } catch {} }
  function load(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } }
  function del(key) { try { localStorage.removeItem(key); } catch {} }

  function updateSavedLockLabel() {
    if (!savedLockEl) return;
    const p = load(LS_LOCK);
    savedLockEl.textContent = p ? `x=${p.x},y=${p.y}` : "none";
  }

  function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

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

  function getRsSize() {
    return { w: alt1.rsWidth || 0, h: alt1.rsHeight || 0 };
  }
  function getRsOffset() {
    return { x: alt1.rsX || 0, y: alt1.rsY || 0 };
  }

  // ---------- Overlay (absolute) ----------
  function overlayRectAbs(absX, absY, w, h, ms = 900) {
    try {
      if (!window.alt1) return false;
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

  let lastOverlayAt = 0;
  function overlayRectRsThrottled(rsX, rsY, w, h, ms = 900, minGapMs = 800) {
    const now = Date.now();
    if (now - lastOverlayAt < minGapMs) return false;
    lastOverlayAt = now;
    return overlayRectRs(rsX, rsY, w, h, ms);
  }

  // ---------- Preview ----------
  function drawImageScaled(img, label) {
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
  }

  // ---------- Scan preset (explicit wiring) ----------
  function getScanPreset() {
    const v = (scanPresetEl && scanPresetEl.value) || load(LS_SCAN) || "top";
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

  // ---------- Progress from learned B patch ----------
  function barEdgeFromPatch(img) {
    if (!img || img.width < 40 || img.height < 8) return { ok: false, edgeX: 0, score: 0 };

    const w = img.width, h = img.height;
    const y0 = Math.floor(h * 0.25);
    const y1 = Math.floor(h * 0.75);

    function grayAt(x, y) {
      const i = (y * w + x) * 4;
      const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
      return (r * 77 + g * 150 + b * 29) >> 8;
    }

    const col = new Float32Array(w);
    for (let x = 0; x < w; x++) {
      let s = 0, c = 0;
      for (let y = y0; y < y1; y++) { s += grayAt(x, y); c++; }
      col[x] = c ? (s / c) : 0;
    }

    let bestG = 0;
    let bestX = Math.floor(w * 0.5);
    for (let x = 2; x < w - 2; x++) {
      const g = Math.abs(col[x] - col[x - 1]) + Math.abs(col[x + 1] - col[x]);
      if (g > bestG) { bestG = g; bestX = x; }
    }

    const frac = bestX / Math.max(1, w - 1);
    if (frac < 0.08 || frac > 0.95) return { ok: false, edgeX: bestX, score: bestG / 255 };

    const score = clamp(bestG / 255, 0, 1);
    return { ok: score >= 0.12, edgeX: bestX, score };
  }

  // ---------- Fast lock ----------
  function tryTripleAnchorFastLock() {
    const s = load(LS_MULTI);
    if (!s) return false;

    const A = makeNeedle(s.A.w, s.A.h, b64ToBytes(s.A.b64));
    const B = makeNeedle(s.B.w, s.B.h, b64ToBytes(s.B.b64));
    const C = makeNeedle(s.C.w, s.C.h, b64ToBytes(s.C.b64));

    const area = getScanAreaConfig();
    const searchRect = { x: area.x0, y: area.y0, w: area.x1 - area.x0, h: area.y1 - area.y0 };
    const searchImg = captureRegion(searchRect.x, searchRect.y, searchRect.w, searchRect.h);
    if (!searchImg) return false;

    const mA = findAnchor(searchImg, A, { tolerance: 55, step: 2, minScore: 0.02 });
    if (!mA?.ok || mA.score < 0.72) return false;

    const ax = (searchRect.x + mA.x) | 0;
    const ay = (searchRect.y + mA.y) | 0;

    const bx = (ax + s.dxB) | 0, by = (ay + s.dyB) | 0;
    const cx = (ax + s.dxC) | 0, cy = (ay + s.dyC) | 0;

    // Containment gate
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

    save(LS_LOCK, { x: ax, y: ay });
    updateSavedLockLabel();

    if (s.dialogW && s.dialogH) {
      const dialogX = (ax - (s.Ax || 0)) | 0;
      const dialogY = (ay - (s.Ay || 0)) | 0;
      const d = { x: dialogX, y: dialogY, w: s.dialogW|0, h: s.dialogH|0 };
      save(LS_DIALOG, d);
      overlayRectRsThrottled(d.x, d.y, d.w, d.h, 900, 400);
    }

    setLock(`x=${ax}, y=${ay}`);
    setStatus("Locked (fast)");
    setProgress("locked");
    drawImageScaled(searchImg, `FAST A=${mA.score.toFixed(2)} B=${mB.score.toFixed(2)} C=${cOK ? "ok" : "—"}`);

    return true;
  }

  function validateLockAndGetRects() {
    const s = load(LS_MULTI);
    const lock = load(LS_LOCK);
    if (!s || !lock) return { ok: false, reason: "no_state" };

    const A = makeNeedle(s.A.w, s.A.h, b64ToBytes(s.A.b64));
    const B = makeNeedle(s.B.w, s.B.h, b64ToBytes(s.B.b64));

    const ax = lock.x|0, ay = lock.y|0;
    const bx = (ax + s.dxB)|0, by = (ay + s.dyB)|0;

    const padA = 6;
    const imgA = captureRegion(ax - padA, ay - padA, s.A.w + padA * 2, s.A.h + padA * 2);
    if (!imgA) return { ok: false, reason: "capA_null" };
    const mA = findAnchor(imgA, A, { tolerance: 58, step: 1, minScore: 0.02 });
    if (!mA?.ok || mA.score < 0.66) return { ok: false, reason: "A_miss", mA };

    const padB = 6;
    const imgB = captureRegion(bx - padB, by - padB, s.B.w + padB * 2, s.B.h + padB * 2);
    if (!imgB) return { ok: false, reason: "capB_null", mA };
    const mB = findAnchor(imgB, B, { tolerance: 58, step: 1, minScore: 0.02 });
    if (!mB?.ok || mB.score < 0.64) return { ok: false, reason: "B_miss", mA, mB };

    const dialogX = (ax - (s.Ax || 0)) | 0;
    const dialogY = (ay - (s.Ay || 0)) | 0;
    const dialogW = (s.dialogW || 0) | 0;
    const dialogH = (s.dialogH || 0) | 0;

    return {
      ok: true,
      dialog: dialogW && dialogH ? { x: dialogX, y: dialogY, w: dialogW, h: dialogH } : null,
      bRect: { x: bx, y: by, w: s.B.w|0, h: s.B.h|0 },
      scores: { A: mA.score, B: mB.score }
    };
  }

  // ---------- Loop ----------
  let running = false;
  let timer = null;
  let lastGood = null;
  let lastPct = null;

  // "Test flash" requested flag (handled in loop to avoid minimizing/focus issues)
  let flashRequest = 0;

  function loopTick() {
    const diag = window.progflashCaptureDiag || {};
    const area = getScanAreaConfig();

    // Handle deferred test flash here (not in click handler)
    if (flashRequest) {
      flashRequest = 0;
      // Flash RS top-left and, if present, current dialog
      overlayRectRsThrottled(20, 20, 140, 70, 900, 0);
      const d = load(LS_DIALOG);
      if (d) overlayRectRsThrottled(d.x, d.y, d.w, d.h, 900, 0);
    }

    const hasLock = !!load(LS_LOCK);
    if (hasLock) {
      const v = validateLockAndGetRects();
      if (!v.ok) {
        setStatus(`LOCKED (lost) ${v.reason}`);
        setProgress("—");
        if (lastGood) drawImageScaled(lastGood.img, lastGood.label);
        dbg({
          note: "locked-lost",
          reason: v.reason,
          scanPreset: getScanPreset(),
          scanRect: { x: area.x0, y: area.y0, w: area.x1 - area.x0, h: area.y1 - area.y0 },
          captureDiag: diag
        });
        return;
      }

      if (v.dialog) {
        save(LS_DIALOG, v.dialog);
        // green box where it's locked onto
        overlayRectRsThrottled(v.dialog.x, v.dialog.y, v.dialog.w, v.dialog.h, 800, 900);
      }

      const imgB = captureRegion(v.bRect.x, v.bRect.y, v.bRect.w, v.bRect.h);
      if (!imgB) {
        setStatus("LOCKED (capture failed)");
        if (lastGood) drawImageScaled(lastGood.img, lastGood.label);
        dbg({
          note: "locked-capture-failed",
          scanPreset: getScanPreset(),
          scanRect: { x: area.x0, y: area.y0, w: area.x1 - area.x0, h: area.y1 - area.y0 },
          captureDiag: diag
        });
        return;
      }

      const edge = barEdgeFromPatch(imgB);
      if (edge.ok) {
        const pct = clamp(edge.edgeX / Math.max(1, imgB.width - 1), 0, 1);
        const pctTxt = Math.round(pct * 100) + "%";
        setStatus("Locked");
        setProgress(pctTxt);

        if (v.dialog && pct >= 0.985) overlayRectRsThrottled(v.dialog.x, v.dialog.y, v.dialog.w, v.dialog.h, 900, 500);
        else if (v.dialog && lastPct !== null && Math.abs(pct - lastPct) >= 0.12) overlayRectRsThrottled(v.dialog.x, v.dialog.y, v.dialog.w, v.dialog.h, 450, 500);

        lastPct = pct;

        if (v.dialog) {
          const imgDlg = captureRegion(v.dialog.x, v.dialog.y, v.dialog.w, v.dialog.h);
          if (imgDlg) {
            const label = `LOCK ${pctTxt} A=${v.scores.A.toFixed(2)} B=${v.scores.B.toFixed(2)} edge=${edge.score.toFixed(2)}`;
            drawImageScaled(imgDlg, label);
            lastGood = { img: imgDlg, label };
          }
        } else {
          const label = `LOCK(B) ${pctTxt} edge=${edge.score.toFixed(2)}`;
          drawImageScaled(imgB, label);
          lastGood = { img: imgB, label };
        }
      } else {
        setStatus("LOCKED (bar edge weak)");
        setProgress("—");
        const label = `LOCK(B) edge weak (score=${edge.score.toFixed(2)})`;
        drawImageScaled(imgB, label);
        lastGood = { img: imgB, label };
      }

      dbg({
        note: "locked",
        scanPreset: getScanPreset(),
        scanRect: { x: area.x0, y: area.y0, w: area.x1 - area.x0, h: area.y1 - area.y0 },
        dialog: load(LS_DIALOG),
        captureDiag: diag
      });
      return;
    }

    // Unlocked preview: show actual scan region capture so changing the preset should visibly change the preview.
    const w = Math.min(560, area.x1 - area.x0);
    const h = Math.min(260, area.y1 - area.y0);
    const img = captureRegion(area.x0, area.y0, w, h);

    drawImageScaled(img, `IDLE (${area.name}) scan x=${area.x0} y=${area.y0} w=${w} h=${h}`);
    dbg({
      note: "idle",
      scanPreset: getScanPreset(),
      scanRect: { x: area.x0, y: area.y0, w: area.x1 - area.x0, h: area.y1 - area.y0 },
      captureDiag: diag
    });
  }

  function startLoop() {
    if (timer) return;
    timer = setInterval(() => {
      if (!running) return;
      loopTick();
    }, 200);
  }

  function stopLoop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  // ---------- Actions ----------
  function start() {
    if (!window.alt1) { setStatus("Alt1 missing"); dbg("Open inside Alt1."); return; }
    if (!alt1.permissionPixel) { setStatus("No pixel permission"); dbg("Enable pixel permission."); return; }
    if (typeof window.captureRegion !== "function" || typeof window.findAnchor !== "function") {
      setStatus("matcher.js not ready");
      dbg({ captureRegion: typeof window.captureRegion, findAnchor: typeof window.findAnchor });
      return;
    }

    // Ensure dropdown reflects stored preset on boot
    const stored = load(LS_SCAN);
    if (scanPresetEl && stored) scanPresetEl.value = stored;

    running = true;
    setMode("Running");
    setProgress("—");
    startLoop();

    setStatus("Fast lock...");
    if (tryTripleAnchorFastLock()) return;
    setStatus("Idle (press Auto find)");
  }

  function stop() {
    running = false;
    stopLoop();
    setMode("Not running");
    setStatus("Idle");
    setProgress("—");
  }

  function autoFind() {
    if (!running) start();

    del(LS_LOCK);
    del(LS_DIALOG);
    lastGood = null;
    lastPct = null;
    updateSavedLockLabel();

    setLock("none");
    setProgress("—");
    setStatus("Auto find: waiting for fast lock...");

    const t0 = Date.now();
    const maxMs = 10000;

    const tick = () => {
      if (!running) return;
      if (load(LS_LOCK)) return;
      if (tryTripleAnchorFastLock()) return;

      if (Date.now() - t0 > maxMs) {
        setStatus("Auto find timed out (try changing Scan area preset)");
        return;
      }
      setTimeout(tick, 250);
    };
    tick();
  }

  function clearLock() {
    del(LS_LOCK);
    del(LS_MULTI);
    del(LS_DIALOG);
    lastGood = null;
    lastPct = null;

    updateSavedLockLabel();
    setLock("none");
    setStatus("Cleared");
    setProgress("—");
  }

  function testFlash() {
    // DO NOT overlay directly here (can minimize/focus Alt1 on some setups).
    // Defer to loop tick.
    flashRequest = Date.now();
    setStatus("Test flash requested");
  }

  // ---------- Init ----------
  updateSavedLockLabel();
  setMode("Not running");
  setStatus("Idle");
  setLock(load(LS_LOCK) ? "saved" : "none");
  setProgress("—");

  // Wire scan preset dropdown explicitly
  if (scanPresetEl) {
    const stored = load(LS_SCAN);
    if (stored) scanPresetEl.value = stored;

    scanPresetEl.addEventListener("change", () => {
      setScanPreset(scanPresetEl.value);
      // force immediate label update in debug/preview next tick
      setStatus(`Scan area set: ${scanPresetEl.value}`);
    });
  }

  if (startBtn) startBtn.onclick = start;
  if (stopBtn) stopBtn.onclick = stop;
  if (autoFindBtn) autoFindBtn.onclick = autoFind;
  if (clearLockBtn) clearLockBtn.onclick = clearLock;
  if (testFlashBtn) testFlashBtn.onclick = testFlash;

  dbg({
    note: "app_final11: fixed scan preset wiring; deferred test flash to avoid minimizing; shows scanRect in debug.",
    scanPreset: getScanPreset()
  });
})();
