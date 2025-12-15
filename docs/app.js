// app.js — Two-stage fully automatic finder (no calibration)
//
// Stage 1: Coarse tiled scan for hourglass_icon (fast locator)
// Stage 2: Local scan for x_corner (reliable lock point)
// When found: save lockPos and STOP scanning.
// Start later: verify saved lock once; if ok stop scanning; else run auto-find.
//
// Requires matcher.js with: loadImage(), captureRegion(), findAnchor()

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
function rgba(r,g,b,a){ return (r&255)|((g&255)<<8)|((b&255)<<16)|((a&255)<<24); }
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

function getRsSize(){
  return { w: alt1.rsWidth || 0, h: alt1.rsHeight || 0 };
}

function captureRect(r){
  const img = captureRegion(r.x, r.y, r.w, r.h);
  return { rect: r, img };
}

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

  ctx.fillStyle = "rgba(0,0,0,0.6)";
  ctx.fillRect(6,6,Math.min(cw-12, 320),20);
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

function findInImage(hay, needle, opts){
  const res = findAnchor(hay, needle, opts);
  const score = res && typeof res.score === "number" ? res.score : 0;
  const ok = !!(res && res.ok && score >= (opts.acceptScore ?? 0));
  return { ok, x: res?.x ?? 0, y: res?.y ?? 0, score };
}

// --- Two-stage parameters ---
const STAGE1 = {
  tileW: 640,
  tileH: 360,
  step: 4,          // a little finer than 5
  tolerance: 105,   // more forgiving for lighting
  minScore: 0.48,   // easier to "seed"
  earlyScore: 0.82
};

const STAGE2 = {
  localW: 900,
  localH: 520,
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

// --- State ---
let running = false;
let loopHandle = null;

let lockPos = loadJSON(LS_LOCK); // {x,y}

let tplHourglass = null; // loaded image needle
let tplXCorner = null;   // loaded image needle

async function loadFirstExisting(paths){
  for (const p of paths) {
    const img = await loadImage(p + (p.includes("?") ? "&" : "?") + "v=" + encodeURIComponent(BUILD_ID));
    if (img) return { path: p, img };
  }
  return null;
}

async function loadTemplates(){
  // Try both root and /img paths
  const hg = await loadFirstExisting([
    "img/hourglass_icon.png",
    "hourglass_icon.png",
    "img/hourglass_crop.png",
    "hourglass_crop.png"
  ]);
  const xc = await loadFirstExisting([
    "img/x_corner.png",
    "x_corner.png"
  ]);

  return { hg, xc };
}

function stopLoop(){
  if (loopHandle) clearTimeout(loopHandle);
  loopHandle = null;
}
function schedule(delayMs, fn){
  stopLoop();
  loopHandle = setTimeout(fn, delayMs);
}

function setLockedAt(x, y, note){
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

  stopLoop();
}

function clearLocked(){
  lockPos = null;
  delKey(LS_LOCK);
  delKey(LS_LOCK_ANCHOR);
  updateSavedLockLabel();
  setLock("none");
  setProgress("—");
}

function cropRGBAFromCapture(img, x, y, w, h){
  // img is a captured RGBA image (captureRegion result)
  const bytes = new Uint8ClampedArray(w * h * 4);
  let idx = 0;
  for (let yy=0; yy<h; yy++){
    for (let xx=0; xx<w; xx++){
      const si = ((y + yy) * img.width + (x + xx)) * 4;
      bytes[idx++] = img.data[si+0];
      bytes[idx++] = img.data[si+1];
      bytes[idx++] = img.data[si+2];
      bytes[idx++] = img.data[si+3];
    }
  }
  return bytes;
}

function saveUserLockAnchorFromXCorner(xCornerAbsX, xCornerAbsY){
  // Capture a stable chunk around the X-corner and store it for faster verifying later.
  // This does NOT require user calibration.
  const rs = getRsSize();
  if (!rs.w || !rs.h) return;

  const dx = 8, dy = 8;              // we capture slightly above/left of x-corner
  const w = 140, h = 90;             // stable-ish corner chunk (avoid bar fill/text)
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

function verifySavedLockOnce(){
  if (!lockPos) return false;
  const rs = getRsSize();
  if (!rs.w || !rs.h) return false;

  const stored = loadJSON(LS_LOCK_ANCHOR);
  const needle = stored
    ? makeNeedleFromRGBA(stored.w, stored.h, base64ToBytes(stored.rgbaBase64))
    : tplXCorner;

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
    ignoreAlphaBelow: 200,
    acceptScore: VERIFY.minScore
  });

  drawRegionPreview(cap.img, stored ? "VERIFY (saved lockAnchor)" : "VERIFY (x_corner)", m.ok ? { x:m.x, y:m.y } : null, needle);

  if (!m.ok) return false;

  // If we matched lockAnchor, convert back to x_corner by adding dx/dy
  const dx = stored?.dx ?? 0;
  const dy = stored?.dy ?? 0;

  const foundX = cap.rect.x + m.x + dx;
  const foundY = cap.rect.y + m.y + dy;

  setLockedAt(foundX, foundY, "Verified saved lock; scanning stopped.");
  return true;
}

