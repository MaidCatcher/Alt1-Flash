// matcher.js — browser-only, Alt1-safe
//
// Provides:
//  - captureRs(): capture an ImageData from Alt1 (robust across Alt1 versions)
//  - loadImage(url): load an image asset (cache-busted)
//  - findAnchor(haystack, needleImg, opts): template match with optional best-score debug

export function captureRs() {
  if (!window.alt1) return null;

  // Some Alt1 builds expose different capture functions. We try the common ones safely.
  const fns = [
    "captureHoldFullRs",
    "captureHoldRs",
    "captureHold",
    "captureFullRs",
    "captureRs",
    "capture"
  ];

  for (const name of fns) {
    try {
      const fn = alt1 && alt1[name];
      if (typeof fn === "function") {
        const img = fn.call(alt1);
        if (img && typeof img.width === "number" && typeof img.height === "number" && img.data) return img;
      }
    } catch (e) {
      // ignore and try the next function
    }
  }

  return null;
}

export function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to load image: " + url));
    img.src = url + "?v=" + 1765636596943; // stable cache-bust per build
  });
}

/**
 * findAnchor(haystack, needleImg, opts)
 *
 * opts:
 *  - tolerance: per-channel abs tolerance (default 18)
 *  - stride: sample every N pixels in needle (default 1)
 *  - step: scan step in haystack (default 1)
 *  - minScore: accept match if score >= minScore (default 0.50)
 *  - returnBest: if true, return best match even if not passed
 *
 * returns:
 *  - null (if inputs invalid)
 *  - if returnBest false: { x,y,w,h,score,passed:true } or null
 *  - if returnBest true: { x,y,w,h,score,passed } with best location always included
 */
export function findAnchor(haystack, needleImg, opts = {}) {
  if (!haystack || !haystack.data || !needleImg) return null;

  const cw = haystack.width;
  const ch = haystack.height;

  const tolerance = typeof opts.tolerance === "number" ? opts.tolerance : 18;
  const stride = typeof opts.stride === "number" ? Math.max(1, opts.stride) : 1;
  const step = typeof opts.step === "number" ? Math.max(1, opts.step) : 1;
  const minScore = typeof opts.minScore === "number" ? opts.minScore : 0.50;
  const returnBest = !!opts.returnBest;

  // Render needle image to ImageData
  const nc = document.createElement("canvas");
  nc.width = needleImg.width;
  nc.height = needleImg.height;
  const nctx = nc.getContext("2d", { willReadFrequently: true });
  nctx.drawImage(needleImg, 0, 0);
  const needle = nctx.getImageData(0, 0, nc.width, nc.height).data;

  const nw = nc.width;
  const nh = nc.height;

  if (nw <= 0 || nh <= 0 || nw > cw || nh > ch) return null;

  // Build sample coordinates for the needle
  const xs = [];
  for (let x = 0; x < nw; x += stride) xs.push(x);
  const ys = [];
  for (let y = 0; y < nh; y += stride) ys.push(y);

  const total = xs.length * ys.length;
  if (total <= 0) return null;

  let bestScore = -1;
  let bestX = 0, bestY = 0;

  const h = haystack.data;

  for (let y = 0; y <= ch - nh; y += step) {
    for (let x = 0; x <= cw - nw; x += step) {
      let matched = 0;

      for (let yi = 0; yi < ys.length; yi++) {
        const ny = ys[yi];
        const hayRow = ((y + ny) * cw + x) * 4;
        const nedRow = (ny * nw) * 4;

        for (let xi = 0; xi < xs.length; xi++) {
          const nx = xs[xi];
          const hi = hayRow + nx * 4;
          const ni = nedRow + nx * 4;

          if (
            Math.abs(h[hi]     - needle[ni])     <= tolerance &&
            Math.abs(h[hi + 1] - needle[ni + 1]) <= tolerance &&
            Math.abs(h[hi + 2] - needle[ni + 2]) <= tolerance
          ) {
            matched++;
          }
        }
      }

      const score = matched / total;
      if (score > bestScore) {
        bestScore = score;
        bestX = x;
        bestY = y;
      }

      if (score >= minScore) {
        return {
          x,
          y,
          w: nw,
          h: nh,
          score,
          passed: true,
          best: { x, y, w: nw, h: nh }
        };
      }
    }
  }

  if (!returnBest) return null;

  return {
    x: bestX,
    y: bestY,
    w: nw,
    h: nh,
    score: bestScore < 0 ? 0 : bestScore,
    passed: false,
    best: { x: bestX, y: bestY, w: nw, h: nh }
  };
}
