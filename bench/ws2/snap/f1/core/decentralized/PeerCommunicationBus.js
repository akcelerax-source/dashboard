// ==========================================================================
// NODEX ACE — Peer Communication Bus (Decentralized Layer)
// Simulates P2P broadcast and unicast message routing between AMR agents
// ==========================================================================

export const MESSAGE_TYPES = {
  STATE_UPDATE: "STATE_UPDATE",
  INTENT_UPDATE: "INTENT_UPDATE",
  TASK_ANNOUNCEMENT: "TASK_ANNOUNCEMENT",
  TASK_BID: "TASK_BID",
  TASK_AWARD: "TASK_AWARD",
  CONFLICT_NOTICE: "CONFLICT_NOTICE",
  COORDINATION_REQUEST: "COORDINATION_REQUEST",
  COORDINATION_RESPONSE: "COORDINATION_RESPONSE",
  HEARTBEAT: "HEARTBEAT",
  // Robot-to-robot move-aside request (both decentralized systems)
  CLEARANCE_REQUEST: "CLEARANCE_REQUEST",
  CLEARANCE_BLOCKED: "CLEARANCE_BLOCKED",
  // System 2: fixed two-robot handshake
  PAIR_REQUEST: "PAIR_REQUEST",
  PAIR_ACCEPT: "PAIR_ACCEPT",
  PAIR_BUSY: "PAIR_BUSY",
  PAIR_INTENT: "PAIR_INTENT",
  PAIR_DECISION: "PAIR_DECISION",
  PAIR_RELEASE: "PAIR_RELEASE",
  // System 3: ACE temporary sessions and space-time contracts
  ACE_SESSION_OPEN: "ACE_SESSION_OPEN",
  ACE_SESSION_JOIN: "ACE_SESSION_JOIN",
  ACE_CONTRACT: "ACE_CONTRACT",
  ACE_SESSION_CLOSE: "ACE_SESSION_CLOSE"
};

export class PeerCommunicationBus {
  constructor() {
    this.subscribers = new Map(); // robotId -> callback
    this.messageCounter = 0;
    this.metrics = {
      totalMessages: 0,
      messagesByType: {},
      coordinationEventsCount: 0,
      droppedMessages: 0
    };
    this.recentMessages = [];
    this.linkConditions = { lossRate: 0, latencyMs: 0 };
    this._lossSeed = 1;
  }

  /**
   * Degrades peer links (scenario comm conditions). Peer messages are dropped
   * with probability `lossRate` (deterministic sequence, so runs reproduce),
   * and delivered messages carry `latencyMs` of extra age, which is what the
   * agents' RACE communication-risk input measures. SYSTEM task-board
   * messages are not affected.
   */
  setLinkConditions({ lossRate = 0, latencyMs = 0 } = {}) {
    this.linkConditions = { lossRate: Math.max(0, Math.min(1, lossRate)), latencyMs: Math.max(0, latencyMs) };
    this._lossSeed = 1;
  }

  _dropNext() {
    if (!this.linkConditions.lossRate) return false;
    this._lossSeed = (this._lossSeed * 1103515245 + 12345) % 2147483648;
    return this._lossSeed / 2147483648 < this.linkConditions.lossRate;
  }

  /**
   * Registers a robot agent to the peer communication bus.
   */
  subscribe(robotId, callback) {
    this.subscribers.set(robotId, callback);
    return () => this.subscribers.delete(robotId);
  }

  unsubscribe(robotId) {
    this.subscribers.delete(robotId);
  }

  /**
   * Routes a message to target receiver or broadcasts to all subscribed peers (excluding sender).
   */
  send(message) {
    this.messageCounter++;
    const msg = {
      id: message.id || `MSG-${this.messageCounter}`,
      type: message.type,
      senderId: message.senderId,
      receiverId: message.receiverId || "BROADCAST",
      timestamp: message.timestamp || Date.now(),
      payload: message.payload || {}
    };
    const degraded = msg.senderId !== "SYSTEM" && (this.linkConditions.lossRate > 0 || this.linkConditions.latencyMs > 0);
    if (degraded && this.linkConditions.latencyMs) msg.latencyMs = this.linkConditions.latencyMs;

    // Metrics accounting
    this.metrics.totalMessages++;
    this.metrics.messagesByType[msg.type] = (this.metrics.messagesByType[msg.type] || 0) + 1;
    if (msg.type.startsWith("COORDINATION_") || msg.type === "CONFLICT_NOTICE"
        || msg.type.startsWith("PAIR_") || msg.type.startsWith("ACE_")) {
      this.metrics.coordinationEventsCount++;
    }

    this.recentMessages.unshift(msg);
    if (this.recentMessages.length > 50) this.recentMessages.pop();

    if (msg.receiverId === "BROADCAST") {
      for (const [id, callback] of this.subscribers.entries()) {
        if (id !== msg.senderId) {
          if (degraded && this._dropNext()) { this.metrics.droppedMessages++; continue; }
          try {
            callback(msg);
          } catch (err) {
            console.error(`[PeerBus] Delivery failed to ${id}:`, err);
          }
        }
      }
    } else {
      const recipientCb = this.subscribers.get(msg.receiverId);
      if (recipientCb && degraded && this._dropNext()) {
        this.metrics.droppedMessages++;
      } else if (recipientCb) {
        try {
          recipientCb(msg);
        } catch (err) {
          console.error(`[PeerBus] Unicast delivery failed to ${msg.receiverId}:`, err);
        }
      }
    }

    return msg;
  }

  broadcast(senderId, type, payload = {}, timestamp = Date.now()) {
    return this.send({
      senderId,
      receiverId: "BROADCAST",
      type,
      payload,
      timestamp
    });
  }

  unicast(senderId, receiverId, type, payload = {}, timestamp = Date.now()) {
    return this.send({
      senderId,
      receiverId,
      type,
      payload,
      timestamp
    });
  }

  getMetrics() {
    return {
      totalMessages: this.metrics.totalMessages,
      messagesByType: { ...this.metrics.messagesByType },
      coordinationEventsCount: this.metrics.coordinationEventsCount,
      droppedMessages: this.metrics.droppedMessages
    };
  }

  getRecentMessages() {
    return [...this.recentMessages];
  }

  /**
   * messageHistory — alias for recentMessages for test compatibility.
   */
  get messageHistory() {
    return this.recentMessages;
  }

  reset() {
    this.subscribers.clear();
    this.messageCounter = 0;
    this.metrics = {
      totalMessages: 0,
      messagesByType: {},
      coordinationEventsCount: 0,
      droppedMessages: 0
    };
    this.recentMessages = [];
    this.linkConditions = { lossRate: 0, latencyMs: 0 };
    this._lossSeed = 1;
  }
}

export const peerCommunicationBus = new PeerCommunicationBus();
