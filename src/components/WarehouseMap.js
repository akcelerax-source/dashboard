// ==========================================================================
// NODEX ACE - Hero 2D Warehouse Simulation Viewport
// Adaptive Fixed Container - Auto-scales to fleet size (3/10/50/100)
// No pan/zoom needed - map content adapts to show full warehouse context
// ==========================================================================

import { state } from "../core/state.js";
import { MapGeometryEngine, WarehouseMapGenerator, WAREHOUSE_DIMENSIONS, ROBOT_FOOTPRINT, WAREHOUSE_TASK_LOCATIONS } from "../core/map-geometry.js";
import { PAIR_SCOPE_RADIUS } from "../core/decentralized/FixedPairCoordinator.js";
import { TASK_PHASE, deriveTaskPhase } from "../core/task-lifecycle.js";
import { robotStateStyle, PICKUP_COLOR, DROP_COLOR, DYNAMIC_OBSTACLE_COLOR, HANDLING_BLINK_MS } from "./robot-state-colors.js";

/** A robot is drawn as coordinating only while it is in a live session. */
function coordinationRequired(r, sessionMembers) {
  if (r.status === "ERROR" || r.status === "error") return false;
  return sessionMembers.has(r.id);
}

/**
 * The part of a robot's route still ahead of it: current position, current
 * target waypoint, then the waypoints after the navigation cursor. Drawing the
 * whole plannedPath kept already-driven legs on screen, and a replanned route
 * appeared layered on top of the old one.
 */
export function remainingRoute(r) {
  const path = Array.isArray(r.plannedPath) ? r.plannedPath : [];
  const route = [{ x: r.x, y: r.y }];
  if (typeof r.targetX === "number" && Math.hypot(r.targetX - r.x, r.targetY - r.y) > 1) {
    route.push({ x: r.targetX, y: r.targetY });
  }
  if (path.length === 0) return route;
  let cursor = r._cursorPath === path && typeof r.pathCursor === "number"
    ? r.pathCursor
    : path.findIndex(p => Math.hypot(p.x - r.targetX, p.y - r.targetY) < 1);
  if (cursor < 0) return route;
  for (let k = cursor + 1; k < path.length; k++) {
    const last = route[route.length - 1];
    if (Math.hypot(path[k].x - last.x, path[k].y - last.y) > 1) route.push(path[k]);
  }
  return route;
}

export class WarehouseMap {
  constructor(container, options = {}) {
    this.container = container;
    this.options = options;
    this.canvas = null;
    this.ctx = null;
    this.animationFrameId = null;
    this.minimapCanvas = null;
    this.minimapCtx = null;

    // Adaptive transform - computed from map metadata, not user interaction
    this.zoom = 1.0;
    this.panX = 0;
    this.panY = 0;
    this.currentScale = 1.0;
    this.currentOffsetX = 0;
    this.currentOffsetY = 0;

    // Active Layers (kept for visualization control)
    this.layers = {
      robots: true,
      paths: true,
      reservations: true,
      conflicts: true,
      congestion: true,
      tasks: true,
      obstacles: true,
      risk: true,
      events: true
    };

    // Subscribe to map config changes
    this.unsubscribeMapConfig = state.subscribe("mapConfig", (config) => {
      if (config) {
        this.applyMapConfig(config);
      }
    });

    // Subscribe to robot count changes (regenerate map before start)
    this.unsubscribeRobotCount = state.subscribe("robotCount", (count) => {
      const isRunning = state.get("simRunning");
      const lifecycleState = state.get("simLifecycleState");
      if (!isRunning && lifecycleState !== "RUNNING" && lifecycleState !== "PAUSED" && lifecycleState !== "STARTING") {
        this.regenerateMap();
      }
    });

    // Subscribe to scenario changes (regenerate map before start)
    this.unsubscribeScenario = state.subscribe("selectedScenario", (code) => {
      const isRunning = state.get("simRunning");
      const lifecycleState = state.get("simLifecycleState");
      if (!isRunning && lifecycleState !== "RUNNING" && lifecycleState !== "PAUSED" && lifecycleState !== "STARTING") {
        this.regenerateMap();
      }
    });

    // Subscribe to system mode changes
    this.unsubscribeSystemMode = state.subscribe("systemMode", () => {
      const isRunning = state.get("simRunning");
      const lifecycleState = state.get("simLifecycleState");
      if (!isRunning && lifecycleState !== "RUNNING" && lifecycleState !== "PAUSED" && lifecycleState !== "STARTING") {
        this.regenerateMap();
      }
    });

    this.renderDOM();
    this.initCanvas();
    this.bindEvents();
    this.startRenderLoop();

    // Initial map generation
    this.regenerateMap();
  }

  regenerateMap() {
    const fleetSize = state.get("robotCount") || 50;
    const scenarioCode = state.get("selectedScenario") || "S01";
    const mapId = state.get("selectedMap") || "WH-A";

    // WH-B / WH-C are fixed layouts: regenerating them with the adaptive
    // generator (as this always did) replaced the selected map's geometry.
    if (MapGeometryEngine.isStaticLayout(mapId)) {
      MapGeometryEngine.loadMap(mapId);
      const meta = MapGeometryEngine.getMapMetadata();
      this.applyMapConfig(meta);
      state.set("mapConfig", meta);
      return;
    }

    const layout = MapGeometryEngine.generateAndLoadLayout(fleetSize, scenarioCode, mapId);
    if (layout) {
      this.applyMapConfig(layout.mapMetadata);
      state.set("mapConfig", layout.mapMetadata);
    }
  }

  applyMapConfig(config) {
    if (!config) return;
    this.zoom = 1.0; // overview always shows the whole world
    this.robotMarkerSize = config.robotMarkerSize || ROBOT_FOOTPRINT.radius;
    this.visibleWidth = config.visibleWidth || WAREHOUSE_DIMENSIONS.width;
    this.visibleHeight = config.visibleHeight || WAREHOUSE_DIMENSIONS.height;
    this.offsetX = config.offsetX || 0;
    this.offsetY = config.offsetY || 0;
    this.showFullWarehouse = config.showFullWarehouse !== false;
    this.clusterCount = config.clusterCount || 6;
    
    // Recalculate canvas transform
    this.resizeCanvas();
  }

