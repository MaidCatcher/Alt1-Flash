// matcher.js — Alt1 classic script
// Goal: get frames via native captureEvents (varargs, opaque signature) on this Alt1 build.
//
// Observed environment:
// - window.captureEvents exists (native) but captureEvents(cb) does not fire on its own.
// - alt1.captureMethod is a STRING (e.g. "OpenGL"), alt1.captureInterval is a NUMBER.
// - a1lib is missing.
// So: we prime capture by setting alt1.captureInterval and then call captureEvents() (no args),
// attach listeners on the returned object if any, AND also attach window event listeners for
// likely event names. We keep diagnostics in window.progflashCaptureDiag.

(function () {
  const diag = {
    captureMode: "",
    lastErr: "",
    cbCount: 0,
    argSample: "",
    retSummary: "",
    hasFrame: false,
  };

  let started = false;
  let lastFrame = null;

  function safeStr(v) {
    try { return String(v); } catch { return "[unstringifiable]"; }
  }

  function summarizeValue(v) {
    if (v == null) return String(v);
    const t = typeof v;
    if (t === "string" || t === "number" || t === "boolean") return `${t}:${v}`;
    if (Array.isArray(v)) return `array(len=${v.length})`;
    if (v.data && v.width && v.height) return `ImageDataLike(${v.width}x${v.height})`;
    const keys = Object.keys(v).slice(0, 12);
    return `${t} keys=[${keys.join(",")}]`;
  }

  function tryExtractFrameFromArgs(args) {
    for (const a of args) {
      if (!a) continue;

      // ImageData-like
      if (a.data && a.width && a.height) return a;

      // Common wrappers
      if (a.imageData && a.imageData.data && a.imageData.width) return a.imageData;
      if (a.img && a.img.data && a.img.width) return a.img;
      if (a.frame && a.frame.data && a.frame.width) return a.frame;

      // Nested payloads
      if (typeof a === "object") {
        for (const k of ["data", "image", "capture", "payload", "detail", "value"]) {
          const v = a[k];
          if (v && v.data && v.width && v.height) return v;
        }
      }
    }
    return null;
  }

  function enableAlt1Capture() {
    if (!window.alt1) return;

    // These are PROPERTIES on your build.
    try {
      if (typeof alt1.captureMethod === "string") {
        if (!alt1.captureMethod) alt1.captureMethod = "OpenGL";
      }
    } catch (e) {
      diag.lastErr = `enable captureMethod failed: ${e && e.message ? e.message : safeStr(e)}`;
    }

    try {
      if (typeof alt1.captureInterval === "number") {
        // Setting it again is a "kick" on some builds.
        alt1.captureInterval = Math.max(50, alt1.captureInterval || 100);
      } else if (alt1.captureInterval == null) {
        alt1.captureInterval = 100;
      }
    } catch (e) {
      diag.lastErr = `enable captureInterval failed: ${e && e.message ? e.message : safeStr(e)}`;
    }
  }

  function onCaptureEvent() {
    try {
      diag.cbCount++;
      const args = Array.from(arguments);

      if (!diag.argSample) {
        diag.argSample = args.map(summarizeValue).join(" | ");
      }

      const frame = tryExtractFrameFromArgs(args);
      if (frame) {
        lastFrame = frame;
        diag.hasFrame = true;
      }
    } catch (e) {
      diag.lastErr = e && e.message ? e.message : safeStr(e);
    }
  }

  function attachToReturnObject(ret) {
    if (!ret || typeof ret !== "object") return false;

    // Record basic shape
    try {
      const keys = Object.keys(ret).slice(0, 20);
      diag.retSummary = `ret type=object keys=[${keys.join(",")}]`;
    } catch {}

    // Common subscription patterns
    try {
      if (typeof ret.on === "function") {
        ret.on("capture", onCaptureEvent);
        diag.captureMode += " + ret.on(capture)";
        return true;
      }
    } catch {}

    try {
      if (typeof ret.addEventListener === "function") {
        ret.addEventListener("capture", onCaptureEvent);
        diag.captureMode += " + ret.addEventListener(capture)";
        return true;
      }
    } catch {}

    try {
      if (typeof ret.subscribe === "function") {
        ret.subscribe(onCaptureEvent);
        diag.captureMode += " + ret.subscribe";
        return true;
      }
    } catch {}

    // Sometimes it's an EventTarget with different event name
    try {
      if (typeof ret.addEventListener === "function") {
        for (const ev of ["frame", "captureFrame", "captured", "data"]) {
          ret.addEventListener(ev, onCaptureEvent);
        }
        diag.captureMode += " + ret.addEventListener(multi)";
        return true;
      }
    } catch {}

    return false;
  }

  function attachWindowListeners() {
    // Try a few likely names (we don't know what native uses)
    const names = ["capture", "captured", "frame", "captureFrame", "alt1capture", "alt1-capture"];
    for (const name of names) {
      try {
        window.addEventListener(name, (ev) => {
          // Try pass (event, detail, data)
          onCaptureEvent(ev, ev && ev.detail, ev && ev.data);
        });
      } catch {}
    }
  }

  function ensureStarted() {
    if (started) return;
    started = true;

    if (typeof window.captureEvents !== "function") {
      diag.captureMode = "no captureEvents";
      return;
    }

    enableAlt1Capture();
    attachWindowListeners();

    // IMPORTANT: On your build captureEvents(cb) appears to "succeed" but never fires.
    // So we ALWAYS do a priming call first, then try callback registration.
    let ret;
    try {
      ret = window.captureEvents(); // prime/start
      diag.captureMode = "captureEvents()";
    } catch (e) {
      diag.lastErr = e && e.message ? e.message : safeStr(e);
      diag.captureMode = "captureEvents() threw";
    }

    // Attach to returned object if possible
    try {
      if (attachToReturnObject(ret)) {
        // good
      }
    } catch (e) {
      diag.lastErr = e && e.message ? e.message : safeStr(e);
    }

    // Now attempt callback registration (even if it might be ignored)
    try {
      window.captureEvents(onCaptureEvent);
      diag.captureMode += " + captureEvents(cb)";
    } catch (e) {
      diag.lastErr = e && e.message ? e.message : safeStr(e);
      diag.captureMode += " + captureEvents(cb) threw";
    }

    // As another kick, re-apply interval after hook
    enableAlt1Capture();

    // If we still have no retSummary, record what ret is
    if (!diag.retSummary) {
      diag.retSummary = summarizeValue(ret);
    }
  }

  function progflashCaptureRs() {
    ensureStarted();
    return lastFrame;
  }

  function progflashLoadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.src = url;
      img.onload = () => {
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const ctx = c.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        resolve(ctx.getImageData(0, 0, c.width, c.height));
      };
      img.onerror = reject;
    });
  }

  // Luma-based match
  function progflashFindAnchor(hay, needle, opts = {}) {
    if (!hay || !needle) return null;

    const tolerance = opts.tolerance ?? 65;
    const stride = opts.stride ?? 1;
    const minScore = opts.minScore ?? 0.5;
    const returnBest = !!opts.returnBest;

    const hw = hay.width, hh = hay.height;
    const nw = needle.width, nh = needle.height;
    if (nw > hw || nh > hh) return returnBest ? { ok: false, score: 0, best: null } : null;

    const h = hay.data;
    const n = needle.data;

    // precompute needle luminance
    const nLum = new Uint8Array(nw * nh);
    for (let j = 0; j < nh; j++) {
      for (let i = 0; i < nw; i++) {
        const idx = (j * nw + i) * 4;
        nLum[j * nw + i] = (n[idx] * 30 + n[idx + 1] * 59 + n[idx + 2] * 11) / 100;
      }
    }

    let bestScore = -1;
    let best = null;
    const total = nw * nh;

    for (let y = 0; y <= hh - nh; y += stride) {
      for (let x = 0; x <= hw - nw; x += stride) {
        let good = 0;
        for (let j = 0; j < nh; j++) {
          for (let i = 0; i < nw; i++) {
            const hi = ((y + j) * hw + (x + i)) * 4;
            const lum = (h[hi] * 30 + h[hi + 1] * 59 + h[hi + 2] * 11) / 100;
            if (Math.abs(lum - nLum[j * nw + i]) <= tolerance) good++;
          }
        }

        const score = good / total;
        if (score > bestScore) {
          bestScore = score;
          best = { x, y, w: nw, h: nh };
        }
        if (score >= minScore) {
          return returnBest ? { ok: true, x, y, w: nw, h: nh, score, best } : { x, y, w: nw, h: nh };
        }
      }
    }

    return returnBest ? { ok: false, score: bestScore, best } : null;
  }

  window.progflashCaptureRs = progflashCaptureRs;
  window.progflashLoadImage = progflashLoadImage;
  window.progflashFindAnchor = progflashFindAnchor;
  window.progflashCaptureDiag = diag;
})();
