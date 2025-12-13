// app.js — Alt1-compatible: NO imports/modules

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

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

const APP_V = Date.now();

let running = false;
let loop = null;
let anchor = null;

// ---------- Overlay flash ----------
let flashing = false;
async function flashOverlay() {
  if (!window.alt1 || !alt1.permissionOverlay || flashing) return;
  flashing = true;
  try {
    alt1.overLaySetGroup("progflash_flash");
    alt1.overLayText("PROGFLASH", -16776961, 22, 30, 53, 900);
    await sleep(250);
    alt1.overLayClearGroup("progflash_flash");
  } finally {
    flashing = false;
  }
}

function captureDebugLine() {
  const nativeCap = (typeof window.captureRs === "function") ? "function" : typeof window.captureRs;
  const pfCap = (typeof window.progflashCaptureRs === "function") ? "function" : typeof window.progflashCaptureRs;

  const alt1Keys = window.alt1 ? Object.keys(alt1).filter(k => k.toLowerCase().includes("capture")).sort() : [];
  const alt1FnKeys = window.alt1 ? alt1Keys.filter(k => typeof alt1[k] === "function") : [];

  return (
    `native captureRs: ${nativeCap}\n` +
    `progflashCaptureRs: ${pfCap}\n` +
    `alt1.capture keys: ${alt1Keys.join(",") || "(none)"}\n` +
    `alt1.capture fns: ${alt1FnKeys.join(",") || "(none)"}`
  );
}

// ---------- Main loop ----------
async function start() {
  if (!window.alt1) {
    setStatus("Not running in Alt1");
    return;
  }

  if (!window.progflashLoadImage || !window.progflashCaptureRs || !window.progflashFindAnchor) {
    setStatus("matcher.js not loaded");
    dbg(`ProgFlash v=${APP_V}\nMissing progflash* globals\n` + captureDebugLine());
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

  // IMPORTANT: capture immediately
  tick();
  loop = setInterval(tick, 200);
}

function tick() {
  if (!running) return;

  const img = window.progflashCaptureRs();
  if (!img) {
    dbg(
      `ProgFlash v=${APP_V}\n` +
      `anchor=${anchor ? anchor.width + "x" + anchor.height : "n/a"}\n` +
      `rsX=${alt1.rsX} rsY=${alt1.rsY}\n` +
      `rsW=${alt1.rsWidth} rsH=${alt1.rsHeight}\n` +
      captureDebugLine() + `\n` +
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

  dbg(
    `ProgFlash v=${APP_V}\n` +
    `img=${img.width}x${img.height}\n` +
    `anchor=${anchor.width}x${anchor.height}\n` +
    `best score=${(res && typeof res.score === "number") ? res.score.toFixed(3) : "n/a"}\n` +
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

// ---------- Buttons ----------
startBtn.onclick = () => start().catch(console.error);
stopBtn.onclick  = () => stop();
testBtn.onclick  = () => flashOverlay().catch(console.error);

// ---------- Init ----------
setStatus("Idle");
setMode("Not running");
setLock("none");
dbg(`ProgFlash v=${APP_V}`);
