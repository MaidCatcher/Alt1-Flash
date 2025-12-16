// ProgFlash app.js — Pivot to adaptive anchor learning (no shipped templates)
//
// Goal:
// - Fully automatic: detect progress window by heuristics (CANCEL orange + red X corner)
// - Learn a user-specific anchor patch once and store it
// - After locked once: stop scanning
// - Start later: verify saved anchor once; if ok stop; else re-find
//
// Requires matcher.js exports: captureRegion(), findAnchor()
// (We use findAnchor only for verification against the learned patch)

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

const LS_LOCK = "progflash.lockPos";            // {x,y}
const LS_ANCHOR = "progflash.learnedAnchor";    // {w,h,rgbaBase64,dx,dy} dx/dy is where x-corner sits within anchor
const LS_NOTE = "progflash.note";

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

function captureRect(r){
  const img = captureRegion(r.x, r.y, r.w, r.h);
  return { rect: r, img };
}

// --- Preview drawing ---
function drawRegionPreview(regionImg, label, box){
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
  ctx.fillRect(6,6,Math.min(cw-12, 520),20);
  ctx.fillStyle = "white";
  ctx.font = "12px Arial";
  ctx.fillText(label, 12, 21);

  if (box) {
    const fx = offX + Math.floor(box.x * scale);
    const fy = offY + Math.floor(box.y * scale);
    const fw = Math.floor(box.w * scale);
    const fh = Math.floor(box.h * scale);
    ctx.lineWidth = 2;
    ctx.strokeStyle = box.color || "deepskyblue";
    ctx.strokeRect(fx, fy, fw, fh);
  }
}

// --- Learned anchor representation for findAnchor() ---
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
function cropRGBA(img, x, y, w, h){
  const out = new Uint8ClampedArray(w*h*4);
  let k = 0;
  for (let yy=0; yy<h; yy++){
    for (let xx=0; xx<w; xx++){
      const si = ((y+yy) * img.width + (x+xx)) * 4;
      out[k++] = img.data[si+0];
      out[k++] = img.data[si+1];
      out[k++] = img.data[si+2];
      out[k++] = img.data[si+3];
    }
  }
  // Force opaque so matcher never skips pixels due to alpha
  for (let i=0;i<out.length;i+=4) out[i+3] = 255;
  return out;
}

// --- Loop control ---
let running = false;
let loopHandle = null;

function stopLoop(){
  if (loopHandle) clearTimeout(loopHandle);
  loopHandle = null;
}
function schedule(ms, fn){
  stopLoop();
  loopHandle = setTimeout(fn, ms);
}

// ============================================================
// Heuristic Finder (no templates)
// ============================================================

// Color tests (tuned for RS UI style; forgiving)
function isOrangeCancel(r,g,b){
  // orange-ish / amber
  return (r >= 150 && r <= 255) && (g >= 70 && g <= 170) && (b >= 0 && b <= 120) && (r > g) && (g > b);
}
function isRedX(r,g,b){
  // red-ish (X icon)
  return (r >= 170) && (g <= 120) && (b <= 120) && (r > g + 40) && (r > b + 40);
}

// Downsample scan for orange density
function findCancelCandidate(fullImg){
  const rsW = fullImg.width, rsH = fullImg.height;

  // Prefer top half first
  const halves = [
    { name: "TOP", y0: 0, y1: Math.floor(rsH/2) },
    { name: "BOTTOM", y0: Math.floor(rsH/2), y1: rsH }
  ];

  // Step controls speed vs detection
  const step = 6; // sampling stride
  // Window size for scanning the CANCEL button region (approx)
  const winW = 180;
  const winH = 70;

  let best = { score: 0, x: 0, y: 0, half: "TOP" };

  // We score a window by counting orange hits in that area
  // To keep it simple/fast, we do sparse sampling inside each window.
  const innerStep = 6;

  for (const half of halves) {
    for (let y = half.y0; y < half.y1 - winH; y += winH) {
      for (let x = 0; x < rsW - winW; x += winW) {

        let hits = 0;
        let total = 0;

        for (let yy = 0; yy < winH; yy += innerStep) {
          const py = y + yy;
          for (let xx = 0; xx < winW; xx += innerStep) {
            const px = x + xx;
            const i = (py * rsW + px) * 4;
            const r = fullImg.data[i], g = fullImg.data[i+1], b = fullImg.data[i+2];
            total++;
            if (isOrangeCancel(r,g,b)) hits++;
          }
        }

        const score = total ? (hits / total) : 0;
        if (score > best.score) best = { score, x, y, half: half.name };
      }
    }

    // if top is decent, don’t bother bottom
    if (best.half === "TOP" && best.score >= 0.06) break;
  }

  // Threshold: needs some orange concentration
  if (best.score < 0.04) return null;

  return {
    half: best.half,
    // center-ish of the window we scored
    cx: best.x + Math.floor(winW/2),
    cy: best.y + Math.floor(winH/2),
    score: best.score,
    box: { x: best.x, y: best.y, w: winW, h: winH }
  };
}

