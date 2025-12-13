import { captureRs, loadImage, findAnchor, MATCHER_VERSION } from "./matcher.js";

const APP_VERSION = Date.now();

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

/* ================= FLASH (safe, finite) ================= */
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

/* ================= Capture helpers ================= */
function captureRsViewport() {
  const full = captureRs();
  if (!full) return null;

  const w = alt1.rsWidth;
  const h = alt1.rsHeight;
  const x = alt1.rsX || 0;
  const y = alt1.rsY || 0;

  // If it already matches viewport, use it
  if (w && h && full.width === w && full.height === h && x === 0 && y === 0) {
    return full;
  }
  // If viewport dims missing, fall back
  if (!w || !h) return full;

  // Normalize using canvas
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

function clearGroup(group){
  if (!window.alt1 || !alt1.permissionOverlay) return;
  alt1.overLaySetGroup(group);
  alt1.overLayClearGroup(group);
}

/* ================= State ================= */
let running = false;
let loop = null;

let anchor = null;
let lastSeen = 0;
let tries = 0;
let hits = 0;

function setUiStateIdle(){
  setStatus("Idle");
  setMode("Not running");
  setLock("none");
  startBtn.disabled = false;
  stopBtn.disabled = true;
}
function setUiStateRunning(){
  setStatus("Searching…");
  setMode("Running");
  setLock("none");
  startBtn.disabled = true;
  stopBtn.disabled = false;
}

/* ================= Main ================= */
async function start() {
  if (!window.alt1) { alert("Open this inside Alt1."); return; }

  if (!alt1.permissionPixel || !alt1.permissionOverlay) {
    setStatus("Missing permissions");
    dbg(
      `ProgFlash v=${APP_VERSION}\n` +
      `Matcher v=${MATCHER_VERSION}\n` +
      `alt1: ${!!window.alt1}\noverlay: ${alt1.permissionOverlay}\ncapture: ${alt1.permissionPixel}\n\n` +
      `Enable 'View screen' and 'Show overlay' permissions for this app.`
    );
    return;
  }

  if (!anchor) {
    setStatus("Loading anchor…");
    // cache-bust anchor too
    anchor = await loadImage(`./img/progbar_anchor.png?v=${APP_VERSION}`);
  }

  running = true;
  setUiStateRunning();
  clearGroup("progflash_debug");
  clearGroup("progflash_best");

  tries = 0;
  hits = 0;
  lastSeen = 0;

  if (loop) clearInterval(loop);

  loop = setInterval(() => {
    if (!running) return;

    // Permission removed mid-run
    if (!alt1.permissionPixel || !alt1.permissionOverlay) {
      stop();
      setStatus("Permissions removed");
      return;
    }

    const img = captureRsViewport();
    tries++;

    if (!img) {
      dbg(
        `ProgFlash v=${APP_VERSION}\n` +
        `Matcher v=${MATCHER_VERSION}\n` +
        `Anchor w=${anchor?.width ?? "?"} h=${anchor?.height ?? "?"}\n` +
        `tries=${tries} hits=${hits}\n` +
        `CAPTURE FAILED (img=null)\n` +
        `alt1.rsWidth=${alt1.rsWidth} alt1.rsHeight=${alt1.rsHeight}\n`
      );
      return;
    }

    // Always compute best score (even if not ok)
    const best = findAnchor(img, anchor, {
      tolerance: 70,
      stride: 1,
      minScore: 0.52,
      returnBest: true
    });

    const bestScore = (best && typeof best.score === "number") ? best.score.toFixed(3) : "n/a";

    // Show best match rectangle when it's somewhat close
    if (best && best.x != null && best.score >= 0.35 && alt1.permissionOverlay) {
      alt1.overLaySetGroup("progflash_best");
      alt1.overLayRect(
        rgba(255, 235, 59, 140), // yellow-ish
        (alt1.rsX || 0) + best.x,
        (alt1.rsY || 0) + best.y,
        best.w,
        best.h,
        200,
        2
      );
    } else {
      clearGroup("progflash_best");
    }

    dbg(
      `ProgFlash v=${APP_VERSION}\n` +
      `Matcher v=${MATCHER_VERSION}\n` +
      `Anchor w=${anchor.width} h=${anchor.height}\n` +
      `tries=${tries} hits=${hits}\n` +
      `img=${img.width}x${img.height}\n` +
      `best score=${bestScore}\n` +
      (best?.ok ? `LOCK @ ${best.x},${best.y}\n` : `no lock\n`) +
      `overlay: ${alt1.permissionOverlay}\n` +
      `capture: ${alt1.permissionPixel}\n`
    );

    if (best && best.ok) {
      hits++;
      lastSeen = Date.now();
      setStatus("Locked");
      setLock(`x=${best.x}, y=${best.y}`);

      // Debug box for actual lock
      if (alt1.permissionOverlay) {
        alt1.overLaySetGroup("progflash_debug");
        alt1.overLayRect(
          rgba(0, 120, 255, 200),
          (alt1.rsX || 0) + best.x,
          (alt1.rsY || 0) + best.y,
          best.w,
          best.h,
          300,
          2
        );
      }
      return;
    }

    // Lost lock flash (if we had a lock recently)
    if (lastSeen && Date.now() - lastSeen > 450) {
      clearGroup("progflash_debug");
      flashOverlay().catch(console.error);
      lastSeen = 0;
      setStatus("Flashed!");
      setLock("none");
    }
  }, 200);
}

function stop() {
  running = false;
  if (loop) clearInterval(loop);
  loop = null;

  setUiStateIdle();
  clearGroup("progflash_debug");
  clearGroup("progflash_best");
  clearGroup("progflash_flash");
  flashing = false;
}

/* ================= Buttons ================= */
testBtn.onclick = () => {
  console.log("TEST BUTTON CLICKED", Date.now());
  setStatus("Test flash");
  flashOverlay().catch(console.error);
};

startBtn.onclick = () => start().catch(e => { console.error(e); setStatus("Error (see console)"); });

stopBtn.onclick = () => stop();

/* ================= Init ================= */
setUiStateIdle();
dbg(
  `ProgFlash v=${APP_VERSION}\n` +
  `Matcher v=${MATCHER_VERSION}\n` +
  `alt1: ${!!window.alt1}\n` +
  `overlay: ${window.alt1 ? alt1.permissionOverlay : false}\n` +
  `capture: ${window.alt1 ? alt1.permissionPixel : false}\n`
);
