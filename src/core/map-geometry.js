// ==========================================================================
// NODEX ACE - Warehouse Map Geometry & Collision Engine
// Authoritative geometry, obstacle models, corridor waypoints & physics checks
// Adaptive warehouse generation for 3/10/50/100 robot fleets
// ==========================================================================

import { state } from "./state.js";

// Mutable: the 100-robot tier extends the floor (see setWarehouseFloor).
// Every consumer reads these fields live, so they follow the active layout.
export const WAREHOUSE_DIMENSIONS = {
  width: 900,
  height: 520,
  bounds: {
    minX: 20,
    maxX: 880,
    minY: 15,
    maxY: 505
  }
};

const DEFAULT_FLOOR = { width: 900, height: 520 };

/** Sets the active floor size; bounds keep a 20px/15px wall margin. */
export function setWarehouseFloor({ width, height } = DEFAULT_FLOOR) {
  WAREHOUSE_DIMENSIONS.width = width;
  WAREHOUSE_DIMENSIONS.height = height;
  WAREHOUSE_DIMENSIONS.bounds.maxX = width - 20;
  WAREHOUSE_DIMENSIONS.bounds.maxY = height - 15;
}

// ==========================================================================
// WORLD PROFILES — the world itself grows with the fleet (not a camera zoom).
// Every supported fleet size selects its own floor, aisle grid (navigable
// area, lane count, intersection count), shelf count and task locations.
// Strict order of world area: 3 < 10 < 50 < 100.
//   3   -> 700 x 360   (4 cross lanes x 3 aisles, 4 rack cells)
//   10  -> 900 x 520   (5 x 4, the reference warehouse)
//   50  -> 1700 x 850  (10 x 6, rectangular ~2:1, r6-bigmap)
//   100 -> 2300 x 1150 (14 x 8, rectangular 2:1, r6-bigmap)
// The large worlds extend the reference grid east and south with a regular
// 160 px (x) / 140 px (y) lane pitch, so every reference coordinate (stress
// points, stations) still lies on a lane; racks, stations, bays and charging
// follow the same generator rules, just over more cells.
// ==========================================================================
const AISLE_X = [145, 212, 352, 578, 740, 900];
const AISLE_Y = [35, 165, 305, 455, 595];
const extendGrid = (base, pitch, last) => {
  const out = [...base];
  while (out[out.length - 1] + pitch <= last) out.push(out[out.length - 1] + pitch);
  return out;
};
const BIG_X_50 = extendGrid(AISLE_X, 160, 1540);   // 10 cross lanes
const BIG_Y_50 = extendGrid(AISLE_Y, 140, 735);    // 6 aisles
const BIG_X_100 = extendGrid(AISLE_X, 160, 2180);  // 14 cross lanes
const BIG_Y_100 = extendGrid(AISLE_Y, 140, 1015);  // 8 aisles

export const WORLD_PROFILES = {
  3: {
    id: "WORLD-S", label: "Small warehouse",
    floor: { width: 700, height: 360 },
    aisleX: AISLE_X.slice(0, 4), aisleY: AISLE_Y.slice(0, 3),
    shelfCount: 4
  },
  10: {
    id: "WORLD-M", label: "Large warehouse",
    floor: { width: 900, height: 520 },
    aisleX: AISLE_X.slice(0, 5), aisleY: AISLE_Y.slice(0, 4),
    shelfCount: 8
  },
  50: {
    id: "WORLD-L", label: "Larger warehouse (rectangular)",
    floor: { width: 1700, height: 850 },
    aisleX: BIG_X_50, aisleY: BIG_Y_50,
    shelfCount: 22
  },
  100: {
    id: "WORLD-XL", label: "Largest warehouse (rectangular)",
    floor: { width: 2300, height: 1150 },
    aisleX: BIG_X_100, aisleY: BIG_Y_100,
    shelfCount: 44
  }
};

/** Supported tier for a fleet size (smallest tier that holds the fleet). */
export function worldTierFor(fleetSize) {
  for (const tier of [3, 10, 50, 100]) if (fleetSize <= tier) return tier;
  return 100;
}

// Task stations per world. Every station sits on an aisle intersection that
// exists in that world, so tasks always fit the selected map.
const BASE_TASK_LOCATIONS = [
  { id: "Storage-A1", name: "Storage Bay A-01", x: 212, y: 165 },
  { id: "Storage-A2", name: "Storage Bay A-02", x: 212, y: 305 },
  { id: "Storage-B1", name: "Storage Bay B-01", x: 352, y: 165 },
  { id: "Storage-B2", name: "Storage Bay B-02", x: 578, y: 165 },
  { id: "Storage-B3", name: "Storage Bay B-03", x: 578, y: 305 },
  { id: "Receiving-1", name: "Receiving Dock 1", x: 145, y: 35 },
  { id: "Receiving-2", name: "Receiving Dock 2", x: 145, y: 165 },
  { id: "Picking-1", name: "Picking Zone 1", x: 740, y: 35 },
  { id: "Packing-1", name: "Packing Station 1", x: 740, y: 165 },
  { id: "Shipping-1", name: "Shipping Bay 1", x: 740, y: 305 },
  { id: "Maintenance", name: "Maintenance Bay", x: 352, y: 455 },
  { id: "Charging", name: "Charging Zone", x: 145, y: 455 }
];
const SMALL_WORLD_TASK_LOCATIONS = [
  { id: "Storage-A1", name: "Storage Bay A-01", x: 212, y: 165 },
  { id: "Storage-A2", name: "Storage Bay A-02", x: 212, y: 305 },
  { id: "Storage-B1", name: "Storage Bay B-01", x: 352, y: 165 },
  { id: "Storage-B2", name: "Storage Bay B-02", x: 578, y: 165 },
  { id: "Storage-B3", name: "Storage Bay B-03", x: 578, y: 305 },
  { id: "Receiving-1", name: "Receiving Dock 1", x: 145, y: 35 },
  { id: "Receiving-2", name: "Receiving Dock 2", x: 145, y: 165 },
  { id: "Picking-1", name: "Picking Zone 1", x: 578, y: 35 },
  { id: "Packing-1", name: "Packing Station 1", x: 352, y: 35 },
  { id: "Shipping-1", name: "Shipping Bay 1", x: 352, y: 305 },
  { id: "Maintenance", name: "Maintenance Bay", x: 145, y: 305 },
  { id: "Charging", name: "Charging Zone", x: 212, y: 35 }
];
const EXTENDED_TASK_LOCATIONS = [
  ...BASE_TASK_LOCATIONS,
  { id: "Picking-2", name: "Picking Zone 2", x: 900, y: 165 },
  { id: "Shipping-2", name: "Shipping Bay 2", x: 900, y: 455 },
  { id: "Packing-2", name: "Packing Station 2", x: 740, y: 595 },
  { id: "Receiving-3", name: "Receiving Dock 3", x: 352, y: 595 }
];
// Large rectangular worlds: the extended stations plus one station on every
// other new intersection (checkerboard, deterministic), named by floor band
// (west = receiving ... east = shipping) so zone-based generators still work.
function bigWorldTaskLocations(xs, ys) {
  const list = EXTENDED_TASK_LOCATIONS.map(l => ({ ...l }));
  const taken = new Set(list.map(l => `${l.x},${l.y}`));
  const maxX = xs[xs.length - 1];
  const bands = [["Receiving", "Receiving Dock"], ["Storage", "Storage Bay"], ["Picking", "Picking Zone"], ["Packing", "Packing Station"], ["Shipping", "Shipping Bay"]];
  const counters = {};
  ys.forEach((y, j) => xs.forEach((x, i) => {
    if (x <= 900 && y <= 595) return;            // reference area keeps its stations
    if ((i + j) % 2 !== 0 || taken.has(`${x},${y}`)) return;
    const [key, label] = bands[Math.min(bands.length - 1, Math.floor((x / maxX) * bands.length))];
    counters[key] = (counters[key] || 0) + 1;
    list.push({ id: `${key}-X${counters[key]}`, name: `${label} X-${String(counters[key]).padStart(2, "0")}`, x, y });
  }));
  return list;
}
const TASK_LOCATIONS_BY_TIER = {
  3: SMALL_WORLD_TASK_LOCATIONS,
  10: BASE_TASK_LOCATIONS,
  50: bigWorldTaskLocations(BIG_X_50, BIG_Y_50),
  100: bigWorldTaskLocations(BIG_X_100, BIG_Y_100)
};