// Given a cancel candidate, search nearby for red X corner
function findRedXNear(fullImg, seed){
  const rsW = fullImg.width, rsH = fullImg.height;

  // Search region above and to the right of the cancel area (progress window top-right)
  const rx = clamp(seed.cx - 250, 0, rsW-1);
  const ry = clamp(seed.cy - 260, 0, rsH-1);
  const rw = clamp(520, 1, rsW - rx);
  const rh = clamp(320, 1, rsH - ry);

  // Find the topmost-rightmost red-ish pixel cluster
  // We’ll pick the best candidate with a small neighborhood density.
  const step = 2;

  let best = null;

  for (let y = 0; y < rh; y += step) {
    for (let x = 0; x < rw; x += step) {
      const i = ((ry + y) * rsW + (rx + x)) * 4;
      const r = fullImg.data[i], g = fullImg.data[i+1], b = fullImg.data[i+2];

      if (!isRedX(r,g,b)) continue;

      // neighborhood density check (avoid random red particles)
      let redHits = 0;
      let n = 0;
      for (let yy = -6; yy <= 6; yy += 2) {
        const py = y + yy;
        if (py < 0 || py >= rh) continue;
        for (let xx = -6; xx <= 6; xx += 2) {
          const px = x + xx;
          if (px < 0 || px >= rw) continue;
          const ii = ((ry + py) * rsW + (rx + px)) * 4;
          const rr = fullImg.data[ii], gg = fullImg.data[ii+1], bb = fullImg.data[ii+2];
          n++;
          if (isRedX(rr,gg,bb)) redHits++;
        }
      }

      const density = n ? (redHits / n) : 0;
      if (density < 0.25) continue;

      const cand = { x: rx + x, y: ry + y, density };

      // Prefer smaller y (top) and larger x (right)
      if (!best) best = cand;
      else {
        if (cand.y < best.y - 3) best = cand;
        else if (Math.abs(cand.y - best.y) <= 3 && cand.x > best.x) best = cand;
        else if (cand.density > best.density + 0.10) best = cand;
      }
    }
  }

  if (!best) return null;

  return {
    x: best.x,
    y: best.y,
    density: best.density,
    searchBox: { x: rx, y: ry, w: rw, h: rh }
  };
}

// Learn and save anchor patch around the x-corner
function learnAnchorAt(fullImg, xCorner){
  const rsW = fullImg.width, rsH = fullImg.height;

  // Anchor patch size: big enough to be unique, small enough to verify fast
  const aw = 220;
  const ah = 140;

  // Place x-corner near the top-right of anchor patch but include some left/below texture
  const dx = 200; // xCorner is dx pixels from anchor left
  const dy = 18;  // yCorner is dy pixels from anchor top

  let ax = clamp(xCorner.x - dx, 0, rsW-1);
  let ay = clamp(xCorner.y - dy, 0, rsH-1);
  const w = clamp(aw, 1, rsW - ax);
  const h = clamp(ah, 1, rsH - ay);

  const bytes = cropRGBA(fullImg, ax, ay, w, h);

  saveJSON(LS_ANCHOR, {
    w, h,
    rgbaBase64: bytesToBase64(bytes),
    dx, dy
  });

  return { ax, ay, w, h, dx, dy };
}

// ============================================================
// Lock / Verify flow
// ============================================================

function setLockedAt(x, y, note){
  saveJSON(LS_LOCK, { x, y });
  updateSavedLockLabel();

  setStatus("Locked (scanning stopped)");
  setMode("Running");
  setLock(`x=${x}, y=${y}`);
  setProgress("locked");

  dbg(JSON.stringify({
    app: { version: APP_VERSION, build: BUILD_ID },
    locked: true,
    lockPos: { x, y },
    note
  }, null, 2));

  stopLoop();
}

function clearSaved(){
  delKey(LS_LOCK);
  delKey(LS_ANCHOR);
  delKey(LS_NOTE);
  updateSavedLockLabel();
  setLock("none");
  setProgress("—");
}

