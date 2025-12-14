// matcher.js

window.captureRs = async function () {
  if (!window.alt1) {
    console.log("alt1 not detected");
    return null;
  }

  try {
    if (typeof alt1.captureScreen === "function") {
      const img = await alt1.captureScreen(); // direct capture
      return img;
    } else {
      console.error("alt1.captureScreen is not a function.");
      return null;
    }
  } catch (e) {
    console.error("Failed to capture screen:", e);
    return null;
  }
};

window.loadImage = async function (path) {
  const response = await fetch(path);
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);
  return bitmap;
};

window.findAnchor = async function (needleImg) {
  const img = await window.captureRs();
  if (!img) return { ok: false };

  const match = img.findSubimage(needleImg, {
    tolerance: 50,
    debug: true,
  });

  if (match.length > 0) {
    return {
      ok: true,
      x: match[0].x,
      y: match[0].y,
      score: match[0].score,
    };
  }

  return { ok: false };
};

console.log("matcher.js loaded (captureScreen)");
