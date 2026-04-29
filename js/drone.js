// ============================================================
// drone.js — State machine + physics (auto & manual modes)
// ============================================================

class Drone {
  constructor(start) {
    this.startPos         = { ...start };
    this.position         = { ...start };
    this.battery          = 100;
    this.fuelLiters       = CONFIG.FUEL_CAPACITY;
    this.status           = STATUS.IDLE;
    this.mode             = 'AUTO';
    this.altitude         = CONFIG.DRONE_FLY_HEIGHT;
    this.missionPriority  = CONFIG.PRIORITY.MEDIUM;
    this.threatIntensity  = 0;        // 0–1, updated per step
    this.path             = [];
    this.fullPath         = [];
    this.trail            = [];
    this.stepsCompleted   = 0;
    this.inThreatZone     = false;
    this.threatWarning    = false;
    this.missionTime      = 0;
    this._missionTimer    = null;
    this.replanCount      = 0;
  }

  // ── Specs ────────────────────────────────────────────────────

  static computeSpecs(specs) {
    const { battery_mah, voltage, motor_power, speed_ms, cell_size_m, payload_kg } = specs;
    const effectivePower = motor_power * (1 + payload_kg * 0.15);
    // Payload reduces effective speed
    const effectiveSpeed = speed_ms / (1 + payload_kg * 0.25);
    const energyWh       = (battery_mah * voltage) / 1000;
    const flightTimeMin  = (energyWh / effectivePower) * 60;
    const flightTimeSec  = flightTimeMin * 60;
    const maxRangeM      = effectiveSpeed * flightTimeSec;
    const maxSteps       = Math.max(1, Math.floor(maxRangeM / cell_size_m));
    const drainPerStep   = 100 / maxSteps;
    const stepDurMs      = Math.max(60, Math.round((cell_size_m / effectiveSpeed) * 1000));
    const fuelPerStep    = (effectivePower / 1000) * (stepDurMs / 3600) * 0.25;
    return { effectivePower, energyWh, flightTimeMin, flightTimeSec,
             maxRangeM, maxSteps, drainPerStep, stepDurMs, fuelPerStep, effectiveSpeed };
  }

  static applySpecs(specs) {
    const result = Drone.computeSpecs(specs);
    CONFIG.BATTERY_DRAIN_NORMAL = result.drainPerStep;
    CONFIG.BATTERY_DRAIN_THREAT = result.drainPerStep * 3;
    CONFIG.MOVE_INTERVAL_MS     = result.stepDurMs;
    CONFIG.PAYLOAD_TYPE         = specs.payload_type || 'NORMAL';
    CONFIG.FUEL_DRAIN_NORMAL    = result.fuelPerStep;
    CONFIG.FUEL_DRAIN_THREAT    = result.fuelPerStep * 3;
    CONFIG.FUEL_DRAIN_URBAN     = result.fuelPerStep * 2;
    return result;
  }

  // ── Auto-pilot ───────────────────────────────────────────────

  loadPath(path) {
    this.path     = path.slice(1).map(p => ({ ...p }));
    this.fullPath = path.map(p => ({ ...p }));
    this.status   = STATUS.NAVIGATING;
    this._startTimer();
  }

  step() {
    if (this.status !== STATUS.NAVIGATING) return false;
    if (this.path.length === 0)            return false;
    this._advancePosition(this.path.shift());
    return true;
  }

  // ── Manual control ───────────────────────────────────────────

  manualStep(dx, dy) {
    if (this.status === STATUS.REACHED || this.status === STATUS.FAILED) return false;

    const nx = this.position.x + dx;
    const ny = this.position.y + dy;
    if (nx < 0 || ny < 0 || nx >= CONFIG.GRID_COLS || ny >= CONFIG.GRID_ROWS) return false;

    if (window._grid) {
      const cellType = window._grid.get(nx, ny);
      if (cellType === CONFIG.CELL.OBSTACLE || cellType === CONFIG.CELL.URBAN) {
        const obsH         = window._grid.getObstacleHeight(nx, ny);
        const minAltNeeded = obsH + CONFIG.OBSTACLE_FLY_CLEARANCE;
        if (this.altitude < minAltNeeded) return 'blocked';
      }
    }

    if (this.status === STATUS.IDLE) this._startTimer();
    this._advancePosition({ x: nx, y: ny });
    return true;
  }

  adjustAltitude(delta) {
    this.altitude = Math.max(CONFIG.DRONE_MIN_ALT,
                    Math.min(CONFIG.DRONE_MAX_ALT, this.altitude + delta));
  }

  // ── Shared movement core ─────────────────────────────────────

