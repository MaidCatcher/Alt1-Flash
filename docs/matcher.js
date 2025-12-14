// matcher.js

window.captureRs = async function () {
  if (!window.alt1) {
    console.log("alt1 not detected");
    return null;
  }

  try {
    // Fixed: supply "RS3" as the region identifier
    const region = await alt1.getRegion("RS3");
    const img = await region.capture();
    return img;
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

// async matcher function using new anchor
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

console.log("matcher.js loaded (getRegion)");
