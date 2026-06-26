/* ── Continuity Monitor — Client ── */

const RECONNECT_INTERVAL_MS = 200;
const STATS_WINDOW = 100; // rolling window size for avg/min/max
const UI_THROTTLE_MS = 100; // update DOM at most 10x/sec
const SPARK_POINTS = 60; // number of sparkline data points (≈60s of history at 1/sec sample)

// ── DOM refs ──
const elStatus = document.getElementById("status-text");
const elLed = document.getElementById("status-led");
const elLatency = document.getElementById("stat-latency");
const elAvgLatency = document.getElementById("stat-avg-latency");
const elMinLatency = document.getElementById("stat-min-latency");
const elMaxLatency = document.getElementById("stat-max-latency");
const elJitter = document.getElementById("stat-jitter");
const elRps = document.getElementById("stat-rps");
const elThroughput = document.getElementById("stat-throughput");
const elLoss = document.getElementById("stat-loss");
const elDowntime = document.getElementById("stat-downtime");
const elPayloadSize = document.getElementById("payload-size");
const elPayloadSlider = document.getElementById("payload-slider");
const elLog = document.getElementById("event-log");
const elVuFill = document.getElementById("vu-fill");
const elVuPeak = document.getElementById("vu-peak");

// ── State ──
let ws = null;
let seq = 0;
let connected = false;
let disconnectTime = null;
let reconnectTimer = null;
let lastUiUpdate = 0;
let lastPingSentAt = 0; // performance.now() when the last ping was sent
let waitingForReply = false;

// Stats accumulators
const rttWindow = []; // rolling RTT samples
let lastRtt = 0;
let prevRtt = null;
let jitterAcc = 0; // running EWMA jitter (RFC 3550)
let jitterCount = 0;

// RPS tracking — sliding window of completion timestamps
const rpsTimestamps = []; // timestamps of completed pings within last 1s
let rpsValue = 0;

// Packet loss
let sentCount = 0;
let recvCount = 0;

// Payload
let payloadSize = 1; // bytes

// Histogram — rolling window of last 10k RTT samples
const HISTO_WINDOW = 10000;
const BUCKET_THRESHOLDS = [0.1, 1, 10, 100, 1000]; // upper bounds (exclusive)
const histoRing = []; // rolling RTT buffer for histogram
const elHBars = Array.from({ length: 6 }, (_, i) => document.getElementById(`hbar-${i}`));
const elHCounts = Array.from({ length: 6 }, (_, i) => document.getElementById(`hcount-${i}`));

// ── Sparkline system ──
// Each sparkline has a time-series buffer and a canvas context
const sparkConfigs = [
  { id: "spark-latency", key: "latency", color: "#e0a020" },
  { id: "spark-avg-latency", key: "avgLatency", color: "#c89018" },
  { id: "spark-min-latency", key: "minLatency", color: "#39ff14" },
  { id: "spark-max-latency", key: "maxLatency", color: "#ff4020" },
  { id: "spark-jitter", key: "jitter", color: "#ff8c00" },
  { id: "spark-rps", key: "rps", color: "#60ff40" },
  { id: "spark-throughput", key: "throughput", color: "#20c0e0" },
  { id: "spark-loss", key: "loss", color: "#ff2020" },
  { id: "spark-downtime", key: "downtime", color: "#ff2020" },
];

const sparkData = {}; // key -> number[]
const sparkCtx = {};  // key -> CanvasRenderingContext2D

for (const cfg of sparkConfigs) {
  sparkData[cfg.key] = [];
  const canvas = document.getElementById(cfg.id);
  if (canvas) {
    sparkCtx[cfg.key] = canvas.getContext("2d");
  }
}

// Sample sparklines once per second
let lastSparkSample = 0;
const SPARK_SAMPLE_MS = 1000;

function sampleSparklines(currentLatency, stats) {
  const throughput = payloadSize * 2 * rpsValue;
  const downtimeVal = disconnectTime ? (Date.now() - disconnectTime) : 0;

  const values = {
    latency: currentLatency,
    avgLatency: stats.avg,
    minLatency: stats.min === Infinity ? 0 : stats.min,
    maxLatency: stats.max === -Infinity ? 0 : stats.max,
    jitter: stats.jitter,
    rps: rpsValue,
    throughput: throughput,
    loss: stats.loss,
    downtime: downtimeVal,
  };

  for (const cfg of sparkConfigs) {
    const arr = sparkData[cfg.key];
    arr.push(values[cfg.key]);
    if (arr.length > SPARK_POINTS) arr.shift();
  }
}

