// ==========================================================================
// NODEX ACE — Centralized Capability Registry & Feature Gating
// Single source of truth for features supported across Centralized,
// Decentralized, and ACE/RACE coordination architectures.
// ==========================================================================

export const UNIVERSAL_CAPABILITIES = [
  "basicMonitoring",
  "fleetOverview",
  "mapVisualization",
  "robotInspection",
  "waypointTracking"
];

export const CENTRALIZED_CAPABILITIES = [
  ...UNIVERSAL_CAPABILITIES,
  "centralizedDispatch",
  "globalPathPlanning",
  "centralConflictArbitration",
  "centralizedFleetState"
];

export const DECENTRALIZED_CAPABILITIES = [
  ...UNIVERSAL_CAPABILITIES,
  "peerNegotiation",
  "decentralizedBidding",
  "localPathPlanning",
  "distributedDeadlockRecovery",
  "p2pHeartbeats"
];

export const ACE_CAPABILITIES = [
  ...DECENTRALIZED_CAPABILITIES,
  "hitl",
  "aceValidation",
  "adaptiveEnvelope",
  "raceRisk",
  "containmentRouting",
  "hysteresisStabilization",
  "adaptiveCommunicationRate",
  "dynamicSpeedThrottling"
];

export const CAPABILITY_REGISTRY = {
  centralized: new Set(CENTRALIZED_CAPABILITIES),
  decentralized: new Set(DECENTRALIZED_CAPABILITIES),
  ace: new Set(ACE_CAPABILITIES)
};

export const FEATURE_ALIAS_MAP = {
  hitl_control: "hitl",
  hitl: "hitl",
  ace_validation: "aceValidation",
  aceValidation: "aceValidation",
  adaptive_envelopes: "adaptiveEnvelope",
  adaptiveEnvelope: "adaptiveEnvelope",
  risk_adaptive_metrics: "raceRisk",
  raceRisk: "raceRisk",
  fleet_monitoring: "fleetOverview",
  fleetMonitoring: "fleetOverview",
  peer_negotiation: "peerNegotiation",
  peerNegotiation: "peerNegotiation",
  p2p_negotiation: "peerNegotiation",
  p2pNegotiation: "peerNegotiation"
};

/**
 * Checks whether a capability is supported under the specified system mode.
 * @param {string} systemMode - "centralized" | "decentralized" | "ace"
 * @param {string} capabilityKey - Feature or capability identifier
 * @returns {boolean}
 */
export function isCapabilitySupported(systemMode, capabilityKey) {
  const mode = (systemMode || "ace").toLowerCase();
  const normalizedKey = FEATURE_ALIAS_MAP[capabilityKey] || capabilityKey;
  const capabilities = CAPABILITY_REGISTRY[mode];
  if (!capabilities) return false;
  return capabilities.has(normalizedKey);
}

/**
 * Generates an informative explanation for why a feature is unavailable.
 * @param {string} systemMode - "centralized" | "decentralized" | "ace"
 * @param {string} capabilityKey - Feature or capability identifier
 * @returns {string}
 */
export function getCapabilityUnavailableReason(systemMode, capabilityKey) {
  const mode = (systemMode || "ace").toLowerCase();
  const normalizedKey = FEATURE_ALIAS_MAP[capabilityKey] || capabilityKey;
  
  if (["hitl", "aceValidation", "adaptiveEnvelope", "raceRisk"].includes(normalizedKey)) {
    if (mode === "centralized") {
      return `Feature '${normalizedKey}' requires decentralized edge envelope dynamics and is strictly gated off in Centralized mode.`;
    }
    if (mode === "decentralized") {
      return `Feature '${normalizedKey}' requires the ACE/RACE layer and is disabled in standard Decentralized mode.`;
    }
  }

  return `Feature '${normalizedKey}' is not supported under ${mode.toUpperCase()} coordination.`;
}
