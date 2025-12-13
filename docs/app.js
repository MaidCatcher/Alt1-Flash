import { captureRs, loadImage, findAnchor } from "./matcher.js";

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

function clearDebug() {
  if (!window.alt1 || !alt1.permissionOverlay) return;
  alt1.overLaySetGroup("progflash_debug");
  alt1.overLayClearGroup("progflash_debug");
}

/* ================= FLASH SYSTEM ================= */

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
  const colorBlue = -16776961;

  try {
    for (let i = 0; i < cycles; i++) {
      alt1.overLaySetGroup(g);
      alt1.overLayText("PROGFLASH", colorBlue, 22, 30, 53, 800);
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

/* ================= PROGRESS STATE ================= */

let lastPercent = 0;

/* ================= CAPTURE ================= */

function captureRsViewport() {
  const full = captureRs();
  if (!full) return null;

  const w = alt1.rsWidth;
  const h = alt1.rsHeight;
  const x = alt1.rsX || 0;
  const y = alt1.rsY || 0;

  if (w && h && full.width === w && full.height === h && x === 0 && y === 0) {
    return full;
  }

  if (!w || !h) return full;

  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });

  try {
    ctx.putImageData(full, -x, -y);
    return ctx.getImageData(0, 0, w, h);
  } catch {
    return full;
  }
}

/* ================= MAIN LOOP ================= */

let running = false;
let anchor = null;
let lastSeen = 0;
let loop = null;

let tries = 0;
let hits = 0;

async function start() {
  if (!window.alt1) { alert("Open this inside Alt1."); return; }

  if (!alt1.permissionPixel || !alt1.permissionOverlay) {
    setStatus("Missing permissions");
    return;
  }

  if (!anchor) {
    anchor = await loadImage("./img/progbar_anchor.png");
  }

  running = true;
  lastPercent = 0;

  startBtn.disabled = true;
  stopBtn.disabled = false;

  setMode("Running");
  setStatus("Searching…");
  setLock("none");
  clearDebug();

  tries = 0;
  hits = 0;
  lastSeen = 0;

  if (loop) clearInterval(loop);

  loop = setInterval(() => {
    if (!running) return;

    const img = captureRsViewport();
    if (!img) return;

    tries++;

    const hit = findAnchor(img, anchor, {
      tolerance: 50,
      stride: 2,
      minScore: 0.65
    });

    if (hit) {
      hits++;
      lastSeen = Date.now();
      setLock(`x=${hit.x}, y=${hit.y}`);

      // ===== PROGRESS CALCULATION =====
      const barWidth = img.width - hit.x;
      const filled = Math.max(0, Math.min(barWidth, hit.x));
      const currentPercent = Math.round((filled / barWidth) * 100);

      // ===== 90% FLASH TRIGGER =====
      if (lastPercent < 90 && currentPercent >= 90) {
        flashOverlay();
      }
      lastPercent = currentPercent;

      setStatus(`Progress: ${currentPercent}%`);

      return;
    }

    // Lost lock flash (existing behavior)
    if (lastSeen && Date.now() - lastSeen > 450) {
      clearDebug();
      flashOverlay();
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

  lastPercent = 0;
  flashing = false;
}

/* ================= BUTTONS ================= */

testBtn.onclick = () => {
  console.log("TEST BUTTON CLICKED", Date.now());
  setStatus("Test flash");
  flashOverlay();
};

startBtn.onclick = () => {
  start().catch(console.error);
};

stopBtn.onclick = () => {
  stop();
};

/* ================= INIT ================= */

setStatus("Idle");
setMode("Not running");
setLock("none");

dbg(
  "alt1: " + !!window.alt1 + "\n" +
  "overlay: " + (window.alt1 ? alt1.permissionOverlay : false) + "\n" +
  "capture: " + (window.alt1 ? alt1.permissionPixel : false)
);
