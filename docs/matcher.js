// matcher.js (Alt1 classic script) — captureEvents integration + diagnostics
(function () {
  const diag = {
    captureMode: "",
    lastErr: "",
    cbCount: 0,
    argSample: "",
    hasFrame: false,
  };

  let started = false;
  let lastFrame = null;

  function summarizeArg(a) {
    if (a == null) return String(a);
    const t = typeof a;
    if (t === "string" || t === "number" || t === "boolean") return `${t}:${a}`;
    if (Array.isArray(a)) return `array(len=${a.length})`;
    if (a.data && a.width && a.height) return `ImageDataLike(${a.width}x${a.height})`;
    const keys = Object.keys(a).slice(0, 12);
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

      // Some implementations pass (type, payload)
      if (typeof a === "object") {
        for (const k of ["data", "image", "capture", "payload", "detail"]) {
          const v = a[k];
          if (v && v.data && v.width && v.height) return v;
        }
      }
    }
    return null;
  }

  // NEW: explicitly enable capture on builds where captureEvents won't fire until this is set
  function enableAlt1Capture() {
    if (!window.alt1) return;

    try {
      // captureMethod is a STRING on your build (ex: "OpenGL")
      if (typeof alt1.captureMethod === "string") {
        if (!alt1.captureMethod) alt1.captureMethod = "OpenGL";
        // Keep whatever it is, but if it's empty, force OpenGL
      } else if (alt1.captureMethod == null) {
        // In case some builds allow setting it even if it wasn't present
        alt1.captureMethod = "OpenGL";
      }
    } catch (e) {
      diag.lastErr = `enable captureMethod failed: ${e && e.message ? e.message : String(e)}`;
    }

    try {
      // captureInterval is a NUMBER on your build
      if (typeof alt1.captureInterval === "number") {
        // Set it even if already set; this is the "arming" signal on some builds
        alt1.captureInterval = Math.max(50, alt1.captureInterval || 100);
      } else if (alt1.captureInterval == null) {
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
          diag.argSample = args.map(summarizeArg).join(" | ");
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

    // ---- Strategy A: subscribe directly (what you already tried) ----
    try {
      window.captureEvents(cb);
      diag.captureMode = "captureEvents(cb)";
      return;
    } catch (e) {
      diag.lastErr = (e && e.message) ? e.message : String(e);
    }

    // ---- Strategy B (NEW): "start" captureEvents first, then subscribe ----
    // Some native implementations require a priming call before callbacks fire.
    try {
      const ret0 = window.captureEvents(); // prime/start
      // Try again with callback after priming
      try {
        window.captureEvents(cb);
        diag.captureMode = "captureEvents(); captureEvents(cb)";
        return;
      } catch (e2) {
        // If callback form isn't accepted, try attaching to returned object
        if (ret0) {
          if (typeof ret0.on === "function") {
            ret0.on("capture", cb);
            diag.captureMode = "captureEvents(); ret.on(capture)";
            return;
          } else if (typeof ret0.addEventListener === "function") {
            ret0.addEventListener("capture", cb);
            diag.captureMode = "captureEvents(); ret.addEventListener(capture)";
            return;
          } else if (typeof ret0.subscribe === "function") {
            ret0.subscribe(cb);
            diag.captureMode = "captureEvents(); ret.subscribe";
            return;
          }
        }
        diag.lastErr = (e2 && e2.message) ? e2.message : String(e2);
      }

      // If priming worked but we couldn't attach, at least record it
      diag.captureMode = "captureEvents() (primed, no hook)";
      return;
    } catch (e) {
      diag.lastErr = (e && e.message) ? e.message : String(e);
    }

    // ---- Strategy C: last resort DOM event listener ----
    try {
      window.addEventListener("capture", (ev) => cb(ev, ev && ev.detail));
      diag.captureMode = "window.addEventListener(capture)";
    } catch (e) {
      diag.lastErr = (e && e.message) ? e.message : String(e);
    }
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

  // Luma-based match (more robust than using only red channel)
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
