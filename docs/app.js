import { captureRs, loadImage, findAnchor } from "./matcher.js";

const statusEl = document.getElementById("status");
const modeEl   = document.getElementById("mode");
const lockEl   = document.getElementById("lock");
const dbgEl    = document.getElementById("debugBox");

const startBtn = document.getElementById("startBtn");
const stopBtn  = document.getElementById("stopBtn");
const testBtn  = document.getElementById("testFlashBtn");

const BUILD = 1765636596943;

function setStatus(v){ statusEl.textContent = v; }
function setMode(v){ modeEl.textContent = v; }
function setLock(v){ lockEl.textContent = v; }
function dbg(v){ dbgEl.textContent = String(v); }

function rgba(r,g,b,a=255){
  return (r&255)|((g&255)<<8)|((b&255)<<16)|((a&255)<<24);
}

function clearDebugOverlay() {
  if (!window.alt1 || !alt1.permissionOverlay) return;
  alt1.overLaySetGroup("progflash_debug");
  alt1.overLayClearGroup("progflash_debug");
}

// ----- Flash (safe, finite, non-overlapping) -----
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

// ----- Capture normalization to RS viewport -----
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

let running = false;
let anchor = null;
let loop = null;
let tries = 0;
let hits = 0;

async function start() {
  if (!window.alt1) { alert("Open this inside Alt1."); return; }

  if (!alt1.permissionPixel || !alt1.permissionOverlay) {
    setStatus("Missing permissions");
    dbg(
      `ProgFlash v=${BUILD}\n` +
      `alt1: ${!!window.alt1}\n` +
      `overlay: ${alt1.permissionOverlay}\n` +
      `capture: ${alt1.permissionPixel}\n\n` +
      "Enable 'View screen' and 'Show overlay' for ProgFlash in Alt1 settings."
    );
    return;
  }

  if (!anchor) {
    setStatus("Loading anchor…");
    anchor = await loadImage("./img/progbar_anchor.png");
  }

  running = true;
  startBtn.disabled = true;
  stopBtn.disabled = false;
  setMode("Running");
  setStatus("Searching…");
  setLock("none");
  clearDebugOverlay();

  tries = 0;
  hits = 0;

  if (loop) clearInterval(loop);

  loop = setInterval(() => {
    if (!running) return;

    // If permissions got toggled off while running, stop cleanly.
    if (!alt1.permissionPixel || !alt1.permissionOverlay) {
      stop();
      setStatus("Permissions removed");
      return;
    }

    const img = captureRsViewport();
    if (!img) {
      dbg(
        `ProgFlash v=${BUILD}\n` +
        `anchor=${anchor ? `${anchor.width}x${anchor.height}` : "n/a"}\n` +
        "captureRs(): null (capture failed)"
      );
      return;
    }

    tries++;

    // Always ask for a best score so we can debug.
    const hit = findAnchor(img, anchor, {
      tolerance: 65,
      stride: 1,
      step: 1,
      minScore: 0.50,
      returnBest: true
    });

    const scoreStr = hit && typeof hit.score === "number" ? hit.score.toFixed(3) : "n/a";
    dbg(
      `ProgFlash v=${BUILD}\n` +
      `img=${img.width}x${img.height}\n` +
      `anchor=${anchor.width}x${anchor.height}\n` +
      `tries=${tries} hits=${hits}\n` +
      `best score=${scoreStr}\n` +
      `passed=${hit ? hit.passed : false}`
    );

    // Draw yellow best-guess box if we have something reasonable.
    if (hit && hit.best && alt1.permissionOverlay && hit.score >= 0.30) {
      alt1.overLaySetGroup("progflash_debug");
      alt1.overLayRect(
        rgba(255, 255, 0, 140),
        (alt1.rsX || 0) + hit.best.x,
        (alt1.rsY || 0) + hit.best.y,
        hit.best.w,
        hit.best.h,
        200,
        2
      );
    }

    if (hit && hit.passed) {
      hits++;
      setStatus("Locked");
      setLock(`x=${hit.x}, y=${hit.y}`);

      // Blue box where we matched
      if (alt1.permissionOverlay) {
        alt1.overLaySetGroup("progflash_debug");
        alt1.overLayRect(
          rgba(0, 120, 255, 200),
          (alt1.rsX || 0) + hit.x,
          (alt1.rsY || 0) + hit.y,
          hit.w,
          hit.h,
          300,
          2
        );
      }
    } else {
      setStatus("Searching…");
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
  clearDebugOverlay();
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

// Init
setStatus("Idle");
setMode("Not running");
setLock("none");

dbg(
  `ProgFlash v=${BUILD}\n` +
  `alt1: ${!!window.alt1}\n` +
  `overlay: ${window.alt1 ? alt1.permissionOverlay : false}\n` +
  `capture: ${window.alt1 ? alt1.permissionPixel : false}`
);
