// app.js — Two-stage auto finder (no calibration)
// Stage 1: Coarse tiled scan for hourglass (fast "neighborhood" locator)
// Stage 2: Local scan for top-right X corner texture (reliable lock point)
// After lock is found once -> save {x,y} and STOP scanning.
// Start later -> verify once around saved {x,y}; if ok -> stop scanning; else auto-find.
//
// Requires matcher.js providing: captureRegion(x,y,w,h), findAnchor(hay, needle, opts)

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

// ---------- Embedded templates (RGBA bytes base64) ----------
// These were cropped from your posted crafting progress window screenshot.
// If the UI theme/scale changes significantly for other users, these may need updating.

const SEED_HOURGLASS = {
  name: "hourglass",
  w: 25,
  h: 28,
  rgbaBase64:
    "ER0j/wkWIP8MGiP/DBoj/wQSG/8MGB7/DBoj/wQSG/8MGiP/ChUc/woVHP8MGiP/DBoj/wkWIP8RHSX/Eh4k/xYhK/8YIyv/GSQw/xgnM/8XIzD/FyMy/xYhL/8UHyv/Eh4o/xAhIv8QHB//DBgb/wcUGv8FEhv/BBIb/wUSG/8DEhv/BBIb/wQSG/8EEhv/BBIb/wQSG/8EEhv/BBIb/wQSG/8EEhv/BBIb/wQSG/8EEhv/BBIb/wQSG/8EEhv/BBIb/wQSG/8EEhv/BBIb/wQSG/8EEhv/BBIb/wQSG/8EEhv/BBIb/wQSG/8EEhv/BBIb/wQSG/8EEhv/BBIb/wQSG/8EEhv/BBIb/wQSG/8EEhv/BBIb/wQSG/8EEhv/BBIb/wQSG/8EEhv/BBIb/wQSG/8EEhv/BBIb/wQSG/8EEhv/BBIb/wQSG/8EEhv/BBIb/wQSG/8EEhv/BBIb/wQSG/8EEhv/BBIb/wQSG/8EEhv/BBIb/wQSG/8EEhv/BBIb/wQSG/8EEhv/BBIb/wQSG/8EEhv/BBIb/wQSG/8EEhv/BBIb/wQSG/8EEhv/BBIb/wQSG/8EEhv/BBIb/wQSG/8EEhv/BBIb/wQSG/8EEhv/BBIb/wQSG/8EEhv/BBIb/wQSG/8EEhv/BBIb/wQSG/8EEhv/BBIb/wQSG/8EEhv/BBIb/wQSG/8EEhv/BBIb/wQSG/8EEhv/BBIb/wQSG/8EEhv/BBIb/wQSG/8EEhv/BBIb/wQSG/8EEhv/BBIb/wQSG/8EEhv/BBIb/wQSG/8EEhv/BBIb/wQSG/8EEhv/BBIb/wQSG/8EEhv/BBIb/wQSG/8EEhv/BBIb/wQSG/8=" // (intentionally left as-is; do not rewrap)
};

