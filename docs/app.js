// app.js — calibration-based WIDE scanning + TRACK, with version/build visible
// Requires matcher.js exposing: captureRs, findAnchor, loadImage
// Uses alt1.mousePosition for one-click calibration. :contentReference[oaicite:1]{index=1}

const statusEl = document.getElementById("status");
const modeEl   = document.getElementById("mode");
const lockEl   = document.getElementById("lock");
const progEl   = document.getElementById("progress");
const dbgEl    = document.getElementById("debugBox");

const startBtn = document.getElementById("startBtn");
const stopBtn  = document.getElementById("stopBtn");
const testBtn  = document.getElementById("testFlashBtn");
const calibBtn = document.getElementById("calibrateBtn");

const calibWideEl = document.getElementById("calibWide");

function setStatus(v){ if (statusEl) statusEl.textContent = v; }
function setMode(v){ if (modeEl) modeEl.textContent = v; }
function setLock(v){ if (lockEl) lockEl.textContent = v; }
function setProgress(v){ if (progEl) progEl.textContent = v; }
function dbg(v){ if (dbgEl) dbgEl.textContent = String(v); }

const APP_VERSION = window.APP_VERSION || "unknown";
const BUILD_ID = window.BUILD_ID || "unknown";

// ----------------- CONFIG -----------------

// Default WIDE region if not calibrated (full viewport)
const DEFAULT_WIDE = {
  x: 0,
  y: 0,
  w: null, // null means "use full img width"
  h: null  // null means "use full img height"
};

// How big the calibrated WIDE box should be (centered on the mouse when calibrating)
const CALIB = {
  boxW: 1200,
  boxH: 520
};

// After lock, track near last position (small box => low lag)
const TRACK = {
  padX: 220,
  padY: 140,
  minW: 420,
  minH: 220
};

// Matcher thresholds
const MATCH = {
  tolerance: 65,
  minScoreWide: 0.70,
  minScoreTrack: 0.78
};

// Overlays (throttled to avoid focus weirdness)
const OVERLAY = {
  enabled: true,
  thickness: 2,
  showWide: false,  // keep false by default (stable + no minimising)
  showTrack: true,
  showFound: true
};

// ------------------------------------------

let running = false;
let loop = null;
let anchor = null;

let locked = false;
let lastLock = { x: 0, y: 0, score: 0 };

// persisted calibrated wide box (in capture coords)
const LS_KEY = "progflash.calibWide";
let calibratedWide = loadCalibWide();

// ---------- Persistence ----------
function loadCalibWide(){
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || typeof obj.x !== "number" || typeof obj.y !== "number" ||
        typeof obj.w !== "number" || typeof obj.h !== "number") return null;
    return obj;
  } catch (_) {
    return null;
  }
}

function saveCalibWide(obj){
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(obj));
  } catch (_) {}
}

function updateCalibLabel(){
  if (!calibWideEl) return;
  if (!calibratedWide) {
    calibWideEl.textContent = "none";
    return;
  }
  calibWideEl.textContent = `x=${calibratedWide.x},y=${calibratedWide.y},w=${calibratedWide.w},h=${calibratedWide.h}`;
}

// ---------- Image helpers ----------
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

function clampRegionToImg(img, region){
  let x = Math.max(0, Math.min(img.width - 1, region.x));
  let y = Math.max(0, Math.min(img.height - 1, region.y));
  let w = Math.max(1, Math.min(region.w, img.width - x));
  let h = Math.max(1, Math.min(region.h, img.height - y));
  return { x, y, w, h };
}

function getWideRegion(img){
  // Use calibrated region if available
  if (calibratedWide) {
    const r = clampRegionToImg(img, calibratedWide);
    return { ...r, mode: "WIDE(CALIB)" };
  }

  // Default full viewport
  const w = DEFAULT_WIDE.w == null ? img.width : DEFAULT_WIDE.w;
  const h = DEFAULT_WIDE.h == null ? img.height : DEFAULT_WIDE.h;
  const r = clampRegionToImg(img, { x: DEFAULT_WIDE.x, y: DEFAULT_WIDE.y, w, h });
  return { ...r, mode: "WIDE(DEFAULT)" };
}

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

// ---------- Overlay helpers ----------
let lastOverlayDraw = 0;

function overlayRect(color, x, y, w, h, label){
  if (!OVERLAY.enabled) return;
  if (!window.alt1) return;
  if (!alt1.permissionOverlay) return;

  // throttle overlays
  const now = Date.now();
  if (now - lastOverlayDraw < 250) return;
  lastOverlayDraw = now;

  const sx = (alt1.rsX || 0) + x;
  const sy = (alt1.rsY || 0) + y;

  try {
    if (typeof alt1.overLayRect === "function") {
      // overLayRect(color, x, y, w, h, time, lineWidth) :contentReference[oaicite:2]{index=2}
      alt1.overLayRect(color, sx, sy, w, h, 700, OVERLAY.thickness);
    }
    if (label && typeof alt1.overLayText === "function") {
      // overLayText(str, color, size, x, y, time) :contentReference[oaicite:3]{index=3}
      alt1.overLayText(label, color, 14, sx + 6, sy + 6, 700);
    }
  } catch (_) {}
}

