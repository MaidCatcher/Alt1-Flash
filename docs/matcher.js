// matcher.js — classic script (NO import/export). Must be loaded before app.js.
//
// Exposes:
//   window.progflashCaptureRs()  -> ImageData | null
//   window.progflashLoadImage(url) -> Promise<ImageData>
//   window.progflashFindAnchor(hay, needle, opts) -> {ok, x,y,w,h, score, best}

function _toImageData(maybe) {
  if (!maybe) return null;

  // Already ImageData-like
  if (maybe.data && typeof maybe.width === "number" && typeof maybe.height === "number") {
    return maybe;
  }

  // Some Alt1 capture handles expose converters
  try { if (typeof maybe.toData === "function") return maybe.toData(); } catch {}
  try { if (typeof maybe.toImageData === "function") return maybe.toImageData(); } catch {}

  return null;
}

function progflashCaptureRs() {
  // Alt1 injects a global captureRs() on some builds.
  // IMPORTANT: do NOT define a top-level function named captureRs in this file;
  // that would clobber Alt1's native one.
  try {
    if (typeof window.captureRs === "function") {
      const out = window.captureRs();
      const img = _toImageData(out);
      if (img) return img;
    }
  } catch (e) {
    console.error("native window.captureRs() threw", e);
  }

  // Some builds expose captureEvents() instead. We don't know its signature,
  // so just report it's present via app.js debug; return null here.
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

// Luma-based template match (small anchors)
function progflashFindAnchor(hay, needle, opts) {
  opts = opts || {};
  const tolerance = opts.tolerance ?? 65;
  const stride = opts.stride ?? 1;
  const minScore = opts.minScore ?? 0.50;
  const returnBest = !!opts.returnBest;

  if (!hay || !needle) return null;

  const hw = hay.width, hh = hay.height;
  const nw = needle.width, nh = needle.height;
  if (nw <= 0 || nh <= 0 || nw > hw || nh > hh) {
    return returnBest ? { ok: false, score: 0, best: null } : null;
  }

  const h = hay.data;
  const n = needle.data;

  // Precompute needle luminance
  const nLum = new Uint8Array(nw * nh);
  for (let j = 0; j < nh; j++) {
    for (let i = 0; i < nw; i++) {
      const idx = (j * nw + i) * 4;
      nLum[j * nw + i] = (n[idx] * 30 + n[idx+1] * 59 + n[idx+2] * 11) / 100;
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
          const lum = (h[hi] * 30 + h[hi+1] * 59 + h[hi+2] * 11) / 100;
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

window.progflashCaptureRs = progflashCaptureRs;
window.progflashLoadImage = progflashLoadImage;
window.progflashFindAnchor = progflashFindAnchor;
