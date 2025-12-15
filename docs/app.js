// app.js — Performance fix: capture only scan region, avoid full-frame per tick,
// use setTimeout loop for UI responsiveness, freeze calibration.

const statusEl = document.getElementById("status");
const modeEl   = document.getElementById("mode");
const lockEl   = document.getElementById("lock");
const progEl   = document.getElementById("progress");
const dbgEl    = document.getElementById("debugBox");

const startBtn = document.getElementById("startBtn");
const stopBtn  = document.getElementById("stopBtn");
const testBtn  = document.getElementById("testFlashBtn");
const calibBtn = document.getElementById("calibrateBtn");

const qualityScoreEl = document.getElementById("qualityScore");
const qualityDetailEl = document.getElementById("qualityDetail");
const suggestionTextEl = document.getElementById("suggestionText");

const calibWideEl = document.getElementById("calibWide");
const calibModeEl = document.getElementById("calibMode");

const canvas = document.getElementById("previewCanvas");
const ctx = canvas.getContext("2d", { willReadFrequently: true });

function setStatus(v){ statusEl.textContent = v; }
function setMode(v){ modeEl.textContent = v; }
function setLock(v){ lockEl.textContent = v; }
function setProgress(v){ progEl.textContent = v; }
function dbg(v){ dbgEl.textContent = String(v); }
function setQuality(score, detail, suggestion) {
  qualityScoreEl.textContent = score;
  qualityDetailEl.textContent = detail || "";
  suggestionTextEl.textContent = suggestion || "—";
}

const APP_VERSION = window.APP_VERSION || "unknown";
const BUILD_ID = window.BUILD_ID || "unknown";

const LS_WIDE = "progflash.calibWide";
const LS_ANCHOR = "progflash.userAnchor";

const MATCH = {
  tolerance: 80,
  minScoreWide: 0.62,
  minScoreTrack: 0.72,
  step: 2,
  ignoreAlphaBelow: 200
};

const QUALITY = {
  tolerance: 90,
  step: 4,
  ignoreAlphaBelow: 200,
  pad: 140
};

const TRACK = { padX: 220, padY: 140, minW: 420, minH: 220 };

// -------- persistence helpers --------
function loadJSON(key){
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
function saveJSON(key, obj){
  try { localStorage.setItem(key, JSON.stringify(obj)); } catch {}
}
function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }

let calibratedWide = loadJSON(LS_WIDE);
function updateCalibLabel(){
  calibWideEl.textContent = calibratedWide
    ? `x=${calibratedWide.x},y=${calibratedWide.y},w=${calibratedWide.w},h=${calibratedWide.h}`
    : "none";
  calibModeEl.textContent = calibrateArmed ? "ARMED" : "off";
}

