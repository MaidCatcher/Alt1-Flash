// app.js — NO imports, Alt1-compatible

const statusEl = document.getElementById("status");
const modeEl   = document.getElementById("mode");
const lockEl   = document.getElementById("lock");
const dbgEl    = document.getElementById("debugBox");

const startBtn = document.getElementById("startBtn");
const stopBtn  = document.getElementById("stopBtn");
const testBtn  = document.getElementById("testFlashBtn");

function setStatus(v){ statusEl.textContent = v; }
function setMode(v){ modeEl.textContent = v; }
function setLock(v){ lockEl.textContent = v; }
function dbg(v){ dbgEl.textContent = String(v); }

const APP_V = Date.now();
let running = false;
let loop = null;
let anchor = null;

let flashing = false;
async function flashOverlay() {
  if (!window.alt1 || !alt1.permissionOverlay || flashing) return;
  flashing = true;
  try {
    alt1.overLaySetGroup("progflash");
    alt1.overLayText("PROGFLASH", -16776961, 22, 30, 53, 900);
    await new Promise(r => setTimeout(r, 250));
    alt1.overLayClearGroup("progflash");
  } finally {
    flashing = false;
  }
}

async function start() {
  if (!window.alt1) { setStatus("Not running in Alt1"); return; }

  if (!window.progflashCaptureRs || !window.progflashFindAnchor || !window.progflashLoadImage) {
    setStatus("matcher.js not loaded");
    dbg("Missing progflash* globals");
    return;
  }

  if (!anchor) {
    setStatus("Loading anchor…");
    anchor = await window.progflashLoadImage("./img/progbar_anchor.png?v=" + APP_V);
  }

  running = true;
  startBtn.disabled = true;
  stopBtn.disabled = false;

  setMode("Running");
  setStatus("Searching…");
  setLock("none");

  if (loop) clearInterval(loop);

  tick();
  loop = setInterval(tick, 200);
}

function tick() {
  if (!running) return;

  const img = window.progflashCaptureRs();
  const info = window.progflashCaptureInfo ? window.progflashCaptureInfo() : null;

  if (!img) {
    dbg(
      `ProgFlash v=${APP_V}
` +
      `anchor=${anchor.width}x${anchor.height}
` +
      `rsX=${alt1.rsX} rsY=${alt1.rsY}
` +
      `rsW=${alt1.rsWidth} rsH=${alt1.rsHeight}
` +
      `native captureRs: ${typeof window.captureRs}
` +
      `native captureEvents: ${typeof window.captureEvents}
` +
      `captureMode: ${info ? info.mode : "n/a"}
` +
      `lastErr: ${info ? info.lastErr : ""}
` +
      `captureRs(): null (capture failed)`
    );
    return;
  }

  const res = window.progflashFindAnchor(img, anchor, {
    tolerance: 65,
    stride: 1,
    minScore: 0.50,
    returnBest: true
  });

  const scoreTxt = (res && typeof res.score === "number") ? res.score.toFixed(3) : "n/a";
  dbg(
    `ProgFlash v=${APP_V}
` +
    `img=${img.width}x${img.height}
` +
    `anchor=${anchor.width}x${anchor.height}
` +
    `captureMode: ${info ? info.mode : "n/a"}
` +
    `best score=${scoreTxt}
` +
    `ok=${!!(res && res.ok)}`
  );

  if (res && res.ok) {
    setStatus("Locked");
    setLock(`x=${res.x}, y=${res.y}`);
    flashOverlay();
  } else {
    setStatus("Searching…");
    setLock("none");
  }
}

function stop() {
  running = false;
  if (loop) clearInterval(loop);
  loop = null;

  startBtn.disabled = false;
  stopBtn.disabled = true;

  setMode("Not running");
  setStatus("Idle");
  setLock("none");
}

testBtn.onclick = () => flashOverlay();
startBtn.onclick = () => start().catch(console.error);
stopBtn.onclick  = () => stop();

setStatus("Idle");
setMode("Not running");
setLock("none");
dbg(`ProgFlash v=${APP_V}`);
