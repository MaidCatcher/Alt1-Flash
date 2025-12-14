// matcher.js — ProgFlash (NO a1lib, Alt1-native capture)

(function () {

  function wrapImageData(imageData) {
    return {
      width: imageData.width,
      height: imageData.height,
      data: imageData.data,
      getPixel(x, y) {
        if (x < 0 || y < 0 || x >= this.width || y >= this.height) return 0;
        const i = (y * this.width + x) * 4;
        const d = this.data;
        return (d[i]) | (d[i+1] << 8) | (d[i+2] << 16) | (d[i+3] << 24);
      }
    };
  }

  // ---- Load anchor image ----
  window.loadImage = function (path) {
    return new Promise(resolve => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement("canvas");
        c.width = img.width;
        c.height = img.height;
        const ctx = c.getContext("2d");
        ctx.drawImage(img, 0, 0);
        resolve(wrapImageData(ctx.getImageData(0, 0, c.width, c.height)));
      };
      img.onerror = () => resolve(null);
      img.src = path;
    });
  };

  // ---- Capture RuneScape viewport ----
  window.progflashCaptureDiag = {};

  window.captureRs = function () {
    if (!window.alt1) {
      window.progflashCaptureDiag = { error: "alt1 missing" };
      return null;
    }

    if (!alt1.permissionPixel) {
      window.progflashCaptureDiag = { error: "permissionPixel false" };
      return null;
    }

    if (typeof alt1.getRegion !== "function") {
      window.progflashCaptureDiag = { error: "getRegion missing" };
      return null;
    }

    const x = alt1.rsX || 0;
    const y = alt1.rsY || 0;
    const w = alt1.rsWidth;
    const h = alt1.rsHeight;

    window.progflashCaptureDiag = { x, y, w, h };

    if (!w || !h) {
      window.progflashCaptureDiag.error = "rsWidth/rsHeight are 0";
      return null;
    }

    try {
      const img = alt1.getRegion(x, y, w, h);
      if (!img) {
        window.progflashCaptureDiag.error = "getRegion returned null";
        return null;
      }

      if (img.getPixel) return img;
      if (img.data) return wrapImageData(img);

      window.progflashCaptureDiag.error = "unknown image format";
      return null;

    } catch (e) {
      window.progflashCaptureDiag.error = String(e);
      return null;
    }
  };

  // ---- Simple template match ----
  window.findAnchor = function (hay, needle, opts = {}) {
    const tol = opts.tolerance ?? 90;
    const minScore = opts.minScore ?? 0.25;

    let best = { score: 0 };

    for (let y = 0; y <= hay.height - needle.height; y++) {
      for (let x = 0; x <= hay.width - needle.width; x++) {
        let good = 0, total = 0;

        for (let ny = 0; ny < needle.height; ny += 2) {
          for (let nx = 0; nx < needle.width; nx += 2) {
            total++;
            const np = needle.getPixel(nx, ny);
            const hp = hay.getPixel(x + nx, y + ny);

            const dr = Math.abs((np & 255) - (hp & 255));
            const dg = Math.abs(((np >> 8) & 255) - ((hp >> 8) & 255));
            const db = Math.abs(((np >> 16) & 255) - ((hp >> 16) & 255));

            if (dr <= tol && dg <= tol && db <= tol) good++;
          }
        }

        const score = good / total;
        if (score > best.score) {
          best = { score, x, y };
        }
      }
    }

    return best.score >= minScore
      ? { ok: true, ...best }
      : { ok: false };
  };

  console.log("matcher.js loaded (Alt1-native)");

})();
