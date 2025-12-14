// app.js — Alt1 compatible (NO modules / NO imports)

const statusEl = document.getElementById("status");
const modeEl = document.getElementById("mode");
const lockEl = document.getElementById("lock");
const progressEl = document.getElementById("progressPct");
const dbgEl = document.getElementById("debugBox");

const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const testBtn = document.getElementById("testFlashBtn");

const thresholdInput = document.getElementById("thresholdPct");
const flashStyleSel = document.getElementById("flashStyle");

function setStatus(v) { statusEl.textContent = v; }
function setMode(v) { modeEl.textContent = v; }
function setLock(v) { lockEl.textContent = v; }
function setProgress(v) { progressEl.textContent = v; }
function dbg(v) { dbgEl.textContent = String(v); }

function rgba(r, g, b, a = 255) {
  return (r & 255) | ((g & 255) << 8) | ((b & 255) << 16) | ((a & 255) << 24);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

const APP_V = Date.now();

// ---------------- Overlay flash ----------------

let flashing = false;
let flashedThisRun = false;

async function flashOverlay(style) {
  if (!window.alt1 || !alt1.permissionOverlay) return;
  if (flashing) return;

  flashing = true;
  const g = "progflash_flash";

  try {
    alt1.overLaySetGroup(g);

    if (style === "fullscreen") {
      // Full screen white flash
      alt1.overLayRect(
        rgba(255, 255, 255, 200),
        alt1.rsX || 0,
        alt1.rsY || 0,
        alt1.rsWidth || 1920,
        alt1.rsHeight || 1080,
        500,
        0
      );
      await sleep(120);
      alt1.overLayClearGroup(g);
    } else {
      // Text flash
      for (let i = 0; i < 2; i++) {
        alt1.overLayText("PROGFLASH", -1, 36, 40, 80, 800);
        await sleep(200);
        alt1.overLayClearGroup(g);
        await sleep(200);
      }
    }
  } finally {
    try {
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

// ---------------- State ----------------

let running = false;
let loop = null;
let anchor = null;

// ---------------- Main ----------------

async function start() {
  if (!window.alt1) {
    alert("Open this inside Alt1.");
    return;
  }

  if (!alt1.permissionPixel || !alt1.permissionOverlay) {
    setStatus("Missing permissions");
    dbg(
      `ProgFlash v=${APP_V}\n` +
      `Enable:\n` +
      `• View screen\n` +
      `• Show overlay`
    );
    return;
  }

  if (!window.progflashCaptureRs || !window.progflashLoadImage || !window.progflashFindAnchor) {
    setStatus("matcher.js not loaded");
    dbg(
      `ProgFlash v=${APP_V}\n` +
      `Missing matcher globals.\n` +
      `Check script order in index.html`
    );
    return;
  }

  if (!anchor) {
    setStatus("Loading anchor…");
    anchor = await window.progflashLoadImage("./img/progbar_anchor.png?v=" + APP_V);
  }

  flashedThisRun = false;
  running = true;

  startBtn.disabled = true;
  stopBtn.disabled = false;

  setMode("Running");
  setStatus("Searching…");
  setLock("none");
  setProgress("—");
  clearDebugOverlay();

  if (loop) clearInterval(loop);

  loop = setInterval(() => {
    if (!running) return;

    const img = window.progflashCaptureRs();
    if (!img) {
      dbg(
        `ProgFlash v=${APP_V}\n` +
        `captureRs(): null`
      );
      return;
    }

    const res = window.progflashFindAnchor(img, anchor, {
      tolerance: 65,
      stride: 1,
      minScore: 0.5,
      returnBest: true
    });

    const score = res && typeof res.score === "number" ? res.score : 0;
    const pct = Math.min(100, Math.max(0, Math.round(score * 100)));

    setProgress(pct + "%");

    dbg(
      `ProgFlash v=${APP_V}\n` +
      `img=${img.width}x${img.height}\n` +
      `anchor=${anchor.width}x${anchor.height}\n` +
      `best score=${score.toFixed(3)}\n` +
      `flashAt=${thresholdInput.value}%\n` +
      `flashStyle=${flashStyleSel.value}\n` +
      `ok=${!!res.ok}`
    );

    if (res && res.ok) {
      setStatus("Locked");
      setLock(`x=${res.x}, y=${res.y}`);

      if (!flashedThisRun && pct >= Number(thresholdInput.value)) {
        flashedThisRun = true;
        flashOverlay(flashStyleSel.value).catch(console.error);
      }
    } else {
      setStatus("Searching…");
      setLock("none");
    }
  }, 200);
}

function stop() {
  running = false;
  flashedThisRun = false;

  if (loop) clearInterval(loop);
  loop = null;

  startBtn.disabled = false;
  stopBtn.disabled = true;

  setMode("Not running");
  setStatus("Idle");
  setLock("none");
  setProgress("—");
  clearDebugOverlay();
}

// ---------------- Buttons ----------------

testBtn.onclick = () => {
  flashOverlay(flashStyleSel.value).catch(console.error);
};

startBtn.onclick = () => {
  start().catch(err => {
    console.error(err);
    setStatus("Error (see console)");
  });
};

stopBtn.onclick = () => stop();

// ---------------- Init ----------------

setStatus("Idle");
setMode("Not running");
setLock("none");
setProgress("—");

dbg(
  `ProgFlash v=${APP_V}\n` +
  `Ready`
);
