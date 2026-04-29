// ============================================================
// config.js — All simulation constants
// ============================================================

const CONFIG = {
  GRID_COLS: 40,
  GRID_ROWS: 35,

  CELL: {
    EMPTY:    0,
    OBSTACLE: 1,
    THREAT:   2,
    TARGET:   3,
    SAFE:     4,
    START:    5,
    URBAN:    6,   // dense city block — high cost, tall buildings
    FOREST:   7,   // tree canopy — medium cost
    RIVER:    8,   // water — forces high altitude, high cost
  },

  OBSTACLE_COUNT:       100,
  THREAT_ZONE_COUNT:      6,
  THREAT_ZONE_RADIUS:     2,
  SAFE_ZONE_COUNT:        4,
  URBAN_BLOCK_COUNT:      4,
  FOREST_PATCH_COUNT:     5,

  // Dynamic threats
  DYNAMIC_THREAT_COUNT:   6,
  PATROL_OBSTACLE_COUNT:  3,
  THREAT_SPEED:           1.2,  // cells per second (mutable via UI)
  THREAT_ENABLED:         true,

  // Moving target
  MOVING_TARGET_ENABLED:  false,
  MOVING_TARGET_SPEED:    1.0,

  // Replanning
  THREAT_REPLAN_COOLDOWN_MS: 800,
  REPLAN_LOOKAHEAD:           6,  // steps ahead to check for threat collision

  // A* costs
  COST_EMPTY:    1,
  COST_SAFE:     0.5,
  COST_THREAT:   9,
  COST_TARGET:   1,
  COST_FLY_OVER: 3.5,
  COST_URBAN:    5,
  COST_FOREST:   2,
  COST_RIVER:    8,

  // Battery defaults (recalculated when specs applied)
  BATTERY_DRAIN_NORMAL: 0.4,
  BATTERY_DRAIN_THREAT: 1.2,
  MOVE_INTERVAL_MS:     800,

  // Fuel system (litres)
  FUEL_CAPACITY:     5.0,
  FUEL_DRAIN_NORMAL: 0.04,
  FUEL_DRAIN_THREAT: 0.12,
  FUEL_DRAIN_URBAN:  0.08,

  // Drone flight altitudes
  DRONE_FLY_HEIGHT:       2.6,
  DRONE_MIN_ALT:          1.5,
  DRONE_MAX_ALT:          8.0,
  DRONE_ALT_STEP:         0.4,
  OBSTACLE_FLY_CLEARANCE: 0.7,
  RIVER_FLY_HEIGHT:       4.5,

  // Default drone specs
  DRONE_SPECS: {
    battery_mah: 5000,
    voltage:     14.8,
    motor_power: 200,
    speed_ms:    10,
    cell_size_m: 10,
    payload_kg:  0.5,
  },

  // Swarm
  SWARM_MAX: 4,

  // Mission priorities — multiplier applied to COST_THREAT
  PRIORITY: { LOW: 'LOW', MEDIUM: 'MEDIUM', HIGH: 'HIGH', CRITICAL: 'CRITICAL' },
  PRIORITY_THREAT_MULT: { LOW: 1.0, MEDIUM: 0.75, HIGH: 0.45, CRITICAL: 0.15 },

  TRAIL_LENGTH: 18,
  ROTOR_SPEED:  0.32,

  // Swarm drone colors by role
  SWARM_ROLE_COLOR: {
    SCOUT:  0x00ffcc,
    STRIKE: 0xff4400,
    RELAY:  0xffcc00,
    RESCUE: 0x4499ff,
  },

  COLOR: {
    BG:            0x080d08,
    EMPTY_GROUND:  0x0a140a,
    OBSTACLE:      0x5a0000,
    OBSTACLE_TOP:  0x8b0000,
    THREAT:        0xff1111,
    TARGET:        0xffd700,
    SAFE:          0x003311,
    START:         0x0a0a3a,
    DRONE_BODY:    0x111111,
    DRONE_ARM:     0x00cc66,
    DRONE_ROTOR:   0x00ff88,
    PATH:          0x00ccff,
    AMBIENT:       0x112211,
    DIR_LIGHT:     0x66ffaa,
    DRONE_LIGHT:   0x00ff88,
    TARGET_LIGHT:  0xffd700,
    FOG:           0x080d08,
    URBAN:         0x16192e,
    URBAN_TOP:     0x252850,
    FOREST:        0x0d2e0d,
    FOREST_CONE:   0x1a5c1a,
    RIVER:         0x001830,
    RIVER_SURFACE: 0x003d6e,
    DYN_THREAT:    0xff2200,
    PATROL:        0xff8800,
  },
};

const STATUS = {
  IDLE:        'IDLE',
  NAVIGATING:  'NAVIGATING',
  REACHED:     'MISSION COMPLETE',
  FAILED:      'MISSION FAILED',
  NO_PATH:     'NO PATH FOUND',
  CALCULATING: 'CALCULATING',
};

const ROLE       = { SCOUT: 'SCOUT', STRIKE: 'STRIKE', RELAY: 'RELAY', RESCUE: 'RESCUE' };
const FORMATION  = { FREE: 'FREE', DELTA: 'DELTA', LINE: 'LINE', ORBIT: 'ORBIT' };
