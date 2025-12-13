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
        for (const k of ["data", "image", "capture", "payload"]) {
          const v = a[k];
          if (v && v.data && v.width && v.height) return v;
        }
      }
    }
    return null;
  }

  function ensureCaptureEventsStarted() {
    if (started) return;
    started = true;

    // If captureInterval is a numeric property, set it (enables capture on some builds)
    try {
      if (window.alt1 && typeof alt1.captureInterval === "number") {
        alt1.captureInterval = Math.max(50, alt1.captureInterval || 100);
      }
    } catch {}

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

    // Try calling captureEvents with a callback
    try {
      window.captureEvents(cb);
      diag.captureMode = "captureEvents(cb)";
      return;
    } catch (e) {
      diag.lastErr = (e && e.message) ? e.message : String(e);
    }

    // Try captureEvents() returning a subscription-like object
    try {
      const ret = window.captureEvents();
      diag.captureMode = "captureEvents()";
      if (ret) {
        if (typeof ret.on === "function") {
          ret.on("capture", cb);
          diag.captureMode = "captureEvents()+ret.on(capture)";
        } else if (typeof ret.addEventListener === "function") {
          ret.addEventListener("capture", cb);
          diag.captureMode = "captureEvents()+ret.addEventListener(capture)";
        } else if (typeof ret.subscribe === "function") {
          ret.subscribe(cb);
          diag.captureMode = "captureEvents()+ret.subscribe";
        }
      }
      return;
    } catch (e) {
      diag.lastErr = (e && e.message) ? e.message : String(e);
    }

    // Last resort: listen for window events (some builds dispatch DOM events)
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
