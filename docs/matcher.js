export const MATCHER_VERSION = Date.now();

// Minimal, robust template matcher for Alt1.
// - Works on luminance (grayscale) for resilience against minor color shifts.
// - Supports options: tolerance, stride, minScore, returnBest
// Returns:
//   - if returnBest=false: null or {x,y,w,h,score,ok}
//   - if returnBest=true: always returns best candidate {x,y,w,h,score,ok}

export function captureRs() {
  if (!window.alt1 || !alt1.permissionPixel) return null;
  // Alt1 returns ImageData
  return alt1.captureHoldFullRs();
}

export async function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, img.width, img.height);
      resolve(data);
    };
    img.onerror = reject;
    img.src = url;
  });
}

function lum(r,g,b){
  // integer approx of Rec.709
  return (r*2126 + g*7152 + b*722) / 10000;
}

function buildLum(imgData){
  const { data, width, height } = imgData;
  const out = new Float32Array(width * height);
  for (let i=0, p=0; i<data.length; i+=4, p++){
    out[p] = lum(data[i], data[i+1], data[i+2]);
  }
  return out;
}

export function findAnchor(img, anchor, opts = {}) {
  const tolerance = opts.tolerance ?? 70;     // higher = more forgiving
  const stride    = opts.stride ?? 1;         // 1 for small anchors
  const minScore  = opts.minScore ?? 0.52;    // typical for small anchor
  const returnBest = !!opts.returnBest;

  if (!img || !anchor) return returnBest ? { x:0,y:0,w:0,h:0,score:0,ok:false } : null;

  const iw = img.width, ih = img.height;
  const aw = anchor.width, ah = anchor.height;
  if (aw <= 0 || ah <= 0 || aw > iw || ah > ih) {
    return returnBest ? { x:0,y:0,w:aw,h:ah,score:0,ok:false } : null;
  }

  // Precompute luminance arrays (fast enough for these sizes)
  const iLum = buildLum(img);
  const aLum = buildLum(anchor);

  // Convert tolerance (0..255-ish) to per-pixel acceptance.
  // We score pixels as "match" if abs diff <= tolerance.
  const tol = Math.max(1, tolerance);

  let bestScore = -1;
  let bestX = 0, bestY = 0;

  const total = aw * ah;

  for (let y = 0; y <= ih - ah; y += stride) {
    const rowBase = y * iw;
    for (let x = 0; x <= iw - aw; x += stride) {
      let good = 0;
      // Compare anchor
      for (let ay=0; ay<ah; ay++) {
        let iIdx = (rowBase + x) + ay * iw;
        let aIdx = ay * aw;
        for (let ax=0; ax<aw; ax++) {
          const d = Math.abs(iLum[iIdx + ax] - aLum[aIdx + ax]);
          if (d <= tol) good++;
        }
      }
      const score = good / total;
      if (score > bestScore) {
        bestScore = score;
        bestX = x; bestY = y;
      }
    }
  }

  const ok = bestScore >= minScore;
  const result = { x: bestX, y: bestY, w: aw, h: ah, score: bestScore, ok };

  return ok ? result : (returnBest ? result : null);
}
