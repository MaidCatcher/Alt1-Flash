// matcher.js — Alt1 only, NO a1lib
// Exposes: loadImage, captureRs, findAnchor

(function () {

  function rgba(r, g, b, a = 255) {
    return (r & 255) | ((g & 255) << 8) | ((b & 255) << 16) | ((a & 255) << 24);
  }

  function wrapImageData(img) {
    return {
      width: img.width,
      height: img.height,
      data: img.data, // <— keep raw RGBA bytes for preview drawing
      getPixel(x, y) {
        if (x < 0 || y < 0 || x >= img.width || y >= img.height) return 0;
        const i = (y * img.width + x) * 4;
        const d = img.data;
        return rgba(d[i], d[i + 1], d[i + 2], d[i + 3]);
      }
    };
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
      if (!window.alt1 || !alt1.permissionPixel) return null;
      if (typeof alt1.getRegionImage !== "function") return null;

      if (!alt1.rsWidth || !alt1.rsHeight) return null;

      const x = alt1.rsX || 0;
      const y = alt1.rsY || 0;
      const w = alt1.rsWidth;
      const h = alt1.rsHeight;

      const img = alt1.getRegionImage(x, y, w, h);
      if (!img || !img.data) return null;

      return wrapImageData(img);
    } catch (e) {
      console.error("captureRs failed:", e);
      return null;
    }
  };

  // ---- Anchor matcher ----
  // opts:
  // - tolerance (default 80)
  // - minScore (default 0.25)
  // - step (default 2)        : sampling step for speed
  // - ignoreAlphaBelow (default 200): ignore anchor pixels with alpha < this
  window.findAnchor = function (hay, needle, opts = {}) {
    if (!hay || !needle) return { ok: false, score: 0 };

    const tol = opts.tolerance ?? 80;
    const minScore = opts.minScore ?? 0.25;
    const step = Math.max(1, opts.step ?? 2);
    const ignoreAlphaBelow = opts.ignoreAlphaBelow ?? 200;

    let best = { score: 0, x: 0, y: 0 };

    const maxY = hay.height - needle.height;
    const maxX = hay.width - needle.width;
    if (maxX < 0 || maxY < 0) return { ok: false, score: 0 };

    for (let y = 0; y <= maxY; y++) {
      for (let x = 0; x <= maxX; x++) {
        let good = 0, total = 0;

        for (let ny = 0; ny < needle.height; ny += step) {
          for (let nx = 0; nx < needle.width; nx += step) {
            const a = needle.getPixel(nx, ny);
            const aa = (a >>> 24) & 255;

            // Ignore semi-transparent anchor pixels (UI edges often have these)
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
        if (score > best.score) best = { score, x, y };
      }
    }

    return best.score >= minScore
      ? { ok: true, x: best.x, y: best.y, score: best.score }
      : { ok: false, score: best.score };
  };

  console.log("matcher.js loaded (getRegionImage)");

})();
