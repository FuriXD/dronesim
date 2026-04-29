// ============================================================
// controls.js — UI wiring; auto + manual control modes
// ============================================================

const MANUAL_STEP_MS = 150;  // ms between steps while holding a key

class Controls {
  constructor(grid, drone, renderer, swarm, threatManager, onRegen) {
    this.grid          = grid;
    this.drone         = drone;
    this.renderer      = renderer;
    this.swarm         = swarm;
    this.threatManager = threatManager;
    this.onRegen       = onRegen;

    this._stepping        = false;
    this._lastStepTime    = 0;
    this._selectingTarget = false;
    this._lastPathHash    = '';
    this._replanCooldown  = 0;

    this._manualMode     = false;
    this._keysHeld       = {};
    this._lastManualStep = 0;

    this._terrainMode = false;
    this._terrainType = 0;
    this._painting    = false;
    this._lastPainted = null;
    this._undoStack   = [];
    this._redoStack   = [];

    this._threatSelectMode = false;
    this._selectedThreat   = null;

    this._bindButtons();
    this._bindCanvas();
    this._bindKeyboard();
    this._bindSpecsPanel();
    this._bindTerrainEditor();
    this._bindThreatControls();
    this._bindPrioritySelector();
    this._bindSwarmPanel();
    this._bindThreatEditor();
    this._bindMovingTargetConfig();
    this._updateSpecDisplay();
    this.updateDashboard();

    setTimeout(() => {
      if (this.grid && this.grid.cells.length > 0) {
        this._saveGridState();
      }
    }, 100);
  }

  // ── Auto-pilot step driver (called every rAF from main.js) ───

  driveStep() {
    if (this._manualMode) return;
    if (!this._stepping || !this.drone.isNavigating) {
      this._stepping = false;
      return;
    }
    const elapsed = performance.now() - this._lastStepTime;
    if (elapsed >= CONFIG.MOVE_INTERVAL_MS) {
      this._lastStepTime += CONFIG.MOVE_INTERVAL_MS;
      this.drone.step();
      this.renderer.onDroneStep();
      this._checkReplan();
      this.updateDashboard();
      if (this.drone.isDone) {
        this._stepping = false;
        this._log(this.drone.status === STATUS.REACHED
          ? 'Target reached. Mission complete.'
          : 'Battery/fuel depleted. Mission failed.');
      }
      if (this.drone.inThreatZone) this._log('Threat zone entered — intensity ' + this.drone.threatIntensity.toFixed(2));
    }
  }

  _checkReplan() {
    if (!this.drone.isNavigating) return;
    const now      = performance.now();
    const cooldown = this._replanCooldown || 0;
    if (now - cooldown < CONFIG.THREAT_REPLAN_COOLDOWN_MS) return;
    if (!AStar.shouldReplan(this.drone, this.grid, this.threatManager)) return;
    const path = AStar.findPath(this.grid, this.drone.position, this.grid.target,
                                new Set(), this.drone.missionPriority);
    if (path) {
      this.drone.loadPath(path);
      this.drone.replanCount++;
      this._replanCooldown = now;
      this._lastPathHash   = AStar.hashPath(path, this.grid);
      this.renderer.onDroneStep();
      this._log(`Path replanned (×${this.drone.replanCount}) — threat detected ahead.`);
    }
  }

  // ── Manual step driver (called every rAF from main.js) ───────

  driveManual() {
    if (!this._manualMode) return;
    if (this.drone.isDone) return;

    // Update HUD key highlights every frame
    this._updateKeyHUD();

    const now = performance.now();

    // ── Altitude (Q = ascend, E = descend) — checked every frame, rate-limited separately ──
    if (now - this._lastManualStep >= MANUAL_STEP_MS) {
      if (this._keysHeld['KeyQ']) {
        this.drone.adjustAltitude(CONFIG.DRONE_ALT_STEP);
        this.updateDashboard();
      }
      if (this._keysHeld['KeyE']) {
        this.drone.adjustAltitude(-CONFIG.DRONE_ALT_STEP);
        this.updateDashboard();
      }
    }

    if (now - this._lastManualStep < MANUAL_STEP_MS) return;

    let dx = 0, dy = 0;
    if (this._keysHeld['ArrowUp']    || this._keysHeld['KeyW']) dy = -1;
    if (this._keysHeld['ArrowDown']  || this._keysHeld['KeyS']) dy =  1;
    if (this._keysHeld['ArrowLeft']  || this._keysHeld['KeyA']) dx = -1;
    if (this._keysHeld['ArrowRight'] || this._keysHeld['KeyD']) dx =  1;

    if (dx === 0 && dy === 0) return;

    const moved = this.drone.manualStep(dx, dy);
    if (moved) {
      this._lastManualStep = now;
      this.renderer.onDroneStep();
      this.updateDashboard();

      if (this.drone.inThreatZone) this._log('Threat zone entered.');
      if (this.drone.isDone) {
        this._log(this.drone.status === STATUS.REACHED
          ? 'Target reached.'
          : 'Battery depleted. Mission failed.');
      }
    }
  }

