import { captureRs, loadImage, findAnchor } from "./matcher.js";

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

function flashOverlay() {
  if (!alt1.permissionOverlay) {
    setStatus("No overlay permission");
    return;
  }

  const g = "progflash";
  let i = 0;

  const t = setInterval(() => {
    alt1.overLaySetGroup(g);
    if (i % 2 === 0) {
      alt1.overLayRect(
        rgba(255,0,0,160),
        alt1.rsX || 0,
        alt1.rsY || 0,
        alt1.rsWidth || 800,
        alt1.rsHeight || 600,
        200,
        0
      );
    } else {
      alt1.overLayClearGroup(g);
    }
    if (++i >= 10) {
      alt1.overLayClearGroup(g);
      clearInterval(t);
    }
  }, 200);
}

let running = false;
let anchor = null;
let lastSeen = 0;
let loop = null;

async function start() {
  if (!alt1.permissionPixel || !alt1.permissionOverlay) {
    setStatus("Missing permissions");
    return;
  }

  if (!anchor) {
    setStatus("Loading anchor…");
    anchor = await loadImage("./img/progbar_anchor.png");
    dbg(
  "Anchor loaded\n" +
  "w=" + anchor.width + " h=" + anchor.height + "\n" +
  "alt1: " + !!window.alt1 + "\n" +
  "overlay: " + alt1.permissionOverlay + "\n" +
  "capture: " + alt1.permissionPixel
);

  }

  running = true;
  startBtn.disabled = true;
  stopBtn.disabled = false;

  setMode("Running");
  setStatus("Searching…");

  loop = setInterval(() => {
    const img = captureRs();
    if (!img) return;

    const hit = findAnchor(img, anchor);
    if (hit) {
      lastSeen = Date.now();
      setStatus("Locked");
      setLock(`x=${hit.x}, y=${hit.y}`);
      return;
    }

    if (lastSeen && Date.now() - lastSeen > 450) {
      flashOverlay();
      lastSeen = 0;
      setStatus("Flashed!");
      setLock("none");
    }
  }, 150);
}

function stop() {
  running = false;
  clearInterval(loop);
  loop = null;

  startBtn.disabled = false;
  stopBtn.disabled = true;

  setMode("Not running");
  setStatus("Idle");
  setLock("none");
}

testBtn.onclick = () => { setStatus("Test flash"); flashOverlay(); };
startBtn.onclick = start;
stopBtn.onclick = stop;

dbg(
  "alt1: " + !!window.alt1 + "\n" +
  "overlay: " + alt1.permissionOverlay + "\n" +
  "capture: " + alt1.permissionPixel
);
