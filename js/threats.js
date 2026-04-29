// ============================================================
// threats.js — ThreatManager: moving threats & patrol obstacles
// ============================================================

class ThreatManager {
  constructor() {
    this.dynamicThreats  = [];
    this.patrolObstacles = [];
    this._prevStamps     = [];  // { x, y, prevType }
  }

  // ── Initialise for a fresh grid ─────────────────────────────

  init(grid) {
    this._clearStamps(grid);
    this.dynamicThreats  = [];
    this.patrolObstacles = [];

    const { DYNAMIC_THREAT_COUNT, PATROL_OBSTACLE_COUNT, THREAT_SPEED } = CONFIG;
    const { cols, rows } = grid;

    for (let i = 0; i < DYNAMIC_THREAT_COUNT; i++) {
      let cx, cy, attempts = 0;
      do {
        cx = 4 + Math.random() * (cols - 8);
        cy = 4 + Math.random() * (rows - 8);
        attempts++;
      } while (attempts < 50 && this._tooClose(cx, cy, grid));

      const angle = Math.random() * Math.PI * 2;
      const speed = THREAT_SPEED * (0.7 + Math.random() * 0.6);
      this.dynamicThreats.push({
        id:        i,
        cx, cy,
        type:      'ENEMY_DRONE',
        vx:        Math.cos(angle) * speed,
        vy:        Math.sin(angle) * speed,
        radius:    1 + Math.round(Math.random()),
        intensity: 0.5 + Math.random() * 0.5,
        phase:     Math.random() * Math.PI * 2,
        frozen:    false,
      });
    }

    for (let i = 0; i < PATROL_OBSTACLE_COUNT; i++) {
      const ox = 8 + Math.floor(Math.random() * (cols - 16));
      const oy = 8 + Math.floor(Math.random() * (rows - 16));
      const w  = 6 + Math.floor(Math.random() * 5);
      const h  = 5 + Math.floor(Math.random() * 4);
      // 5-waypoint patrol route for more interesting movement
      this.patrolObstacles.push({
        id: i,
        cx: ox, cy: oy,
        route: [
          { x: ox,         y: oy     },
          { x: ox + w,     y: oy     },
          { x: ox + w,     y: oy + h },
          { x: ox + w / 2, y: oy + h / 2 },
          { x: ox,         y: oy + h },
        ],
        routeIdx: 0,
        speed:    0.6 + Math.random() * 0.4,
      });
    }

    this._stampGrid(grid);
  }

  // ── Per-frame tick (dt in seconds) ──────────────────────────

  tick(dt, grid) {
    if (!CONFIG.THREAT_ENABLED) return;

    this._clearStamps(grid);
    const { cols, rows } = grid;

    for (const t of this.dynamicThreats) {
      if (t.frozen) { t.phase += dt * 2.1; continue; }
      t.cx    += t.vx * dt;
      t.cy    += t.vy * dt;
      t.phase += dt * 2.1;

      const margin = t.radius + 0.5;
      if (t.cx < margin)        { t.vx =  Math.abs(t.vx); t.cx = margin; }
      if (t.cx > cols - margin) { t.vx = -Math.abs(t.vx); t.cx = cols - margin; }
      if (t.cy < margin)        { t.vy =  Math.abs(t.vy); t.cy = margin; }
      if (t.cy > rows - margin) { t.vy = -Math.abs(t.vy); t.cy = rows - margin; }
    }

    for (const p of this.patrolObstacles) {
      const wp   = p.route[(p.routeIdx + 1) % p.route.length];
      const dx   = wp.x - p.cx;
      const dy   = wp.y - p.cy;
      const dist = Math.hypot(dx, dy);
      const step = p.speed * dt;
      if (dist <= step + 0.01) {
        p.cx = wp.x; p.cy = wp.y;
        p.routeIdx = (p.routeIdx + 1) % p.route.length;
      } else {
        p.cx += (dx / dist) * step;
        p.cy += (dy / dist) * step;
      }
    }

    this._stampGrid(grid);
  }

  // ── Intensity query ─────────────────────────────────────────
  // Returns 0–1 threat intensity at grid cell (x, y)

  getThreatAt(x, y) {
    let maxIntensity = 0;
    for (const t of this.dynamicThreats) {
      const effRadius = t.radius + 0.4 * Math.sin(t.phase);
      const dist      = Math.hypot(x - t.cx, y - t.cy);
      if (dist <= effRadius + 0.5) {
        const falloff = Math.max(0, 1 - dist / (effRadius + 1));
        maxIntensity  = Math.max(maxIntensity, t.intensity * falloff);
      }
    }
    return maxIntensity;
  }

