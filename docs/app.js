// --- sanity check ---
if (!window.alt1) {
  document.body.insertAdjacentHTML(
    "afterbegin",
    "<div style='padding:8px;background:#fcc;border:1px solid #c99'>Not running in Alt1</div>"
  );
  throw new Error("Not running in Alt1");
}

// --- UI refs ---
const statusEl = document.getElementById("status");
const modeEl   = document.getElementById("mode");
const lockEl   = document.getElementById("lock");

const startBtn = document.getElementById("startBtn");
const stopBtn  = document.getElementById("stopBtn");
const testBtn  = document.getElementById("testFlashBtn");

let running = false;

// --- helpers ---
function rgba(r, g, b, a = 255) {
  return (r & 255) | ((g & 255) << 8) | ((b & 255) << 16) | ((a & 255) << 24);
}

function flashOverlay() {
  if (!alt1.permissionOverlay) {
    alert("Overlay permission not granted");
    return;
  }

  const group = "progflash";
  let i = 0;
  const flashes = 6;

  const t = setInterval(() => {
    alt1.overLaySetGroup(group);
    if (i % 2 === 0) {
      alt1.overLayRect(
        rgba(255, 0, 0, 140),
        alt1.rsX + 10,
        alt1.rsY + 10,
        400,
        200,
        200,
        4
      );
    } else {
      alt1.overLayClearGroup(group);
    }
    i++;
    if (i >= flashes * 2) {
      alt1.overLayClearGroup(group);
      clearInterval(t);
    }
  }, 200);
}

// --- buttons ---
testBtn.onclick = () => {
  statusEl.textContent = "Test flash";
  flashOverlay();
};

startBtn.onclick = () => {
  running = true;
  statusEl.textContent = "Running";
  modeEl.textContent = "Armed";
  lockEl.textContent = "none";
  startBtn.disabled = true;
  stopBtn.disabled = false;
};

stopBtn.onclick = () => {
  running = false;
  statusEl.textContent = "Idle";
  modeEl.textContent = "Not running";
  lockEl.textContent = "none";
  startBtn.disabled = false;
  stopBtn.disabled = true;
};

// --- startup ---
statusEl.textContent = "Idle";
modeEl.textContent = "Not running";
lockEl.textContent = "none";

document.body.insertAdjacentHTML(
  "afterbegin",
  "<div style='padding:6px;background:#ddf;border:1px solid #99c'>✅ app.js running</div>"
);
