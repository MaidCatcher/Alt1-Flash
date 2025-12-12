// --- sanity check ---
if (!window.alt1) {
  document.body.insertAdjacentHTML(
    "afterbegin",
    "<div style='padding:8px;background:#fcc;border:1px solid #c99'>Not running in Alt1</div>"
  );
  throw new Error("Not running in Alt1");
}

// --- UI refs ---
const statusEl = document.getElementById("status");
const modeEl   = document.getElementById("mode");
const lockEl   = document.getElementById("lock");

const startBtn = document.getElementById("startBtn");
const stopBtn  = document.getElementById("stopBtn");
const testBtn  = document.getElementById("testFlashBtn");

let running = false;

// --- helpers ---
function rgba(r, g, b, a = 255) {
  return (r & 255) | ((g & 255) << 8) | ((b & 255) << 16) | ((a & 255) << 24);
}

function rgba(r, g, b, a = 255) {
  return (r & 255) |
         ((g & 255) << 8) |
         ((b & 255) << 16) |
         ((a & 255) << 24);
}

function testFlash() {
  if (!window.alt1) {
    alert("Not running inside Alt1");
    return;
  }
  if (!alt1.permissionOverlay) {
    alert("Overlay permission not granted");
    return;
  }

  const group = "progflash_test";
  let on = false;
  let ticks = 0;

  const timer = setInterval(() => {
    alt1.overLaySetGroup(group);

    if (on) {
      alt1.overLayClearGroup(group);
    } else {
      // BIG full-client flash so it is impossible to miss
      alt1.overLayRect(
        rgba(255, 0, 0, 160),
        alt1.rsX,
        alt1.rsY,
        alt1.rsWidth,
        alt1.rsHeight,
        250,
        0
      );
    }

    on = !on;
    ticks++;

    if (ticks > 6) {
      alt1.overLayClearGroup(group);
      clearInterval(timer);
    }
  }, 250);
}

function flashOverlay() {
  if (!alt1.permissionOverlay) {
    alert("Overlay permission not granted");
    return;
  }

  const group = "progflash";
  let i = 0;
  const flashes = 6;

  const t = setInterval(() => {
    alt1.overLaySetGroup(group);
    if (i % 2 === 0) {
      alt1.overLayRect(
        rgba(255, 0, 0, 140),
        alt1.rsX + 10,
        alt1.rsY + 10,
        400,
        200,
        200,
        4
      );
    } else {
      alt1.overLayClearGroup(group);
    }
    i++;
    if (i >= flashes * 2) {
      alt1.overLayClearGroup(group);
      clearInterval(t);
    }
  }, 200);
}

// --- buttons ---
testBtn.onclick = () => {
  statusEl.textContent = "Test flash";
  flashOverlay();
};

// --- progress bar detection using @alt1/base ---
let anchorImg = null;
let anchorFinder = null;
let lockedRect = null;
let tickTimer = null;

async function initDetector() {
  // alt1-base exposes global `alt1` already, and usually `alt1base` bundle exports as `alt1Base`
  // In the bundled build, image loading helper is available via `Alt1` namespace.
  // We'll load the anchor as an Image and use Alt1's image matching.

  anchorImg = new Image();
  anchorImg.src = "./img/progbar_anchor.png?v=1";
  await anchorImg.decode();

  // If alt1lib is present, we can use ImgRef (classic). If not, we use base capture APIs.
  if (window.ImgRef) {
    anchorFinder = new ImgRef(anchorImg);
  } else {
    anchorFinder = anchorImg; // fallback; we'll use findSubimage via a1lib/base if available
  }
}

function setStatus(s) { statusEl.textContent = s; }
function setMode(s) { modeEl.textContent = s; }
function setLock(s) { lockEl.textContent = s; }

function captureRs() {
  // Prefer alt1's built-in capture (available when View screen is enabled)
  // captureHoldFullRs returns ImageData-like object in classic libs; in newer builds alt1.capture is used.
  if (window.a1lib && a1lib.captureHoldFullRs) return a1lib.captureHoldFullRs();
  if (alt1.capture && alt1.captureHoldFullRs) return alt1.captureHoldFullRs(); // some builds
  if (alt1.capture && alt1.capture) return alt1.capture(); // generic
  // If none exists, we can't detect.
  return null;
}

function findAnchor(img) {
  // If classic ImgRef exists, use it
  if (window.a1lib && a1lib.findSubimage && anchorFinder) {
    // (img, imgref) -> match object
    return a1lib.findSubimage(img, anchorFinder);
  }

  // If `findSubimage` is available globally (some bundles expose it)
  if (window.findSubimage && anchorFinder) {
    return window.findSubimage(img, anchorFinder);
  }

  // No matcher available
  return null;
}

function inLockedArea(match) {
  // define a rectangle around the bar based on anchor position
  // Adjust numbers as needed for your UI scale
  const x = match.x - 5;
  const y = match.y - 5;
  const w = 230;
  const h = 26;
  return { x, y, w, h };
}

function startLoop() {
  if (!alt1.permissionPixel) { alert("Need View screen permission"); return; }
  if (!alt1.permissionOverlay) { alert("Need Show overlay permission"); return; }

  running = true;
  startBtn.disabled = true;
  stopBtn.disabled = false;

  setStatus("Searching...");
  setMode("Running");
  setLock("none");

  let lastSeen = 0;

  tickTimer = setInterval(() => {
    const img = captureRs();
    if (!img) {
      setStatus("No capture available");
      return;
    }

    // If not locked: find anchor anywhere
    if (!lockedRect) {
      const match = findAnchor(img);
      if (match && match.confidence !== undefined ? match.confidence > 0.85 : true) {
        lockedRect = inLockedArea(match);
        setLock(`x=${lockedRect.x}, y=${lockedRect.y}`);
        setStatus("Locked");
        lastSeen = Date.now();
      } else {
        setStatus("Searching...");
      }
      return;
    }

    // Locked: check presence again (either by re-finding anchor or sampling pixels)
    const match = findAnchor(img);
    const present = !!match;

    if (present) {
      lastSeen = Date.now();
      setStatus("Locked");
      return;
    }

    // If not present for a short grace period => treat as ended
    if (Date.now() - lastSeen > 400) {
      flashOverlay();
      setStatus("Flashed!");
      // reset lock so next cycle can find it again
      lockedRect = null;
      lastSeen = 0;
    }

  }, 150);
}

function stopLoop() {
  running = false;
  startBtn.disabled = false;
  stopBtn.disabled = true;
  lockedRect = null;
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = null;
  setStatus("Idle");
  setMode("Not running");
  setLock("none");
}

// Wire buttons
startBtn.onclick = async () => {
  if (!anchorImg) await initDetector();
  startLoop();
};
stopBtn.onclick = stopLoop;


startBtn.onclick = () => {
  running = true;
  statusEl.textContent = "Running";
  modeEl.textContent = "Armed";
  lockEl.textContent = "none";
  startBtn.disabled = true;
  stopBtn.disabled = false;
};

stopBtn.onclick = () => {
  running = false;
  statusEl.textContent = "Idle";
  modeEl.textContent = "Not running";
  lockEl.textContent = "none";
  startBtn.disabled = false;
  stopBtn.disabled = true;
};

document.getElementById("testFlashBtn").onclick = testFlash;

// --- startup ---
statusEl.textContent = "Idle";
modeEl.textContent = "Not running";
lockEl.textContent = "none";

document.body.insertAdjacentHTML(
  "afterbegin",
  "<div style='padding:6px;background:#ddf;border:1px solid #99c'>✅ app.js running</div>"
);