function drawSparkline(key, color) {
  const ctx = sparkCtx[key];
  if (!ctx) return;
  const data = sparkData[key];
  if (data.length < 2) return;

  const canvas = ctx.canvas;
  const rect = canvas.parentElement.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = rect.width;
  const h = rect.height;

  // Resize canvas buffer to match display size (HiDPI)
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  ctx.clearRect(0, 0, w, h);

  // Auto-scale Y axis
  let min = Infinity, max = -Infinity;
  for (const v of data) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (max === min) { max = min + 1; }
  const yPad = (max - min) * 0.1;
  min -= yPad;
  max += yPad;

  const stepX = w / (SPARK_POINTS - 1);
  const offset = SPARK_POINTS - data.length;

  ctx.beginPath();
  for (let i = 0; i < data.length; i++) {
    const x = (i + offset) * stepX;
    const y = h - ((data[i] - min) / (max - min)) * h;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = "round";
  ctx.stroke();

  // Fill under the line
  ctx.lineTo((data.length - 1 + offset) * stepX, h);
  ctx.lineTo(offset * stepX, h);
  ctx.closePath();
  ctx.fillStyle = color.replace(")", ",0.08)").replace("rgb", "rgba").replace("#", "");
  // Use a simpler approach for hex colors
  ctx.globalAlpha = 0.1;
  ctx.fill();
  ctx.globalAlpha = 1;
}

function drawAllSparklines() {
  for (const cfg of sparkConfigs) {
    drawSparkline(cfg.key, cfg.color);
  }
}

// ── Helpers ──
function formatBytes(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + " MB";
  return (bytes / 1073741824).toFixed(2) + " GB";
}

function formatDuration(ms) {
  if (ms < 1000) return ms.toFixed(0) + " ms";
  if (ms < 60000) return (ms / 1000).toFixed(1) + " s";
  return (ms / 60000).toFixed(1) + " min";
}

function formatThroughput(bytesPerSec) {
  if (bytesPerSec < 1024) return bytesPerSec.toFixed(0) + " B/s";
  if (bytesPerSec < 1048576) return (bytesPerSec / 1024).toFixed(1) + " KB/s";
  if (bytesPerSec < 1073741824)
    return (bytesPerSec / 1048576).toFixed(1) + " MB/s";
  return (bytesPerSec / 1073741824).toFixed(2) + " GB/s";
}

function logEvent(type, msg) {
  const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
  const div = document.createElement("div");
  div.className = `log-entry log-${type}`;
  div.textContent = `[${ts}] ${msg}`;
  elLog.prepend(div);

  // Keep log manageable
  while (elLog.children.length > 200) {
    elLog.removeChild(elLog.lastChild);
  }
}

function setStatus(state) {
  elLed.className = `led led-${state}`;
  if (state === "connected") elStatus.textContent = "CONNECTED";
  else if (state === "disconnected") elStatus.textContent = "DISCONNECTED";
  else if (state === "reconnecting") elStatus.textContent = "RECONNECTING…";
}

// ── Payload slider ──
function sliderToBytes(val) {
  // Logarithmic mapping: 0-1000 → 1 B to 100 MB
  const minLog = 0; // log10(1)
  const maxLog = 8; // log10(100_000_000)
  const logVal = minLog + (val / 1000) * (maxLog - minLog);
  return Math.round(Math.pow(10, logVal));
}

function updatePayloadLabel() {
  payloadSize = sliderToBytes(parseInt(elPayloadSlider.value, 10));
  elPayloadSize.textContent = formatBytes(payloadSize);
}

elPayloadSlider.addEventListener("input", updatePayloadLabel);
updatePayloadLabel();

// ── Stats ──
function pushRtt(rtt) {
  rttWindow.push(rtt);
  if (rttWindow.length > STATS_WINDOW) rttWindow.shift();

  lastRtt = rtt;
  recvCount++;

  // RPS — record this completion timestamp
  rpsTimestamps.push(performance.now());

  // RFC 3550 jitter (exponential weighted moving average of |delta|)
  if (prevRtt !== null) {
    const diff = Math.abs(rtt - prevRtt);
    jitterAcc += (diff - jitterAcc) / 16;
    jitterCount++;
  }
  prevRtt = rtt;

  // Histogram rolling window
  histoRing.push(rtt);
  if (histoRing.length > HISTO_WINDOW) histoRing.shift();
}

function getStats() {
  if (rttWindow.length === 0)
    return { avg: 0, min: 0, max: 0, jitter: 0, loss: 0 };

  let sum = 0,
    min = Infinity,
    max = -Infinity;
  for (const r of rttWindow) {
    sum += r;
    if (r < min) min = r;
    if (r > max) max = r;
  }
  const avg = sum / rttWindow.length;
  const loss = sentCount > 0 ? ((sentCount - recvCount) / sentCount) * 100 : 0;

  return { avg, min, max, jitter: jitterAcc, loss: Math.max(0, loss) };
}

// ── Compute "live" current latency ──
// If we're waiting for a reply, the displayed latency grows linearly
function getCurrentLatency() {
  if (waitingForReply && lastPingSentAt > 0) {
    return performance.now() - lastPingSentAt;
  }
  return lastRtt;
}

// ── Compute live RPS from sliding window ──
function computeRps() {
  const now = performance.now();
  // Prune timestamps older than 1 second
  while (rpsTimestamps.length > 0 && now - rpsTimestamps[0] > 1000) {
    rpsTimestamps.shift();
  }
  rpsValue = rpsTimestamps.length;
}

// ── Continuous render loop (requestAnimationFrame) ──
function renderLoop() {
  const now = performance.now();

  // Compute live values
  computeRps();
  const currentLatency = getCurrentLatency();
  const stats = getStats();

  // Throttle DOM updates
  if (now - lastUiUpdate >= UI_THROTTLE_MS) {
    lastUiUpdate = now;

    elLatency.textContent = currentLatency.toFixed(2) + " ms";
    elAvgLatency.textContent = stats.avg.toFixed(2) + " ms";
    elMinLatency.textContent = stats.min.toFixed(2) + " ms";
    elMaxLatency.textContent =
      stats.max === -Infinity ? "—" : stats.max.toFixed(2) + " ms";
    elJitter.textContent = stats.jitter.toFixed(2) + " ms";
    elRps.textContent = rpsValue.toFixed(0) + " rps";
    elLoss.textContent = stats.loss.toFixed(1) + "%";

    // Throughput: payload * 2 (round trip) * RPS
    const throughput = payloadSize * 2 * rpsValue;
    elThroughput.textContent = formatThroughput(throughput);

    // Downtime
    if (disconnectTime) {
      const elapsed = Date.now() - disconnectTime;
      elDowntime.textContent = formatDuration(elapsed);
    }

    // VU meter — map latency logarithmically (0.1ms → 1000ms)
    const vuMax = 1000;
    const pct = Math.min(
      100,
      Math.max(0, (Math.log10(Math.max(currentLatency, 0.1)) / Math.log10(vuMax)) * 100)
    );
    elVuFill.style.width = pct + "%";

    // Color the VU fill based on latency
    if (currentLatency < 10) elVuFill.className = "vu-fill vu-good";
    else if (currentLatency < 50) elVuFill.className = "vu-fill vu-ok";
    else if (currentLatency < 200) elVuFill.className = "vu-fill vu-warn";
    else elVuFill.className = "vu-fill vu-bad";

    // Histogram bars — recompute buckets from rolling window
    const counts = [0, 0, 0, 0, 0, 0];
    for (const r of histoRing) {
      let b = BUCKET_THRESHOLDS.length;
      for (let i = 0; i < BUCKET_THRESHOLDS.length; i++) {
        if (r < BUCKET_THRESHOLDS[i]) { b = i; break; }
      }
      counts[b]++;
    }
    const maxBucket = Math.max(1, ...counts);
    for (let i = 0; i < 6; i++) {
      const pctH = (counts[i] / maxBucket) * 100;
      elHBars[i].style.height = pctH + "%";
      elHCounts[i].textContent = counts[i];
    }
  }

  // Sample sparklines once per second
  if (now - lastSparkSample >= SPARK_SAMPLE_MS) {
    lastSparkSample = now;
    sampleSparklines(currentLatency, stats);
    drawAllSparklines();
  }

  requestAnimationFrame(renderLoop);
}

// ── WebSocket ──
function buildPayload() {
  // Build padding string of the requested size.
  // The JSON overhead is small, so we approximate.
  const overhead = 40; // rough JSON envelope size
  const padLen = Math.max(0, payloadSize - overhead);
  return "x".repeat(padLen);
}

function sendPing() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const msg = JSON.stringify({
    ts: performance.now(),
    seq: seq++,
    pad: buildPayload(),
  });
  ws.send(msg);
  sentCount++;
  lastPingSentAt = performance.now();
  waitingForReply = true;
}

