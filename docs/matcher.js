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
export function findAnchor(haystack, needleImg, opts = {}) {
  const cw = haystack.width;
  const ch = haystack.height;

  const tolerance = typeof opts.tolerance === "number" ? opts.tolerance : 18;
  const stride = typeof opts.stride === "number" ? Math.max(1, opts.stride) : 2;
  const step = typeof opts.step === "number" ? Math.max(1, opts.step) : 2;
  const minScore = typeof opts.minScore === "number" ? opts.minScore : 0.65;

  // Render needleImg into ImageData
  const nc = document.createElement("canvas");
  nc.width = needleImg.width;
  nc.height = needleImg.height;
  const nctx = nc.getContext("2d", { willReadFrequently: true });
  nctx.drawImage(needleImg, 0, 0);
  const needle = nctx.getImageData(0, 0, nc.width, nc.height).data;

  const nw = nc.width;
  const nh = nc.height;

  // How many needle pixels will we actually sample?
  const sampleXs = [];
  for (let x = 0; x < nw; x += stride) sampleXs.push(x);
  const sampleYs = [];
  for (let y = 0; y < nh; y += stride) sampleYs.push(y);

  const totalSamples = sampleXs.length * sampleYs.length;
  if (totalSamples <= 0) return null;

  for (let y = 0; y <= ch - nh; y += step) {
    for (let x = 0; x <= cw - nw; x += step) {
      let matched = 0;

      // Sample needle pixels and compare with haystack at offset (x,y)
      for (let sy = 0; sy < sampleYs.length; sy++) {
        const ny = sampleYs[sy];
        const hayRowBase = ((y + ny) * cw + x) * 4;
        const needleRowBase = (ny * nw) * 4;

        for (let sx = 0; sx < sampleXs.length; sx++) {
          const nx = sampleXs[sx];
          const hi = hayRowBase + nx * 4;
          const ni = needleRowBase + nx * 4;

          const dr = Math.abs(haystack.data[hi]     - needle[ni]);
          const dg = Math.abs(haystack.data[hi + 1] - needle[ni + 1]);
          const db = Math.abs(haystack.data[hi + 2] - needle[ni + 2]);

          if (dr <= tolerance && dg <= tolerance && db <= tolerance) {
            matched++;
          }
        }
      }

      const score = matched / totalSamples;
      if (score >= minScore) {
        return { x, y, w: nw, h: nh, score };
      }
    }
  }

  return null;
}
