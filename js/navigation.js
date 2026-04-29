// ============================================================
// navigation.js — A* (8-directional) + threat-aware replanning
// ============================================================

class AStar {
  /**
   * Find optimal path from start to goal.
   * 8-directional movement with diagonal cost √2.
   * priority: CONFIG.PRIORITY key — scales threat cell cost for urgent missions.
   * reserved: Set of "x,y" strings treated as moderate obstacles (swarm collision avoidance).
   */
  static findPath(grid, start, goal, reserved = new Set(), priority = CONFIG.PRIORITY.MEDIUM) {
    const { GRID_COLS, GRID_ROWS, CELL } = CONFIG;
    const key = (x, y) => `${x},${y}`;

    const threatMult = CONFIG.PRIORITY_THREAT_MULT[priority] ?? 1.0;

    const cellCost = (x, y) => {
      if (reserved.has(key(x, y))) return 4;
      switch (grid.get(x, y)) {
        case CELL.OBSTACLE: return CONFIG.COST_FLY_OVER;
        case CELL.URBAN:    return CONFIG.COST_URBAN;
        case CELL.SAFE:     return CONFIG.COST_SAFE;
        case CELL.THREAT:   return CONFIG.COST_THREAT * threatMult;
        case CELL.FOREST:   return CONFIG.COST_FOREST;
        case CELL.RIVER:    return CONFIG.COST_RIVER;
        case CELL.TARGET:   return CONFIG.COST_TARGET;
        case CELL.START:    return CONFIG.COST_EMPTY;
        default:            return CONFIG.COST_EMPTY;
      }
    };

    const heuristic = (x, y) =>
      Math.max(Math.abs(x - goal.x), Math.abs(y - goal.y));  // Chebyshev for 8-dir

    const openList  = [];
    const openSet   = new Set();
    const closedSet = new Set();
    const gScore    = {};
    const fScore    = {};
    const cameFrom  = {};

    const startKey = key(start.x, start.y);
    gScore[startKey] = 0;
    fScore[startKey] = heuristic(start.x, start.y);
    openList.push({ x: start.x, y: start.y, f: fScore[startKey] });
    openSet.add(startKey);

    // 8-directional neighbours with correct costs
    const DIRS = [
      { dx:  0, dy: -1, cost: 1 },
      { dx:  0, dy:  1, cost: 1 },
      { dx: -1, dy:  0, cost: 1 },
      { dx:  1, dy:  0, cost: 1 },
      { dx: -1, dy: -1, cost: Math.SQRT2 },
      { dx:  1, dy: -1, cost: Math.SQRT2 },
      { dx: -1, dy:  1, cost: Math.SQRT2 },
      { dx:  1, dy:  1, cost: Math.SQRT2 },
    ];

    while (openList.length > 0) {
      openList.sort((a, b) => a.f - b.f);
      const current    = openList.shift();
      const currentKey = key(current.x, current.y);
      openSet.delete(currentKey);

      if (current.x === goal.x && current.y === goal.y) {
        return AStar._reconstruct(cameFrom, current, key);
      }

      closedSet.add(currentKey);

      for (const { dx, dy, cost } of DIRS) {
        const nx = current.x + dx;
        const ny = current.y + dy;
        if (nx < 0 || ny < 0 || nx >= GRID_COLS || ny >= GRID_ROWS) continue;

        // Diagonal movement: block if both cardinal neighbours are obstacles
        if (dx !== 0 && dy !== 0) {
          const typeA = grid.get(current.x + dx, current.y);
          const typeB = grid.get(current.x, current.y + dy);
          const blocked = (t) => t === CONFIG.CELL.OBSTACLE;
          if (blocked(typeA) && blocked(typeB)) continue;
        }

        const neighborKey = key(nx, ny);
        if (closedSet.has(neighborKey)) continue;

        const tentativeG = (gScore[currentKey] ?? Infinity) + cellCost(nx, ny) * cost;

        if (tentativeG < (gScore[neighborKey] ?? Infinity)) {
          cameFrom[neighborKey] = { x: current.x, y: current.y };
          gScore[neighborKey]   = tentativeG;
          fScore[neighborKey]   = tentativeG + heuristic(nx, ny);

          if (!openSet.has(neighborKey)) {
            openList.push({ x: nx, y: ny, f: fScore[neighborKey] });
            openSet.add(neighborKey);
          }
        }
      }
    }

    return null;
  }

  // ── Replan decision ─────────────────────────────────────────

  /**
   * Returns true if any of the next REPLAN_LOOKAHEAD steps now contains
   * a threat cell or has a dynamic threat intensity > 0.3.
   */
  static shouldReplan(drone, grid, threatManager = null) {
    if (!drone.path || drone.path.length === 0) return false;

    // Check if target has moved
    if (grid.target) {
      const currentGoal = drone.fullPath ? drone.fullPath[drone.fullPath.length - 1] : null;
      if (currentGoal && (currentGoal.x !== grid.target.x || currentGoal.y !== grid.target.y)) {
        return true; // Target moved, need to replan
      }
    }

    const lookahead = drone.path.slice(0, CONFIG.REPLAN_LOOKAHEAD);
    for (const p of lookahead) {
      if (grid.get(p.x, p.y) === CONFIG.CELL.THREAT) return true;
      if (threatManager && threatManager.getThreatAt(p.x, p.y) > 0.3) return true;
    }
    return false;
  }

  // ── Path hash — for change detection ─────────────────────────

  static hashPath(path, grid) {
    if (!path || path.length === 0) return '';
    return path.slice(0, 12).map(p => grid.get(p.x, p.y)).join(',');
  }

  static needsReplan(drone, grid, lastHash) {
    if (!drone.path || drone.path.length === 0) return false;
    return AStar.hashPath(drone.path, grid) !== lastHash;
  }

  // ── Reconstruct ──────────────────────────────────────────────

  static _reconstruct(cameFrom, current, keyFn) {
    const path = [];
    let node = current;
    while (node) {
      path.unshift({ x: node.x, y: node.y });
      node = cameFrom[keyFn(node.x, node.y)] || null;
    }
    return path.length > 1 ? path : null;
  }
}
