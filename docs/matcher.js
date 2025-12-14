// matcher.js — ProgFlash
// Provides global helpers for app.js

(function () {
  if (!window.alt1) return;

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = url;
    });
  }

  function captureRs() {
    if (!alt1.permissionPixel) return null;
    return alt1.captureScreen();
  }

  function findAnchor(img, anchor, opts) {
    if (!window.a1lib || !a1lib.findSubimage) return null;
    return a1lib.findSubimage(img, anchor, opts);
  }

  // expose ONLY these
  window.progflashLoadImage = loadImage;
  window.progflashCaptureRs = captureRs;
  window.progflashFindAnchor = findAnchor;
})();
