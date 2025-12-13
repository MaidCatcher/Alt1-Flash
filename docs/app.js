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

// --- Flash control (prevents overlapping timers / “spamming” Windows focus/notifications) ---
let flashing = false;
let lastFlashAt = 0;
const FLASH_COOLDOWN_MS = 1500;

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

async function flashOverlay({ cycles = 6, intervalMs = 250 } = {}) {
  if (!window.alt1) { alert("Open this inside Alt1."); return; }

  if (!alt1.permissionOverlay) {
    setStatus("No overlay permission");
    return;
  }

  // Hard cooldown so we never retrigger rapidly (helps a LOT with the DND flicker symptom)
  const now = Date.now();
  if (now - lastFlashAt < FLASH_COOLDOWN_MS) return;
  lastFlashAt = now;

  // If a flash is already running, don’t start another one.
  if (flashing) return;
  flashing = true;

  const g = "progflash_flash";
  const colorBlue = -16776961; // 0xFF0000FF as signed int

  try {
    for (let i = 0; i < cycles; i++) {
      // Draw
      alt1.overLaySetGroup(g);
      alt1.overLayText("PROGFLASH", colorBlue, 22, 30, 53, intervalMs * 2 + 50);
      await sleep(intervalMs);

      // Clear
      alt1.overLayClearGroup(g);
      await sleep(intervalMs);
    }
  } finally {
    // Always leave the overlay group clean
    alt1.overLaySetGroup(g);
    alt1.overLayClearGroup(g);
    flashing = false;
  }
}

/**
 * captureRs() returns an ImageData-like object.
 * On some setups it can include padding/offsets; this normalizes to the RS viewport
 * using rsX/rsY/rsWidth/rsHeight when needed.
 */
function captureRsViewport() {
  const full = captureRs();
  if (!full) return null;

  const w = alt1.rsWidth;
  const h = alt1.rsHeight;
  const x = alt1.rsX || 0;
  const y = alt1.rsY || 0;

  // If it already matches the viewport, use it as-is
  if (w && h && full.width === w && full.height === h && x === 0 && y === 0) {
    return full;
  }

  // If we don't have viewport dims, fall back to full
  if (!w || !h) return full;

  // Re-center viewport into (0,0) using a canvas
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
let lastSeen = 0;
let loop = null;

let tries = 0;
let hits = 0;

async function start() {
  if (!window.alt1) { alert("Open this inside Alt1."); return; }

  if (!alt1.permissionPixel || !alt1.permissionOverlay) {
    setStatus("Missing permissions");
    dbg("Enable 'View screen' and 'Show overlay' for ProgFlash in Alt1 settings.");
    return;
  }

  if (!anchor) {
    setStatus("Loading anchor…");
    anchor = await loadImage("./img/progbar_anchor.png");
    dbg(
      "Anchor loaded\n" +
      "w=" + anchor.width + " h=" + anchor.height + "\n" +
      "alt1: " + !!window.alt1 + "\n" +
      "overlay: " + alt1.permissionOverlay + "\n" +
      "capture: " + alt1.permissionPixel
    );
  }

  running = true;
  startBtn.disabled = true;
  stopBtn.disabled = false;

  setMode("Running");
  setStatus("Searching…");
  setLock("none");
  clearDebug();

  tries = 0;
  hits = 0;
  lastSeen = 0;

  // If an old loop exists (shouldn't, but safe), kill it.
  if (loop) {
    clearInterval(loop);
    loop = null;
  }

  loop = setInterval(() => {
    if (!running) return;

    // If permissions got toggled off while running, stop cleanly.
    if (!alt1.permissionPixel || !alt1.permissionOverlay) {
      stop();
      setStatus("Permissions removed");
      return;
    }

    const img = captureRsViewport();
    if (!img) return;

    tries++;

    // matcher.js now supports options; these are sane defaults for speed/robustness.
    const hit = findAnchor(img, anchor, { tolerance: 50, stride: 2, minScore: 0.65 });

    if (hit) {
      hits++;
      lastSeen = Date.now();
      setStatus("Locked");
      setLock(`x=${hit.x}, y=${hit.y}`);

      // BLUE DEBUG BOX (draw exactly where we matched)
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

      dbg(`Anchor loaded\nw=${anchor.width} h=${anchor.height}\ntries=${tries} hits=${hits}\nlast lock=${hit.x},${hit.y}`);
      return;
    }

    dbg(`Anchor loaded\nw=${anchor.width} h=${anchor.height}\ntries=${tries} hits=${hits}\nlast lock=none`);

    // Trigger a flash if we *recently* had a lock and then lost it for a bit.
    // NOTE: cooldown inside flashOverlay prevents repeated flashing storms.
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

  // Clean up flash overlay if it was mid-flight.
  if (window.alt1 && alt1.permissionOverlay) {
    alt1.overLaySetGroup("progflash");
    alt1.overLayClearGroup("progflash");
  }
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

// Startup state
setStatus("Idle");
setMode("Not running");
setLock("none");

dbg(
  "alt1: " + !!window.alt1 + "\n" +
  "overlay: " + (window.alt1 ? alt1.permissionOverlay : false) + "\n" +
  "capture: " + (window.alt1 ? alt1.permissionPixel : false)
);