// Mutable, like WAREHOUSE_DIMENSIONS: refilled in place for the active world,
// so every importer reads the stations of the map that is actually loaded.
export const WAREHOUSE_TASK_LOCATIONS = BASE_TASK_LOCATIONS.map(l => ({ ...l }));

function setTaskLocations(list) {
  WAREHOUSE_TASK_LOCATIONS.length = 0;
  WAREHOUSE_TASK_LOCATIONS.push(...list.map(l => ({ ...l })));
}

// Deepest parking-bay row behind an aisle (see computeParkingBays).
const MAX_BAY_DEPTH = 4;

export const ROBOT_FOOTPRINT = {
  radius: 12,       // Physical radius in world coordinates
  safetyMargin: 4,  // Clearance buffer for collision avoidance
  totalRadius: 16   // radius + safetyMargin
};

// ==========================================================================
// ADAPTIVE WAREHOUSE MAP GENERATOR
// ==========================================================================

export class WarehouseMapGenerator {
  /**
   * Generate a complete warehouse layout adapted to fleet size and scenario.
   * Returns: { obstacles, aisles, waypoints, spawnPositions, pickupZones, dropZones, chargingZones, mapMetadata }
   */
  static generate(fleetSize, scenarioCode = "S01", mapId = "WH-A") {
    const config = this.getLayoutConfig(fleetSize, scenarioCode);
    setWarehouseFloor(config.floor || DEFAULT_FLOOR);
    const seed = state.get("seed") || 18427;
    const rng = this.createSeededRNG(seed + fleetSize);

    // 1. Generate shelf clusters based on config
    const obstacles = this.generateShelfClusters(config, rng, mapId);
    
    // 2. Generate driving corridors (aisles) that avoid obstacles
    const aisles = this.generateDrivingCorridors(config, obstacles);
    
    // 3. Generate navigation waypoints at aisle intersections
    const waypoints = this.generateWaypoints(aisles);
    
    // 4. Generate valid spawn positions (on corridors, not in obstacles)
    const spawnPositions = this.generateSpawnPositions(fleetSize, aisles, obstacles, rng);
    
    // 5. Generate pickup/drop zones (on shelf faces or valid zones)
    const { pickupZones, dropZones } = this.generateTaskZones(config, obstacles, aisles, rng);
    
    // 6. Generate charging zones if needed by scenario
    const chargingZones = this.generateChargingZones(config, scenarioCode, obstacles, aisles, rng);
    
    // 7. Calculate map metadata (zoom, robot marker size)
    const mapMetadata = this.calculateMapMetadata(fleetSize, config);

    return {
      obstacles,
      aisles,
      waypoints,
      spawnPositions,
      pickupZones,
      dropZones,
      chargingZones,
      mapMetadata,
      config
    };
  }

  /**
   * Get layout configuration for a given fleet size and scenario.
   */
  static getLayoutConfig(fleetSize, scenarioCode) {
    // The world profile is selected by fleet size (see WORLD_PROFILES): floor,
    // aisle grid and rack count all grow with the fleet.
    // Benchmark stress trials are authored on the reference world and may pin
    // it (MapGeometryEngine.worldTierOverride); live runs never set it.
    const tier = MapGeometryEngine.worldTierOverride || worldTierFor(fleetSize);
    const profile = WORLD_PROFILES[tier];
    const densityByTier = { 3: "sparse", 10: "moderate", 50: "dense", 100: "very_dense" };
    let config = {
      worldTier: tier,
      worldProfileId: profile.id,
      worldLabel: profile.label,
      floor: { ...profile.floor },
      aisleX: [...profile.aisleX],
      aisleY: [...profile.aisleY],
      parkingLaneY: profile.parkingLaneY || null,
      shelfClusters: profile.shelfCount,
      shelvesPerCluster: 2,
      corridorDensity: densityByTier[tier],
      zones: tier >= 50 ? 5 : tier === 10 ? 3 : 2
    };

    // Scenario-specific modifications. Relative rack counts ("+2") add to the
    // world's rack count (they used to replace it with the string itself).
    const scenarioMods = { ...this.getScenarioModifications(scenarioCode) };
    if (typeof scenarioMods.shelfClusters === "string") {
      config.shelfClusters += parseInt(scenarioMods.shelfClusters, 10) || 0;
      delete scenarioMods.shelfClusters;
    }
    config = { ...config, ...scenarioMods };

    config.fleetSize = fleetSize;
    config.scenarioCode = scenarioCode;
    return config;
  }

  /**
   * Scenario-specific layout modifications.
   */
  static getScenarioModifications(scenarioCode) {
    const mods = {
      "S01": {}, // Normal - base layout
      "S02": { corridorDensity: "dense", shelfClusters: "+1" }, // High task load - more shelves
      "S03": { corridorDensity: "dense", shelfClusters: "+2" }, // High traffic - more corridors
      "S04": { corridorDensity: "dense" }, // Crossing conflict - emphasize crossing zone
      "S05": { dynamicObstacles: true, corridorDensity: "moderate" }, // Dynamic obstacle
      "S06": { corridorDensity: "moderate" }, // Comm delay
      "S07": { corridorDensity: "moderate" }, // Comm loss
      "S08": { corridorDensity: "moderate" }, // Robot failure
      "S09": { corridorDensity: "very_dense", shelfClusters: "+2" }, // Deadlock - complex layout
      "S10": { corridorDensity: "moderate" }, // Sensor uncertainty
      "S11": { dynamicObstacles: true }, // Lease expiry
      "S12": { corridorDensity: "moderate" }, // Health degradation
      "S13": { corridorDensity: "very_dense", shelfClusters: "+3", dynamicObstacles: true }, // Combined stress
      "S14": { corridorDensity: "moderate" }, // Central link failure
      "A01": { corridorDensity: "dense" }, // Adaptive lifecycle
      "A02": { corridorDensity: "moderate" },
      "A03": { corridorDensity: "moderate" },
      "A04": { corridorDensity: "very_dense", shelfClusters: "+2" }, // Cascade pressure
      "A05": { corridorDensity: "dense" }, // Space-time contract
      "A06": { corridorDensity: "dense" }, // Conflict detection
      "A07": { corridorDensity: "moderate" },
      "A08": { corridorDensity: "very_dense" }, // Deadlock
      "A09": { corridorDensity: "moderate" },
      "A10": { corridorDensity: "moderate" },
      "A11": { corridorDensity: "very_dense", dynamicObstacles: true }, // Safe-degraded
      "A12": { corridorDensity: "moderate" } // HITL
    };
    return mods[scenarioCode] || {};
  }

