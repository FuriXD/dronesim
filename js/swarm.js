// ============================================================
// swarm.js — SwarmManager: multi-drone coordination
// ============================================================

class SwarmDrone {
  constructor(id, role, startPos) {
    this.id          = id;
    this.role        = role;
    this.drone       = new Drone(startPos);
    this.drone.mode  = 'AUTO';
    this._stepping   = false;
    this._lastStep   = 0;
    this._pathHash   = '';
    this._replanCooldown = 0;

    switch (role) {
      case ROLE.SCOUT:
        this.drone.missionPriority = CONFIG.PRIORITY.CRITICAL;
        this._speedMult = 1.4;
        this._drainMult = 0.6;
        break;
      case ROLE.RELAY:
        this.drone.missionPriority = CONFIG.PRIORITY.MEDIUM;
        this._speedMult = 0.8;
        this._drainMult = 0.7;
        break;
      case ROLE.RESCUE:
        this.drone.missionPriority = CONFIG.PRIORITY.HIGH;
        this._speedMult = 0.9;
        this._drainMult = 1.1;
        break;
      default: // STRIKE
        this.drone.missionPriority = CONFIG.PRIORITY.HIGH;
        this._speedMult = 1.0;
        this._drainMult = 1.2;
    }
  }

  get stepIntervalMs() {
    return Math.max(60, CONFIG.MOVE_INTERVAL_MS / this._speedMult);
  }
}

class SwarmManager {
  constructor() {
    this.members   = [];
    this.formation = FORMATION.FREE;
    this._nextId   = 1;
  }

  // ── Drone management ────────────────────────────────────────

  addDrone(role, startPos) {
    if (this.members.length >= CONFIG.SWARM_MAX - 1) return null;
    const member = new SwarmDrone(this._nextId++, role, startPos);
    this.members.push(member);
    return member;
  }

  removeLast() {
    return this.members.pop() || null;
  }

  clearAll() {
    this.members  = [];
    this._nextId  = 1;
  }

  reset(startPos) {
    for (const m of this.members) {
      m.drone.reset();
      m.drone.updateStart(startPos);
      m._stepping = false;
      m._lastStep = 0;
    }
  }

  // ── Role-based mission launch ────────────────────────────────
  // Assigns paths with role-appropriate priorities and staggered offsets.

  launchMission(grid, target, threatManager = null) {
    if (!target) return;

    const roles = [ROLE.SCOUT, ROLE.RELAY, ROLE.STRIKE, ROLE.RESCUE];
    const reserved = new Set();

    for (let i = 0; i < this.members.length; i++) {
      const m    = this.members[i];
      const role = m.role;

      // Formation offset from start
      const offset = this.formationOffset(i);
      const sp = {
        x: Math.max(0, Math.min(CONFIG.GRID_COLS - 1, m.drone.position.x + offset.dx)),
        y: Math.max(0, Math.min(CONFIG.GRID_ROWS - 1, m.drone.position.y + offset.dy)),
      };
      m.drone.updateStart(sp);
      m.drone.reset();

      const tp = {
        x: Math.max(0, Math.min(CONFIG.GRID_COLS - 1, target.x + offset.dx)),
        y: Math.max(0, Math.min(CONFIG.GRID_ROWS - 1, target.y + offset.dy)),
      };

      // Scout gets CRITICAL priority (ignores threats), others get their assigned priority
      const path = AStar.findPath(grid, m.drone.position, tp, new Set(reserved), m.drone.missionPriority);
      if (path) {
        this.assignPath(m, path);
        // Reserve this drone's first few cells to space them out
        path.slice(0, 3).forEach(p => reserved.add(`${p.x},${p.y}`));
      }
    }
  }

  // ── Path assignment ─────────────────────────────────────────

  assignPath(member, path) {
    if (!path) return;
    member.drone.loadPath(path);
    member._stepping = true;
    member._lastStep = performance.now();
    member._pathHash = AStar.hashPath(path, window._grid || { get: () => 0 });
  }

  // ── Tick all swarm drones ───────────────────────────────────

  tick(now, grid, threatManager = null) {
    for (const m of this.members) {
      if (!m._stepping || !m.drone.isNavigating) continue;

      const elapsed = now - m._lastStep;
      if (elapsed < m.stepIntervalMs) continue;

      // Real-time threat replanning
      const cooldownOk = now - m._replanCooldown > CONFIG.THREAT_REPLAN_COOLDOWN_MS;
      if (cooldownOk && AStar.shouldReplan(m.drone, grid, threatManager)) {
        const reserved = this.reservedCells(m.id);
        const offset = this.formationOffset(this.members.indexOf(m));
        const tp = {
          x: Math.max(0, Math.min(CONFIG.GRID_COLS - 1, grid.target.x + offset.dx)),
          y: Math.max(0, Math.min(CONFIG.GRID_ROWS - 1, grid.target.y + offset.dy)),
        };
        const newPath  = AStar.findPath(grid, m.drone.position, tp, reserved, m.drone.missionPriority);
        if (newPath) {
          m.drone.loadPath(newPath);
          m.drone.replanCount++;
          m._pathHash       = AStar.hashPath(newPath, grid);
          m._replanCooldown = now;
        }
      }

      m._lastStep += m.stepIntervalMs;
      m.drone.step();
      if (m.drone.isDone) m._stepping = false;
    }
  }

  // ── Formation offsets ───────────────────────────────────────

  formationOffset(memberIdx) {
    const i = memberIdx + 1;
    switch (this.formation) {
      case FORMATION.DELTA:
        return memberIdx === 0 ? { dx: -1, dy:  1 }
             : memberIdx === 1 ? { dx:  1, dy:  1 }
             :                   { dx:  0, dy:  2 };
      case FORMATION.LINE:
        return { dx: 0, dy: i };
      case FORMATION.ORBIT: {
        const angle = (i / (this.members.length)) * Math.PI * 2;
        return { dx: Math.round(Math.cos(angle) * 2), dy: Math.round(Math.sin(angle) * 2) };
      }
      default: // FREE
        return { dx: 0, dy: 0 };
    }
  }

  // ── Reserved cells (exclude from A* neighbours) ─────────────

  reservedCells(excludeId = null) {
    const set = new Set();
    for (const m of this.members) {
      if (m.id === excludeId) continue;
      const { x, y } = m.drone.position;
      set.add(`${x},${y}`);
    }
    return set;
  }

  // ── Swarm telemetry ─────────────────────────────────────────

  getSwarmTelemetry() {
    return this.members.map(m => ({
      id:       m.id,
      role:     m.role,
      position: { ...m.drone.position },
      battery:  Math.round(m.drone.battery),
      fuel:     m.drone.fuelPct.toFixed(0),
      status:   m.drone.isDone ? (m.drone.status === STATUS.REACHED ? 'DONE' : 'FAILED')
                               : (m.drone.isNavigating ? 'FLY' : 'IDLE'),
      replans:  m.drone.replanCount,
    }));
  }

  get activeCount() {
    return this.members.filter(m => m._stepping && m.drone.isNavigating).length;
  }
}
