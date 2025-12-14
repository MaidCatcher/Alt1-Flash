// matcher.js — ProgFlash (Alt1-compatible, NO external libs)
// Exposes: loadImage(), captureRs(), findAnchor()
// Also exposes progflash* aliases.

(function(){
  if (!window.alt1) {
    console.warn("Alt1 not detected yet (window.alt1 missing).");
  }

  // ---- Image wrapper helpers ----
  function makeWrapperFromImageData(imageData){
    // imageData: {width,height,data(Uint8ClampedArray)}
    return {
      width: imageData.width,
      height: imageData.height,
      data: imageData.data,
      // Return packed int in same style app.js expects (r | g<<8 | b<<16 | a<<24)
      getPixel: function(x, y){
        if (x < 0 || y < 0 || x >= this.width || y >= this.height) return 0;
        const i = (y * this.width + x) * 4;
        const d = this.data;
        const r = d[i] & 255;
        const g = d[i+1] & 255;
        const b = d[i+2] & 255;
        const a = d[i+3] & 255;
        return (r) | (g<<8) | (b<<16) | (a<<24);
      }
    };
  }

  // ---- loadImage(path) -> wrapper with getPixel ----
  window.loadImage = function(path){
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try{
          const c = document.createElement("canvas");
          c.width = img.width;
          c.height = img.height;
          const ctx = c.getContext("2d");
          ctx.drawImage(img, 0, 0);
          const id = ctx.getImageData(0,0,c.width,c.height);
          resolve(makeWrapperFromImageData(id));
        } catch(e){
          console.error("loadImage failed:", e);
          resolve(null);
        }
      };
      img.onerror = () => resolve(null);
      img.src = path;
    });
  };

  // ---- captureRs() -> wrapper with getPixel ----
  // Uses alt1.getRegion(x,y,w,h) which exists in your environment.
  window.progflashCaptureDiag = {};
  window.captureRs = function(){
    try{
      if (!window.alt1) return null;
      if (!alt1.permissionPixel) return null;

      const x = alt1.rsX || 0;
      const y = alt1.rsY || 0;
      const w = alt1.rsWidth;
      const h = alt1.rsHeight;

      window.progflashCaptureDiag = { x, y, w, h };

      if (!w || !h) return null;

      // Alt1 returns an image wrapper already (with getPixel/width/height) in many builds.
      // If it doesn't, try to adapt if it returns ImageData-like.
      const img = alt1.getRegion(x, y, w, h);
      if (!img) return null;

      if (typeof img.getPixel === "function" && typeof img.width === "number") {
        return img;
      }

      // If it returned ImageData-like
      if (img.data && img.width && img.height) {
        return makeWrapperFromImageData(img);
      }

      return null;
    } catch(e){
      console.error("captureRs failed:", e);
      return null;
    }
  };

  // ---- findAnchor(haystack, needle, opts) ----
  // Brute-force template match for small needles (your anchor is small).
  // Returns: { ok, score, x, y, best }
  function findAnchorImpl(hay, needle, opts){
    opts = opts || {};
    const tolerance = (typeof opts.tolerance === "number") ? opts.tolerance : 70;
    const stride = (typeof opts.stride === "number") ? Math.max(1, opts.stride) : 1;
    const minScore = (typeof opts.minScore === "number") ? opts.minScore : 0.35;
    const returnBest = (opts.returnBest !== false);

    if (!hay || !needle) return { ok:false };
    const hw = hay.width, hh = hay.height;
    const nw = needle.width, nh = needle.height;
    if (!hw || !hh || !nw || !nh) return { ok:false };
    if (nw > hw || nh > hh) return { ok:false };

    // Sample grid inside needle (avoid full per-pixel for speed)
    const sampleStep = 2; // good balance for small anchors
    const samples = [];
    for (let y=0; y<nh; y+=sampleStep){
      for (let x=0; x<nw; x+=sampleStep){
        samples.push([x,y, needle.getPixel(x,y)]);
      }
    }
    const total = samples.length || 1;

    let bestScore = -1;
    let bestX = 0, bestY = 0;

    for (let y=0; y<=hh-nh; y+=stride){
      for (let x=0; x<=hw-nw; x+=stride){
        let good = 0;

        // Early abort threshold: must be able to reach minScore
        const must = Math.floor(minScore * total);

        for (let i=0; i<samples.length; i++){
          const sx = samples[i][0], sy = samples[i][1], np = samples[i][2];
          const hp = hay.getPixel(x+sx, y+sy);

          const nr = np & 255, ng = (np>>8)&255, nb = (np>>16)&255;
          const hr = hp & 255, hg = (hp>>8)&255, hb = (hp>>16)&255;

          if (Math.abs(nr-hr) <= tolerance &&
              Math.abs(ng-hg) <= tolerance &&
              Math.abs(nb-hb) <= tolerance) {
            good++;
          } else {
            // can't reach required count
            if ((samples.length - (i+1)) + good < must) break;
          }
        }

        const score = good / total;
        if (score > bestScore){
          bestScore = score;
          bestX = x; bestY = y;
        }
      }
    }

    const ok = bestScore >= minScore;
    if (!returnBest) return { ok, x:bestX, y:bestY, score:bestScore };

    return {
      ok,
      x: bestX,
      y: bestY,
      score: bestScore,
      best: { x: bestX, y: bestY, w: needle.width, h: needle.height }
    };
  }

  window.findAnchor = function(hay, needle, opts){
    return findAnchorImpl(hay, needle, opts);
  };

  // ---- Also export progflash* aliases (both directions) ----
  window.progflashLoadImage = window.loadImage;
  window.progflashCaptureRs  = window.captureRs;
  window.progflashFindAnchor = window.findAnchor;

  console.log("matcher.js loaded (no external libs)");
})();