  /**
   * Create a seeded random number generator for reproducible layouts.
   */
  static createSeededRNG(seed) {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return (s >>> 0) / 0xffffffff;
    };
  }

  /**
   * Generate shelf clusters (storage racks) in valid cells between fixed aisles.
   */
  static generateShelfClusters(config, rng, mapId) {
    const obstacles = [];
    const { shelfClusters, shelvesPerCluster } = config;

    // Aisle grid of the selected world profile
    const hAisles = config.aisleY || AISLE_Y.slice(0, 4);
    const vAisles = config.aisleX || AISLE_X.slice(0, 5);
    
    // Calculate valid cells between aisles
    const cells = [];
    for (let hi = 0; hi < hAisles.length - 1; hi++) {
      for (let vi = 0; vi < vAisles.length - 1; vi++) {
        const cell = {
          minX: vAisles[vi] + 20,
          maxX: vAisles[vi + 1] - 20,
          minY: hAisles[hi] + 20,
          maxY: hAisles[hi + 1] - 20,
          col: vi,
          row: hi
        };
        if (cell.maxX - cell.minX > 60 && cell.maxY - cell.minY > 60) {
          cells.push(cell);
        }
      }
    }

    // Spread racks over the whole world: visit cells in a stride order
    // (even indices first, then odd) instead of filling the first cells.
    cells.sort((a, b) => ((a.row + a.col) % 2) - ((b.row + b.col) % 2) || a.row - b.row || a.col - b.col);

    // Shelf dimensions
    const shelfWidth = 75;
    const shelfHeight = 80;
    const shelfGap = 15;
    const aisleWidth = 40;

    // Distribute shelf clusters across valid cells
    const numCells = cells.length;
    const clustersPerCell = Math.max(1, Math.ceil(shelfClusters / numCells));
    
    let clusterId = 0;
    for (let ci = 0; ci < cells.length && clusterId < shelfClusters; ci++) {
      const cell = cells[ci];
      const clustersInCell = Math.min(clustersPerCell, shelfClusters - clusterId);
      
      for (let c = 0; c < clustersInCell; c++) {
        // Place shelves within the cell
        const cellWidth = cell.maxX - cell.minX;
        const cellHeight = cell.maxY - cell.minY;
        
        // Calculate how many shelves fit in this cell
        const maxCols = Math.max(1, Math.floor((cellWidth + shelfGap) / (shelfWidth + shelfGap)));
        const maxRows = Math.max(1, Math.min(shelvesPerCluster, Math.floor((cellHeight + 20) / (shelfHeight + 20))));
        
        for (let row = 0; row < maxRows; row++) {
          for (let col = 0; col < maxCols && clusterId < shelfClusters; col++) {
            const sx = cell.minX + col * (shelfWidth + shelfGap) + (cellWidth - maxCols * (shelfWidth + shelfGap) + shelfGap) / 2;
            const sy = cell.minY + row * (shelfHeight + 20) + (cellHeight - maxRows * (shelfHeight + 20) + 20) / 2;
            
            // Ensure shelf stays within cell bounds
            if (sx + shelfWidth > cell.maxX || sy + shelfHeight > cell.maxY) continue;

            const shelf = {
              id: `RACK-${mapId}-${clusterId}-${row}-${col}`,
              name: `Storage ${String.fromCharCode(65 + clusterId)}-${row}-${col}`,
              minX: Math.round(sx),
              minY: Math.round(sy),
              maxX: Math.round(sx + shelfWidth),
              maxY: Math.round(sy + shelfHeight),
              type: "shelf",
              clusterId: clusterId,
              row,
              col
            };

            // Validate: no overlap with existing obstacles, adequate corridor space
            if (this.validateShelfPlacement(shelf, obstacles, aisleWidth)) {
              obstacles.push(shelf);
              clusterId++;
            }
          }
        }
      }
    }

    // Add hazard/restricted zones based on scenario (in non-shelf areas)
    if (config.dynamicObstacles || rng() < 0.3) {
      this.addRestrictedZones(obstacles, rng, cells);
    }

    return obstacles;
  }

  /**
   * Calculate optimal cluster positions for even distribution.
   */
  static calculateClusterPositions(config, rng, minX, maxX, minY, maxY) {
    const { shelfClusters, clusterSpacing, corridorDensity } = config;
    const positions = [];
    
    // Base positions - distributed across warehouse
    const cols = Math.ceil(Math.sqrt(shelfClusters));
    const rows = Math.ceil(shelfClusters / cols);
    
    const startX = minX + 40;
    const startY = minY + 40;
    const stepX = Math.max(clusterSpacing, 150);
    const stepY = 160;

    for (let i = 0; i < shelfClusters; i++) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      
      let x = startX + col * stepX + (rng() - 0.5) * 20;
      let y = startY + row * stepY + (rng() - 0.5) * 15;
      
      // Clamp to bounds
      x = Math.max(minX + 30, Math.min(maxX - 150, x));
      y = Math.max(minY + 30, Math.min(maxY - 200, y));
      
      positions.push({ x: Math.round(x), y: Math.round(y), rows: 2 });
    }

    return positions;
  }

  /**
   * Validate shelf placement - no overlap, adequate corridors.
   */
  static validateShelfPlacement(shelf, existingObstacles, minAisleWidth) {
    for (const obs of existingObstacles) {
      if (obs.type !== "shelf") continue;
      
      // Check overlap with buffer
      const buffer = minAisleWidth;
      if (shelf.minX < obs.maxX + buffer &&
          shelf.maxX > obs.minX - buffer &&
          shelf.minY < obs.maxY + buffer &&
          shelf.maxY > obs.minY - buffer) {
        return false; // Too close to another shelf
      }
    }
    return true;
  }

  /**
   * Add restricted/hazard zones in valid non-shelf areas.
   */
  static addRestrictedZones(obstacles, rng, cells) {
    const zoneCount = 1 + Math.floor(rng() * 2);
    const validCells = cells.filter(c => 
      !obstacles.some(o => o.type === "shelf" && 
        o.minX < c.maxX && o.maxX > c.minX &&
        o.minY < c.maxY && o.maxY > c.minY)
    );
    
    for (let i = 0; i < zoneCount && i < validCells.length; i++) {
      const cell = validCells[i];
      const w = 40 + rng() * 30;
      const h = 50 + rng() * 40;
      const x = Math.max(cell.minX, Math.min(cell.maxX - w, cell.minX + rng() * (cell.maxX - cell.minX - w)));
      const y = Math.max(cell.minY, Math.min(cell.maxY - h, cell.minY + rng() * (cell.maxY - cell.minY - h)));
      
      // Avoid placing on existing shelves
      let valid = true;
      for (const obs of obstacles) {
        if (obs.type !== "shelf") continue;
        if (x < obs.maxX + 20 && x + w > obs.minX - 20 &&
            y < obs.maxY + 20 && y + h > obs.minY - 20) {
          valid = false; break;
        }
      }
      if (valid) {
        obstacles.push({
          id: `ZONE-HAZARD-${i}`,
          name: `Restricted Zone ${i + 1}`,
          minX: x, minY: y, maxX: x + w, maxY: y + h,
          type: "restricted"
        });
      }
    }
  }

  /**
   * Generate driving corridors (aisles) - uses FIXED aisle positions for guaranteed validity.
   * Only shelf clusters vary based on fleet size.
   */
  static generateDrivingCorridors(config, obstacles) {
    // Aisle grid comes from the world profile; lanes, not racks, define the
    // navigable network, so racks are placed only in the cells between them.
    const aisles = this._corridorsFor(config);
    if (config.parkingLaneY) {
      // Staging area: every cross lane continues south to the parking lane.
      const hMaxX = aisles.horizontal[0].maxX;
      for (const v of aisles.vertical) v.maxY = config.parkingLaneY;
      aisles.horizontal.push({ id: "H-PARK", y: config.parkingLaneY, minX: 60, maxX: hMaxX, label: "South Staging / Parking Lane" });
    }
    return aisles;
  }

  static _corridorsFor(config = {}) {
    const xs = config.aisleX || AISLE_X.slice(0, 5);
    const ys = config.aisleY || AISLE_Y.slice(0, 4);
    const floorW = config.floor?.width || DEFAULT_FLOOR.width;
    const hMaxX = Math.min(xs[xs.length - 1] + 100, floorW - 60);
    const H_LABELS = {
      35: ["H-TOP", "North Periphery Lane"],
      165: ["H-MID1", "Aisle A-B Crossway 1"],
      305: ["H-MID2", "Aisle A-B Crossway 2 (Main Crossing)"],
      455: ["H-BTM", "South Transit Lane"],
      595: ["H-SOUTH", "South Outer Lane"]
    };
    const V_LABELS = {
      145: ["V-WEST", "West Transit Corridor"],
      212: ["V-MID1", "Aisle 1 Cross Lane"],
      352: ["V-MID2", "Central Crossing Lane (Hotspot)"],
      578: ["V-MID3", "Aisle 2 Cross Lane"],
      740: ["V-EAST", "East Dispatch Corridor"],
      900: ["V-FAR-EAST", "Far East Dispatch Corridor"]
    };
    const lastY = ys[ys.length - 1];
    // Lanes of the large rectangular worlds get generic ids / labels.
    const hl = y => H_LABELS[y] || [`H-${y}`, `Aisle Row y${y}`];
    const vl = x => V_LABELS[x] || [`V-${x}`, `Cross Lane x${x}`];
    return {
      horizontal: ys.map((y, i) => ({
        id: hl(y)[0], y,
        // Periphery lanes (first and last) run to the west wall area.
        minX: i === 0 || i === ys.length - 1 ? 60 : 120,
        maxX: hMaxX, label: hl(y)[1]
      })),
      vertical: xs.map(x => ({ id: vl(x)[0], x, minY: ys[0], maxY: lastY, label: vl(x)[1] }))
    };
  }

  /** Reference (10-robot) aisle network. */
  static _fixedCorridors() {
    return this._corridorsFor({ aisleX: AISLE_X.slice(0, 5), aisleY: AISLE_Y.slice(0, 4), floor: DEFAULT_FLOOR });
  }

  /**
   * Validate horizontal aisle doesn't intersect shelves.
   * Aisle is 40px wide (20px each side of centerline), needs 20px clearance = 40px total from shelf edge.
   */
  static validateAisleY(y, obstacles) {
    const aisleHalfWidth = 20;
    const clearance = 20;
    const totalBuffer = aisleHalfWidth + clearance; // 40px
    
    for (const obs of obstacles) {
      if (obs.type !== "shelf") continue;
      // Check if aisle (with buffer) intersects shelf
      if (y + aisleHalfWidth >= obs.minY - clearance && y - aisleHalfWidth <= obs.maxY + clearance) return false;
    }
    return true;
  }

  /**
   * Validate vertical aisle doesn't intersect shelves.
   * Aisle is 40px wide (20px each side of centerline), needs 20px clearance = 40px total from shelf edge.
   */
  static validateAisleX(x, obstacles) {
    const aisleHalfWidth = 20;
    const clearance = 20;
    const totalBuffer = aisleHalfWidth + clearance; // 40px
    
    for (const obs of obstacles) {
      if (obs.type !== "shelf") continue;
      // Check if aisle (with buffer) intersects shelf
      if (x + aisleHalfWidth >= obs.minX - clearance && x - aisleHalfWidth <= obs.maxX + clearance) return false;
    }
    return true;
  }

  /**
   * Generate navigation waypoints at aisle intersections.
   */
  static generateWaypoints(aisles) {
    const waypoints = [];
    for (const h of aisles.horizontal) {
      for (const v of aisles.vertical) {
        waypoints.push({
          id: `WP-${v.x}-${h.y}`,
          x: v.x,
          y: h.y,
          hAisle: h.id,
          vAisle: v.id
        });
      }
    }
    return waypoints;
  }

  /**
   * Generate valid robot spawn positions on corridors.
   */
  static generateSpawnPositions(fleetSize, aisles, obstacles, rng) {
    const positions = [];
    const candidates = [];

    // Collect valid positions along corridors
    for (const h of aisles.horizontal) {
      for (const v of aisles.vertical) {
        const x = v.x;
        const y = h.y;
        if (this.isValidSpawnPosition(x, y, obstacles)) {
          candidates.push({ x, y, hAisle: h.id, vAisle: v.id });
        }
      }
    }

    // Also add positions along corridor segments (not just intersections)
    for (const h of aisles.horizontal) {
      for (let x = h.minX + 40; x < h.maxX - 40; x += 80) {
        if (this.isValidSpawnPosition(x, h.y, obstacles)) {
          candidates.push({ x, y: h.y, onAisle: h.id });
        }
      }
    }
    for (const v of aisles.vertical) {
      for (let y = v.minY + 40; y < v.maxY - 40; y += 80) {
        if (this.isValidSpawnPosition(v.x, y, obstacles)) {
          candidates.push({ x: v.x, y, onAisle: v.id });
        }
      }
    }

    // Shuffle and pick required number
    this.shuffleArray(candidates, rng);
    for (let i = 0; i < Math.min(fleetSize, candidates.length); i++) {
      positions.push(candidates[i]);
    }

    return positions;
  }

  /**
   * Check if a position is valid for robot spawn.
   */
  static isValidSpawnPosition(x, y, obstacles) {
    const radius = ROBOT_FOOTPRINT.totalRadius;
    // Check bounds
    const b = WAREHOUSE_DIMENSIONS.bounds;
    if (x < b.minX + radius || x > b.maxX - radius ||
        y < b.minY + radius || y > b.maxY - radius) return false;
    // Check obstacles
    for (const obs of obstacles) {
      if (x >= obs.minX - radius && x <= obs.maxX + radius &&
          y >= obs.minY - radius && y <= obs.maxY + radius) return false;
    }
    return true;
  }

  /**
   * Generate pickup and drop zones on shelf faces and valid areas.
   */
  static generateTaskZones(config, obstacles, aisles, rng) {
    const pickupZones = [];
    const dropZones = [];
    const shelfObstacles = obstacles.filter(o => o.type === "shelf");
    
    // Pickup zones: shelf faces (front of shelves) + receiving zone
    for (const shelf of shelfObstacles) {
      // Front face pickup (aisle side)
      const aisleSide = this.findNearestAisle(shelf, aisles);
      if (aisleSide) {
        pickupZones.push({
          id: `PU-${shelf.id}`,
          x: aisleSide.x,
          y: aisleSide.y,
          shelfId: shelf.id,
          type: "shelf_pickup",
          zone: shelf.clusterId
        });
      }
    }

    // Add receiving/picking zones at warehouse edges
    const edgeZones = this.getEdgeZones(config);
    pickupZones.push(...edgeZones.pickup);
    dropZones.push(...edgeZones.drop);

    // Drop zones: shelf backs + shipping/packing zones
    for (const shelf of shelfObstacles) {
      if (rng() < 0.5) { // Some shelves are drop targets
        const aisleSide = this.findNearestAisle(shelf, aisles, "back");
        if (aisleSide) {
          dropZones.push({
            id: `DO-${shelf.id}`,
            x: aisleSide.x,
            y: aisleSide.y,
            shelfId: shelf.id,
            type: "shelf_drop",
            zone: shelf.clusterId
          });
        }
      }
    }

    // Shuffle for variety
    this.shuffleArray(pickupZones, rng);
    this.shuffleArray(dropZones, rng);

    return { pickupZones, dropZones };
  }

  /**
   * Find nearest aisle position for shelf access.
   */
  static findNearestAisle(shelf, aisles, side = "front") {
    const shelfCenterX = (shelf.minX + shelf.maxX) / 2;
    const shelfCenterY = (shelf.minY + shelf.maxY) / 2;
    
    let best = null;
    let bestDist = Infinity;
    
    for (const h of aisles.horizontal) {
      if (h.minX <= shelfCenterX && h.maxX >= shelfCenterX) {
        const dist = Math.abs(h.y - shelfCenterY);
        if (dist < bestDist) {
          bestDist = dist;
          best = { x: shelfCenterX, y: h.y };
        }
      }
    }
    for (const v of aisles.vertical) {
      if (v.minY <= shelfCenterY && v.maxY >= shelfCenterY) {
        const dist = Math.abs(v.x - shelfCenterX);
        if (dist < bestDist) {
          bestDist = dist;
          best = { x: v.x, y: shelfCenterY };
        }
      }
    }
    return best;
  }

  /**
   * Get edge zones (receiving, shipping, charging) based on config.
   */
  static getEdgeZones(config) {
    const bounds = WAREHOUSE_DIMENSIONS.bounds;
    const minX = bounds.minX, maxX = bounds.maxX, minY = bounds.minY, maxY = bounds.maxY;

    return {
      pickup: [
        { id: "PU-RECV", x: 145, y: minY + 15, type: "receiving", zone: "receiving" },
        { id: "PU-PICK", x: maxX - 50, y: minY + 80, type: "picking", zone: "picking" }
      ],
      drop: [
        { id: "DO-SHIP", x: maxX - 50, y: maxY - 80, type: "shipping", zone: "shipping" },
        { id: "DO-PACK", x: maxX - 50, y: (minY + maxY) / 2, type: "packing", zone: "packing" }
      ]
    };
  }

  /**
   * Generate charging zones if required.
   */
  static generateChargingZones(config, scenarioCode, obstacles, aisles, rng) {
    const chargingRequired = scenarioCode === "S12" || // Health degradation
                            scenarioCode === "A10" || // Health-aware adaptation
                            scenarioCode === "A11" || // Safe-degraded
                            config.zones >= 5; // Larger warehouses have charging

    if (!chargingRequired) return [];

    const zones = [];
    const bounds = WAREHOUSE_DIMENSIONS.bounds;
    
    // Bottom-left charging zone (standard)
    if (this.validateZonePlacement(bounds.minX + 40, bounds.maxY - 100, 120, 80, obstacles)) {
      zones.push({
        id: "CHARGE-MAIN",
        x: bounds.minX + 100,
        y: bounds.maxY - 60,
        width: 120,
        height: 80,
        type: "charging",
        stations: 4
      });
    }

    // Additional charging for large fleets
    if (config.fleetSize >= 50 && rng() < 0.5) {
      if (this.validateZonePlacement(bounds.maxX - 160, bounds.minY + 40, 120, 80, obstacles)) {
        zones.push({
          id: "CHARGE-AUX",
          x: bounds.maxX - 100,
          y: bounds.minY + 80,
          width: 120,
          height: 80,
          type: "charging",
          stations: 2
        });
      }
    }

    return zones;
  }

  /**
   * Validate zone placement doesn't overlap obstacles.
   */
  static validateZonePlacement(x, y, w, h, obstacles) {
    for (const obs of obstacles) {
      if (x < obs.maxX && x + w > obs.minX &&
          y < obs.maxY && y + h > obs.minY) return false;
    }
    return true;
  }

  /**
   * Calculate map metadata (zoom, marker size, visible area).
   */
  static calculateMapMetadata(fleetSize, config) {
    // The overview camera always fits the complete world (no crop, no zoom).
    return {
      worldTier: config.worldTier,
      worldProfileId: config.worldProfileId,
      worldLabel: config.worldLabel,
      worldWidth: config.floor.width,
      worldHeight: config.floor.height,
      zoom: 1.0,
      robotMarkerSize: ROBOT_FOOTPRINT.radius,
      visibleWidth: config.floor.width,
      visibleHeight: config.floor.height,
      offsetX: 0,
      offsetY: 0,
      showFullWarehouse: true,
      clusterCount: config.shelfClusters
    };
  }

  /**
   * Fisher-Yates shuffle with seeded RNG.
   */
  static shuffleArray(array, rng) {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
  }
}

