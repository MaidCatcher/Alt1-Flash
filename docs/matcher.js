// matcher.js — classic script, Alt1-compatible
// Exposes globals:
//   window.progflashCaptureRs
//   window.progflashLoadImage
//   window.progflashFindAnchor
// Also exposes diagnostics:
//   window.progflashCaptureDiag

(function () {
  const diag = {
    captureMode: "",
    lastErr: "",
    cbCount: 0,
    argSample: "",
    hasFrame: false,
    retSummary: ""
  };

  let lastFrame = null;
  let started = false;

  function summarize(obj) {
    try {
      if (!obj) return String(obj);
      const t = typeof obj;
      if (t !== "object" && t !== "function") return `${t}:${String(obj)}`;
      const keys = Object.keys(obj).slice(0, 20);
      return `${t} keys=[${keys.join(",")}]`;
    } catch {
      return "unprintable";
    }
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

      // Nested candidates
      if (typeof a === "object") {
        for (const k of ["data", "image", "capture", "payload", "detail"]) {
          const v = a[k];
          if (v && v.data && v.width && v.height) return v;
        }
      }

      // Conversion helpers
      if (typeof a.toImageData === "function") {
        const img = a.toImageData();
        if (img && img.data && img.width && img.height) return img;
      }
      if (typeof a.toData === "function") {
        const img = a.toData();
        if (img && img.data && img.width && img.height) return img;
      }
    }
    return null;
  }

  // Enable capture on builds where captureEvents won't fire until these are set
  function enableAlt1Capture() {
    if (!window.alt1) return;
    try {
      // captureMethod is a STRING on your build (ex: "OpenGL")
      if (typeof alt1.captureMethod === "string") {
        alt1.captureMethod = alt1.captureMethod || "OpenGL";
      } else {
        alt1.captureMethod = "OpenGL";
      }
    } catch (e) {
      diag.lastErr = `enable captureMethod failed: ${e && e.message ? e.message : String(e)}`;
    }

    try {
      // captureInterval is a NUMBER on your build
      if (typeof alt1.captureInterval === "number") {
        alt1.captureInterval = Math.max(50, alt1.captureInterval || 100);
      } else {
        alt1.captureInterval = 100;
      }
    } catch (e) {
      diag.lastErr = `enable captureInterval failed: ${e && e.message ? e.message : String(e)}`;
    }
  }

  function ensureCaptureEventsStarted() {
    if (started) return;
    started = true;

    enableAlt1Capture();

    if (typeof window.captureEvents !== "function") {
      diag.captureMode = "no captureEvents";
      return;
    }

    const cb = function () {
      try {
        diag.cbCount++;
        const args = Array.from(arguments);

        if (!diag.argSample) {
          diag.argSample = args.map(a => summarize(a)).join(" | ");
        }

        const frame = tryExtractFrameFromArgs(args);
        if (frame) {
          lastFrame = frame;
          diag.hasFrame = true;
        }
      } catch (e) {
        diag.lastErr = (e && e.message) ? e.message : String(e);
      }
    };

    // Prime call (some builds require this)
    let ret = null;
    try {
      ret = window.captureEvents();
      diag.retSummary = summarize(ret);
    } catch (e) {
      // ignore, still try other patterns
    }

    // Attach to returned object if it has a subscription API
    try {
      if (ret && typeof ret.on === "function") {
        ret.on("capture", cb);
        diag.captureMode += (diag.captureMode ? " + " : "") + "ret.on('capture')";
      }
      if (ret && typeof ret.addEventListener === "function") {
        ret.addEventListener("capture", cb);
        diag.captureMode += (diag.captureMode ? " + " : "") + "ret.addEventListener('capture')";
      }
      if (ret && typeof ret.subscribe === "function") {
        ret.subscribe(cb);
        diag.captureMode += (diag.captureMode ? " + " : "") + "ret.subscribe(cb)";
      }
    } catch (e) {
      diag.lastErr = (e && e.message) ? e.message : String(e);
    }

    // Try common call signatures (varargs native; may accept extra args)
    const patterns = [
      ["captureEvents(cb)", () => window.captureEvents(cb)],
      ["captureEvents('capture',cb)", () => window.captureEvents("capture", cb)],
      ["captureEvents('rs',cb)", () => window.captureEvents("rs", cb)],
      ["captureEvents({type:'capture'},cb)", () => window.captureEvents({ type: "capture" }, cb)]
    ];

    for (const [name, fn] of patterns) {
      try {
        fn();
        diag.captureMode += (diag.captureMode ? " + " : "") + name;
      } catch (e) {
        // swallow, keep trying
        if (!diag.lastErr) diag.lastErr = (e && e.message) ? e.message : String(e);
      }
    }

    // DOM event fallback (sometimes native dispatches events)
    const evNames = ["capture", "Capture", "captureevent", "captureEvent", "frame", "rsCapture"];
    for (const ev of evNames) {
      try {
        window.addEventListener(ev, (e) => cb(e, e && e.detail));
        diag.captureMode += (diag.captureMode ? " + " : "") + `window.on('${ev}')`;
      } catch {}
    }

    // Re-arm interval after hooks are attached (some builds need this)
    enableAlt1Capture();

    // If nothing arrives quickly, keep a helpful hint in lastErr
    setTimeout(() => {
      if (diag.cbCount === 0 && !diag.lastErr) {
        diag.lastErr = "captureEvents subscribed but no callbacks. Check Alt1: Linked windows (RuneScape ticked) + View Screen enabled + correct capture mode.";
      }
    }, 1200);
  }

  function progflashCaptureRs() {
    ensureCaptureEventsStarted();
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
