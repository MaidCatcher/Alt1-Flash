// app.js — Preview-based calibration + on-canvas scan debug box + bestScore debug

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
const calibModeEl = document.getElementById("calibMode");

const canvas = document.getElementById("previewCanvas");
const ctx = canvas.getContext("2d", { willReadFrequently: true });

function setStatus(v){ if (statusEl) statusEl.textContent = v; }
function setMode(v){ if (modeEl) modeEl.textContent = v; }
function setLock(v){ if (lockEl) lockEl.textContent = v; }
function setProgress(v){ if (progEl) progEl.textContent = v; }
function dbg(v){ if (dbgEl) dbgEl.textContent = String(v); }

const APP_VERSION = window.APP_VERSION || "unknown";
const BUILD_ID = window.BUILD_ID || "unknown";

// ---- persisted calibrated wide box (capture coords) ----
const LS_KEY = "progflash.calibWide";
let calibratedWide = loadCalibWide();

// ---- state ----
let running = false;
let loop = null;
let anchor = null;

let locked = false;
let lastLock = { x: 0, y: 0, score: 0 };
let lastBestScore = 0;

let calibrateArmed = false;

// ---- config ----
const CALIB = { boxW: 1200, boxH: 520 };   // WIDE box size after calibration
const TRACK = { padX: 220, padY: 140, minW: 420, minH: 220 };

const MATCH = {
  tolerance: 80,
  minScoreWide: 0.62,
  minScoreTrack: 0.72,
  step: 2,
  ignoreAlphaBelow: 200
};

// Preview update rate (avoid lag)
let lastPreviewDraw = 0;
const PREVIEW_MS = 250; // 4 fps

// Used to map canvas clicks to capture coords
let previewMap = { scale: 1, offX: 0, offY: 0, drawW: 0, drawH: 0, srcW: 0, srcH: 0 };

function loadCalibWide(){
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || typeof obj.x !== "number" || typeof obj.y !== "number" ||
        typeof obj.w !== "number" || typeof obj.h !== "number") return null;
    return obj;
  } catch (_) { return null; }
}

function saveCalibWide(obj){
  try { localStorage.setItem(LS_KEY, JSON.stringify(obj)); } catch (_) {}
}

function updateCalibLabel(){
  if (!calibWideEl) return;
  calibWideEl.textContent = calibratedWide
    ? `x=${calibratedWide.x},y=${calibratedWide.y},w=${calibratedWide.w},h=${calibratedWide.h}`
    : "none";
  if (calibModeEl) calibModeEl.textContent = calibrateArmed ? "ARMED (click preview)" : "off";
}

function clampRegion(img, r){
  let x = Math.max(0, Math.min(img.width - 1, r.x));
  let y = Math.max(0, Math.min(img.height - 1, r.y));
  let w = Math.max(1, Math.min(r.w, img.width - x));
  let h = Math.max(1, Math.min(r.h, img.height - y));
  return { x, y, w, h };
}

function getWideRegion(img){
  if (calibratedWide) {
    const r = clampRegion(img, calibratedWide);
    return { ...r, mode: "WIDE(CALIB)" };
  }
  // fallback full screen
  return { x: 0, y: 0, w: img.width, h: img.height, mode: "WIDE(FULL)" };
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
    data: img.data, // not used for matching, but keep consistent
    getPixel(x, y){
      return img.getPixel(x0 + x, y0 + y);
    }
  };
}

// Match but always show bestScore
function runMatch(img, region, acceptScore){
  const hay = cropView(img, region.x, region.y, region.w, region.h);
  const res = findAnchor(hay, anchor, {
    tolerance: MATCH.tolerance,
    minScore: 0.01,            // always compute best
    step: MATCH.step,
    ignoreAlphaBelow: MATCH.ignoreAlphaBelow
  });

  const bestScore = res && typeof res.score === "number" ? res.score : 0;

  if (res && res.ok && bestScore >= acceptScore) {
    return { ok: true, x: res.x + hay._offsetX, y: res.y + hay._offsetY, score: bestScore };
  }
  return { ok: false, score: bestScore };
}