function verifySavedOnce(){
  const lockPos = loadJSON(LS_LOCK);
  const learned = loadJSON(LS_ANCHOR);
  if (!lockPos || !learned) return false;

  const rs = getRsSize();
  if (!rs.w || !rs.h) return false;

  const needle = makeNeedleFromRGBA(learned.w, learned.h, base64ToBytes(learned.rgbaBase64));

  // Verify in a small region around saved lock
  const pad = 260;

  let rx = clamp(lockPos.x - pad, 0, rs.w-1);
  let ry = clamp(lockPos.y - pad, 0, rs.h-1);
  const rw = clamp(pad*2, 1, rs.w - rx);
  const rh = clamp(pad*2, 1, rs.h - ry);

  const cap = captureRect({ x: rx, y: ry, w: rw, h: rh });
  if (!cap.img) return false;

  const res = findAnchor(cap.img, needle, {
    tolerance: 85,
    minScore: 0.01,
    step: 2,
    ignoreAlphaBelow: 0
  });

  const score = res?.score ?? 0;
  const ok = !!(res?.ok && score >= 0.70);

  drawRegionPreview(cap.img, `VERIFY learned anchor score=${score.toFixed(2)}`, ok ? { x: res.x, y: res.y, w: needle.width, h: needle.height, color: "lime" } : null);

  if (!ok) return false;

  // Convert match back to x-corner coordinate
  const foundAx = cap.rect.x + res.x;
  const foundAy = cap.rect.y + res.y;
  const xCornerX = foundAx + learned.dx;
  const xCornerY = foundAy + learned.dy;

  setLockedAt(xCornerX, xCornerY, "Verified learned anchor; scanning stopped.");
  return true;
}

// ============================================================
// Auto-find + learn
// ============================================================

function autoFindAndLearnOnce(){
  if (!running) return;

  const rs = getRsSize();
  if (!rs.w || !rs.h) {
    setStatus("No RS size");
    return;
  }

  setMode("Running");
  setStatus("Auto-finding…");
  setLock("none");
  setProgress("—");

  // Capture full RS (if this is too heavy for some users, we can tile it later)
  const full = captureRegion(0, 0, rs.w, rs.h);
  if (!full) {
    setStatus("Capture failed");
    dbg(JSON.stringify({ capture: "null", diag: window.progflashCaptureDiag || null }, null, 2));
    schedule(600, autoFindAndLearnOnce);
    return;
  }

  // 1) Find CANCEL area
  const cancel = findCancelCandidate(full);
  if (!cancel) {
    drawRegionPreview(full, "AUTO-FIND: no CANCEL cluster yet (retrying)…", null);
    dbg(JSON.stringify({ stage: "cancel", ok: false, note: "retry in 600ms" }, null, 2));
    schedule(600, autoFindAndLearnOnce);
    return;
  }

  drawRegionPreview(full, `AUTO-FIND: cancelScore=${cancel.score.toFixed(3)} (${cancel.half})`, { ...cancel.box, color: "orange" });

  // 2) Find red X corner near it
  const xCorner = findRedXNear(full, cancel);
  if (!xCorner) {
    dbg(JSON.stringify({ stage: "xcorner", ok: false, cancel }, null, 2));
    schedule(400, autoFindAndLearnOnce);
    return;
  }

  // Show x-corner search box
  drawRegionPreview(full, `AUTO-FIND: found redX density=${xCorner.density.toFixed(2)}`, { ...xCorner.searchBox, color: "deepskyblue" });

  // 3) Learn anchor patch around x-corner and save it
  const learned = learnAnchorAt(full, xCorner);

  // 4) Save lock position at the x-corner coordinate and STOP scanning
  setLockedAt(xCorner.x, xCorner.y, `Learned anchor ${learned.w}x${learned.h} at (${learned.ax},${learned.ay}).`);

  // Also show learned anchor patch in preview for sanity (optional)
  const patch = captureRegion(learned.ax, learned.ay, learned.w, learned.h);
  if (patch) drawRegionPreview(patch, "LEARNED ANCHOR PATCH (saved)", { x: learned.dx-6, y: learned.dy-6, w: 12, h: 12, color: "lime" });
}

// ============================================================
// Controls
// ============================================================

async function start(){
  if (!window.alt1) { setStatus("Alt1 missing"); dbg("Open inside Alt1 Toolkit."); return; }
  if (!alt1.permissionPixel) { setStatus("No pixel permission"); dbg("Enable Alt1 pixel permission."); return; }
  if (typeof captureRegion !== "function" || typeof findAnchor !== "function") {
    setStatus("matcher.js not ready");
    dbg(JSON.stringify({ captureRegion: typeof captureRegion, findAnchor: typeof findAnchor }, null, 2));
    return;
  }

  running = true;

  setMode("Running");
  setStatus("Checking learned anchor…");

  // Fast path: verify once
  if (verifySavedOnce()) return;

  // Otherwise, auto-find and learn
  setStatus("Learning (first time) — show a progress window and wait…");
  autoFindAndLearnOnce();
}

function stop(){
  running = false;
  stopLoop();
  setMode("Not running");
  setStatus("Idle");
  setLock("none");
  setProgress("—");
}

startBtn.onclick = () => start().catch(e => dbg(String(e)));
stopBtn.onclick = () => stop();
autoFindBtn.onclick = () => { running = true; start().catch(e => dbg(String(e))); };
clearLockBtn.onclick = () => { clearSaved(); setStatus("Cleared saved anchor/lock"); };
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
    savedLock: loadJSON(LS_LOCK),
    learned: loadJSON(LS_ANCHOR) ? "yes" : "no",
    note: "Pivot: auto-detect CANCEL + redX, learn anchor patch, then verify-only."
  }, null, 2));
})();
