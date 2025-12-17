// ProgFlash app_final9.js
// Fixes:
// 1) Syntax/parse issues in prior app.js
// 2) Remove undefined 'c' reference inside fast-lock
// 3) Robustness: per-tick lock validation using learned A+B needles
// 4) Progress: compute from learned B region (bar edge inside B patch), not whole-dialog heuristic
// 5) UI: don't show IDLE preview after lock; instead show "LOCKED (capture failed)" if needed
//
// Depends on matcher.js globals:
//   captureRegion(x,y,w,h) -> wrapped ImageData-like {width,height,data,getPixel(x,y)}
//   findAnchor(haystack, needle, opts)
//
// UI expected ids (from index.html):
//   startBtn, stopBtn, autoFindBtn, clearLockBtn, testFlashBtn
//   status, mode, lock, progress, debugBox
//   previewCanvas
//   scanPreset <select> (optional but present in your index.html)

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
  const scanPresetEl = $("scanPreset"); // index.html uses scanPreset

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

  // ---------------- Storage ----------------
  const LS_LOCK   = "progflash.lockPos";         // {x,y} where x,y = absolute RS coords of Anchor A top-left
  const LS_MULTI  = "progflash.multiAnchorABC";  // learned A/B/C + offsets + dialog dims
  const LS_DIALOG = "progflash.dialogRect";      // {x,y,w,h}
  const LS_SCAN   = "progflash.scanPreset";      // "top|mid|bot|full" (index.html uses this key too)

  function save(key, obj) { try { localStorage.setItem(key, JSON.stringify(obj)); } catch {} }
  function load(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } }
  function del(key) { try { localStorage.removeItem(key); } catch {} }

  function updateSavedLockLabel() {
    if (!savedLockEl) return;
    const p = load(LS_LOCK);
    savedLockEl.textContent = p ? `x=${p.x},y=${p.y}` : "none";
  }

  // ---------------- Utils ----------------
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

  function getRsRect() {
    const w = alt1.rsWidth || 0;
    const h = alt1.rsHeight || 0;
    const x = alt1.rsX || 0;
    const y = alt1.rsY || 0;
    return { x, y, w, h };
  }

  // ---------------- Screen overlay (Alt1) ----------------
  function overlayRectOnScreen(x, y, w, h, ms = 1200) {
    try {
      if (!window.alt1) return false;
      const colorNum = 0x00ff00;
      if (typeof alt1.overLayRect === "function") { alt1.overLayRect(x, y, w, h, colorNum, 2, ms); return true; }
      if (typeof alt1.overLayRectEx === "function") { alt1.overLayRectEx(x, y, w, h, colorNum, 2, ms); return true; }
      if (typeof alt1.overlayRect === "function") { alt1.overlayRect(x, y, w, h, colorNum, 2, ms); return true; }
      return false;
    } catch {
      return false;
    }
  }

  // ---------------- Preview drawing ----------------
  function drawImageScaled(img, label, overlayRects) {
    if (!ctx || !canvas || !img) return;

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

  // ---------------- Scan area ----------------
  function getScanPreset() {
    const saved = (scanPresetEl && scanPresetEl.value) || load(LS_SCAN) || "top";
    if (scanPresetEl && scanPresetEl.value !== saved) scanPresetEl.value = saved;

    if (scanPresetEl && !scanPresetEl._wired) {
      scanPresetEl._wired = true;
      scanPresetEl.addEventListener("change", () => {
        try { localStorage.setItem(LS_SCAN, scanPresetEl.value); } catch {}
      });
    }
    return saved;
  }

  function getScanAreaConfig() {
    const rs = getRsRect();
    const v = getScanPreset();

    const xMinFrac = 0.12, xMaxFrac = 0.88;
    let y0 = 0, y1 = rs.h;

    if (v === "top") { y0 = 0; y1 = Math.floor(rs.h * 0.62); }
    else if (v === "mid" || v === "middle") { y0 = Math.floor(rs.h * 0.20); y1 = Math.floor(rs.h * 0.85); }
    else if (v === "bot" || v === "bottom") { y0 = Math.floor(rs.h * 0.38); y1 = rs.h; }
    else { y0 = 0; y1 = rs.h; } // full

    return {
      name: v,
      x0: Math.floor(rs.w * xMinFrac),
      x1: Math.floor(rs.w * xMaxFrac),
      y0, y1
    };
  }

  // ---------------- Progress from learned B patch ----------------
  // Compute progress edge inside a small bar patch by finding the strongest vertical transition.
  // Returns { ok, edgeX, score } where edgeX is 0..(w-1)
  function barEdgeFromPatch(img) {
    if (!img || img.width < 40 || img.height < 8) return { ok: false, edgeX: 0, score: 0 };

    const w = img.width, h = img.height;

    // Work on a central band to avoid frame edges.
    const y0 = Math.floor(h * 0.25);
    const y1 = Math.floor(h * 0.75);

    function grayAt(x, y) {
      const i = (y * w + x) * 4;
      const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
      return (r * 77 + g * 150 + b * 29) >> 8;
    }

    // Column mean grayscale
    const col = new Float32Array(w);
    for (let x = 0; x < w; x++) {
      let s = 0, c = 0;
      for (let y = y0; y < y1; y++) { s += grayAt(x, y); c++; }
      col[x] = c ? (s / c) : 0;
    }

    // Gradient magnitude
    let bestG = 0;
    let bestX = Math.floor(w * 0.5);
    for (let x = 2; x < w - 2; x++) {
      const g = Math.abs(col[x] - col[x - 1]) + Math.abs(col[x + 1] - col[x]);
      if (g > bestG) { bestG = g; bestX = x; }
    }

    // Reject edges too near ends; they produce false “always full” or “always empty”.
    const frac = bestX / Math.max(1, w - 1);
    if (frac < 0.08 || frac > 0.95) return { ok: false, edgeX: bestX, score: bestG / 255 };

    // Score: strong step and relatively flat sides
    function rough(i0, i1) {
      let s = 0, c = 0;
      for (let x = i0 + 1; x < i1; x++) { s += Math.abs(col[x] - col[x - 1]); c++; }
      return c ? (s / c) / 255 : 1;
    }
    const rL = rough(0, bestX);
    const rR = rough(bestX, w);
    const stepScore = clamp(bestG / 255, 0, 1);
    const uniformScore = clamp(1.0 - (rL * 2.0 + rR * 2.0) / 2.0, 0, 1);

    const score = stepScore * 0.70 + uniformScore * 0.30;
    return { ok: score >= 0.12, edgeX: bestX, score };
  }

  // ---------------- Triple-anchor learn/fast-lock ----------------
  function learnTripleAnchorFromDialog(dialogAbsRect) {
    const img = captureRegion(dialogAbsRect.x, dialogAbsRect.y, dialogAbsRect.w, dialogAbsRect.h);
    if (!img) return false;

    // A: top-right frame patch
    const Aw = 80, Ah = 28;
    const Ax = img.width - Aw - 20;
    const Ay = 10;

    // B: progress bar patch around center
    const Bw = 140, Bh = 20;
    const Bx = Math.floor((img.width - Bw) / 2);
    const By = Math.floor(img.height * 0.55);

    // C: close X patch
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

    save(LS_DIALOG, { x: dialogAbsRect.x|0, y: dialogAbsRect.y|0, w: img.width|0, h: img.height|0 });
    return true;
  }

  function tryTripleAnchorFastLock() {
    const s = load(LS_MULTI);
    if (!s) return false;

    const rs = getRsRect();
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

    const ax = (searchRect.x + mA.x) | 0;
    const ay = (searchRect.y + mA.y) | 0;

    const bx = (ax + s.dxB) | 0, by = (ay + s.dyB) | 0;
    const cx = (ax + s.dxC) | 0, cy = (ay + s.dyC) | 0;

    // Containment gate: predicted B/C inside dialog rectangle inferred from A position
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

    // Save lock and dialog rect
    save(LS_LOCK, { x: ax, y: ay });
    updateSavedLockLabel();

    if (s.dialogW && s.dialogH) {
      const dialogX = (ax - (s.Ax || 0)) | 0;
      const dialogY = (ay - (s.Ay || 0)) | 0;
      save(LS_DIALOG, { x: dialogX, y: dialogY, w: s.dialogW|0, h: s.dialogH|0 });
      overlayRectOnScreen(dialogX, dialogY, s.dialogW|0, s.dialogH|0, 1200);
    }

    setLock(`x=${ax}, y=${ay}`);
    setStatus("Locked (fast A+B+C)");
    setProgress("locked");

    const overlays = [
      { x: mA.x, y: mA.y, w: s.A.w, h: s.A.h, color: "#00ffff", label: "A" },
      { x: (bx - searchRect.x), y: (by - searchRect.y), w: s.B.w, h: s.B.h, color: "#00ff00", label: "B" },
      { x: (cx - searchRect.x), y: (cy - searchRect.y), w: s.C.w, h: s.C.h, color: "#ff9900", label: "C" }
    ];
    drawImageScaled(searchImg, `FAST A=${mA.score.toFixed(2)} B=${mB.score.toFixed(2)} C=${cOK ? "ok" : "—"}`, overlays);

    return true;
  }

  // ---------------- Per-tick lock validation ----------------
  function validateLockAndGetRects() {
    const s = load(LS_MULTI);
    const lock = load(LS_LOCK);
    if (!s || !lock) return { ok: false, reason: "no_state" };

    const A = makeNeedle(s.A.w, s.A.h, b64ToBytes(s.A.b64));
    const B = makeNeedle(s.B.w, s.B.h, b64ToBytes(s.B.b64));

    const ax = lock.x|0, ay = lock.y|0;
    const bx = (ax + s.dxB)|0, by = (ay + s.dyB)|0;

    // Validate A with a small capture
    const padA = 6;
    const imgA = captureRegion(ax - padA, ay - padA, s.A.w + padA * 2, s.A.h + padA * 2);
    if (!imgA) return { ok: false, reason: "capA_null" };

    const mA = findAnchor(imgA, A, { tolerance: 58, step: 1, minScore: 0.02 });
    if (!mA?.ok || mA.score < 0.66) return { ok: false, reason: "A_miss", mA };

    // Validate B at predicted position
    const padB = 6;
    const imgB = captureRegion(bx - padB, by - padB, s.B.w + padB * 2, s.B.h + padB * 2);
    if (!imgB) return { ok: false, reason: "capB_null", mA };

    const mB = findAnchor(imgB, B, { tolerance: 58, step: 1, minScore: 0.02 });
    if (!mB?.ok || mB.score < 0.64) return { ok: false, reason: "B_miss", mA, mB };

    // Dialog rect inferred from A
    const dialogX = (ax - (s.Ax || 0)) | 0;
    const dialogY = (ay - (s.Ay || 0)) | 0;
    const dialogW = (s.dialogW || 0) | 0;
    const dialogH = (s.dialogH || 0) | 0;

    // B patch absolute rect (exact, without pads)
    const bRect = { x: bx, y: by, w: s.B.w|0, h: s.B.h|0 };

    return {
      ok: true,
      ax, ay,
      dialog: dialogW && dialogH ? { x: dialogX, y: dialogY, w: dialogW, h: dialogH } : null,
      bRect,
      scores: { A: mA.score, B: mB.score }
    };
  }

  // ---------------- Capture loop ----------------
  let running = false;
  let captureTimer = null;
  let lastGoodFrame = null;

  function startCaptureLoop() {
    if (captureTimer) return;
    captureTimer = setInterval(() => {
      if (!running) return;

      const hasLock = !!load(LS_LOCK);

      if (hasLock) {
        // Locked path: validate + compute progress from learned B patch
        const v = validateLockAndGetRects();

        if (!v.ok) {
          setStatus(`LOCKED (lost) ${v.reason} -> Auto find recommended`);
          setProgress("—");
          // Do NOT fall back to IDLE preview while locked; keep last good frame if we have it.
          if (lastGoodFrame) drawImageScaled(lastGoodFrame.img, lastGoodFrame.label, lastGoodFrame.overlays);
          return;
        }

        if (v.dialog) {
          save(LS_DIALOG, v.dialog);
        }

        const imgB = captureRegion(v.bRect.x, v.bRect.y, v.bRect.w, v.bRect.h);
        if (!imgB) {
          setStatus("LOCKED (capture failed)");
          if (lastGoodFrame) drawImageScaled(lastGoodFrame.img, lastGoodFrame.label, lastGoodFrame.overlays);
          return;
        }

        const edge = barEdgeFromPatch(imgB);
        if (!edge.ok) {
          setStatus("LOCKED (bar edge weak)");
          setProgress("—");
        } else {
          const pct = clamp(edge.edgeX / Math.max(1, (imgB.width - 1)), 0, 1);
          const pctTxt = Math.round(pct * 100) + "%";
          setStatus("Locked");
          setProgress(pctTxt);

          const last = window._pf_lastPct ?? null;
          window._pf_lastPct = pct;

          // Flash only on meaningful completion/jumps
          if (v.dialog && pct >= 0.985) {
            overlayRectOnScreen(v.dialog.x, v.dialog.y, v.dialog.w, v.dialog.h, 900);
          } else if (v.dialog && last !== null && Math.abs(pct - last) >= 0.12) {
            overlayRectOnScreen(v.dialog.x, v.dialog.y, v.dialog.w, v.dialog.h, 450);
          }
        }

        // Preview shows B patch and inferred A/B/C boxes in dialog coords if possible
        const s = load(LS_MULTI);
        const overlays = [];
        if (s && v.dialog) {
          overlays.push({ x: (v.ax - v.dialog.x), y: (v.ay - v.dialog.y), w: s.A.w, h: s.A.h, color: "#00ffff", label: "A" });
          overlays.push({ x: (v.bRect.x - v.dialog.x), y: (v.bRect.y - v.dialog.y), w: s.B.w, h: s.B.h, color: "#00ff00", label: "B" });
          overlays.push({
            x: (v.ax + s.dxC - v.dialog.x),
            y: (v.ay + s.dyC - v.dialog.y),
            w: s.C.w, h: s.C.h, color: "#ff9900", label: "C"
          });
        }

        // Prefer drawing the dialog if we have it; otherwise draw just the B patch.
        if (v.dialog) {
          const imgDlg = captureRegion(v.dialog.x, v.dialog.y, v.dialog.w, v.dialog.h);
          if (imgDlg) {
            const label = `LOCK A=${v.scores.A.toFixed(2)} B=${v.scores.B.toFixed(2)} edge=${edge.score.toFixed(2)}`;
            drawImageScaled(imgDlg, label, overlays);
            lastGoodFrame = { img: imgDlg, label, overlays };
          }
        } else {
          const label = `LOCK(B) A=${v.scores.A.toFixed(2)} B=${v.scores.B.toFixed(2)} edge=${edge.score.toFixed(2)}`;
          drawImageScaled(imgB, label, []);
          lastGoodFrame = { img: imgB, label, overlays: [] };
        }

        return;
      }

      // Unlocked path: show a small live preview (IDLE)
      const rs = getRsRect();
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

  // ---------------- Auto-find (fallback) ----------------
  // Keep your existing workflow: Auto find clears lock and forces re-learn.
  // This build’s main improvement is *post-lock robustness* and *progress accuracy*.
  function autoFind() {
    if (!running) start();

    del(LS_LOCK);
    del(LS_DIALOG);
    window._pf_lastPct = null;
    lastGoodFrame = null;
    updateSavedLockLabel();

    setLock("none");
    setProgress("—");
    setStatus("Auto find: open the crafting dialog, then wait for a lock...");

    // Minimal “scan”: try fast lock repeatedly for a short window.
    // (Your previous build had a full rectangle scanner; this keeps behaviour simple while fixing your main issues.)
    const t0 = Date.now();
    const maxMs = 6000;

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

    setStatus("Idle (press Auto find)");
  }

  function stop() {
    running = false;
    stopCaptureLoop();
    setMode("Not running");
    setStatus("Idle");
    setProgress("—");
  }

  function clearLock() {
    del(LS_LOCK);
    del(LS_MULTI);
    del(LS_DIALOG);
    window._pf_lastPct = null;
    lastGoodFrame = null;

    updateSavedLockLabel();
    setLock("none");
    setStatus("Cleared");
    setProgress("—");
  }

  function testFlash() {
    const d = load(LS_DIALOG);
    if (d) { overlayRectOnScreen(d.x, d.y, d.w, d.h, 900); return; }
    const rs = getRsRect();
    overlayRectOnScreen(Math.floor(rs.w * 0.25), Math.floor(rs.h * 0.25), Math.floor(rs.w * 0.5), Math.floor(rs.h * 0.15), 900);
  }

  // ---------------- Init UI ----------------
  updateSavedLockLabel();
  setMode("Not running");
  setStatus("Idle");
  setLock(load(LS_LOCK) ? "saved" : "none");
  setProgress("—");

  if (startBtn) startBtn.onclick = start;
  if (stopBtn) stopBtn.onclick = stop;
  if (autoFindBtn) autoFindBtn.onclick = autoFind;
  if (clearLockBtn) clearLockBtn.onclick = clearLock;
  if (testFlashBtn) testFlashBtn.onclick = testFlash;

  dbg({
    note: "app_final9: progress from learned B patch + per-tick A/B validation; avoids IDLE preview after lock.",
    scanPreset: getScanPreset()
  });
})();