// ---- preview drawing ----
function drawPreview(img, scanRegion, found){
  const now = Date.now();
  if (now - lastPreviewDraw < PREVIEW_MS) return;
  lastPreviewDraw = now;

  // Build ImageData from img.data (already RGBA)
  const srcW = img.width, srcH = img.height;
  const imageData = new ImageData(new Uint8ClampedArray(img.data), srcW, srcH);

  // Fit to canvas with aspect ratio
  const cw = canvas.width, ch = canvas.height;
  const scale = Math.min(cw / srcW, ch / srcH);
  const drawW = Math.floor(srcW * scale);
  const drawH = Math.floor(srcH * scale);
  const offX = Math.floor((cw - drawW) / 2);
  const offY = Math.floor((ch - drawH) / 2);

  previewMap = { scale, offX, offY, drawW, drawH, srcW, srcH };

  // Clear + draw
  ctx.clearRect(0, 0, cw, ch);

  // Draw scaled image (drawImage needs a bitmap; use temp canvas)
  const tmp = document.createElement("canvas");
  tmp.width = srcW; tmp.height = srcH;
  const tctx = tmp.getContext("2d", { willReadFrequently: true });
  tctx.putImageData(imageData, 0, 0);
  ctx.drawImage(tmp, 0, 0, srcW, srcH, offX, offY, drawW, drawH);

  // Draw scan region box
  if (scanRegion) {
    const rx = offX + Math.floor(scanRegion.x * scale);
    const ry = offY + Math.floor(scanRegion.y * scale);
    const rw = Math.floor(scanRegion.w * scale);
    const rh = Math.floor(scanRegion.h * scale);

    ctx.lineWidth = 2;
    ctx.strokeStyle = (scanRegion.mode === "TRACK") ? "orange" : "lime";
    ctx.strokeRect(rx, ry, rw, rh);

    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(rx, ry - 16, 130, 16);
    ctx.fillStyle = "white";
    ctx.font = "12px Arial";
    ctx.fillText(scanRegion.mode, rx + 4, ry - 4);
  }

  // Draw FOUND box (exact match area)
  if (found && anchor) {
    const fx = offX + Math.floor(found.x * scale);
    const fy = offY + Math.floor(found.y * scale);
    const fw = Math.floor(anchor.width * scale);
    const fh = Math.floor(anchor.height * scale);

    ctx.lineWidth = 2;
    ctx.strokeStyle = "deepskyblue";
    ctx.strokeRect(fx, fy, fw, fh);
  }

  // Calibration hint
  if (calibrateArmed) {
    ctx.fillStyle = "rgba(0,0,0,0.65)";
    ctx.fillRect(6, 6, cw - 12, 22);
    ctx.fillStyle = "white";
    ctx.font = "12px Arial";
    ctx.fillText("CALIBRATE: click on the preview where the progress bar is", 12, 22);
  }
}

// Canvas click = calibration target when armed
canvas.addEventListener("click", (ev) => {
  if (!calibrateArmed) return;

  const rect = canvas.getBoundingClientRect();
  const mx = ev.clientX - rect.left;
  const my = ev.clientY - rect.top;

  const { scale, offX, offY, drawW, drawH, srcW, srcH } = previewMap;
  if (!scale || drawW <= 0 || drawH <= 0) return;

  // Ignore clicks outside the drawn image area
  if (mx < offX || my < offY || mx > offX + drawW || my > offY + drawH) return;

  const cx = Math.floor((mx - offX) / scale);
  const cy = Math.floor((my - offY) / scale);

  // Set wide box centered on click
  const x = Math.max(0, Math.floor(cx - CALIB.boxW / 2));
  const y = Math.max(0, Math.floor(cy - CALIB.boxH / 2));

  calibratedWide = { x, y, w: CALIB.boxW, h: CALIB.boxH };
  saveCalibWide(calibratedWide);

  calibrateArmed = false;
  updateCalibLabel();

  setStatus("Calibrated");
  dbg(JSON.stringify({
    app: { version: APP_VERSION, build: BUILD_ID },
    note: "Calibration set from preview click",
    clickCaptureCoords: { x: cx, y: cy },
    calibratedWide
  }, null, 2));
});

