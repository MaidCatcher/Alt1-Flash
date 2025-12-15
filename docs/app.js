// app.js — Smooth calibration: freeze frame + zoom/pan preview + drag-to-calibrate with live quality.

const statusEl = document.getElementById("status");
const modeEl   = document.getElementById("mode");
const lockEl   = document.getElementById("lock");
const progEl   = document.getElementById("progress");
const dbgEl    = document.getElementById("debugBox");

const startBtn = document.getElementById("startBtn");
const stopBtn  = document.getElementById("stopBtn");
const testBtn  = document.getElementById("testFlashBtn");
const calibBtn = document.getElementById("calibrateBtn");
const freezeBtn = document.getElementById("freezeBtn");
const resetViewBtn = document.getElementById("resetViewBtn");

const calibWideEl = document.getElementById("calibWide");
const calibModeEl = document.getElementById("calibMode");
const frameModeEl = document.getElementById("frameMode");

const qualityScoreEl = document.getElementById("qualityScore");
const qualityDetailEl = document.getElementById("qualityDetail");
const suggestionTextEl = document.getElementById("suggestionText");

const zoomSlider = document.getElementById("zoomSlider");
const zoomLabel = document.getElementById("zoomLabel");

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

// ---- storage ----
const LS_WIDE = "progflash.calibWide";
const LS_ANCHOR = "progflash.userAnchor";

// ---- runtime state ----
let running = false;
let loop = null;

let locked = false;
let lastLock = { x: 0, y: 0, score: 0 };

let calibrateArmed = false;

// live frame vs frozen frame
let frozen = false;
let lastFrame = null;     // latest captured frame (live)
let frozenFrame = null;   // snapshot used for calibration/preview when frozen

// drag states
let drag = { active: false, sx: 0, sy: 0, ex: 0, ey: 0 };      // canvas coords
let pan = { active: false, sx: 0, sy: 0, startX: 0, startY: 0 };
let spaceDown = false;

// view transform (in capture space)
let view = {
  zoom: 1.0,
  offsetX: 0, // capture-space top-left pixel shown at canvas top-left
  offsetY: 0
};

// map and base scale
let previewBase = { baseScale: 1, drawW: 0, drawH: 0, srcW: 0, srcH: 0 };

// current anchor
let anchor = null;

// config
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

// throttle
let lastPreviewDraw = 0;
const PREVIEW_MS = 140; // smoother but not too heavy
let lastQualityEval = 0;
const QUALITY_MS = 320;

// ---- helpers ----
function loadJSON(key){
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
function saveJSON(key, obj){
  try { localStorage.setItem(key, JSON.stringify(obj)); } catch {}
}
function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }

function updateLabels(calibratedWide){
  calibWideEl.textContent = calibratedWide
    ? `x=${calibratedWide.x},y=${calibratedWide.y},w=${calibratedWide.w},h=${calibratedWide.h}`
    : "none";
  calibModeEl.textContent = calibrateArmed ? "ARMED (drag on preview)" : "off";
  frameModeEl.textContent = frozen ? "frozen" : "live";
  zoomLabel.textContent = `${view.zoom.toFixed(2)}×`;
}