  renderDOM() {
    this.container.innerHTML = `
      <div class="map-card-container" id="map-main-wrapper">
        <div class="map-viewport" id="map-viewport">
          <canvas class="map-canvas" id="main-map-canvas"></canvas>

          <!-- Top-Left View Mode -->
          <div class="map-hud-top-left">
            <div class="view-switch-capsule">
              <button class="view-capsule-btn active" id="btn-view-2d" disabled>2D</button>
            </div>
            <div class="map-info-badge" id="map-info-badge">
              <span class="fleet-indicator" id="fleet-indicator">Adaptive Layout</span>
            </div>
          </div>

          <!-- Top-Right Layers & Fullscreen Controls -->
          <div class="map-hud-top-right">
            <!-- Layers Toggle -->
            <div class="map-layers-popover-wrap">
              <button class="hud-action-btn" id="btn-layers-toggle" title="Toggle Visualization Layers">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polygon points="12 2 2 7 12 12 22 7 12 2"></polygon>
                  <polyline points="2 17 12 22 22 17"></polyline>
                  <polyline points="2 12 12 17 22 12"></polyline>
                </svg>
                <span>Layers</span>
              </button>

              <div class="layers-dropdown-panel" id="layers-panel">
                <div class="layers-header">Display Layers</div>
                <label class="layer-chk"><input type="checkbox" id="chk-layer-robots" checked> Robots</label>
                <label class="layer-chk"><input type="checkbox" id="chk-layer-paths" checked> Paths</label>
                <label class="layer-chk"><input type="checkbox" id="chk-layer-reservations" checked> Reservations</label>
                <label class="layer-chk"><input type="checkbox" id="chk-layer-conflicts" checked> Conflicts</label>
                <label class="layer-chk"><input type="checkbox" id="chk-layer-congestion" checked> Congestion</label>
                <label class="layer-chk"><input type="checkbox" id="chk-layer-tasks" checked> Tasks</label>
                <label class="layer-chk"><input type="checkbox" id="chk-layer-obstacles" checked> Obstacles</label>
                <label class="layer-chk"><input type="checkbox" id="chk-layer-risk" checked> Risk</label>
              </div>
            </div>

            <!-- Fullscreen Button -->
            <button class="hud-action-btn icon-only" id="btn-map-fullscreen" title="Toggle Fullscreen">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="15 3 21 3 21 9"></polyline>
                <polyline points="9 21 3 21 3 15"></polyline>
                <line x1="21" y1="3" x2="14" y2="10"></line>
                <line x1="3" y1="21" x2="10" y2="14"></line>
              </svg>
            </button>
          </div>

          <!-- Bottom-Left Scale Ruler & Compass Rose -->
          <div class="map-hud-bottom-left">
            <div class="compass-marker">
              <span class="compass-arrow">▲</span>
              <span class="compass-text">N</span>
            </div>
            <div class="scale-ruler-strip">
              <div class="scale-ticks-labels">
                <span>0</span>
                <span>5</span>
                <span>10</span>
                <span>20 m</span>
              </div>
              <div class="scale-bar-line"></div>
            </div>
          </div>

          <!-- Bottom-Right Interactive Minimap (Overview Only) -->
          <div class="map-hud-bottom-right">
            <div class="minimap-wrapper" id="minimap-wrapper" title="Minimap Overview">
              <canvas class="minimap-canvas" id="minimap-canvas" width="140" height="80"></canvas>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  bindEvents() {
    // Layers dropdown toggle
    const btnLayers = this.container.querySelector("#btn-layers-toggle");
    const panelLayers = this.container.querySelector("#layers-panel");

    btnLayers?.addEventListener("click", (e) => {
      e.stopPropagation();
      panelLayers?.classList.toggle("open");
    });

    document.addEventListener("click", (e) => {
      if (!e.target.closest(".map-layers-popover-wrap")) {
        panelLayers?.classList.remove("open");
      }
    });

    // Layer checkboxes
    const layerCheckboxes = {
      "#chk-layer-robots": "robots",
      "#chk-layer-paths": "paths",
      "#chk-layer-reservations": "reservations",
      "#chk-layer-conflicts": "conflicts",
      "#chk-layer-congestion": "congestion",
      "#chk-layer-tasks": "tasks",
      "#chk-layer-obstacles": "obstacles",
      "#chk-layer-risk": "risk"
    };

    for (const [selector, layer] of Object.entries(layerCheckboxes)) {
      const chk = this.container.querySelector(selector);
      chk?.addEventListener("change", (e) => { this.layers[layer] = e.target.checked; });
    }

    // Fullscreen toggle
    const btnFullscreen = this.container.querySelector("#btn-map-fullscreen");
    btnFullscreen?.addEventListener("click", () => {
      const wrapper = this.container.querySelector("#map-main-wrapper");
      if (!document.fullscreenElement) {
        wrapper?.requestFullscreen().catch(err => console.warn(err));
      } else {
        document.exitFullscreen().catch(err => console.warn(err));
      }
    });

    // Canvas click to select robot
    this.canvas?.addEventListener("click", (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const clickX = (e.clientX - rect.left - this.currentOffsetX) / this.currentScale;
      const clickY = (e.clientY - rect.top - this.currentOffsetY) / this.currentScale;

      const robots = state.get("robots") || [];
      for (const r of robots) {
        const dist = Math.hypot(clickX - r.x, clickY - r.y);
        if (dist < this.robotMarkerSize * 2) {
          state.set("selectedRobotId", r.id);
          break;
        }
      }
    });

    // Minimap click to center (viewport sync only, no pan)
    this.minimapCanvas?.addEventListener("click", (e) => {
      this.updatePanFromMinimap(e);
    });
  }

  initCanvas() {
    this.canvas = this.container.querySelector("#main-map-canvas");
    this.ctx = this.canvas.getContext("2d");
    this.minimapCanvas = this.container.querySelector("#minimap-canvas");
    this.minimapCtx = this.minimapCanvas ? this.minimapCanvas.getContext("2d") : null;
    this.resizeCanvas();

    if (window.ResizeObserver && this.canvas.parentElement) {
      this.resizeObserver = new ResizeObserver(() => {
        this.resizeCanvas();
      });
      this.resizeObserver.observe(this.canvas.parentElement);
    }

    window.addEventListener("resize", () => this.resizeCanvas());
  }

  resizeCanvas() {
    if (!this.canvas || !this.canvas.parentElement) return;
    const rect = this.canvas.parentElement.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    this.canvas.style.width = `${rect.width}px`;
    this.canvas.style.height = `${rect.height}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    this.fitWorld(rect.width, rect.height);
  }

