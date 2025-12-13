// matcher.js (Alt1-compatible: NO ES modules)
// ProgFlash capture + image matcher without relying on Alt1 version-specific APIs.
// Exposes on window:
//   - progflashCaptureRs(): ImageData | null
//   - progflashLoadImage(url): Promise<ImageData>
//   - progflashFindAnchor(haystack, needle, opts): match result

function isImageDataLike(obj) {
  return !!(obj && obj.data && typeof obj.width === "number" && typeof obj.height === "number");
}

function toImageData(obj) {
  if (!obj) return null;
  if (isImageDataLike(obj)) return obj;

  // Some capture handles expose conversion helpers
  try {
    if (typeof obj.toData === "function") {
      const out = obj.toData();
      if (isImageDataLike(out)) return out;
    }
  } catch {}
  try {
    if (typeof obj.toImageData === "function") {
      const out = obj.toImageData();
      if (isImageDataLike(out)) return out;
    }
  } catch {}
  return null;
}

/**
 * Capture RuneScape viewport pixels.
 * Your Alt1 build exposes captureInterval/captureMethod as *properties* only,
 * and does not expose alt1.capture()/alt1.captureHold().
 *
 * Alt1 itself typically injects a global captureRs() function in some builds.
 * We will use it if present; otherwise we fall back to a1lib capture if available.
 */
function progflashCaptureRs() {
  // 1) Prefer any existing global captureRs() provided by Alt1/runtime
  try {
    if (typeof window.captureRs === "function" && window.captureRs !== progflashCaptureRs) {
      // Try no-args first (most common)
      let cap = window.captureRs();
      let img = toImageData(cap);
      if (img) return img;

      // Try with RS viewport args if it expects them
      if (window.alt1 && (window.captureRs.length >= 4)) {
        const x = alt1.rsX || 0;
        const y = alt1.rsY || 0;
        const w = alt1.rsWidth || 0;
        const h = alt1.rsHeight || 0;
        cap = window.captureRs(x, y, w, h);
        img = toImageData(cap);
        if (img) return img;
      }
    }
  } catch (e) {
    console.error("global captureRs() failed", e);
  }

  // 2) Fallback: a1lib capture (not present in all web app contexts)
  try {
    if (window.a1lib && typeof a1lib.captureHoldFullRs === "function") {
      const cap = a1lib.captureHoldFullRs();
      const img = toImageData(cap);
      if (img) return img;
    }
  } catch (e) {
    console.error("a1lib.captureHoldFullRs failed", e);
  }

  try {
    if (window.a1lib && typeof a1lib.captureHold === "function" && window.alt1) {
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

// Luma-based template match with options and returnBest support
function progflashFindAnchor(hay, needle, opts = {}) {
  if (!hay || !needle) return null;

  const tolerance = opts.tolerance ?? 65;
  const stride = opts.stride ?? 1;
  const minScore = opts.minScore ?? 0.5;
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

// Expose without clobbering other libs
window.progflashCaptureRs = progflashCaptureRs;
window.progflashLoadImage = progflashLoadImage;
window.progflashFindAnchor = progflashFindAnchor;