async function loadAnchorSmart(){
  // Try both locations (people host differently)
  const try1 = await loadImage("img/progbar_anchor.png?v=" + encodeURIComponent(BUILD_ID));
  if (try1) return try1;
  const try2 = await loadImage("progbar_anchor.png?v=" + encodeURIComponent(BUILD_ID));
  if (try2) return try2;
  return null;
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
    dbg(JSON.stringify({
      captureRs: typeof window.captureRs,
      findAnchor: typeof window.findAnchor,
      loadImage: typeof window.loadImage
    }, null, 2));
    return;
  }

  if (!anchor){
    setStatus("Loading anchor…");
    anchor = await loadAnchorSmart();
  }
  if (!anchor){
    setStatus("Anchor load failed");
    dbg("Could not load progbar_anchor.png (tried img/progbar_anchor.png and progbar_anchor.png).");
    return;
  }

  running = true;
  locked = false;
  lastLock = { x: 0, y: 0, score: 0 };
  lastBestScore = 0;

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
    dbg(JSON.stringify({
      app: { version: APP_VERSION, build: BUILD_ID },
      alt1: !!window.alt1,
      permissionPixel: window.alt1 ? !!alt1.permissionPixel : false,
      permissionOverlay: window.alt1 ? !!alt1.permissionOverlay : false,
      rsLinked: window.alt1 ? !!alt1.rsLinked : undefined
    }, null, 2));
    return;
  }

  let region, result;

  if (locked) {
    region = getTrackRegion(img);
    result = runMatch(img, region, MATCH.minScoreTrack);

    if (!result.ok) {
      // reacquire in WIDE
      const wide = getWideRegion(img);
      const reacq = runMatch(img, wide, MATCH.minScoreWide);
      region = wide;
      result = reacq;
      if (!result.ok) locked = false;
    }
  } else {
    region = getWideRegion(img);
    result = runMatch(img, region, MATCH.minScoreWide);
  }

  lastBestScore = result.score ?? 0;

  if (result.ok){
    locked = true;
    lastLock = { x: result.x, y: result.y, score: result.score };
    setStatus("Locked");
    setLock(`x=${result.x}, y=${result.y}`);
    setProgress("locked");

    drawPreview(img, region, { x: result.x, y: result.y });

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

    drawPreview(img, region, null);

    dbg(JSON.stringify({
      app: { version: APP_VERSION, build: BUILD_ID },
      scanMode: region.mode,
      capture: { w: img.width, h: img.height },
      calibratedWide,
      scanRegion: { x: region.x, y: region.y, w: region.w, h: region.h },
      anchor: anchor ? { w: anchor.width, h: anchor.height } : null,
      res: { ok: false, bestScore: lastBestScore }
    }, null, 2));
  }
}

// Buttons
testBtn.onclick = () => alert("flash test");
startBtn.onclick = () => start().catch(console.error);
stopBtn.onclick = () => stop();

calibBtn.onclick = () => {
  calibrateArmed = !calibrateArmed;
  updateCalibLabel();
  setStatus(calibrateArmed ? "Calibrate: click preview" : "Idle");
};

// Init UI
updateCalibLabel();
setStatus("Idle");
setMode("Not running");
setLock("none");
setProgress("—");
dbg(JSON.stringify({ app: { version: APP_VERSION, build: BUILD_ID }, calibratedWide }, null, 2));
