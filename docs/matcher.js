
// Minimal image matcher for Alt1 (browser-only)
// Uses Alt1's captureHoldFullRs() + simple pixel comparison

export function capture() {
  if (!window.alt1 || !alt1.captureHoldFullRs) return null;
  return alt1.captureHoldFullRs();
}

export function loadImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.src = url;
    img.onload = () => resolve(img);
  });
}

export function findImage(haystack, needleImg) {
  const cw = haystack.width;
  const ch = haystack.height;

  const nc = document.createElement("canvas");
  nc.width = needleImg.width;
  nc.height = needleImg.height;
  const nctx = nc.getContext("2d");
  nctx.drawImage(needleImg, 0, 0);
  const needle = nctx.getImageData(0, 0, nc.width, nc.height).data;

  const step = 4; // fast enough for progress bars

  for (let y = 0; y < ch - nc.height; y += 2) {
    for (let x = 0; x < cw - nc.width; x += 2) {
      let match = 0;
      for (let i = 0; i < needle.length; i += step * 4) {
        const hi = ((y * cw + x) * 4) + i;
        if (
          haystack.data[hi] === needle[i] &&
          haystack.data[hi + 1] === needle[i + 1] &&
          haystack.data[hi + 2] === needle[i + 2]
        ) {
          match++;
        }
      }
      if (match > 20) {
        return { x, y };
      }
    }
  }
  return null;
}
