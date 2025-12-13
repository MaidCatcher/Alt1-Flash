// matcher.js — browser-only, Alt1-safe

export function captureRs() {
  if (!window.alt1) return null;
  if (typeof alt1.captureHoldFullRs === "function")
    return alt1.captureHoldFullRs();
  if (typeof alt1.capture === "function")
    return alt1.capture();
  return null;
}

export function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to load image"));
    img.src = url + "?v=" + Date.now(); // cache bust
  });
}

function imgToData(img) {
  const c = document.createElement("canvas");
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  return ctx.getImageData(0, 0, c.width, c.height);
}

export function findAnchor(hay, needleImg, opts = {}) {
const tol = opts.tolerance ?? 50;
const stride = opts.stride ?? 1;
const minScore = opts.minScore ?? 0.50;


  const n = imgToData(needleImg);
  const pts = [];

  for (let y = 0; y < n.height; y += stride) {
    for (let x = 0; x < n.width; x += stride) {
      const i = (y * n.width + x) * 4;
      if (n.data[i + 3] > 200)
        pts.push([x, y, n.data[i], n.data[i + 1], n.data[i + 2]]);
    }
  }

  const hw = hay.width;
  const hh = hay.height;
  const maxX = hw - n.width;
  const maxY = hh - n.height;

  for (let y0 = 0; y0 <= maxY; y0 += 2) {
    for (let x0 = 0; x0 <= maxX; x0 += 2) {
      let ok = 0;
      for (const [x, y, r, g, b] of pts) {
        const hi = ((y0 + y) * hw + (x0 + x)) * 4;
        // Alt1 capture is typically BGRA (Blue, Green, Red, Alpha)
const hb = hay.data[hi + 0];
const hg = hay.data[hi + 1];
const hr = hay.data[hi + 2];

if (
  Math.abs(hr - r) <= tol &&
  Math.abs(hg - g) <= tol &&
  Math.abs(hb - b) <= tol
) ok++;

      }
      if (ok / pts.length >= minScore)
        return { x: x0, y: y0, w: n.width, h: n.height };
    }
  }
  return null;
}