// ==========================================================================
// EXISTING CONSTANTS (kept for backward compatibility)
// ==========================================================================

// Shelves and Structural Obstacles (exact bounding boxes: [minX, minY, maxX, maxY])
export const SHELF_OBSTACLES = [
  // Upper Racks Bank A (x: 245 to 320, y: 55 to 135)
  { id: "RACK-UA", name: "Storage A - Upper", minX: 245, minY: 55, maxX: 320, maxY: 135, type: "shelf" },
  // Upper Racks Bank B (x: 385 to 545, y: 55 to 135)
  { id: "RACK-UB", name: "Storage B - Upper", minX: 385, minY: 55, maxX: 545, maxY: 135, type: "shelf" },

  // Mid Racks Bank A (x: 245 to 320, y: 195 to 275)
  { id: "RACK-MA", name: "Storage A - Mid", minX: 245, minY: 195, maxX: 320, maxY: 275, type: "shelf" },
  // Mid Racks Bank B (x: 385 to 545, y: 195 to 275)
  { id: "RACK-MB", name: "Storage B - Mid", minX: 385, minY: 195, maxX: 545, maxY: 275, type: "shelf" },

  // Lower Racks Bank A (x: 245 to 320, y: 335 to 415)
  { id: "RACK-LA", name: "Storage A - Lower", minX: 245, minY: 335, maxX: 320, maxY: 415, type: "shelf" },
  // Lower Racks Bank B (x: 385 to 545, y: 335 to 415)
  { id: "RACK-LB", name: "Storage B - Lower", minX: 385, minY: 335, maxX: 545, maxY: 415, type: "shelf" },

  // Restricted Hazard Zone (x: 55 to 110, y: 190 to 275)
  { id: "ZONE-HAZARD", name: "Hazard Restricted Area", minX: 55, minY: 190, maxX: 110, maxY: 275, type: "restricted" }
];

