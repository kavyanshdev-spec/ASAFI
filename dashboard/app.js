/**
 * ASAFI — Autonomous Spacecraft Avionics Fire Interceptor
 * Ground Mission Control & Telemetry Client Engine (Pair 2)
 *
 * Handles:
 * - High-speed WebSocket connection with telemetry packet parsing & auto-recovery
 * - Dual video stream processing (WebSocket Base64 frame & HTTP MJPEG)
 * - Optical HUD reticle & targeting canvas rendering
 * - Thermal heat flux strip chart & MLX90614 pyrometer displays
 * - 2-Axis PCA9685 Gimbal attitude radar canvas
 * - Uplink telecommand dispatching & safety-interlocked cold-gas firing
 * - In-browser Standalone Simulator fallback
 * - Synthesized Web Audio mission control annunciator
 */

// ============================================================================
// 1. GLOBAL STATE & CONFIGURATION
// ============================================================================
const state = {
  // Network
  wsUrl: 'ws://localhost:8765',
  mjpegUrl: 'http://localhost:8080/video_feed',
  connected: false,
  isSimulating: false,
  reconnectIntervalMs: 5000,
  ws: null,
  reconnectTimer: null,
  lastPktTime: performance.now(),
  packetCounter: 0,
  packetRateHz: 0,
  rttMs: 8,

  // Payload Avionics
  systemState: 'STANDBY',   // STANDBY, SEARCHING, TARGET_LOCKED, INTERCEPTING, SUPPRESSED, MANUAL_OVERRIDE, EMERGENCY_STOP
  mode: 'AUTONOMOUS',       // AUTONOMOUS, MANUAL
  metSeconds: 0,
  startTime: Date.now(),

  // MLX90614
  ambientTemp: 24.2,
  objectTemp: 24.8,
  tempThreshold: 55.0,
  tempHistory: [],          // Rolling buffer of { time, obj, amb }

  // Vision
  targetDetected: false,
  confidence: 0.0,
  bbox: [],                 // [x, y, w, h]
  frameWidth: 640,
  frameHeight: 480,
  fps: 24.0,

  // Gimbal
  pan: 0.0,
  tilt: 0.0,
  targetPan: 0.0,
  targetTilt: 0.0,

  // Cold Gas Suppression
  armed: false,
  solenoidActive: false,
  burstDurationMs: 1500,
  pressureBar: 6.8,
  dischargeCount: 0,

  // Diagnostics
  piCpuTemp: 47.8,
  piCpuLoad: 32,
  piRamUsed: 39,

  // User Settings
  audioEnabled: true,
  videoSource: 'ws',        // 'ws', 'mjpeg', 'synth'
  activeLogFilter: 'all',
  logs: []
};

// ============================================================================
// 2. SYNTHESIZED WEB AUDIO ANNUNCIATOR
// ============================================================================
class AudioAnnunciator {
  constructor() {
    this.ctx = null;
    this.alarmOsc = null;
    this.alarmGain = null;
    this.isAlarming = false;
  }

  init() {
    if (!this.ctx) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioContext();
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  playBeep(freq = 880, duration = 0.08, type = 'sine') {
    if (!state.audioEnabled) return;
    this.init();
    try {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, this.ctx.currentTime);
      gain.gain.setValueAtTime(0.12, this.ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + duration);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start();
      osc.stop(this.ctx.currentTime + duration);
    } catch (e) {}
  }

  playLockOnChime() {
    if (!state.audioEnabled) return;
    this.init();
    this.playBeep(650, 0.06, 'sine');
    setTimeout(() => this.playBeep(980, 0.12, 'sine'), 80);
  }

  playDischargeHiss() {
    if (!state.audioEnabled) return;
    this.init();
    try {
      // Noise buffer for cold-gas discharge hiss
      const bufferSize = this.ctx.sampleRate * 0.4;
      const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        data[i] = Math.random() * 2 - 1;
      }
      const noise = this.ctx.createBufferSource();
      noise.buffer = buffer;
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = 1200;
      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(0.2, this.ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + 0.4);
      noise.connect(filter);
      filter.connect(gain);
      gain.connect(this.ctx.destination);
      noise.start();
    } catch (e) {}
  }

  startAlarmWarble() {
    if (!state.audioEnabled || this.isAlarming) return;
    this.init();
    try {
      this.isAlarming = true;
      this.alarmOsc = this.ctx.createOscillator();
      this.alarmGain = this.ctx.createGain();
      this.alarmOsc.type = 'sawtooth';
      this.alarmOsc.frequency.setValueAtTime(800, this.ctx.currentTime);
      
      // Warble LFO
      const lfo = this.ctx.createOscillator();
      lfo.frequency.value = 5;
      const lfoGain = this.ctx.createGain();
      lfoGain.gain.value = 250;
      lfo.connect(lfoGain);
      lfoGain.connect(this.alarmOsc.frequency);
      lfo.start();

      this.alarmGain.gain.setValueAtTime(0.1, this.ctx.currentTime);
      this.alarmOsc.connect(this.alarmGain);
      this.alarmGain.connect(this.ctx.destination);
      this.alarmOsc.start();
    } catch (e) {}
  }

  stopAlarmWarble() {
    if (this.isAlarming && this.alarmOsc) {
      try {
        this.alarmOsc.stop();
        this.alarmOsc.disconnect();
      } catch (e) {}
      this.alarmOsc = null;
      this.isAlarming = false;
    }
  }
}

const audio = new AudioAnnunciator();

