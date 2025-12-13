import { captureRs, loadImage, findAnchor, MATCHER_VERSION } from "./matcher.js?v=1765632483";

const APP_VERSION = "1765632483";

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

function rgba(r,g,b,a=255){
  return (r&255)|((g&255)<<8)|((b&255)<<16)|((a&255)<<24);
}

function clearGroup(name){
  if (!window.alt1 || !alt1.permissionOverlay) return;
  alt1.overLaySetGroup(name);
  alt1.overLayClearGroup(name);
}

function clearDebug() {
  clearGroup("progflash_debug");
}

// ---------- Flash (safe; no setInterval storms) ----------
let flashing = false;
let lastFlashAt = 0;
const FLASH_COOLDOWN_MS = 1500;
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

async function flashOverlay({ cycles = 3, intervalMs = 300 } = {}) {
  if (!window.alt1 || !alt1.permissionOverlay) return;

  const now = Date.now();
  if (now - lastFlashAt < FLASH_COOLDOWN_MS) return;
  lastFlashAt = now;

  if (flashing) return;
  flashing = true;

  const g = "progflash_flash";
  const colorBlue = -16776961; // signed 0xFF0000FF

  try {
    for (let i = 0; i < cycles; i++) {
      alt1.overLaySetGroup(g);
      alt1.overLayText("PROGFLASH", colorBlue, 22, 30, 53, 900);
      await sleep(intervalMs);
      alt1.overLayClearGroup(g);
      await sleep(intervalMs);
    }
  } finally {
    alt1.overLaySetGroup(g);
    alt1.overLayClearGroup(g);
    flashing = false;
  }
}

// ---------- Capture ----------
function captureRsViewport() {
  const full = captureRs();
  if (!full) return null;

  const w = alt1.rsWidth;
  const h = alt1.rsHeight;
  const x = alt1.rsX || 0;
  const y = alt1.rsY || 0;

  if (w && h && full.width === w && full.height === h && x === 0 && y === 0) return full;
  if (!w || !h) return full;

  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  try {
    ctx.putImageData(full, -x, -y);
    return ctx.getImageData(0, 0, w, h);
  } catch {
    return full;
  }
}

// ---------- Main state ----------
let running = false;
let anchor = null;
let lastSeen = 0;
let loop = null;
let tries = 0;
let hits = 0;

function drawBestGuess(best) {
  if (!window.alt1 || !alt1.permissionOverlay) return;
  if (!best || best.score == null) return;

  if (best.score < 0.40) {
    clearGroup("progflash_best");
    return;
  }

  alt1.overLaySetGroup("progflash_best");
  alt1.overLayClearGroup("progflash_best");
  alt1.overLayRect(
    rgba(255, 215, 0, 120),
    (alt1.rsX || 0) + best.x,
    (alt1.rsY || 0) + best.y,
    best.w,
    best.h,
    220,
    2
  );
}

async function start() {
  if (!window.alt1) { alert("Open this inside Alt1."); return; }

  if (!alt1.permissionPixel || !alt1.permissionOverlay) {
    setStatus("Missing permissions");
    dbg("Enable 'View screen' and 'Show overlay' for ProgFlash in Alt1 settings.");
    return;
  }

  if (!anchor) {
    setStatus("Loading anchor…");
    anchor = await loadImage("./img/progbar_anchor.png?v=1765632483");
  }

  running = true;

  startBtn.disabled = true;
  stopBtn.disabled = false;

  setMode("Running");
  setStatus("Searching…");
  setLock("none");
  clearDebug();
  clearGroup("progflash_best");

  tries = 0; hits = 0; lastSeen = 0;

  if (loop) { clearInterval(loop); loop = null; }

  loop = setInterval(() => {
    if (!running) return;

    const img = captureRsViewport();
    if (!img) return;

    tries++;

    const res = findAnchor(img, anchor, { tolerance: 65, stride: 1, minScore: 0.50, returnBest: true });
    const bestScore = (res && typeof res.score === "number") ? res.score : null;

    dbg(
      "ProgFlash v=" + APP_VERSION + "\n" +
      "Matcher v=" + MATCHER_VERSION + "\n" +
      "anchor w=" + anchor.width + " h=" + anchor.height + "\n" +
      "tries=" + tries + " hits=" + hits + "\n" +
      "best score=" + (bestScore == null ? "n/a" : bestScore.toFixed(3))
    );

    if (res && res.x != null) drawBestGuess(res);

    if (res && res.ok) {
      hits++;
      lastSeen = Date.now();

      setStatus("Locked");
      setLock(`x=${res.x}, y=${res.y}`);

      alt1.overLaySetGroup("progflash_debug");
      alt1.overLayClearGroup("progflash_debug");
      alt1.overLayRect(
        rgba(0, 120, 255, 200),
        (alt1.rsX || 0) + res.x,
        (alt1.rsY || 0) + res.y,
        res.w,
        res.h,
        300,
        2
      );
      return;
    }

    if (lastSeen && Date.now() - lastSeen > 450) {
      clearDebug();
      flashOverlay().catch(console.error);
      lastSeen = 0;
      setStatus("Flashed!");
      setLock("none");
    }
  }, 150);
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

  clearDebug();
  clearGroup("progflash_best");
  clearGroup("progflash_flash");

  flashing = false;
}

testBtn.onclick = () => {
  console.log("TEST BUTTON CLICKED", Date.now());
  setStatus("Test flash");
  flashOverlay().catch(console.error);
};

startBtn.onclick = () => {
  console.log("START CLICKED", Date.now());
  start().catch(e => { console.error(e); setStatus("Error (see console)"); });
};

stopBtn.onclick = () => {
  console.log("STOP CLICKED", Date.now());
  stop();
};

setStatus("Idle");
setMode("Not running");
setLock("none");
dbg(
  "ProgFlash v=" + APP_VERSION + "\n" +
  "Matcher v=" + MATCHER_VERSION + "\n" +
  "alt1: " + !!window.alt1 + "\n" +
  "overlay: " + (window.alt1 ? alt1.permissionOverlay : false) + "\n" +
  "capture: " + (window.alt1 ? alt1.permissionPixel : false)
);
