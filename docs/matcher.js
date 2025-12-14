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

      const x = alt1.rsX || 0;
      const y = alt1.rsY || 0;
      const w = alt1.rsWidth;
      const h = alt1.rsHeight;
      if (!w || !h) return null;

      const img = alt1.getRegionImage(x, y, w, h);
      if (!img || !img.data) return null;

      return wrapImageData(img);
    } catch (e) {
      console.error("captureRs failed:", e);
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

  console.log("matcher.js loaded (getRegionImage)");

})();