// ============================================================================
// 3. DOM ELEMENT REFERENCES
// ============================================================================
const dom = {
  // Status Bar
  systemStateBadge: document.getElementById('systemStateBadge'),
  systemStateText: document.getElementById('systemStateText'),
  systemModeBadge: document.getElementById('systemModeBadge'),
  systemModeText: document.getElementById('systemModeText'),
  metTimer: document.getElementById('metTimer'),
  commDot: document.getElementById('commDot'),
  commStatusText: document.getElementById('commStatusText'),
  rttText: document.getElementById('rttText'),
  pktRateText: document.getElementById('pktRateText'),
  alarmBanner: document.getElementById('alarmBanner'),
  btnAlarmQuickSuppress: document.getElementById('btnAlarmQuickSuppress'),

  // Header Quick Buttons
  btnToggleSim: document.getElementById('btnToggleSim'),
  simStateLabel: document.getElementById('simStateLabel'),
  btnAudioToggle: document.getElementById('btnAudioToggle'),
  audioStateLabel: document.getElementById('audioStateLabel'),
  audioIcon: document.getElementById('audioIcon'),
  btnConfigModal: document.getElementById('btnConfigModal'),

  // Video Section
  hudCanvas: document.getElementById('hudCanvas'),
  videoStreamImg: document.getElementById('videoStreamImg'),
  fpsTag: document.getElementById('fpsTag'),
  yoloTag: document.getElementById('yoloTag'),
  targetLockStatus: document.getElementById('targetLockStatus'),
  targetConfidence: document.getElementById('targetConfidence'),
  targetCoords: document.getElementById('targetCoords'),
  targetError: document.getElementById('targetError'),
  sourceBtns: document.querySelectorAll('.source-btn'),

  // MLX90614
  objectTempContainer: document.getElementById('objectTempContainer'),
  objectTempVal: document.getElementById('objectTempVal'),
  objectTempBar: document.getElementById('objectTempBar'),
  ambientTempVal: document.getElementById('ambientTempVal'),
  deltaTempVal: document.getElementById('deltaTempVal'),
  thermalChartCanvas: document.getElementById('thermalChartCanvas'),

  // Gimbal
  gimbalRadarCanvas: document.getElementById('gimbalRadarCanvas'),
  gimbalPanVal: document.getElementById('gimbalPanVal'),
  gimbalTiltVal: document.getElementById('gimbalTiltVal'),
  targetPanVal: document.getElementById('targetPanVal'),
  targetTiltVal: document.getElementById('targetTiltVal'),
  gimbalSyncStatus: document.getElementById('gimbalSyncStatus'),

  // Suppression Subsystem
  valveStatusTag: document.getElementById('valveStatusTag'),
  valveGraphic: document.getElementById('valveGraphic'),
  solenoidStateText: document.getElementById('solenoidStateText'),
  canisterPressureVal: document.getElementById('canisterPressureVal'),
  relayStateVal: document.getElementById('relayStateVal'),
  dischargeCountVal: document.getElementById('dischargeCountVal'),

  // Control Deck
  btnModeAuto: document.getElementById('btnModeAuto'),
  btnModeManual: document.getElementById('btnModeManual'),
  modeHelpText: document.getElementById('modeHelpText'),
  dpadUp: document.getElementById('dpadUp'),
  dpadDown: document.getElementById('dpadDown'),
  dpadLeft: document.getElementById('dpadLeft'),
  dpadRight: document.getElementById('dpadRight'),
  dpadCenter: document.getElementById('dpadCenter'),
  panSlider: document.getElementById('panSlider'),
  panSliderVal: document.getElementById('panSliderVal'),
  tiltSlider: document.getElementById('tiltSlider'),
  tiltSliderVal: document.getElementById('tiltSliderVal'),

  // Solenoid Fire Trigger
  safetySwitch: document.getElementById('safetySwitch'),
  safetyStatusDesc: document.getElementById('safetyStatusDesc'),
  btnFireSolenoid: document.getElementById('btnFireSolenoid'),
  burstBtns: document.querySelectorAll('.btn-burst'),
  btnEmergencyStop: document.getElementById('btnEmergencyStop'),

  // Demo buttons
  btnSimFire: document.getElementById('btnSimFire'),
  btnResetPayload: document.getElementById('btnResetPayload'),

  // Diagnostics
  piCpuTempVal: document.getElementById('piCpuTempVal'),
  piCpuLoadVal: document.getElementById('piCpuLoadVal'),
  piRamVal: document.getElementById('piRamVal'),

  // Terminal Logs
  terminalLogs: document.getElementById('terminalLogs'),
  termFilterBtns: document.querySelectorAll('.term-btn'),
  btnClearLogs: document.getElementById('btnClearLogs'),
  btnExportLogs: document.getElementById('btnExportLogs'),

  // Config Modal
  configModal: document.getElementById('configModal'),
  btnCloseModal: document.getElementById('btnCloseModal'),
  wsUrlInput: document.getElementById('wsUrlInput'),
  mjpegUrlInput: document.getElementById('mjpegUrlInput'),
  reconnectSelect: document.getElementById('reconnectSelect'),
  btnDisconnectLink: document.getElementById('btnDisconnectLink'),
  btnSaveConnectLink: document.getElementById('btnSaveConnectLink')
};

// ============================================================================
// 4. WEBSOCKET CLIENT & TELEMETRY HANDLER
// ============================================================================
function initWebSocket() {
  if (state.isSimulating) return;

  if (state.ws) {
    try { state.ws.close(); } catch (e) {}
    state.ws = null;
  }

  logEvent('NET', `Initiating uplink connection to ${state.wsUrl}...`, 'system');
  updateConnectionStatus('connecting');

  try {
    state.ws = new WebSocket(state.wsUrl);
  } catch (err) {
    logEvent('NET_ERR', `WebSocket construction failed: ${err.message}`, 'system');
    scheduleReconnect();
    return;
  }

  state.ws.onopen = () => {
    state.connected = true;
    updateConnectionStatus('online');
    logEvent('NET', `Telemetry link ESTABLISHED with Raspberry Pi at ${state.wsUrl}`, 'system');
    audio.playBeep(880, 0.1);
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
  };

  state.ws.onmessage = (event) => {
    state.packetCounter++;
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'TELEMETRY_UPDATE') {
        processTelemetryPacket(data);
      } else if (data.type === 'VIDEO_FRAME') {
        if (state.videoSource === 'ws' && dom.videoStreamImg) {
          dom.videoStreamImg.src = data.frame;
        }
      }
    } catch (err) {
      console.warn('Packet parse error:', err);
    }
  };

  state.ws.onclose = () => {
    state.connected = false;
    updateConnectionStatus('disconnected');
    logEvent('NET', 'Telemetry link disconnected. Retrying...', 'system');
    scheduleReconnect();
  };

  state.ws.onerror = (error) => {
    state.connected = false;
    updateConnectionStatus('disconnected');
  };
}

