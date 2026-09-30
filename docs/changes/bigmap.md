# r6-bigmap: rectangular worlds + full concurrency for 50/100 robots

CONFIG_VERSION `NODEX-ARCH-2026.09-r6-bigmap` (src). Mirrored into `zz-base/`
(map-geometry, admission-control, scenario-engine, WarehouseMap) so the
baseline and optimized runs use the same world and workload.

## Worlds (`src/core/map-geometry.js`, `WORLD_PROFILES`)

| Fleet | Id | Floor (px) | Lanes (V x H) | Racks | Stations | Parking bays (front row) |
|---|---|---|---|---|---|---|
| 3 | WORLD-S | 700 x 360 | 4 x 3 | 4 | 12 | 28 (20) — unchanged |
| 10 | WORLD-M | 900 x 520 | 5 x 4 | 8 | 12 | 76 (60) — unchanged |
| 50 | WORLD-L | **1700 x 850** (2:1) | 10 x 6 | 22 | 31 | 289 (202) |
| 100 | WORLD-XL | **2300 x 1150** (2:1) | 14 x 8 | 44 | 57 | 548 (361) |

- The big grids extend the reference lanes (x 145..900, y 35..595) east with
  a 160 px pitch and south with a 140 px pitch, so every reference coordinate
  (stress points, base stations, Charging/Maintenance) is still on a lane.
- Same generator: racks in a checkerboard of cells, charging zones, parking
  bays off-lane. The old 100-robot south staging lane (`H-PARK`) is gone.
- Stations: the 16 extended stations plus one on every other new intersection,
  named by floor band (Receiving → Storage → Picking → Packing → Shipping).
- Spawn: all robots start in distinct front-row bays inside the bounds, no
  overlap (>= 34 px apart).

## Admission (`src/core/admission-control.js`)

The 6-task cap for fleets > 10 is removed: `concurrentTaskLimit` is `Infinity`
for every fleet size, same for Centralized, Decentralized and ACE. `CAP=<n>`
env still pins a cap for ablations.

## Workload (`src/core/scenario-engine.js`)

- `topUpLargeFleetWorkload`: scenario runs with fleet >= 50 get at least
  2 x fleet tasks (S01: 100 at 50, 200 at 100). Extra tasks continue the
  same station walk.
- `spreadStationPair`: on the large worlds S01 walks all stations with a
  stride coprime to the station count, destination half the list away. The
  old zone indexing (`i % zone.length` with a zone stride of 5) piled most
  tasks onto 3-4 hub stations and gridlocked 50 robots at the default seed.
- Pure functions of (task index, fleet, stations), then the usual seeded
  `varyWorkload`: deterministic per seed, identical for all three systems.
  3/10 robot workloads are unchanged.

## Map view (`src/components/WarehouseMap.js`)

The main view already fits the whole world (uniform scale, centered). The
minimap now also uses a uniform, centered scale (it stretched before), and
click-to-pan uses the same mapping.