// Valid Driving Corridors (Centerlines and free space)
export const DRIVING_AISLES = {
  horizontal: [
    { id: "H-TOP", y: 35, minX: 60, maxX: 840, label: "North Periphery Lane" },
    { id: "H-MID1", y: 165, minX: 120, maxX: 840, label: "Aisle A-B Crossway 1" },
    { id: "H-MID2", y: 305, minX: 120, maxX: 840, label: "Aisle A-B Crossway 2 (Main Crossing)" },
    { id: "H-BTM", y: 455, minX: 60, maxX: 840, label: "South Transit Lane" }
  ],
  vertical: [
    { id: "V-WEST", x: 145, minY: 35, maxY: 455, label: "West Transit Corridor" },
    { id: "V-MID1", x: 212, minY: 35, maxY: 455, label: "Aisle 1 Cross Lane" },
    { id: "V-MID2", x: 352, minY: 35, maxY: 455, label: "Central Crossing Lane (Hotspot)" },
    { id: "V-MID3", x: 578, minY: 35, maxY: 455, label: "Aisle 2 Cross Lane" },
    { id: "V-EAST", x: 740, minY: 35, maxY: 455, label: "East Dispatch Corridor" }
  ]
};

// Connected Waypoint Navigation Graph along Free Corridors
export const NAVIGATION_WAYPOINTS = [];
for (const h of DRIVING_AISLES.horizontal) {
  for (const v of DRIVING_AISLES.vertical) {
    NAVIGATION_WAYPOINTS.push({
      id: `WP-${v.x}-${h.y}`,
      x: v.x,
      y: h.y,
      hAisle: h.id,
      vAisle: v.id
    });
  }
}

export class MapGeometryEngine {
  static activeMapId = "WH-A";
  static customObstacles = null;
  static generatedLayout = null;
  static layoutLocked = false;
  static onLayoutGenerated = null; // Callback for when layout is regenerated
  static worldTierOverride = null;  // benchmark trials only (reference world)

  static getActiveObstacles() {
    // If we have a generated layout, use it; otherwise fall back to legacy
    if (this.generatedLayout && this.generatedLayout.obstacles) {
      return this.generatedLayout.obstacles;
    }
    return SHELF_OBSTACLES;
  }

  static getActiveAisles() {
    if (this.generatedLayout && this.generatedLayout.aisles) {
      return this.generatedLayout.aisles;
    }
    return DRIVING_AISLES;
  }

  static getActiveWaypoints() {
    if (this.generatedLayout && this.generatedLayout.waypoints) {
      return this.generatedLayout.waypoints;
    }
    return NAVIGATION_WAYPOINTS;
  }

  static getActiveSpawnPositions() {
    return this.generatedLayout?.spawnPositions || [];
  }

  static getActivePickupZones() {
    return this.generatedLayout?.pickupZones || [];
  }

  static getActiveDropZones() {
    return this.generatedLayout?.dropZones || [];
  }

  static getActiveChargingZones() {
    return this.generatedLayout?.chargingZones || [];
  }

  static getMapMetadata() {
    return this.generatedLayout?.mapMetadata || {
      worldTier: null,
      worldProfileId: "STATIC",
      worldWidth: WAREHOUSE_DIMENSIONS.width,
      worldHeight: WAREHOUSE_DIMENSIONS.height,
      zoom: 1.0,
      robotMarkerSize: ROBOT_FOOTPRINT.radius,
      visibleWidth: WAREHOUSE_DIMENSIONS.width,
      visibleHeight: WAREHOUSE_DIMENSIONS.height,
      offsetX: 0,
      offsetY: 0,
      showFullWarehouse: true,
      clusterCount: 6
    };
  }