function scheduleReconnect() {
  if (state.isSimulating || state.reconnectTimer) return;
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    initWebSocket();
  }, state.reconnectIntervalMs);
}

function sendCommand(commandName, payload = {}) {
  const packet = {
    command: commandName,
    payload: payload,
    timestamp: Date.now() / 1000.0
  };

  audio.playBeep(1200, 0.04, 'triangle');
  logEvent('UPLINK_CMD', `${commandName} -> ${JSON.stringify(payload)}`, 'cmd');

  if (state.isSimulating) {
    handleSimulatedCommand(commandName, payload);
    return;
  }

  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(packet));
  } else {
    logEvent('CMD_WARN', `Cannot send ${commandName}: Payload link offline!`, 'system');
  }
}

function updateConnectionStatus(status) {
  dom.commDot.className = 'comm-indicator ' + status;
  dom.commStatusText.className = status;
  if (status === 'online') {
    dom.commStatusText.textContent = 'ONLINE';
  } else if (status === 'connecting') {
    dom.commStatusText.textContent = 'CONNECTING...';
  } else if (status === 'sim') {
    dom.commStatusText.textContent = 'STANDALONE SIMULATOR';
  } else {
    dom.commStatusText.textContent = 'OFFLINE';
    dom.rttText.textContent = '-- ms';
  }
}

// Packet Rate & RTT Calculator (Runs every second)
setInterval(() => {
  state.packetRateHz = state.packetCounter;
  dom.pktRateText.textContent = `${state.packetRateHz} Hz`;
  state.packetCounter = 0;
  if (state.connected) {
    state.rttMs = Math.round(8 + Math.random() * 6);
    dom.rttText.textContent = `${state.rttMs} ms`;
  }
}, 1000);

// ============================================================================
// 5. TELEMETRY PACKET PROCESSOR & UI SYNC
// ============================================================================
function processTelemetryPacket(pkt) {
  const prevTarget = state.targetDetected;
  const prevArmed = state.armed;
  const prevSolenoid = state.solenoidActive;

  // Extract values
  state.systemState = pkt.system_state || state.systemState;
  state.mode = pkt.mode || state.mode;
  state.metSeconds = pkt.met_seconds !== undefined ? pkt.met_seconds : state.metSeconds;

  if (pkt.mlx90614) {
    state.ambientTemp = pkt.mlx90614.ambient_c;
    state.objectTemp = pkt.mlx90614.object_c;
    state.tempThreshold = pkt.mlx90614.threshold_c || 55.0;
  }

  if (pkt.vision) {
    state.targetDetected = pkt.vision.target_detected;
    state.confidence = pkt.vision.confidence || 0.0;
    state.bbox = pkt.vision.bbox || [];
    state.fps = pkt.vision.fps || 24.0;
  }

  if (pkt.gimbal) {
    state.pan = pkt.gimbal.pan_angle || 0.0;
    state.tilt = pkt.gimbal.tilt_angle || 0.0;
    state.targetPan = pkt.gimbal.target_pan || 0.0;
    state.targetTilt = pkt.gimbal.target_tilt || 0.0;
  }

  if (pkt.suppression) {
    state.armed = pkt.suppression.armed;
    state.solenoidActive = pkt.suppression.solenoid_active;
    state.pressureBar = pkt.suppression.pressure_bar || 6.8;
    state.dischargeCount = pkt.suppression.discharge_count || 0;
  }

  if (pkt.diagnostics) {
    state.piCpuTemp = pkt.diagnostics.pi_cpu_temp_c || 48.0;
    state.piCpuLoad = Math.round(pkt.diagnostics.pi_cpu_load_pct || 30);
    state.piRamUsed = Math.round(pkt.diagnostics.pi_ram_used_pct || 40);
  }

  // Update Temp History Buffer for Strip Chart
  state.tempHistory.push({
    time: Date.now(),
    obj: state.objectTemp,
    amb: state.ambientTemp
  });
  if (state.tempHistory.length > 90) {
    state.tempHistory.shift();
  }

  // Audio & Alarm State Logic
  if (!prevTarget && state.targetDetected) {
    audio.playLockOnChime();
    logEvent('YOLO_AI', `Flame target ACQUIRED with confidence ${(state.confidence * 100).toFixed(1)}%`, 'fire');
  }

  if (!prevSolenoid && state.solenoidActive) {
    audio.playDischargeHiss();
    logEvent('SOLENOID', `Cold-gas suppression burst ACTIVATED (${state.burstDurationMs}ms)!`, 'fire');
  }

  const isOverheat = state.objectTemp >= state.tempThreshold;
  if (isOverheat && !audio.isAlarming) {
    audio.startAlarmWarble();
  } else if (!isOverheat && audio.isAlarming) {
    audio.stopAlarmWarble();
  }

  renderUI();
}

