// ProgFlash - no a1lib dependency
// Requires: Alt1 + View screen + Show overlay permissions

const statusEl = document.getElementById("status");
const modeEl   = document.getElementById("mode");
const lockEl   = document.getElementById("lock");

const startBtn = document.getElementById("startBtn");
const stopBtn  = document.getElementById("stopBtn");
const testBtn  = document.getElementById("testFlashBtn");

document.getElementById("bannerApp").style.display = "block";

function setStatus(s){ statusEl.textContent = s; }
function setMode(s){ modeEl.textContent = s; }
function setLock(s){ lockEl.textContent = s; }

function rgba(r,g,b,a=255){
  return (r & 255) | ((g & 255) << 8) | ((b & 255) << 16) | ((a & 255) << 24);
}

function flashOverlay() {
  if (!window.alt1) { alert("Not running inside Alt1."); return; }
  if (!alt1.permissionOverlay) { alert("Overlay permission not granted."); return; }

  const group = "progflash";
  let i = 0;
  const flashes = 6;
  const interval = 200;

  const t = setInterval(() => {
    alt1.overLaySetGroup(group);
    if (i % 2 === 0) {
      // Flash the RS client area
      const x = alt1.rsX || 0;
      const y = alt1.rsY || 0;
      const w = alt1.rsWidth  || 800;
      const h = alt1.rsHeight || 600;
      alt1.overLayRect(rgba(255, 0, 0, 160), x, y, w, h, interval, 0);
    } else {
      alt1.overLayClearGroup(group);
    }
    i++;
    if (i >= flashes * 2) {
      alt1.overLayClearGroup(group);
      clearInterval(t);
    }
  }, interval);
}

// ---- Anchor image -> BGRA base64 (Alt1 bindFindSubImg expects BGRA8 base64) ----
function imgDataToAlt1BGRA8Base64(imgData) {
  const { data, width, height } = imgData;
  const out = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const r = data[i * 4 + 0];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    const a = data[i * 4 + 3];
    out[i * 4 + 0] = b;
    out[i * 4 + 1] = g;
    out[i * 4 + 2] = r;
    out[i * 4 + 3] = a;
  }
  // base64
  let binary = "";
  for (let i = 0; i < out.length; i++) binary += String.fromCharCode(out[i]);
  return btoa(binary);
}

async function loadAnchorAsAlt1Buffer(url) {
  const img = new Image();
  img.src = url + "?v=" + Date.now(); // bust caches
  await img.decode();

  const c = document.createElement("canvas");
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const imgData = ctx.getImageData(0, 0, c.width, c.height);

  return { w: c.width, h: c.height, b64: imgDataToAlt1BGRA8Base64(imgData) };
}

// ---- Detection state ----
let running = false;
let anchor = null;
let regionId = null;
let lockPos = null;     // {x,y} in RS-client coords (not screen coords)
let lastSeen = 0;
let loopTimer = null;

// helpers: normalize bindFindSubImg return formats
function parseFindResult(res) {
  // Common formats seen in the wild:
  // - string: "x,y"
  // - object: {x:..., y:...}
  // - array:  [x,y]
  // - number: -1 or 0
  if (res == null) return null;
  if (typeof res === "string") {
    if (!res.includes(",")) return null;
    const [xs, ys] = res.split(",");
    const x = parseInt(xs, 10);
    const y = parseInt(ys, 10);
    if (Number.isFinite(x) && Number.isFinite(y)) return { x, y };
    return null;
  }
  if (Array.isArray(res) && res.length >= 2) {
    const x = Number(res[0]), y = Number(res[1]);
    if (Number.isFinite(x) && Number.isFinite(y)) return { x, y };
    return null;
  }
  if (typeof res === "object" && "x" in res && "y" in res) {
    const x = Number(res.x), y = Number(res.y);
    if (Number.isFinite(x) && Number.isFinite(y)) return { x, y };
    return null;
  }
  return null;
}

