// app.js (patched: progress element safe)

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

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

let running = false;
let loop = null;
let anchor = null;

async function start(){
  if (!window.alt1){
    alert("Open inside Alt1");
    return;
  }
  if (!window.captureRs || !window.findAnchor || !window.loadImage){
    setStatus("matcher.js not loaded");
    return;
  }

  if (!anchor){
    anchor = await loadImage("img/progbar_anchor.png");
  }

  running = true;
  setMode("Running");
  setStatus("Searching…");
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
    dbg("capture failed");
    return;
  }

  const res = findAnchor(img, anchor, {
    tolerance: 80,
    stride: 1,
    minScore: 0.30,
    returnBest: true
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

  dbg(JSON.stringify(res, null, 2));
}

testBtn.onclick = () => alert("flash test");
startBtn.onclick = () => start().catch(console.error);
stopBtn.onclick = () => stop();

setStatus("Idle");
setMode("Not running");
setLock("none");
setProgress("—");