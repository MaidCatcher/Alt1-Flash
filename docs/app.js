// app.js — diagnostic build with scan-region overlay + lock tracking
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

// --- Scan configuration ---
// WIDE scan: where the bar usually is (tune if needed)
const WIDE = {
  bottomPx: 260, // scan bottom strip height
  rightPx:  900  // scan right strip width
};

// TRACK scan: when locked, search only near last position
const TRACK = {
  padX: 220,  // padding around last X
  padY: 140,  // padding around last Y
  minW: 420,  // minimum tracking window size
  minH: 220
};

// Matcher thresholds
const MATCH = {
  tolerance: 65,
  minScoreWide: 0.65,
  minScoreTrack: 0.70
};

// Overlay visualization
const OVERLAY = {
  enabled: true,    // if alt1.permissionOverlay is true, draw scan region
  thickness: 2,
  durationMs: 250   // redraw every tick; keep it visible
};

// Internal lock state
let locked = false;
let lastLock = { x: 0, y: 0, score: 0 };

// Create a cropped "view" of an image without copying pixel buffers
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

// Compute WIDE search region within captured RS viewport
function getWideRegion(img){
  const x = Math.max(0, img.width  - WIDE.rightPx);
  const y = Math.max(0, img.height - WIDE.bottomPx);
  const w = img.width  - x;
  const h = img.height - y;
  return { x, y, w, h, mode: "WIDE" };
}

// Compute TRACK region around lastLock (within captured RS viewport)
function getTrackRegion(img){
  const desiredW = Math.max(TRACK.minW, TRACK.padX * 2);
  const desiredH = Math.max(TRACK.minH, TRACK.padY * 2);

  let x = Math.floor(lastLock.x - desiredW / 2);
  let y = Math.floor(lastLock.y - desiredH / 2);

  // clamp to viewport
  x = Math.max(0, Math.min(img.width  - 1, x));
  y = Math.max(0, Math.min(img.height - 1, y));

  let w = Math.min(desiredW, img.width  - x);
  let h = Math.min(desiredH, img.height - y);

  // ensure >= 1
  w = Math.max(1, w);
  h = Math.max(1, h);

  return { x, y, w, h, mode: "TRACK" };
}

// Draw a rectangle on the RS client showing scan area
function drawScanOverlay(region){
  if (!OVERLAY.enabled) return;
  if (!window.alt1) return;
  if (!alt1.permissionOverlay) return;

  // region is in CAPTURE coords (within RS viewport)
  // convert to screen coords: rsX/rsY is the RS viewport offset on the monitor
  const sx = (alt1.rsX || 0) + region.x;
  const sy = (alt1.rsY || 0) + region.y;

  // Alt1 overlay API: alt1.overLayRect(x,y,w,h,color,thickness,time)
  // color is ARGB int. We'll use:
  // - WIDE: 0xA000FF00 (semi-green)
  // - TRACK: 0xA0FFAA00 (semi-orange)
  const color = region.mode === "TRACK" ? 0xA0FFAA00 : 0xA000FF00;

  try {
    if (typeof alt1.overLayRect === "function") {
      alt1.overLayRect(sx, sy, region.w, region.h, color, OVERLAY.thickness, OVERLAY.durationMs);
    }
    // Optional: label it if available
    if (typeof alt1.overLayText === "function") {
      alt1.overLayText(region.mode, sx + 6, sy + 6, color, OVERLAY.durationMs);
    }
  } catch (e) {
    // Don’t crash if overlay call fails
  }
}

async function start(){
  if (!window.alt1){
    setStatus("Alt1 missing");
    dbg("Open this inside Alt1 Toolkit.");
    return;
  }

  // show basic Alt1 state right away
  dbg(JSON.stringify({
    alt1: true,
    permissionPixel: !!alt1.permissionPixel,
    permissionOverlay: !!alt1.permissionOverlay,
    hasGetRegion: typeof alt1.getRegion === "function",
    rsX: alt1.rsX, rsY: alt1.rsY,
    rsWidth: alt1.rsWidth, rsHeight: alt1.rsHeight
  }, null, 2));

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
    anchor = await loadImage("img/anchortest.png?v=" + Date.now());
  }
  if (!anchor){
    setStatus("Anchor load failed");
    dbg("Could not load img/anchortest.png (check path + case).");
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

  // Decide scan mode
  // If locked: try TRACK first (small region = less lag)
  // If TRACK fails: fall back to WIDE to reacquire
  let region, result;

  if (locked) {
    region = getTrackRegion(img);
    drawScanOverlay(region);

    result = runMatch(img, region, MATCH.minScoreTrack);

    if (!result.ok) {
      // reacquire
      const wide = getWideRegion(img);
      drawScanOverlay(wide);
      const reacq = runMatch(img, wide, MATCH.minScoreWide);

      if (reacq.ok) {
        result = reacq;
        region = wide;
      } else {
        // lost lock
        locked = false;
      }
    }
  } else {
    region = getWideRegion(img);
    drawScanOverlay(region);
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
      tracking: locked ? { lastX: lastLock.x, lastY: lastLock.y, lastScore: lastLock.score } : null
    }, null, 2));
  } else {
    setStatus("Searching…");
    setLock("none");
    setProgress("—");

    dbg(JSON.stringify({
      scanMode: locked ? "TRACK (lost)" : region.mode,
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
