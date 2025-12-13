// matcher.js
// Alt1-compatible (NO ES modules). Exposes captureRs/loadImage/findAnchor on window.

/* ================= CAPTURE ================= */

function toImageData(cap) {
  if (!cap) return null;

  // Some Alt1 builds return ImageData directly
  if (cap.data && typeof cap.width === "number" && typeof cap.height === "number") return cap;

  // Some return a capture-handle that needs conversion
  try {
    if (typeof cap.toData === "function") return cap.toData();
  } catch {}

  try {
    if (typeof cap.toImageData === "function") return cap.toImageData();
  } catch {}

  return null;
}

function captureRs() {
  if (!window.alt1) return null;
  if (!alt1.permissionPixel) return null;

  const x = Number.isFinite(alt1.rsX) ? alt1.rsX : 0;
  const y = Number.isFinite(alt1.rsY) ? alt1.rsY : 0;
  const w = Number.isFinite(alt1.rsWidth) ? alt1.rsWidth : 0;
  const h = Number.isFinite(alt1.rsHeight) ? alt1.rsHeight : 0;

  if (!w || !h) return null;

  // Try the common Alt1 capture APIs in a safe order.
  const attempts = [
    () => (typeof alt1.captureHoldFullRs === "function" ? alt1.captureHoldFullRs() : null),
    () => (typeof alt1.captureHoldFull === "function" ? alt1.captureHoldFull() : null),

    () => (typeof alt1.captureHold === "function" ? alt1.captureHold(x, y, w, h) : null),
    () => (typeof alt1.captureHold === "function" ? alt1.captureHold(0, 0, w, h) : null),

    () => (typeof alt1.capture === "function" ? alt1.capture(x, y, w, h) : null),
    () => (typeof alt1.capture === "function" ? alt1.capture(0, 0, w, h) : null),

    // Some builds expose captureMethod; if it accepts region args, try it last.
    () => (typeof alt1.captureMethod === "function" && alt1.captureMethod.length >= 4 ? alt1.captureMethod(x, y, w, h) : null),
  ];

  for (let i = 0; i < attempts.length; i++) {
    try {
      const cap = attempts[i]();
      const img = toImageData(cap);
      if (img) return img;
    } catch {}
  }

  return null;
}

/* ================= IMAGE LOAD ================= */

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

/* ================= MATCHER ================= */

function findAnchor(hay, needle, opts = {}) {
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

  // Precompute needle luminance (more robust than RGB)
  const nLum = new Uint8Array(nw * nh);
  for (let j = 0; j < nh; j++) {
    for (let i = 0; i < nw; i++) {
      const idx = (j * nw + i) * 4;
      nLum[j * nw + i] =
        (n[idx] * 30 + n[idx + 1] * 59 + n[idx + 2] * 11) / 100;
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
          const lum =
            (h[hi] * 30 + h[hi + 1] * 59 + h[hi + 2] * 11) / 100;

          if (Math.abs(lum - nLum[j * nw + i]) <= tolerance) {
            good++;
          }
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

  return returnBest
    ? { ok: false, score: bestScore, best }
    : null;
}

/* ================= EXPOSE TO WINDOW ================= */

window.captureRs = captureRs;
window.loadImage = loadImage;
window.findAnchor = findAnchor;
