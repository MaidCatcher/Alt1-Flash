// matcher.js — browser-only, Alt1-safe
//
// Minimal image capture + template matching for Alt1 apps.
// Supports configurable matching parameters and (optionally) returning the best match.

export function captureRs() {
  if (!window.alt1) return null;
  if (typeof alt1.captureHoldFullRs === "function") return alt1.captureHoldFullRs();
  if (typeof alt1.capture === "function") return alt1.capture();
  return null;
}

export function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to load image: " + url));
    // Cache bust so updated anchors are picked up immediately
    img.src = url + "?v=" + Date.now();
  });
}

/**
 * Find a small template (needleImg) inside an ImageData-like haystack.
 *
 * Options:
 *  - tolerance: per-channel (RGB) absolute difference allowed (default 50)
 *  - stride: scanning step in pixels for x/y (default 1). Use 1 for small anchors.
 *  - sampleStride: subsample template pixels (default 1). 1 = use all pixels.
 *  - minScore: [0..1] fraction of sampled pixels that must match (default 0.55)
 *  - returnBest: if true, returns best candidate even if below minScore
 *
 * Returns:
 *  - if returnBest=false: {x,y,w,h,score} or null
 *  - if returnBest=true:  {x,y,w,h,score,ok} (ok indicates score>=minScore)
 */
export function findAnchor(haystack, needleImg, opts = {}) {
  const {
    tolerance = 50,
    stride = 1,
    sampleStride = 1,
    minScore = 0.55,
    returnBest = false,
  } = opts || {};

  if (!haystack || !needleImg) return null;

  const hw = haystack.width;
  const hh = haystack.height;

  const nc = document.createElement("canvas");
  nc.width = needleImg.width;
  nc.height = needleImg.height;
  const nctx = nc.getContext("2d", { willReadFrequently: true });
  nctx.drawImage(needleImg, 0, 0);
  const needle = nctx.getImageData(0, 0, nc.width, nc.height).data;

  const nw = nc.width;
  const nh = nc.height;

  if (nw <= 0 || nh <= 0) return null;
  if (nw > hw || nh > hh) return null;

  // Precompute sampled pixel offsets for the template
  const offsets = [];
  for (let y = 0; y < nh; y += sampleStride) {
    for (let x = 0; x < nw; x += sampleStride) {
      offsets.push((y * nw + x) * 4);
    }
  }
  const total = offsets.length;
  if (!total) return null;

  let best = null;
  let bestScore = -1;

  // Scan
  for (let y = 0; y <= hh - nh; y += stride) {
    const rowBase = y * hw * 4;
    for (let x = 0; x <= hw - nw; x += stride) {
      const base = rowBase + x * 4;

      let matched = 0;

      for (let k = 0; k < total; k++) {
        const ni = offsets[k];
        const pix = (ni / 4) | 0;
        const nx = pix % nw;
        const ny = ((pix / nw) | 0);
        const hi = base + (ny * hw + nx) * 4;

        const dr = haystack.data[hi]     - needle[ni];
        const dg = haystack.data[hi + 1] - needle[ni + 1];
        const db = haystack.data[hi + 2] - needle[ni + 2];

        if (dr <= tolerance && dr >= -tolerance &&
            dg <= tolerance && dg >= -tolerance &&
            db <= tolerance && db >= -tolerance) {
          matched++;
        }
      }

      const score = matched / total;

      if (score > bestScore) {
        bestScore = score;
        best = { x, y, w: nw, h: nh, score };
      }

      if (!returnBest && score >= minScore) {
        return { x, y, w: nw, h: nh, score };
      }
    }
  }

  if (!returnBest) return null;
  if (!best) return null;
  return { ...best, ok: best.score >= minScore };
}
