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
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const APP_V = Date.now();

// ---------------- Settings (persist) ----------------
const LS_THRESH = "progflash_thresholdPct";
const LS_STYLE = "progflash_flashStyle";

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

// ---------------- Flash (Text / Fullscreen) ----------------
let flashing = false;
let lastFlashAt = 0;
const FLASH_COOLDOWN_MS = 1200;

async function flashText() {
  if (!window.alt1 || !alt1.permissionOverlay) return;
  const now = Date.now();
  if (now - lastFlashAt < FLASH_COOLDOWN_MS) return;
  lastFlashAt = now;
  if (flashing) return;
  flashing = true;

  const g = "progflash_flash";
  try {
    for (let i = 0; i < 2; i++) {
      alt1.overLaySetGroup(g);
      alt1.overLayText("PROGFLASH", -1, 36, 40, 80, 700);
      await sleep(180);
      alt1.overLayClearGroup(g);
      await sleep(180);
    }
  } finally {
    try { alt1.overLaySetGroup(g); alt1.overLayClearGroup(g); } catch {}
    flashing = false;
  }
}

async function flashFullscreen() {
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

    for (let i = 0; i < 2; i++) {
      alt1.overLaySetGroup(g);
      alt1.overLayRect(rgba(255, 255, 255, 200), x, y, w, h, 200, 0);
      await sleep(120);
      alt1.overLayClearGroup(g);
      await sleep(120);
    }
  } finally {
    try { alt1.overLaySetGroup(g); alt1.overLayClearGroup(g); } catch {}
    flashing = false;
  }
}

function flashNow() {
  return (getFlashStyle() === "text" ? flashText() : flashFullscreen()).catch(console.error);
}

function clearDebugOverlay() {
  if (!window.alt1 || !alt1.permissionOverlay) return;
  alt1.overLaySetGroup("progflash_debug");
  alt1.overLayClearGroup("progflash_debug");
}

// ---------------- Pixel helpers ----------------
function getPx(img, x, y) {
  if (!img) return null;
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return null;
  const i = (y * img.width + x) * 4;
  const d = img.data;
  return { r: d[i], g: d[i + 1], b: d[i + 2] };
}
function lum(p) {
  return (p.r * 30 + p.g * 59 + p.b * 11) / 100;
}
function colorDist(a, b) {
  return Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);
}

// Measure progress bar fill percent using luminance drop vs empty region.
// Uses 3 scanlines for stability.
function measureProgressPercent(img, lockX, lockY, anchorW, anchorH) {
  const ys = [
    Math.floor(lockY + anchorH * 0.25),
    Math.floor(lockY + anchorH * 0.50),
    Math.floor(lockY + anchorH * 0.75),
  ];

  let best = null;

  for (const y of ys) {
    if (y < 0 || y >= img.height) continue;

    const cx = Math.min(img.width - 1, Math.max(0, lockX + Math.floor(anchorW / 2)));
    const ref = getPx(img, cx, y);
    if (!ref) continue;

    // Walk outwards to find interior bounds (stop when pixel differs from interior ref)
    let left = cx;
    for (let i = 0; i < 800; i++) {
      const x = cx - i;
      const p = getPx(img, x, y);
      if (!p || colorDist(p, ref) > 80) { left = x + 1; break; }
      left = x;
    }

    let right = cx;
    for (let i = 0; i < 1400; i++) {
      const x = cx + i;
      const p = getPx(img, x, y);
      if (!p || colorDist(p, ref) > 80) { right = x - 1; break; }
      right = x;
    }

    const width = right - left + 1;
    if (width < 100) continue;

    // Sample "empty" luminance from far right side (usually unfilled region)
    const emptyP = getPx(img, right, y);
    if (!emptyP) continue;
    const emptyLum = lum(emptyP);

    // Scan from left until luminance stops being significantly darker than empty.
    let fillX = left;
    let seenFill = false;

    for (let x = left; x <= right; x++) {
      const p = getPx(img, x, y);
      if (!p) break;

      const L = lum(p);
      const filled = (L < emptyLum - 10); // threshold

      if (filled) {
        fillX = x;
        seenFill = true;
      } else if (seenFill && x > left + 12) {
        break; // stop once we've passed the filled region
      }
    }

    const pct = Math.max(0, Math.min(100, ((fillX - left) / width) * 100));
    if (best == null || pct > best) best = pct;
  }

  return best;
}

// ---------------- Main logic ----------------
let running = false;
let loop = null;
let anchor = null;

let lastPct = null;
let flashedThisCraft = false;

function matcherReady() {
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
    dbg(`ProgFlash v=${APP_V}\nEnable View screen + Show overlay in Alt1.`);
    return;
  }

  if (!matcherReady()) {
    setStatus("matcher.js not loaded");
    dbg(
      `ProgFlash v=${APP_V}\n` +
      `Missing matcher globals.\n` +
      `capture=${typeof window.progflashCaptureRs}\n` +
      `load=${typeof window.progflashLoadImage}\n` +
      `find=${typeof window.progflashFindAnchor}`
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

  lastPct = null;
  flashedThisCraft = false;
  clearDebugOverlay();

  if (loop) clearInterval(loop);

  const tick = () => {
    if (!running) return;

    const img = window.progflashCaptureRs();
    if (!img) {
      setStatus("Searching…");
      setLock("none");
      setProgress("—");
      dbg(`ProgFlash v=${APP_V}\ncaptureRs(): null`);
      return;
    }

    const res = window.progflashFindAnchor(img, anchor, {
      tolerance: 65,
      stride: 1,
      minScore: 0.50,
      returnBest: true
    });

    const scoreTxt = (res && typeof res.score === "number") ? res.score.toFixed(3) : "n/a";

    // Optional debug rectangle on best match
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
        const pctRound = Math.max(0, Math.min(100, Math.round(pct)));
        setProgress(pctRound + "%");

        // Reset for next craft when it drops low again
        if (pctRound <= 5) flashedThisCraft = false;

        const thresh = getThreshold();
        if (!flashedThisCraft && lastPct != null && lastPct < thresh && pctRound >= thresh) {
          flashedThisCraft = true;
          flashNow();
        }

        lastPct = pctRound;
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
  loop = setInterval(tick, 120);
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

  lastPct = null;
  flashedThisCraft = false;

  clearDebugOverlay();
}

// ---------------- Buttons ----------------
testBtn.onclick = () => {
  setStatus("Test flash");
  flashNow();
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

dbg(`ProgFlash v=${APP_V}\nReady`);
