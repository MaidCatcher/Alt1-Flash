// matcher.js — NO modules. Uses Alt1 event-driven capture via window.captureEvents() if available.

(function () {
  let lastFrame = null;
  let captureStarted = false;
  let captureMode = "none";
  let lastCaptureErr = "";

  function toImageData(maybe) {
    if (!maybe) return null;
    if (maybe.data && typeof maybe.width === "number" && typeof maybe.height === "number") return maybe;

    try { if (typeof maybe.toData === "function") return maybe.toData(); } catch {}
    try { if (typeof maybe.toImageData === "function") return maybe.toImageData(); } catch {}

    if (maybe.img && maybe.img.data) return maybe.img;
    return null;
  }

  function hookReturn(ret, cb) {
    if (!ret) return;

    try {
      if (typeof ret.on === "function") {
        ret.on("frame", cb);
        ret.on("capture", cb);
        ret.on("data", cb);
        captureMode += "+ret.on";
        return;
      }
    } catch {}

    try {
      if (typeof ret.addEventListener === "function") {
        ret.addEventListener("frame", (e) => cb(e && e.detail ? e.detail : e));
        ret.addEventListener("capture", (e) => cb(e && e.detail ? e.detail : e));
        captureMode += "+ret.addEventListener";
        return;
      }
    } catch {}

    try {
      if (typeof ret.subscribe === "function") {
        ret.subscribe(cb);
        captureMode += "+ret.subscribe";
        return;
      }
    } catch {}
  }

  function startCaptureEvents() {
    if (captureStarted) return;
    captureStarted = true;

    if (typeof window.captureEvents !== "function") {
      captureMode = "no-captureEvents";
      return;
    }

    const cb = function (...args) {
      // Look for ImageData-like in args
      for (const a of args) {
        const img = toImageData(a);
        if (img) { lastFrame = img; return; }
      }
      if (args.length >= 2) {
        const img = toImageData(args[1]);
        if (img) { lastFrame = img; return; }
      }
    };

    // Try captureEvents(cb)
    try {
      const ret = window.captureEvents(cb);
      captureMode = "captureEvents(cb)";
      hookReturn(ret, cb);
      return;
    } catch (e1) {
      lastCaptureErr = String(e1 && e1.message ? e1.message : e1);
    }

    // Try captureEvents() returning something
    try {
      const ret = window.captureEvents();
      captureMode = "captureEvents()";
      hookReturn(ret, cb);
      return;
    } catch (e2) {
      lastCaptureErr = String(e2 && e2.message ? e2.message : e2);
    }

    captureMode = "captureEvents(unusable)";
  }

  function progflashCaptureRs() {
    startCaptureEvents();

    if (lastFrame) return lastFrame;

    // Last resort: older global captureRs
    try {
      if (typeof window.captureRs === "function") {
        const img = toImageData(window.captureRs());
        if (img) {
          lastFrame = img;
          captureMode = "window.captureRs()";
          return img;
        }
      }
    } catch (e) {
      lastCaptureErr = String(e && e.message ? e.message : e);
    }

    return null;
  }

  function progflashCaptureInfo() {
    return { started: captureStarted, mode: captureMode, lastErr: lastCaptureErr };
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

  function progflashFindAnchor(hay, needle, opts = {}) {
    const tolerance = opts.tolerance ?? 65;
    const stride = opts.stride ?? 1;
    const minScore = opts.minScore ?? 0.5;
    const returnBest = !!opts.returnBest;

    if (!hay || !needle) return returnBest ? { ok: false, score: 0, best: null } : null;

    const hw = hay.width, hh = hay.height;
    const nw = needle.width, nh = needle.height;
    if (nw <= 0 || nh <= 0 || nw > hw || nh > hh) {
      return returnBest ? { ok: false, score: 0, best: null } : null;
    }

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
        if (score > bestScore) { bestScore = score; best = { x, y, w: nw, h: nh }; }
        if (score >= minScore) {
          return returnBest ? { ok: true, x, y, w: nw, h: nh, score, best } : { x, y, w: nw, h: nh };
        }
      }
    }

    return returnBest ? { ok: false, score: bestScore, best } : null;
  }

  window.progflashCaptureRs = progflashCaptureRs;
  window.progflashCaptureInfo = progflashCaptureInfo;
  window.progflashLoadImage = progflashLoadImage;
  window.progflashFindAnchor = progflashFindAnchor;
})();
