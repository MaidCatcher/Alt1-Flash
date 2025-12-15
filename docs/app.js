// app.js — Drag-to-calibrate sets WIDE region AND captures per-user anchor
// Adds: live anchor quality score + auto "expand selection" suggestions

const statusEl = document.getElementById("status");
const modeEl   = document.getElementById("mode");
const lockEl   = document.getElementById("lock");
const progEl   = document.getElementById("progress");
const dbgEl    = document.getElementById("debugBox");

const startBtn = document.getElementById("startBtn");
const stopBtn  = document.getElementById("stopBtn");
const testBtn  = document.getElementById("testFlashBtn");
const calibBtn = document.getElementById("calibrateBtn");

const calibWideEl = document.getElementById("calibWide");
const calibModeEl = document.getElementById("calibMode");

const qualityScoreEl = document.getElementById("qualityScore");
const qualityDetailEl = document.getElementById("qualityDetail");
const suggestionTextEl = document.getElementById("suggestionText");

const canvas = document.getElementById("previewCanvas");
const ctx = canvas.getContext("2d", { willReadFrequently: true });

function setStatus(v){ if (statusEl) statusEl.textContent = v; }
function setMode(v){ if (modeEl) modeEl.textContent = v; }
function setLock(v){ if (lockEl) lockEl.textContent = v; }
function setProgress(v){ if (progEl) progEl.textContent = v; }
function dbg(v){ if (dbgEl) dbgEl.textContent = String(v); }

function setQuality(score, detail, suggestion) {
  if (qualityScoreEl) qualityScoreEl.textContent = score;
  if (qualityDetailEl) qualityDetailEl.textContent = detail || "";
  if (suggestionTextEl) suggestionTextEl.textContent = suggestion || "—";
}

const APP_VERSION = window.APP_VERSION || "unknown";
const BUILD_ID = window.BUILD_ID || "unknown";

// ---- localStorage keys ----
const LS_WIDE = "progflash.calibWide";
const LS_ANCHOR = "progflash.userAnchor"; // {w,h,rgbaBase64}

// ---- state ----
let running = false;
let loop = null;

let locked = false;
let lastLock = { x: 0, y: 0, score: 0 };
let lastBestScore = 0;

let calibrateArmed = false;

// Drag state (canvas coords)
let drag = { active: false, sx: 0, sy: 0, ex: 0, ey: 0 };

// Preview update rate
let lastPreviewDraw = 0;
const PREVIEW_MS = 250;

// Live quality throttle
let lastQualityEval = 0;
const QUALITY_MS = 450;

// map canvas -> capture coords
let previewMap = { scale: 1, offX: 0, offY: 0, drawW: 0, drawH: 0, srcW: 0, srcH: 0 };

// last captured frame (for quality eval)
let lastFrame = null;

// The current anchor used by matching
let anchor = null;
let userAnchor = loadJSON(LS_ANCHOR);

// ---- config ----
const MATCH = {
  tolerance: 80,
  minScoreWide: 0.62,
  minScoreTrack: 0.72,
  step: 2,
  ignoreAlphaBelow: 200
};

// Fast quality scan uses coarser sampling to stay smooth
const QUALITY = {
  tolerance: 90,
  step: 4,
  ignoreAlphaBelow: 200,
  pad: 140
};

const TRACK = { padX: 220, padY: 140, minW: 420, minH: 220 };

// -------- persistence helpers --------
function loadJSON(key){
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (_) { return null; }
}
function saveJSON(key, obj){
  try { localStorage.setItem(key, JSON.stringify(obj)); } catch (_) {}
}

let calibratedWide = loadJSON(LS_WIDE);

function updateLabels(){
  if (calibWideEl) {
    calibWideEl.textContent = calibratedWide
      ? `x=${calibratedWide.x},y=${calibratedWide.y},w=${calibratedWide.w},h=${calibratedWide.h}`
      : "none";
  }
  if (calibModeEl) calibModeEl.textContent = calibrateArmed ? "ARMED (drag on preview)" : "off";
}

