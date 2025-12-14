// app.js (Alt1-compatible: NO imports/modules)

const statusEl = document.getElementById("status");
const modeEl   = document.getElementById("mode");
const lockEl   = document.getElementById("lock");
const dbgEl    = document.getElementById("debugBox");
const progressEl = document.getElementById("progressPct");

const startBtn = document.getElementById("startBtn");
const stopBtn  = document.getElementById("stopBtn");
const testBtn  = document.getElementById("testFlashBtn");

const thresholdInput = document.getElementById("thresholdPct");
const flashStyleSel  = document.getElementById("flashStyle");

function setStatus(v){ statusEl.textContent = v; }
function setMode(v){ modeEl.textContent = v; }
function setLock(v){ lockEl.textContent = v; }
function dbg(v){ dbgEl.textContent = String(v); }
function setProgress(v){ progressEl.textContent = v; }

function rgba(r,g,b,a=255){
  return (r&255)|((g&255)<<8)|((b&255)<<16)|((a&255)<<24);
}

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

const APP_V = Date.now();

// --- Settings persistence ---
const LS_THRESH = "progflash_thresholdPct";
const LS_STYLE  = "progflash_flashStyle";

function loadSettings() {
  const t = parseInt(localStorage.getItem(LS_THRESH) || "95", 10);
  const s = localStorage.getItem(LS_STYLE) || "fullscreen";
  thresholdInput.value = String(Math.min(99, Math.max(1, isFinite(t) ? t : 95)));
  flashStyleSel.value = (s === "text") ? "text" : "fullscreen";
}

function saveSettings() {
  const t = Math.min(99, Math.max(1, parseInt(thresholdInput.value || "95", 10) || 95));
  thresholdInput.value = String(t);
  localStorage.setItem(LS_THRESH, String(t));
  localStorage.setItem(LS_STYLE, flashStyleSel.value === "text" ? "text" : "fullscreen");
}

loadSettings();
thresholdInput.addEventListener("change", saveSettings);
flashStyleSel.addEventListener("change", saveSettings);

function getThreshold() {
  return Math.min(99, Math.max(1, parseInt(thresholdInput.value || "95", 10) || 95));
}

function getFlashStyle() {
  return flashStyleSel.value === "text" ? "text" : "fullscreen";
}

// ---- Flash (text or fullscreen) ----
let flashing = false;
let lastFlashAt = 0;
const FLASH_COOLDOWN_MS = 1500;