  _advancePosition(newPos) {
    this.trail.push({ ...this.position });
    if (this.trail.length > CONFIG.TRAIL_LENGTH) this.trail.shift();

    this.position = { ...newPos };
    this.stepsCompleted++;

    const cellType = window._grid ? window._grid.get(newPos.x, newPos.y) : CONFIG.CELL.EMPTY;
    const { CELL } = CONFIG;

    const inThreat = cellType === CELL.THREAT;
    const inUrban  = cellType === CELL.URBAN;
    this.inThreatZone = inThreat;

    // Threat intensity — blend live ThreatManager intensity with cell-based flag
    let intensityTarget = 0;
    if (inThreat) {
      const dynIntensity = window._threatManager
        ? window._threatManager.getThreatAt(newPos.x, newPos.y)
        : 0;
      intensityTarget = Math.max(0.4, dynIntensity);
      this.threatWarning = true;
      setTimeout(() => { this.threatWarning = false; }, 600);
    }
    // Smooth intensity convergence
    if (intensityTarget > this.threatIntensity) {
      this.threatIntensity = Math.min(1, this.threatIntensity + 0.35);
    } else {
      this.threatIntensity = Math.max(0, this.threatIntensity - 0.2);
    }

    // Battery drain — scaled by real threat intensity
    const intensityScale = inThreat ? Math.max(1, 1 + this.threatIntensity * 2) : 1;
    const battDrain = inThreat
      ? CONFIG.BATTERY_DRAIN_THREAT * intensityScale
      : CONFIG.BATTERY_DRAIN_NORMAL;
    this.battery = Math.max(0, this.battery - battDrain);

    // Fuel drain (kept for logic compatibility but no longer fails mission)
    const fuelDrain = inThreat  ? CONFIG.FUEL_DRAIN_THREAT  * intensityScale
                    : inUrban   ? CONFIG.FUEL_DRAIN_URBAN
                    :             CONFIG.FUEL_DRAIN_NORMAL;
    this.fuelLiters = Math.max(0, this.fuelLiters - fuelDrain);

    if (this.battery <= 0) {
      this.status = STATUS.FAILED;
      this._stopTimer();
      return;
    }

    const tgt = window._grid ? window._grid.target : null;
    if (tgt && newPos.x === tgt.x && newPos.y === tgt.y) {
      this.status = STATUS.REACHED;
      this._stopTimer();
      if (CONFIG.PAYLOAD_TYPE === 'EXPLOSIVE' && window._renderer) {
        window._renderer.triggerExplosion(newPos.x, newPos.y);
      }
      return;
    }

    if (this.mode === 'AUTO' && this.path.length === 0) {
      this.status = STATUS.REACHED;
      this._stopTimer();
      if (CONFIG.PAYLOAD_TYPE === 'EXPLOSIVE' && window._renderer) {
        window._renderer.triggerExplosion(newPos.x, newPos.y);
      }
    } else {
      this.status = STATUS.NAVIGATING;
    }
  }

  // ── Reset ────────────────────────────────────────────────────

  reset() {
    this._stopTimer();
    this.position        = { ...this.startPos };
    this.battery         = 100;
    this.fuelLiters      = CONFIG.FUEL_CAPACITY;
    this.status          = STATUS.IDLE;
    this.mode            = 'AUTO';
    this.altitude        = CONFIG.DRONE_FLY_HEIGHT;
    this.missionPriority = CONFIG.PRIORITY.MEDIUM;
    this.threatIntensity = 0;
    this.path            = [];
    this.fullPath        = [];
    this.trail           = [];
    this.stepsCompleted  = 0;
    this.inThreatZone    = false;
    this.threatWarning   = false;
    this.missionTime     = 0;
    this.replanCount     = 0;
  }

  updateStart(pos) { this.startPos = { ...pos }; this.position = { ...pos }; }

  _startTimer() { this._stopTimer(); this._missionTimer = setInterval(() => { this.missionTime++; }, 1000); }
  _stopTimer()  { if (this._missionTimer) { clearInterval(this._missionTimer); this._missionTimer = null; } }

  get isNavigating() { return this.status === STATUS.NAVIGATING; }
  get isIdle()       { return this.status === STATUS.IDLE; }
  get isDone()       { return this.status === STATUS.REACHED || this.status === STATUS.FAILED; }
  get batteryClass() { return this.battery > 60 ? 'high' : this.battery > 30 ? 'mid' : 'low'; }
  get fuelClass()    { return this.fuelLiters > CONFIG.FUEL_CAPACITY * 0.6 ? 'high'
                            : this.fuelLiters > CONFIG.FUEL_CAPACITY * 0.25 ? 'mid' : 'low'; }
  get fuelPct()      { return (this.fuelLiters / CONFIG.FUEL_CAPACITY) * 100; }
  get fuelWarning()  { return this.fuelLiters < CONFIG.FUEL_CAPACITY * 0.20; }
  get formattedTime() {
    const m = String(Math.floor(this.missionTime / 60)).padStart(2, '0');
    const s = String(this.missionTime % 60).padStart(2, '0');
    return `${m}:${s}`;
  }
}
