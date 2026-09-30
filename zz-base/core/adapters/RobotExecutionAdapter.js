// ==========================================================================
// NODEX ACE — Robot Execution Adapter Interface (Layer B)
// Generic abstract boundary separating coordination algorithm from execution substrate
// In Phase 2: DashboardSimulationAdapter
// In Future: GazeboAdapter / ROS2Adapter / RealRobotAdapter
// ==========================================================================

export class RobotExecutionAdapter {
  constructor(adapterType = "simulation") {
    this.adapterType = adapterType;
  }

  getAdapterType() {
    return this.adapterType;
  }

  /**
   * Dispatches high-level motion/path commands from coordinator to robots.
   * @param {Array<Object>} fleetCommands Array of robot command specifications
   */
  dispatchFleetCommands(fleetCommands) {
    throw new Error("dispatchFleetCommands() must be implemented by concrete execution adapter.");
  }

  /**
   * Dispatches a command to a specific robot.
   */
  sendRobotCommand(robotId, command) {
    throw new Error("sendRobotCommand() must be implemented by concrete execution adapter.");
  }

  /**
   * Retrieves latest physical/kinematic state of all robots from execution layer.
   * @returns {Array<Object>} Array of robot state objects [{id, x, y, heading, velocity, status}]
   */
  getRobotStates() {
    throw new Error("getRobotStates() must be implemented by concrete execution adapter.");
  }

  /**
   * Injects an actuator or communication fault into an execution entity.
   */
  injectFault(robotId, faultType) {
    throw new Error("injectFault() must be implemented by concrete execution adapter.");
  }

  /**
   * Clears faults and restores execution layer to nominal.
   */
  clearFaults() {
    throw new Error("clearFaults() must be implemented by concrete execution adapter.");
  }

  /**
   * Resets execution layer environment.
   */
  reset() {
    throw new Error("reset() must be implemented by concrete execution adapter.");
  }
}