  // ── Keyboard bindings ────────────────────────────────────────

  _bindKeyboard() {
    document.addEventListener('keydown', (e) => {
      this._keysHeld[e.code] = true;
      // Prevent page scrolling on arrow keys when in manual mode
      if (this._manualMode &&
          ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.code)) {
        e.preventDefault();
      }
      // Escape exits manual mode
      if (e.code === 'Escape' && this._manualMode) {
        this.toggleManualMode();
      }
    });
    document.addEventListener('keyup', (e) => {
      this._keysHeld[e.code] = false;
      this._updateKeyHUD();
    });
  }

  // ── Button bindings ──────────────────────────────────────────

  _bindButtons() {
    document.getElementById('btn-start').addEventListener('click',  () => this.startMission());
    document.getElementById('btn-reset').addEventListener('click',  () => this.reset());
    document.getElementById('btn-regen').addEventListener('click',  () => { this.onRegen(); setTimeout(() => this._saveGridState(), 50); });
    document.getElementById('btn-path').addEventListener('click',   () => this.togglePath());
    document.getElementById('btn-target').addEventListener('click', () => this.enterTargetSelect());
    document.getElementById('btn-manual').addEventListener('click', () => this.toggleManualMode());
    document.getElementById('btn-apply-specs').addEventListener('click', () => this._applySpecs());
    document.getElementById('btn-terrain-edit').addEventListener('click', () => this.toggleTerrainMode());
    
    // New Environment Setup buttons
    document.getElementById('btn-clear-grid')?.addEventListener('click', () => this.clearGrid());
    document.getElementById('btn-undo-terrain')?.addEventListener('click', () => this.undoTerrain());
    document.getElementById('btn-redo-terrain')?.addEventListener('click', () => this.redoTerrain());
  }

  _bindThreatControls() {
    const speedSlider = document.getElementById('threat-speed');
    const enableToggle = document.getElementById('threat-enable');
    if (speedSlider) {
      speedSlider.addEventListener('input', () => {
        CONFIG.THREAT_SPEED = parseFloat(speedSlider.value);
        document.getElementById('val-threat-speed').textContent = speedSlider.value;
        if (this.threatManager) {
          for (const t of this.threatManager.dynamicThreats) {
            const spd = CONFIG.THREAT_SPEED * (0.7 + Math.random() * 0.6);
            const ang = Math.atan2(t.vy, t.vx);
            t.vx = Math.cos(ang) * spd;
            t.vy = Math.sin(ang) * spd;
          }
        }
      });
    }
    if (enableToggle) {
      enableToggle.addEventListener('change', () => {
        CONFIG.THREAT_ENABLED = enableToggle.checked;
        this._log('Dynamic threats ' + (CONFIG.THREAT_ENABLED ? 'enabled' : 'disabled') + '.');
      });
    }
  }

  _bindMovingTargetConfig() {
    const uploadInput = document.getElementById('moving-target-upload');
    const enableToggle = document.getElementById('moving-target-enable');
    const speedSlider = document.getElementById('moving-target-speed');
    const speedVal = document.getElementById('val-moving-target-speed');

    if (uploadInput) {
      uploadInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
          const reader = new FileReader();
          reader.onload = (evt) => {
            if (this.renderer) {
              this.renderer.setMovingTargetTexture(evt.target.result);
              this._log('Moving target photo loaded.');
            }
          };
          reader.readAsDataURL(file);
        }
      });
    }

    if (enableToggle) {
      enableToggle.addEventListener('change', () => {
        CONFIG.MOVING_TARGET_ENABLED = enableToggle.checked;
        if (this.renderer) this.renderer.toggleMovingTarget(enableToggle.checked);
        this._log('Moving target ' + (enableToggle.checked ? 'enabled' : 'disabled') + '.');
      });
    }

    if (speedSlider) {
      speedSlider.addEventListener('input', () => {
        CONFIG.MOVING_TARGET_SPEED = parseFloat(speedSlider.value);
        if (speedVal) speedVal.textContent = parseFloat(speedSlider.value).toFixed(1);
      });
    }
  }

  _bindPrioritySelector() {
    document.querySelectorAll('.btn-priority').forEach(btn => {
      btn.addEventListener('click', () => {
        this.drone.missionPriority = btn.dataset.priority;
        document.querySelectorAll('.btn-priority').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this._log('Mission priority: ' + btn.dataset.priority);
        this.updateDashboard();
      });
    });
    // set MEDIUM active by default
    const medBtn = document.querySelector('.btn-priority[data-priority="MEDIUM"]');
    if (medBtn) medBtn.classList.add('active');
  }

  _bindSwarmPanel() {
    const formSel = document.getElementById('swarm-formation');
    if (formSel) formSel.addEventListener('change', () => {
      if (this.swarm) this.swarm.formation = formSel.value;
    });

    const btnLaunch = document.getElementById('btn-launch-swarm');
    const btnAbort  = document.getElementById('btn-abort-swarm');

    if (btnLaunch) btnLaunch.addEventListener('click', () => this._launchSwarm());
    if (btnAbort)  btnAbort.addEventListener('click',  () => this._abortSwarm());
  }

  _launchSwarm() {
    if (!this.grid.target) { this._log('Set a target before launching swarm.'); return; }
    if (!this.swarm)       return;

    this.swarm.clearAll();
    const countEl = document.getElementById('swarm-size');
    const count   = countEl ? parseInt(countEl.value, 10) : 2;
    const roles   = [ROLE.SCOUT, ROLE.STRIKE, ROLE.RELAY, ROLE.RESCUE];

    for (let i = 0; i < Math.min(count, CONFIG.SWARM_MAX - 1); i++) {
      this.swarm.addDrone(roles[i % roles.length], this.grid.start);
    }
    this.swarm.launchMission(this.grid, this.grid.target, this.threatManager);
    this._log(`Swarm launched — ${this.swarm.members.length} drone(s), ${this.swarm.formation} formation.`);
    this.updateDashboard();
  }

  _abortSwarm() {
    if (!this.swarm) return;
    this.swarm.clearAll();
    this._log('Swarm aborted.');
    this.updateDashboard();
  }

  _bindCanvas() {
    this.renderer.container.addEventListener('click', (e) => {
      // ── Target selection ────────────────────────────────────
      if (this._selectingTarget) {
        const cell = this.renderer.cellFromPixel(e.clientX, e.clientY);
        if (!cell) return;
        const ok = this.grid.setTarget(cell.x, cell.y);
        if (ok) {
          this._selectingTarget = false;
          this.renderer.controls.enabled = true;
          this.renderer.container.classList.remove('crosshair');
          this._setBtn('btn-target', false, 'SET TARGET');
          this.renderer.rebuildScene();
          this.drone.reset();
          this.drone.updateStart(this.grid.start);
          this._log(`Target set: (${cell.x}, ${cell.y})`);
          this.updateDashboard();
        }
        return;
      }

      // ── Terrain painting intercepts canvas ──────────────────
      if (this._terrainMode) return;

      // ── Threat selection mode (explicit SELECT THREAT button) ─
      if (this._threatSelectMode) {
        const threat = this.renderer.getClickedThreat(e.clientX, e.clientY);
        if (threat) {
          this._selectedThreat = threat;
          this.renderer._selectedThreatId = threat.id;
          this._refreshThreatInspector();
          this._scrollToInspector();
          this._log(`Threat #${threat.id} selected.`);
        } else {
          // Deselect if clicked empty area
          this._selectedThreat = null;
          this.renderer._selectedThreatId = null;
          this._refreshThreatInspector();
        }
        return;
      }

      // ── Passive threat click (no mode active) ───────────────
      // Any click on a threat sphere auto-selects it + opens inspector
      if (CONFIG.THREAT_ENABLED) {
        const threat = this.renderer.getClickedThreat(e.clientX, e.clientY);
        if (threat) {
          this._selectedThreat = threat;
          this.renderer._selectedThreatId = threat.id;
          this._refreshThreatInspector();
          this._scrollToInspector();
          this._log(`Threat #${threat.id} selected.`);
        }
      }
    });
  }

  // ── Manual mode toggle ───────────────────────────────────────

  toggleManualMode() {
    this._manualMode = !this._manualMode;
    this._stepping   = false;  // always stop auto-pilot when toggling

    const btn  = document.getElementById('btn-manual');
    const hud  = document.getElementById('manual-hud');
    const vp   = document.querySelector('.viewport-col');

    if (this._manualMode) {
      // Enter manual mode
      this.drone.mode   = 'MANUAL';
      this.drone.status = STATUS.IDLE;
      this.drone.path   = [];
      this.drone.fullPath = [];
      if (btn) { btn.textContent = 'AUTO MODE'; btn.classList.add('active'); }
      if (hud) hud.classList.add('active');
      if (vp)  vp.classList.add('manual-active');
      this._log('Manual control activated. Use WASD or arrow keys.');
    } else {
      // Return to auto mode
      this.drone.mode   = 'AUTO';
      this.drone.status = STATUS.IDLE;
      if (btn) { btn.textContent = 'MANUAL CONTROL'; btn.classList.remove('active'); }
      if (hud) hud.classList.remove('active');
      if (vp)  vp.classList.remove('manual-active');
      this._keysHeld = {};
      this._updateKeyHUD();
      this._log('Autonomous mode restored.');
    }
    this.updateDashboard();
  }

  _updateKeyHUD() {
    const map = {
      'key-w': ['KeyW', 'ArrowUp'],
      'key-a': ['KeyA', 'ArrowLeft'],
      'key-s': ['KeyS', 'ArrowDown'],
      'key-d': ['KeyD', 'ArrowRight'],
    };
    Object.entries(map).forEach(([id, codes]) => {
      const el = document.getElementById(id);
      if (el) el.classList.toggle('pressed', codes.some(c => this._keysHeld[c]));
    });
  }

  // ── Specs panel ──────────────────────────────────────────────

  _bindSpecsPanel() {
    [['spec-mah','val-mah'],['spec-power','val-power'],
     ['spec-speed','val-speed'],['spec-payload','val-payload']]
      .forEach(([id, vid]) => {
        document.getElementById(id).addEventListener('input', () => {
          document.getElementById(vid).textContent = document.getElementById(id).value;
          this._updateSpecDisplay();
        });
      });
    document.getElementById('spec-voltage').addEventListener('change', () => this._updateSpecDisplay());
    document.getElementById('spec-cellsize').addEventListener('input',  () => this._updateSpecDisplay());
  }

  _readSpecs() {
    return {
      battery_mah: parseFloat(document.getElementById('spec-mah').value),
      voltage:     parseFloat(document.getElementById('spec-voltage').value),
      motor_power: parseFloat(document.getElementById('spec-power').value),
      speed_ms:    parseFloat(document.getElementById('spec-speed').value),
      cell_size_m: parseFloat(document.getElementById('spec-cellsize').value) || 10,
      payload_kg:  parseFloat(document.getElementById('spec-payload').value),
      payload_type: document.getElementById('spec-payload-type') ? document.getElementById('spec-payload-type').value : 'NORMAL',
    };
  }

  _updateSpecDisplay() {
    const specs  = this._readSpecs();
    const result = Drone.computeSpecs(specs);
    document.getElementById('val-mah').textContent     = specs.battery_mah;
    document.getElementById('val-power').textContent   = specs.motor_power;
    document.getElementById('val-speed').textContent   = specs.speed_ms;
    document.getElementById('val-payload').textContent = specs.payload_kg;
    this._setText('comp-energy',    result.energyWh.toFixed(1) + ' Wh');
    this._setText('comp-eff-power', result.effectivePower.toFixed(0) + ' W');
    this._setText('comp-flight',    result.flightTimeMin.toFixed(1) + ' min');
    this._setText('comp-range',
      result.maxRangeM >= 1000 ? (result.maxRangeM/1000).toFixed(2)+' km' : result.maxRangeM.toFixed(0)+' m');
    this._setText('comp-maxsteps', result.maxSteps);
    this._setText('comp-step-dur', result.stepDurMs + ' ms');
    this._setText('comp-drain',    result.drainPerStep.toFixed(3) + '%');
  }

  _applySpecs() {
    const specs  = this._readSpecs();
    Drone.applySpecs(specs);
    if (this._stepping) this._lastStepTime = performance.now();
    this._log(`Config applied — ${specs.battery_mah}mAh ${specs.voltage}V`);
    const btn = document.getElementById('btn-apply-specs');
    btn.textContent = 'CONFIGURATION APPLIED';
    setTimeout(() => { btn.textContent = 'APPLY CONFIGURATION'; }, 1400);
  }

  // ── Mission ──────────────────────────────────────────────────

  startMission() {
    if (this.drone.isNavigating && !this._manualMode) return;
    if (!this.grid.target) { this._log('Set a target first.'); return; }

    // Auto-mission always exits manual mode
    if (this._manualMode) this.toggleManualMode();

    this.drone.reset();
    this.drone.updateStart(this.grid.start);
    this._updateStatus(STATUS.CALCULATING);
    this._log('Computing A* path...');

    setTimeout(() => {
      const path = AStar.findPath(this.grid, this.grid.start, this.grid.target);
      if (!path) {
        this.drone.status = STATUS.NO_PATH;
        this._log('No viable path found. Regen the map.');
        this.updateDashboard();
        return;
      }
      this._log(`Path: ${path.length - 1} steps`);
      this.drone.loadPath(path);
      this.renderer.onDroneStep();
      this.updateDashboard();
      this._lastStepTime = performance.now();
      this._stepping     = true;
    }, 80);
  }

  reset() {
    this._stepping = false;
    // Exit manual mode on reset
    if (this._manualMode) {
      this._manualMode = false;
      this._keysHeld   = {};
      this._updateKeyHUD();
      const btn = document.getElementById('btn-manual');
      if (btn) { btn.textContent = 'MANUAL CONTROL'; btn.classList.remove('active'); }
      const hud = document.getElementById('manual-hud');
      if (hud) hud.classList.remove('active');
      const vp = document.querySelector('.viewport-col');
      if (vp) vp.classList.remove('manual-active');
    }
    this.drone.reset();
    this.drone.updateStart(this.grid.start);
    this.renderer.rebuildScene();
    this._log('Simulation reset.');
    this.updateDashboard();
  }

  togglePath() {
    this.renderer.showPath = !this.renderer.showPath;
    const on = this.renderer.showPath;
    document.getElementById('btn-path').textContent = on ? 'HIDE PATH' : 'SHOW PATH';
    document.getElementById('btn-path').classList.toggle('active', on);
    if (!on && this.renderer.pathLine) { this.renderer.scene.remove(this.renderer.pathLine); this.renderer.pathLine = null; }
    if (on) this.renderer._refreshPath();
  }

  enterTargetSelect() {
    this._selectingTarget = true;
    this.renderer.controls.enabled = false;
    this.renderer.container.classList.add('crosshair');
    this._setBtn('btn-target', true, 'CLICK MAP...');
    this._log('Click on the 3D map to place target.');
  }

  // ── Terrain editor ────────────────────────────────────────

  toggleTerrainMode() {
    this._terrainMode = !this._terrainMode;
    const btn  = document.getElementById('btn-terrain-edit');
    const vp   = document.querySelector('.viewport-col');
    const hint = document.getElementById('terrain-hint');

    if (this._terrainMode) {
      // disable orbit so clicks paint rather than rotate
      this.renderer.controls.enabled = false;
      if (btn)  { btn.textContent = 'STOP EDITING'; btn.classList.add('active'); }
      if (vp)   vp.classList.add('terrain-active');
      if (hint) hint.classList.add('visible');
      this._log('Terrain editor active. Click/drag the map to paint cells.');
    } else {
      this.renderer.controls.enabled = true;
      this._painting = false;
      if (btn)  { btn.textContent = 'EDIT TERRAIN'; btn.classList.remove('active'); }
      if (vp)   vp.classList.remove('terrain-active');
      if (hint) hint.classList.remove('visible');
      this._log('Terrain editor closed.');
    }
  }

  _bindTerrainEditor() {
    // Palette type buttons
    document.querySelectorAll('.btn-terrain-type').forEach(btn => {
      btn.addEventListener('click', () => {
        this._terrainType = parseInt(btn.dataset.type, 10);
        document.querySelectorAll('.btn-terrain-type').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        // Show height slider for obstacle (1) and urban (6) types
        const heightRow = document.getElementById('obs-height-row');
        if (heightRow) heightRow.classList.toggle('visible', this._terrainType === CONFIG.CELL.OBSTACLE || this._terrainType === CONFIG.CELL.URBAN);
      });
    });

    // Obstacle height slider live readout
    const obsSlider = document.getElementById('terrain-obs-height');
    const obsVal    = document.getElementById('val-obs-height');
    if (obsSlider && obsVal) {
      obsSlider.addEventListener('input', () => { obsVal.textContent = parseFloat(obsSlider.value).toFixed(1); });
    }

    // Canvas drag-paint
    const canvas = this.renderer.container;

    const paintAt = (clientX, clientY) => {
      if (!this._terrainMode) return;
      const cell = this.renderer.cellFromPixel(clientX, clientY);
      if (!cell) return;

      // Don't repaint same cell twice in one stroke
      const key = `${cell.x},${cell.y}`;
      if (this._lastPainted === key) return;
      this._lastPainted = key;

      const { CELL } = CONFIG;

      // Prevent overwriting start cell
      if (cell.x === this.grid.start.x && cell.y === this.grid.start.y) return;

      const type = this._terrainType;

      // If replacing existing target, clear grid.target ref
      if (this.grid.target && cell.x === this.grid.target.x && cell.y === this.grid.target.y) {
        this.grid.target = null;
      }

      this.grid.set(cell.x, cell.y, type);

      // Update obstacle/urban height map
      if (type === CELL.OBSTACLE || type === CELL.URBAN) {
        const h = parseFloat(document.getElementById('terrain-obs-height')?.value || 2.0);
        if (!this.grid.obstacleHeights[cell.y]) this.grid.obstacleHeights[cell.y] = [];
        this.grid.obstacleHeights[cell.y][cell.x] = h;
      } else {
        // Clear height when removing obstacle
        if (this.grid.obstacleHeights[cell.y]) this.grid.obstacleHeights[cell.y][cell.x] = 0;
      }

      this.renderer.rebuildCell(cell.x, cell.y);
    };

    canvas.addEventListener('mousedown', (e) => {
      if (!this._terrainMode) return;
      this._painting    = true;
      this._lastPainted = null;
      paintAt(e.clientX, e.clientY);
    });

    canvas.addEventListener('mousemove', (e) => {
      if (!this._painting || !this._terrainMode) return;
      paintAt(e.clientX, e.clientY);
    });

    const stopPainting = () => { 
      if (this._painting && this._lastPainted) {
        this._saveGridState();
      }
      this._painting = false; 
      this._lastPainted = null; 
    };
    canvas.addEventListener('mouseup',    stopPainting);
    canvas.addEventListener('mouseleave', stopPainting);
  }

  // ── Undo/Redo/Clear ─────────────────────────────────────────

  _saveGridState() {
    this._undoStack.push(this.grid.getState());
    this._redoStack = [];
    if (this._undoStack.length > 50) this._undoStack.shift();
  }

  undoTerrain() {
    if (this._undoStack.length > 1) {
      this._redoStack.push(this._undoStack.pop());
      this.grid.setState(this._undoStack[this._undoStack.length - 1]);
      this.renderer.rebuildScene();
      this._log('Terrain undo.');
    } else {
      this._log('Nothing to undo.');
    }
  }

  redoTerrain() {
    if (this._redoStack.length > 0) {
      const state = this._redoStack.pop();
      this.grid.setState(state);
      this._undoStack.push(state);
      this.renderer.rebuildScene();
      this._log('Terrain redo.');
    }
  }

  clearGrid() {
    this.grid.clear();
    this.renderer.rebuildScene();
    this._saveGridState();
    this._log('Grid cleared for custom setup.');
  }

  // ── Threat Inspector ─────────────────────────────────────────

  _bindThreatEditor() {
    const btnSelect = document.getElementById('btn-select-threat');
    const btnAdd    = document.getElementById('btn-add-threat');
    const btnDelete = document.getElementById('btn-delete-threat');
    const btnFreeze = document.getElementById('btn-freeze-threat');

    if (btnSelect) btnSelect.addEventListener('click', () => {
      this._threatSelectMode = !this._threatSelectMode;
      const vp = document.querySelector('.viewport-col');
      if (this._threatSelectMode) {
        // disable orbit controls so clicks register
        this.renderer.controls.enabled = false;
        this.renderer.container.classList.add('threat-select-cursor');
        if (vp) vp.classList.add('threat-selecting');
        btnSelect.textContent = 'CANCEL SELECT';
        btnSelect.classList.add('active');
        this._log('Click a red threat sphere to select it.');
      } else {
        this.renderer.controls.enabled = !this._terrainMode;
        this.renderer.container.classList.remove('threat-select-cursor');
        if (vp) vp.classList.remove('threat-selecting');
        btnSelect.textContent = 'SELECT UNIT';
        btnSelect.classList.remove('active');
      }
    });

    if (btnAdd) btnAdd.addEventListener('click', () => {
      if (!this.threatManager) return;
      const typeSelect = document.getElementById('spawn-type');
      const type = typeSelect ? typeSelect.value : 'ENEMY_DRONE';
      const t = this.threatManager.addThreat(this.grid, type);
      // Register mesh in renderer
      this.renderer._addDynThreatMesh(t);
      this._log(`Unit [${type}] #${t.id} spawned.`);
    });

    if (btnDelete) btnDelete.addEventListener('click', () => {
      if (!this._selectedThreat || !this.threatManager) return;
      const id = this._selectedThreat.id;
      this.threatManager.removeThreat(id, this.grid);
      this.renderer.removeDynThreatMesh(id);
      this._selectedThreat = null;
      this._refreshThreatInspector();
      this._log(`Threat #${id} deleted.`);
    });

    if (btnFreeze) btnFreeze.addEventListener('click', () => {
      if (!this._selectedThreat) return;
      this._selectedThreat.frozen = !this._selectedThreat.frozen;
      const frozen = this._selectedThreat.frozen;
      btnFreeze.textContent = frozen ? '▶ UNFREEZE' : '⏸ FREEZE';
      btnFreeze.classList.toggle('active', frozen);
      this._log(`Threat #${this._selectedThreat.id} ${frozen ? 'frozen' : 'unfrozen'}.`);
    });

    // Speed slider
    const speedSlider = document.getElementById('threat-edit-speed');
    const speedVal    = document.getElementById('val-threat-edit-speed');
    if (speedSlider) speedSlider.addEventListener('input', () => {
      speedVal.textContent = parseFloat(speedSlider.value).toFixed(1);
      if (!this._selectedThreat) return;
      const t   = this._selectedThreat;
      let ang = Math.atan2(t.vy, t.vx);
      if (t.vx === 0 && t.vy === 0) {
        const angleSlider = document.getElementById('threat-edit-angle');
        ang = angleSlider ? parseInt(angleSlider.value, 10) * Math.PI / 180 : 0;
      }
      const spd = parseFloat(speedSlider.value);
      t.vx = Math.cos(ang) * spd;
      t.vy = Math.sin(ang) * spd;
    });

    // Direction slider
    const angleSlider = document.getElementById('threat-edit-angle');
    const angleVal    = document.getElementById('val-threat-edit-angle');
    if (angleSlider) angleSlider.addEventListener('input', () => {
      angleVal.textContent = angleSlider.value + '°';
      if (!this._selectedThreat) return;
      const t   = this._selectedThreat;
      const spd = Math.hypot(t.vx, t.vy);
      const rad = parseInt(angleSlider.value, 10) * Math.PI / 180;
      t.vx = Math.cos(rad) * spd;
      t.vy = Math.sin(rad) * spd;
    });

    // Intensity slider
    const intSlider = document.getElementById('threat-edit-intensity');
    const intVal    = document.getElementById('val-threat-edit-intensity');
    if (intSlider) intSlider.addEventListener('input', () => {
      intVal.textContent = parseFloat(intSlider.value).toFixed(2);
      if (this._selectedThreat) this._selectedThreat.intensity = parseFloat(intSlider.value);
    });

    // Radius slider
    const radSlider = document.getElementById('threat-edit-radius');
    const radVal    = document.getElementById('val-threat-edit-radius');
    if (radSlider) radSlider.addEventListener('input', () => {
      radVal.textContent = radSlider.value;
      if (!this._selectedThreat) return;
      this._selectedThreat.radius = parseInt(radSlider.value, 10);
      // Resize the 3D mesh geometry
      const mesh = this.renderer._dynThreatMeshes
        .find(m => m._threatRef && m._threatRef.id === this._selectedThreat.id);
      if (mesh) {
        mesh.geometry.dispose();
        if (this._selectedThreat.type === 'ANTI_AIR') {
          mesh.geometry = new THREE.CylinderGeometry(this._selectedThreat.radius * 0.85, this._selectedThreat.radius * 0.85, 2.0, 16);
        } else if (this._selectedThreat.type === 'PERSONNEL') {
          mesh.geometry = new THREE.BoxGeometry(0.8, 1.8, 0.8); // Fixed size for personnel
        } else {
          mesh.geometry = new THREE.SphereGeometry(this._selectedThreat.radius * 0.85, 12, 8);
        }
        if (mesh._radarRing) {
          mesh._radarRing.geometry.dispose();
          mesh._radarRing.geometry = new THREE.RingGeometry(this._selectedThreat.radius * 0.85, this._selectedThreat.radius * 0.95, 32);
        }
      }
    });
  }

  /** Populate / clear the Threat Inspector form panel. */
  _refreshThreatInspector() {
    const t       = this._selectedThreat;
    const form    = document.getElementById('threat-inspector-form');
    const empty   = document.getElementById('threat-inspector-empty');
    const idBadge = document.getElementById('threat-id-badge');
    if (!form || !empty) return;

    if (!t) {
      form.style.display  = 'none';
      empty.style.display = 'block';
      return;
    }

    form.style.display  = 'flex';
    empty.style.display = 'none';

    if (idBadge) idBadge.textContent = `THREAT  #${t.id}`;

    // Populate sliders from current threat values
    const spd = Math.hypot(t.vx, t.vy);
    const ang = Math.round(Math.atan2(t.vy, t.vx) * 180 / Math.PI);
    const angleDeg = ((ang % 360) + 360) % 360;

    this._setSlider('threat-edit-speed',     'val-threat-edit-speed',     spd.toFixed(1),                    spd.toFixed(1));
    this._setSlider('threat-edit-angle',     'val-threat-edit-angle',     angleDeg,                          angleDeg + '°');
    this._setSlider('threat-edit-intensity', 'val-threat-edit-intensity', t.intensity.toFixed(2),            t.intensity.toFixed(2));
    this._setSlider('threat-edit-radius',    'val-threat-edit-radius',    t.radius,                          t.radius);

    // Freeze button state
    const btnFreeze = document.getElementById('btn-freeze-threat');
    if (btnFreeze) {
      btnFreeze.textContent = t.frozen ? '▶ UNFREEZE' : '⏸ FREEZE';
      btnFreeze.classList.toggle('active', !!t.frozen);
    }
  }

  _setSlider(sliderId, valId, sliderVal, displayVal) {
    const sl = document.getElementById(sliderId);
    const vl = document.getElementById(valId);
    if (sl) sl.value = sliderVal;
    if (vl) vl.textContent = displayVal;
  }

  /** Scroll the right panel so the Threat Inspector section is visible. */
  _scrollToInspector() {
    const section = document.getElementById('threat-inspector-section');
    if (!section) return;
    const panel = section.closest('.side-panel');
    if (panel) {
      const panelTop   = panel.getBoundingClientRect().top;
      const sectionTop = section.getBoundingClientRect().top;
      panel.scrollTo({ top: panel.scrollTop + (sectionTop - panelTop) - 12, behavior: 'smooth' });
    }
  }

  // ── Dashboard ────────────────────────────────────────────────

  updateDashboard() {
    const d        = this.drone;
    const cellSize = parseFloat(document.getElementById('spec-cellsize').value) || 10;

    this._setText('stat-pos',    `(${d.position.x}, ${d.position.y})`);
    this._setText('stat-target',
      this.grid.target ? `(${this.grid.target.x}, ${this.grid.target.y})` : '— not set —');
    this._setText('stat-steps',   d.stepsCompleted);
    this._setText('stat-time',    d.formattedTime);
    this._setText('stat-replans', d.replanCount);

    const distM = d.stepsCompleted * cellSize;
    this._setText('stat-dist',
      distM >= 1000 ? (distM/1000).toFixed(2)+' km' : distM.toFixed(0)+' m');

    const remM = d.path.length * cellSize;
    this._setText('stat-remaining',
      d.path.length > 0
        ? (remM >= 1000 ? (remM/1000).toFixed(2)+' km' : remM.toFixed(0)+' m')
        : '—');

    const totalM = (d.fullPath.length > 1 ? d.fullPath.length - 1 : 0) * cellSize;
    this._setText('stat-total-path',
      totalM > 0
        ? (totalM >= 1000 ? (totalM/1000).toFixed(2)+' km' : totalM.toFixed(0)+' m')
        : '—');

    const modeBadge = document.getElementById('mode-badge');
    if (modeBadge) {
      modeBadge.textContent = this._manualMode ? 'MANUAL' : 'AUTO';
      modeBadge.className   = 'mode-badge ' + (this._manualMode ? 'manual' : 'auto');
    }

    // Battery
    const pct = Math.round(d.battery);
    const bar = document.getElementById('battery-fill');
    if (bar) { bar.style.width = `${pct}%`; bar.className = `battery-fill ${d.batteryClass}`; }
    this._setText('battery-label', `${pct}%`);



    // Threat intensity bar
    const intPct = Math.round(d.threatIntensity * 100);
    const intBar = document.getElementById('intensity-fill');
    if (intBar) { intBar.style.width = `${intPct}%`; }
    this._setText('intensity-label', `${intPct}%`);

    this._updateStatus(d.status);

    const t = document.getElementById('threat-indicator');
    if (t) {
      t.classList.toggle('threat-active', d.inThreatZone);
      t.textContent = d.inThreatZone ? 'THREAT DETECTED' : 'SECTOR CLEAR';
    }

    const startBtn = document.getElementById('btn-start');
    if (startBtn) {
      startBtn.disabled    = d.isNavigating && !this._manualMode;
      startBtn.textContent = (d.isNavigating && !this._manualMode) ? 'NAVIGATING...' : 'START MISSION';
    }

    // Live position readout for selected threat
    if (this._selectedThreat) {
      const posEl = document.getElementById('threat-edit-pos');
      if (posEl) {
        const t = this._selectedThreat;
        posEl.textContent = `(${t.cx.toFixed(1)}, ${t.cy.toFixed(1)})`;
      }
    }

    // Swarm telemetry table
    const tblBody = document.getElementById('swarm-tbl-body');
    if (tblBody && this.swarm) {
      const telem = this.swarm.getSwarmTelemetry();
      tblBody.innerHTML = telem.length === 0
        ? '<tr><td colspan="5" style="text-align:center;opacity:0.4">No swarm active</td></tr>'
        : telem.map(r =>
            `<tr>
              <td>#${r.id}</td>
              <td><span class="role-pill role-${r.role.toLowerCase()}">${r.role}</span></td>
              <td>(${r.position.x},${r.position.y})</td>
              <td>${r.battery}%</td>
              <td><span class="swarm-status swarm-${r.status.toLowerCase()}">${r.status}</span></td>
            </tr>`
          ).join('');
    }
  }

  _updateStatus(status) {
    const el = document.getElementById('status-badge');
    if (!el) return;
    el.textContent = this._manualMode ? 'MANUAL' : status;
    el.className   = 'status-badge';
    if (this._manualMode) { el.classList.add('manual-mode'); return; }
    const cls = {
      [STATUS.NAVIGATING]:  'navigating',
      [STATUS.REACHED]:     'success',
      [STATUS.FAILED]:      'failed',
      [STATUS.NO_PATH]:     'failed',
      [STATUS.CALCULATING]: 'calculating',
    };
    el.classList.add(cls[status] || 'idle');
  }

  // ── Utilities ────────────────────────────────────────────────

  _setText(id, val)   { const el = document.getElementById(id); if (el) el.textContent = val; }

  _setBtn(id, active, label) {
    const b = document.getElementById(id); if (!b) return;
    b.textContent = label;
    b.classList.toggle('active', active);
  }

  _log(msg) {
    const log = document.getElementById('event-log'); if (!log) return;
    const ts   = new Date().toLocaleTimeString('en-GB', { hour12: false });
    const line = document.createElement('div');
    line.className   = 'log-entry';
    line.textContent = `[${ts}] ${msg}`;
    log.prepend(line);
    while (log.children.length > 14) log.removeChild(log.lastChild);
  }
}
