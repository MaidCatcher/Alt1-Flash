// matcher.js — Alt1-safe, getRegion-based capture

(function () {
  if (!window.alt1) {
    console.error("Alt1 missing");
    return;
  }

  // ---- Image loader ----
  window.progflashLoadImage = async function (src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  };

  // ---- Capture RuneScape viewport ----
  window.progflashCaptureRs = function () {
    if (!alt1.permissionPixel) return null;

    try {
      return alt1.getRegion(
        alt1.rsX || 0,
        alt1.rsY || 0,
        alt1.rsWidth,
        alt1.rsHeight
      );
    } catch (e) {
      console.error("getRegion failed", e);
      return null;
    }
  };

  // ---- Anchor matching ----
  window.progflashFindAnchor = function (img, anchor, opts = {}) {
    const {
      tolerance = 50,
      minScore = 0.4
    } = opts;

    if (!img || !anchor) return { ok: false };

    const res = alt1.findSubimage
      ? alt1.findSubimage(img, anchor, tolerance)
      : [];

    if (!res || !res.length) return { ok: false };

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

  console.log("matcher.js loaded (getRegion)");
})();

// ---- ProgFlash global exports + compatibility aliases ----

// Primary exports
window.progflashFindAnchor = progflashFindAnchor;
window.progflashCaptureRs  = progflashCaptureRs;
window.progflashLoadImage  = progflashLoadImage;

// Compatibility aliases expected by app.js
window.findAnchor = progflashFindAnchor;
window.captureRs  = progflashCaptureRs;
window.loadImage  = progflashLoadImage;

// Sanity log
console.log("matcher.js loaded (findAnchor, captureRs, loadImage ready)");
