// ================================
// ProgFlash – app.js (PATCHED)
// ================================

// -------- DOM --------
const statusEl = document.getElementById("status");
const modeEl   = document.getElementById("mode");
const lockEl   = document.getElementById("lock");
const progEl   = document.getElementById("progress");
const dbgEl    = document.getElementById("debugBox");

const startBtn = document.getElementById("startBtn");
const stopBtn  = document.getElementById("stopBtn");
const testBtn  = document.getElementById("testFlashBtn");

const flashAtInput   = document.getElementById("flashAt");
const flashStyleSel  = document.getElementById("flashStyle");

// -------- Helpers --------
function setStatus(v){ statusEl.textContent = v; }
function setMode(v){ modeEl.textContent = v; }
function setLock(v){ lockEl.textContent = v; }
function setProgress(v){
  if (progEl) progEl.textContent = v;
}

function dbg(v){ dbgEl.textContent = String(v); }

function rgba(r,g,b,a=255){
  return (r&255)|((g&255)<<8)|((b&255)<<16)|((a&255)<<24);
}

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

// -------- App state --------
const APP_V = Date.now();

let running = false;
let loopId = null;
let anchorImg = null;

let lastProgress = 0;
let smoothedProgress = 0;
let flashedThisCycle = false;

// smoothing factor (0–1). Higher = smoother
const SMOOTH_ALPHA = 0.25;

// crafting bar geometry (relative to anchor)
const BAR_OFFSET_X = 2;
const BAR_OFFSET_Y = 1;
const BAR_WIDTH    = 170;
const BAR_HEIGHT   = 6;

// -------- Overlay Flash --------
let flashing = false;
let lastFlashAt = 0;
const FLASH_COOLDOWN_MS = 1500;

async function flashOverlay(style = "text") {
  if (!window.alt1 || !alt1.permissionOverlay) return;

  const now = Date.now();
  if (now - lastFlashAt < FLASH_COOLDOWN_MS) return;
  lastFlashAt = now;

  if (flashing) return;
  flashing = true;

  const g = "progflash_flash";

  try {
    if (style === "fullscreen") {
      alt1.overLaySetGroup(g);
      alt1.overLayRect(
        rgba(255, 255, 255, 140),
        alt1.rsX || 0,
        alt1.rsY || 0,
        alt1.rsWidth,
        alt1.rsHeight,
        500
      );
      await sleep(400);
      alt1.overLayClearGroup(g);
    } else {
      for (let i = 0; i < 3; i++) {
        alt1.overLaySetGroup(g);
        alt1.overLayText("PROGFLASH", -16776961, 22, 30, 53, 700);
        await sleep(250);
        alt1.overLayClearGroup(g);
        await sleep(200);
      }
    }
  } finally {
    flashing = false;
  }
}

function clearDebugOverlay() {
  if (!window.alt1 || !alt1.permissionOverlay) return;
  alt1.overLaySetGroup("progflash_debug");
  alt1.overLayClearGroup("progflash_debug");
}

// -------- Progress Scan --------
function measureProgress(img, ax, ay) {
  const startX = ax + anchorImg.width + BAR_OFFSET_X;
  const y = ay + BAR_OFFSET_Y;

  let greenCount = 0;

  for (let x = 0; x < BAR_WIDTH; x++) {
    const p = img.getPixel(startX + x, y);
    const r = p & 255;
    const g = (p >> 8) & 255;
    const b = (p >> 16) & 255;

    // green detection (tuned for RS bar)
    if (g > 120 && g > r * 1.3 && g > b * 1.3) {
      greenCount++;
    }
  }

  return Math.min(100, Math.max(0, Math.round((greenCount / BAR_WIDTH) * 100)));
}

// -------- Main --------
async function start() {
  if (!window.alt1) {
    alert("Open this inside Alt1.");
    return;
  }

  if (!alt1.permissionPixel || !alt1.permissionOverlay) {
    setStatus("Missing permissions");
    return;
  }

  if (!window.findAnchor || !window.loadImage || !window.captureRs) {
    setStatus("matcher.js not loaded");
    return;
  }

  if (!anchorImg) {
    anchorImg = await window.loadImage("./img/progbar_anchor.png?v=" + APP_V);
  }

  running = true;
  flashedThisCycle = false;
  lastProgress = 0;
  smoothedProgress = 0;

  startBtn.disabled = true;
  stopBtn.disabled = false;

  setMode("Running");
  setStatus("Searching…");
  setLock("none");
  setProgress("—");

  clearDebugOverlay();

  loopId = setInterval(() => {
    if (!running) return;

    const img = window.captureRs();
    if (!img) return;

    const res = window.findAnchor(img, anchorImg, {
      tolerance: 60,
      stride: 1,
      minScore: 0.45,
      returnBest: true
    });

    if (!res || !res.ok) {
      setStatus("Searching…");
      setLock("none");
      setProgress("—");
      return;
    }

    const ax = res.x;
    const ay = res.y;

    setStatus("Locked");
    setLock(`x=${ax}, y=${ay}`);

    // debug anchor box
    if (alt1.permissionOverlay) {
      alt1.overLaySetGroup("progflash_debug");
      alt1.overLayRect(
        rgba(0, 150, 255, 180),
        (alt1.rsX || 0) + ax,
        (alt1.rsY || 0) + ay,
        anchorImg.width,
        anchorImg.height,
        200,
        2
      );
    }

    const rawProgress = measureProgress(img, ax, ay);

    // clamp backward jitter
    const clamped = Math.max(lastProgress, rawProgress);
    lastProgress = clamped;

    // smoothing
    smoothedProgress =
      smoothedProgress +
      (clamped - smoothedProgress) * SMOOTH_ALPHA;

    const shown = Math.round(smoothedProgress);
    setProgress(`${shown}%`);

    const flashAt = Math.min(100, Math.max(1, Number(flashAtInput.value) || 95));
    const style = flashStyleSel.value;

    if (!flashedThisCycle && shown >= flashAt) {
      flashedThisCycle = true;
      flashOverlay(style).catch(console.error);
    }

    if (shown <= 2) {
      flashedThisCycle = false;
    }

    dbg(
      `ProgFlash v=${APP_V}\n` +
      `img=${img.width}x${img.height}\n` +
      `anchor=${anchorImg.width}x${anchorImg.height}\n` +
      `raw=${rawProgress}%\n` +
      `smooth=${shown}%\n` +
      `flashAt=${flashAt}%\n` +
      `style=${style}`
    );
  }, 200);
}

function stop() {
  running = false;
  if (loopId) clearInterval(loopId);
  loopId = null;

  startBtn.disabled = false;
  stopBtn.disabled = true;

  setMode("Not running");
  setStatus("Idle");
  setLock("none");
  setProgress("—");

  clearDebugOverlay();
}

// -------- Buttons --------
startBtn.onclick = () => start().catch(console.error);
stopBtn.onclick = () => stop();
testBtn.onclick = () => flashOverlay(flashStyleSel.value);

// -------- Init --------
setStatus("Idle");
setMode("Not running");
setLock("none");
setProgress("—");

dbg(`ProgFlash v=${APP_V}`);