// -------- anchor load/save --------
function rgba(r,g,b,a){ return (r&255)|((g&255)<<8)|((b&255)<<16)|((a&255)<<24); }
function base64ToBytes(b64){
  const bin = atob(b64);
  const out = new Uint8ClampedArray(bin.length);
  for (let i=0;i<bin.length;i++) out[i] = bin.charCodeAt(i) & 255;
  return out;
}
function bytesToBase64(bytes){
  let s=""; for (let i=0;i<bytes.length;i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function makeAnchorFromRgbaBytes(w, h, rgbaBytes){
  return {
    width: w,
    height: h,
    data: rgbaBytes,
    getPixel(x, y){
      if (x < 0 || y < 0 || x >= w || y >= h) return 0;
      const i = (y * w + x) * 4;
      return rgba(rgbaBytes[i], rgbaBytes[i+1], rgbaBytes[i+2], rgbaBytes[i+3]);
    }
  };
}
function loadUserAnchorIfAny(){
  const ua = loadJSON(LS_ANCHOR);
  if (!ua || !ua.rgbaBase64) return null;
  return makeAnchorFromRgbaBytes(ua.w, ua.h, base64ToBytes(ua.rgbaBase64));
}
async function loadAnchorFromFiles(){
  const a1 = await loadImage("img/progbar_anchor.png?v=" + encodeURIComponent(BUILD_ID));
  if (a1) return a1;
  const a2 = await loadImage("progbar_anchor.png?v=" + encodeURIComponent(BUILD_ID));
  if (a2) return a2;
  return null;
}
async function ensureAnchorLoaded(){
  const ua = loadUserAnchorIfAny();
  if (ua) return ua;
  return await loadAnchorFromFiles();
}

// -------- state --------
let running = false;
let locked = false;
let lastLock = { x: 0, y: 0, score: 0 };

let loopHandle = null;
let calibrateArmed = false;

// Freeze for calibration (single capture)
let frozenImg = null;

// Preview throttles
let lastPreviewDraw = 0;
const PREVIEW_MS = 350;   // slower preview = smoother UI
let lastQualityEval = 0;
const QUALITY_MS = 450;

// Drag calibrate (canvas coords)
let drag = { active: false, sx: 0, sy: 0, ex: 0, ey: 0 };

// Map canvas coords to capture coords for frozen image
let previewMap = { scale: 1, offX: 0, offY: 0, drawW: 0, drawH: 0, srcW: 0, srcH: 0 };

// Current anchor
let anchor = null;

// -------- region helpers (RS capture space) --------
function clampRegionToRs(imgW, imgH, r){
  const x = clamp(r.x, 0, imgW - 1);
  const y = clamp(r.y, 0, imgH - 1);
  const w = clamp(r.w, 1, imgW - x);
  const h = clamp(r.h, 1, imgH - y);
  return { x, y, w, h };
}

function getWideRegion(rsW, rsH){
  if (calibratedWide) return clampRegionToRs(rsW, rsH, calibratedWide);
  return { x: 0, y: 0, w: rsW, h: rsH };
}

function getTrackRegion(rsW, rsH){
  const desiredW = Math.max(TRACK.minW, TRACK.padX * 2);
  const desiredH = Math.max(TRACK.minH, TRACK.padY * 2);
  let x = Math.floor(lastLock.x - desiredW / 2);
  let y = Math.floor(lastLock.y - desiredH / 2);
  x = clamp(x, 0, rsW - 1);
  y = clamp(y, 0, rsH - 1);
  let w = Math.min(desiredW, rsW - x);
  let h = Math.min(desiredH, rsH - y);
  return { x, y, w: Math.max(1,w), h: Math.max(1,h) };
}

// When we capture a region, the returned image is region-sized; convert match coords back to RS coords.
function runMatchOnRegion(regionImg, regionRect, acceptScore, opts){
  const res = findAnchor(regionImg, anchor, opts);
  const best = res && typeof res.score === "number" ? res.score : 0;
  if (res && res.ok && best >= acceptScore) {
    return { ok: true, x: regionRect.x + res.x, y: regionRect.y + res.y, score: best };
  }
  return { ok: false, score: best };
}

// -------- preview drawing (uses frozenImg only) --------
function drawPreviewFrozen(scanRegion, found){
  const img = frozenImg;
  if (!img) return;

  const now = Date.now();
  if (now - lastPreviewDraw < PREVIEW_MS) return;
  lastPreviewDraw = now;

  const srcW = img.width, srcH = img.height;
  const imageData = new ImageData(new Uint8ClampedArray(img.data), srcW, srcH);

  const cw = canvas.width, ch = canvas.height;
  const scale = Math.min(cw / srcW, ch / srcH);
  const drawW = Math.floor(srcW * scale);
  const drawH = Math.floor(srcH * scale);
  const offX = Math.floor((cw - drawW) / 2);
  const offY = Math.floor((ch - drawH) / 2);

  previewMap = { scale, offX, offY, drawW, drawH, srcW, srcH };

  ctx.clearRect(0, 0, cw, ch);

  const tmp = document.createElement("canvas");
  tmp.width = srcW; tmp.height = srcH;
  const tctx = tmp.getContext("2d", { willReadFrequently: true });
  tctx.putImageData(imageData, 0, 0);
  ctx.drawImage(tmp, 0, 0, srcW, srcH, offX, offY, drawW, drawH);

  // scan region box (green)
  if (scanRegion) {
    const rx = offX + Math.floor(scanRegion.x * scale);
    const ry = offY + Math.floor(scanRegion.y * scale);
    const rw = Math.floor(scanRegion.w * scale);
    const rh = Math.floor(scanRegion.h * scale);
    ctx.lineWidth = 2;
    ctx.strokeStyle = "lime";
    ctx.strokeRect(rx, ry, rw, rh);
  }

  // found match (blue)
  if (found && anchor) {
    const fx = offX + Math.floor(found.x * scale);
    const fy = offY + Math.floor(found.y * scale);
    const fw = Math.floor(anchor.width * scale);
    const fh = Math.floor(anchor.height * scale);
    ctx.lineWidth = 2;
    ctx.strokeStyle = "deepskyblue";
    ctx.strokeRect(fx, fy, fw, fh);
  }

  // drag overlay
  if (calibrateArmed && drag.active) {
    const x = Math.min(drag.sx, drag.ex);
    const y = Math.min(drag.sy, drag.ey);
    const w = Math.abs(drag.ex - drag.sx);
    const h = Math.abs(drag.ey - drag.sy);
    ctx.lineWidth = 2;
    ctx.strokeStyle = "yellow";
    ctx.strokeRect(x, y, w, h);
  }
}

function canvasToCapture(mx, my){
  const { scale, offX, offY, drawW, drawH, srcW, srcH } = previewMap;
  if (!scale || drawW <= 0 || drawH <= 0) return null;
  if (mx < offX || my < offY || mx > offX + drawW || my > offY + drawH) return null;
  const cx = Math.floor((mx - offX) / scale);
  const cy = Math.floor((my - offY) / scale);
  return { x: clamp(cx, 0, srcW - 1), y: clamp(cy, 0, srcH - 1) };
}

// -------- quality scoring (runs on frozen only, so no lag) --------
function computeQualityFromScores(best, second, aw, ah) {
  const gap = Math.max(0, best - second);
  const sizePenalty =
    (aw * ah < 1500) ? 0.14 :
    (aw * ah < 2800) ? 0.08 : 0;

  let q = (best * 0.75 + gap * 1.3) - sizePenalty;
  q = Math.max(0, Math.min(1, q));
  return { quality: Math.round(q * 100), gap };
}
function autoSuggestion(best, second, gap, aw, ah) {
  const tooSmall = (aw < 45 || ah < 30);
  if (best < 0.35) return "Not matching well. Expand selection to include more frame/texture (avoid text/fill).";
  if (best < 0.55) return "Match is weak. Expand 10–30px to include more corner/frame texture.";
  if (gap < 0.06) return "Not unique enough. Expand to include more distinctive corner/edge shape.";
  if (tooSmall) return "Anchor is small. Make it bigger (aim ~80×50+) including frame texture.";
  return "Looks good.";
}

function buildTempAnchorFromFrozen(rect){
  const img = frozenImg;
  const r = clampRegionToRs(img.width, img.height, rect);
  const bytes = new Uint8ClampedArray(r.w * r.h * 4);
  let idx = 0;
  for (let y=0;y<r.h;y++){
    for (let x=0;x<r.w;x++){
      const px = (r.y + y) * img.width + (r.x + x);
      const si = px * 4;
      bytes[idx++] = img.data[si+0];
      bytes[idx++] = img.data[si+1];
      bytes[idx++] = img.data[si+2];
      bytes[idx++] = img.data[si+3];
    }
  }
  return { r, tempAnchor: makeAnchorFromRgbaBytes(r.w, r.h, bytes), bytes };
}

function evaluateLiveQualityFromDrag(){
  if (!calibrateArmed || !drag.active || !frozenImg) return;
  const now = Date.now();
  if (now - lastQualityEval < QUALITY_MS) return;
  lastQualityEval = now;

  const x1 = Math.min(drag.sx, drag.ex);
  const y1 = Math.min(drag.sy, drag.ey);
  const x2 = Math.max(drag.sx, drag.ex);
  const y2 = Math.max(drag.sy, drag.ey);

  const p1 = canvasToCapture(x1, y1);
  const p2 = canvasToCapture(x2, y2);
  if (!p1 || !p2) { setQuality("—", "", "Drag inside the preview."); return; }

  const rect = { x: Math.min(p1.x,p2.x), y: Math.min(p1.y,p2.y), w: Math.abs(p2.x-p1.x), h: Math.abs(p2.y-p1.y) };
  if (rect.w < 20 || rect.h < 20) { setQuality("—", "", "Drag a slightly larger box."); return; }

  const { r, tempAnchor } = buildTempAnchorFromFrozen(rect);

  const padded = clampRegionToRs(frozenImg.width, frozenImg.height, {
    x: r.x - QUALITY.pad,
    y: r.y - QUALITY.pad,
    w: r.w + QUALITY.pad * 2,
    h: r.h + QUALITY.pad * 2
  });

  const hay = {
    width: padded.w,
    height: padded.h,
    getPixel: (x,y) => frozenImg.getPixel(padded.x + x, padded.y + y)
  };

  const res = findAnchor(hay, tempAnchor, {
    tolerance: QUALITY.tolerance,
    minScore: 0.01,
    step: QUALITY.step,
    ignoreAlphaBelow: QUALITY.ignoreAlphaBelow,
    returnSecond: true
  });

  const best = res && typeof res.score === "number" ? res.score : 0;
  const second = res && typeof res.secondScore === "number" ? res.secondScore : 0;

  const { quality, gap } = computeQualityFromScores(best, second, r.w, r.h);
  setQuality(
    `${quality}/100`,
    ` (best=${best.toFixed(2)}, 2nd=${second.toFixed(2)}, gap=${gap.toFixed(2)}, size=${r.w}x${r.h})`,
    autoSuggestion(best, second, gap, r.w, r.h)
  );
}

// -------- main scan loop (setTimeout) --------
const TICK_MS_SEARCH = 260;
const TICK_MS_LOCKED = 180;

async function start(){
  if (!window.alt1) { setStatus("Alt1 missing"); dbg("Open inside Alt1 Toolkit."); return; }
  if (typeof captureRegion !== "function") { setStatus("matcher.js missing captureRegion"); return; }

  if (!anchor) {
    setStatus("Loading anchor…");
    anchor = await ensureAnchorLoaded();
  }
  if (!anchor) { setStatus("No anchor"); dbg("Use Calibrate to capture one."); return; }

  running = true;
  locked = false;

  setMode("Running");
  setStatus("Searching…");
  setLock("none");
  setProgress("—");

  scheduleNextTick(0);
}

function stop(){
  running = false;
  locked = false;
  if (loopHandle) clearTimeout(loopHandle);
  loopHandle = null;
  setMode("Not running");
  setStatus("Idle");
  setLock("none");
  setProgress("—");
}

function scheduleNextTick(delay){
  if (loopHandle) clearTimeout(loopHandle);
  loopHandle = setTimeout(tick, delay);
}

function tick(){
  if (!running) return;

  // Calibration should not be running scan logic (keeps UI responsive)
  if (calibrateArmed) {
    scheduleNextTick(200);
    return;
  }

  const rsW = alt1.rsWidth || 0;
  const rsH = alt1.rsHeight || 0;
  if (!rsW || !rsH) {
    setStatus("Capture failed");
    dbg(JSON.stringify(window.progflashCaptureDiag || {}, null, 2));
    scheduleNextTick(400);
    return;
  }

  // Choose smallest region possible
  let regionRect;
  let scanMode;

  if (locked) {
    regionRect = getTrackRegion(rsW, rsH);
    scanMode = "TRACK";
  } else {
    regionRect = getWideRegion(rsW, rsH);
    scanMode = calibratedWide ? "WIDE(CALIB)" : "WIDE(FULL)";
  }

  // Capture ONLY that region
  const regionImg = captureRegion(regionRect.x, regionRect.y, regionRect.w, regionRect.h);
  if (!regionImg) {
    setStatus("Capture failed");
    dbg("captureRegion(): null\n\n" + JSON.stringify(window.progflashCaptureDiag || {}, null, 2));
    scheduleNextTick(500);
    return;
  }

  // Match inside region image
  const accept = locked ? MATCH.minScoreTrack : MATCH.minScoreWide;
  const result = runMatchOnRegion(regionImg, regionRect, accept, {
    tolerance: MATCH.tolerance,
    minScore: 0.01,
    step: MATCH.step,
    ignoreAlphaBelow: MATCH.ignoreAlphaBelow
  });

  if (result.ok) {
    locked = true;
    lastLock = { x: result.x, y: result.y, score: result.score };
    setStatus("Locked");
    setLock(`x=${result.x}, y=${result.y}`);
    setProgress("locked");
  } else {
    locked = false;
    setStatus("Searching…");
    setLock("none");
    setProgress("—");
  }

  dbg(JSON.stringify({
    app: { version: APP_VERSION, build: BUILD_ID },
    scanMode,
    rs: { w: rsW, h: rsH },
    region: regionRect,
    anchor: anchor ? { w: anchor.width, h: anchor.height } : null,
    res: result.ok ? { ok: true, x: result.x, y: result.y, score: result.score } : { ok: false, bestScore: result.score }
  }, null, 2));

  scheduleNextTick(locked ? TICK_MS_LOCKED : TICK_MS_SEARCH);
}

// -------- calibration (freeze once, no live capture) --------
function enterCalibration(){
  calibrateArmed = true;
  drag.active = false;

  // Freeze: capture one moderately-sized preview (use WIDE if set, else full)
  const rsW = alt1.rsWidth || 0;
  const rsH = alt1.rsHeight || 0;
  if (!rsW || !rsH) return;

  const wide = getWideRegion(rsW, rsH);

  // If full screen and you haven't calibrated yet, still capture full once (only once)
  frozenImg = captureRegion(wide.x, wide.y, wide.w, wide.h);
  if (!frozenImg) {
    setStatus("Capture failed");
    dbg("freeze captureRegion(): null\n\n" + JSON.stringify(window.progflashCaptureDiag || {}, null, 2));
    calibrateArmed = false;
    return;
  }

  setStatus("Calibrate: frozen");
  setQuality("—", "", "Drag a box on the frozen preview. No lag now.");
  updateCalibLabel();
  drawPreviewFrozen({ x: 0, y: 0, w: frozenImg.width, h: frozenImg.height }, null);
}

function exitCalibration(){
  calibrateArmed = false;
  drag.active = false;
  setStatus("Idle");
  updateCalibLabel();
}

calibBtn.onclick = () => {
  if (calibrateArmed) exitCalibration();
  else enterCalibration();
};

// -------- canvas drag for calibration --------
canvas.addEventListener("mousedown", (ev) => {
  if (!calibrateArmed || !frozenImg) return;
  const rect = canvas.getBoundingClientRect();
  drag.active = true;
  drag.sx = ev.clientX - rect.left;
  drag.sy = ev.clientY - rect.top;
  drag.ex = drag.sx;
  drag.ey = drag.sy;
});

canvas.addEventListener("mousemove", (ev) => {
  if (!calibrateArmed || !frozenImg || !drag.active) return;
  const rect = canvas.getBoundingClientRect();
  drag.ex = ev.clientX - rect.left;
  drag.ey = ev.clientY - rect.top;

  evaluateLiveQualityFromDrag();
  drawPreviewFrozen({ x: 0, y: 0, w: frozenImg.width, h: frozenImg.height }, null);
});

canvas.addEventListener("mouseup", (ev) => {
  if (!calibrateArmed || !frozenImg || !drag.active) return;
  drag.active = false;

  const rectC = canvas.getBoundingClientRect();
  const mx2 = ev.clientX - rectC.left;
  const my2 = ev.clientY - rectC.top;

  const x1 = Math.min(drag.sx, mx2);
  const y1 = Math.min(drag.sy, my2);
  const x2 = Math.max(drag.sx, mx2);
  const y2 = Math.max(drag.sy, my2);

  const p1 = canvasToCapture(x1, y1);
  const p2 = canvasToCapture(x2, y2);
  if (!p1 || !p2) { setStatus("Calibrate failed"); return; }

  const ax = Math.min(p1.x,p2.x);
  const ay = Math.min(p1.y,p2.y);
  const aw = Math.max(1, Math.abs(p2.x-p1.x));
  const ah = Math.max(1, Math.abs(p2.y-p1.y));

  // Save anchor from exact selection
  const r = clampRegionToRs(frozenImg.width, frozenImg.height, { x: ax, y: ay, w: aw, h: ah });
  const bytes = new Uint8ClampedArray(r.w * r.h * 4);
  let idx = 0;
  for (let y=0;y<r.h;y++){
    for (let x=0;x<r.w;x++){
      const px = (r.y + y) * frozenImg.width + (r.x + x);
      const si = px * 4;
      bytes[idx++] = frozenImg.data[si+0];
      bytes[idx++] = frozenImg.data[si+1];
      bytes[idx++] = frozenImg.data[si+2];
      bytes[idx++] = frozenImg.data[si+3];
    }
  }
  const ua = { w: r.w, h: r.h, rgbaBase64: bytesToBase64(bytes) };
  saveJSON(LS_ANCHOR, ua);
  anchor = makeAnchorFromRgbaBytes(ua.w, ua.h, base64ToBytes(ua.rgbaBase64));

  // Save WIDE region padded around selection (still in frozenImg coords!)
  // IMPORTANT: frozenImg is itself a region capture. We need to map back to RS coords:
  // captureRegion stored offsets in _offsetX/_offsetY which are RS-space of the frozen capture.
  const baseX = frozenImg._offsetX || 0;
  const baseY = frozenImg._offsetY || 0;

  const pad = 180;
  calibratedWide = {
    x: clamp(baseX + r.x - pad, 0, (alt1.rsWidth || 1) - 1),
    y: clamp(baseY + r.y - pad, 0, (alt1.rsHeight || 1) - 1),
    w: r.w + pad * 2,
    h: r.h + pad * 2
  };
  // Clamp w/h properly
  const rsW = alt1.rsWidth || 0;
  const rsH = alt1.rsHeight || 0;
  calibratedWide = clampRegionToRs(rsW, rsH, calibratedWide);
  saveJSON(LS_WIDE, calibratedWide);

  setStatus("Calibrated");
  updateCalibLabel();
  exitCalibration();
});

// -------- buttons --------
testBtn.onclick = () => alert("flash test");
startBtn.onclick = () => start().catch(console.error);
stopBtn.onclick = () => stop();

// -------- init --------
(async function init(){
  setStatus("Idle");
  setMode("Not running");
  setLock("none");
  setProgress("—");
  setQuality("—", "", "—");
  updateCalibLabel();

  anchor = await ensureAnchorLoaded();

  dbg(JSON.stringify({
    app: { version: APP_VERSION, build: BUILD_ID },
    calibratedWide,
    hasUserAnchor: !!loadUserAnchorIfAny()
  }, null, 2));
})();