  // ── Runtime threat manipulation ─────────────────────────

  /** Add a brand-new dynamic threat at a random safe position. */
  addThreat(grid, type = 'ENEMY_DRONE') {
    const { cols, rows } = { ...CONFIG, cols: grid.cols, rows: grid.rows };
    const nextId = this.dynamicThreats.length > 0
      ? Math.max(...this.dynamicThreats.map(t => t.id)) + 1
      : 0;
    let cx, cy, attempts = 0;
    do {
      cx = 4 + Math.random() * (cols - 8);
      cy = 4 + Math.random() * (rows - 8);
      attempts++;
    } while (attempts < 50 && this._tooClose(cx, cy, grid));
    
    const t = {
      id:        nextId,
      cx, cy,
      type:      type,
      phase:     Math.random() * Math.PI * 2,
      frozen:    false,
    };

    if (type === 'ENEMY_DRONE') {
      const speed = CONFIG.THREAT_SPEED * (0.7 + Math.random() * 0.6);
      const angle = Math.random() * Math.PI * 2;
      t.vx = Math.cos(angle) * speed;
      t.vy = Math.sin(angle) * speed;
      t.radius = 1;
      t.intensity = 0.75;
    } else if (type === 'ANTI_AIR') {
      t.vx = 0; t.vy = 0;
      t.radius = 3;
      t.intensity = 1.0;
    } else if (type === 'PERSONNEL') {
      t.vx = 0; t.vy = 0;
      t.radius = 1;
      t.intensity = 0.4;
    }

    this.dynamicThreats.push(t);
    return t;
  }

  /** Remove a dynamic threat by id and erase its stamps. */
  removeThreat(id, grid) {
    this._clearStamps(grid);
    this.dynamicThreats = this.dynamicThreats.filter(t => t.id !== id);
    this._stampGrid(grid);
  }

  // ── Helpers ─────────────────────────────────────────────────

  _clearStamps(grid) {
    for (const { x, y, prevType } of this._prevStamps) {
      if (grid._inBounds(x, y)) grid.cells[y][x] = prevType;
    }
    this._prevStamps = [];
  }

  _stampGrid(grid) {
    const { CELL } = CONFIG;
    const noOverwrite = new Set([CELL.START, CELL.TARGET]);

    for (const t of this.dynamicThreats) {
      const effR = t.radius + Math.round(0.4 * Math.sin(t.phase));
      const cx   = Math.round(t.cx);
      const cy   = Math.round(t.cy);
      for (let dy = -effR; dy <= effR; dy++) {
        for (let dx = -effR; dx <= effR; dx++) {
          if (Math.hypot(dx, dy) > effR + 0.5) continue;
          const nx = cx + dx, ny = cy + dy;
          if (!grid._inBounds(nx, ny)) continue;
          const curr = grid.cells[ny][nx];
          if (noOverwrite.has(curr)) continue;
          this._prevStamps.push({ x: nx, y: ny, prevType: curr });
          grid.cells[ny][nx] = CELL.THREAT;
        }
      }
    }

    for (const p of this.patrolObstacles) {
      const cx = Math.round(p.cx), cy = Math.round(p.cy);
      if (!grid._inBounds(cx, cy)) continue;
      const curr = grid.cells[cy][cx];
      if (noOverwrite.has(curr)) continue;
      this._prevStamps.push({ x: cx, y: cy, prevType: curr });
      grid.cells[cy][cx] = CELL.OBSTACLE;
      if (!grid.obstacleHeights[cy]) grid.obstacleHeights[cy] = [];
      grid.obstacleHeights[cy][cx] = 2.5;
    }
  }

  _tooClose(cx, cy, grid) {
    const s   = grid.start;
    const tgt = grid.target;
    if (Math.hypot(cx - s.x, cy - s.y) < 6) return true;
    if (tgt && Math.hypot(cx - tgt.x, cy - tgt.y) < 6) return true;
    
    const gx = Math.floor(cx);
    const gy = Math.floor(cy);
    if (grid._inBounds && grid._inBounds(gx, gy)) {
      const cell = grid.cells[gy][gx];
      if (cell === CONFIG.CELL.OBSTACLE || cell === CONFIG.CELL.URBAN) return true;
    }
    return false;
  }
}
