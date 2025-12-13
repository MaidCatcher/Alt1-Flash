// matcher.js — NO exports, Alt1-compatible

function progflashCaptureRs() {
  // Alt1 injects this globally
  if (typeof window.captureRs === "function") {
    try {
      const img = window.captureRs();
      if (img && img.data && img.width && img.height) return img;
    } catch (e) {
      console.error("global captureRs failed", e);
    }
  }
  return null;
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
  const minScore = opts.minScore ?? 0.5;

  const hw = hay.width, hh = hay.height;
  const nw = needle.width, nh = needle.height;

  let bestScore = -1;
  let best = null;

  for (let y = 0; y <= hh - nh; y++) {
    for (let x = 0; x <= hw - nw; x++) {
      let good = 0;
      for (let j = 0; j < nh; j++) {
        for (let i = 0; i < nw; i++) {
          const hi = ((y + j) * hw + (x + i)) * 4;
          const ni = (j * nw + i) * 4;
          const hL = hay.data[hi];
          const nL = needle.data[ni];
          if (Math.abs(hL - nL) <= tolerance) good++;
        }
      }
      const score = good / (nw * nh);
      if (score > bestScore) {
        bestScore = score;
        best = { x, y, w: nw, h: nh };
      }
      if (score >= minScore) {
        return { ok: true, x, y, w: nw, h: nh, score };
      }
    }
  }
  return { ok: false, score: bestScore, best };
}

// expose globally
window.progflashCaptureRs = progflashCaptureRs;
window.progflashLoadImage = progflashLoadImage;
window.progflashFindAnchor = progflashFindAnchor;
