// app.js — Preview-based calibration (drag rectangle) + on-canvas scan debug box + bestScore debug

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

// Drag-to-calibrate state (in CANVAS coords)
let drag = {
  active: false,
  sx: 0, sy: 0,
  ex: 0, ey: 0
};

// ---- config ----
const MATCH = {
  tolerance: 80,
  minScoreWide: 0.62,
  minScoreTrack: 0.72,
  step: 2,
  ignoreAlphaBelow: 200
};

const TRACK = { padX: 220, padY: 140, minW: 420, minH: 220 };

// Preview update rate
let lastPreviewDraw = 0;
const PREVIEW_MS = 250;

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
  if (calibModeEl) calibModeEl.textContent = calibrateArmed ? "ARMED (drag on preview)" : "off";
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
    getPixel(x, y){ return img.getPixel(x0 + x, y0 + y); }
  };
}

// Match but always return bestScore
function runMatch(img, region, acceptScore){
  const hay = cropView(img, region.x, region.y, region.w, region.h);
  const res = findAnchor(hay, anchor, {
    tolerance: MATCH.tolerance,
    minScore: 0.01,
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

  const srcW = img.width, srcH = img.height;
  const imageData = new ImageData(new Uint8ClampedArray(img.data), srcW, srcH);

  const cw = canvas.width, ch = canvas.height;
  const scale = Math.min(cw / srcW, ch / srcH);
  const drawW = Math.floor(srcW * scale);
  const drawH = Math.floor(srcH * scale);
  const offX = Math.floor((cw - drawW) / 2);
  const offY = Math.floor((ch - drawH) / 2);

  previewMap = { scale, offX, offY, drawW, drawH, srcW, srcH };

  ctx.clearRect(0, 0, cw, ch);

  const tmp = document.createElement("canvas");
  tmp.width = srcW; tmp.height = srcH;
  const tctx = tmp.getContext("2d", { willReadFrequently: true });
  tctx.putImageData(imageData, 0, 0);
  ctx.drawImage(tmp, 0, 0, srcW, srcH, offX, offY, drawW, drawH);

  // Scan region box
  if (scanRegion) {
    const rx = offX + Math.floor(scanRegion.x * scale);
    const ry = offY + Math.floor(scanRegion.y * scale);
    const rw = Math.floor(scanRegion.w * scale);
    const rh = Math.floor(scanRegion.h * scale);

    ctx.lineWidth = 2;
    ctx.strokeStyle = (scanRegion.mode === "TRACK") ? "orange" : "lime";
    ctx.strokeRect(rx, ry, rw, rh);

    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(rx, Math.max(0, ry - 16), 150, 16);
    ctx.fillStyle = "white";
    ctx.font = "12px Arial";
    ctx.fillText(scanRegion.mode, rx + 4, Math.max(12, ry - 4));
  }

  // Found box
  if (found && anchor) {
    const fx = offX + Math.floor(found.x * scale);
    const fy = offY + Math.floor(found.y * scale);
    const fw = Math.floor(anchor.width * scale);
    const fh = Math.floor(anchor.height * scale);

    ctx.lineWidth = 2;
    ctx.strokeStyle = "deepskyblue";
    ctx.strokeRect(fx, fy, fw, fh);
  }

  // Calibration drag overlay
  if (calibrateArmed) {
    ctx.fillStyle = "rgba(0,0,0,0.65)";
    ctx.fillRect(6, 6, cw - 12, 22);
    ctx.fillStyle = "white";
    ctx.font = "12px Arial";
    ctx.fillText("CALIBRATE: drag a box around the progress bar in this preview", 12, 22);

    if (drag.active) {
      const x = Math.min(drag.sx, drag.ex);
      const y = Math.min(drag.sy, drag.ey);
      const w = Math.abs(drag.ex - drag.sx);
      const h = Math.abs(drag.ey - drag.sy);
      ctx.lineWidth = 2;
      ctx.strokeStyle = "yellow";
      ctx.strokeRect(x, y, w, h);
    }
  }
}

function canvasToCapture(mx, my){
  const { scale, offX, offY, drawW, drawH, srcW, srcH } = previewMap;
  if (!scale || drawW <= 0 || drawH <= 0) return null;

  if (mx < offX || my < offY || mx > offX + drawW || my > offY + drawH) return null;

  const cx = Math.floor((mx - offX) / scale);
  const cy = Math.floor((my - offY) / scale);

  // Clamp to capture bounds
  return {
    x: Math.max(0, Math.min(srcW - 1, cx)),
    y: Math.max(0, Math.min(srcH - 1, cy))
  };
}

// Drag calibration handlers
canvas.addEventListener("mousedown", (ev) => {
  if (!calibrateArmed) return;
  const rect = canvas.getBoundingClientRect();
  const mx = ev.clientX - rect.left;
  const my = ev.clientY - rect.top;
  drag.active = true;
  drag.sx = mx; drag.sy = my;
  drag.ex = mx; drag.ey = my;
});

canvas.addEventListener("mousemove", (ev) => {
  if (!calibrateArmed || !drag.active) return;
  const rect = canvas.getBoundingClientRect();
  drag.ex = ev.clientX - rect.left;
  drag.ey = ev.clientY - rect.top;
});

canvas.addEventListener("mouseup", (ev) => {
  if (!calibrateArmed || !drag.active) return;
  drag.active = false;

  const rect = canvas.getBoundingClientRect();
  const mx2 = ev.clientX - rect.left;
  const my2 = ev.clientY - rect.top;

  const x1 = Math.min(drag.sx, mx2);
  const y1 = Math.min(drag.sy, my2);
  const x2 = Math.max(drag.sx, mx2);
  const y2 = Math.max(drag.sy, my2);

  const p1 = canvasToCapture(x1, y1);
  const p2 = canvasToCapture(x2, y2);

  if (!p1 || !p2) {
    setStatus("Calibrate failed");
    dbg("Drag inside the preview image area.");
    return;
  }

  // Create calibrated region from drag box
  let rx = Math.min(p1.x, p2.x);
  let ry = Math.min(p1.y, p2.y);
  let rw = Math.max(1, Math.abs(p2.x - p1.x));
  let rh = Math.max(1, Math.abs(p2.y - p1.y));

  // Add a little padding so it doesn't miss if bar moves slightly
  const pad = 40;
  rx = Math.max(0, rx - pad);
  ry = Math.max(0, ry - pad);
  rw = rw + pad * 2;
  rh = rh + pad * 2;

  calibratedWide = { x: rx, y: ry, w: rw, h: rh };
  saveCalibWide(calibratedWide);

  calibrateArmed = false;
  updateCalibLabel();

  setStatus("Calibrated");
  dbg(JSON.stringify({
    app: { version: APP_VERSION, build: BUILD_ID },
    note: "Calibration set from drag box on preview",
    calibratedWide
  }, null, 2));
});

async function loadAnchorSmart(){
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
    dbg("captureRs(): null\n\n" + JSON.stringify(window.progflashCaptureDiag || {}, null, 2));
    return;
  }

  let region, result;

  if (locked) {
    region = getTrackRegion(img);
    result = runMatch(img, region, MATCH.minScoreTrack);

    if (!result.ok) {
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
  drag.active = false;
  updateCalibLabel();
  setStatus(calibrateArmed ? "Calibrate: drag on preview" : "Idle");
};

// Init UI
updateCalibLabel();
setStatus("Idle");
setMode("Not running");
setLock("none");
setProgress("—");
dbg(JSON.stringify({ app: { version: APP_VERSION, build: BUILD_ID }, calibratedWide }, null, 2));