  static generateAndLoadLayout(fleetSize, scenarioCode = "S01", mapId = "WH-A") {
    if (this.layoutLocked) {
      console.warn("[MapGeometryEngine] Layout is locked, cannot regenerate");
      return this.generatedLayout;
    }

    const layout = WarehouseMapGenerator.generate(fleetSize, scenarioCode, mapId);
    this.generatedLayout = layout;
    setTaskLocations(TASK_LOCATIONS_BY_TIER[layout.config.worldTier] || BASE_TASK_LOCATIONS);
    this.activeMapId = mapId;
    
    // Update legacy arrays for backward compatibility
    SHELF_OBSTACLES.length = 0;
    SHELF_OBSTACLES.push(...layout.obstacles);
    
    // Update waypoints from generated layout
    NAVIGATION_WAYPOINTS.length = 0;
    NAVIGATION_WAYPOINTS.push(...layout.waypoints);
    
    console.log(`[MapGeometryEngine] Generated adaptive layout for ${fleetSize} robots (${scenarioCode}): ${layout.obstacles.length} obstacles, ${layout.aisles.horizontal.length}H + ${layout.aisles.vertical.length}V aisles, ${layout.waypoints.length} waypoints`);
    
    // Trigger callback for layout regeneration (e.g., rebuild planner graphs)
    if (this.onLayoutGenerated) {
      this.onLayoutGenerated(layout);
    }
    
    return layout;
  }

  /** Maps with a fixed, hand-authored layout; every other id uses the generator. */
  static isStaticLayout(mapId) {
    return mapId === "WH-B" || mapId === "WH-C";
  }

  static loadMap(mapId, customData = null, fleetSizeOverride = null) {
    // The layout is frozen for the duration of a run; only the generated-layout
    // path checked the lock before, so WH-B/WH-C/custom loads could swap the
    // obstacle set under moving robots.
    if (this.layoutLocked) {
      console.warn(`[MapGeometryEngine] Layout is locked, ignoring loadMap(${mapId})`);
      return;
    }
    this.activeMapId = mapId;
    const fleetSize = fleetSizeOverride || state.get("robotCount") || 50;
    const scenarioCode = state.get("selectedScenario") || "S01";
    
    if (customData || this.isStaticLayout(mapId)) {
      setWarehouseFloor(DEFAULT_FLOOR);
      setTaskLocations(BASE_TASK_LOCATIONS);
    }
    if (customData && customData.obstacles) {
      SHELF_OBSTACLES.length = 0;
      SHELF_OBSTACLES.push(...customData.obstacles);
      this.generatedLayout = null; // Mark as custom
    } else if (mapId === "WH-B") {
      // Regional Hub Layout: Extended bank configuration
      SHELF_OBSTACLES.length = 0;
      SHELF_OBSTACLES.push(
        { id: "RACK-B1", name: "Storage Hub B-1", minX: 230, minY: 60, maxX: 330, maxY: 140, type: "shelf" },
        { id: "RACK-B2", name: "Storage Hub B-2", minX: 370, minY: 60, maxX: 560, maxY: 140, type: "shelf" },
        { id: "RACK-B3", name: "Storage Hub B-3", minX: 230, minY: 200, maxX: 330, maxY: 280, type: "shelf" },
        { id: "RACK-B4", name: "Storage Hub B-4", minX: 370, minY: 200, maxX: 560, maxY: 280, type: "shelf" },
        { id: "RACK-B5", name: "Storage Hub B-5", minX: 230, minY: 340, maxX: 330, maxY: 420, type: "shelf" },
        { id: "RACK-B6", name: "Storage Hub B-6", minX: 370, minY: 340, maxX: 560, maxY: 420, type: "shelf" },
        { id: "ZONE-HAZARD-B", name: "Hazard Zone Regional", minX: 60, minY: 180, maxX: 120, maxY: 260, type: "restricted" }
      );
      this.generatedLayout = null;
    } else if (mapId === "WH-C") {
      // Fulfillment Center Layout: Compact high-density racks
      SHELF_OBSTACLES.length = 0;
      SHELF_OBSTACLES.push(
        { id: "RACK-C1", name: "FC Picking Rack 1", minX: 260, minY: 70, maxX: 340, maxY: 150, type: "shelf" },
        { id: "RACK-C2", name: "FC Picking Rack 2", minX: 400, minY: 70, maxX: 530, maxY: 150, type: "shelf" },
        { id: "RACK-C3", name: "FC Picking Rack 3", minX: 260, minY: 210, maxX: 340, maxY: 290, type: "shelf" },
        { id: "RACK-C4", name: "FC Picking Rack 4", minX: 400, minY: 210, maxX: 530, maxY: 290, type: "shelf" },
        { id: "ZONE-HAZARD-C", name: "Hazard Buffer C", minX: 50, minY: 200, maxX: 100, maxY: 270, type: "restricted" }
      );
      this.generatedLayout = null;
    } else {
      // Default WH-A Layout - use adaptive generator
      this.generateAndLoadLayout(fleetSize, scenarioCode, mapId);
    }
  }

  static lockLayout() {
    this.layoutLocked = true;
    console.log("[MapGeometryEngine] Layout locked - configuration frozen for run");
  }

  static unlockLayout() {
    this.layoutLocked = false;
    console.log("[MapGeometryEngine] Layout unlocked - configuration editable");
  }

  static isLayoutLocked() {
    return this.layoutLocked;
  }

  /**
   * Checks if a point with robot footprint intersects any shelf or restricted zone.
   */
  static isPointInObstacle(x, y, radius = ROBOT_FOOTPRINT.radius) {
    const obstacles = this.getActiveObstacles();
    for (const obs of obstacles) {
      // Expanded bounding box with robot radius
      if (
        x >= obs.minX - radius &&
        x <= obs.maxX + radius &&
        y >= obs.minY - radius &&
        y <= obs.maxY + radius
      ) {
        return {
          collision: true,
          obstacle: obs
        };
      }
    }
    return { collision: false, obstacle: null };
  }

  /**
   * Checks if a point is within legal warehouse map boundaries.
   */
  static isWithinBounds(x, y, radius = ROBOT_FOOTPRINT.radius) {
    const b = WAREHOUSE_DIMENSIONS.bounds;
    return (
      x >= b.minX + radius &&
      x <= b.maxX - radius &&
      y >= b.minY + radius &&
      y <= b.maxY - radius
    );
  }

  /**
   * Clamps robot coordinate within legal map bounds.
   */
  static clampToBounds(x, y, radius = ROBOT_FOOTPRINT.radius) {
    const b = WAREHOUSE_DIMENSIONS.bounds;
    return {
      x: Math.max(b.minX + radius, Math.min(b.maxX - radius, x)),
      y: Math.max(b.minY + radius, Math.min(b.maxY - radius, y))
    };
  }

  /**
   * Checks if a straight-line segment from p1 to p2 intersects any shelf footprint.
   * Samples points along the segment to guarantee continuous collision verification.
   */
  static doesSegmentIntersectObstacle(p1, p2, radius = ROBOT_FOOTPRINT.radius) {
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const dist = Math.hypot(dx, dy);

    if (dist === 0) return this.isPointInObstacle(p1.x, p1.y, radius);

    // Sample along segment at step intervals of radius / 2
    const step = Math.max(4, radius / 2);
    const steps = Math.ceil(dist / step);

    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const sampleX = p1.x + dx * t;
      const sampleY = p1.y + dy * t;
      const check = this.isPointInObstacle(sampleX, sampleY, radius);
      if (check.collision) {
        return {
          collision: true,
          intersectionPoint: { x: sampleX, y: sampleY },
          obstacle: check.obstacle
        };
      }
    }