function ensureRegion() {
  // bind full RS client region once
  if (regionId != null) return regionId;

  if (!alt1.bindRegion) return null;

  const w = alt1.rsWidth  || 0;
  const h = alt1.rsHeight || 0;
  if (!w || !h) return null;

  regionId = alt1.bindRegion(0, 0, w, h);
  return regionId;
}

function findAnchorOnce() {
  const id = ensureRegion();
  if (id == null) return null;
  if (!alt1.bindFindSubImg) return null;
  if (!anchor) return null;

  const w = alt1.rsWidth  || 0;
  const h = alt1.rsHeight || 0;
  // search entire client for now (we can optimize after lock)
  const res = alt1.bindFindSubImg(id, anchor.b64, anchor.w, 0, 0, w, h);
  const pt = parseFindResult(res);
  return pt;
}

function drawDebugBox(x, y, w, h) {
  if (!alt1.permissionOverlay) return;
  alt1.overLaySetGroup("progflash_debug");
  alt1.overLayRect(rgba(0, 120, 255, 200), (alt1.rsX||0)+x, (alt1.rsY||0)+y, w, h, 500, 2);
}

function clearDebug() {
  if (!alt1.permissionOverlay) return;
  alt1.overLaySetGroup("progflash_debug");
  alt1.overLayClearGroup("progflash_debug");
}

async function start() {
  if (!window.alt1) { alert("Open this inside Alt1."); return; }
  if (!alt1.permissionPixel) { alert("Need View screen permission."); return; }
  if (!alt1.permissionOverlay) { alert("Need Show overlay permission."); return; }
  if (!alt1.bindFindSubImg || !alt1.bindRegion) {
    alert("Your Alt1 build doesn't expose bindFindSubImg/bindRegion.\nProgress-bar detection won't work on this build.");
    return;
  }

  if (!anchor) {
    setStatus("Loading anchor...");
    anchor = await loadAnchorAsAlt1Buffer("./img/progbar_anchor.png");
  }

  running = true;
  startBtn.disabled = true;
  stopBtn.disabled = false;

  setMode("Running");
  setStatus("Searching...");
  setLock("none");
  lockPos = null;
  lastSeen = 0;

  loopTimer = setInterval(() => {
    if (!running) return;

    const pt = findAnchorOnce();

    if (!lockPos) {
      if (pt) {
        lockPos = pt;
        lastSeen = Date.now();
        setStatus("Locked");
        setLock(`x=${pt.x}, y=${pt.y}`);
        drawDebugBox(pt.x, pt.y, anchor.w, anchor.h);
      } else {
        setStatus("Searching...");
      }
      return;
    }

    // When locked: keep checking anchor presence. If it disappears briefly, treat as end.
    if (pt) {
      lastSeen = Date.now();
      setStatus("Locked");
      // draw at current match point (bar shifts a little sometimes)
      drawDebugBox(pt.x, pt.y, anchor.w, anchor.h);
      return;
    }

    // not found this frame
    const ms = Date.now() - lastSeen;
    if (ms > 450) {
      // progress finished or bar not visible anymore
      flashOverlay();
      setStatus("Flashed!");
      lockPos = null;
      lastSeen = 0;
      clearDebug();
    } else {
      setStatus("Lost (waiting)...");
    }
  }, 150);
}

function stop() {
  running = false;
  if (loopTimer) clearInterval(loopTimer);
  loopTimer = null;
  regionId = null;
  lockPos = null;
  lastSeen = 0;

  startBtn.disabled = false;
  stopBtn.disabled = true;

  setStatus("Idle");
  setMode("Not running");
  setLock("none");
  clearDebug();
}

// Button wiring
testBtn.onclick = () => { setStatus("Test flash"); flashOverlay(); };
startBtn.onclick = () => { start().catch(e => { console.error(e); setStatus("Error (see console)"); }); };
stopBtn.onclick = stop;

// Startup
setStatus("Idle");
setMode("Not running");
setLock("none");
