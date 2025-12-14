// app.js — Alt1 compatible, NO modules, NO imports

/* =========================
   DOM
========================= */
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

/* =========================
   UI helpers
========================= */
function setStatus(v){ statusEl.textContent = v; }
function setMode(v){ modeEl.textContent = v; }
function setLock(v){ lockEl.textContent = v; }
function setProgress(v){ progressEl.textContent = v === null ? "—" : `${v}%`; }
function dbg(v){ dbgEl.textContent = String(v); }

/* =========================
   Utils
========================= */
function rgba(r,g,b,a=255){
  return (r&255)|((g&255)<<8)|((b&255)<<16)|((a&255)<<24);
}
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

/* =========================
   State
========================= */
let running = false;
let loopId  = null;
let anchor  = null;

let lastProgress = 0;
let flashed = false;

const APP_V = Date.now();

/* =========================
   Flash
========================= */
async function doFlash(){
  if (!window.alt1 || !alt1.permissionOverlay) return;

  const style = flashStyleSel.value;

  if (style === "fullscreen") {
    const g = "progflash_full";
    alt1.overLaySetGroup(g);
    alt1.overLayRect(
      rgba(255,255,255,180),
      0, 0,
      alt1.rsWidth,
      alt1.rsHeight,
      300,
      0
    );
    await sleep(200);
    alt1.overLayClearGroup(g);
  } else {
    const g = "progflash_text";
    alt1.overLaySetGroup(g);
    alt1.overLayText("PROGFLASH", -65536, 30, 40, 60, 600);
    await sleep(400);
    alt1.overLayClearGroup(g);
  }
}

/* =========================
   Progress calculation
========================= */
// Geometry relative to LEFT EDGE anchor
const BAR_OFFSET_X = 4;   // inside bar
const BAR_OFFSET_Y = 8;   // vertical center-ish
const BAR_WIDTH    = 170; // inner fill width

function computeProgress(img, ax, ay){
  let green = 0;
  let total = 0;

  const y = ay + BAR_OFFSET_Y;

  for (let x = ax + BAR_OFFSET_X; x < ax + BAR_OFFSET_X + BAR_WIDTH; x++) {
    const p = img.getPixel(x, y);
    const r =  p        & 255;
    const g = (p >> 8)  & 255;
    const b = (p >> 16) & 255;

    // RuneScape progress green
    if (g > 140 && g > r + 20 && g > b + 20) {
      green++;
    }
    total++;
  }

  if (total === 0) return 0;

  let pct = Math.round((green / total) * 100);

  // smoothing + clamp
  pct = Math.max(pct, lastProgress - 2);
  pct = Math.min(pct, lastProgress + 4);
  pct = Math.max(0, Math.min(100, pct));

  lastProgress = pct;
  return pct;
}

/* =========================
   Start / Stop
========================= */
async function start(){
  if (!window.alt1) {
    alert("Open inside Alt1");
    return;
  }

  if (!alt1.permissionPixel || !alt1.permissionOverlay) {
    setStatus("Missing Alt1 permissions");
    return;
  }

  if (typeof window.findAnchor !== "function" ||
      typeof window.captureRs !== "function" ||
      typeof window.loadImage !== "function") {
    setStatus("matcher.js not loaded");
    return;
  }

  if (!anchor) {
    anchor = await loadImage("./img/progbar_anchor.png?v=" + APP_V);
  }

  running = true;
  flashed = false;
  lastProgress = 0;

  startBtn.disabled = true;
  stopBtn.disabled  = false;

  setMode("Running");
  setStatus("Searching…");
  setLock("none");
  setProgress(null);

  if (loopId) clearInterval(loopId);

  loopId = setInterval(() => {
    if (!running) return;

    const img = captureRs();
    if (!img) return;

    const res = findAnchor(img, anchor, {
      tolerance: 65,
      stride: 1,
      minScore: 0.4,
      returnBest: true
    });

    if (!res || !res.ok) {
      setStatus("Searching…");
      setLock("none");
      setProgress(null);
      flashed = false;
      return;
    }

    const ax = res.x;
    const ay = res.y;

    setStatus("Locked");
    setLock(`x=${ax}, y=${ay}`);

    const prog = computeProgress(img, ax, ay);
    setProgress(prog);

    const flashAt = Number(flashAtInput.value || 95);

    if (prog >= flashAt && !flashed) {
      flashed = true;
      doFlash().catch(console.error);
    }

    dbg(
      `ProgFlash v=${APP_V}\n` +
      `img=${img.width}x${img.height}\n` +
      `progress=${prog}%\n` +
      `flashAt=${flashAt}%\n` +
      `style=${flashStyleSel.value}`
    );

  }, 120);
}

function stop(){
  running = false;
  if (loopId) clearInterval(loopId);
  loopId = null;

  startBtn.disabled = false;
  stopBtn.disabled  = true;

  setMode("Not running");
  setStatus("Idle");
  setLock("none");
  setProgress(null);
}

/* =========================
   Buttons
========================= */
startBtn.onclick = () => start().catch(console.error);
stopBtn.onclick  = () => stop();
testBtn.onclick  = () => doFlash();

/* =========================
   Init
========================= */
setStatus("Idle");
setMode("Not running");
setLock("none");
setProgress(null);

dbg(`ProgFlash v=${APP_V}`);
