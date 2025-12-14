// matcher.js — Alt1-only, NO a1lib
// Provides: loadImage(), captureRs(), findAnchor()
// Adds: detailed capture diagnostics in window.progflashCaptureDiag

(function () {

  function wrapRGBA(width, height, data) {
    return {
      width,
      height,
      getPixel(x, y) {
        if (x < 0 || y < 0 || x >= width || y >= height) return 0;
        const i = (y * width + x) * 4;
        const r = data[i] & 255;
        const g = data[i + 1] & 255;
        const b = data[i + 2] & 255;
        const a = data[i + 3] & 255;
        return (r) | (g << 8) | (b << 16) | (a << 24);
      }
    };
  }

  function wrapImageData(imageData) {
    return wrapRGBA(imageData.width, imageData.height, imageData.data);
  }

  function asClampedArray(maybe) {
    if (!maybe) return null;

    // ImageData.data
    if (maybe instanceof Uint8ClampedArray) return maybe;

    // TypedArray view
    if (ArrayBuffer.isView(maybe)) {
      return new Uint8ClampedArray(maybe.buffer);
    }

    // ArrayBuffer
    if (maybe instanceof ArrayBuffer) {
      return new Uint8ClampedArray(maybe);
    }

    return null;
  }

  function normalizeAlt1Image(obj, diag) {
    if (!obj) return null;

    // Quick success path: Alt1 already gives wrapper
    if (typeof obj.getPixel === "function" && typeof obj.width === "number" && typeof obj.height === "number") {
      diag.format = "native getPixel";
      return obj;
    }

    // Some builds use w/h or Width/Height
    const w = obj.width ?? obj.w ?? obj.Width ?? obj.W;
    const h = obj.height ?? obj.h ?? obj.Height ?? obj.H;

    // Common raw buffer fields
    const raw =
      obj.data ??
      obj.pixels ??
      obj.pixelData ??
      obj.pixeldata ??
      obj.buffer ??
      obj.buf ??
      obj.rgba ??
      obj.rgbaData;

    const arr = asClampedArray(raw);
    if (w && h && arr) {
      diag.format = "raw rgba array field";
      diag.rawField = raw === obj.data ? "data"
        : raw === obj.pixels ? "pixels"
        : raw === obj.pixelData ? "pixelData"
        : raw === obj.pixeldata ? "pixeldata"
        : raw === obj.buffer ? "buffer"
        : raw === obj.buf ? "buf"
        : raw === obj.rgba ? "rgba"
        : "rgbaData";
      return wrapRGBA(w, h, arr);
    }

    // Method-based conversions (names vary by Alt1 version)
    try {
      if (typeof obj.toImageData === "function") {
        const id = obj.toImageData();
        if (id && id.data && id.width && id.height) {
          diag.format = "toImageData()";
          return wrapImageData(id);
        }
      }
    } catch (e) { diag.toImageDataError = String(e); }

    try {
      if (typeof obj.getImageData === "function") {
        const id = obj.getImageData();
        if (id && id.data && id.width && id.height) {
          diag.format = "getImageData()";
          return wrapImageData(id);
        }
      }
    } catch (e) { diag.getImageDataError = String(e); }

    try {
      if (typeof obj.toData === "function") {
        const id = obj.toData();
        if (id && id.data && id.width && id.height) {
          diag.format = "toData()";
          return wrapImageData(id);
        }
      }
    } catch (e) { diag.toDataError = String(e); }

    return null;
  }

  // ---- loadImage (anchor) ----
  window.loadImage = function (path) {
    return new Promise(resolve => {
      const img = new Image();
      img.onload = () => {
        try {
          const c = document.createElement("canvas");
          c.width = img.width;
          c.height = img.height;
          const ctx = c.getContext("2d");
          ctx.drawImage(img, 0, 0);
          resolve(wrapImageData(ctx.getImageData(0, 0, c.width, c.height)));
        } catch (e) {
          console.error("loadImage failed:", e);
          resolve(null);
        }
      };
      img.onerror = () => resolve(null);
      img.src = path;
    });
  };

  // ---- captureRs ----
  window.progflashCaptureDiag = {};

  window.captureRs = function () {
    const diag = {};
    window.progflashCaptureDiag = diag;

    try {
      if (!window.alt1) { diag.error = "alt1 missing"; return null; }
      diag.permissionPixel = !!alt1.permissionPixel;
      diag.permissionOverlay = !!alt1.permissionOverlay;
      diag.hasGetRegion = (typeof alt1.getRegion === "function");

      if (!alt1.permissionPixel) { diag.error = "permissionPixel false"; return null; }
      if (typeof alt1.getRegion !== "function") { diag.error = "getRegion missing"; return null; }

      const x = alt1.rsX ?? 0;
      const y = alt1.rsY ?? 0;
      const w = alt1.rsWidth;
      const h = alt1.rsHeight;

      diag.request = { x, y, w, h };

      if (!w || !h) { diag.error = "rs size is zero"; return null; }

      let raw = null;
      try {
        raw = alt1.getRegion(x, y, w, h);
      } catch (e) {
        diag.exception = String(e);
        return null;
      }

      diag.rawType = typeof raw;
      if (!raw) { diag.error = "getRegion returned null"; return null; }

      // Introspect shape for debugging
      try {
        diag.rawKeys = Object.keys(raw);
        diag.rawOwnProps = Object.getOwnPropertyNames(raw).slice(0, 40);
      } catch {}

      const norm = normalizeAlt1Image(raw, diag);
      if (!norm) {
        diag.error = "unknown image format";
        return null;
      }

      diag.ok = true;
      diag.norm = { w: norm.width, h: norm.height, hasGetPixel: typeof norm.getPixel === "function" };
      return norm;

    } catch (e) {
      diag.error = "captureRs exception";
      diag.exception = String(e);
      return null;
    }
  };

  // ---- findAnchor (simple template match) ----
  window.findAnchor = function (hay, needle, opts = {}) {
    if (!hay || !needle) return { ok: false };

    const tol = opts.tolerance ?? 90;
    const minScore = opts.minScore ?? 0.25;

    let bestScore = 0;
    let bestX = 0, bestY = 0;

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
        if (score > bestScore) { bestScore = score; bestX = x; bestY = y; }
      }
    }

    return bestScore >= minScore
      ? { ok: true, x: bestX, y: bestY, score: bestScore }
      : { ok: false, score: bestScore };
  };

  console.log("matcher.js loaded (Alt1 only, capture normalize)");

})();
