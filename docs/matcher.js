// matcher.js
// Minimal, stable matcher for Alt1 using a1lib (NO alt1.captureScreen)

(function () {
  if (!window.alt1 || !window.a1lib) {
    console.error("Alt1 or a1lib missing");
    return;
  }

  // --- Load image helper ---
  window.progflashLoadImage = async function (src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  };

  // --- Capture region helper ---
  window.progflashCaptureRs = function () {
    if (!alt1.permissionPixel) return null;

    const x = alt1.rsX || 0;
    const y = alt1.rsY || 0;
    const w = alt1.rsWidth;
    const h = alt1.rsHeight;

    if (!w || !h) return null;

    try {
      return a1lib.capture(x, y, w, h);
    } catch (e) {
      console.error("capture failed", e);
      return null;
    }
  };

  // --- Anchor matcher ---
  window.progflashFindAnchor = function (img, anchor, opts = {}) {
    const {
      tolerance = 60,
      minScore = 0.4,
      returnBest = true
    } = opts;

    const res = a1lib.findSubimage(img, anchor, tolerance);

    if (!res || !res.length) {
      return { ok: false };
    }

    let best = res[0];
    for (const r of res) {
      if (r.score > best.score) best = r;
    }

    return {
      ok: best.score >= minScore,
      score: best.score,
      x: best.x,
      y: best.y,
      best
    };
  };

  console.log("matcher.js loaded");
})();
