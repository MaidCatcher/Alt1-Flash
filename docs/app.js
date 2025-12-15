// app.js — scan-region overlay + lock tracking (configurable WIDE region)
// Requires matcher.js exposing: captureRs, findAnchor, loadImage

const statusEl = document.getElementById("status");
const modeEl   = document.getElementById("mode");
const lockEl   = document.getElementById("lock");
const progEl   = document.getElementById("progress");
const dbgEl    = document.getElementById("debugBox");

const startBtn = document.getElementById("startBtn");
const stopBtn  = document.getElementById("stopBtn");
const testBtn  = document.getElementById("testFlashBtn");

function setStatus(v){ if (statusEl) statusEl.textContent = v; }
function setMode(v){ if (modeEl) modeEl.textContent = v; }
function setLock(v){ if (lockEl) lockEl.textContent = v; }
function setProgress(v){ if (progEl) progEl.textContent = v; }
function dbg(v){ if (dbgEl) dbgEl.textContent = String(v); }

let running = false;
let loop = null;
let anchor = null;

// ----------------- CONFIG -----------------

// WIDE scan region: pick which edge(s) to scan.
// Example presets:
// - top-center-ish: set yFrom:"top", yPx:220; xFrom:"left", xPx: img.width (full width)
// - bottom-right:  yFrom:"bottom", yPx:260; xFrom:"right", xPx:900
const WIDE = {
  // "left" means scan starts at x=0 for width xPx
  // "right" means scan starts at x=img.width-xPx for width xPx
  xFrom: "right",   // "left" | "right"
  xPx: 900,         // width of scan strip/region (px)

  // "top" means scan starts at y=0 for height yPx
  // "bottom" means scan starts at y=img.height-yPx for height yPx
  yFrom: "bottom",  // "top" | "bottom"
  yPx: 260          // height of scan strip/region (px)
};

// TRACK scan: after lock, search only near last position
const TRACK = {
  padX: 220,
  padY: 140,
  minW: 420,
  minH: 220
};

// Matcher thresholds
const MATCH = {
  tolerance: 65,
  minScoreWide: 0.65,
  minScoreTrack: 0.70
};

// Overlay drawing
const OVERLAY = {
  enabled: true,
  thickness: 2
};

// ------------------------------------------

let locked = false;
let lastLock = { x: 0, y: 0, score: 0 };

// Crop view without copying buffers
function cropView(img, ox, oy, w, h){
  const x0 = Math.max(0, Math.min(img.width  - 1, ox));
  const y0 = Math.max(0, Math.min(img.height - 1, oy));
  const cw = Math.max(1, Math.min(w, img.width  - x0));
  const ch = Math.max(1, Math.min(h, img.height - y0));

  return {
    width: cw,
    height: ch,
    _offsetX: x0,
    _offsetY: y0,
    getPixel(x, y){
      return img.getPixel(x0 + x, y0 + y);
    }
  };
}

// Compute configurable WIDE region
function getWideRegion(img){
  const w = Math.max(1, Math.min(WIDE.xPx, img.width));
  const h = Math.max(1, Math.min(WIDE.yPx, img.height));

  const x = (WIDE.xFrom === "right") ? Math.max(0, img.width - w) : 0;
  const y = (WIDE.yFrom === "bottom") ? Math.max(0, img.height - h) : 0;

  return { x, y, w, h, mode: "WIDE" };
}

// Compute TRACK region around last lock
function getTrackRegion(img){
  const desiredW = Math.max(TRACK.minW, TRACK.padX * 2);
  const desiredH = Math.max(TRACK.minH, TRACK.padY * 2);

  let x = Math.floor(lastLock.x - desiredW / 2);
  let y = Math.floor(lastLock.y - desiredH / 2);

  x = Math.max(0, Math.min(img.width  - 1, x));
  y = Math.max(0, Math.min(img.height - 1, y));

  let w = Math.min(desiredW, img.width  - x);
  let h = Math.min(desiredH, img.height - y);

  w = Math.max(1, w);
  h = Math.max(1, h);

  return { x, y, w, h, mode: "TRACK" };
}

// Correct Alt1 overlay call order + throttling
let lastOverlayDraw = 0;
function drawScanOverlay(region){
  if (!OVERLAY.enabled) return;
  if (!window.alt1) return;
  if (!alt1.permissionOverlay) return;

  const now = Date.now();
  if (now - lastOverlayDraw < 700) return;
  lastOverlayDraw = now;

  const sx = (alt1.rsX || 0) + region.x;
  const sy = (alt1.rsY || 0) + region.y;

  const color = region.mode === "TRACK" ? 0xA0FFAA00 : 0xA000FF00;

  try {
    if (typeof alt1.overLayRect === "function") {
      // overLayRect(color, x, y, w, h, time, lineWidth)
      alt1.overLayRect(color, sx, sy, region.w, region.h, 900, OVERLAY.thickness);
    }
    if (typeof alt1.overLayText === "function") {
      // overLayText(str, color, size, x, y, time)
      alt1.overLayText(region.mode, color, 14, sx + 6, sy + 6, 900);
    }
  } catch (_) {}
}

