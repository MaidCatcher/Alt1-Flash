export const MATCHER_VERSION = "1765632483";

export function captureRs() {
  if (!window.alt1 || !alt1.permissionPixel) return null;
  return alt1.capture(alt1.rsX, alt1.rsY, alt1.rsWidth, alt1.rsHeight);
}

export async function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = img.width; c.height = img.height;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      resolve(ctx.getImageData(0, 0, c.width, c.height));
    };
    img.onerror = reject;
    img.src = url;
  });
}

function lumaAt(data, idx) {
  const r = data[idx], g = data[idx+1], b = data[idx+2];
  return (r*54 + g*183 + b*19) >> 8;
}

export function findAnchor(haystack, needle, opts = {}) {
  const {
    tolerance = 65,
    stride = 1,
    minScore = 0.50,
    returnBest = false
  } = opts;

  const H = haystack.height, W = haystack.width;
  const h = needle.height, w = needle.width;
  if (!haystack || !needle) return null;
  if (w > W || h > H) return null;

  const hd = haystack.data;
  const nd = needle.data;

  const needleL = new Uint8Array(w*h);
  for (let yy=0; yy<h; yy++) {
    for (let xx=0; xx<w; xx++) {
      const ni = ((yy*w + xx) * 4);
      needleL[yy*w + xx] = lumaAt(nd, ni);
    }
  }

  let best = { ok:false, score:-1, x:0, y:0, w, h };
  const total = w*h;
  const maxBadBase = (scoreTarget) => Math.floor((1 - scoreTarget) * total);

  for (let y=0; y<=H-h; y+=stride) {
    for (let x=0; x<=W-w; x+=stride) {
      let good = 0;
      let bad = 0;
      const maxBad = maxBadBase(minScore);

      for (let yy=0; yy<h; yy++) {
        const rowBase = ((y+yy)*W + x) * 4;
        const nBase = yy*w;
        for (let xx=0; xx<w; xx++) {
          const hi = rowBase + xx*4;
          const hv = lumaAt(hd, hi);
          const nv = needleL[nBase + xx];
          if (Math.abs(hv - nv) <= tolerance) good++;
          else {
            bad++;
            if (bad > maxBad) {
              yy = h; // break outer
              break;
            }
          }
        }
      }

      const score = good / total;
      if (score > best.score) best = { ok: score >= minScore, score, x, y, w, h };
      if (!returnBest && score >= minScore) return { x, y, w, h, score, ok:true };
    }
  }

  return returnBest ? best : null;
}
