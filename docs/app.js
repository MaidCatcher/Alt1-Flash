// ProgFlash app.js — Auto-find once, save lock, stop scanning.
// Stage1: scan for X-corner template (top half first, then bottom).
// Optional fallback Stage1b: scan for hourglass seed (if provided) then try X-corner locally.
// After first lock: save lockPos + a user-captured lockAnchor chunk for fast verify on next Start.
// No calibration required.

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
const BUILD_ID = window.BUILD_ID || ("build-" + Date.now());

const LS_LOCK = "progflash.lockPos";           // {x,y}
const LS_LOCK_ANCHOR = "progflash.lockAnchor"; // {w,h,rgbaBase64,dx,dy}

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

function getRsSize(){
  return { w: alt1.rsWidth || 0, h: alt1.rsHeight || 0 };
}

// --- Template handling (important) ---
function forceOpaque(img){
  // If template PNG has alpha/transparent background, matcher may skip pixels.
  if (!img || !img.data) return img;
  for (let i = 0; i < img.data.length; i += 4) img.data[i + 3] = 255;
  return img;
}

function alphaStats(img){
  if (!img || !img.data) return null;
  let minA = 255, maxA = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    const a = img.data[i + 3];
    if (a < minA) minA = a;
    if (a > maxA) maxA = a;
  }
  return { minA, maxA, w: img.width, h: img.height };
}

