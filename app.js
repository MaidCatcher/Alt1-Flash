/* global alt1, a1lib */

// =======================
// CONFIG (UI scale 100%)
// =======================

// This app finds a small anchor image on-screen, then derives the full bar rect.
// You'll likely only need to tweak BAR_W/BAR_H and BAR_OFFSET_* once.
const CFG = {
  TICK_MS: 200,            // polling rate (ms)
  SEARCH_EVERY_MS: 800,    // how often to do full-screen find when unlocked
  MIN_MATCH: 0.85,         // template match threshold (0..1) - raise if false positives

  // Full bar rectangle derived from anchor match.
  // anchor match returns the top-left of the matched anchor.
  BAR_OFFSET_X: 0,         // pixels from anchor top-left to bar rect top-left
  BAR_OFFSET_Y: 0,
  BAR_W: 360,              // approximate full bar width
  BAR_H: 28,               // approximate full bar height

  // Debounce “bar disappeared”
  MISSING_FRAMES_TO_TRIGGER: 4,

  // Flash behavior
  FLASH_BLINKS: 7,
  FLASH_INTERVAL_MS: 170,

  // Oversized overlay rect (safe “whole client” flash)
  // You can leave this big; overlay drawing outside the client doesn't matter.
  FLASH_RECT: { x: 0, y: 0, w: 4000, h: 2500 }
};

// =======================
// UI helpers
// =======================
const $ = (id) => document.getElementById(id);
function setStatus(text) { $("status").textContent = text; }
function setMode(text) { $("mode").textContent = text; }
function setLock(text) { $("lock").textContent = text; }

// =======================
// Alt1 checks
// =======================
if (!window.alt1) {
  setStatus("Open this inside Alt1.");
  throw new Error("Alt1 not detected");
}
if (!alt1.permissionPixel) {
  setStatus("Need pixel permission (enable capture in Alt1).");
  throw new Error("Missing pixel permission");
}
if (!alt1.permissionOverlay) {
  setStatus("Need overlay permission (enable overlay in Alt1).");
  throw new Error("Missing overlay permission");
}

// =======================
// Template setup
// =======================
const anchor = new a1lib.ImageDetect();
anchor.addImage("prog", "./img/progbar_anchor.png");

// =======================
// State
// =======================
let running = false;
let timer = null;

let locked = false;
let barRect = null;

let lastSearchAt = 0;
let missingCount = 0;
let seenCount = 0;

// =======================
// Core: find & lock
// =======================
function tryAcquireLock() {
  // Grab current RS area pixels
  const img = a1lib.captureHoldFullRs();
  if (!img) return;

  // Find anchor
  const found = anchor.findSubimage(img, "prog");
  if (!found || !found.length) return;

  // Pick best match (highest confidence)
  found.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const best = found[0];
  const score = best.score ?? 0;

  if (score < CFG.MIN_MATCH) return;

  // best.x / best.y are in captured image coordinates
  const x = best.x + CFG.BAR_OFFSET_X;
  const y = best.y + CFG.BAR_OFFSET_Y;

  barRect = { x, y, w: CFG.BAR_W, h: CFG.BAR_H };
  locked = true;
  missingCount = 0;
  seenCount = 0;

  setMode("Locked (tracking)");
  setLock(`x=${x}, y=${y}, w=${CFG.BAR_W}, h=${CFG.BAR_H} (score ${score.toFixed(2)})`);
}