function drawScanOverlay(region){
  if (region.mode.startsWith("WIDE") && !OVERLAY.showWide) return;
  if (region.mode === "TRACK" && !OVERLAY.showTrack) return;

  const color = (region.mode === "TRACK") ? 0xA0FFAA00 : 0xA000FF00;
  overlayRect(color, region.x, region.y, region.w, region.h, region.mode);
}

function drawFoundOverlay(foundX, foundY){
  if (!OVERLAY.showFound) return;
  if (!anchor) return;
  overlayRect(0xA00088FF, foundX, foundY, anchor.width, anchor.height, "FOUND");
}

// ---------- Matching ----------
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

// ---------- Calibration ----------
function unpackMousePosition(packed){
  // packed: x=r>>16, y=r&0xFFFF :contentReference[oaicite:4]{index=4}
  const x = (packed >>> 16) & 0xFFFF;
  const y = packed & 0xFFFF;
  return { x, y };
}

function calibrateNow(){
  if (!window.alt1) {
    setStatus("Alt1 missing");
    return;
  }

  // mousePosition is a packed int. It’s only valid when mouse is inside RS client. :contentReference[oaicite:5]{index=5}
  const packed = alt1.mousePosition;
  if (typeof packed !== "number") {
    setStatus("Calibrate failed");
    dbg("alt1.mousePosition not available. This may require the relevant permission (gamestate) in Alt1.\n\n" +
        JSON.stringify({ app: { version: APP_VERSION, build: BUILD_ID }, mousePositionType: typeof packed }, null, 2));
    return;
  }

  const mp = unpackMousePosition(packed);

  // If mouse is outside RS, mp may come through as 0,0 depending on setup.
  // We’ll guard against obvious bad values.
  if ((mp.x === 0 && mp.y === 0) || mp.x < 0 || mp.y < 0) {
    setStatus("Calibrate failed");
    dbg("Mouse position invalid. Hover your mouse over the progress bar INSIDE the RuneScape client, then click Calibrate.\n\n" +
        JSON.stringify({ packed, mp }, null, 2));
    return;
  }

  // Build calibrated WIDE box centered on mouse
  const halfW = Math.floor(CALIB.boxW / 2);
  const halfH = Math.floor(CALIB.boxH / 2);

  let x = Math.floor(mp.x - halfW);
  let y = Math.floor(mp.y - halfH);

  // Clamp to positive — further clamping to viewport happens at runtime (when we have capture dims)
  x = Math.max(0, x);
  y = Math.max(0, y);

  calibratedWide = { x, y, w: CALIB.boxW, h: CALIB.boxH };
  saveCalibWide(calibratedWide);
  updateCalibLabel();

  setStatus("Calibrated");
  dbg(JSON.stringify({
    app: { version: APP_VERSION, build: BUILD_ID },
    note: "Calibrated WIDE region saved. Start scanning now.",
    mouse: { packed, x: mp.x, y: mp.y },
    calibratedWide
  }, null, 2));
}

// ---------- App lifecycle ----------
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
    anchor = await loadImage("img/progbar_anchor.png?v=" + encodeURIComponent(BUILD_ID));
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
    drawScanOverlay(region);

    result = runMatch(img, region, MATCH.minScoreTrack);

    if (!result.ok) {
      // Reacquire in WIDE (calibrated or default)
      const wide = getWideRegion(img);
      drawScanOverlay(wide);
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
    drawScanOverlay(region);
    result = runMatch(img, region, MATCH.minScoreWide);
  }

  if (result.ok){
    locked = true;
    lastLock = { x: result.x, y: result.y, score: result.score };

    setStatus("Locked");
    setLock(`x=${result.x}, y=${result.y}`);
    setProgress("locked");

    drawFoundOverlay(result.x, result.y);

    dbg(JSON.stringify({
      app: { version: APP_VERSION, build: BUILD_ID },
      scanMode: region.mode,
      capture: { w: img.width, h: img.height },
      calibratedWide,
      scanRegion: { x: region.x, y: region.y, w: region.w, h: region.h },
      anchor: { w: anchor.width, h: anchor.height },
      res: { ok: true, x: result.x, y: result.y, score: result.score }
    }, null, 2));
  } else {
    setStatus("Searching…");
    setLock("none");
    setProgress("—");

    dbg(JSON.stringify({
      app: { version: APP_VERSION, build: BUILD_ID },
      scanMode: region.mode,
      capture: { w: img.width, h: img.height },
      calibratedWide,
      scanRegion: { x: region.x, y: region.y, w: region.w, h: region.h },
      anchor: { w: anchor.width, h: anchor.height },
      res: result
    }, null, 2));
  }
}

// Buttons
testBtn.onclick = () => alert("flash test");
startBtn.onclick = () => start().catch(console.error);
stopBtn.onclick = () => stop();
if (calibBtn) calibBtn.onclick = () => calibrateNow();

// Init UI
updateCalibLabel();
setStatus("Idle");
setMode("Not running");
setLock("none");
setProgress("—");
dbg(JSON.stringify({ app: { version: APP_VERSION, build: BUILD_ID }, calibratedWide }, null, 2));