// base64 helpers for saving lockAnchor
function bytesToBase64(bytes){
  let s = "";
  for (let i=0;i<bytes.length;i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function base64ToBytes(b64){
  const bin = atob(b64);
  const out = new Uint8ClampedArray(bin.length);
  for (let i=0;i<bin.length;i++) out[i] = bin.charCodeAt(i) & 255;
  return out;
}
function rgba(r,g,b,a){ return (r&255) | ((g&255)<<8) | ((b&255)<<16) | ((a&255)<<24); }
function makeNeedleFromRGBA(w,h,bytes){
  return {
    width: w,
    height: h,
    data: bytes,
    getPixel(x,y){
      if (x < 0 || y < 0 || x >= w || y >= h) return 0;
      const i = (y*w + x) * 4;
      return rgba(bytes[i], bytes[i+1], bytes[i+2], bytes[i+3]);
    }
  };
}

// --- Preview drawing ---
function drawRegionPreview(regionImg, label, matchXY, needle){
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

  // label
  ctx.fillStyle = "rgba(0,0,0,0.6)";
  ctx.fillRect(6,6,Math.min(cw-12, 420),20);
  ctx.fillStyle = "white";
  ctx.font = "12px Arial";
  ctx.fillText(label, 12, 21);

  // match box
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

// --- Matching helpers ---
function findInImage(hay, needle, opts){
  const res = findAnchor(hay, needle, opts);
  const score = res && typeof res.score === "number" ? res.score : 0;
  const ok = !!(res && res.ok && score >= (opts.acceptScore ?? 0));
  return { ok, x: res?.x ?? 0, y: res?.y ?? 0, score };
}

function captureRect(r){
  const img = captureRegion(r.x, r.y, r.w, r.h);
  return { rect: r, img };
}

// --- Finder tuning ---
// Stage1 uses templates only as a locator: tile scan, top then bottom.
// Stage2 optional fallback: if hourglass seed hits, scan locally for x_corner.
const STAGE1 = {
  tileW: 640,
  tileH: 360,
  step: 4,
  tolerance: 95,
  minAccept: 0.52,      // accept match to lock
  earlyScore: 0.85      // early return
};

const STAGE2 = {
  localW: 900,
  localH: 520,
  step: 2,
  tolerance: 90,
  minAccept: 0.60
};

const VERIFY = {
  pad: 240,
  step: 2,
  tolerance: 90,
  minAccept: 0.70
};

// --- State ---
let running = false;
let loopHandle = null;

let lockPos = loadJSON(LS_LOCK); // {x,y}

let tplXCorner = null;
let tplHourglass = null; // optional

function stopLoop(){
  if (loopHandle) clearTimeout(loopHandle);
  loopHandle = null;
}
function schedule(ms, fn){
  stopLoop();
  loopHandle = setTimeout(fn, ms);
}

// --- Template loader ---
async function loadFirstExisting(paths){
  for (const p of paths) {
    const img = await loadImage(p + (p.includes("?") ? "&" : "?") + "v=" + encodeURIComponent(BUILD_ID));
    if (img) return { path: p, img };
  }
  return null;
}

async function loadTemplates(){
  // Required: x_corner
  const xc = await loadFirstExisting([
    "img/x_corner.png",
    "x_corner.png"
  ]);

  // Optional: hourglass seed (fallback only)
  const hg = await loadFirstExisting([
    "img/hourglass_crop.png",
    "hourglass_crop.png",
    "img/hourglass_icon.png",
    "hourglass_icon.png"
  ]);

  return { xc, hg };
}

// --- Lock + saved anchor chunk ---
function cropRGBAFromCapture(img, x, y, w, h){
  const bytes = new Uint8ClampedArray(w*h*4);
  let idx = 0;
  for (let yy=0; yy<h; yy++){
    for (let xx=0; xx<w; xx++){
      const si = ((y+yy) * img.width + (x+xx)) * 4;
      bytes[idx++] = img.data[si+0];
      bytes[idx++] = img.data[si+1];
      bytes[idx++] = img.data[si+2];
      bytes[idx++] = img.data[si+3];
    }
  }
  return bytes;
}

function saveUserLockAnchorFromXCorner(xCornerAbsX, xCornerAbsY){
  // Capture a stable-ish chunk around the x-corner.
  // This becomes the verify template next time, tailored to THIS user pixels.
  const rs = getRsSize();
  if (!rs.w || !rs.h) return;

  const dx = 8, dy = 8;   // capture starts slightly above/left of x-corner
  const w = 150, h = 100; // chunk size
  let ax = xCornerAbsX - dx;
  let ay = xCornerAbsY - dy;
  ax = clamp(ax, 0, rs.w - 1);
  ay = clamp(ay, 0, rs.h - 1);
  const aw = clamp(w, 1, rs.w - ax);
  const ah = clamp(h, 1, rs.h - ay);

  const cap = captureRect({ x: ax, y: ay, w: aw, h: ah });
  if (!cap.img) return;

  const bytes = cropRGBAFromCapture(cap.img, 0, 0, aw, ah);
  saveJSON(LS_LOCK_ANCHOR, { w: aw, h: ah, rgbaBase64: bytesToBase64(bytes), dx, dy });
}

function setLockedAt(x, y, note){
  lockPos = { x, y };
  saveJSON(LS_LOCK, lockPos);
  updateSavedLockLabel();

  running = true;

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

  stopLoop();
}

// --- Verify saved lock on Start ---
function verifySavedLockOnce(){
  if (!lockPos) return false;
  const rs = getRsSize();
  if (!rs.w || !rs.h) return false;

  const stored = loadJSON(LS_LOCK_ANCHOR);
  const needle = stored
    ? makeNeedleFromRGBA(stored.w, stored.h, base64ToBytes(stored.rgbaBase64))
    : tplXCorner;

  if (!needle) return false;

  const pad = VERIFY.pad;

  let rx = Math.floor(lockPos.x - pad);
  let ry = Math.floor(lockPos.y - pad);
  rx = clamp(rx, 0, rs.w - 1);
  ry = clamp(ry, 0, rs.h - 1);
  const rw = clamp(pad * 2, 1, rs.w - rx);
  const rh = clamp(pad * 2, 1, rs.h - ry);

  const cap = captureRect({ x: rx, y: ry, w: rw, h: rh });
  if (!cap.img) return false;

  const m = findInImage(cap.img, needle, {
    tolerance: VERIFY.tolerance,
    minScore: 0.01,
    step: VERIFY.step,
    ignoreAlphaBelow: 0,
    acceptScore: VERIFY.minAccept
  });

  drawRegionPreview(cap.img, stored ? "VERIFY (saved lockAnchor)" : "VERIFY (x_corner)", m.ok ? { x:m.x, y:m.y } : null, needle);

  if (!m.ok) return false;

  const dx = stored?.dx ?? 0;
  const dy = stored?.dy ?? 0;

  const foundX = cap.rect.x + m.x + dx;
  const foundY = cap.rect.y + m.y + dy;

  setLockedAt(foundX, foundY, "Verified saved lock; scanning stopped.");
  return true;
}

// --- Stage1: find X-corner (top half first) ---
function stage1FindXCorner(){
  const rs = getRsSize();
  if (!rs.w || !rs.h || !tplXCorner) return null;

  const halves = [
    { name: "TOP",    y0: 0,                y1: Math.floor(rs.h / 2) },
    { name: "BOTTOM", y0: Math.floor(rs.h / 2), y1: rs.h }
  ];

  let best = { score: 0, absX: 0, absY: 0, half: "TOP" };

  for (const half of halves) {
    let tileIndex = 0;

    for (let ty = half.y0; ty < half.y1; ty += STAGE1.tileH) {
      for (let tx = 0; tx < rs.w; tx += STAGE1.tileW) {
        tileIndex++;

        const w = Math.min(STAGE1.tileW, rs.w - tx);
        const h = Math.min(STAGE1.tileH, half.y1 - ty);

        const cap = captureRect({ x: tx, y: ty, w, h });
        if (!cap.img) continue;

        const m = findInImage(cap.img, tplXCorner, {
          tolerance: STAGE1.tolerance,
          minScore: 0.01,
          step: STAGE1.step,
          ignoreAlphaBelow: 0,
          acceptScore: 0
        });

        drawRegionPreview(
          cap.img,
          `STAGE1 ${half.name} tile#${tileIndex} (${tx},${ty}) best=${best.score.toFixed(2)} cur=${m.score.toFixed(2)}`,
          m.ok ? { x:m.x, y:m.y } : null,
          tplXCorner
        );

        if (m.score > best.score) {
          best = { score: m.score, absX: tx + m.x, absY: ty + m.y, half: half.name };
          if (best.score >= STAGE1.earlyScore) return best;
        }
      }
    }

    // prefer top if already acceptable
    if (best.half === "TOP" && best.score >= STAGE1.minAccept) return best;
  }

  return best.score >= STAGE1.minAccept ? best : null;
}

// --- Optional fallback: hourglass seed -> local X-corner ---
function stage1FindHourglass(){
  if (!tplHourglass) return null;

  const rs = getRsSize();
  if (!rs.w || !rs.h) return null;

  const halves = [
    { name: "TOP",    y0: 0,                y1: Math.floor(rs.h / 2) },
    { name: "BOTTOM", y0: Math.floor(rs.h / 2), y1: rs.h }
  ];

  // very forgiving; just a seed
  const seedMin = 0.30;

  let best = { score: 0, absX: 0, absY: 0, half: "TOP" };

  for (const half of halves) {
    let tileIndex = 0;

    for (let ty = half.y0; ty < half.y1; ty += STAGE1.tileH) {
      for (let tx = 0; tx < rs.w; tx += STAGE1.tileW) {
        tileIndex++;

        const w = Math.min(STAGE1.tileW, rs.w - tx);
        const h = Math.min(STAGE1.tileH, half.y1 - ty);

        const cap = captureRect({ x: tx, y: ty, w, h });
        if (!cap.img) continue;

        const m = findInImage(cap.img, tplHourglass, {
          tolerance: 120,
          minScore: 0.01,
          step: 4,
          ignoreAlphaBelow: 0,
          acceptScore: 0
        });

        drawRegionPreview(
          cap.img,
          `SEED ${half.name} tile#${tileIndex} (${tx},${ty}) best=${best.score.toFixed(2)} cur=${m.score.toFixed(2)}`,
          m.ok ? { x:m.x, y:m.y } : null,
          tplHourglass
        );

        if (m.score > best.score) {
          best = { score: m.score, absX: tx + m.x, absY: ty + m.y, half: half.name };
        }
      }
    }

    if (best.half === "TOP" && best.score >= seedMin) return best;
  }

  return best.score >= seedMin ? best : null;
}

function stage2FindXCornerNear(seedAbsX, seedAbsY){
  const rs = getRsSize();
  if (!rs.w || !rs.h || !tplXCorner) return null;

  let x = Math.floor(seedAbsX - STAGE2.localW / 2);
  let y = Math.floor(seedAbsY - STAGE2.localH / 2);
  x = clamp(x, 0, rs.w - 1);
  y = clamp(y, 0, rs.h - 1);

  const w = clamp(STAGE2.localW, 1, rs.w - x);
  const h = clamp(STAGE2.localH, 1, rs.h - y);

  const cap = captureRect({ x, y, w, h });
  if (!cap.img) return null;

  const m = findInImage(cap.img, tplXCorner, {
    tolerance: STAGE2.tolerance,
    minScore: 0.01,
    step: STAGE2.step,
    ignoreAlphaBelow: 0,
    acceptScore: STAGE2.minAccept
  });

  drawRegionPreview(cap.img, "STAGE2 local (x_corner)", m.ok ? { x:m.x, y:m.y } : null, tplXCorner);

  if (!m.ok) return null;

  return { absX: cap.rect.x + m.x, absY: cap.rect.y + m.y, score: m.score };
}

// --- Main auto-find loop ---
function runAutoFindOnce(){
  if (!running) return;

  setMode("Running");
  setStatus("Auto-finding (stage 1)…");
  setLock("none");
  setProgress("—");

  schedule(0, () => {
    if (!running) return;

    // Primary: direct x_corner scan (best universal option)
    const s1 = stage1FindXCorner();
    if (s1) {
      saveUserLockAnchorFromXCorner(s1.absX, s1.absY);
      setLockedAt(s1.absX, s1.absY, `Locked via X-corner (score ${s1.score.toFixed(2)}).`);
      return;
    }

    // Optional fallback: if hourglass exists, seed then local refine
    const seed = stage1FindHourglass();
    if (seed) {
      setStatus(`Seed found (score ${seed.score.toFixed(2)}). Refining…`);
      const s2 = stage2FindXCornerNear(seed.absX, seed.absY);
      if (s2) {
        saveUserLockAnchorFromXCorner(s2.absX, s2.absY);
        setLockedAt(s2.absX, s2.absY, `Locked via seed→x_corner (score ${s2.score.toFixed(2)}).`);
        return;
      }
    }

    setStatus("Auto-find: not found yet (retrying)...");
    dbg(JSON.stringify({ stage1: "fail", note: "Will retry in 600ms" }, null, 2));
    schedule(600, runAutoFindOnce);
  });
}

// --- Controls ---
async function start(){
  if (!window.alt1) { setStatus("Alt1 missing"); dbg("Open inside Alt1 Toolkit."); return; }
  if (!alt1.permissionPixel) { setStatus("No pixel permission"); dbg("Enable Alt1 pixel permission."); return; }
  if (typeof captureRegion !== "function" || typeof findAnchor !== "function" || typeof loadImage !== "function") {
    setStatus("matcher.js not ready");
    dbg(JSON.stringify({ captureRegion: typeof captureRegion, findAnchor: typeof findAnchor, loadImage: typeof loadImage }, null, 2));
    return;
  }

  running = true;
  locked = false;

  setMode("Running");
  setStatus("Loading templates…");

  if (!tplXCorner) {
    const { xc, hg } = await loadTemplates();
    if (!xc) {
      setStatus("Missing x_corner.png");
      dbg(JSON.stringify({
        error: "Template missing",
        need: ["img/x_corner.png (required)"],
        optional: ["img/hourglass_crop.png or img/hourglass_icon.png (optional seed)"]
      }, null, 2));
      running = false;
      setMode("Not running");
      return;
    }
    tplXCorner = forceOpaque(xc.img);
    tplHourglass = hg ? forceOpaque(hg.img) : null;

    // safe debug output (no null crash)
    dbg(JSON.stringify({
      app: { version: APP_VERSION, build: BUILD_ID },
      templates: {
        xcorner: alphaStats(tplXCorner),
        hourglass: tplHourglass ? alphaStats(tplHourglass) : null
      },
      note: "Templates loaded"
    }, null, 2));
  }

  // If we have a saved lock, verify once and stop scanning immediately.
  setStatus("Checking saved lock…");
  if (lockPos && verifySavedLockOnce()) return;

  // Otherwise auto-find
  runAutoFindOnce();
}

function stop(){
  running = false;
  locked = false;
  stopLoop();
  setMode("Not running");
  setStatus("Idle");
  setLock("none");
  setProgress("—");
}

function clearLock(){
  lockPos = null;
  locked = false;
  delKey(LS_LOCK);
  delKey(LS_LOCK_ANCHOR);
  updateSavedLockLabel();
  setLock("none");
  setProgress("—");
  setStatus("Saved lock cleared");
}

// Buttons
startBtn.onclick = () => start().catch(e => dbg(String(e)));
stopBtn.onclick = () => stop();
autoFindBtn.onclick = () => { clearLock(); start().catch(e => dbg(String(e))); };
clearLockBtn.onclick = () => clearLock();
testBtn.onclick = () => alert("flash test");

// Init
(function init(){
  updateSavedLockLabel();
  setStatus("Idle");
  setMode("Not running");
  setLock("none");
  setProgress("—");

  dbg(JSON.stringify({
    app: { version: APP_VERSION, build: BUILD_ID },
    savedLock: lockPos,
    note: "Start verifies saved lock once; if not found, auto-find runs until progress window appears, then stops scanning."
  }, null, 2));
})();