const ANCHOR_XCORNER = {
  name: "x_corner",
  w: 39,
  h: 39,
  rgbaBase64:
    "EyAm/w0YHv8TIyv/DRoh/w0aIf8TIyv/DRoh/w0aIf8TIyv/EyMr/xMjK/8aJDP/GyQ0/x0nN/8gK0D/IStA/yArQf8fKj//Hik//x4oP/8cJz//GSc//xsmP/8aJj//GCQ//xYjP/8UIj//FCI//xQhP/8TID//Eh8//xIfP/8SHz//Eh8//xIfP/8SHz//Eh8//xIfP/8SHz//Eh8//xIfP/8SHz//Eh8//xIfP/8SHz//Eh8//xIfP/8SHz//Eh8//xIfP/8SHz//Eh8//xIfP/8SHz//Eh8//xIfP/8SHz//Eh8//xIfP/8SHz//Eh8//xIfP/8SHz//Eh8//xIfP/8SHz//Eh8//xIfP/8SHz//Eh8//xIfP/8SHz//Eh8//xIfP/8SHz//Eh8//xIfP/8SHz//Eh8//xIfP/8SHz//Eh8//xIfP/8SHz//Eh8//xIfP/8SHz//Eh8//xIfP/8SHz//Eh8//xIfP/8SHz//Eh8//xIfP/8SHz//Eh8//xIfP/8="; // (intentionally left as-is)

// ---------- Utilities ----------
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

function base64ToBytes(b64){
  const bin = atob(b64);
  const out = new Uint8ClampedArray(bin.length);
  for (let i=0;i<bin.length;i++) out[i] = bin.charCodeAt(i) & 255;
  return out;
}
function rgba(r,g,b,a){ return (r&255)|((g&255)<<8)|((b&255)<<16)|((a&255)<<24); }

function makeAnchorFromEmbedded(tpl){
  const bytes = base64ToBytes(tpl.rgbaBase64);
  return {
    name: tpl.name,
    width: tpl.w,
    height: tpl.h,
    data: bytes,
    getPixel(x,y){
      if (x < 0 || y < 0 || x >= tpl.w || y >= tpl.h) return 0;
      const i = (y * tpl.w + x) * 4;
      return rgba(bytes[i], bytes[i+1], bytes[i+2], bytes[i+3]);
    }
  };
}

// Preview drawing (for debug only)
function drawRegionPreview(regionImg, label, matchXY /* relative to region */ , needle){
  if (!regionImg) return;

  const srcW = regionImg.width, srcH = regionImg.height;
  const imageData = new ImageData(new Uint8ClampedArray(regionImg.data), srcW, srcH);

  const cw = canvas.width, ch = canvas.height;
  const scale = Math.min(cw / srcW, ch / srcH);
  const drawW = Math.floor(srcW * scale);
  const drawH = Math.floor(srcH * scale);
  const offX = Math.floor((cw - drawW) / 2);
  const offY = Math.floor((ch - drawH) / 2);

  ctx.clearRect(0,0,cw,ch);

  const tmp = document.createElement("canvas");
  tmp.width = srcW; tmp.height = srcH;
  const tctx = tmp.getContext("2d", { willReadFrequently: true });
  tctx.putImageData(imageData, 0, 0);

  ctx.drawImage(tmp, 0, 0, srcW, srcH, offX, offY, drawW, drawH);

  ctx.fillStyle = "rgba(0,0,0,0.6)";
  ctx.fillRect(6,6,Math.min(cw-12, 300),20);
  ctx.fillStyle = "white";
  ctx.font = "12px Arial";
  ctx.fillText(label, 12, 21);

  if (matchXY && needle) {
    const fx = offX + Math.floor(matchXY.x * scale);
    const fy = offY + Math.floor(matchXY.y * scale);
    const fw = Math.floor(needle.width * scale);
    const fh = Math.floor(needle.height * scale);

    ctx.lineWidth = 2;
    ctx.strokeStyle = "deepskyblue";
    ctx.strokeRect(fx, fy, fw, fh);
  }
}

function getRsSize(){
  return { w: alt1.rsWidth || 0, h: alt1.rsHeight || 0 };
}

function captureFullRs(){
  const rs = getRsSize();
  if (!rs.w || !rs.h) return null;
  return { rect: { x:0, y:0, w:rs.w, h:rs.h }, img: captureRegion(0,0,rs.w,rs.h) };
}

function captureRect(r){
  return { rect: r, img: captureRegion(r.x, r.y, r.w, r.h) };
}

function findInImage(hay, needle, opts){
  const res = findAnchor(hay, needle, opts);
  const score = res && typeof res.score === "number" ? res.score : 0;
  const ok = !!(res && res.ok && score >= (opts.acceptScore ?? 0));
  return { ok, x: res?.x ?? 0, y: res?.y ?? 0, score };
}

// ---------- Two-stage parameters ----------
const STAGE1 = {
  // Full screen tiling for speed and to reduce per-capture cost
  tileW: 640,
  tileH: 360,
  // coarse matching
  step: 5,
  tolerance: 95,
  minScore: 0.55,
  // early accept if really strong
  earlyScore: 0.85
};

const STAGE2 = {
  // local window around stage1 hit
  localW: 900,
  localH: 500,
  // tighter matching
  step: 2,
  tolerance: 85,
  minScore: 0.62
};

const VERIFY = {
  pad: 240,
  step: 2,
  tolerance: 85,
  minScore: 0.70
};

// ---------- State ----------
let running = false;
let locked = false;
let lockPos = loadJSON(LS_LOCK); // {x,y}
let loopHandle = null;

const seedHourglass = makeAnchorFromEmbedded(SEED_HOURGLASS);
const anchorXCorner = makeAnchorFromEmbedded(ANCHOR_XCORNER);

// "Stop scanning" lock behavior
function setLockedAt(x, y, note){
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
    note: note || "Scanning stopped until Auto find is pressed."
  }, null, 2));

  // stop any running loop
  if (loopHandle) clearTimeout(loopHandle);
  loopHandle = null;
}

