// ==========================================================================
// NODEX ACE - Cross-Browser Shared State Sync
// Keeps UI preferences and archived run history in the backend
// (backend/server.py, /api/shared + /ws/shared) so every open dashboard sees
// the same values live. localStorage stays as the offline cache: if the
// backend is not running, the dashboard behaves exactly as before and
// reconnects when the backend comes back.
// ==========================================================================

import { state } from "./state.js";
import { getArchivedRuns, replaceArchivedRuns, setRunHistorySink } from "../data/run-history.js";

const PREF_KEYS = ["theme", "timeFormat", "autoRefresh", "robotCount"];
// Keys whose state setter does not already write localStorage.
const LOCAL_CACHE_KEYS = { timeFormat: "nodex_time_format", autoRefresh: "nodex_auto_refresh" };
const MAX_RETRY_MS = 30000;

let started = false;
let connected = false;
let applyingRemote = false;
let retryMs = 2000;

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}`);
  return res.json();
}

function applyPrefs(prefs) {
  if (!prefs || typeof prefs !== "object") return;
  applyingRemote = true;
  try {
    for (const key of PREF_KEYS) {
      if (!(key in prefs) || state.get(key) === prefs[key]) continue;
      if (key === "robotCount" && state.get("configLocked")) continue; // never change a running run
      state.set(key, prefs[key]);
      if (LOCAL_CACHE_KEYS[key]) {
        try { localStorage.setItem(LOCAL_CACHE_KEYS[key], String(prefs[key])); } catch (e) {}
      }
    }
  } finally {
    applyingRemote = false;
  }
}

/** Uploads runs only this browser has, then adopts the shared state. */
async function reconcile() {
  const shared = await api("GET", "/api/shared");
  const known = new Set((shared.runs || []).map(r => r.runId));
  const localOnly = getArchivedRuns().filter(r => r.runId && !known.has(r.runId));
  const runs = localOnly.length > 0
    ? (await api("POST", "/api/shared/runs", { runs: localOnly })).runs
    : shared.runs;
  replaceArchivedRuns(runs || []);

  // First browser to connect seeds the shared preferences from its own.
  const prefs = shared.prefs || {};
  const missing = {};
  for (const key of PREF_KEYS) {
    if (!(key in prefs)) missing[key] = state.get(key);
  }
  if (Object.keys(missing).length > 0) await api("PUT", "/api/shared/prefs", missing);
  applyPrefs(prefs);
}

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws/shared`);

  ws.onopen = () => {
    reconcile()
      .then(() => {
        connected = true;
        retryMs = 2000;
      })
      .catch(err => console.warn("[SharedSync] Initial sync failed:", err));
  };

  ws.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch (e) { return; }
    if (msg.type === "prefs") applyPrefs(msg.prefs);
    else if (msg.type === "runs") replaceArchivedRuns(msg.runs);
  };

  ws.onclose = () => {
    connected = false;
    setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
  };
}

export function startSharedSync() {
  if (started || typeof window === "undefined" || typeof WebSocket === "undefined") return;
  started = true;

  for (const key of PREF_KEYS) {
    state.subscribe(key, (value) => {
      if (applyingRemote || !connected) return;
      api("PUT", "/api/shared/prefs", { [key]: value })
        .catch(err => console.warn("[SharedSync] Pref push failed:", err));
    });
  }

  setRunHistorySink({
    add: (run) => {
      if (!connected) return; // uploaded by reconcile() on reconnect
      api("POST", "/api/shared/runs", { runs: [run] })
        .catch(err => console.warn("[SharedSync] Run upload failed:", err));
    },
    clear: () => {
      if (!connected) return;
      api("DELETE", "/api/shared/runs")
        .catch(err => console.warn("[SharedSync] Clear failed:", err));
    }
  });

  connect();
}