  /**
   * Overview camera: fits the COMPLETE active world (floor of the selected
   * fleet-size profile) into the viewport, centered, never cropped. Re-run
   * whenever the world or the viewport changes.
   */
  fitWorld(w, h) {
    const targetW = WAREHOUSE_DIMENSIONS.width;
    const targetH = WAREHOUSE_DIMENSIONS.height;
    this.fittedWorld = `${targetW}x${targetH}`;
    this.currentScale = Math.min(w / targetW, h / targetH);
    this.currentOffsetX = (w - targetW * this.currentScale) / 2;
    this.currentOffsetY = (h - targetH * this.currentScale) / 2;
  }

  startRenderLoop() {
    const render = () => {
      this.draw();
      this.lastMapRafMs = Date.now();
      this.animationFrameId = requestAnimationFrame(render);
    };
    this.lastMapRafMs = 0;
    this.animationFrameId = requestAnimationFrame(render);
    // Fallback repaint when rAF is throttled (hidden/headless tabs).
    if (this.mapFallbackIntervalId) clearInterval(this.mapFallbackIntervalId);
    this.mapFallbackIntervalId = setInterval(() => {
      if (Date.now() - (this.lastMapRafMs || 0) < 600) return;
      try { this.draw(); } catch (e) { /* ignore transient draw errors */ }
    }, 500);
  }

  destroy() {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    if (this.mapFallbackIntervalId) {
      clearInterval(this.mapFallbackIntervalId);
      this.mapFallbackIntervalId = null;
    }
    // Clean up subscriptions
    if (this.unsubscribeMapConfig) this.unsubscribeMapConfig();
    if (this.unsubscribeRobotCount) this.unsubscribeRobotCount();
    if (this.unsubscribeScenario) this.unsubscribeScenario();
    if (this.unsubscribeSystemMode) this.unsubscribeSystemMode();
  }

  draw() {
    if (!this.ctx || !this.canvas) return;

    const ctx = this.ctx;
    const w = this.canvas.width / (window.devicePixelRatio || 1);
    const h = this.canvas.height / (window.devicePixelRatio || 1);
    if (w <= 0 || h <= 0) return;

    // 1. Fill entire canvas with theme color
    const isLight = document.body.classList.contains("theme-light");
    ctx.fillStyle = isLight ? "#F8FAFC" : "#0A111F";
    ctx.fillRect(0, 0, w, h);

    // Refit if the world changed (robot count -> world profile).
    if (this.fittedWorld !== `${WAREHOUSE_DIMENSIONS.width}x${WAREHOUSE_DIMENSIONS.height}`) this.fitWorld(w, h);

    // 2. Apply transform for adaptive warehouse view
    ctx.save();
    ctx.translate(this.currentOffsetX, this.currentOffsetY);
    ctx.scale(this.currentScale, this.currentScale);

    // Draw warehouse using adaptive layout
    this.drawAdaptiveViewport(ctx);

    ctx.restore();

    // 3. Render Minimap (Overview)
    this.drawMinimap(w, h);

    // 4. Update fleet indicator badge
    this.updateFleetIndicator();
  }

  drawAdaptiveViewport(ctx, worldW = WAREHOUSE_DIMENSIONS.width, worldH = WAREHOUSE_DIMENSIONS.height) {
    const isLight = document.body.classList.contains("theme-light");
    const obstacles = MapGeometryEngine.getActiveObstacles();
    const aisles = MapGeometryEngine.getActiveAisles();
    const chargingZones = MapGeometryEngine.getActiveChargingZones();

    // 1. Concrete Warehouse Floor Base
    ctx.fillStyle = isLight ? "#FFFFFF" : "#0A111F";
    // Floor follows the active layout (the 100-robot tier is taller).
    const floorW = worldW - 30, floorH = worldH - 20;
    ctx.fillRect(15, 10, floorW, floorH);

    // Floor outline boundary
    ctx.strokeStyle = isLight ? "#CBD5E1" : "#1A2B47";
    ctx.lineWidth = 2;
    ctx.strokeRect(15, 10, floorW, floorH);

    // Subtle guide grid lines
    ctx.strokeStyle = isLight ? "rgba(148, 163, 184, 0.3)" : "rgba(30, 48, 80, 0.4)";
    ctx.lineWidth = 0.5;
    for (let x = 35; x < 15 + floorW; x += 40) {
      ctx.beginPath();
      ctx.moveTo(x, 10);
      ctx.lineTo(x, 10 + floorH);
      ctx.stroke();
    }
    for (let y = 30; y < 10 + floorH; y += 40) {
      ctx.beginPath();
      ctx.moveTo(15, y);
      ctx.lineTo(15 + floorW, y);
      ctx.stroke();
    }

    // 2. Driving Corridors (Free Space Lanes) - drawn from generated aisles
    ctx.fillStyle = isLight ? "#F1F5F9" : "#0D172A";
    
    // Horizontal aisles
    for (const h of aisles.horizontal) {
      const aisleHeight = 40;
      ctx.fillRect(h.minX, h.y - aisleHeight/2, h.maxX - h.minX, aisleHeight);
    }
    
    // Vertical aisles
    for (const v of aisles.vertical) {
      const aisleWidth = 40;
      ctx.fillRect(v.x - aisleWidth/2, v.minY, aisleWidth, v.maxY - v.minY);
    }

    // 3. Storage Racks (Shelves) - drawn from generated obstacles
    this.drawAdaptiveRacks(ctx, obstacles);

    // 4. Charging Zones
    this.drawChargingZones(ctx, chargingZones);

    // 5. Pickup/Drop markers of the live tasks (coloured like the robot
    // travelling to them).
    this.drawTaskZoneMarkers(ctx);

    // 6. Zone Labels (Badges)
    this.drawZonePills(ctx);

    const systemMode = state.get("systemMode") || "ace";
    const robots = state.get("robots") || [];
    const selectedId = state.get("selectedRobotId") || (robots[0] ? robots[0].id : "R01");
    const coordination = state.get("coordination") || {};

    // 7. Paths
    if (this.layers.paths) {
      this.drawRobotPaths(ctx, robots);
    }

    // 8. Architecture-Specific Coordination Visualizations
    if (systemMode === "centralized") {
      // CENTRALIZED: Central server + radio links to robots
      this.drawCentralizedCoordination(ctx, robots, coordination);
    } else if (systemMode === "decentralized") {
      // DECENTRALIZED: Fixed blue neighborhood rings (40m radius)
      if (this.layers.conflicts || this.layers.risk) {
        this.drawDecentralizedCoordination(ctx, robots);
      }
    } else if (systemMode === "ace") {
      // ACE: Dynamic adaptive envelopes based on RACE risk
      if (this.layers.conflicts || this.layers.risk) {
        this.drawCoordinationEnvelopes(ctx, robots, systemMode);
      }
    }

    // 9. Space-Time Contracts & Reservations
    if (this.layers.reservations) {
      this.drawSpaceTimeContracts(ctx);
    }

    // 10. Communication links: only sessions that are live in the runtime
    // right now (a link disappears the tick its session ends).
    if (systemMode !== "centralized") {
      this.drawSessionLinks(ctx, robots, systemMode);
    }

    // 11. Robots (AMRs) with adaptive LOD scaling
    if (this.layers.robots) {
      const fleetSize = robots.length;
      for (const r of robots) {
        this.drawAMR2D(ctx, r, r.id === selectedId, fleetSize);
      }
    }

    // 12. Dynamic Elements (Humans, Obstacles)
    if (this.layers.obstacles) {
      this.drawDynamicElements(ctx);
    }
  }