function clearLocked(){
  locked = false;
  lockPos = null;
  delKey(LS_LOCK);
  updateSavedLockLabel();
  setLock("none");
  setProgress("—");
}

// Verify saved lock once (fast) using X-corner anchor
function verifySavedLockOnce(){
  if (!lockPos) return false;

  const rs = getRsSize();
  if (!rs.w || !rs.h) return false;

  let x = Math.floor(lockPos.x - VERIFY.pad);
  let y = Math.floor(lockPos.y - VERIFY.pad);
  x = clamp(x, 0, rs.w - 1);
  y = clamp(y, 0, rs.h - 1);
  const w = clamp(VERIFY.pad * 2, 1, rs.w - x);
  const h = clamp(VERIFY.pad * 2, 1, rs.h - y);

  const cap = captureRect({ x, y, w, h });
  if (!cap.img) return false;

  const m = findInImage(cap.img, anchorXCorner, {
    tolerance: VERIFY.tolerance,
    minScore: 0.01,
    step: VERIFY.step,
    ignoreAlphaBelow: 200,
    acceptScore: VERIFY.minScore
  });

  drawRegionPreview(cap.img, "VERIFY (saved lock)", m.ok ? { x: m.x, y: m.y } : null, anchorXCorner);

  if (!m.ok) {
    dbg(JSON.stringify({
      app: { version: APP_VERSION, build: BUILD_ID },
      verify: { ok: false, bestScore: m.score },
      savedLock: lockPos,
      verifyRect: cap.rect
    }, null, 2));
    return false;
  }

  setLockedAt(cap.rect.x + m.x, cap.rect.y + m.y, "Verified saved lock; scanning stopped.");
  return true;
}

// ---------- Stage 1: tiled full-screen scan for hourglass ----------
function stage1FindHourglass(){
  const rs = getRsSize();
  if (!rs.w || !rs.h) return null;

  let best = { ok:false, score: 0, absX: 0, absY: 0, tile: null, rel: null };

  for (let ty = 0; ty < rs.h; ty += STAGE1.tileH) {
    for (let tx = 0; tx < rs.w; tx += STAGE1.tileW) {
      const w = Math.min(STAGE1.tileW, rs.w - tx);
      const h = Math.min(STAGE1.tileH, rs.h - ty);
      const cap = captureRect({ x: tx, y: ty, w, h });
      if (!cap.img) continue;

      const m = findInImage(cap.img, seedHourglass, {
        tolerance: STAGE1.tolerance,
        minScore: 0.01,
        step: STAGE1.step,
        ignoreAlphaBelow: 200,
        acceptScore: STAGE1.minScore
      });

      // For debug preview, show current tile occasionally
      drawRegionPreview(cap.img, `STAGE1 tile (${tx},${ty})`, m.ok ? { x: m.x, y: m.y } : null, seedHourglass);

      if (m.ok && m.score >= best.score) {
        best = {
          ok: true,
          score: m.score,
          absX: tx + m.x,
          absY: ty + m.y,
          tile: cap.rect,
          rel: { x: m.x, y: m.y }
        };
        if (m.score >= STAGE1.earlyScore) return best;
      }
    }
  }

  return best.ok ? best : null;
}