// --- Stage 1: tiled scan for hourglass ---
function stage1FindHourglass(){
  const rs = getRsSize();
  if (!rs.w || !rs.h) return null;

  // Scan order: top half first, then bottom half
  const halves = [
    { name: "TOP",    y0: 0,               y1: Math.floor(rs.h / 2) },
    { name: "BOTTOM", y0: Math.floor(rs.h / 2), y1: rs.h }
  ];

  let best = null;

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
          tolerance: STAGE1.tolerance,
          minScore: 0.01,
          step: STAGE1.step,
          ignoreAlphaBelow: 140,          // <-- IMPORTANT: more forgiving on glow/alpha
          acceptScore: STAGE1.minScore
        });

        // Show EXACTLY what we're scanning
        drawRegionPreview(
          cap.img,
          `STAGE1 ${half.name} tile#${tileIndex} (${tx},${ty})`,
          m.ok ? { x:m.x, y:m.y } : null,
          tplHourglass
        );

        if (m.ok) {
          const absX = tx + m.x;
          const absY = ty + m.y;
          best = { absX, absY, score: m.score, half: half.name };

          // Early exit if it's a very strong match
          if (m.score >= STAGE1.earlyScore) return best;
        }
      }
    }

    // If we got any result in top half, prefer it over scanning bottom half
    // (You can remove this if you want best-of-both-halves.)
    if (best && best.half === "TOP") return best;
  }

  return best;
}


// --- Stage 2: local scan for X-corner near stage1 hit ---
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

  const m = findInImage(cap.img, tplXCorner, {
    tolerance: STAGE2.tolerance,
    minScore: 0.01,
    step: STAGE2.step,
    ignoreAlphaBelow: 200,
    acceptScore: STAGE2.minScore
  });

  drawRegionPreview(cap.img, "STAGE2 local (x_corner)", m.ok ? { x:m.x, y:m.y } : null, tplXCorner);

  if (!m.ok) return null;

  const absX = cap.rect.x + m.x;
  const absY = cap.rect.y + m.y;

  // sanity: x-corner should usually be to the right of hourglass seed
  if (absX < seedAbsX) return null;

  return { absX, absY, score: m.score };
}

function runAutoFindOnce(){
  if (!running) return;

  setMode("Running");
  setStatus("Auto-finding (stage 1)…");
  setLock("none");
  setProgress("—");

  schedule(0, () => {
    if (!running) return;

    const s1 = stage1FindHourglass();
    if (!s1) {
  setStatus("Auto-find: not found yet (retrying)...");
  dbg(JSON.stringify({ stage1: "fail", note: "Will retry in 600ms" }, null, 2));
  schedule(600, runAutoFindOnce);
  return;
}


    setStatus(`Stage 1 found (score ${s1.score.toFixed(2)}). Stage 2…`);

    schedule(0, () => {
      if (!running) return;

      const s2 = stage2FindXCornerNear(s1.absX, s1.absY);
      if (!s2) {
        setStatus("Auto-find failed (stage 2)");
        dbg(JSON.stringify({ stage1: s1, stage2: "fail" }, null, 2));
        return;
      }

      // Save lock and also store a user-specific corner chunk for future verify
      saveUserLockAnchorFromXCorner(s2.absX, s2.absY);
      setLockedAt(s2.absX, s2.absY, `Locked via Stage2 x_corner (score ${s2.score.toFixed(2)}).`);
    });
  });
}

async function start(){
  if (!window.alt1) { setStatus("Alt1 missing"); dbg("Open inside Alt1 Toolkit."); return; }
  if (typeof captureRegion !== "function" || typeof findAnchor !== "function" || typeof loadImage !== "function") {
    setStatus("matcher.js not ready");
    dbg(JSON.stringify({ captureRegion: typeof captureRegion, findAnchor: typeof findAnchor, loadImage: typeof loadImage }, null, 2));
    return;
  }

  setMode("Running");
  setStatus("Loading templates…");

  if (!tplHourglass || !tplXCorner) {
    const { hg, xc } = await loadTemplates();
    if (!hg || !xc) {
      setStatus("Template image missing");
      dbg(JSON.stringify({
        error: "Missing templates",
        need: ["hourglass_icon.png (or img/hourglass_icon.png)", "x_corner.png (or img/x_corner.png)"],
        found: { hourglass: hg?.path || null, xcorner: xc?.path || null }
      }, null, 2));
      return;
    }
    tplHourglass = hg.img;
    tplXCorner = xc.img;
  }

  running = true;

  // Verify saved lock once; if ok, stop scanning immediately.
  setStatus("Checking saved lock…");
  if (verifySavedLockOnce()) return;

  // Otherwise auto-find
  runAutoFindOnce();
}

function stop(){
  running = false;
  stopLoop();
  setMode("Not running");
  setStatus("Idle");
  setLock("none");
  setProgress("—");
}

// Buttons
testBtn.onclick = () => alert("flash test");
startBtn.onclick = () => start().catch(console.error);
stopBtn.onclick = () => stop();
autoFindBtn.onclick = () => {
  if (!running) start().catch(console.error);
  else { clearLocked(); runAutoFindOnce(); }
};
clearLockBtn.onclick = () => {
  clearLocked();
  setStatus("Saved lock cleared");
  dbg(JSON.stringify({ cleared: true }, null, 2));
};

// Init
(function init(){
  updateSavedLockLabel();
  setStatus("Idle");
  setMode("Not running");
  setLock("none");
  setProgress("—");
  dbg(JSON.stringify({
    app: { version: APP_VERSION, build: BUILD_ID },
    note: "Start verifies saved lock once; if not found, runs Stage1+Stage2 then stops scanning."
  }, null, 2));
})();
