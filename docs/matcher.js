// matcher.js — Alt1 only, NO a1lib
// Exposes: loadImage, captureRs, captureRegion, findAnchor
// Works with either alt1.getRegionImage OR alt1.getRegion (base64 ARGB)
// findAnchor supports returnSecond for quality scoring.

(function () {
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
      data: img.data, // Uint8ClampedArray RGBA
      getPixel(x, y) {
        if (x < 0 || y < 0 || x >= img.width || y >= img.height) return 0;
        const i = (y * img.width + x) * 4;
        const d = img.data;
        return rgba(d[i], d[i + 1], d[i + 2], d[i + 3]);
      }
    };
  }

  function base64ToBytes(b64) {
    try {
      if (typeof Uint8Array.fromBase64 === "function") {
        return Uint8Array.fromBase64(b64);
      }
    } catch (_) {}
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 255;
    return out;
  }

  function argbToRgbaBytes(argbBytes) {
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

  function getRsRect() {
    const w = alt1.rsWidth;
    const h = alt1.rsHeight;
    const x = alt1.rsX || 0;
    const y = alt1.rsY || 0;
    return { x, y, w, h };
  }

  function clampRectToRs(r) {
    const rs = getRsRect();
    const x = Math.max(0, Math.min(rs.w - 1, r.x));
    const y = Math.max(0, Math.min(rs.h - 1, r.y));
    const w = Math.max(1, Math.min(r.w, rs.w - x));
    const h = Math.max(1, Math.min(r.h, rs.h - y));
    return { x, y, w, h };
  }

  // Capture a region in RS capture space (fast path used by app.js)
  // Returns wrapped image and includes _offsetX/_offsetY for mapping to RS coords.
  window.captureRegion = function (x, y, w, h) {
    try {
      setDiag({ when: new Date().toISOString(), stage: "captureRegion_start" });

      if (!window.alt1) { setDiag({ stage: "no_alt1" }); return null; }
      if (!alt1.permissionPixel) { setDiag({ stage: "no_pixel_permission" }); return null; }

      const rs = getRsRect();
      if (!rs.w || !rs.h) { setDiag({ stage: "bad_dims" }); return null; }

      const rr = clampRectToRs({ x, y, w, h });
      const sx = rs.x + rr.x;
      const sy = rs.y + rr.y;

      setDiag({
        stage: "captureRegion_dims",
        rs,
        req: rr,
        abs: { x: sx, y: sy },
        hasGetRegion: typeof alt1.getRegion === "function",
        hasGetRegionImage: typeof alt1.getRegionImage === "function",
        maxtransfer: alt1.maxtransfer
      });

      // Preferred
      if (typeof alt1.getRegionImage === "function") {
        const img = alt1.getRegionImage(sx, sy, rr.w, rr.h);
        if (!img || !img.data) { setDiag({ stage: "getRegionImage_failed" }); return null; }
        const wrapped = wrapImageData(img);
        wrapped._offsetX = rr.x;
        wrapped._offsetY = rr.y;
        setDiag({ stage: "ok_getRegionImage_region" });
        return wrapped;
      }

      // Fallback
      if (typeof alt1.getRegion !== "function") { setDiag({ stage: "no_getRegion_api" }); return null; }

      const approxBytes = rr.w * rr.h * 4;
      if (alt1.maxtransfer && approxBytes > alt1.maxtransfer * 0.95) {
        setDiag({ stage: "too_large_for_transfer", approxBytes, maxtransfer: alt1.maxtransfer });
        return null;
      }

      const b64 = alt1.getRegion(sx, sy, rr.w, rr.h);
      if (!b64 || typeof b64 !== "string") { setDiag({ stage: "getRegion_returned_empty" }); return null; }

      const argbBytes = base64ToBytes(b64);
      if (!argbBytes || argbBytes.length !== rr.w * rr.h * 4) {
        setDiag({ stage: "decode_length_mismatch", gotLen: argbBytes ? argbBytes.length : null });
        return null;
      }

      const rgbaBytes = argbToRgbaBytes(argbBytes);
      const wrapped = wrapImageData({ width: rr.w, height: rr.h, data: rgbaBytes });
      wrapped._offsetX = rr.x;
      wrapped._offsetY = rr.y;
      setDiag({ stage: "ok_getRegion_region" });
      return wrapped;
    } catch (e) {
      console.error("captureRegion failed:", e);
      setDiag({ stage: "exception", error: String(e && e.message ? e.message : e) });
      return null;
    }
  };

  // Full RS capture (keep for debug, but app.js should no longer use this per-tick)
  window.captureRs = function () {
    try {
      if (!window.alt1 || !alt1.permissionPixel) return null;
      const rs = getRsRect();
      return window.captureRegion(0, 0, rs.w, rs.h);
    } catch {
      return null;
    }
  };

  // opts: tolerance, minScore, step, ignoreAlphaBelow, returnSecond
  window.findAnchor = function (hay, needle, opts = {}) {
    if (!hay || !needle) return { ok: false, score: 0, secondScore: 0 };

    const tol = opts.tolerance ?? 80;
    const minScore = opts.minScore ?? 0.25;
    const step = Math.max(1, opts.step ?? 2);
    const ignoreAlphaBelow = opts.ignoreAlphaBelow ?? 200;
    const returnSecond = !!opts.returnSecond;

    let best = { score: 0, x: 0, y: 0 };
    let secondScore = 0;

    const maxY = hay.height - needle.height;
    const maxX = hay.width - needle.width;
    if (maxX < 0 || maxY < 0) return { ok: false, score: 0, secondScore: 0 };

    for (let y = 0; y <= maxY; y++) {
      for (let x = 0; x <= maxX; x++) {
        let good = 0, total = 0;

        for (let ny = 0; ny < needle.height; ny += step) {
          for (let nx = 0; nx < needle.width; nx += step) {
            const a = needle.getPixel(nx, ny);
            const aa = (a >>> 24) & 255;
            if (aa < ignoreAlphaBelow) continue;

            total++;

            const b = hay.getPixel(x + nx, y + ny);

            const dr = Math.abs((a & 255) - (b & 255));
            const dg = Math.abs(((a >> 8) & 255) - ((b >> 8) & 255));
            const db = Math.abs(((a >> 16) & 255) - ((b >> 16) & 255));

            if (dr <= tol && dg <= tol && db <= tol) good++;
          }
        }

        if (total === 0) continue;

        const score = good / total;

        if (score > best.score) {
          if (returnSecond) secondScore = Math.max(secondScore, best.score);
          best = { score, x, y };
        } else if (returnSecond && score > secondScore) {
          secondScore = score;
        }
      }
    }

    const ok = best.score >= minScore;
    return returnSecond
      ? { ok, x: best.x, y: best.y, score: best.score, secondScore }
      : { ok, x: best.x, y: best.y, score: best.score };
  };

  console.log("matcher.js loaded (captureRegion enabled)");
})();
