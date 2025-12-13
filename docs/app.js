// app.js (Alt1-compatible: NO imports/modules)

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

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

const APP_V = Date.now();

// ---- Overlay flash (safe) ----
let flashing = false;
let lastFlashAt = 0;
const FLASH_COOLDOWN_MS = 1500;

async function flashOverlay({ cycles = 3, intervalMs = 300 } = {}) {
  if (!window.alt1 || !alt1.permissionOverlay) return;

  const now = Date.now();
  if (now - lastFlashAt < FLASH_COOLDOWN_MS) return;
  lastFlashAt = now;

  if (flashing) return;
  flashing = true;

  const g = "progflash_flash";
  try {
    for (let i = 0; i < cycles; i++) {
      alt1.overLaySetGroup(g);
      alt1.overLayText("PROGFLASH", -16776961, 22, 30, 53, 800);
      await sleep(intervalMs);
      alt1.overLayClearGroup(g);
      await sleep(intervalMs);
    }
  } finally {
    try {
      alt1.overLaySetGroup(g);
      alt1.overLayClearGroup(g);
    } catch {}
    flashing = false;
  }
}

function clearDebugOverlay() {
  if (!window.alt1 || !alt1.permissionOverlay) return;
  alt1.overLaySetGroup("progflash_debug");
  alt1.overLayClearGroup("progflash_debug");
}

// ---- State ----
let running = false;
let loop = null;
let anchor = null;

function hasMatcherGlobals() {
  return (
    typeof window.progflashCaptureRs === "function" &&
    typeof window.progflashLoadImage === "function" &&
    typeof window.progflashFindAnchor === "function"
  );
}

async function start() {
  if (!window.alt1) { alert("Open this inside Alt1."); return; }

  if (!alt1.permissionPixel || !alt1.permissionOverlay) {
    setStatus("Missing permissions");
    dbg(
      `ProgFlash v=${APP_V}\n` +
      `alt1: ${!!window.alt1}\n` +
      `overlay: ${alt1.permissionOverlay}\n` +
      `capture: ${alt1.permissionPixel}\n` +
      `\nEnable 'View screen' + 'Show overlay' in Alt1.`
    );
    return;
  }

  // ✅ FIX: check the correct matcher globals
  if (!hasMatcherGlobals()) {
    setStatus("matcher.js not loaded");
    dbg(
      `ProgFlash v=${APP_V}\n` +
      `Missing matcher globals.\n` +
      `Expected: progflashCaptureRs/progflashLoadImage/progflashFindAnchor\n` +
      `Got: capture=${typeof window.progflashCaptureRs}, load=${typeof window.progflashLoadImage}, find=${typeof window.progflashFindAnchor}`
    );
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
  clearDebugOverlay();

  if (loop) clearInterval(loop);

  // (Optional but helpful): tick immediately
  // so you don’t miss the bar right after clicking Start.
  const tick = () => {
    if (!running) return;

    const img = window.progflashCaptureRs();

    if (!img) {
      const capKeys = window.alt1
        ? Object.keys(alt1).filter(k => k.toLowerCase().includes("capture")).sort().join(",")
        : "n/a";

      const nativeCE = typeof window.captureEvents;

      dbg(
        `ProgFlash v=${APP_V}\n` +
        `anchor=${anchor.width}x${anchor.height}\n` +
        `rsX=${alt1.rsX} rsY=${alt1.rsY}\n` +
        `rsW=${alt1.rsWidth} rsH=${alt1.rsHeight}\n` +
        `native captureEvents: ${nativeCE}\n` +
        `alt1 capture keys: ${capKeys}\n` +
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
      `ProgFlash v=${APP_V}\n` +
      `img=${img.width}x${img.height}\n` +
      `anchor=${anchor.width}x${anchor.height}\n` +
      `best score=${scoreTxt}\n` +
      `ok=${!!(res && res.ok)}`
    );

    if (res && res.best && alt1.permissionOverlay) {
      if (res.score >= 0.30) {
        alt1.overLaySetGroup("progflash_debug");
        alt1.overLayRect(
          rgba(255, 255, 0, 180),
          (alt1.rsX || 0) + res.best.x,
          (alt1.rsY || 0) + res.best.y,
          res.best.w,
          res.best.h,
          200,
          2
        );
      } else {
        clearDebugOverlay();
      }
    }

    if (res && res.ok) {
      setStatus("Locked");
      setLock(`x=${res.x}, y=${res.y}`);
      flashOverlay().catch(console.error);
    } else {
      setStatus("Searching…");
      setLock("none");
    }
  };

  tick();
  loop = setInterval(tick, 200);
}

function stop() {
  running = false;
  if (loop) clearInterval(loop);
  loop = null;

  // ✅ FIX: remove alt1.captureInterval(...) call (it is not a function on your build)

  startBtn.disabled = false;
  stopBtn.disabled = true;

  setMode("Not running");
  setStatus("Idle");
  setLock("none");
  clearDebugOverlay();
}

// Buttons
testBtn.onclick = () => {
  setStatus("Test flash");
  flashOverlay().catch(console.error);
};

startBtn.onclick = () => {
  start().catch(e => {
    console.error(e);
    setStatus("Error (see console)");
  });
};

stopBtn.onclick = () => stop();

// Init
setStatus("Idle");
setMode("Not running");
setLock("none");

// ✅ FIX: if matcher loads after app.js, clear the stale error
(function waitForMatcher() {
  if (hasMatcherGlobals()) {
    if (statusEl && statusEl.textContent.includes("matcher.js")) {
      setStatus("Idle");
    }
    return;
  }
  setTimeout(waitForMatcher, 50);
})();

if (window.alt1) {
  dbg(
    `ProgFlash v=${APP_V}\n` +
    `alt1: true\n` +
    `overlay: ${alt1.permissionOverlay}\n` +
    `capture: ${alt1.permissionPixel}\n` +
    `matcher globals: ${hasMatcherGlobals() ? "yes" : "no"}`
  );
} else {
  dbg(`ProgFlash v=${APP_V}\nalt1: false`);
}
