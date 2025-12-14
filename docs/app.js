// app.js — ProgFlash (FINAL PATCH, Alt1-safe)

// ---------- DOM ----------
const statusEl = document.getElementById("status");
const modeEl   = document.getElementById("mode");
const lockEl   = document.getElementById("lock");
const progEl   = document.getElementById("progress");
const dbgEl    = document.getElementById("debugBox");

const startBtn = document.getElementById("startBtn");
const stopBtn  = document.getElementById("stopBtn");
const testBtn  = document.getElementById("testFlashBtn");

const flashAtInput  = document.getElementById("flashAt");
const flashStyleSel = document.getElementById("flashStyle");

// ---------- helpers ----------
function setStatus(v){ if (statusEl) statusEl.textContent = v; }
function setMode(v){ if (modeEl) modeEl.textContent = v; }
function setLock(v){ if (lockEl) lockEl.textContent = v; }
function setProgress(v){ if (progEl) progEl.textContent = v; }
function dbg(v){ if (dbgEl) dbgEl.textContent = String(v); }

function rgba(r,g,b,a=255){
  return (r&255)|((g&255)<<8)|((b&255)<<16)|((a&255)<<24);
}
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

const APP_V = Date.now();

// ---------- state ----------
let running = false;
let loop = null;
let anchorImg = null;

let lastProgress = 0;
let smoothProgress = 0;
let flashedThisCraft = false;

// smoothing factor
const SMOOTH_ALPHA = 0.25;

// bar geometry relative to anchor
const BAR_OFFSET_X = 2;
const BAR_OFFSET_Y = 1;
const BAR_WIDTH    = 170;
const BAR_HEIGHT   = 6;

// ---------- flash ----------
let flashing = false;
let lastFlashAt = 0;
const FLASH_COOLDOWN = 1200;

async function flashOverlay(style){
  if (!window.alt1 || !alt1.permissionOverlay) return;
  if (flashing) return;

  const now = Date.now();
  if (now - lastFlashAt < FLASH_COOLDOWN) return;
  lastFlashAt = now;

  flashing = true;
  const g = "progflash_flash";

  try {
    if (style === "fullscreen") {
      alt1.overLaySetGroup(g);
      alt1.overLayRect(
        rgba(255,255,255,160),
        alt1.rsX||0, alt1.rsY||0,
        alt1.rsWidth, alt1.rsHeight,
        300
      );
      await sleep(300);
      alt1.overLayClearGroup(g);
    } else {
      for (let i=0;i<2;i++){
        alt1.overLaySetGroup(g);
        alt1.overLayText("PROGFLASH", -1, 24, 40, 40, 600);
        await sleep(200);
        alt1.overLayClearGroup(g);
        await sleep(180);
      }
    }
  } finally {
    flashing = false;
  }
}

// ---------- progress scan ----------
function isGreen(r,g,b){
  return g > 120 && g > r * 1.3 && g > b * 1.3;
}

function measureProgress(img, ax, ay){
  const startX = ax + anchorImg.width + BAR_OFFSET_X;
  const y = ay + BAR_OFFSET_Y;

  let green = 0;
  for (let x=0; x<BAR_WIDTH; x++){
    const p = img.getPixel(startX + x, y);
    const r = p & 255;
    const g = (p >> 8) & 255;
    const b = (p >> 16) & 255;
    if (isGreen(r,g,b)) green++;
  }
  return Math.round((green / BAR_WIDTH) * 100);
}

// ---------- main ----------
async function start(){
  if (!window.alt1 || !alt1.permissionPixel){
    alert("Open inside Alt1 with View Screen enabled.");
    return;
  }

  // CORRECT matcher check
  if (
    typeof window.progflashLoadImage !== "function" ||
    typeof window.progflashCaptureRs !== "function" ||
    typeof window.progflashFindAnchor !== "function"
  ) {
    setStatus("matcher.js not loaded");
    dbg("Missing progflash* globals");
    return;
  }

  if (!anchorImg){
    anchorImg = await progflashLoadImage("./img/progbar_anchor.png?v="+APP_V);
  }

  running = true;
  flashedThisCraft = false;
  lastProgress = 0;
  smoothProgress = 0;

  startBtn.disabled = true;
  stopBtn.disabled = false;

  setMode("Running");
  setStatus("Searching…");
  setLock("none");
  setProgress("—");

  loop = setInterval(()=>{
    if (!running) return;

    const img = progflashCaptureRs();
    if (!img) return;

    const res = progflashFindAnchor(img, anchorImg, {
      tolerance: 60,
      minScore: 0.45,
      returnBest: true
    });

    if (!res || !res.ok){
      setStatus("Searching…");
      setLock("none");
      flashedThisCraft = false;
      return;
    }

    setStatus("Locked");
    setLock(`x=${res.x}, y=${res.y}`);

    const raw = measureProgress(img, res.x, res.y);

    // clamp + smooth
    const clamped = Math.max(raw, lastProgress);
    lastProgress = clamped;
    smoothProgress += (clamped - smoothProgress) * SMOOTH_ALPHA;

    const shown = Math.round(smoothProgress);
    setProgress(shown + "%");

    const flashAt = Math.min(100, Math.max(1, Number(flashAtInput.value)||95));
    if (!flashedThisCraft && shown >= flashAt){
      flashedThisCraft = true;
      flashOverlay(flashStyleSel.value);
    }

    if (shown <= 2) flashedThisCraft = false;

    dbg(
      `ProgFlash v=${APP_V}\n` +
      `progress=${shown}%\n` +
      `flashAt=${flashAt}%`
    );
  }, 200);
}

function stop(){
  running = false;
  if (loop) clearInterval(loop);
  loop = null;

  startBtn.disabled = false;
  stopBtn.disabled = true;

  setMode("Not running");
  setStatus("Idle");
  setLock("none");
  setProgress("—");
}

// ---------- buttons ----------
startBtn.onclick = () => start();
stopBtn.onclick  = () => stop();
testBtn.onclick  = () => flashOverlay(flashStyleSel.value);

// ---------- init ----------
setStatus("Idle");
setMode("Not running");
setLock("none");
setProgress("—");
dbg(`ProgFlash v=${APP_V}`);
