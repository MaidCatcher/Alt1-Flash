// matcher.js — classic script, Alt1-compatible (NO imports/exports)
// Uses alt1.getRegion(...) which returns base64-encoded raw pixels.
// Exposes globals:
//   window.progflashCaptureRs
//   window.progflashLoadImage
//   window.progflashFindAnchor

(function () {
  // cache buffers to avoid realloc every tick
  let lastW = 0, lastH = 0;
  let rgba = null; // Uint8ClampedArray
  let imgObj = null; // ImageData

  // Debug info (optional, but useful)
  const diag = {
    lastErr: "",
    lastMode: "",
    frames: 0,
    lastB64Len: 0,
  };

  function b64ToBytes(b64) {
    // atob returns a binary string where charCodeAt is the byte value
    const bin = atob(b64);
    const len = bin.length;
    const out = new Uint8ClampedArray(len);
    for (let i = 0; i < len; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function ensureImageData(w, h) {
    if (w === lastW && h === lastH && rgba && imgObj) return;

    lastW = w; lastH = h;
    rgba = new Uint8ClampedArray(w * h * 4);
    imgObj = new ImageData(rgba, w, h);
  }

  // NOTE: the byte order from Alt1 getRegion is usually BGRA.
  // We'll convert BGRA -> RGBA by swapping R and B each pixel.
  function bgraToRgbaInPlace(buf) {
    for (let i = 0; i < buf.length; i += 4) {
      const b = buf[i + 0];
      const g = buf[i + 1];
      const r = buf[i + 2];
      const a = buf[i + 3];
      buf[i + 0] = r;
      buf[i + 1] = g;
      buf[i + 2] = b;
      buf[i + 3] = a;
    }
  }

  function progflashCaptureRs() {
    diag.lastErr = "";
    diag.lastMode = "";

    if (!window.alt1 || !alt1.permissionPixel) {
      diag.lastErr = "no alt1 / no permissionPixel";
      return null;
    }
    if (typeof alt1.getRegion !== "function") {
      diag.lastErr = "alt1.getRegion missing";
      return null;
    }

    try {
      const x = alt1.rsX || 0;
      const y = alt1.rsY || 0;
      const w = alt1.rsWidth || 0;
      const h = alt1.rsHeight || 0;
      if (!w || !h) {
        diag.lastErr = `bad rs dims: ${w}x${h}`;
        return null;
      }

      // getRegion returns base64 raw pixels (length ~ (w*h*4)*4/3)
      const b64 = alt1.getRegion(x, y, w, h);
      if (!b64 || typeof b64 !== "string") {
        diag.lastErr = "getRegion returned non-string/empty";
        return null;
      }

      diag.lastMode = "getRegion(base64)";
      diag.lastB64Len = b64.length;

      // decode -> bytes -> convert order -> copy to cached ImageData buffer
      const bytes = b64ToBytes(b64);

      // sanity: bytes length must match w*h*4
      const expected = w * h * 4;
      if (bytes.length !== expected) {
        diag.lastErr = `decoded bytes len ${bytes.length} != expected ${expected}`;
        return null;
      }

      // Convert BGRA -> RGBA
      bgraToRgbaInPlace(bytes);

      ensureImageData(w, h);
      rgba.set(bytes);

      diag.frames++;
      return imgObj;
    } catch (e) {
      diag.lastErr = (e && e.message) ? e.message : String(e);
      return null;
    }
  }

  // ---- Load anchor image ----
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

  // ---- Anchor matcher (luma-based) ----
  function progflashFindAnchor(hay, needle, opts = {}) {
    if (!hay || !needle) return null;

    const tolerance = opts.tolerance ?? 65;
    const stride = opts.stride ?? 1;
    const minScore = opts.minScore ?? 0.5;
    const returnBest = !!opts.returnBest;

    const hw = hay.width, hh = hay.height;
    const nw = needle.width, nh = needle.height;
    if (nw > hw || nh > hh) return returnBest ? { ok: false, score: 0 } : null;

    const h = hay.data;
    const n = needle.data;

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

  // ---- Export globals (correct names) ----
  window.progflashCaptureRs = progflashCaptureRs;
  window.progflashLoadImage = progflashLoadImage;
  window.progflashFindAnchor = progflashFindAnchor;

  // Optional diag export
  window.progflashCaptureDiag = diag;
})();