    return { collision: false, obstacle: null };
  }

  /**
   * Validates a multi-segment trajectory path.
   * Returns isValid: false if ANY part of the path crosses a shelf or boundary.
   */
  static validatePath(points, radius = ROBOT_FOOTPRINT.radius) {
    if (!points || points.length < 2) return { isValid: true, valid: true, reason: "Trivial path" };

    for (let i = 0; i < points.length - 1; i++) {
      const p1 = points[i];
      const p2 = points[i + 1];

      // Check boundary
      if (!this.isWithinBounds(p1.x, p1.y, radius) || !this.isWithinBounds(p2.x, p2.y, radius)) {
        return { isValid: false, valid: false, reason: "Path leaves map boundary", segment: [p1, p2] };
      }

      // Check obstacle intersection
      const check = this.doesSegmentIntersectObstacle(p1, p2, radius);
      if (check.collision) {
        return {
          isValid: false,
          valid: false,
          reason: `Path intersects obstacle: ${check.obstacle.name}`,
          obstacle: check.obstacle,
          segment: [p1, p2]
        };
      }
    }

    return { isValid: true, valid: true, reason: "Path valid and collision-free" };
  }

  /**
   * True when a point is parked clear of every aisle: at least one robot
   * separation (minus tolerance) from each aisle centerline, so a robot there
   * cannot obstruct lane traffic and never needs to move for it.
   */
  static isOffLane(x, y) {
    const clear = ROBOT_FOOTPRINT.totalRadius * 2 - 3;
    const aisles = this.getActiveAisles();
    const nearH = aisles.horizontal.some(h => Math.abs(h.y - y) < clear && x >= h.minX - clear && x <= h.maxX + clear);
    const nearV = aisles.vertical.some(v => Math.abs(v.x - x) < clear && y >= v.minY - clear && y <= v.maxY + clear);
    return !nearH && !nearV;
  }

  /**
   * A robot in a deep (row-2) bay leaves through its front bay; it may take
   * work only while no other robot sits in that front bay. Always true for
   * robots elsewhere.
   */
  static bayExitClear(r, others) {
    if (!this.isOffLane(r.x, r.y)) return true;
    const bay = (this._bayIndex || []).find(b => Math.hypot(b.x - r.x, b.y - r.y) < 6);
    if (!bay || !bay.front) return true;
    for (const o of others) { // any iterable (peer cache values, arrays)
      if (o.id !== r.id && bay.front.some(f => Math.hypot(o.x - f.x, o.y - f.y) < ROBOT_FOOTPRINT.totalRadius * 2)) return false;
    }
    return true;
  }

  /** Perpendicular foot of (x, y) on the nearest aisle centerline. */
  static projectToNearestAisle(x, y) {
    const aisles = this.getActiveAisles();
    let best = null;
    for (const h of aisles.horizontal) {
      if (x < h.minX || x > h.maxX) continue;
      const d = Math.abs(h.y - y);
      if (!best || d < best.d) best = { d, x, y: h.y };
    }
    for (const v of aisles.vertical) {
      if (y < v.minY || y > v.maxY) continue;
      const d = Math.abs(v.x - x);
      if (!best || d < best.d) best = { d, x: v.x, y };
    }
    return best ? { x: best.x, y: best.y } : null;
  }

  /**
   * Off-lane parking bays: one row of cells on each side of every aisle,
   * exactly one robot separation from the centerline, so a parked robot leaves
   * with a single perpendicular step onto the lane and never boxes in a
   * neighbor. Cells near another aisle, or inside an obstacle, are
   * skipped. Ordered round-robin across aisles so a fleet spreads over the floor.
   */
  static computeParkingBays() {
    const S = ROBOT_FOOTPRINT.totalRadius * 2 + 2;
    const aisles = this.getActiveAisles();
    const nearOtherLane = (x, y, skipH, skipV) =>
      aisles.horizontal.some(h => h !== skipH && Math.abs(h.y - y) < S && x >= h.minX - S && x <= h.maxX + S) ||
      aisles.vertical.some(v => v !== skipV && Math.abs(v.x - x) < S && y >= v.minY - S && y <= v.maxY + S);
    const valid = (x, y, skipH, skipV) =>
      this.isWithinBounds(x, y) &&
      !this.isPointInObstacle(x, y, ROBOT_FOOTPRINT.totalRadius + 2).collision &&
      !nearOtherLane(x, y, skipH, skipV);
    // Row 1 sits one separation off the aisle. Deeper rows sit behind it on
    // the same perpendicular line and leave through the bays in front, so a
    // deep bay is used only while those are empty (see bayExitClear).
    const rows = Array.from({ length: MAX_BAY_DEPTH }, () => []);
    const addLine = (cellAt) => {
      const fronts = [];
      for (let depth = 1; depth <= MAX_BAY_DEPTH; depth++) {
        const c = cellAt(depth);
        if (!c) break;
        rows[depth - 1].push([{ ...c, bay: true, ...(fronts.length ? { front: [...fronts] } : {}) }]);
        fronts.push({ x: c.x, y: c.y });
      }
    };
    for (const h of aisles.horizontal) {
      for (const side of [-1, 1]) {
        for (let x = h.minX; x <= h.maxX; x += S) {
          addLine(d => (valid(x, h.y + side * d * S, h, null) ? { x, y: h.y + side * d * S } : null));
        }
      }
    }
    for (const v of aisles.vertical) {
      for (const side of [-1, 1]) {
        for (let y = v.minY; y <= v.maxY; y += S) {
          addLine(d => (valid(v.x + side * d * S, y, null, v) ? { x: v.x + side * d * S, y } : null));
        }
      }
    }
    // Round-robin across rows so a fleet spreads over the floor; drop cells
    // closer than one separation to an accepted bay (row intersections).
    const bays = [];
    for (const group of rows) {
      const longest = Math.max(0, ...group.map(l => l.length));
      for (let k = 0; k < longest; k++) {
        for (const row of group) {
          const c = row[k];
          if (!c || bays.some(b => Math.hypot(b.x - c.x, b.y - c.y) < S)) continue;
          if (c.front && !c.front.every(f => bays.some(b => b.x === f.x && b.y === f.y))) continue;
          bays.push(c);
        }
      }
    }
    this._bayIndex = bays;
    return bays;
  }

  /**
   * Distance of a point from the floor boundary, normalized by the floor
   * size (0 = on the wall, 0.5 = dead centre). Used to rank perimeter slots.
   */
  static perimeterRank(x, y) {
    const W = WAREHOUSE_DIMENSIONS.width, H = WAREHOUSE_DIMENSIONS.height;
    return Math.min(x / W, (W - x) / W, y / H, (H - y) / H);
  }

  /**
   * Deterministic, collision-free perimeter staging points for a fleet of
   * `count` robots. Robots start in off-lane parking bays (never on an aisle
   * centerline, an intersection, a rack or a blocked zone), taken from the
   * outer ring of the warehouse first: bays are ranked by their normalized
   * distance to the floor boundary, so the fleet is staged around the borders
   * and corners and the centre stays free. Every point is at least
   * SPAWN_SPACING from every other one (no overlapping safety radii). Only
   * front-row bays are used, so every staged robot can leave with a single
   * perpendicular step onto its lane and can later return to the same bay.
   */
  static computeFleetSpawnPoints(count) {
    const SPAWN_SPACING = ROBOT_FOOTPRINT.totalRadius * 2 + 2; // 34px > 32px separation
    const byPerimeter = (a, b) => this.perimeterRank(a.x, a.y) - this.perimeterRank(b.x, b.y) || a.y - b.y || a.x - b.x;
    const bays = this.computeParkingBays();
    const candidates = [
      ...bays.filter(b => !b.front).sort(byPerimeter),
      // Surplus only (not needed by the supported 3/10/50/100 fleets).
      ...bays.filter(b => b.front).sort(byPerimeter)
    ];
    const accepted = [];
    for (const p of candidates) {
      if (accepted.length >= count) break;
      if (!this.isWithinBounds(p.x, p.y) || this.isPointInObstacle(p.x, p.y).collision) continue;
      if (accepted.some(a => Math.hypot(a.x - p.x, a.y - p.y) < SPAWN_SPACING)) continue;
      accepted.push({ x: p.x, y: p.y });
    }
    if (accepted.length < count) {
      throw new Error(`[MapGeometryEngine] Only ${accepted.length} collision-free staging points available for ${count} robots`);
    }
    return accepted;
  }

  /**
   * Calculates distance between two robots and checks if safe separation is maintained.
   */
  static checkRobotSeparation(r1, r2, minSeparation = ROBOT_FOOTPRINT.totalRadius * 2) {
    const dist = Math.hypot(r2.x - r1.x, r2.y - r1.y);
    return {
      distance: dist,
      isConflict: dist < minSeparation,
      minSeparation
    };
  }

  /**
   * Finds the nearest legal navigation waypoint to a given point.
   */
  static findNearestWaypoint(x, y) {
    const waypoints = this.getActiveWaypoints();
    if (!waypoints || waypoints.length === 0) return { x, y };
    
    let nearest = waypoints[0];
    let minDist = Infinity;

    for (const wp of waypoints) {
      const d = Math.hypot(wp.x - x, wp.y - y);
      if (d < minDist) {
        minDist = d;
        nearest = wp;
      }
    }

    return nearest;
  }

  /**
   * Generates a valid multi-segment corridor path between start and destination.
   * Path moves ONLY along horizontal and vertical aisles, completely avoiding shelves.
   * Uses generated aisle coordinates directly for guaranteed validity.
   */
  /**
   * Replaces every diagonal leg with an axis-aligned elbow (horizontal-then-
   * vertical or vertical-then-horizontal, whichever keeps both legs clear of
   * racks). Robots drive along single-lane aisles; a diagonal leg (produced by
   * planner fallbacks when a start/goal is slightly off an aisle) crossed open
   * floor, left the aisle grid, and stranded robots against restricted zones
   * where no traffic rule could see them.
   */
  static orthogonalizePath(path, radius = ROBOT_FOOTPRINT.radius) {
    if (!Array.isArray(path) || path.length < 2) return path;
    const out = [path[0]];
    for (let i = 1; i < path.length; i++) {
      const a = out[out.length - 1];
      const b = path[i];
      if (Math.abs(a.x - b.x) > 2 && Math.abs(a.y - b.y) > 2) {
        const elbows = [{ x: b.x, y: a.y }, { x: a.x, y: b.y }];
        const ok = elbows.find(e => !this.doesSegmentIntersectObstacle(a, e, radius).collision
          && !this.doesSegmentIntersectObstacle(e, b, radius).collision);
        out.push(ok || elbows[0]);
      }
      out.push(b);
    }
    return out;
  }

  static planCorridorPath(startX, startY, destX, destY) {
    const aisles = this.getActiveAisles();
    const bounds = WAREHOUSE_DIMENSIONS.bounds;
    const radius = ROBOT_FOOTPRINT.totalRadius;

    // Clamp start and dest to bounds
    const clampedStart = this.clampToBounds(startX, startY, radius);
    const clampedDest = this.clampToBounds(destX, destY, radius);

    const path = [{ x: clampedStart.x, y: clampedStart.y }];

    // Find which horizontal aisle the start is on (or nearest)
    let startHAisle = null;
    let startVAisle = null;
    let minHDist = Infinity;
    let minVDist = Infinity;

    for (const h of aisles.horizontal) {
      if (clampedStart.x >= h.minX - radius && clampedStart.x <= h.maxX + radius) {
        const dist = Math.abs(h.y - clampedStart.y);
        if (dist < minHDist) {
          minHDist = dist;
          startHAisle = h;
        }
      }
    }

    for (const v of aisles.vertical) {
      if (clampedStart.y >= v.minY - radius && clampedStart.y <= v.maxY + radius) {
        const dist = Math.abs(v.x - clampedStart.x);
        if (dist < minVDist) {
          minVDist = dist;
          startVAisle = v;
        }
      }
    }

    // Find which horizontal aisle the dest is on (or nearest)
    let destHAisle = null;
    let destVAisle = null;
    minHDist = Infinity;
    minVDist = Infinity;

    for (const h of aisles.horizontal) {
      if (clampedDest.x >= h.minX - radius && clampedDest.x <= h.maxX + radius) {
        const dist = Math.abs(h.y - clampedDest.y);
        if (dist < minHDist) {
          minHDist = dist;
          destHAisle = h;
        }
      }
    }

    for (const v of aisles.vertical) {
      if (clampedDest.y >= v.minY - radius && clampedDest.y <= v.maxY + radius) {
        const dist = Math.abs(v.x - clampedDest.x);
        if (dist < minVDist) {
          minVDist = dist;
          destVAisle = v;
        }
      }
    }

    // If no aisles found, fall back to direct path with validation
    if (!startHAisle && !startVAisle && !destHAisle && !destVAisle) {
      const check = this.doesSegmentIntersectObstacle(clampedStart, clampedDest, radius);
      if (!check.collision) {
        return [clampedStart, clampedDest];
      }
      // Try Manhattan path via warehouse center
      const midX = (bounds.minX + bounds.maxX) / 2;
      const midY = (bounds.minY + bounds.maxY) / 2;
      return this.planCorridorPath(clampedStart.x, clampedStart.y, midX, midY).slice(0, -1)
        .concat(this.planCorridorPath(midX, midY, clampedDest.x, clampedDest.y));
    }

    // Build path: start -> start aisle intersection -> dest aisle intersection -> dest
    // Strategy: Go from start to an intersection of its aisle and dest's aisle, then to dest

    const intersections = [];

    // Try H->V: start's horizontal aisle + dest's vertical aisle
    if (startHAisle && destVAisle) {
      const ix = destVAisle.x;
      const iy = startHAisle.y;
      if (ix >= startHAisle.minX && ix <= startHAisle.maxX &&
          iy >= destVAisle.minY && iy <= destVAisle.maxY) {
        intersections.push({ x: ix, y: iy, type: 'HV', via: { h: startHAisle, v: destVAisle } });
      }
    }

    // Try V->H: start's vertical aisle + dest's horizontal aisle
    if (startVAisle && destHAisle) {
      const ix = startVAisle.x;
      const iy = destHAisle.y;
      if (ix >= destHAisle.minX && ix <= destHAisle.maxX &&
          iy >= startVAisle.minY && iy <= startVAisle.maxY) {
        intersections.push({ x: ix, y: iy, type: 'VH', via: { v: startVAisle, h: destHAisle } });
      }
    }

    // Try start's horizontal -> dest's horizontal (if same aisle)
    if (startHAisle && destHAisle && startHAisle.id === destHAisle.id) {
      intersections.push({ x: clampedDest.x, y: startHAisle.y, type: 'HH', via: { h: startHAisle } });
    }

    // Try start's vertical -> dest's vertical (if same aisle)
    if (startVAisle && destVAisle && startVAisle.id === destVAisle.id) {
      intersections.push({ x: startVAisle.x, y: clampedDest.y, type: 'VV', via: { v: startVAisle } });
    }

    // Find best valid intersection
    let bestIntersection = null;
    for (const inter of intersections) {
      // Check path: start -> intersection -> dest
      const check1 = this.doesSegmentIntersectObstacle(clampedStart, inter, radius);
      const check2 = this.doesSegmentIntersectObstacle(inter, clampedDest, radius);
      if (!check1.collision && !check2.collision) {
        bestIntersection = inter;
        break;
      }
    }

    if (bestIntersection) {
      // Connect start to intersection
      if (clampedStart.x !== bestIntersection.x || clampedStart.y !== bestIntersection.y) {
        path.push({ x: bestIntersection.x, y: bestIntersection.y });
      }
      // Connect intersection to dest
      if (bestIntersection.x !== clampedDest.x || bestIntersection.y !== clampedDest.y) {
        path.push({ x: clampedDest.x, y: clampedDest.y });
      }
      return path;
    }

    // Fallback: use corridor planner with waypoints (should rarely happen)
    const startWp = this.findNearestWaypoint(clampedStart.x, clampedStart.y);
    const destWp = this.findNearestWaypoint(clampedDest.x, clampedDest.y);
    return this.planCorridorPathWaypoints(clampedStart, clampedDest, startWp, destWp);
  }

  /**
   * Fallback corridor planner using waypoints.
   */
  static planCorridorPathWaypoints(start, dest, startWp, destWp) {
    const path = [start];

    if (startWp.x !== start.x || startWp.y !== start.y) {
      path.push({ x: startWp.x, y: startWp.y });
    }

    if (startWp.x === destWp.x || startWp.y === destWp.y) {
      path.push({ x: destWp.x, y: destWp.y });
    } else {
      const corner1 = { x: destWp.x, y: startWp.y };
      const corner2 = { x: startWp.x, y: destWp.y };

      const check1 = this.doesSegmentIntersectObstacle(startWp, corner1);
      const check2 = this.doesSegmentIntersectObstacle(corner1, destWp);

      if (!check1.collision && !check2.collision) {
        path.push(corner1);
      } else {
        path.push(corner2);
      }
      path.push({ x: destWp.x, y: destWp.y });
    }

    if (destWp.x !== dest.x || destWp.y !== dest.y) {
      path.push(dest);
    }

    return path;
  }
}

// Subscribe to authoritative map updates
if (typeof state !== "undefined" && state.subscribe) {
  state.subscribe("selectedMap", (mapId) => {
    MapGeometryEngine.loadMap(mapId);
  });
}
