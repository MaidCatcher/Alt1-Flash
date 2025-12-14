
let config = {
  flashAt: 95,
  flashStyle: "text",
  anchorImage: "progbar_anchor.png"
};

let running = false;

function log(msg) {
  document.getElementById("log").textContent += msg + "\n";
}

async function findAnchorAndLock() {
  log("Searching for anchor...");
  const result = await window.findAnchor(config.anchorImage);
  if (result.ok) {
    log("Locked at: x=" + result.x + ", y=" + result.y);
    return result;
  } else {
    log("Failed to find anchor.");
    return null;
  }
}

async function start() {
  running = true;
  log("Started");
  const anchor = await findAnchorAndLock();
  if (!anchor) return;

  // Simulate progress loop
  while (running) {
    log("Progress: simulated");
    await new Promise(res => setTimeout(res, 1000));
  }
}

function stop() {
  running = false;
  log("Stopped");
}

function testFlash() {
  const flashStyle = document.getElementById("flashStyle").value;
  if (flashStyle === "fullscreen") {
    document.body.style.backgroundColor = "white";
    setTimeout(() => document.body.style.backgroundColor = "", 100);
  } else {
    alert("FLASH!");
  }
}

window.start = start;
window.stop = stop;
window.testFlash = testFlash;
