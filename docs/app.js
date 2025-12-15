// app.js — Fully automatic:
// - Auto-find progress window anchor once, save its position
// - Then stop scanning completely (LOCKED state)
// - "Auto find" button forces rescanning and re-saving lock
//
// Requires matcher.js with: loadImage, captureRegion, findAnchor

const statusEl = document.getElementById("status");
const modeEl   = document.getElementById("mode");
const lockEl   = document.getElementById("lock");
const progEl   = document.getElementById("progress");
const dbgEl    = document.getElementById("debugBox");

const startBtn = document.getElementById("startBtn");
const stopBtn  = document.getElementById("stopBtn");
const autoFindBtn = document.getElementById("autoFindBtn");
const clearLockBtn = document.getElementById("clearLockBtn");
const testBtn  = document.getElementById("testFlashBtn");

const savedLockEl = document.getElementById("savedLock");

const canvas = document.getElementById("previewCanvas");
const ctx = canvas.getContext("2d", { willReadFrequently: true });

function setStatus(v){ statusEl.textContent = v; }
function setMode(v){ modeEl.textContent = v; }
function setLock(v){ lockEl.textContent = v; }
function setProgress(v){ progEl.textContent = v; }
function dbg(v){ dbgEl.textContent = String(v); }

const APP_VERSION = window.APP_VERSION || "unknown";
const BUILD_ID = window.BUILD_ID || "unknown";

const LS_LOCK = "progflash.lockPos"; // {x,y}
const LS_ANCHOR_USER = "progflash.userAnchor"; // optional, but we won't rely on it for "automatic"

// Matching thresholds
const MATCH = {
  tolerance: 80,
  step: 2,
  ignoreAlphaBelow: 200,
  minScoreFind: 0.62,     // for initial find
  minScoreVerify: 0.70    // for verifying the saved position quickly
};

// Regions
const VERIFY_PAD = 220;      // capture size around saved lock when verifying
const FIND_TICK_MS = 280;    // scan loop delay
const FIND_STEP_COARSE = 3;  // faster find (coarser sampling)

