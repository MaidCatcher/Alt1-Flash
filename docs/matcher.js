// matcher.js — browser-only, Alt1-safe
//
// This file provides:
//  - captureRs(): get ImageData from Alt1
//  - loadImage(url): load an image asset
//  - findAnchor(haystack, needleImg, opts): locate a small template inside a screenshot

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

    // Cache-bust so updates to the anchor image are picked up while developing.
    // (You can replace Date.now() with a fixed version string for production.)
    img.src = url + "?v=" + Date.now();
  });
}

/**
 * Find a small template image (needleImg) inside an ImageData (haystack).
 *
 * opts:
 *  - tolerance: per-channel absolute tolerance (default 18)
 *  - stride: sample every Nth pixel in the needle (default 2)  [higher = faster, less accurate]
 *  - step: scan step in the haystack (default 2)               [higher = faster, less accurate]
 *  - minScore: fraction [0..1] required to accept a match (default 0.65)
 */
/**
 * Find a small template image (needleImg) inside an ImageData (haystack).
 *
 * Robustness improvements:
 *  - Compares on luminance (grayscale) instead of raw RGB so it survives small UI/theme/color changes.
 *  - Can optionally return the best-scoring location even if below minScore (opts.returnBest=true).
 *
 * opts:
 *  - tolerance: luminance tolerance (default 28)
 *  - stride: sample every Nth pixel in the needle (default 2)  [higher = faster, less accurate]
 *  - step: scan step in the haystack (default 2)               [higher = faster, less accurate]
 *  - minScore: fraction [0..1] required to accept a match (default 0.62)
 *  - returnBest: if true, returns best match with {passed:false} even if score < minScore
 */
export function findAnchor(haystack, needleImg, opts = {}) {
  const cw = haystack.width;
  const ch = haystack.height;

  const tolerance = typeof opts.tolerance === "number" ? opts.tolerance : 28;
  const stride = typeof opts.stride === "number" ? Math.max(1, opts.stride) : 2;
  const step = typeof opts.step === "number" ? Math.max(1, opts.step) : 2;
  const minScore = typeof opts.minScore === "number" ? opts.minScore : 0.62;
  const returnBest = !!opts.returnBest;

  // Render needleImg into ImageData
  const nc = document.createElement("canvas");
  nc.width = needleImg.width;
  nc.height = needleImg.height;
  const nctx = nc.getContext("2d", { willReadFrequently: true });
  nctx.drawImage(needleImg, 0, 0);

  const needleData = nctx.getImageData(0, 0, nc.width, nc.height).data;
  const nw = nc.width;
  const nh = nc.height;

  // Precompute needle luminance for sampled pixels
  const sampleXs = [];
  for (let x = 0; x < nw; x += stride) sampleXs.push(x);
  const sampleYs = [];
  for (let y = 0; y < nh; y += stride) sampleYs.push(y);

  const totalSamples = sampleXs.length * sampleYs.length;
  if (totalSamples <= 0) return null;

  // Needle luminance lookup for sampled pixels (flat array aligned with sampling loops)
  const needleLum = new Uint8Array(totalSamples);
  let k = 0;
  for (let sy = 0; sy < sampleYs.length; sy++) {
    const y = sampleYs[sy];
    const rowBase = (y * nw) * 4;
    for (let sx = 0; sx < sampleXs.length; sx++) {
      const x = sampleXs[sx];
      const i = rowBase + x * 4;
      const r = needleData[i], g = needleData[i + 1], b = needleData[i + 2];
      // ITU-R BT.601 luma approximation
      needleLum[k++] = (r * 299 + g * 587 + b * 114) / 1000;
    }
  }

  let best = null; // {x,y,w,h,score,passed}
  let bestScore = -1;

  for (let y = 0; y <= ch - nh; y += step) {
    for (let x = 0; x <= cw - nw; x += step) {
      let matched = 0;
      let idx = 0;

      for (let sy = 0; sy < sampleYs.length; sy++) {
        const ny = sampleYs[sy];
        const hayRowBase = ((y + ny) * cw + x) * 4;

        for (let sx = 0; sx < sampleXs.length; sx++) {
          const nx = sampleXs[sx];
          const hi = hayRowBase + nx * 4;

          const r = haystack.data[hi];
          const g = haystack.data[hi + 1];
          const b = haystack.data[hi + 2];

          const lum = (r * 299 + g * 587 + b * 114) / 1000;
          const dl = Math.abs(lum - needleLum[idx++]);

          if (dl <= tolerance) matched++;
        }
      }

      const score = matched / totalSamples;
      if (score > bestScore) {
        bestScore = score;
        best = { x, y, w: nw, h: nh, score, passed: score >= minScore };
      }

      if (score >= minScore) {
        return { x, y, w: nw, h: nh, score, passed: true };
      }
    }
  }

  return returnBest ? best : null;
}