async function start(){
  if (!window.alt1){
    setStatus("Alt1 missing");
    dbg("Open this inside Alt1 Toolkit.");
    return;
  }

  if (typeof window.captureRs !== "function" ||
      typeof window.findAnchor !== "function" ||
      typeof window.loadImage !== "function") {
    setStatus("matcher.js not loaded");
    dbg("Missing globals:\n" + JSON.stringify({
      captureRs: typeof window.captureRs,
      findAnchor: typeof window.findAnchor,
      loadImage: typeof window.loadImage
    }, null, 2));
    return;
  }

  if (!anchor){
    setStatus("Loading anchor…");
    anchor = await loadImage("img/progbar_anchor.png?v=" + Date.now());
  }
  if (!anchor){
    setStatus("Anchor load failed");
    dbg("Could not load img/progbar_anchor.png (check path + case).");
    return;
  }

  running = true;
  locked = false;
  lastLock = { x: 0, y: 0, score: 0 };

  setMode("Running");
  setStatus("Searching…");
  setLock("none");
  setProgress("—");

  if (loop) clearInterval(loop);
  loop = setInterval(tick, 200);
}

function stop(){
  running = false;
  locked = false;
  if (loop) clearInterval(loop);
  loop = null;
  setMode("Not running");
  setStatus("Idle");
  setLock("none");
  setProgress("—");
}

function runMatch(img, region, minScore){
  const hay = cropView(img, region.x, region.y, region.w, region.h);
  const res = findAnchor(hay, anchor, {
    tolerance: MATCH.tolerance,
    minScore
  });

  if (res && res.ok) {
    return {
      ok: true,
      x: res.x + hay._offsetX,
      y: res.y + hay._offsetY,
      score: res.score
    };
  }
  return { ok: false, score: res && typeof res.score === "number" ? res.score : null };
}

function tick(){
  if (!running) return;

  const img = captureRs();
  if (!img){
    setStatus("Capture failed");
    const d = window.progflashCaptureDiag || {};
    dbg("captureRs(): null\n\n" + JSON.stringify(d, null, 2));
    return;
  }

  let region, result;

  if (locked) {
    region = getTrackRegion(img);
    drawScanOverlay(region); // safe (throttled)

    result = runMatch(img, region, MATCH.minScoreTrack);

    if (!result.ok) {
      // reacquire in WIDE
      const wide = getWideRegion(img);
      // IMPORTANT: do NOT spam overlay while searching; only draw WIDE if you want:
      // drawScanOverlay(wide);
      const reacq = runMatch(img, wide, MATCH.minScoreWide);

      if (reacq.ok) {
        result = reacq;
        region = wide;
      } else {
        locked = false;
      }
    }
  } else {
    region = getWideRegion(img);
    // no overlay here to keep it stable for everyone
    result = runMatch(img, region, MATCH.minScoreWide);
  }

  if (result.ok){
    locked = true;
    lastLock = { x: result.x, y: result.y, score: result.score };

    setStatus("Locked");
    setLock(`x=${result.x}, y=${result.y}`);
    setProgress("locked");

    dbg(JSON.stringify({
      scanMode: region.mode,
      capture: { w: img.width, h: img.height },
      scanRegion: { x: region.x, y: region.y, w: region.w, h: region.h },
      anchor: { w: anchor.width, h: anchor.height },
      res: { ok: true, x: result.x, y: result.y, score: result.score },
      tracking: { lastX: lastLock.x, lastY: lastLock.y, lastScore: lastLock.score }
    }, null, 2));
  } else {
    setStatus("Searching…");
    setLock("none");
    setProgress("—");

    dbg(JSON.stringify({
      scanMode: region.mode,
      capture: { w: img.width, h: img.height },
      scanRegion: { x: region.x, y: region.y, w: region.w, h: region.h },
      anchor: { w: anchor.width, h: anchor.height },
      res: result
    }, null, 2));
  }
}

testBtn.onclick = () => alert("flash test");
startBtn.onclick = () => start().catch(console.error);
stopBtn.onclick = () => stop();

setStatus("Idle");
setMode("Not running");
setLock("none");
setProgress("—");