  drawAdaptiveRacks(ctx, obstacles) {
    const isLight = document.body.classList.contains("theme-light");
    
    // Group shelves by cluster for visual organization
    const clusters = {};
    for (const obs of obstacles) {
      if (obs.type !== "shelf") continue;
      const clusterId = obs.clusterId || 0;
      if (!clusters[clusterId]) clusters[clusterId] = [];
      clusters[clusterId].push(obs);
    }

    for (const [clusterId, shelves] of Object.entries(clusters)) {
      for (const shelf of shelves) {
        // Metallic rack frame
        ctx.fillStyle = isLight ? "#334155" : "#1E293B";
        ctx.fillRect(shelf.minX, shelf.minY, shelf.maxX - shelf.minX, shelf.maxY - shelf.minY);
        ctx.strokeStyle = isLight ? "#64748B" : "#334155";
        ctx.lineWidth = 1;
        ctx.strokeRect(shelf.minX, shelf.minY, shelf.maxX - shelf.minX, shelf.maxY - shelf.minY);

        // Amber storage cargo pallets
        const w = shelf.maxX - shelf.minX;
        const h = shelf.maxY - shelf.minY;
        ctx.fillStyle = "#D97706";
        for (let py = shelf.minY + 6; py < shelf.maxY - 6; py += 15) {
          ctx.fillRect(shelf.minX + 2, py, w - 4, 9);
          ctx.fillStyle = "#F59E0B";
          ctx.fillRect(shelf.minX + 2, py, w - 4, 2);
          ctx.fillStyle = "#D97706";
        }

        // Cluster label (only first shelf in cluster)
        if (shelves.indexOf(shelf) === 0) {
          ctx.font = "bold 9px Inter, sans-serif";
          ctx.fillStyle = isLight ? "#475569" : "#64748B";
          ctx.textAlign = "center";
          ctx.fillText(`Cluster ${String.fromCharCode(65 + parseInt(clusterId))}`, shelf.minX + w/2, shelf.minY - 5);
        }
      }
    }

    // Restricted zones
    for (const obs of obstacles) {
      if (obs.type === "restricted") {
        const rx = obs.minX, ry = obs.minY, rw = obs.maxX - obs.minX, rh = obs.maxY - obs.minY;
        ctx.save();
        ctx.beginPath();
        ctx.rect(rx, ry, rw, rh);
        ctx.clip();
        ctx.fillStyle = "rgba(239, 68, 68, 0.16)";
        ctx.fillRect(rx, ry, rw, rh);
        ctx.strokeStyle = "rgba(239, 68, 68, 0.7)";
        ctx.lineWidth = 2.5;
        for (let lineX = rx - rh; lineX < rx + rw + rh; lineX += 12) {
          ctx.beginPath();
          ctx.moveTo(lineX, ry);
          ctx.lineTo(lineX + rh, ry + rh);
          ctx.stroke();
        }
        ctx.restore();
        ctx.strokeStyle = "rgba(239, 68, 68, 0.9)";
        ctx.lineWidth = 1.5;
        ctx.strokeRect(rx, ry, rw, rh);
        ctx.fillStyle = "#EF4444";
        ctx.beginPath();
        ctx.arc(rx + rw/2, ry + rh/2, 10, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(rx + rw/2 - 7, ry + rh/2 - 7);
        ctx.lineTo(rx + rw/2 + 7, ry + rh/2 + 7);
        ctx.stroke();
      }
    }
  }

  drawChargingZones(ctx, zones) {
    for (const zone of zones) {
      ctx.fillStyle = "rgba(16, 185, 129, 0.08)";
      ctx.fillRect(zone.x - zone.width/2, zone.y - zone.height/2, zone.width, zone.height);
      ctx.strokeStyle = "rgba(16, 185, 129, 0.6)";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(zone.x - zone.width/2, zone.y - zone.height/2, zone.width, zone.height);

      ctx.font = "bold 9px Inter, sans-serif";
      ctx.fillStyle = "#10B981";
      ctx.textAlign = "center";
      ctx.fillText("Charging Zone", zone.x, zone.y - zone.height/2 - 5);

      // Charging station pads
      for (let i = 0; i < zone.stations; i++) {
        const padX = zone.x - zone.width/2 + 12 + i * (zone.width - 24) / Math.max(1, zone.stations - 1);
        const padY = zone.y + 10;
        ctx.fillStyle = "#0B1322";
        ctx.fillRect(padX, padY, 18, 26);
        ctx.strokeStyle = "#10B981";
        ctx.lineWidth = 1;
        ctx.strokeRect(padX, padY, 18, 26);
        ctx.fillStyle = "#10B981";
        ctx.fillRect(padX + 5, padY + 18, 8, 4);
      }
    }
  }

  drawTaskZoneMarkers(ctx) {
    const robots = new Map((state.get("robots") || []).map(r => [r.id, r]));
    const drawn = new Set();
    for (const t of state.get("tasks") || []) {
      if (t.status === "COMPLETED" || t.status === "FAILED" || t.status === "UNASSIGNED") continue;
      const r = robots.get(t.assignedRobot || t.assignedRobotId);
      if (!r || !t.pickup || !t.destination) continue;
      const phase = r.taskPhase || deriveTaskPhase(r);
      const toPickup = phase === TASK_PHASE.ASSIGNED || phase === TASK_PHASE.TO_PICKUP || phase === TASK_PHASE.LOADING;
      const toDrop = phase === TASK_PHASE.TO_DROP || phase === TASK_PHASE.UNLOADING;
      if (toPickup) this._drawStationMarker(ctx, t.pickup, "P", PICKUP_COLOR, drawn);
      if (toPickup || toDrop) this._drawStationMarker(ctx, t.destination, "D", DROP_COLOR, drawn);
    }
  }

  _drawStationMarker(ctx, pt, letter, color, drawn) {
    const key = `${letter}${Math.round(pt.x)},${Math.round(pt.y)}`;
    if (drawn.has(key)) return;
    drawn.add(key);
    ctx.save();
    ctx.fillStyle = color + "33";
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    if (letter === "P") ctx.arc(pt.x, pt.y, 13, 0, Math.PI * 2);
    else ctx.rect(pt.x - 12, pt.y - 12, 24, 24);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.font = "bold 9px Inter, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(letter, pt.x, pt.y + 1);
    ctx.restore();
  }

  drawZonePills(ctx) {
    const drawPill = (text, x, y) => {
      ctx.save();
      ctx.font = "bold 7.5px Inter, sans-serif";
      const metrics = ctx.measureText(text);
      const pw = metrics.width + 8;
      const ph = 12;

      ctx.fillStyle = "rgba(15, 23, 42, 0.85)";
      ctx.strokeStyle = "#253858";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(x - pw / 2, y - ph / 2, pw, ph, 4);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = "#94A3B8";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(text, x, y);
      ctx.restore();
    };

    // Task stations of the loaded world (they move with the world profile).
    for (const loc of WAREHOUSE_TASK_LOCATIONS) {
      drawPill(loc.name.replace(/ (Bay|Zone|Station|Dock)/, ""), loc.x, loc.y - 20);
    }
  }

  drawRobotPaths(ctx, robots) {
    for (const r of robots) {
      if (r.status === "error" || r.status === "failed") continue;

      const path = remainingRoute(r);
      if (path.length < 2) continue;

      const validation = MapGeometryEngine.validatePath(path);
      const isPathValid = validation.isValid;

      ctx.beginPath();
      ctx.moveTo(path[0].x, path[0].y);
      for (let i = 1; i < path.length; i++) {
        ctx.lineTo(path[i].x, path[i].y);
      }

      ctx.strokeStyle = !isPathValid
        ? "rgba(239, 68, 68, 0.85)"
        : (r.id === "R01" ? "#00C8FF" : "rgba(0, 150, 255, 0.35)");
      ctx.lineWidth = r.id === "R01" ? 2 : 1.2;
      ctx.stroke();

      const lastPoint = path[path.length - 1];
      const prevPoint = path[path.length - 2] || { x: r.x, y: r.y };
      const angle = Math.atan2(lastPoint.y - prevPoint.y, lastPoint.x - prevPoint.x);

      ctx.save();
      ctx.translate(lastPoint.x, lastPoint.y);
      ctx.rotate(angle);
      ctx.fillStyle = !isPathValid ? "#EF4444" : (r.id === "R01" ? "#00C8FF" : "rgba(0, 150, 255, 0.6)");
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(-6, -3);
      ctx.lineTo(-6, 3);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }

  /**
   * ACE envelopes from runtime state: the radius is the robot's current
   * envelopeRadius (small in LOCAL, larger only after RACE escalation).
   */
  drawCoordinationEnvelopes(ctx, robots, systemMode) {
    if (systemMode !== "ace") return;
    // Only robots that are actually coordinating (members of a live ACE
    // session) get an envelope. Idle / unassigned robots, and robots
    // resolving alone in LOCAL, are drawn standalone.
    const members = new Set((state.get("activeSessions") || []).flatMap(s => s.robots || []));
    for (const r of robots) {
      const radius = r.envelopeRadius || 0;
      if (radius <= 0) continue;
      const degraded = r.raceState === "SAFE-DEGRADED" && r.currentTaskId;
      if (!degraded && !coordinationRequired(r, members)) continue;
      const st = r.raceState;
      const style = st === "SAFE-DEGRADED" || r.status === "error" || r.status === "ERROR"
        ? { fill: "rgba(245, 158, 11, 0.14)", stroke: "#F59E0B", dash: [4, 4], w: 1.4 }
        : st === "CONTAINMENT" ? { fill: "rgba(239, 68, 68, 0.12)", stroke: "rgba(239, 68, 68, 0.9)", dash: [], w: 1.4 }
        : st === "NEIGHBORHOOD" ? { fill: "rgba(0, 200, 255, 0.10)", stroke: "rgba(0, 200, 255, 0.85)", dash: [], w: 1.2 }
        : { fill: "rgba(0, 120, 255, 0.05)", stroke: "rgba(0, 120, 255, 0.35)", dash: [], w: 0.8 }; // LOCAL baseline
      ctx.save();
      ctx.beginPath();
      ctx.arc(r.x, r.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = style.fill;
      ctx.fill();
      ctx.strokeStyle = style.stroke;
      ctx.lineWidth = style.w;
      ctx.setLineDash(style.dash);
      ctx.stroke();
      ctx.restore();
    }
  }

  /** Lines between robots of each LIVE session (pair or ACE group). */
  drawSessionLinks(ctx, robots, systemMode) {
    const sessions = state.get("activeSessions") || [];
    if (!sessions.length) return;
    const byId = new Map(robots.map(r => [r.id, r]));
    ctx.save();
    ctx.lineWidth = 1.4;
    ctx.setLineDash([4, 3]);
    for (const s of sessions) {
      const members = (s.robots || []).map(id => byId.get(id)).filter(r => r && r.status !== "ERROR" && r.status !== "error");
      if (members.length < 2) continue;
      const hub = members[0];
      ctx.strokeStyle = systemMode === "ace"
        ? (s.scope === "CONTAINMENT" ? "rgba(239, 68, 68, 0.75)" : "rgba(0, 200, 255, 0.75)")
        : "rgba(59, 130, 246, 0.7)";
      for (const m of members.slice(1)) {
        ctx.beginPath();
        ctx.moveTo(hub.x, hub.y);
        ctx.lineTo(m.x, m.y);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  drawSpaceTimeContracts(ctx) {
    const contracts = state.get("contracts") || [];
    if (!contracts || contracts.length === 0) return;

    for (const c of contracts) {
      const coords = c.coordinates || { x: 352, y: 305, radius: 36 };
      ctx.save();
      ctx.beginPath();
      ctx.arc(coords.x, coords.y, coords.radius || 32, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(16, 185, 129, 0.12)";
      ctx.fill();
      ctx.strokeStyle = "#10B981";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.font = "bold 8.5px JetBrains Mono, monospace";
      ctx.fillStyle = "#10B981";
      ctx.textAlign = "center";
      ctx.fillText(`${c.id}: ${c.owner}`, coords.x, coords.y - (coords.radius || 32) - 4);
      ctx.restore();
    }
  }

  drawCentralizedRadioLinks(ctx, robots) {
    const cx = 450, cy = 35;
    ctx.save();

    ctx.fillStyle = "#0284C7";
    ctx.strokeStyle = "#38BDF8";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, 14, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = "#FFFFFF";
    ctx.font = "bold 9px Inter, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("SRV", cx, cy);

    ctx.font = "bold 7.5px JetBrains Mono, monospace";
    ctx.fillStyle = "#38BDF8";
    ctx.fillText("CENTRAL CONTROLLER", cx, cy + 18);

    ctx.strokeStyle = "rgba(0, 200, 255, 0.22)";
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 5]);

    const n = Math.min(robots.length, 60);
    for (let i = 0; i < n; i++) {
      const r = robots[i];
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(r.x, r.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * Draw centralized coordination: Central server symbol + active radio links to robots
   * Only shown in Centralized mode when RACE is explicitly INACTIVE
   */
  drawCentralizedCoordination(ctx, robots, coordination) {
    const cx = 450, cy = 35;
    const isOnline = coordination.centralServer?.status === "ONLINE";

    ctx.save();

    // Central Server Node
    ctx.fillStyle = isOnline ? "#0284C7" : "#475569";
    ctx.strokeStyle = isOnline ? "#38BDF8" : "#64748B";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, 16, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Server tower symbol
    ctx.fillStyle = "#FFFFFF";
    ctx.font = "bold 10px Inter, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("SRV", cx, cy);

    ctx.font = "bold 7px JetBrains Mono, monospace";
    ctx.fillStyle = isOnline ? "#38BDF8" : "#64748B";
    ctx.fillText("CENTRAL SERVER", cx, cy + 20);

    // Status indicator
    ctx.fillStyle = isOnline ? "#10B981" : "#EF4444";
    ctx.beginPath();
    ctx.arc(cx + 14, cy - 14, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#FFFFFF";
    ctx.font = "bold 6px Inter, sans-serif";
    ctx.fillText(isOnline ? "●" : "○", cx + 14, cy - 12);

    // Active Radio Links to Robots
    if (isOnline) {
      ctx.strokeStyle = "rgba(0, 200, 255, 0.35)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 4]);

      // Command links only to robots the server is actively directing (a
      // task or a return route); a parked idle robot gets no line.
      for (const r of robots) {
        if (r.status === "ERROR" || r.status === "error") continue;
        if (!r.currentTaskId && !r.parkingBay) continue;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(r.x, r.y);
        ctx.stroke();

        // Small arrow at robot end showing direction from server
        const angle = Math.atan2(r.y - cy, r.x - cx);
        const arrowLen = 12;
        ctx.beginPath();
        ctx.moveTo(r.x - Math.cos(angle) * arrowLen, r.y - Math.sin(angle) * arrowLen);
        ctx.lineTo(r.x - Math.cos(angle - 0.3) * arrowLen * 0.6, r.y - Math.sin(angle - 0.3) * arrowLen * 0.6);
        ctx.lineTo(r.x - Math.cos(angle + 0.3) * arrowLen * 0.6, r.y - Math.sin(angle + 0.3) * arrowLen * 0.6);
        ctx.fillStyle = "rgba(0, 200, 255, 0.6)";
        ctx.fill();
      }
    }

    // RACE Status: Explicitly INACTIVE badge
    ctx.fillStyle = "rgba(239, 68, 68, 0.15)";
    ctx.strokeStyle = "#EF4444";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(cx - 70, cy + 30, 140, 22, 4);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = "#EF4444";
    ctx.font = "bold 9px JetBrains Mono, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("RACE: INACTIVE", cx, cy + 41);

    ctx.restore();
  }

  /**
   * Draw decentralized coordination: Fixed blue neighborhood rings (40m radius)
   * Only shown in Decentralized mode when RACE is explicitly INACTIVE
   */
  /**
   * System 2: small FIXED coordination scope per robot (pairwise model). It
   * never grows; robots in a live pair are highlighted.
   */
  drawDecentralizedCoordination(ctx, robots) {
    ctx.save();
    // Blue scope ring only while a pair negotiates right of way (a real
    // conflict). Idle robots and routine intent refreshes get no ring.
    const negotiating = new Set((state.get("activeSessions") || [])
      .filter(s => s.purpose === "conflict").flatMap(s => s.robots || []));
    for (const r of robots) {
      if (!coordinationRequired(r, negotiating)) continue;
      ctx.beginPath();
      ctx.arc(r.x, r.y, PAIR_SCOPE_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(0, 120, 255, 0.10)";
      ctx.fill();
      ctx.strokeStyle = "rgba(59, 130, 246, 0.8)";
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
    ctx.restore();
  }

  drawCentralizedRadioLinks(ctx, robots) {
    // P2P communication links drawing handled separately
  }


  drawAMR2D(ctx, r, isSelected, fleetSize = 50) {
    ctx.save();
    ctx.translate(r.x, r.y);

    // The body colour IS the lifecycle state (robot.taskPhase).
    const phase = r.taskPhase || deriveTaskPhase(r);
    const style = robotStateStyle(phase);
    const isError = phase === TASK_PHASE.FAILED;
    const handling = phase === TASK_PHASE.LOADING || phase === TASK_PHASE.UNLOADING;
    const blinkOn = handling && Math.floor(Date.now() / HANDLING_BLINK_MS) % 2 === 0;

    // Drawn at the physical footprint size (the world scales, not the robot).
    const hw = ROBOT_FOOTPRINT.radius;
    const hh = ROBOT_FOOTPRINT.radius * 0.6;

    if (isSelected) {
      ctx.shadowColor = "#00C8FF";
      ctx.shadowBlur = 12;
    } else if (isError || handling) {
      ctx.shadowColor = style.edge;
      ctx.shadowBlur = handling ? (blinkOn ? 14 : 4) : 8;
    }

    ctx.fillStyle = handling && blinkOn ? style.blink : style.body;
    ctx.strokeStyle = isSelected ? "#00C8FF" : style.edge;
    ctx.lineWidth = isSelected ? 2 : 1.4;
    ctx.beginPath();
    ctx.roundRect(-hw, -hh, hw * 2, hh * 2, 3);
    ctx.fill();
    ctx.stroke();

    // Heading nose
    ctx.save();
    ctx.rotate(r.heading || 0);
    ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
    ctx.fillRect(hw - 4, -2, 4, 4);
    ctx.restore();
    ctx.shadowBlur = 0;

    if (isError) {
      ctx.strokeStyle = "#FFFFFF";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(-hw + 3, -hh + 2); ctx.lineTo(hw - 3, hh - 2);
      ctx.moveTo(hw - 3, -hh + 2); ctx.lineTo(-hw + 3, hh - 2);
      ctx.stroke();
    }

    // Robot ID Label: show based on fleet size and zoom
    const labelVisible = isSelected || fleetSize <= 50 || this.zoom >= 1.0;
    if (labelVisible && !isError) {
      ctx.font = isSelected ? "bold 8.5px Inter, sans-serif" : "bold 7.5px Inter, sans-serif";
      ctx.fillStyle = handling && blinkOn ? "#0F172A" : "#FFFFFF";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(r.id, 0, 0);
    }

    if (isSelected) {
      ctx.strokeStyle = "#00C8FF";
      ctx.lineWidth = 1.8;
      ctx.strokeRect(-hw - 4, -hh - 4, (hw + 4) * 2, (hh + 4) * 2);
    }

    if (r.isYielding && fleetSize <= 10) {
      ctx.font = "bold 6px Inter, sans-serif";
      ctx.fillStyle = "#FBBF24";
      ctx.textAlign = "center";
      ctx.fillText("WAIT", 0, -hh - 6);
    }

    ctx.restore();
  }

  /** Humans / dynamic obstacles that exist in the running simulation. */
  drawDynamicElements(ctx) {
    for (const o of state.get("dynamicWorldObjects") || []) {
      ctx.save();
      ctx.translate(o.x, o.y);
      if (o.kind === "human") {
        ctx.fillStyle = DYNAMIC_OBSTACLE_COLOR.edge;
        ctx.beginPath();
        ctx.arc(0, -6, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillRect(-4, -1, 8, 9);
      } else {
        const r = o.radius || 12;
        ctx.fillStyle = DYNAMIC_OBSTACLE_COLOR.fill;
        ctx.strokeStyle = DYNAMIC_OBSTACLE_COLOR.edge;
        ctx.lineWidth = 1.5;
        ctx.fillRect(-r, -r, r * 2, r * 2);
        ctx.strokeRect(-r, -r, r * 2, r * 2);
      }
      ctx.restore();
    }
  }

  updatePanFromMinimap(e) {
    if (!this.minimapCanvas || !this.canvas) return;
    const rect = this.minimapCanvas.getBoundingClientRect();
    if (rect.width <= 8 || rect.height <= 8) return;
    // Same uniform, centered fit as drawMinimap.
    const W = WAREHOUSE_DIMENSIONS.width, H = WAREHOUSE_DIMENSIONS.height;
    const s = Math.min((rect.width - 8) / W, (rect.height - 8) / H);
    const mx = e.clientX - rect.left - (rect.width - W * s) / 2;
    const my = e.clientY - rect.top - (rect.height - H * s) / 2;

    const normU = Math.max(0, Math.min(1, mx / (W * s)));
    const normV = Math.max(0, Math.min(1, my / (H * s)));

    const worldTargetX = normU * WAREHOUSE_DIMENSIONS.width;
    const worldTargetY = normV * WAREHOUSE_DIMENSIONS.height;

    // For adaptive map, we just re-center the view on the target
    this.centerOnWorld(worldTargetX, worldTargetY);
  }

  centerOnWorld(wx, wy) {
    if (!this.canvas) return;
    const w = this.canvas.width / (window.devicePixelRatio || 1);
    const h = this.canvas.height / (window.devicePixelRatio || 1);
    const S = this.currentScale;

    this.currentOffsetX = (w / 2) - (wx * S);
    this.currentOffsetY = (h / 2) - (wy * S);
  }

  focusOnRobot(robotId) {
    if (!robotId) return;
    const robots = state.get("robots") || [];
    const r = robots.find(x => x.id === robotId);
    if (r) {
      this.centerOnWorld(r.x, r.y);
    }
  }

  drawMinimap(mainW, mainH) {
    if (!this.minimapCanvas || !this.minimapCtx) return;
    const mctx = this.minimapCtx;
    const mw = this.minimapCanvas.width;
    const mh = this.minimapCanvas.height;

    mctx.clearRect(0, 0, mw, mh);

    // Floor Base
    mctx.fillStyle = "#09101E";
    mctx.fillRect(0, 0, mw, mh);

    // Outer border
    mctx.strokeStyle = "rgba(0, 200, 255, 0.25)";
    mctx.lineWidth = 1;
    mctx.strokeRect(1, 1, mw - 2, mh - 2);

    // Uniform scale (keeps the rectangular 50/100 worlds undistorted), centered.
    const mScale = Math.min((mw - 8) / WAREHOUSE_DIMENSIONS.width, (mh - 8) / WAREHOUSE_DIMENSIONS.height);
    const mxScale = mScale;
    const myScale = mScale;
    const mOffsetX = (mw - WAREHOUSE_DIMENSIONS.width * mScale) / 2;
    const mOffsetY = (mh - WAREHOUSE_DIMENSIONS.height * mScale) / 2;

    // Driving Corridors from generated aisles
    const aisles = MapGeometryEngine.getActiveAisles();
    mctx.fillStyle = "rgba(255, 255, 255, 0.05)";
    for (const h of aisles.horizontal) {
      mctx.fillRect(mOffsetX + h.minX * mxScale, mOffsetY + (h.y - 20) * myScale, (h.maxX - h.minX) * mxScale, 40 * myScale);
    }
    for (const v of aisles.vertical) {
      mctx.fillRect(mOffsetX + (v.x - 20) * mxScale, mOffsetY + v.minY * myScale, 40 * mxScale, (v.maxY - v.minY) * myScale);
    }

    // Racks from generated obstacles
    const obstacles = MapGeometryEngine.getActiveObstacles();
    mctx.fillStyle = "rgba(100, 116, 139, 0.45)";
    for (const obs of obstacles) {
      if (obs.type !== "shelf") continue;
      mctx.fillRect(
        mOffsetX + obs.minX * mxScale,
        mOffsetY + obs.minY * myScale,
        Math.max(1.5, (obs.maxX - obs.minX) * mxScale),
        (obs.maxY - obs.minY) * myScale
      );
    }

    // Charging zones
    const chargingZones = MapGeometryEngine.getActiveChargingZones();
    for (const zone of chargingZones) {
      mctx.fillStyle = "rgba(16, 185, 129, 0.3)";
      mctx.fillRect(
        mOffsetX + (zone.x - zone.width/2) * mxScale,
        mOffsetY + (zone.y - zone.height/2) * myScale,
        zone.width * mxScale,
        zone.height * myScale
      );
    }

    // Dynamic Robots
    const robots = state.get("robots") || [];
    const selectedId = state.get("selectedRobotId") || (robots[0] ? robots[0].id : "R01");
    for (const r of robots) {
      const rx = mOffsetX + r.x * mxScale;
      const ry = mOffsetY + r.y * myScale;
      mctx.beginPath();
      mctx.arc(rx, ry, r.id === selectedId ? 3 : 2, 0, Math.PI * 2);
      mctx.fillStyle = r.id === selectedId ? "#00E5FF" : robotStateStyle(r.taskPhase || deriveTaskPhase(r)).edge;
      mctx.fill();
    }

    // Viewport frustum
    const mainVisibleWorldWidth = mainW / this.currentScale;
    const mainVisibleWorldHeight = mainH / this.currentScale;
    
    const vWorldMinX = this.currentOffsetX / this.currentScale;
    const vWorldMaxX = vWorldMinX + mainVisibleWorldWidth;
    const vWorldMinY = this.currentOffsetY / this.currentScale;
    const vWorldMaxY = vWorldMinY + mainVisibleWorldHeight;

    const WH_MIN_X = 20;
    const WH_MIN_Y = 15;
    
    const vMinimapX1 = Math.max(mOffsetX, Math.min(mw - mOffsetX, (vWorldMinX - WH_MIN_X) * mxScale + mOffsetX));
    const vMinimapY1 = Math.max(mOffsetY, Math.min(mh - mOffsetY, (vWorldMinY - WH_MIN_Y) * myScale + mOffsetY));
    const vMinimapX2 = Math.max(mOffsetX, Math.min(mw - mOffsetX, (vWorldMaxX - WH_MIN_X) * mxScale + mOffsetX));
    const vMinimapY2 = Math.max(mOffsetY, Math.min(mh - mOffsetY, (vWorldMaxY - WH_MIN_Y) * myScale + mOffsetY));

    const vw = Math.max(6, vMinimapX2 - vMinimapX1);
    const vh = Math.max(4, vMinimapY2 - vMinimapY1);

    mctx.fillStyle = "rgba(0, 200, 255, 0.15)";
    mctx.fillRect(vMinimapX1, vMinimapY1, vw, vh);
    mctx.strokeStyle = "#00C8FF";
    mctx.lineWidth = 1.2;
    mctx.strokeRect(vMinimapX1, vMinimapY1, vw, vh);

    // Label
    mctx.fillStyle = "rgba(0, 200, 255, 0.65)";
    mctx.font = "bold 8px Inter, monospace";
    mctx.fillText("OVERVIEW", 6, 11);
  }

  updateFleetIndicator() {
    const badge = this.container.querySelector("#fleet-indicator");
    if (badge) {
      const fleetSize = state.get("robotCount") || 50;
      const scenarioCode = state.get("selectedScenario") || "S01";
      const layout = MapGeometryEngine.generatedLayout;
      const clusters = layout?.config?.shelfClusters || 6;
      badge.textContent = `${fleetSize} AMRs • ${clusters} Clusters • ${scenarioCode}`;
    }
  }
}