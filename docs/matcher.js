// matcher.js — browser-only, Alt1-safe

export function captureRs() {
  if (!window.alt1) return null;
  if (typeof alt1.captureHoldFullRs === "function") return alt1.captureHoldFullRs();
  if (typeof alt1.capture === "function") return alt1.capture();
  return null;
}

export function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to load image: " + url));
    img.src = url + "?v=" + Date.now(); // cache bust
  });
}

// app.js expects findAnchor()
export function findAnchor(haystack, needleImg) {
  const cw = haystack.width;
  const ch = haystack.height;

  const nc = document.createElement("canvas");
  nc.width = needleImg.width;
  nc.height = needleImg.height;
  const nctx = nc.getContext("2d", { willReadFrequently: true });
  nctx.drawImage(needleImg, 0, 0);
  const needle = nctx.getImageData(0, 0, nc.width, nc.height).data;

  const step = 4;

  for (let y = 0; y < ch - nc.height; y += 2) {
    for (let x = 0; x < cw - nc.width; x += 2) {
      let match = 0;
      for (let i = 0; i < needle.length; i += step * 4) {
        const hi = ((y * cw + x) * 4) + i;
        if (
          haystack.data[hi] === needle[i] &&
          haystack.data[hi + 1] === needle[i + 1] &&
          haystack.data[hi + 2] === needle[i + 2]
        ) match++;
      }
      if (match > 20) return { x, y, w: nc.width, h: nc.height };
    }
  }
  return null;
}