function rgba(r,g,b,a){ return (r&255)|((g&255)<<8)|((b&255)<<16)|((a&255)<<24); }
function bytesToBase64(bytes){
  let s=""; for (let i=0;i<bytes.length;i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function base64ToBytes(b64){
  const bin = atob(b64);
  const out = new Uint8ClampedArray(bin.length);
  for (let i=0;i<bin.length;i++) out[i] = bin.charCodeAt(i) & 255;
  return out;
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

function clampRegion(img, r){
  let x = clamp(r.x, 0, img.width - 1);
  let y = clamp(r.y, 0, img.height - 1);
  let w = clamp(r.w, 1, img.width - x);
  let h = clamp(r.h, 1, img.height - y);
  return { x, y, w, h };
}

function cropView(img, ox, oy, w, h){
  const x0 = clamp(ox, 0, img.width - 1);
  const y0 = clamp(oy, 0, img.height - 1);
  const cw = clamp(w, 1, img.width - x0);
  const ch = clamp(h, 1, img.height - y0);
  return {
    width: cw,
    height: ch,
    _offsetX: x0,
    _offsetY: y0,
    getPixel(x, y){ return img.getPixel(x0 + x, y0 + y); }
  };
}

// ---- calibration storage ----
let calibratedWide = loadJSON(LS_WIDE);
let userAnchor = loadJSON(LS_ANCHOR);

function loadUserAnchorIfAny(){
  userAnchor = loadJSON(LS_ANCHOR);
  if (!userAnchor || !userAnchor.rgbaBase64) return null;
  return makeAnchorFromRgbaBytes(userAnchor.w, userAnchor.h, base64ToBytes(userAnchor.rgbaBase64));
}

async function loadAnchorFromFiles(){
  // try both paths
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

// ---- matching ----
function getWideRegion(img){
  if (calibratedWide) return { ...clampRegion(img, calibratedWide), mode: "WIDE(CALIB)" };
  return { x: 0, y: 0, w: img.width, h: img.height, mode: "WIDE(FULL)" };
}

function getTrackRegion(img){
  const desiredW = Math.max(TRACK.minW, TRACK.padX * 2);
  const desiredH = Math.max(TRACK.minH, TRACK.padY * 2);
  let x = Math.floor(lastLock.x - desiredW / 2);
  let y = Math.floor(lastLock.y - desiredH / 2);
  x = clamp(x, 0, img.width - 1);
  y = clamp(y, 0, img.height - 1);
  let w = Math.min(desiredW, img.width - x);
  let h = Math.min(desiredH, img.height - y);
  return { x, y, w: Math.max(1,w), h: Math.max(1,h), mode: "TRACK" };
}

function runMatch(img, region, acceptScore){
  const hay = cropView(img, region.x, region.y, region.w, region.h);
  const res = findAnchor(hay, anchor, {
    tolerance: MATCH.tolerance,
    minScore: 0.01,
    step: MATCH.step,
    ignoreAlphaBelow: MATCH.ignoreAlphaBelow
  });
  const bestScore = res && typeof res.score === "number" ? res.score : 0;
  if (res && res.ok && bestScore >= acceptScore) {
    return { ok: true, x: res.x + hay._offsetX, y: res.y + hay._offsetY, score: bestScore };
  }
  return { ok: false, score: bestScore };
}

// ---- preview rendering with zoom/pan ----
function getDisplayFrame(){
  return frozen ? frozenFrame : lastFrame;
}

function resetViewToFit(img){
  // We render the capture into the canvas with a base scale and then apply zoom/pan in capture space.
  view.zoom = 1.0;
  view.offsetX = 0;
  view.offsetY = 0;

  // fit to canvas (baseScale)
  const cw = canvas.width, ch = canvas.height;
  const baseScale = Math.min(cw / img.width, ch / img.height);
  const drawW = Math.floor(img.width * baseScale);
  const drawH = Math.floor(img.height * baseScale);
  previewBase = { baseScale, drawW, drawH, srcW: img.width, srcH: img.height };
}

function drawPreview(img, scanRegion, found){
  const now = Date.now();
  if (!frozen && now - lastPreviewDraw < PREVIEW_MS) return;
  lastPreviewDraw = now;

  // ensure base fit is computed
  if (!previewBase.srcW || previewBase.srcW !== img.width || previewBase.srcH !== img.height) {
    resetViewToFit(img);
  }

  const cw = canvas.width, ch = canvas.height;
  ctx.clearRect(0, 0, cw, ch);

  // Create ImageData
  const srcW = img.width, srcH = img.height;
  const imageData = new ImageData(new Uint8ClampedArray(img.data), srcW, srcH);

  // Put into temp canvas
  const tmp = document.createElement("canvas");
  tmp.width = srcW; tmp.height = srcH;
  const tctx = tmp.getContext("2d", { willReadFrequently: true });
  tctx.putImageData(imageData, 0, 0);

  const { baseScale } = previewBase;

  // zoom/pan are applied in capture space:
  // We pick a capture-space rectangle [offsetX..offsetX+viewW] and draw it scaled to fill.
  const viewW = clamp(Math.floor(srcW / view.zoom), 1, srcW);
  const viewH = clamp(Math.floor(srcH / view.zoom), 1, srcH);

  view.offsetX = clamp(view.offsetX, 0, srcW - viewW);
  view.offsetY = clamp(view.offsetY, 0, srcH - viewH);

  // Destination size is canvas area; we draw the cropped source into canvas directly.
  ctx.drawImage(
    tmp,
    view.offsetX, view.offsetY, viewW, viewH,
    0, 0, cw, ch
  );

  // helper: capture -> canvas
  const capToCanvas = (cx, cy) => {
    const nx = (cx - view.offsetX) / viewW;
    const ny = (cy - view.offsetY) / viewH;
    return { x: Math.floor(nx * cw), y: Math.floor(ny * ch) };
  };
  const capToCanvasWH = (w, h) => {
    return { w: Math.floor((w / viewW) * cw), h: Math.floor((h / viewH) * ch) };
  };

  // scan region overlay
  if (scanRegion) {
    const p = capToCanvas(scanRegion.x, scanRegion.y);
    const s = capToCanvasWH(scanRegion.w, scanRegion.h);
    ctx.lineWidth = 2;
    ctx.strokeStyle = (scanRegion.mode === "TRACK") ? "orange" : "lime";
    ctx.strokeRect(p.x, p.y, s.w, s.h);

    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(p.x, Math.max(0, p.y - 16), 160, 16);
    ctx.fillStyle = "white";
    ctx.font = "12px Arial";
    ctx.fillText(scanRegion.mode, p.x + 4, Math.max(12, p.y - 4));
  }

  // found overlay
  if (found && anchor) {
    const p = capToCanvas(found.x, found.y);
    const s = capToCanvasWH(anchor.width, anchor.height);
    ctx.lineWidth = 2;
    ctx.strokeStyle = "deepskyblue";
    ctx.strokeRect(p.x, p.y, s.w, s.h);
  }

  // calibration drag overlay
  if (calibrateArmed) {
    ctx.fillStyle = "rgba(0,0,0,0.65)";
    ctx.fillRect(6, 6, cw - 12, 22);
    ctx.fillStyle = "white";
    ctx.font = "12px Arial";
    ctx.fillText("CALIBRATE: zoom/pan, then drag a box. (Frame is frozen)", 12, 22);

    if (drag.active) {
      const x = Math.min(drag.sx, drag.ex);
      const y = Math.min(drag.sy, drag.ey);
      const w = Math.abs(drag.ex - drag.sx);
      const h = Math.abs(drag.ey - drag.sy);
      ctx.lineWidth = 2;
      ctx.strokeStyle = "yellow";
      ctx.strokeRect(x, y, w, h);
    }
  }
}

// canvas -> capture mapping with zoom/pan
function canvasToCapture(mx, my, img){
  const cw = canvas.width, ch = canvas.height;
  const srcW = img.width, srcH = img.height;

  const viewW = clamp(Math.floor(srcW / view.zoom), 1, srcW);
  const viewH = clamp(Math.floor(srcH / view.zoom), 1, srcH);

  const nx = mx / cw;
  const ny = my / ch;

  const cx = Math.floor(view.offsetX + nx * viewW);
  const cy = Math.floor(view.offsetY + ny * viewH);
  return { x: clamp(cx, 0, srcW - 1), y: clamp(cy, 0, srcH - 1) };
}

// ---- live quality (uses frozenFrame so it stays smooth) ----
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
  if (gap < 0.06) return "Anchor may not be unique. Expand to include more distinctive corner/edge shape.";
  if (tooSmall) return "Anchor is small. Make it bigger (aim ~80×50+) including frame texture.";
  return "Looks good. If it ever drops lock, expand slightly to include more border texture.";
}

function buildTempAnchorFromRect(img, rect) {
  const r = clampRegion(img, rect);
  const bytes = new Uint8ClampedArray(r.w * r.h * 4);
  let idx = 0;
  for (let y = 0; y < r.h; y++) {
    for (let x = 0; x < r.w; x++) {
      const px = (r.y + y) * img.width + (r.x + x);
      const si = px * 4;
      bytes[idx++] = img.data[si + 0];
      bytes[idx++] = img.data[si + 1];
      bytes[idx++] = img.data[si + 2];
      bytes[idx++] = img.data[si + 3];
    }
  }
  return { r, tempAnchor: makeAnchorFromRgbaBytes(r.w, r.h, bytes), bytes };
}

function evaluateLiveQuality(img){
  if (!calibrateArmed || !drag.active) return;

  const now = Date.now();
  if (now - lastQualityEval < QUALITY_MS) return;
  lastQualityEval = now;

  const x1 = Math.min(drag.sx, drag.ex);
  const y1 = Math.min(drag.sy, drag.ey);
  const x2 = Math.max(drag.sx, drag.ex);
  const y2 = Math.max(drag.sy, drag.ey);

  const p1 = canvasToCapture(x1, y1, img);
  const p2 = canvasToCapture(x2, y2, img);

  const rect = { x: Math.min(p1.x, p2.x), y: Math.min(p1.y, p2.y), w: Math.abs(p2.x - p1.x), h: Math.abs(p2.y - p1.y) };
  if (rect.w < 20 || rect.h < 20) {
    setQuality("—", "", "Drag a slightly larger box.");
    return;
  }

  const { r, tempAnchor } = buildTempAnchorFromRect(img, rect);

  const padded = clampRegion(img, {
    x: Math.max(0, r.x - QUALITY.pad),
    y: Math.max(0, r.y - QUALITY.pad),
    w: r.w + QUALITY.pad * 2,
    h: r.h + QUALITY.pad * 2
  });

  const hay = cropView(img, padded.x, padded.y, padded.w, padded.h);

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
  const suggestion = autoSuggestion(best, second, gap, r.w, r.h);

  setQuality(
    `${quality}/100`,
    ` (best=${best.toFixed(2)}, 2nd=${second.toFixed(2)}, gap=${gap.toFixed(2)}, size=${r.w}x${r.h})`,
    suggestion
  );
}

// ---- main loop ----
async function start(){
  if (!window.alt1) { setStatus("Alt1 missing"); dbg("Open inside Alt1 Toolkit."); return; }

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

  if (loop) clearInterval(loop);
  loop = setInterval(tick, 200);
}

function stop(){
  running = false;
  locked = false;
  if (loop) clearInterval(loop);
  loop = null;
  setMode("Not running");
  setStatus("Idle");
  setLock("none");
  setProgress("—");
}

function tick(){
  if (!running) return;

  // Only capture new frames if not frozen
  if (!frozen) {
    const img = captureRs();
    if (!img) {
      setStatus("Capture failed");
      dbg("captureRs(): null\n\n" + JSON.stringify(window.progflashCaptureDiag || {}, null, 2));
      return;
    }
    lastFrame = img;
  }

  const img = getDisplayFrame();
  if (!img) return;

  let region, result;

  if (locked) {
    region = getTrackRegion(img);
    result = runMatch(img, region, MATCH.minScoreTrack);
    if (!result.ok) {
      const wide = getWideRegion(img);
      const reacq = runMatch(img, wide, MATCH.minScoreWide);
      region = wide;
      result = reacq;
      if (!result.ok) locked = false;
    }
  } else {
    region = getWideRegion(img);
    result = runMatch(img, region, MATCH.minScoreWide);
  }

  if (result.ok) {
    locked = true;
    lastLock = { x: result.x, y: result.y, score: result.score };
    setStatus("Locked");
    setLock(`x=${result.x}, y=${result.y}`);
    setProgress("locked");
  } else {
    setStatus("Searching…");
    setLock("none");
    setProgress("—");
  }

  drawPreview(img, region, result.ok ? { x: result.x, y: result.y } : null);
  updateLabels(calibratedWide);

  // debug
  dbg(JSON.stringify({
    app: { version: APP_VERSION, build: BUILD_ID },
    frozen,
    scanMode: region.mode,
    capture: { w: img.width, h: img.height },
    calibratedWide,
    anchor: anchor ? { w: anchor.width, h: anchor.height } : null,
    res: result.ok ? { ok: true, x: result.x, y: result.y, score: result.score } : { ok: false, bestScore: result.score }
  }, null, 2));
}

// ---- UI handlers ----
testBtn.onclick = () => alert("flash test");
startBtn.onclick = () => start().catch(console.error);
stopBtn.onclick = () => stop();

function doFreeze(on){
  frozen = on;
  if (frozen) {
    // snapshot current live frame (or capture once if missing)
    if (!lastFrame) lastFrame = captureRs();
    frozenFrame = lastFrame;
  } else {
    frozenFrame = null;
  }
  updateLabels(calibratedWide);
}

freezeBtn.onclick = () => doFreeze(!frozen);

resetViewBtn.onclick = () => {
  const img = getDisplayFrame();
  if (img) resetViewToFit(img);
  view.zoom = 1.0;
  zoomSlider.value = "1";
  updateLabels(calibratedWide);
};

zoomSlider.oninput = () => {
  view.zoom = parseFloat(zoomSlider.value || "1");
  updateLabels(calibratedWide);
};

calibBtn.onclick = () => {
  calibrateArmed = !calibrateArmed;
  drag.active = false;
  pan.active = false;

  if (calibrateArmed) {
    // auto-freeze for smooth calibration
    doFreeze(true);

    // ensure we have a frame and reset view to fit so user can zoom from sensible base
    const img = getDisplayFrame();
    if (img) resetViewToFit(img);

    setStatus("Calibrate: frozen (zoom then drag)");
    setQuality("—", "", "Zoom in and drag a box around stable frame/border pixels.");
  } else {
    setStatus("Idle");
  }

  updateLabels(calibratedWide);
};

window.addEventListener("keydown", (e) => { if (e.code === "Space") spaceDown = true; });
window.addEventListener("keyup", (e) => { if (e.code === "Space") spaceDown = false; });

// ---- canvas interaction: pan + drag select ----
canvas.addEventListener("contextmenu", (e) => e.preventDefault());

canvas.addEventListener("mousedown", (ev) => {
  const img = getDisplayFrame();
  if (!img) return;

  const rect = canvas.getBoundingClientRect();
  const mx = ev.clientX - rect.left;
  const my = ev.clientY - rect.top;

  const rightButton = (ev.button === 2);
  if (rightButton || spaceDown) {
    pan.active = true;
    pan.sx = mx; pan.sy = my;
    pan.startX = view.offsetX;
    pan.startY = view.offsetY;
    return;
  }

  if (!calibrateArmed) return;

  drag.active = true;
  drag.sx = mx; drag.sy = my;
  drag.ex = mx; drag.ey = my;
});

canvas.addEventListener("mousemove", (ev) => {
  const img = getDisplayFrame();
  if (!img) return;

  const rect = canvas.getBoundingClientRect();
  const mx = ev.clientX - rect.left;
  const my = ev.clientY - rect.top;

  if (pan.active) {
    // convert canvas delta into capture delta
    const cw = canvas.width, ch = canvas.height;
    const srcW = img.width, srcH = img.height;
    const viewW = clamp(Math.floor(srcW / view.zoom), 1, srcW);
    const viewH = clamp(Math.floor(srcH / view.zoom), 1, srcH);

    const dx = (mx - pan.sx) / cw * viewW;
    const dy = (my - pan.sy) / ch * viewH;

    view.offsetX = clamp(Math.floor(pan.startX - dx), 0, srcW - viewW);
    view.offsetY = clamp(Math.floor(pan.startY - dy), 0, srcH - viewH);
    return;
  }

  if (!calibrateArmed || !drag.active) return;
  drag.ex = mx; drag.ey = my;

  // live quality (fast + throttled)
  evaluateLiveQuality(img);
});

canvas.addEventListener("mouseup", (ev) => {
  const img = getDisplayFrame();
  if (!img) return;

  if (pan.active) { pan.active = false; return; }
  if (!calibrateArmed || !drag.active) return;

  drag.active = false;

  const rect = canvas.getBoundingClientRect();
  const mx2 = ev.clientX - rect.left;
  const my2 = ev.clientY - rect.top;

  const x1 = Math.min(drag.sx, mx2);
  const y1 = Math.min(drag.sy, my2);
  const x2 = Math.max(drag.sx, mx2);
  const y2 = Math.max(drag.sy, my2);

  const p1 = canvasToCapture(x1, y1, img);
  const p2 = canvasToCapture(x2, y2, img);

  const ax = Math.min(p1.x, p2.x);
  const ay = Math.min(p1.y, p2.y);
  const aw = Math.max(1, Math.abs(p2.x - p1.x));
  const ah = Math.max(1, Math.abs(p2.y - p1.y));

  // Build anchor bytes from exact selection
  const aRect = clampRegion(img, { x: ax, y: ay, w: aw, h: ah });
  const bytes = new Uint8ClampedArray(aRect.w * aRect.h * 4);
  let idx = 0;
  for (let y = 0; y < aRect.h; y++) {
    for (let x = 0; x < aRect.w; x++) {
      const px = (aRect.y + y) * img.width + (aRect.x + x);
      const si = px * 4;
      bytes[idx++] = img.data[si + 0];
      bytes[idx++] = img.data[si + 1];
      bytes[idx++] = img.data[si + 2];
      bytes[idx++] = img.data[si + 3];
    }
  }

  const ua = { w: aRect.w, h: aRect.h, rgbaBase64: bytesToBase64(bytes) };
  saveJSON(LS_ANCHOR, ua);
  anchor = makeAnchorFromRgbaBytes(ua.w, ua.h, base64ToBytes(ua.rgbaBase64));

  // Wide region padded around anchor
  const pad = 160;
  calibratedWide = clampRegion(img, {
    x: aRect.x - pad,
    y: aRect.y - pad,
    w: aRect.w + pad * 2,
    h: aRect.h + pad * 2
  });
  saveJSON(LS_WIDE, calibratedWide);

  calibrateArmed = false;
  updateLabels(calibratedWide);

  setStatus("Calibrated (anchor saved)");
  setQuality("—", "", "Saved. Click Start.");
});

// ---- init ----
(async function init(){
  setStatus("Idle");
  setMode("Not running");
  setLock("none");
  setProgress("—");
  setQuality("—", "", "—");

  // start with a frame so preview isn't blank
  const img = captureRs();
  if (img) {
    lastFrame = img;
    resetViewToFit(img);
    drawPreview(img, null, null);
  }

  anchor = await ensureAnchorLoaded();
  updateLabels(calibratedWide);

  dbg(JSON.stringify({
    app: { version: APP_VERSION, build: BUILD_ID },
    calibratedWide,
    hasUserAnchor: !!loadUserAnchorIfAny()
  }, null, 2));
})();
