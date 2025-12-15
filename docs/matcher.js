// matcher.js — Alt1 only, NO a1lib
// Exposes: loadImage, captureRs, findAnchor
// FIXED: use alt1.getRegion (documented) instead of non-existent getRegionImage
// Adds: window.progflashCaptureDiag for better debug output

(function () {

  // diagnostic object app.js will display if capture fails
  window.progflashCaptureDiag = {};

  function setDiag(patch) {
    window.progflashCaptureDiag = Object.assign({}, window.progflashCaptureDiag, patch);
  }

  function rgba(r, g, b, a = 255) {
    return (r & 255) | ((g & 255) << 8) | ((b & 255) << 16) | ((a & 255) << 24);
  }

  function wrapImageData(img) {
    return {
      width: img.width,
      height: img.height,
      data: img.data, // keep data around (useful for diagnostics/tools)
      getPixel(x, y) {
        if (x < 0 || y < 0 || x >= img.width || y >= img.height) return 0;
        const i = (y * img.width + x) * 4;
        const d = img.data;
        return rgba(d[i], d[i + 1], d[i + 2], d[i + 3]);
      }
    };
  }

  function base64ToBytes(b64) {
    // Prefer new Uint8Array.fromBase64 if available (modern Chromium)
    // Fallback to atob.
    try {
      if (typeof Uint8Array.fromBase64 === "function") {
        return Uint8Array.fromBase64(b64);
      }
    } catch (_) { /* ignore */ }

    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 255;
    return out;
  }

  function argbToRgbaBytes(argbBytes) {
    // Alt1 getRegion returns 8bpp ARGB buffer (A,R,G,B). :contentReference[oaicite:2]{index=2}
    // Convert to RGBA for canvas-like usage.
    const out = new Uint8ClampedArray(argbBytes.length);
    for (let i = 0; i < argbBytes.length; i += 4) {
      const A = argbBytes[i + 0];
      const R = argbBytes[i + 1];
      const G = argbBytes[i + 2];
      const B = argbBytes[i + 3];
      out[i + 0] = R;
      out[i + 1] = G;
      out[i + 2] = B;
      out[i + 3] = A;
    }
    return out;
  }

  // ---- Load anchor image ----
  window.loadImage = function (src) {
    return new Promise(resolve => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement("canvas");
        c.width = img.width;
        c.height = img.height;
        const ctx = c.getContext("2d");
        ctx.drawImage(img, 0, 0);
        const id = ctx.getImageData(0, 0, c.width, c.height);
        resolve(wrapImageData(id));
      };
      img.onerror = () => resolve(null);
      img.src = src;
    });
  };

  // ---- Capture RuneScape viewport ----
  window.captureRs = function () {
    try {
      setDiag({ when: new Date().toISOString(), stage: "start" });

      if (!window.alt1) {
        setDiag({ stage: "no_alt1" });
        return null;
      }
      if (!alt1.permissionPixel) {
        setDiag({ stage: "no_pixel_permission", permissionPixel: !!alt1.permissionPixel });
        return null;
      }
      if (alt1.rsLinked === false) {
        setDiag({ stage: "rs_not_linked", rsLinked: alt1.rsLinked });
        return null;
      }

      const x = alt1.rsX || 0;
      const y = alt1.rsY || 0;
      const w = alt1.rsWidth;
      const h = alt1.rsHeight;

      setDiag({
        stage: "dims",
        rs: { x, y, w, h },
        maxtransfer: alt1.maxtransfer,
        hasGetRegion: typeof alt1.getRegion === "function",
        hasGetRegionImage: typeof alt1.getRegionImage === "function"
      });

      if (!w || !h) {
        setDiag({ stage: "bad_dims" });
        return null;
      }

      // If some wrapper provides an ImageData-like API, use it.
      if (typeof alt1.getRegionImage === "function") {
        const img = alt1.getRegionImage(x, y, w, h);
        if (!img || !img.data) {
          setDiag({ stage: "getRegionImage_failed", got: !!img });
          return null;
        }
        setDiag({ stage: "ok_getRegionImage" });
        return wrapImageData(img);
      }

      // Documented Alt1 API: getRegion -> base64 encoded 8bpp ARGB buffer. :contentReference[oaicite:3]{index=3}
      if (typeof alt1.getRegion !== "function") {
        setDiag({ stage: "no_getRegion_api" });
        return null;
      }

      // Heuristic check: huge captures can exceed transfer limits on some setups.
      // If this triggers, you'll want to capture a smaller region instead of full viewport.
      const approxBytes = w * h * 4;
      if (alt1.maxtransfer && approxBytes > alt1.maxtransfer * 0.95) {
        setDiag({
          stage: "too_large_for_transfer",
          approxBytes,
          maxtransfer: alt1.maxtransfer
        });
        return null;
      }

      const b64 = alt1.getRegion(x, y, w, h);
      if (!b64 || typeof b64 !== "string") {
        setDiag({ stage: "getRegion_returned_empty", type: typeof b64 });
        return null;
      }

      const argbBytes = base64ToBytes(b64);
      if (!argbBytes || argbBytes.length !== w * h * 4) {
        setDiag({
          stage: "decode_length_mismatch",
          gotLen: argbBytes ? argbBytes.length : null,
          expectedLen: w * h * 4
        });
        return null;
      }

      const rgbaBytes = argbToRgbaBytes(argbBytes);
      setDiag({ stage: "ok_getRegion" });

      return wrapImageData({ width: w, height: h, data: rgbaBytes });
    } catch (e) {
      console.error("captureRs failed:", e);
      setDiag({ stage: "exception", error: String(e && e.message ? e.message : e) });
      return null;
    }
  };

  // ---- Anchor matcher ----
  window.findAnchor = function (hay, needle, opts = {}) {
    if (!hay || !needle) return { ok: false };

    const tol = opts.tolerance ?? 80;
    const minScore = opts.minScore ?? 0.25;

    let best = { score: 0, x: 0, y: 0 };

    for (let y = 0; y <= hay.height - needle.height; y++) {
      for (let x = 0; x <= hay.width - needle.width; x++) {
        let good = 0, total = 0;

        for (let ny = 0; ny < needle.height; ny += 2) {
          for (let nx = 0; nx < needle.width; nx += 2) {
            total++;
          const a = needle.getPixel(nx, ny);
const alpha = (a >>> 24) & 255;

// IGNORE transparent / semi-transparent anchor pixels
if (alpha < 200) continue;

const b = hay.getPixel(x + nx, y + ny);


            const dr = Math.abs((a & 255) - (b & 255));
            const dg = Math.abs(((a >> 8) & 255) - ((b >> 8) & 255));
            const db = Math.abs(((a >> 16) & 255) - ((b >> 16) & 255));

            if (dr <= tol && dg <= tol && db <= tol) good++;
          }
        }

        const score = good / total;
        if (score > best.score) best = { score, x, y };
      }
    }

    return best.score >= minScore
      ? { ok: true, x: best.x, y: best.y, score: best.score }
      : { ok: false, score: best.score };
  };

  console.log("matcher.js loaded (getRegion fallback)");

})();
