// ============================================================
// grid.js — Grid state, procedural generation, obstacle heights
// ============================================================

class Grid {
  constructor() {
    this.cols            = CONFIG.GRID_COLS;
    this.rows            = CONFIG.GRID_ROWS;
    this.cells           = [];
    this.obstacleHeights = [];
    this.start           = { x: 1, y: 1 };
    this.target          = null;
  }

  generate() {
    const { CELL, OBSTACLE_COUNT, THREAT_ZONE_COUNT, THREAT_ZONE_RADIUS,
            SAFE_ZONE_COUNT, URBAN_BLOCK_COUNT, FOREST_PATCH_COUNT } = CONFIG;

    this.cells           = Array.from({ length: this.rows }, () => new Array(this.cols).fill(CELL.EMPTY));
    this.obstacleHeights = Array.from({ length: this.rows }, () => new Array(this.cols).fill(0));

    this.start  = { x: 1, y: 1 };
    this.target = { x: this.cols - 2, y: this.rows - 2 };

    this.cells[this.start.y][this.start.x]   = CELL.START;
    this.cells[this.target.y][this.target.x] = CELL.TARGET;

    // ── River corridor ───────────────────────────────────────
    const riverX = 10 + Math.floor(Math.random() * (this.cols - 20));
    const riverW = 1 + Math.floor(Math.random() * 2);
    for (let y = 2; y < this.rows - 2; y++) {
      const wobble = Math.round(Math.sin(y * 0.4) * 1.5);
      for (let w = 0; w <= riverW; w++) {
        const rx = riverX + wobble + w;
        if (this._isSafeToPlace(rx, y)) this.cells[y][rx] = CELL.RIVER;
      }
    }

    // ── Forest patches ───────────────────────────────────────
    for (let f = 0; f < FOREST_PATCH_COUNT; f++) {
      const fx = 4 + Math.floor(Math.random() * (this.cols - 8));
      const fy = 4 + Math.floor(Math.random() * (this.rows - 8));
      const fr = 2 + Math.floor(Math.random() * 3);
      for (let dy = -fr; dy <= fr; dy++) {
        for (let dx = -fr; dx <= fr; dx++) {
          if (Math.hypot(dx, dy) > fr) continue;
          const nx = fx + dx, ny = fy + dy;
          if (this._isSafeToPlace(nx, ny)) this.cells[ny][nx] = CELL.FOREST;
        }
      }
    }

    // ── Urban block clusters ─────────────────────────────────
    for (let u = 0; u < URBAN_BLOCK_COUNT; u++) {
      const ux = 5 + Math.floor(Math.random() * (this.cols - 10));
      const uy = 5 + Math.floor(Math.random() * (this.rows - 10));
      const uw = 2 + Math.floor(Math.random() * 4);
      const uh = 2 + Math.floor(Math.random() * 4);
      for (let dy = 0; dy < uh; dy++) {
        for (let dx = 0; dx < uw; dx++) {
          const nx = ux + dx, ny = uy + dy;
          if (!this._isSafeToPlace(nx, ny)) continue;
          const h = 2.8 + Math.random() * 2.0;
          this.cells[ny][nx]           = CELL.URBAN;
          this.obstacleHeights[ny][nx] = h;
        }
      }
    }

    // ── Scattered obstacles ──────────────────────────────────
    let placed = 0, attempts = 0;
    while (placed < OBSTACLE_COUNT && attempts < 15000) {
      attempts++;
      const x = Math.floor(Math.random() * (this.cols - 2)) + 1;
      const y = Math.floor(Math.random() * (this.rows - 2)) + 1;
      if (this._isSafeToPlace(x, y)) {
        const h = 1.4 + Math.random() * 1.2;
        this.cells[y][x]           = CELL.OBSTACLE;
        this.obstacleHeights[y][x] = h;
        placed++;
      }
    }

    // ── Threat zone blobs ────────────────────────────────────
    for (let t = 0; t < THREAT_ZONE_COUNT; t++) {
      const cx = 4 + Math.floor(Math.random() * (this.cols - 8));
      const cy = 4 + Math.floor(Math.random() * (this.rows - 8));
      for (let dy = -THREAT_ZONE_RADIUS; dy <= THREAT_ZONE_RADIUS; dy++) {
        for (let dx = -THREAT_ZONE_RADIUS; dx <= THREAT_ZONE_RADIUS; dx++) {
          const nx = cx + dx, ny = cy + dy;
          if (this._inBounds(nx, ny) && this._isSafeToPlace(nx, ny)) {
            this.cells[ny][nx] = CELL.THREAT;
          }
        }
      }
    }

    // ── Safe corridors ───────────────────────────────────────
    for (let s = 0; s < SAFE_ZONE_COUNT; s++) {
      const cx = 3 + Math.floor(Math.random() * (this.cols - 6));
      const cy = 3 + Math.floor(Math.random() * (this.rows - 6));
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const nx = cx + dx, ny = cy + dy;
          if (this._inBounds(nx, ny) && this.cells[ny][nx] === CELL.EMPTY)
            this.cells[ny][nx] = CELL.SAFE;
        }
      }
    }

    // Restore start + target
    this.cells[this.start.y][this.start.x]   = CELL.START;
    this.cells[this.target.y][this.target.x] = CELL.TARGET;

    return this;
  }

  // ── State Management for Undo/Redo ──────────────────────────

  clear() {
    const { CELL } = CONFIG;
    for (let y = 0; y < this.rows; y++) {
      for (let x = 0; x < this.cols; x++) {
        if (this.cells[y][x] !== CELL.START && this.cells[y][x] !== CELL.TARGET) {
          this.cells[y][x] = CELL.EMPTY;
        }
        if (this.obstacleHeights[y]) {
          this.obstacleHeights[y][x] = 0;
        }
      }
    }
  }

  getState() {
    // Deep copy cells and heights
    return {
      cells: this.cells.map(row => [...row]),
      heights: this.obstacleHeights.map(row => [...row]),
      target: this.target ? { x: this.target.x, y: this.target.y } : null
    };
  }

  setState(state) {
    if (!state) return;
    this.cells = state.cells.map(row => [...row]);
    this.obstacleHeights = state.heights.map(row => [...row]);
    this.target = state.target ? { x: state.target.x, y: state.target.y } : null;
  }

  // ── Cell access ─────────────────────────────────────────────

  get(x, y) {
    if (!this._inBounds(x, y)) return CONFIG.CELL.OBSTACLE;
    return this.cells[y][x];
  }

  set(x, y, type) {
    if (this._inBounds(x, y)) this.cells[y][x] = type;
  }

  getObstacleHeight(x, y) {
    if (!this._inBounds(x, y) || !this.obstacleHeights[y]) return 0;
    return this.obstacleHeights[y][x] || 0;
  }

  isWalkable(x, y) { return this._inBounds(x, y); }

  setTarget(x, y) {
    const { CELL } = CONFIG;
    const type = this.get(x, y);
    if (type === CELL.START) return false;
    if (this.target) {
      const old = this.get(this.target.x, this.target.y);
      if (old === CELL.TARGET) this.set(this.target.x, this.target.y, CELL.EMPTY);
    }
    this.target = { x, y };
    this.set(x, y, CELL.TARGET);
    return true;
  }

  // ── Private helpers ─────────────────────────────────────────

  _inBounds(x, y) {
    return x >= 0 && y >= 0 && x < this.cols && y < this.rows;
  }

  _isSafeToPlace(x, y) {
    const { CELL } = CONFIG;
    if (!this._inBounds(x, y)) return false;
    if (this.cells[y][x] !== CELL.EMPTY) return false;
    const tsStart  = Math.abs(x - this.start.x)  < 3 && Math.abs(y - this.start.y)  < 3;
    const tsTarget = this.target &&
                     Math.abs(x - this.target.x) < 3 && Math.abs(y - this.target.y) < 3;
    return !tsStart && !tsTarget;
  }
}
