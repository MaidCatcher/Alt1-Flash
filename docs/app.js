// app.js — diagnostic build (shows WHY capture fails)

const statusEl = document.getElementById("status");
const modeEl   = document.getElementById("mode");
const lockEl   = document.getElementById("lock");
const progEl   = document.getElementById("progress");
const dbgEl    = document.getElementById("debugBox");

const startBtn = document.getElementById("startBtn");
const stopBtn  = document.getElementById("stopBtn");
const testBtn  = document.getElementById("testFlashBtn");

function setStatus(v){ if (statusEl) statusEl.textContent = v; }
function setMode(v){ if (modeEl) modeEl.textContent = v; }
function setLock(v){ if (lockEl) lockEl.textContent = v; }
function setProgress(v){ if (progEl) progEl.textContent = v; }
function dbg(v){ if (dbgEl) dbgEl.textContent = String(v); }

let running = false;
let loop = null;
let anchor = null;

async function start(){
  if (!window.alt1){
    setStatus("Alt1 missing");
    dbg("Open this inside Alt1 Toolkit.");
    return;
  }

  // show basic Alt1 state right away
  dbg(JSON.stringify({
    alt1: true,
    permissionPixel: !!alt1.permissionPixel,
    permissionOverlay: !!alt1.permissionOverlay,
    hasGetRegion: typeof alt1.getRegion === "function",
    rsX: alt1.rsX, rsY: alt1.rsY,
    rsWidth: alt1.rsWidth, rsHeight: alt1.rsHeight
  }, null, 2));

  if (typeof window.captureRs !== "function" ||
      typeof window.findAnchor !== "function" ||
      typeof window.loadImage !== "function") {
    setStatus("matcher.js not loaded");
    dbg("Missing globals:\n" + JSON.stringify({
      captureRs: typeof window.captureRs,
      findAnchor: typeof window.findAnchor,
      loadImage: typeof window.loadImage
    }, null, 2));
    return;
  }

  if (!anchor){
    setStatus("Loading anchor…");
    anchor = await loadImage("img/progbar_anchor.png?v=" + Date.now());
  }
  if (!anchor){
    setStatus("Anchor load failed");
    dbg("Could not load img/progbar_anchor.png (check path + case).");
    return;
  }

  running = true;
  setMode("Running");
  setStatus("Searching…");
  setLock("none");
  setProgress("—");

  if (loop) clearInterval(loop);
  loop = setInterval(tick, 200);
}

function stop(){
  running = false;
  if (loop) clearInterval(loop);
  loop = null;
  setMode("Not running");
  setStatus("Idle");
  setLock("none");
  setProgress("—");
}

function tick(){
  if (!running) return;

  const img = captureRs();
  if (!img){
    setStatus("Capture failed");
    const d = window.progflashCaptureDiag || {};
    dbg("captureRs(): null\n\n" + JSON.stringify(d, null, 2));
    return;
  }

  const res = findAnchor(img, anchor, {
    tolerance: 90,
    minScore: 0.25
  });

  if (res && res.ok){
    setStatus("Locked");
    setLock(`x=${res.x}, y=${res.y}`);
    setProgress("locked");
  } else {
    setStatus("Searching…");
    setLock("none");
    setProgress("—");
  }

  dbg(JSON.stringify({
    capture: { w: img.width, h: img.height },
    anchor: { w: anchor.width, h: anchor.height },
    res
  }, null, 2));
}

testBtn.onclick = () => alert("flash test");
startBtn.onclick = () => start().catch(console.error);
stopBtn.onclick = () => stop();

setStatus("Idle");
setMode("Not running");
setLock("none");
setProgress("—");