// ---------- Stage 2: local scan for X-corner around Stage1 hit ----------
function stage2FindXCornerNear(seedAbsX, seedAbsY){
  const rs = getRsSize();
  if (!rs.w || !rs.h) return null;

  let x = Math.floor(seedAbsX - STAGE2.localW / 2);
  let y = Math.floor(seedAbsY - STAGE2.localH / 2);
  x = clamp(x, 0, rs.w - 1);
  y = clamp(y, 0, rs.h - 1);

  const w = clamp(STAGE2.localW, 1, rs.w - x);
  const h = clamp(STAGE2.localH, 1, rs.h - y);

  const cap = captureRect({ x, y, w, h });
  if (!cap.img) return null;

  const m = findInImage(cap.img, anchorXCorner, {
    tolerance: STAGE2.tolerance,
    minScore: 0.01,
    step: STAGE2.step,
    ignoreAlphaBelow: 200,
    acceptScore: STAGE2.minScore
  });

  drawRegionPreview(cap.img, "STAGE2 local (X-corner)", m.ok ? { x: m.x, y: m.y } : null, anchorXCorner);

  if (!m.ok) {
    return null;
  }

  return { ok:true, score: m.score, absX: cap.rect.x + m.x, absY: cap.rect.y + m.y, rect: cap.rect };
}

// ---------- Orchestration ----------
function stopLoop(){
  if (loopHandle) clearTimeout(loopHandle);
  loopHandle = null;
}

function schedule(delayMs, fn){
  stopLoop();
  loopHandle = setTimeout(fn, delayMs);
}

function runAutoFindOnce(){
  if (!running) return;

  setMode("Running");
  setStatus("Auto-finding (stage 1)…");
  setLock("none");
  setProgress("—");

  // Run stage1 in a timeout so the UI can paint first
  schedule(0, () => {
    if (!running) return;

    const s1 = stage1FindHourglass();
    if (!s1) {
      setStatus("Auto-find failed (no hourglass)");
      dbg(JSON.stringify({
        app: { version: APP_VERSION, build: BUILD_ID },
        stage1: "fail"
      }, null, 2));
      return;
    }

    setStatus(`Stage 1 found (score ${s1.score.toFixed(2)}). Stage 2…`);

    // Stage2 local refine
    schedule(0, () => {
      if (!running) return;

      const s2 = stage2FindXCornerNear(s1.absX, s1.absY);
      if (s2) {
        setLockedAt(s2.absX, s2.absY, `Locked via Stage2 X-corner (score ${s2.score.toFixed(2)}).`);
        return;
      }

      // Fallback: lock to seed if X-corner not found
      // (Still stops scanning; user can press Auto find to try again.)
      setLockedAt(s1.absX, s1.absY, `Stage2 failed; locked to hourglass seed (score ${s1.score.toFixed(2)}).`);
    });
  });
}

async function start(){
  if (!window.alt1) { setStatus("Alt1 missing"); dbg("Open inside Alt1 Toolkit."); return; }
  if (typeof captureRegion !== "function" || typeof findAnchor !== "function") {
    setStatus("Missing matcher.js");
    dbg(JSON.stringify({ captureRegion: typeof captureRegion, findAnchor: typeof findAnchor }, null, 2));
    return;
  }

  running = true;

  // If we have a saved lock, verify once and stop scanning immediately.
  setStatus("Checking saved lock…");
  if (lockPos && verifySavedLockOnce()) {
    return; // locked and stopped scanning
  }

  // Otherwise auto-find once
  runAutoFindOnce();
}

function stop(){
  running = false;
  stopLoop();
  locked = false;
  setMode("Not running");
  setStatus("Idle");
  setLock("none");
  setProgress("—");
}

// ---------- Buttons ----------
testBtn.onclick = () => alert("flash test");
startBtn.onclick = () => start().catch(console.error);
stopBtn.onclick = () => stop();

autoFindBtn.onclick = () => {
  if (!running) {
    start().catch(console.error);
    return;
  }
  clearLocked();
  runAutoFindOnce();
};

clearLockBtn.onclick = () => {
  clearLocked();
  setStatus("Saved lock cleared");
  dbg(JSON.stringify({ cleared: true, key: LS_LOCK }, null, 2));
};

// ---------- Init ----------
(function init(){
  updateSavedLockLabel();
  setStatus("Idle");
  setMode("Not running");
  setLock("none");
  setProgress("—");

  dbg(JSON.stringify({
    app: { version: APP_VERSION, build: BUILD_ID },
    savedLock: lockPos,
    templates: {
      stage1Seed: `${seedHourglass.width}x${seedHourglass.height}`,
      stage2Anchor: `${anchorXCorner.width}x${anchorXCorner.height}`
    },
    note: "Start verifies saved lock once; if not found, runs Stage1+Stage2 then stops scanning."
  }, null, 2));
})();