// -------- pixel helpers --------
function rgba(r,g,b,a){ return (r&255)|((g&255)<<8)|((b&255)<<16)|((a&255)<<24); }

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
  let x = Math.max(0, Math.min(img.width - 1, r.x));
  let y = Math.max(0, Math.min(img.height - 1, r.y));
  let w = Math.max(1, Math.min(r.w, img.width - x));
  let h = Math.max(1, Math.min(r.h, img.height - y));
  return { x, y, w, h };
}

function getWideRegion(img){
  if (calibratedWide) {
    const r = clampRegion(img, calibratedWide);
    return { ...r, mode: "WIDE(CALIB)" };
  }
  return { x: 0, y: 0, w: img.width, h: img.height, mode: "WIDE(FULL)" };
}

function getTrackRegion(img){
  const desiredW = Math.max(TRACK.minW, TRACK.padX * 2);
  const desiredH = Math.max(TRACK.minH, TRACK.padY * 2);

  let x = Math.floor(lastLock.x - desiredW / 2);
  let y = Math.floor(lastLock.y - desiredH / 2);

  x = Math.max(0, Math.min(img.width  - 1, x));
  y = Math.max(0, Math.min(img.height - 1, y));

  let w = Math.min(desiredW, img.width  - x);
  let h = Math.min(desiredH, img.height - y);

  return { x, y, w: Math.max(1,w), h: Math.max(1,h), mode: "TRACK" };
}

function cropView(img, ox, oy, w, h){
  const x0 = Math.max(0, Math.min(img.width  - 1, ox));
  const y0 = Math.max(0, Math.min(img.height - 1, oy));
  const cw = Math.max(1, Math.min(w, img.width  - x0));
  const ch = Math.max(1, Math.min(h, img.height - y0));

  return {
    width: cw,
    height: ch,
    _offsetX: x0,
    _offsetY: y0,
    getPixel(x, y){ return img.getPixel(x0 + x, y0 + y); }
  };
}

// -------- matching --------
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

// -------- preview mapping --------
function canvasToCapture(mx, my){
  const { scale, offX, offY, drawW, drawH, srcW, srcH } = previewMap;
  if (!scale || drawW <= 0 || drawH <= 0) return null;
  if (mx < offX || my < offY || mx > offX + drawW || my > offY + drawH) return null;

  const cx = Math.floor((mx - offX) / scale);
  const cy = Math.floor((my - offY) / scale);
  return { x: Math.max(0, Math.min(srcW - 1, cx)), y: Math.max(0, Math.min(srcH - 1, cy)) };
}

// -------- live quality scoring --------
function computeQualityFromScores(best, second, aw, ah) {
  const gap = Math.max(0, best - second);

  // Build a "human-feel" 0..100 score:
  // - matching strength matters most
  // - uniqueness gap matters a lot
  // - too-small anchors get penalized
  const sizePenalty =
    (aw * ah < 1500) ? 0.14 :   // e.g. 40x35
    (aw * ah < 2800) ? 0.08 :   // e.g. 70x40
    0;

  let q = (best * 0.75 + gap * 1.3) - sizePenalty;
  q = Math.max(0, Math.min(1, q));
  return { quality: Math.round(q * 100), gap };
}

function autoSuggestion(best, second, gap, aw, ah) {
  const tooSmall = (aw < 45 || ah < 30);
  const sizeOk = (aw >= 60 && ah >= 40);

  if (best < 0.35) {
    return "Not matching well. Expand selection to include more frame/texture (avoid text and the moving fill).";
  }
  if (best < 0.55) {
    return "Match is weak. Expand a bit (10–30px) to include more of the window corner/frame.";
  }
  if (gap < 0.06) {
    return "Anchor may not be unique (too many similar matches). Expand selection to include a more distinctive corner/edge.";
  }
  if (tooSmall) {
    return "Anchor is small. Make it bigger (aim ~80×50+) including more of the frame around the X.";
  }
  if (!sizeOk && gap < 0.10) {
    return "Looks OK, but expanding slightly could improve uniqueness and stability.";
  }
  return "Looks good. If it ever drops lock, expand slightly to include more border texture.";
}

