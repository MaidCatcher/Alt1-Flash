let running = false;
let lockPos = null;
let bestScore = 0;
let matchInfo = {};
let flashAt = 95;
let flashStyle = "text";
let lastProgress = 0;
let triggered = false;
let version = `v=${Date.now()}`;

function log(msg) {
  const el = document.getElementById("log");
  if (el) el.textContent = msg;
  console.log(msg);
}

function setStatus(text) {
  document.getElementById("status").textContent = text;
}

function setProgress(p) {
  const el = document.getElementById("progress");
  el.textContent = p === null ? "—" : `${Math.floor(p)}%`;
}

function playBeep() {
  const beep = new Audio("https://www.soundjay.com/button/beep-07.wav");
  beep.play();
}

function doFlash() {
  if (flashStyle === "fullscreen") {
    const flash = document.createElement("div");
    flash.style.position = "fixed";
    flash.style.top = 0;
    flash.style.left = 0;
    flash.style.width = "100vw";
    flash.style.height = "100vh";
    flash.style.backgroundColor = "white";
    flash.style.zIndex = 9999;
    flash.style.opacity = 1;
    document.body.appendChild(flash);
    playBeep();
    setTimeout(() => document.body.removeChild(flash), 150);
  } else {
    alert("Flash!");
    playBeep();
  }
}

function clampProgress(p) {
  return Math.max(0, Math.min(100, p));
}

async function findAnchorAndLock() {
  setStatus("Searching…");
  const anchor = await loadImage("img/progbar_anchor.png");
  if (!anchor) {
    setStatus("Missing anchor image");
    return;
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    const img = await captureRs();
    const match = findAnchor(img, anchor, { threshold: 0.9 });
    if (match.ok) {
      lockPos = match.pos;
      bestScore = match.score;
      matchInfo = match;
      setStatus("Locked");
      return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  setStatus("Not found");
}

function getProgress(img, anchorPos) {
  const barX = anchorPos.x + 5;
  const barY = anchorPos.y + 5;
  const barWidth = 130;
  const barHeight = 5;

  let filled = 0;
  for (let x = 0; x < barWidth; x++) {
    const color = img.getPixel(barX + x, barY + 2);
    if (color.g > 100 && color.r < 100) filled++;
    else break;
  }

  const percent = clampProgress((filled / barWidth) * 100);
  return percent;
}

async function loop() {
  if (!running) return;

  const img = await captureRs();

  if (!lockPos) {
    await findAnchorAndLock();
    setTimeout(loop, 100);
    return;
  }

  const progress = getProgress(img, lockPos);
  setProgress(progress);

  if (progress >= flashAt && !triggered) {
    triggered = true;
    doFlash();
  }

  if (progress < flashAt - 20) triggered = false;

  setTimeout(loop, 250);
}

document.getElementById("start").addEventListener("click", async () => {
  running = true;
  lockPos = null;
  triggered = false;
  flashAt = parseInt(document.getElementById("flashAt").value) || 95;
  flashStyle = document.getElementById("flashStyle").value;
  setProgress(null);
  log("ProgFlash " + version);
  loop();
});

document.getElementById("stop").addEventListener("click", () => {
  running = false;
  setStatus("Stopped");
});

document.getElementById("testflash").addEventListener("click", () => {
  doFlash();
});

if (
  typeof window.findAnchor === "function" &&
  typeof window.captureRs === "function" &&
  typeof window.loadImage === "function"
) {
  console.log("ProgFlash " + version + " Ready");
  log("ProgFlash " + version + "\nReady");
} else {
  log("Missing progflash* globals");
}