function loadJSON(key){
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
function saveJSON(key, obj){
  try { localStorage.setItem(key, JSON.stringify(obj)); } catch {}
}
function delKey(key){
  try { localStorage.removeItem(key); } catch {}
}
function clamp(n,a,b){ return Math.max(a, Math.min(b,n)); }

function updateSavedLockLabel(){
  const lp = loadJSON(LS_LOCK);
  savedLockEl.textContent = lp ? `x=${lp.x},y=${lp.y}` : "none";
}

function drawRegionPreview(regionImg, label, matchXY /* {x,y} relative to region */){
  if (!regionImg) return;

  const srcW = regionImg.width, srcH = regionImg.height;

  const imageData = new ImageData(new Uint8ClampedArray(regionImg.data), srcW, srcH);

  const cw = canvas.width, ch = canvas.height;
  const scale = Math.min(cw / srcW, ch / srcH);
  const drawW = Math.floor(srcW * scale);
  const drawH = Math.floor(srcH * scale);
  const offX = Math.floor((cw - drawW) / 2);
  const offY = Math.floor((ch - drawH) / 2);

  ctx.clearRect(0, 0, cw, ch);

  const tmp = document.createElement("canvas");
  tmp.width = srcW; tmp.height = srcH;
  const tctx = tmp.getContext("2d", { willReadFrequently: true });
  tctx.putImageData(imageData, 0, 0);

  ctx.drawImage(tmp, 0, 0, srcW, srcH, offX, offY, drawW, drawH);

  // label box
  ctx.fillStyle = "rgba(0,0,0,0.6)";
  ctx.fillRect(6, 6, Math.min(cw - 12, 240), 20);
  ctx.fillStyle = "white";
  ctx.font = "12px Arial";
  ctx.fillText(label, 12, 21);

  // match overlay
  if (matchXY && anchor) {
    const fx = offX + Math.floor(matchXY.x * scale);
    const fy = offY + Math.floor(matchXY.y * scale);
    const fw = Math.floor(anchor.width * scale);
    const fh = Math.floor(anchor.height * scale);

    ctx.lineWidth = 2;
    ctx.strokeStyle = "deepskyblue";
    ctx.strokeRect(fx, fy, fw, fh);
  }
}

// ---- App state ----
let running = false;
let findLoopHandle = null;

// LOCKED means: we are not scanning
let locked = false;
let lockPos = loadJSON(LS_LOCK); // {x,y}

// Anchor (automatic)
let anchor = null;

async function loadAnchorAutomatic(){
  // For fully automatic, we load a bundled file anchor.
  // (If you want to allow optional user anchors later, you can add fallback logic.)
  const a1 = await loadImage("img/progbar_anchor.png?v=" + encodeURIComponent(BUILD_ID));
  if (a1) return a1;
  const a2 = await loadImage("progbar_anchor.png?v=" + encodeURIComponent(BUILD_ID));
  if (a2) return a2;
  return null;
}

function getRsSize(){
  return { w: alt1.rsWidth || 0, h: alt1.rsHeight || 0 };
}

function captureFullRsRegion(){
  const rs = getRsSize();
  if (!rs.w || !rs.h) return null;
  return captureRegion(0, 0, rs.w, rs.h);
}

function captureVerifyRegionAround(pos){
  const rs = getRsSize();
  if (!rs.w || !rs.h) return null;

  // Create a region centered around the expected lock
  let x = Math.floor(pos.x - VERIFY_PAD);
  let y = Math.floor(pos.y - VERIFY_PAD);
  x = clamp(x, 0, rs.w - 1);
  y = clamp(y, 0, rs.h - 1);

  const w = clamp(VERIFY_PAD * 2, 1, rs.w - x);
  const h = clamp(VERIFY_PAD * 2, 1, rs.h - y);

  return { rect: { x, y, w, h }, img: captureRegion(x, y, w, h) };
}

function runMatchOnRegion(regionImg, step, minScore){
  const res = findAnchor(regionImg, anchor, {
    tolerance: MATCH.tolerance,
    minScore: 0.01,
    step,
    ignoreAlphaBelow: MATCH.ignoreAlphaBelow
  });

  const score = res && typeof res.score === "number" ? res.score : 0;
  const ok = !!(res && res.ok && score >= minScore);

  return { ok, x: res?.x ?? 0, y: res?.y ?? 0, score };
}

// ---- “Stop scanning” lock behavior ----
function setLockedAt(x, y, score){
  locked = true;
  lockPos = { x, y };
  saveJSON(LS_LOCK, lockPos);
  updateSavedLockLabel();

  setStatus("Locked (scanning stopped)");
  setMode("Running");
  setLock(`x=${x}, y=${y}`);
  setProgress("locked");
  dbg(JSON.stringify({
    app: { version: APP_VERSION, build: BUILD_ID },
    locked: true,
    lockPos,
    note: "Scanning stopped until Auto find is pressed."
  }, null, 2));
}

function clearLocked(){
  locked = false;
  lockPos = null;
  delKey(LS_LOCK);
  updateSavedLockLabel();

  setLock("none");
  setProgress("—");
}

// ---- Verify saved lock once (fast) ----
function verifySavedLockOnce(){
  if (!lockPos) return false;

  const cap = captureVerifyRegionAround(lockPos);
  if (!cap || !cap.img) {
    setStatus("Capture failed");
    dbg("captureVerifyRegion(): null\n\n" + JSON.stringify(window.progflashCaptureDiag || {}, null, 2));
    return false;
  }

  // Use normal step here (verify should be accurate)
  const m = runMatchOnRegion(cap.img, MATCH.step, MATCH.minScoreVerify);

  drawRegionPreview(cap.img, "VERIFY (saved lock)", m.ok ? { x: m.x, y: m.y } : null);

  if (!m.ok) {
    dbg(JSON.stringify({
      app: { version: APP_VERSION, build: BUILD_ID },
      verify: { ok: false, bestScore: m.score },
      savedLock: lockPos,
      verifyRect: cap.rect
    }, null, 2));
    return false;
  }

  // Convert to RS coords using verify rect offset
  const foundX = cap.rect.x + m.x;
  const foundY = cap.rect.y + m.y;

  setLockedAt(foundX, foundY, m.score);
  return true;
}

// ---- Auto-find scan loop (only runs until it finds once) ----
function stopFindLoop(){
  if (findLoopHandle) clearTimeout(findLoopHandle);
  findLoopHandle = null;
}

function startFindLoop(){
  stopFindLoop();

  locked = false;
  setStatus("Auto-finding…");
  setMode("Running");
  setLock("none");
  setProgress("—");

  const tick = () => {
    if (!running) return;

    const img = captureFullRsRegion();
    if (!img) {
      setStatus("Capture failed");
      dbg("captureFullRsRegion(): null\n\n" + JSON.stringify(window.progflashCaptureDiag || {}, null, 2));
      findLoopHandle = setTimeout(tick, 500);
      return;
    }

    // Coarse step for speed while scanning full screen
    const m = runMatchOnRegion(img, FIND_STEP_COARSE, MATCH.minScoreFind);

    drawRegionPreview(img, "FIND (full screen)", m.ok ? { x: m.x, y: m.y } : null);

    if (m.ok) {
      // Found it: store absolute lock coordinates and STOP scanning
      setLockedAt(m.x, m.y, m.score);
      stopFindLoop();
      return;
    }

    dbg(JSON.stringify({
      app: { version: APP_VERSION, build: BUILD_ID },
      mode: "FIND",
      res: { ok: false, bestScore: m.score },
      note: "Scanning continues until found once."
    }, null, 2));

    findLoopHandle = setTimeout(tick, FIND_TICK_MS);
  };

  tick();
}

// ---- Public controls ----
async function start(){
  if (!window.alt1) { setStatus("Alt1 missing"); dbg("Open inside Alt1 Toolkit."); return; }
  if (typeof captureRegion !== "function" || typeof findAnchor !== "function") {
    setStatus("Missing matcher.js");
    dbg(JSON.stringify({ captureRegion: typeof captureRegion, findAnchor: typeof findAnchor }, null, 2));
    return;
  }

  if (!anchor) {
    setStatus("Loading anchor…");
    anchor = await loadAnchorAutomatic();
  }
  if (!anchor) {
    setStatus("No anchor file");
    dbg("Missing anchor image. Provide img/progbar_anchor.png or progbar_anchor.png");
    return;
  }

  running = true;
  setMode("Running");

  // If we have a saved lock: verify once and then stop scanning forever.
  if (lockPos && verifySavedLockOnce()) {
    // already locked and stopped scanning
    return;
  }

  // Otherwise auto-find
  startFindLoop();
}

function stop(){
  running = false;
  stopFindLoop();
  locked = false;
  setMode("Not running");
  setStatus("Idle");
  setLock("none");
  setProgress("—");
}

// ---- Buttons ----
testBtn.onclick = () => alert("flash test");
startBtn.onclick = () => start().catch(console.error);
stopBtn.onclick = () => stop();

autoFindBtn.onclick = () => {
  if (!running) {
    // If not running, run start() which will load anchor etc, then find
    start().catch(console.error);
    return;
  }
  // Force re-find
  clearLocked();
  startFindLoop();
};

clearLockBtn.onclick = () => {
  clearLocked();
  setStatus("Saved lock cleared");
  dbg(JSON.stringify({ cleared: true, key: LS_LOCK }, null, 2));
};

// ---- Init ----
(function init(){
  updateSavedLockLabel();
  setStatus("Idle");
  setMode("Not running");
  setLock("none");
  setProgress("—");

  dbg(JSON.stringify({
    app: { version: APP_VERSION, build: BUILD_ID },
    savedLock: lockPos,
    note: "Start will verify saved lock once; if ok, scanning stops."
  }, null, 2));
})();
