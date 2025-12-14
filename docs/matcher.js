
window.captureRs = async function () {
  try {
    const img = a1lib.captureHoldFullRs();
    if (!img) {
      console.warn("Image capture returned null.");
      return null;
    }
    return img;
  } catch (e) {
    console.error("captureRs failed:", e);
    return null;
  }
};

window.findAnchor = async function (needleUrl) {
  const needleImg = await loadImage(needleUrl);
  if (!needleImg) {
    console.warn("Needle image not loaded.");
    return { ok: false };
  }

  const haystack = await captureRs();
  if (!haystack) return { ok: false };

  const match = haystack.findSubimage(needleImg, { tolerance: 50 });
  if (!match) return { ok: false };

  return { ok: true, x: match.x, y: match.y };
};

window.loadImage = async function (url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, img.width, img.height);
      resolve(new a1lib.ImageDataWrapper(data));
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
};
