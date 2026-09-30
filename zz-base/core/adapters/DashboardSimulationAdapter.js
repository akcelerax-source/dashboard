// ==========================================================================
// NODEX ACE — Dashboard Simulation Adapter (Layer B Concrete Implementation)
// Connects Centralized Coordinator to the Dashboard Kinematic Simulation Engine
// Can be substituted with GazeboAdapter / ROS2Adapter without changing Layer A
// ==========================================================================

import { RobotExecutionAdapter } from "./RobotExecutionAdapter.js";
import { simEngine } from "../sim-engine.js";

export class DashboardSimulationAdapter extends RobotExecutionAdapter {
  constructor(simulationEngine = simEngine) {
    super("dashboard_simulation");
    this.simEngine = simulationEngine;
  }

  /**
   * Receives fleet coordination decisions and applies them to the simulation engine.
   */
  dispatchFleetCommands(fleetCommands) {
    if (!this.simEngine) return;
    this.simEngine.applyCoordinatorCommands(fleetCommands);
  }

  /**
   * Dispatches a single command to a specific robot.
   */
  sendRobotCommand(robotId, command) {
    if (!this.simEngine) return;
    this.simEngine.applySingleCommand(robotId, command);
  }

  /**
   * Reads back the authentic simulated robot states (kinematics, positions, speeds).
   */
  getRobotStates() {
    if (!this.simEngine) return [];
    return this.simEngine.getSimulatedRobotStates();
  }

  /**
   * Injects hardware or comm fault into the simulation engine.
   */
  injectFault(robotId, faultType) {
    if (!this.simEngine) return;
    this.simEngine.injectFault(faultType, robotId);
  }

  /**
   * Clears active faults in simulation engine.
   */
  clearFaults() {
    if (!this.simEngine) return;
    this.simEngine.clearFaults();
  }

  /**
   * Resets simulation engine state.
   */
  reset() {
    if (!this.simEngine) return;
    this.simEngine.reset();
  }
}

export const dashboardSimulationAdapter = new DashboardSimulationAdapter();
