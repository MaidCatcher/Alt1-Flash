// matcher.js
// Provides:
// - captureRs(): ImageData | null
// - loadImage(url): Promise<ImageData>
// - findAnchor(haystackImg, needleImg, opts)

function toImageData(maybe) {
  if (!maybe) return null;

  // Already ImageData-like
  if (maybe.data && typeof maybe.width === "number" && typeof maybe.height === "number") {
    return maybe;
  }

  // Some Alt1 captures return a "ref" with toData() / toDataArray() / etc.
  // Try common conversions safely.
  try {
    if (typeof maybe.toData === "function") return maybe.toData();
  } catch {}
  try {
    if (typeof maybe.toImageData === "function") return maybe.toImageData();
  } catch {}

  return null;
}

export function captureRs() {
  if (!window.alt1) return null;
  if (!alt1.permissionPixel) return null;

  const x = alt1.rsX ?? 0;
  const y = alt1.rsY ?? 0;
  const w = alt1.rsWidth;
  const h = alt1.rsHeight;

  if (!w || !h) return null;

  try {
    const img = alt1.capture(x, y, w, h);
    if (img && img.width && img.height) {
      return img;
    }
  } catch (e) {
    console.error("capture failed", e);
  }

  return null;
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

// Simple template match with tolerance/stride/minScore and optional returnBest
export function findAnchor(hay, needle, opts = {}) {
  const tolerance = opts.tolerance ?? 65;
  const stride = opts.stride ?? 1;
  const minScore = opts.minScore ?? 0.50;
  const returnBest = !!opts.returnBest;

  if (!hay || !needle) return null;

  const hw = hay.width, hh = hay.height;
  const nw = needle.width, nh = needle.height;
  if (nw <= 0 || nh <= 0 || nw > hw || nh > hh) return null;

  const hdata = hay.data;
  const ndata = needle.data;

  let bestScore = -1;
  let best = null;

  // precompute needle luminance for stability
  const nLum = new Uint8Array(nw * nh);
  for (let j = 0; j < nh; j++) {
    for (let i = 0; i < nw; i++) {
      const idx = (j * nw + i) * 4;
      const r = ndata[idx], g = ndata[idx + 1], b = ndata[idx + 2];
      nLum[j * nw + i] = (r * 30 + g * 59 + b * 11) / 100;
    }
  }

  const maxDiff = tolerance;
  const total = nw * nh;

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
          if (d <= maxDiff) good++;
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