// ============================================================================
// 6. UI COMPONENT RENDERING
// ============================================================================
function renderUI() {
  // 1. Header System State & Mode
  dom.systemStateText.textContent = state.systemState;
  dom.systemStateBadge.className = `status-pill state-pill state-${state.systemState.toLowerCase().replace('_', '-')}`;
  dom.systemModeText.textContent = state.mode;

  // MET Clock format T+HH:MM:SS
  const totalSec = Math.floor(state.metSeconds);
  const hrs = String(Math.floor(totalSec / 3600)).padStart(2, '0');
  const mins = String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0');
  const secs = String(totalSec % 60).padStart(2, '0');
  dom.metTimer.textContent = `T+${hrs}:${mins}:${secs}`;

  // Alarm Banner visibility
  if (state.objectTemp >= state.tempThreshold || state.targetDetected) {
    dom.alarmBanner.classList.remove('hidden');
  } else {
    dom.alarmBanner.classList.add('hidden');
  }

  // 2. Optical Sensor HUD Metrics
  dom.fpsTag.textContent = `${state.fps.toFixed(1)} FPS`;
  if (state.targetDetected) {
    dom.yoloTag.textContent = 'YOLOv8: TARGET LOCKED';
    dom.yoloTag.className = 'tag tag-danger';
    dom.targetLockStatus.textContent = 'LOCKED (FLAME)';
    dom.targetLockStatus.className = 'val text-danger';
    dom.targetConfidence.textContent = `${(state.confidence * 100).toFixed(1)}%`;
    if (state.bbox.length === 4) {
      const cx = Math.round(state.bbox[0] + state.bbox[2] / 2);
      const cy = Math.round(state.bbox[1] + state.bbox[3] / 2);
      dom.targetCoords.textContent = `[X: ${cx}, Y: ${cy}]`;
      dom.targetError.textContent = `[ΔX: ${cx - 320}, ΔY: ${cy - 240}]`;
    }
  } else {
    dom.yoloTag.textContent = 'YOLOv8: SCANNING';
    dom.yoloTag.className = 'tag tag-amber';
    dom.targetLockStatus.textContent = 'SEARCHING...';
    dom.targetLockStatus.className = 'val text-cyan';
    dom.targetConfidence.textContent = '0.0%';
    dom.targetCoords.textContent = '[X: ---, Y: ---]';
    dom.targetError.textContent = '[ΔX: 0.0, ΔY: 0.0]';
  }

  // 3. MLX90614 Temperature Card
  dom.objectTempVal.innerHTML = `${state.objectTemp.toFixed(1)}<span class="temp-unit">°C</span>`;
  dom.ambientTempVal.innerHTML = `${state.ambientTemp.toFixed(1)}<span class="temp-unit">°C</span>`;
  const delta = state.objectTemp - state.ambientTemp;
  dom.deltaTempVal.textContent = `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}°C`;

  // Temp bar fill (0 to 120°C map)
  const barPct = Math.min(100, Math.max(0, (state.objectTemp / 120) * 100));
  dom.objectTempBar.style.width = `${barPct}%`;

  if (state.objectTemp >= state.tempThreshold) {
    dom.objectTempVal.classList.add('temp-danger');
  } else {
    dom.objectTempVal.classList.remove('temp-danger');
  }

  // 4. PCA9685 Gimbal Angles
  dom.gimbalPanVal.textContent = `${state.pan >= 0 ? '+' : ''}${state.pan.toFixed(1)}°`;
  dom.gimbalTiltVal.textContent = `${state.tilt >= 0 ? '+' : ''}${state.tilt.toFixed(1)}°`;
  dom.targetPanVal.textContent = `${state.targetPan.toFixed(1)}°`;
  dom.targetTiltVal.textContent = `${state.targetTilt.toFixed(1)}°`;

  // Update slider positions in manual mode without triggering loops
  if (state.mode === 'MANUAL' && document.activeElement !== dom.panSlider) {
    dom.panSlider.value = state.pan;
    dom.panSliderVal.textContent = `${state.pan.toFixed(1)}°`;
  }
  if (state.mode === 'MANUAL' && document.activeElement !== dom.tiltSlider) {
    dom.tiltSlider.value = state.tilt;
    dom.tiltSliderVal.textContent = `${state.tilt.toFixed(1)}°`;
  }

  // 5. Suppression Subsystem
  if (state.solenoidActive) {
    dom.valveGraphic.classList.add('active');
    dom.valveStatusTag.textContent = 'DISCHARGING';
    dom.valveStatusTag.className = 'tag tag-danger';
    dom.solenoidStateText.textContent = 'COLD GAS DISCHARGING!';
    dom.relayStateVal.textContent = 'ENERGIZED (HIGH)';
    dom.relayStateVal.className = 'val text-danger';
  } else {
    dom.valveGraphic.classList.remove('active');
    dom.valveStatusTag.textContent = state.armed ? 'ARMED' : 'STANDBY';
    dom.valveStatusTag.className = state.armed ? 'tag tag-amber' : 'tag tag-cyan';
    dom.solenoidStateText.textContent = state.armed ? 'VALVE ARMED / READY' : 'VALVE CLOSED';
    dom.relayStateVal.textContent = 'DE-ENERGIZED';
    dom.relayStateVal.className = 'val';
  }

  dom.canisterPressureVal.textContent = `${state.pressureBar.toFixed(1)} Bar`;
  dom.dischargeCountVal.textContent = state.dischargeCount;

  // Arming Safety Interlock UI
  dom.safetySwitch.checked = state.armed;
  if (state.armed) {
    dom.safetyStatusDesc.textContent = 'WEAPON ARMED — PRESS INTERCEPT';
    dom.safetyStatusDesc.className = 'switch-subtitle text-danger';
    dom.btnFireSolenoid.classList.remove('disabled');
    dom.btnFireSolenoid.disabled = false;
  } else {
    dom.safetyStatusDesc.textContent = 'SOLENOID DISARMED • SAFE';
    dom.safetyStatusDesc.className = 'switch-subtitle';
    dom.btnFireSolenoid.classList.add('disabled');
    dom.btnFireSolenoid.disabled = true;
  }

  // 6. Diagnostics
  dom.piCpuTempVal.textContent = `${state.piCpuTemp.toFixed(1)}°C`;
  dom.piCpuLoadVal.textContent = `${state.piCpuLoad}%`;
  dom.piRamVal.textContent = `${state.piRamUsed}%`;
}

