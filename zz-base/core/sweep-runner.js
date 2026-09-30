// ==========================================================================
// Full Test Sweep Runner
// 14 scenarios × 3 systems × 4 counts (168) + 12 ACE tests × 4 counts (48)
// = 216 runs at 5x speed, with progress pushed to Chrome via shared sync
// ==========================================================================

import { state } from "./state.js";
import { simLifecycle } from "./sim-lifecycle.js";
import { scenarioEngine } from "./scenario-engine.js";
import { recordRun, getArchivedRuns } from "../data/run-history.js";

const SCENARIOS = ["S01", "S02", "S03", "S04", "S05", "S06", "S07", "S08", "S09", "S10", "S11", "S12", "S13", "S14"];
const SYSTEMS = ["centralized", "decentralized", "ace"];
const ROBOT_COUNTS = [3, 10, 50, 100];
const ACE_TESTS = ["A01", "A02", "A03", "A04", "A05", "A06", "A07", "A08", "A09", "A10", "A11", "A12"];

class SweepRunner {
  constructor() {
    this.isRunning = false;
    this.totalRuns = 0;
    this.completedRuns = 0;
    this.currentRun = null;
    this.startTime = null;
  }

  async runFullSweep() {
    if (this.isRunning) {
      console.warn("[SweepRunner] Already running");
      return;
    }

    this.isRunning = true;
    this.totalRuns = 14 * 3 * 4 + 12 * 4; // 216
    this.completedRuns = 0;
    this.startTime = Date.now();

    console.log(`[SweepRunner] Starting full sweep: ${this.totalRuns} runs at 5x speed`);

    // Skip combos already recorded (resuming after a tab/server restart) —
    // matches on the same identity a finished run is archived under.
    const isDone = (code, system, count, kind) => getArchivedRuns().some(r =>
      r.scenarioCode === code && r.systemMode === system && r.fleetSize === count && (r.runKind || "scenario") === kind
    );

    // Scenarios: S01-S14, each on centralized/decentralized/ace, each at 3/10/50/100 robots
    for (const scenario of SCENARIOS) {
      for (const system of SYSTEMS) {
        for (const count of ROBOT_COUNTS) {
          if (isDone(scenario, system, count, "scenario")) {
            this.completedRuns++;
            console.log(`[SweepRunner] [${this.completedRuns}/${this.totalRuns}] ${scenario} ${system} ${count}r already recorded, skipping`);
            continue;
          }
          await this.runOne(scenario, system, count, "scenario");
        }
      }
    }

    // ACE-only tests: A01-A12, each at 3/10/50/100 robots (ACE system only)
    for (const test of ACE_TESTS) {
      for (const count of ROBOT_COUNTS) {
        if (isDone(test, "ace", count, "test")) {
          this.completedRuns++;
          console.log(`[SweepRunner] [${this.completedRuns}/${this.totalRuns}] ${test} ace ${count}r already recorded, skipping`);
          continue;
        }
        await this.runOne(test, "ace", count, "aceTest");
      }
    }

    console.log(`[SweepRunner] Sweep complete in ${((Date.now() - this.startTime) / 1000 / 60).toFixed(1)} minutes`);
    this.isRunning = false;
  }

  async runOne(scenarioOrTest, system, robotCount, testType) {
    this.completedRuns++;
    const progress = `[${this.completedRuns}/${this.totalRuns}]`;

    return new Promise((resolve) => {
      // Set up run config
      state.set("selectedSystem", system);
      state.set("robotCount", robotCount);

      if (testType === "scenario") {
        state.set("selectedScenario", scenarioOrTest);
        state.set("simTestType", "scenario");
      } else {
        state.set("simTestType", "aceTest");
      }

      this.currentRun = `${progress} ${scenarioOrTest} ${system} ${robotCount}r`;
      console.log(`[SweepRunner] ${this.currentRun}...`);

      // Wait for state to settle, then start
      setTimeout(() => {
        state.set("simSpeed", 5.0); // Set speed right before start
        simLifecycle
          .start()
          .then(() => {
            // Ensure speed stays at 5.0 during run
            const speedInterval = setInterval(() => {
              if (!state.get("simRunning")) {
                clearInterval(speedInterval);
              } else if (state.get("simSpeed") !== 5.0) {
                state.set("simSpeed", 5.0);
              }
            }, 500);

            // Listen for run completion
            const unsubscribe = state.subscribe("simRunning", (isRunning) => {
              if (!isRunning) {
                unsubscribe();
                clearInterval(speedInterval);
                console.log(`[SweepRunner] ${this.currentRun} done`);
                setTimeout(resolve, 200); // Give shared sync time to push the run
              }
            });
          })
          .catch((err) => {
            console.error(`[SweepRunner] ${this.currentRun} failed:`, err);
            state.set("simRunning", false);
            setTimeout(resolve, 200);
          });
      }, 100);
    });
  }

  getProgress() {
    return {
      isRunning: this.isRunning,
      completedRuns: this.completedRuns,
      totalRuns: this.totalRuns,
      currentRun: this.currentRun,
      elapsedSeconds: this.startTime ? Math.floor((Date.now() - this.startTime) / 1000) : 0,
      estimatedRemainingSeconds: this.startTime && this.completedRuns > 0
        ? Math.floor(((this.totalRuns - this.completedRuns) / this.completedRuns) * ((Date.now() - this.startTime) / 1000))
        : 0
    };
  }
}

export const sweepRunner = new SweepRunner();

// Auto-subscribe to sync progress back to Chrome
if (typeof window !== "undefined") {
  setInterval(() => {
    const progress = sweepRunner.getProgress();
    if (progress.isRunning) {
      state.set("sweepProgress", progress);
    }
  }, 2000);
}