// Build a temporary anchor from a drag rectangle (capture coords) using lastFrame
function buildTempAnchorFromDrag(img, rect) {
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
  return { r, tempAnchor: makeAnchorFromRgbaBytes(r.w, r.h, bytes) };
}

function evaluateLiveQuality(img) {
  if (!calibrateArmed || !drag.active) return;

  const now = Date.now();
  if (now - lastQualityEval < QUALITY_MS) return;
  lastQualityEval = now;

  // Convert drag box to capture coords
  const x1 = Math.min(drag.sx, drag.ex);
  const y1 = Math.min(drag.sy, drag.ey);
  const x2 = Math.max(drag.sx, drag.ex);
  const y2 = Math.max(drag.sy, drag.ey);

  const p1 = canvasToCapture(x1, y1);
  const p2 = canvasToCapture(x2, y2);
  if (!p1 || !p2) {
    setQuality("—", "", "Drag inside the preview image area.");
    return;
  }

  const rect = { x: Math.min(p1.x, p2.x), y: Math.min(p1.y, p2.y), w: Math.abs(p2.x - p1.x), h: Math.abs(p2.y - p1.y) };
  if (rect.w < 20 || rect.h < 20) {
    setQuality("—", "", "Drag a slightly larger box.");
    return;
  }

  // Build temporary anchor from current drag selection
  const { r, tempAnchor } = buildTempAnchorFromDrag(img, rect);

  // Evaluate it inside a padded area around the selection (fast)
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

// -------- preview drawing --------
function drawPreview(img, scanRegion, found){
  const now = Date.now();
  if (now - lastPreviewDraw < PREVIEW_MS) return;
  lastPreviewDraw = now;

  lastFrame = img;

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

  // Scan region
  if (scanRegion) {
    const rx = offX + Math.floor(scanRegion.x * scale);
    const ry = offY + Math.floor(scanRegion.y * scale);
    const rw = Math.floor(scanRegion.w * scale);
    const rh = Math.floor(scanRegion.h * scale);

    ctx.lineWidth = 2;
    ctx.strokeStyle = (scanRegion.mode === "TRACK") ? "orange" : "lime";
    ctx.strokeRect(rx, ry, rw, rh);

    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(rx, Math.max(0, ry - 16), 170, 16);
    ctx.fillStyle = "white";
    ctx.font = "12px Arial";
    ctx.fillText(scanRegion.mode, rx + 4, Math.max(12, ry - 4));
  }

  // Found match box
  if (found && anchor) {
    const fx = offX + Math.floor(found.x * scale);
    const fy = offY + Math.floor(found.y * scale);
    const fw = Math.floor(anchor.width * scale);
    const fh = Math.floor(anchor.height * scale);

    ctx.lineWidth = 2;
    ctx.strokeStyle = "deepskyblue";
    ctx.strokeRect(fx, fy, fw, fh);
  }

  // Calibration drag overlay
  if (calibrateArmed) {
    ctx.fillStyle = "rgba(0,0,0,0.65)";
    ctx.fillRect(6, 6, cw - 12, 22);
    ctx.fillStyle = "white";
    ctx.font = "12px Arial";
    ctx.fillText("CALIBRATE: drag around the progress window corner (X + frame)", 12, 22);

    if (drag.active) {
      const x = Math.min(drag.sx, drag.ex);
      const y = Math.min(drag.sy, drag.ey);
      const w = Math.abs(drag.ex - drag.sx);
      const h = Math.abs(drag.ey - drag.sy);
      ctx.lineWidth = 2;
      ctx.strokeStyle = "yellow";
      ctx.strokeRect(x, y, w, h);

      // Live quality evaluation (throttled)
      evaluateLiveQuality(img);
    } else {
      setQuality("—", "", "Drag a box around the corner (include frame texture).");
    }
  }
}

// -------- calibration (mouseup saves WIDE + user anchor) --------
canvas.addEventListener("mousedown", (ev) => {
  if (!calibrateArmed) return;
  const rect = canvas.getBoundingClientRect();
  drag.active = true;
  drag.sx = ev.clientX - rect.left;
  drag.sy = ev.clientY - rect.top;
  drag.ex = drag.sx; drag.ey = drag.sy;
});

canvas.addEventListener("mousemove", (ev) => {
  if (!calibrateArmed || !drag.active) return;
  const rect = canvas.getBoundingClientRect();
  drag.ex = ev.clientX - rect.left;
  drag.ey = ev.clientY - rect.top;
});

canvas.addEventListener("mouseup", (ev) => {
  if (!calibrateArmed || !drag.active) return;
  drag.active = false;

  const rect = canvas.getBoundingClientRect();
  const mx2 = ev.clientX - rect.left;
  const my2 = ev.clientY - rect.top;

  const x1 = Math.min(drag.sx, mx2);
  const y1 = Math.min(drag.sy, my2);
  const x2 = Math.max(drag.sx, mx2);
  const y2 = Math.max(drag.sy, my2);

  const p1 = canvasToCapture(x1, y1);
  const p2 = canvasToCapture(x2, y2);
  if (!p1 || !p2) {
    setStatus("Calibrate failed");
    dbg("Drag inside the preview image area.");
    return;
  }

	// Raw drag rect
	const rawX = Math.min(p1.x, p2.x);
	const rawY = Math.min(p1.y, p2.y);
	const rawW = Math.max(1, Math.abs(p2.x - p1.x));
	const rawH = Math.max(1, Math.abs(p2.y - p1.y));

// Trim to a recommended size anchored to the TOP-RIGHT of the selection
const REC_W = 140;
const REC_H = 70;

// Anchor rect: take top-right corner from their selection
const ax = Math.max(0, rawX + rawW - REC_W);
const ay = Math.max(0, rawY);
const aw = REC_W;
const ah = REC_H;


  if (!lastFrame) lastFrame = captureRs();
  if (!lastFrame) {
    setStatus("Capture failed");
    dbg("Cannot capture to save anchor.");
    return;
  }

  // Anchor crop (exact drag box)
  const aRect = clampRegion(lastFrame, { x: ax, y: ay, w: aw, h: ah });
  const bytes = new Uint8ClampedArray(aRect.w * aRect.h * 4);
  let idx = 0;
  for (let y = 0; y < aRect.h; y++) {
    for (let x = 0; x < aRect.w; x++) {
      const px = (aRect.y + y) * lastFrame.width + (aRect.x + x);
      const si = px * 4;
      bytes[idx++] = lastFrame.data[si + 0];
      bytes[idx++] = lastFrame.data[si + 1];
      bytes[idx++] = lastFrame.data[si + 2];
      bytes[idx++] = lastFrame.data[si + 3];
    }
  }

  userAnchor = { w: aRect.w, h: aRect.h, rgbaBase64: bytesToBase64(bytes) };
  saveJSON(LS_ANCHOR, userAnchor);
  anchor = makeAnchorFromRgbaBytes(userAnchor.w, userAnchor.h, base64ToBytes(userAnchor.rgbaBase64));

  // WIDE region padded around anchor for reacquire
  const pad = 160;
  calibratedWide = clampRegion(lastFrame, { x: aRect.x - pad, y: aRect.y - pad, w: aRect.w + pad * 2, h: aRect.h + pad * 2 });
  saveJSON(LS_WIDE, calibratedWide);

  calibrateArmed = false;
  updateLabels();

  setStatus("Calibrated + Anchor saved");
  dbg(JSON.stringify({
    app: { version: APP_VERSION, build: BUILD_ID },
    calibratedWide,
    userAnchor: { w: userAnchor.w, h: userAnchor.h, bytes: userAnchor.w * userAnchor.h * 4 }
  }, null, 2));
});

// -------- anchor loading --------
async function loadAnchorFromFiles(){
  const a1 = await loadImage("img/progbar_anchor.png?v=" + encodeURIComponent(BUILD_ID));
  if (a1) return a1;
  const a2 = await loadImage("progbar_anchor.png?v=" + encodeURIComponent(BUILD_ID));
  if (a2) return a2;
  return null;
}
function loadUserAnchorIfAny(){
  userAnchor = loadJSON(LS_ANCHOR);
  if (!userAnchor || !userAnchor.rgbaBase64) return null;
  return makeAnchorFromRgbaBytes(userAnchor.w, userAnchor.h, base64ToBytes(userAnchor.rgbaBase64));
}
async function ensureAnchorLoaded(){
  const ua = loadUserAnchorIfAny();
  if (ua) return ua;
  return await loadAnchorFromFiles();
}

// -------- main loop --------
async function start(){
  if (!window.alt1){
    setStatus("Alt1 missing");
    dbg("Open this inside Alt1 Toolkit.");
    return;
  }
  if (typeof window.captureRs !== "function" ||
      typeof window.findAnchor !== "function" ||
      typeof window.loadImage !== "function") {
    setStatus("matcher.js not loaded");
    dbg(JSON.stringify({
      captureRs: typeof window.captureRs,
      findAnchor: typeof window.findAnchor,
      loadImage: typeof window.loadImage
    }, null, 2));
    return;
  }

  if (!anchor){
    setStatus("Loading anchor…");
    anchor = await ensureAnchorLoaded();
  }
  if (!anchor){
    setStatus("No anchor");
    dbg("No anchor available. Use Calibrate to capture one.");
    return;
  }

  running = true;
  locked = false;
  lastLock = { x: 0, y: 0, score: 0 };
  lastBestScore = 0;

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

  const img = captureRs();
  if (!img){
    setStatus("Capture failed");
    dbg("captureRs(): null\n\n" + JSON.stringify(window.progflashCaptureDiag || {}, null, 2));
    return;
  }

  lastFrame = img;

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

  lastBestScore = result.score ?? 0;

  if (result.ok){
    locked = true;
    lastLock = { x: result.x, y: result.y, score: result.score };

    setStatus("Locked");
    setLock(`x=${result.x}, y=${result.y}`);
    setProgress("locked");

    drawPreview(img, region, { x: result.x, y: result.y });

    dbg(JSON.stringify({
      app: { version: APP_VERSION, build: BUILD_ID },
      scanMode: region.mode,
      capture: { w: img.width, h: img.height },
      calibratedWide,
      anchor: { w: anchor.width, h: anchor.height, source: loadUserAnchorIfAny() ? "user" : "file" },
      res: { ok: true, x: result.x, y: result.y, score: result.score }
    }, null, 2));
  } else {
    setStatus("Searching…");
    setLock("none");
    setProgress("—");

    drawPreview(img, region, null);

    dbg(JSON.stringify({
      app: { version: APP_VERSION, build: BUILD_ID },
      scanMode: region.mode,
      capture: { w: img.width, h: img.height },
      calibratedWide,
      anchor: anchor ? { w: anchor.width, h: anchor.height } : null,
      res: { ok: false, bestScore: lastBestScore }
    }, null, 2));
  }
}

// Buttons
testBtn.onclick = () => alert("flash test");
startBtn.onclick = () => start().catch(console.error);
stopBtn.onclick = () => stop();

calibBtn.onclick = () => {
  calibrateArmed = !calibrateArmed;
  drag.active = false;
  updateLabels();
  setStatus(calibrateArmed ? "Calibrate: drag on preview" : "Idle");
  setQuality("—", "", calibrateArmed ? "Drag a box around the corner (include frame texture)." : "—");
};

// Init
updateLabels();
setQuality("—", "", "—");
setStatus("Idle");
setMode("Not running");
setLock("none");
setProgress("—");

dbg(JSON.stringify({
  app: { version: APP_VERSION, build: BUILD_ID },
  calibratedWide,
  hasUserAnchor: !!userAnchor
}, null, 2));