// =======================
// Core: “bar present” heuristic
// =======================
// We avoid OCR and avoid sampling the “fill” (changes). Instead sample a few border-ish pixels.
// You will likely tweak the sample points ONCE after you verify your barRect is correct.
function barLooksPresent(regionImg) {
  // Sample points relative to barRect
  // These are conservative points near the frame edge.
  const samples = [
    { x: 6, y: 6 },
    { x: regionImg.width - 7, y: 6 },
    { x: 6, y: regionImg.height - 7 },
    { x: regionImg.width - 7, y: regionImg.height - 7 }
  ];

  // We treat “present” as “enough non-transparent / non-background-ish pixels exist at these points”.
  // a1lib stores pixels as ARGB ints. We'll just check the alpha and brightness-ish.
  let good = 0;

  for (const p of samples) {
    const col = regionImg.getPixel(p.x, p.y); // ARGB int
    const a = (col >>> 24) & 0xff;
    const r = (col >>> 16) & 0xff;
    const g = (col >>> 8) & 0xff;
    const b = col & 0xff;

    // Heuristic: UI frame pixels are usually not fully transparent and not near-black background.
    // If your bar frame is very dark, lower these thresholds.
    const bright = (r + g + b) / 3;

    if (a > 80 && bright > 20) good++;
  }

  return good >= 3; // 3/4 sample points look like UI
}

// =======================
// Alert: flash overlay
// =======================
function flashOverlay() {
  const group = "progflash";
  let i = 0;

  const t = setInterval(() => {
    alt1.overLaySetGroup(group);

    if (i % 2 === 0) {
      // Semi-transparent red
      const col = a1lib.mixcolor(255, 0, 0, 120);
      const R = CFG.FLASH_RECT;
      alt1.overLayRect(col, R.x, R.y, R.w, R.h, CFG.FLASH_INTERVAL_MS, 0);
    } else {
      alt1.overLayClearGroup(group);
    }

    i++;
    if (i >= CFG.FLASH_BLINKS * 2) {
      alt1.overLayClearGroup(group);
      clearInterval(t);
    }
  }, CFG.FLASH_INTERVAL_MS);
}

// =======================
// Main loop
// =======================
function tick() {
  if (!running) return;

  const now = Date.now();

  // If not locked, periodically search
  if (!locked) {
    if (now - lastSearchAt >= CFG.SEARCH_EVERY_MS) {
      lastSearchAt = now;
      setMode("Searching (auto-detect)");
      tryAcquireLock();
      if (!locked) setLock("none (no match yet)");
    }
    return;
  }

  // Locked: capture bar region and test presence
  const full = a1lib.captureHoldFullRs();
  if (!full || !barRect) return;

  const region = full.getSubImage(barRect.x, barRect.y, barRect.w, barRect.h);
  if (!region) return;

  const present = barLooksPresent(region);

  if (present) {
    seenCount++;
    missingCount = 0;
    setStatus(`Tracking… (${seenCount} frames seen)`);
  } else {
    missingCount++;
    setStatus(`Bar missing… (${missingCount}/${CFG.MISSING_FRAMES_TO_TRIGGER})`);
  }

  // Trigger when it was present, then disappears consistently
  if (seenCount >= 6 && missingCount >= CFG.MISSING_FRAMES_TO_TRIGGER) {
    setStatus("Done! Flashing.");
    flashOverlay();

    // reset lock so it can re-acquire next time you start another Make-X
    locked = false;
    barRect = null;
    missingCount = 0;
    seenCount = 0;
    setMode("Searching (auto-detect)");
    setLock("none");
  }

  // If it never looks present for a while, unlock and rescan (bar moved / bad rect)
  if (seenCount === 0 && missingCount >= 12) {
    locked = false;
    barRect = null;
    missingCount = 0;
    setMode("Searching (auto-detect)");
    setLock("none (lost lock)");
  }
}

// =======================
// Buttons
// =======================
$("startBtn").onclick = () => {
  if (running) return;
  running = true;
  setStatus("Running");
  setMode("Searching (auto-detect)");
  $("startBtn").disabled = true;
  $("stopBtn").disabled = false;
  timer = setInterval(tick, CFG.TICK_MS);
};

$("stopBtn").onclick = () => {
  running = false;
  if (timer) clearInterval(timer);
  timer = null;

  locked = false;
  barRect = null;
  missingCount = 0;
  seenCount = 0;

  alt1.overLayClearGroup("progflash");
  setStatus("Stopped");
  setMode("Not running");
  setLock("none");
  $("startBtn").disabled = false;
  $("stopBtn").disabled = true;
};

$("testFlashBtn").onclick = () => {
  flashOverlay();
};