async function flashText({ cycles = 3, intervalMs = 250 } = {}) {
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
      alt1.overLayText("PROGFLASH", -16776961, 22, 30, 53, 600);
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

async function flashFullscreen({ cycles = 2, intervalMs = 180 } = {}) {
  if (!window.alt1 || !alt1.permissionOverlay) return;

  const now = Date.now();
  if (now - lastFlashAt < FLASH_COOLDOWN_MS) return;
  lastFlashAt = now;

  if (flashing) return;
  flashing = true;

  const g = "progflash_flash";
  try {
    const x = alt1.rsX || 0;
    const y = alt1.rsY || 0;
    const w = alt1.rsWidth || 0;
    const h = alt1.rsHeight || 0;

    for (let i = 0; i < cycles; i++) {
      alt1.overLaySetGroup(g);
      // bright white-ish flash across the RS viewport
      alt1.overLayRect(rgba(255,255,255,200), x, y, w, h, 250, 0);
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

function flashNow() {
  const style = getFlashStyle();
  if (style === "text") return flashText().catch(console.error);
  return flashFullscreen().catch(console.error);
}

function clearDebugOverlay() {
  if (!window.alt1 || !alt1.permissionOverlay) return;
  alt1.overLaySetGroup("progflash_debug");
  alt1.overLayClearGroup("progflash_debug");
}

// ---- Progress helpers ----
function getPx(img, x, y) {
  if (!img) return null;
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return null;
  const i = (y * img.width + x) * 4;
  const d = img.data;
  return { r: d[i], g: d[i+1], b: d[i+2], a: d[i+3] };
}

function lum(c) {
  return (c.r * 30 + c.g * 59 + c.b * 11) / 100;
}

function colorDist(a, b) {
  return Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);
}

// Robust progress % estimation using luminance difference across multiple scanlines.
// Works better than "green dominance" on RS gradients/shine.
function measureProgressPercent(img, lockX, lockY, anchorW, anchorH) {
  const scanLines = [
    Math.floor(lockY + anchorH * 0.25),
    Math.floor(lockY + anchorH * 0.50),
    Math.floor(lockY + anchorH * 0.75),
  ];

  let bestPct = null;

  for (const scanY of scanLines) {
    if (scanY < 0 || scanY >= img.height) continue;

    const centerX = Math.min(img.width - 1, Math.max(0, lockX + Math.floor(anchorW / 2)));
    const ref = getPx(img, centerX, scanY);
    if (!ref) continue;

    // find interior bounds by walking until pixels differ from the anchor-interior reference
    let left = centerX;
    let right = centerX;

    for (let i = 0; i < 600; i++) {
      const x = centerX - i;
      const p = getPx(img, x, scanY);
      if (!p || colorDist(p, ref) > 80) break;
      left = x;
    }

    for (let i = 0; i < 1200; i++) {
      const x = centerX + i;
      const p = getPx(img, x, scanY);
      if (!p || colorDist(p, ref) > 80) break;
      right = x;
    }

    const width = right - left + 1;
    if (width < 80) continue;

    const emptyP = getPx(img, right, scanY);
    if (!emptyP) continue;
    const emptyLum = lum(emptyP);

    // scan from left: filled part is usually darker than empty region
    let fillX = left;

    for (let x = left; x <= right; x++) {
      const p = getPx(img, x, scanY);
      if (!p) break;

      if (lum(p) < emptyLum - 10) {
        fillX = x;
      } else if (x > left + 10) {
        // once we’ve seen non-fill beyond the initial margin, stop
        break;
      }
    }

    const pct = Math.max(0, Math.min(100, ((fillX - left) / width) * 100));
    if (bestPct == null || pct > bestPct) bestPct = pct;
  }

  return bestPct;
}

// ---- State ----
let running = false;
let loop = null;
let anchor = null;

// threshold crossing behavior
let lastPct = null;
let flashedThisCraft = false;

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
  setProgress("—");
  clearDebugOverlay();

  lastPct = null;
  flashedThisCraft = false;

  if (loop) clearInterval(loop);

  const tick = () => {
    if (!running) return;

    const img = window.progflashCaptureRs();
    if (!img) {
      dbg(
        `ProgFlash v=${APP_V}\n` +
        `anchor=${anchor.width}x${anchor.height}\n` +
        `rsX=${alt1.rsX} rsY=${alt1.rsY}\n` +
        `rsW=${alt1.rsWidth} rsH=${alt1.rsHeight}\n` +
        `captureRs(): null (capture failed)`
      );
      setProgress("—");
      return;
    }

    const res = window.progflashFindAnchor(img, anchor, {
      tolerance: 65,
      stride: 1,
      minScore: 0.50,
      returnBest: true
    });

    const scoreTxt = (res && typeof res.score === "number") ? res.score.toFixed(3) : "n/a";

    // Debug overlay rectangle for best match
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

      const pct = measureProgressPercent(img, res.x, res.y, anchor.width, anchor.height);
      if (pct == null) {
        setProgress("—");
        lastPct = null;
        flashedThisCraft = false;
      } else {
        setProgress(pct.toFixed(0) + "%");

        // reset for next craft once it drops low again
        if (pct <= 5) flashedThisCraft = false;

        const thresh = getThreshold();

        // flash once when crossing upward over threshold
        if (!flashedThisCraft) {
          if (lastPct != null && lastPct < thresh && pct >= thresh) {
            flashedThisCraft = true;
            flashNow();
          }
        }

        lastPct = pct;
      }

    } else {
      setStatus("Searching…");
      setLock("none");
      setProgress("—");
      lastPct = null;
      flashedThisCraft = false;
    }

    dbg(
      `ProgFlash v=${APP_V}\n` +
      `img=${img.width}x${img.height}\n` +
      `anchor=${anchor.width}x${anchor.height}\n` +
      `best score=${scoreTxt}\n` +
      `ok=${!!(res && res.ok)}\n` +
      `flashAt=${getThreshold()}%\n` +
      `flashStyle=${getFlashStyle()}`
    );
  };

  tick();
  loop = setInterval(tick, 150);
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
  setProgress("—");
  clearDebugOverlay();
}

// Buttons
testBtn.onclick = () => {
  setStatus("Test flash");
  flashNow();
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
setProgress("—");

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