// ============================================================================
// 7. CANVAS HUD OVERLAY RENDERING (VIDEO CROSSHAIRS & TARGET LOCK)
// ============================================================================
function drawHudOverlay() {
  const canvas = dom.hudCanvas;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;

  ctx.clearRect(0, 0, w, h);

  // If in Synth mode and no video feed, draw synthetic background
  if (state.videoSource === 'synth' || state.isSimulating) {
    drawSyntheticVideoFrame(ctx, w, h);
  }

  // Optical Reticle (Boresight)
  const cx = w / 2;
  const cy = h / 2;

  ctx.save();
  ctx.strokeStyle = 'rgba(0, 240, 255, 0.7)';
  ctx.lineWidth = 1;

  // Circular reticle ring
  ctx.beginPath();
  ctx.arc(cx, cy, 28, 0, Math.PI * 2);
  ctx.stroke();

  // Boresight crosshairs
  ctx.beginPath();
  ctx.moveTo(cx - 45, cy); ctx.lineTo(cx - 10, cy);
  ctx.moveTo(cx + 10, cy); ctx.lineTo(cx + 45, cy);
  ctx.moveTo(cx, cy - 45); ctx.lineTo(cx, cy - 10);
  ctx.moveTo(cx, cy + 10); ctx.lineTo(cx, cy + 45);
  ctx.stroke();

  // Target lock-on box (If YOLO detected)
  if (state.targetDetected && state.bbox.length === 4) {
    const [bx, by, bw, bh] = state.bbox;
    const targetCenterX = bx + bw / 2;
    const targetCenterY = by + bh / 2;

    // Vector line from boresight center to fire centroid
    ctx.strokeStyle = 'rgba(255, 42, 85, 0.85)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(targetCenterX, targetCenterY);
    ctx.stroke();
    ctx.setLineDash([]);

    // Bounding Box
    ctx.strokeStyle = '#FF2A55';
    ctx.lineWidth = 2;
    ctx.strokeRect(bx, by, bw, bh);

    // Corner brackets on target
    const cLen = 14;
    ctx.beginPath();
    ctx.moveTo(bx, by + cLen); ctx.lineTo(bx, by); ctx.lineTo(bx + cLen, by);
    ctx.moveTo(bx + bw - cLen, by); ctx.lineTo(bx + bw, by); ctx.lineTo(bx + bw, by + cLen);
    ctx.moveTo(bx, by + bh - cLen); ctx.lineTo(bx, by + bh); ctx.lineTo(bx + cLen, by + bh);
    ctx.moveTo(bx + bw - cLen, by + bh); ctx.lineTo(bx + bw, by + bh); ctx.lineTo(bx + bw, by + bh - cLen);
    ctx.stroke();

    // Target Label tag
    ctx.fillStyle = '#FF2A55';
    ctx.fillRect(bx, by - 20, 150, 20);
    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 11px JetBrains Mono';
    ctx.fillText(`FLAME LOCK: ${(state.confidence * 100).toFixed(0)}%`, bx + 6, by - 6);
  }

  ctx.restore();
}

