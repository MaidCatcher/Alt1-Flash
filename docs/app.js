// app.js — Alt1 compatible (NO imports / NO modules)

const statusEl   = document.getElementById("status");
const modeEl     = document.getElementById("mode");
const lockEl     = document.getElementById("lock");
const progressEl = document.getElementById("progress");
const dbgEl      = document.getElementById("debugBox");

const startBtn = document.getElementById("startBtn");
const stopBtn  = document.getElementById("stopBtn");
const testBtn  = document.getElementById("testFlashBtn");

const flashAtInput   = document.getElementById("flashAt");
const flashStyleSel  = document.getElementById("flashStyle");

function setStatus(v){ statusEl.textContent = v; }
function setMode(v){ modeEl.textContent = v; }
function setLock(v){ lockEl.textContent = v; }
function setProgress(v){ progressEl.textContent = v; }
function dbg(v){ dbgEl.textContent = String(v); }

function rgba(r,g,b,a=255){
  return (r&255)|((g&255)<<8)|((b&255)<<16)|((a&255)<<24);
}

const APP_V = Date.now();

// --------------------------------------------------
// Overlay flash (text OR fullscreen)
// --------------------------------------------------

let flashing = false;
let lastFlash = 0;
const FLASH_COOLDOWN = 1200;

async function flashOverlay(style="text"){
  if (!alt1 || !alt1.permissionOverlay) return;

  const now = Date.now();
  if (now - lastFlash < FLASH_COOLDOWN) return;
  lastFlash = now;
  if (flashing) return;
  flashing = true;

  try {
    if (style === "fullscreen") {
      alt1.overLaySetGroup("progflash_full");
      alt1.overLayRect(
        rgba(255,255,255,180),
        alt1.rsX, alt1.rsY,
        alt1.rsWidth, alt1.rsHeight,
        250, 0
      );
      await new Promise(r => setTimeout(r, 250));
      alt1.overLayClearGroup("progflash_full");
    } else {
      alt1.overLaySetGroup("progflash_text");
      alt1.overLayText(
        "PROGFLASH",
        rgba(0,0,255,255),
        22,
        30, 60,
        900
      );
      await new Promise(r => setTimeout(r, 400));
      alt1.overLayClearGroup("progflash_text");
    }
  } finally {
    flashing = false;
  }
}

// --------------------------------------------------
// State
// --------------------------------------------------

let running = false;
let loop = null;
let anchorImg = null;

let lastProgress = 0;   // for smoothing
let flashed = false;

// --------------------------------------------------
// Progress detection
// --------------------------------------------------

function clamp(v,min,max){ return Math.max(min, Math.min(max,v)); }

// Scan green fill to the right of anchor
function computeProgress(img, anchorX, anchorY) {
  const BAR_Y = anchorY + Math.floor(anchorImg.height / 2);
  const START_X = anchorX + anchorImg.width + 2;
  const MAX_W = 160; // crafting bar width

  let filled = 0;
  for (let i = 0; i < MAX_W; i++) {
    const x = START_X + i;
    const idx = (BAR_Y * img.width + x) * 4;
    const r = img.data[idx];
    const g = img.data[idx+1];
    const b = img.data[idx+2];

    // green-ish fill
    if (g > 120 && g > r + 20 && g > b + 20) {
      filled++;
    } else {
      break;
    }
  }

  let pct = clamp(Math.round((filled / MAX_W) * 100), 0, 100);

  // smoothing (prevents jitter / stuck values)
  pct = Math.round(lastProgress * 0.7 + pct * 0.3);
  lastProgress = pct;

  return pct;
}

// --------------------------------------------------
// Start / Stop
// --------------------------------------------------

async function start(){
  if (!window.alt1) {

    setStatus("Alt1 or a1lib missing");
    return;
  }

  if (!window.progflashCaptureRs ||
      !window.progflashLoadImage ||
      !window.progflashFindAnchor) {
    setStatus("matcher.js not loaded");
    dbg("Missing progflash* globals");
    return;
  }

  if (!anchorImg) {
    anchorImg = await window.progflashLoadImage("./img/progbar_anchor.png?v=" + APP_V);
  }

  running = true;
  flashed = false;
  lastProgress = 0;

  startBtn.disabled = true;
  stopBtn.disabled = false;

  setMode("Running");
  setStatus("Searching…");
  setLock("none");
  setProgress("—");

  loop = setInterval(tick, 150);
}

function stop(){
  running = false;
  clearInterval(loop);
  loop = null;

  startBtn.disabled = false;
  stopBtn.disabled = true;

  setMode("Not running");
  setStatus("Idle");
  setLock("none");
  setProgress("—");
}

// --------------------------------------------------
// Main loop
// --------------------------------------------------

function tick(){
  if (!running) return;

  const img = window.progflashCaptureRs();
  if (!img) return;

  const res = window.progflashFindAnchor(img, anchorImg, {
    tolerance: 65,
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

  setStatus("Locked");
  setLock(`x=${res.x}, y=${res.y}`);

  const progress = computeProgress(img, res.x, res.y);
  setProgress(progress + "%");

  const flashAt = clamp(parseInt(flashAtInput.value || "95", 10), 1, 100);
  const flashStyle = flashStyleSel.value;

  if (!flashed && progress >= flashAt) {
    flashed = true;
    flashOverlay(flashStyle);
  }

  dbg(
    `ProgFlash v=${APP_V}\n` +
    `progress=${progress}%\n` +
    `flashAt=${flashAt}%\n` +
    `flashStyle=${flashStyle}`
  );
}

// --------------------------------------------------
// Buttons
// --------------------------------------------------

startBtn.onclick = () => start();
stopBtn.onclick = () => stop();
testBtn.onclick = () => flashOverlay(flashStyleSel.value);

// --------------------------------------------------
// Init
// --------------------------------------------------

setStatus("Idle");
setMode("Not running");
setLock("none");
setProgress("—");

dbg(`ProgFlash v=${APP_V}`);
