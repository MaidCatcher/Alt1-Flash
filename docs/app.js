// app.js — classic script (NO import). Uses globals from matcher.js.

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

// overlay flash
let flashing = false;
async function flashOverlay() {
  if (!window.alt1 || !alt1.permissionOverlay || flashing) return;
  flashing = true;
  try {
    alt1.overLaySetGroup("progflash");
    alt1.overLayText("PROGFLASH", -16776961, 22, 30, 53, 1000);
    await sleep(250);
    alt1.overLayClearGroup("progflash");
  } finally {
    flashing = false;
  }
}

function debugHeader() {
  const rsX = window.alt1 ? alt1.rsX : "n/a";
  const rsY = window.alt1 ? alt1.rsY : "n/a";
  const rsW = window.alt1 ? alt1.rsWidth : "n/a";
  const rsH = window.alt1 ? alt1.rsHeight : "n/a";

  const nativeCapType = typeof window.captureRs;
  const nativeEventsType = typeof window.captureEvents;

  const alt1Keys = window.alt1 ? Object.keys(alt1).filter(k => k.toLowerCase().includes("capture")) : [];
  const alt1Fns = window.alt1 ? alt1Keys.filter(k => typeof alt1[k] === "function") : [];
  const alt1Props = window.alt1 ? alt1Keys.filter(k => typeof alt1[k] !== "function") : [];

  return (
    `ProgFlash v=${APP_V}\n` +
    `anchor=${anchor ? (anchor.width + "x" + anchor.height) : "n/a"}\n` +
    `rsX=${rsX} rsY=${rsY}\n` +
    `rsW=${rsW} rsH=${rsH}\n` +
    `native captureRs: ${nativeCapType}\n` +
    `native captureEvents: ${nativeEventsType}\n` +
    `alt1.capture keys: ${alt1Keys.join(",") || "(none)"}\n` +
    `alt1.capture fns: ${alt1Fns.join(",") || "(none)"}\n` +
    `alt1.capture props: ${alt1Props.join(",") || "(none)"}\n`
  );
}

async function start() {
  if (!window.alt1) {
    setStatus("Not running in Alt1");
    setMode("Not running");
    dbg(`ProgFlash v=${APP_V}\nalt1: false`);
    return;
  }

  if (!alt1.permissionPixel || !alt1.permissionOverlay) {
    setStatus("Missing permissions");
    setMode("Not running");
    dbg(`ProgFlash v=${APP_V}\noverlay=${alt1.permissionOverlay}\ncapture=${alt1.permissionPixel}`);
    return;
  }

  if (typeof window.progflashCaptureRs !== "function" ||
      typeof window.progflashLoadImage !== "function" ||
      typeof window.progflashFindAnchor !== "function") {
    setStatus("matcher.js not loaded");
    setMode("Not running");
    dbg(`ProgFlash v=${APP_V}\nMissing progflash* globals.\nCheck script order in index.html.`);
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
  tick(); // run immediately
  loop = setInterval(tick, 200);
}

function tick() {
  if (!running) return;

  const img = window.progflashCaptureRs();
  if (!img) {
    dbg(debugHeader() + "captureRs(): null (capture failed)");
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
    debugHeader() +
    `img=${img.width}x${img.height}\n` +
    `best score=${scoreTxt}\n` +
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
stopBtn.onclick = () => stop();

// init
setStatus("Idle");
setMode("Not running");
setLock("none");
dbg(`ProgFlash v=${APP_V}\nLoading…`);
