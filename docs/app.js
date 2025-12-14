// app.js — ProgFlash (Alt1 compatible, no imports)

const statusEl = document.getElementById("status");
const modeEl   = document.getElementById("mode");
const lockEl   = document.getElementById("lock");
const progEl   = document.getElementById("progress");
const dbgEl    = document.getElementById("debugBox");

const startBtn = document.getElementById("startBtn");
const stopBtn  = document.getElementById("stopBtn");
const testBtn  = document.getElementById("testFlashBtn");

const flashAtInput   = document.getElementById("flashAt");
const flashStyleSel  = document.getElementById("flashStyle");

const APP_V = Date.now();

// ---------- helpers ----------
function setStatus(v){ statusEl.textContent = v; }
function setMode(v){ modeEl.textContent = v; }
function setLock(v){ lockEl.textContent = v; }
function setProgress(v){ progEl.textContent = v; }
function dbg(v){ dbgEl.textContent = String(v); }

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

function rgba(r,g,b,a=255){
  return (r&255)|((g&255)<<8)|((b&255)<<16)|((a&255)<<24);
}

// ---------- green detection ----------
function isGreen(r,g,b){
  return g > 120 && g > r + 25 && g > b + 25;
}

// ---------- flash + audio ----------
let flashing = false;
let lastFlashAt = 0;

async function doFlash(style){
  if (!window.alt1 || !alt1.permissionOverlay) return;
  if (flashing) return;

  flashing = true;
  const g = "progflash_flash";

  try {
    if (style === "fullscreen") {
      alt1.overLaySetGroup(g);
      alt1.overLayRect(
        rgba(255,255,255,200),
        0, 0,
        alt1.rsWidth, alt1.rsHeight,
        300
      );
      await sleep(180);
      alt1.overLayClearGroup(g);
    } else {
      for (let i=0;i<3;i++){
        alt1.overLaySetGroup(g);
        alt1.overLayText("PROGFLASH", -1, 24, 40, 40, 600);
        await sleep(200);
        alt1.overLayClearGroup(g);
        await sleep(200);
      }
    }

    if (alt1.playSound) alt1.playSound("ding");
  } finally {
    flashing = false;
    lastFlashAt = Date.now();
  }
}

// ---------- state ----------
let running = false;
let loop = null;
let anchorImg = null;
let barRow = null;
let lastProgress = 0;
let flashedThisCraft = false;

// ---------- bar detection ----------
function findBarRow(img, startY, maxScan = 40){
  for (let dy=0; dy<maxScan; dy++){
    let green = 0;
    const y = startY + dy;
    for (let x=0; x<img.width; x++){
      const i = (x + y * img.width) * 4;
      if (isGreen(img.data[i], img.data[i+1], img.data[i+2])) {
        green++;
      }
    }
    if (green > img.width * 0.15) return y;
  }
  return null;
}

function computeProgress(img, y){
  let green = 0;
  for (let x=0; x<img.width; x++){
    const i = (x + y * img.width) * 4;
    if (isGreen(img.data[i], img.data[i+1], img.data[i+2])) green++;
  }
  return Math.round((green / img.width) * 100);
}

// ---------- main ----------
async function start(){
  if (!window.alt1 || !alt1.permissionPixel){
    alert("Open inside Alt1 with View Screen enabled.");
    return;
  }

  if (!window.loadImage || !window.captureRs || !window.findAnchor){
    setStatus("matcher.js not loaded");
    return;
  }

  if (!anchorImg){
    anchorImg = await loadImage("./img/progbar_anchor.png?v="+APP_V);
  }

  running = true;
  flashedThisCraft = false;
  barRow = null;
  lastProgress = 0;

  startBtn.disabled = true;
  stopBtn.disabled = false;

  setMode("Running");
  setStatus("Searching…");
  setLock("none");
  setProgress("—");

  loop = setInterval(()=>{
    if (!running) return;

    const img = captureRs();
    if (!img) return;

    const res = findAnchor(img, anchorImg, {
      tolerance: 65,
      minScore: 0.45,
      returnBest: true
    });

    if (!res || !res.ok){
      setStatus("Searching…");
      setLock("none");
      barRow = null;
      flashedThisCraft = false;
      return;
    }

    setStatus("Locked");
    setLock(`x=${res.x}, y=${res.y}`);

    if (barRow === null){
      barRow = findBarRow(img, res.y + anchorImg.height);
    }

    if (barRow !== null){
      let p = computeProgress(img, barRow);

      // smoothing + clamp
      p = Math.max(p, lastProgress);
      if (p > 100) p = 100;
      lastProgress = p;

      setProgress(p + "%");

      const flashAt = parseInt(flashAtInput.value || "95", 10);
      const style = flashStyleSel.value;

      if (!flashedThisCraft && p >= flashAt){
        flashedThisCraft = true;
        doFlash(style).catch(console.error);
      }
    }

    dbg(
      `ProgFlash v=${APP_V}\n`+
      `img=${img.width}x${img.height}\n`+
      `anchor=${anchorImg.width}x${anchorImg.height}\n`+
      `progress=${lastProgress}%\n`+
      `flashAt=${flashAtInput.value}%\n`+
      `flashStyle=${flashStyleSel.value}`
    );
  }, 200);
}

function stop(){
  running = false;
  clearInterval(loop);
  loop = null;

  startBtn.disabled = false;
  stopBtn.disabled = true;

  setMode("Not running");
  setStatus("Idle");
  setLock("none");
  setProgress("—");
}

// ---------- buttons ----------
startBtn.onclick = () => start().catch(console.error);
stopBtn.onclick = () => stop();
testBtn.onclick = () => doFlash(flashStyleSel.value);

// ---------- init ----------
setStatus("Idle");
setMode("Not running");
setLock("none");
setProgress("—");
