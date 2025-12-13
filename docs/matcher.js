// matcher.js (Alt1-compatible: NO ES modules)
// Exposes: window.captureRs, window.loadImage, window.findAnchor
//
// IMPORTANT: Your Alt1 build does NOT provide callable alt1.capture()/alt1.captureHold()/alt1.captureMethod().
// Use a1lib capture instead (this is what most Alt1 apps rely on).

function toImageData(cap) {
  if (!cap) return null;

  // Already ImageData-like
  if (cap.data && typeof cap.width === "number" && typeof cap.height === "number") {
    return cap;
  }

  // Capture handle conversions (vary by Alt1 build)
  try { if (typeof cap.toData === "function") return cap.toData(); } catch {}
  try { if (typeof cap.toImageData === "function") return cap.toImageData(); } catch {}

  return null;
}

function captureRs() {
  // Prefer a1lib (most consistent across Alt1 builds)
  if (!window.a1lib) return null;
  if (window.alt1 && !alt1.permissionPixel) return null;

  // 1) Best option: full RuneScape capture
  try {
    if (typeof a1lib.captureHoldFullRs === "function") {
      const cap = a1lib.captureHoldFullRs();
      const img = toImageData(cap);
      if (img) return img;
    }
  } catch (e) {
    console.error("a1lib.captureHoldFullRs failed", e);
  }

  // 2) Fallback: capture the RS viewport region (screen coords)
  try {
    if (typeof a1lib.captureHold === "function" && window.alt1) {
      const x = alt1.rsX || 0;
      const y = alt1.rsY || 0;
      const w = alt1.rsWidth || 0;
      const h = alt1.rsHeight || 0;
      if (w && h) {
        const cap = a1lib.captureHold(x, y, w, h);
        const img = toImageData(cap);
        if (img) return img;
      }
    }
  } catch (e) {
    console.error("a1lib.captureHold failed", e);
  }

  return null;
}

function loadImage(url) {
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

// Luma-based template match w/ options and returnBest support
function findAnchor(hay, needle, opts = {}) {
  if (!hay || !needle) return null;

  const tolerance = opts.tolerance ?? 65;
  const stride = opts.stride ?? 1;
  const minScore = opts.minScore ?? 0.50;
  const returnBest = !!opts.returnBest;

  const hw = hay.width, hh = hay.height;
  const nw = needle.width, nh = needle.height;
  if (nw > hw || nh > hh) {
    return returnBest ? { ok: false, score: 0, best: null } : null;
  }

  const h = hay.data;
  const n = needle.data;

  // Precompute needle luminance
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
        return returnBest
          ? { ok: true, x, y, w: nw, h: nh, score, best }
          : { x, y, w: nw, h: nh };
      }
    }
  }

  return returnBest ? { ok: false, score: bestScore, best } : null;
}

window.captureRs = captureRs;
window.loadImage = loadImage;
window.findAnchor = findAnchor;
