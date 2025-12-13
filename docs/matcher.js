// matcher.js

function toImageData(maybe) {
  if (!maybe) return null;

  // ImageData-like already
  if (maybe.data && typeof maybe.width === "number" && typeof maybe.height === "number") {
    return maybe;
  }

  // Alt1 capture-handle conversions (varies by build)
  try { if (typeof maybe.toData === "function") return maybe.toData(); } catch {}
  try { if (typeof maybe.toImageData === "function") return maybe.toImageData(); } catch {}

  return null;
}

export function captureRs() {
  if (!window.alt1) return null;
  if (!alt1.permissionPixel) return null;

  const w = Number.isFinite(alt1.rsWidth) ? alt1.rsWidth : 0;
  const h = Number.isFinite(alt1.rsHeight) ? alt1.rsHeight : 0;
  if (!w || !h) return null;

  const sx = Number.isFinite(alt1.rsX) ? alt1.rsX : 0;
  const sy = Number.isFinite(alt1.rsY) ? alt1.rsY : 0;

  // 1) Try SCREEN coordinates (some Alt1 builds expect absolute screen coords)
  try {
    if (typeof alt1.captureHold === "function") {
      const out = alt1.captureHold(sx, sy, w, h);
      const img = toImageData(out);
      if (img) return img;
    }
    if (typeof alt1.capture === "function") {
      const out = alt1.capture(sx, sy, w, h);
      const img = toImageData(out);
      if (img) return img;
    }
  } catch {}

  // 2) Try CLIENT-relative coordinates (0,0 at the RS client area)
  try {
    if (typeof alt1.captureHold === "function") {
      const out = alt1.captureHold(0, 0, w, h);
      const img = toImageData(out);
      if (img) return img;
    }
    if (typeof alt1.capture === "function") {
      const out = alt1.capture(0, 0, w, h);
      const img = toImageData(out);
      if (img) return img;
    }
  } catch {}

  return null;
}

}

export async function loadImage(url) {
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.src = url;

  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
  });

  const c = document.createElement("canvas");
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  return ctx.getImageData(0, 0, c.width, c.height);
}

// Luma-based template match with options and returnBest support
export function findAnchor(hay, needle, opts = {}) {
  const tolerance = opts.tolerance ?? 65;
  const stride = opts.stride ?? 1;
  const minScore = opts.minScore ?? 0.50;
  const returnBest = !!opts.returnBest;

  if (!hay || !needle) return null;

  const hw = hay.width, hh = hay.height;
  const nw = needle.width, nh = needle.height;
  if (nw <= 0 || nh <= 0 || nw > hw || nh > hh) return returnBest ? { ok: false, score: 0, best: null } : null;

  const hdata = hay.data;
  const ndata = needle.data;

  // Precompute needle luminance
  const nLum = new Uint8Array(nw * nh);
  for (let j = 0; j < nh; j++) {
    for (let i = 0; i < nw; i++) {
      const idx = (j * nw + i) * 4;
      const r = ndata[idx], g = ndata[idx + 1], b = ndata[idx + 2];
      nLum[j * nw + i] = (r * 30 + g * 59 + b * 11) / 100;
    }
  }

  const total = nw * nh;
  let bestScore = -1;
  let best = null;

  for (let y = 0; y <= hh - nh; y += stride) {
    for (let x = 0; x <= hw - nw; x += stride) {
      let good = 0;

      for (let j = 0; j < nh; j++) {
        const hy = y + j;
        for (let i = 0; i < nw; i++) {
          const hx = x + i;
          const hIdx = (hy * hw + hx) * 4;
          const r = hdata[hIdx], g = hdata[hIdx + 1], b = hdata[hIdx + 2];
          const hL = (r * 30 + g * 59 + b * 11) / 100;

          const d = Math.abs(hL - nLum[j * nw + i]);
          if (d <= tolerance) good++;
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