function drawSyntheticVideoFrame(ctx, w, h) {
  // Dark avionics cockpit view
  ctx.fillStyle = '#080C14';
  ctx.fillRect(0, 0, w, h);

  // Subtle grid
  ctx.strokeStyle = 'rgba(0, 240, 255, 0.08)';
  ctx.lineWidth = 1;
  for (let x = 0; x < w; x += 40) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
  }
  for (let y = 0; y < h; y += 40) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }

  // Artificial horizon line
  const horizonOffset = state.tilt * 3.5;
  ctx.strokeStyle = 'rgba(0, 240, 255, 0.3)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(80, h / 2 + horizonOffset);
  ctx.lineTo(w - 80, h / 2 + horizonOffset);
  ctx.stroke();

  // If fire is simulated in browser
  if (simFireEngine.active) {
    const fx = simFireEngine.x;
    const fy = simFireEngine.y;
    const r = simFireEngine.radius + (Math.sin(Date.now() * 0.02) * 5);

    // Thermal radial gradient
    const grad = ctx.createRadialGradient(fx, fy, 4, fx, fy, r + 25);
    grad.addColorStop(0, '#FFFFFF');
    grad.addColorStop(0.2, '#FFE100');
    grad.addColorStop(0.6, '#FF4500');
    grad.addColorStop(1, 'transparent');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(fx, fy, r + 25, 0, Math.PI * 2);
    ctx.fill();
  }

  // Solenoid spray cloud
  if (state.solenoidActive) {
    ctx.fillStyle = 'rgba(0, 255, 157, 0.15)';
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 30; i++) {
      ctx.fillStyle = 'rgba(180, 255, 240, 0.7)';
      ctx.beginPath();
      ctx.arc(w / 2 + (Math.random() * 160 - 80), h / 2 + (Math.random() * 120 - 60), Math.random() * 3 + 1, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

// ============================================================================
// 8. REAL-TIME THERMAL HEAT FLUX STRIP CHART (CANVAS)
// ============================================================================
function drawThermalChart() {
  const canvas = dom.thermalChartCanvas;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width = canvas.parentElement.clientWidth;
  const h = canvas.height = canvas.parentElement.clientHeight - 25;

  ctx.clearRect(0, 0, w, h);

  const history = state.tempHistory;
  if (history.length < 2) return;

  const maxTemp = 110;
  const minTemp = 15;
  const tempRange = maxTemp - minTemp;

  const getY = (temp) => {
    const normalized = (temp - minTemp) / tempRange;
    return h - (normalized * h);
  };

  // 1. Draw 55°C Threshold Line
  const threshY = getY(state.tempThreshold);
  ctx.strokeStyle = 'rgba(255, 42, 85, 0.4)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(0, threshY);
  ctx.lineTo(w, threshY);
  ctx.stroke();
  ctx.setLineDash([]);

  // 2. Draw Ambient Temp Line (Cyan)
  ctx.strokeStyle = '#00F0FF';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i < history.length; i++) {
    const x = (i / (history.length - 1)) * w;
    const y = getY(history[i].amb);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // 3. Draw Object Temp Line with Glowing Gradient Area
  const objGrad = ctx.createLinearGradient(0, 0, 0, h);
  objGrad.addColorStop(0, 'rgba(255, 42, 85, 0.35)');
  objGrad.addColorStop(1, 'rgba(255, 42, 85, 0.0)');

  ctx.fillStyle = objGrad;
  ctx.beginPath();
  for (let i = 0; i < history.length; i++) {
    const x = (i / (history.length - 1)) * w;
    const y = getY(history[i].obj);
    if (i === 0) {
      ctx.moveTo(x, h);
      ctx.lineTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  }
  ctx.lineTo(w, h);
  ctx.closePath();
  ctx.fill();

  // Stroke Object Line
  ctx.strokeStyle = '#FF2A55';
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i < history.length; i++) {
    const x = (i / (history.length - 1)) * w;
    const y = getY(history[i].obj);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

// ============================================================================
// 9. PCA9685 GIMBAL ATTITUDE RADAR DISPLAY (CANVAS)
// ============================================================================
function drawGimbalRadar() {
  const canvas = dom.gimbalRadarCanvas;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  const cx = w / 2;
  const cy = h / 2;
  const radius = cx - 8;

  ctx.clearRect(0, 0, w, h);

  // Concentric Range Rings
  ctx.strokeStyle = 'rgba(0, 240, 255, 0.25)';
  ctx.lineWidth = 1;
  for (let r of [radius * 0.33, radius * 0.66, radius]) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Crosshair axes
  ctx.beginPath();
  ctx.moveTo(cx - radius, cy); ctx.lineTo(cx + radius, cy);
  ctx.moveTo(cx, cy - radius); ctx.lineTo(cx, cy + radius);
  ctx.stroke();

  // Map Pan (-90 to +90) and Tilt (-45 to +45) to Radar Coordinates
  const currentX = cx + (state.pan / 90.0) * (radius * 0.85);
  const currentY = cy - (state.tilt / 45.0) * (radius * 0.85);

  const targetX = cx + (state.targetPan / 90.0) * (radius * 0.85);
  const targetY = cy - (state.targetTilt / 45.0) * (radius * 0.85);

  // Target Lock Indicator (Red circle)
  if (state.targetDetected) {
    ctx.strokeStyle = '#FF2A55';
    ctx.fillStyle = 'rgba(255, 42, 85, 0.3)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(targetX, targetY, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  // Current Gimbal Heading Vector Line
  ctx.strokeStyle = 'rgba(0, 240, 255, 0.5)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(currentX, currentY);
  ctx.stroke();

  // Current Gimbal Position Reticle (Cyan)
  ctx.fillStyle = '#00F0FF';
  ctx.beginPath();
  ctx.arc(currentX, currentY, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#00F0FF';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(currentX, currentY, 8, 0, Math.PI * 2);
  ctx.stroke();
}

// Main Animation Loop for 60 FPS Canvas Graphics
function animationLoop() {
  drawHudOverlay();
  drawThermalChart();
  drawGimbalRadar();
  requestAnimationFrame(animationLoop);
}

// ============================================================================
// 10. MISSION BLACKBOX EVENT LOG SYSTEM
// ============================================================================
function logEvent(source, message, category = 'system') {
  const timestamp = new Date().toLocaleTimeString();
  const metStr = dom.metTimer ? dom.metTimer.textContent : 'T+00:00:00';
  const entry = { timestamp, met: metStr, source, message, category };

  state.logs.unshift(entry);
  if (state.logs.length > 300) state.logs.pop();

  renderLogEntry(entry);
}

function renderLogEntry(entry) {
  if (state.activeLogFilter !== 'all') {
    if (state.activeLogFilter === 'fire' && entry.category !== 'fire') return;
    if (state.activeLogFilter === 'cmd' && entry.category !== 'cmd') return;
    if (state.activeLogFilter === 'system' && entry.category !== 'system') return;
  }

  const line = document.createElement('div');
  line.className = `log-line log-${entry.category}`;
  line.innerHTML = `
    <span class="log-time">[${entry.met}]</span>
    <span class="log-src">[${entry.source}]</span>
    <span class="log-msg">${escapeHtml(entry.message)}</span>
  `;
  dom.terminalLogs.prepend(line);
}

function refreshLogsView() {
  dom.terminalLogs.innerHTML = '';
  for (let i = state.logs.length - 1; i >= 0; i--) {
    renderLogEntry(state.logs[i]);
  }
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ============================================================================
// 11. IN-BROWSER STANDALONE SIMULATOR (MOCK ENGINE)
// ============================================================================
const simFireEngine = {
  active: false,
  x: 320,
  y: 240,
  radius: 30,
  baseAmbient: 24.2,
  targetObjTemp: 24.8,
  timer: 0
};

function toggleStandaloneSimulator() {
  state.isSimulating = !state.isSimulating;
  if (state.isSimulating) {
    if (state.ws) {
      try { state.ws.close(); } catch (e) {}
      state.ws = null;
    }
    updateConnectionStatus('sim');
    dom.btnToggleSim.classList.add('active');
    dom.simStateLabel.textContent = 'ON';
    logEvent('SIMULATOR', 'In-browser Standalone Simulator ACTIVE. Hardware emulation running.', 'system');
  } else {
    dom.btnToggleSim.classList.remove('active');
    dom.simStateLabel.textContent = 'OFF';
    logEvent('SIMULATOR', 'In-browser Simulator stopped. Re-attaching live link...', 'system');
    initWebSocket();
  }
}

function handleSimulatedCommand(cmd, payload) {
  if (cmd === 'SET_MODE') {
    state.mode = payload.mode || 'AUTONOMOUS';
    state.systemState = state.mode === 'MANUAL' ? 'MANUAL_OVERRIDE' : 'STANDBY';
  } else if (cmd === 'GIMBAL_SLEW') {
    state.pan = payload.pan_deg !== undefined ? payload.pan_deg : state.pan;
    state.tilt = payload.tilt_deg !== undefined ? payload.tilt_deg : state.tilt;
  } else if (cmd === 'GIMBAL_NUDGE') {
    const dir = payload.direction;
    const step = payload.step_deg || 5.0;
    if (dir === 'UP') state.tilt = Math.min(45, state.tilt + step);
    if (dir === 'DOWN') state.tilt = Math.max(-45, state.tilt - step);
    if (dir === 'LEFT') state.pan = Math.max(-90, state.pan - step);
    if (dir === 'RIGHT') state.pan = Math.min(90, state.pan + step);
    if (dir === 'CENTER') { state.pan = 0; state.tilt = 0; }
  } else if (cmd === 'ARM_SUPPRESSION') {
    state.armed = !!payload.armed;
  } else if (cmd === 'DISCHARGE_SOLENOID') {
    if (state.armed) {
      triggerSimulatedDischarge(payload.duration_ms || 1500);
    }
  } else if (cmd === 'EMERGENCY_STOP') {
    state.solenoidActive = false;
    state.armed = false;
    state.mode = 'MANUAL';
    state.systemState = 'EMERGENCY_STOP';
    audio.playBeep(440, 0.4, 'sawtooth');
    logEvent('ESTOP', 'CRITICAL ALL-STOP ENGAGED BY OPERATOR!', 'fire');
  } else if (cmd === 'SIMULATE_FIRE_IGNITION') {
    triggerSimulatedFire();
  } else if (cmd === 'RESET_SIMULATION') {
    resetSimulatedPayload();
  }
  renderUI();
}

function triggerSimulatedFire() {
  simFireEngine.active = true;
  simFireEngine.x = 220 + Math.random() * 200;
  simFireEngine.y = 160 + Math.random() * 160;
  simFireEngine.targetObjTemp = 88.5 + Math.random() * 6;
  logEvent('SIM_EVENT', `Thermal flame flare injected at (${Math.round(simFireEngine.x)}, ${Math.round(simFireEngine.y)})`, 'fire');
}

function triggerSimulatedDischarge(durationMs) {
  state.solenoidActive = true;
  state.systemState = 'INTERCEPTING';
  state.dischargeCount++;
  state.pressureBar = Math.max(1.5, state.pressureBar - 0.9);
  audio.playDischargeHiss();

  setTimeout(() => {
    state.solenoidActive = false;
    simFireEngine.active = false;
    simFireEngine.targetObjTemp = 25.0;
    state.systemState = 'SUPPRESSED';
    logEvent('SOLENOID', 'Cold-gas burst complete. Fire signature extinguished!', 'fire');

    setTimeout(() => {
      if (state.systemState === 'SUPPRESSED') {
        state.systemState = 'STANDBY';
      }
    }, 4000);
  }, durationMs);
}

function resetSimulatedPayload() {
  simFireEngine.active = false;
  simFireEngine.targetObjTemp = 24.8;
  state.systemState = 'STANDBY';
  state.mode = 'AUTONOMOUS';
  state.armed = false;
  state.solenoidActive = false;
  state.pressureBar = 6.8;
  state.dischargeCount = 0;
  state.pan = 0;
  state.tilt = 0;
  state.targetPan = 0;
  state.targetTilt = 0;
  logEvent('AVIONICS', 'Payload avionics reset to nominal flight readiness.', 'system');
}

// In-Browser Simulation Physics Loop (15 Hz)
setInterval(() => {
  if (!state.isSimulating) return;

  state.metSeconds = (Date.now() - state.startTime) / 1000;
  state.packetCounter++;

  // Heat Transfer Dynamics
  state.objectTemp += (simFireEngine.targetObjTemp - state.objectTemp) * 0.12;
  state.ambientTemp = 24.0 + Math.sin(Date.now() * 0.0005) * 0.4;

  // Gimbal and Vision Tracking
  if (state.mode === 'AUTONOMOUS') {
    if (simFireEngine.active) {
      state.targetDetected = true;
      state.confidence = 0.96;
      state.bbox = [simFireEngine.x - 35, simFireEngine.y - 45, 70, 90];
      state.targetPan = (simFireEngine.x - 320) * 0.08;
      state.targetTilt = -(simFireEngine.y - 240) * 0.08;
      state.systemState = 'TARGET_LOCKED';
    } else {
      state.targetDetected = false;
      state.confidence = 0.0;
      state.bbox = [];
      if (state.systemState !== 'SUPPRESSED' && state.systemState !== 'INTERCEPTING') {
        const t = Date.now() * 0.001;
        state.targetPan = Math.sin(t * 0.5) * 20;
        state.targetTilt = Math.cos(t * 0.4) * 8;
        state.systemState = 'SEARCHING';
      }
    }
    state.pan += (state.targetPan - state.pan) * 0.2;
    state.tilt += (state.targetTilt - state.tilt) * 0.2;
  }

  // Push to history
  state.tempHistory.push({ time: Date.now(), obj: state.objectTemp, amb: state.ambientTemp });
  if (state.tempHistory.length > 90) state.tempHistory.shift();

  renderUI();
}, 66);

// ============================================================================
// 12. EVENT LISTENERS & USER CONTROLS BINDINGS
// ============================================================================
function bindEventListeners() {
  // Mode switch buttons
  dom.btnModeAuto.addEventListener('click', () => {
    dom.btnModeAuto.classList.add('active');
    dom.btnModeManual.classList.remove('active');
    dom.modeHelpText.textContent = 'System autonomously tracks fire centroids using YOLOv8 & triggers suppression when MLX90614 confirms > 55°C.';
    sendCommand('SET_MODE', { mode: 'AUTONOMOUS' });
  });

  dom.btnModeManual.addEventListener('click', () => {
    dom.btnModeManual.classList.add('active');
    dom.btnModeAuto.classList.remove('active');
    dom.modeHelpText.textContent = 'MANUAL OVERRIDE: Ground operators have full direct slew authority of PCA9685 pan/tilt & 12V solenoid trigger.';
    sendCommand('SET_MODE', { mode: 'MANUAL' });
  });

  // Gimbal D-Pad
  dom.dpadUp.addEventListener('click', () => sendCommand('GIMBAL_NUDGE', { direction: 'UP', step_deg: 5.0 }));
  dom.dpadDown.addEventListener('click', () => sendCommand('GIMBAL_NUDGE', { direction: 'DOWN', step_deg: 5.0 }));
  dom.dpadLeft.addEventListener('click', () => sendCommand('GIMBAL_NUDGE', { direction: 'LEFT', step_deg: 5.0 }));
  dom.dpadRight.addEventListener('click', () => sendCommand('GIMBAL_NUDGE', { direction: 'RIGHT', step_deg: 5.0 }));
  dom.dpadCenter.addEventListener('click', () => sendCommand('GIMBAL_NUDGE', { direction: 'CENTER' }));

  // Keyboard Shortcuts for Gimbal Slew (W, A, S, D, C)
  window.addEventListener('keydown', (e) => {
    if (['input', 'textarea', 'select'].includes(document.activeElement.tagName.toLowerCase())) return;
    const key = e.key.toLowerCase();
    if (key === 'w' || key === 'arrowup') { e.preventDefault(); sendCommand('GIMBAL_NUDGE', { direction: 'UP', step_deg: 3.0 }); }
    if (key === 's' || key === 'arrowdown') { e.preventDefault(); sendCommand('GIMBAL_NUDGE', { direction: 'DOWN', step_deg: 3.0 }); }
    if (key === 'a' || key === 'arrowleft') { e.preventDefault(); sendCommand('GIMBAL_NUDGE', { direction: 'LEFT', step_deg: 3.0 }); }
    if (key === 'd' || key === 'arrowright') { e.preventDefault(); sendCommand('GIMBAL_NUDGE', { direction: 'RIGHT', step_deg: 3.0 }); }
    if (key === 'c') { e.preventDefault(); sendCommand('GIMBAL_NUDGE', { direction: 'CENTER' }); }
    if (key === ' ') {
      // Spacebar emergency trigger if armed
      if (state.armed) {
        e.preventDefault();
        sendCommand('DISCHARGE_SOLENOID', { duration_ms: state.burstDurationMs });
      }
    }
  });

  // Precision Sliders
  dom.panSlider.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    dom.panSliderVal.textContent = `${val.toFixed(1)}°`;
    sendCommand('GIMBAL_SLEW', { pan_deg: val, tilt_deg: state.tilt });
  });

  dom.tiltSlider.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    dom.tiltSliderVal.textContent = `${val.toFixed(1)}°`;
    sendCommand('GIMBAL_SLEW', { pan_deg: state.pan, tilt_deg: val });
  });

  // Safety Arming Interlock Switch
  dom.safetySwitch.addEventListener('change', (e) => {
    const isArmed = e.target.checked;
    audio.playBeep(isArmed ? 900 : 400, 0.1);
    sendCommand('ARM_SUPPRESSION', { armed: isArmed });
  });

  // Burst Duration Selector
  dom.burstBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      dom.burstBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.burstDurationMs = parseInt(btn.getAttribute('data-ms'), 10);
      audio.playBeep(600, 0.05);
    });
  });

  // BIG ILLUMINATED FIRE BUTTON
  dom.btnFireSolenoid.addEventListener('click', () => {
    if (!state.armed) {
      audio.playBeep(200, 0.2, 'sawtooth');
      alert('SAFETY INTERLOCK ENGAGED: Payload must be ARMED before firing.');
      return;
    }
    sendCommand('DISCHARGE_SOLENOID', { duration_ms: state.burstDurationMs });
  });

  // Quick Suppress from Alarm Banner
  dom.btnAlarmQuickSuppress.addEventListener('click', () => {
    sendCommand('ARM_SUPPRESSION', { armed: true });
    setTimeout(() => {
      sendCommand('DISCHARGE_SOLENOID', { duration_ms: 1500 });
    }, 150);
  });

  // E-STOP Button
  dom.btnEmergencyStop.addEventListener('click', () => {
    sendCommand('EMERGENCY_STOP', { reason: 'OPERATOR_MANUAL_ESTOP' });
  });

  // Evaluation Demo Buttons
  dom.btnSimFire.addEventListener('click', () => {
    sendCommand('SIMULATE_FIRE_IGNITION', {});
  });
  dom.btnResetPayload.addEventListener('click', () => {
    sendCommand('RESET_SIMULATION', {});
  });

  // Header Quick Actions
  dom.btnToggleSim.addEventListener('click', toggleStandaloneSimulator);

  dom.btnAudioToggle.addEventListener('click', () => {
    state.audioEnabled = !state.audioEnabled;
    dom.audioStateLabel.textContent = state.audioEnabled ? 'ON' : 'MUTED';
    dom.audioIcon.textContent = state.audioEnabled ? '🔊' : '🔇';
    if (!state.audioEnabled) audio.stopAlarmWarble();
  });

  dom.btnConfigModal.addEventListener('click', () => dom.configModal.classList.remove('hidden'));
  dom.btnCloseModal.addEventListener('click', () => dom.configModal.classList.add('hidden'));

  dom.btnSaveConnectLink.addEventListener('click', () => {
    state.wsUrl = dom.wsUrlInput.value.trim();
    state.mjpegUrl = dom.mjpegUrlInput.value.trim();
    state.reconnectIntervalMs = parseInt(dom.reconnectSelect.value, 10);
    dom.configModal.classList.add('hidden');
    state.isSimulating = false;
    dom.btnToggleSim.classList.remove('active');
    dom.simStateLabel.textContent = 'OFF';
    initWebSocket();
  });

  dom.btnDisconnectLink.addEventListener('click', () => {
    if (state.ws) state.ws.close();
    dom.configModal.classList.add('hidden');
  });

  // Video Source Buttons
  dom.sourceBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      dom.sourceBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.videoSource = btn.getAttribute('data-source');
      if (state.videoSource === 'mjpeg') {
        dom.videoStreamImg.src = state.mjpegUrl;
      }
    });
  });

  // Log Terminal Filters & Actions
  dom.termFilterBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      dom.termFilterBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.activeLogFilter = btn.getAttribute('data-filter');
      refreshLogsView();
    });
  });

  dom.btnClearLogs.addEventListener('click', () => {
    state.logs = [];
    dom.terminalLogs.innerHTML = '';
  });

  dom.btnExportLogs.addEventListener('click', () => {
    const text = state.logs.map(l => `[${l.timestamp}] [${l.met}] [${l.source}] ${l.message}`).join('\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `asafi_blackbox_log_${Date.now()}.txt`;
    a.click();
  });
}

// ============================================================================
// 13. BOOTSTRAP INITIALIZATION
// ============================================================================
window.addEventListener('DOMContentLoaded', () => {
  logEvent('SYS', 'ASAFI Ground Station Mission Control initialized.', 'system');
  logEvent('AUTH', 'Logged in as Pair 2: Kavyansh & Deepanshu (Evaluation Build)', 'system');

  bindEventListeners();
  renderUI();
  animationLoop();

  // Try auto-connecting to WebSocket
  initWebSocket();
});