function connect() {
  if (ws) {
    try {
      ws.close();
    } catch {}
  }

  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${proto}//${location.host}/ws`;

  try {
    ws = new WebSocket(url);
  } catch (e) {
    scheduleReconnect();
    return;
  }

  ws.addEventListener("open", () => {
    connected = true;
    setStatus("connected");

    if (disconnectTime) {
      const downtime = Date.now() - disconnectTime;
      logEvent(
        "reconnect",
        `Reconnected after ${formatDuration(downtime)} downtime`
      );
      elDowntime.textContent = formatDuration(downtime);
      disconnectTime = null;
    } else {
      logEvent("connect", "Connected to server");
    }

    // Reset loss counters on fresh connection
    sentCount = 0;
    recvCount = 0;

    // Fire first ping
    sendPing();
  });

  ws.addEventListener("message", (ev) => {
    try {
      const data = JSON.parse(ev.data);
      const rtt = performance.now() - data.ts;
      waitingForReply = false;
      pushRtt(rtt);
    } catch {}

    // Fire next ping immediately (continuous loop)
    sendPing();
  });

  ws.addEventListener("close", () => {
    if (connected) {
      connected = false;
      disconnectTime = Date.now();
      waitingForReply = false;
      setStatus("disconnected");
      logEvent("disconnect", "Connection lost");
    }
    scheduleReconnect();
  });

  ws.addEventListener("error", () => {
    // Error will be followed by close, so no action needed here
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  setStatus("reconnecting");
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, RECONNECT_INTERVAL_MS);
}

// ── Boot ──
connect();
requestAnimationFrame(renderLoop);
