"use strict";

/**
 * OpenCode Gateway Adapter for Claw3D
 *
 * Standalone WebSocket server that speaks the Claw3D gateway protocol.
 * Receives subagent lifecycle events from an OpenCode plugin over Unix socket,
 * translates them into Claw3D agent/session/chat events.
 *
 * Environment:
 *   OPENCODE_ADAPTER_PORT     WebSocket port (default: 18790)
 *   OPENCODE_CLAW3D_SOCKET    Unix socket path for plugin communication
 *   OPENCODE_DB_PATH          Override opencode.db path
 */

const http = require("http");
const fs = require("fs");
const net = require("net");
const path = require("path");
const os = require("os");
const { randomUUID } = require("crypto");
const { WebSocketServer } = require("ws");

const MAX_PLUGIN_BUFFER = 1024 * 1024; // 1 MB safety cap for plugin socket
const EVICTION_IDLE_MS = 5 * 60 * 1000; // remove agents after 5 min idle
const EVICTION_SWEEP_MS = 60 * 1000;    // sweep every 1 min
const ADAPTER_PORT = parseInt(process.env.OPENCODE_ADAPTER_PORT || "18790", 10);
const ADAPTER_HOST = process.env.OPENCODE_ADAPTER_HOST || "127.0.0.1";
const SOCKET_PATH = process.env.OPENCODE_CLAW3D_SOCKET ||
  path.join(os.homedir(), ".config", "opencode", "opencode-claw3d.sock");
const MAIN_KEY = "main";

// Agent registry: maps sessionId -> AgentInfo
const agentRegistry = new Map();
// Conversation history: maps sessionKey -> messages[]
const conversationHistory = new Map();
// Active WebSocket send functions for broadcasting
const activeSendEventFns = new Set();
// Active chat runs (for abort tracking)
const activeRuns = new Map();

// Eviction timers: agentId → setTimeout handle for idle removal
const evictionTimers = new Map();
let orchestratorId = null;
let evictionSweepTimer = null;

// Plugin socket connection
let pluginSocket = null;
let pluginBuffer = "";
const pendingRpcs = new Map(); // rpcId → { resolve, reject, timer }

function randomId() {
  return randomUUID().replace(/-/g, "").slice(0, 12);
}

function sessionKeyFor(agentId) {
  return `agent:${agentId}:${MAIN_KEY}`;
}

function resOk(id, payload) {
  return { type: "res", id, ok: true, payload: payload ?? {} };
}

function resErr(id, code, message) {
  return { type: "res", id, ok: false, error: { code, message } };
}

function broadcastEvent(frame) {
  for (const sendFn of activeSendEventFns) {
    try { sendFn(frame); } catch (_) {}
  }
}

let presenceTimer = null;
let pendingPresence = null;

function debouncedPresence() {
  pendingPresence = buildPresencePayload();
  if (presenceTimer) return;
  presenceTimer = setTimeout(() => {
    presenceTimer = null;
    if (pendingPresence) broadcastEvent({ type: "event", event: "presence", payload: pendingPresence });
    pendingPresence = null;
  }, 200);
}

function buildAgentListPayload() {
  return [...agentRegistry.values()].map((agent) => ({
    id: agent.id,
    name: agent.name,
    workspace: agent.workspace,
    identity: { name: agent.name, emoji: "🤖" },
    role: agent.role || "subagent",
    status: agent.status || "idle",
    parentId: agent.parentId,
  }));
}

function buildPresencePayload() {
  const now = Date.now();
  const recent = [...agentRegistry.values()]
    .filter((a) => a.updatedAt)
    .map((a) => ({ key: sessionKeyFor(a.id), updatedAt: a.updatedAt }));
  const byAgent = [...agentRegistry.keys()].map((aid) => ({
    agentId: aid,
    recent: recent.filter((r) => r.key.includes(`:${aid}:`)),
  }));
  return { sessions: { recent, byAgent } };
}

// ---------------------------------------------------------------------------
// Idle eviction — removes agents after EVICTION_IDLE_MS of inactivity
// ---------------------------------------------------------------------------

function scheduleEviction(agentId) {
  cancelEviction(agentId);
  evictionTimers.set(agentId, setTimeout(() => {
    evictionTimers.delete(agentId);
    const agent = agentRegistry.get(agentId);
    if (agent && agent.status === "idle") {
      agentRegistry.delete(agentId);
      conversationHistory.delete(sessionKeyFor(agentId));
      debouncedPresence();
    }
  }, EVICTION_IDLE_MS));
}

function cancelEviction(agentId) {
  if (evictionTimers.has(agentId)) {
    clearTimeout(evictionTimers.get(agentId));
    evictionTimers.delete(agentId);
  }
}

function sweepEvictions() {
  const now = Date.now();
  for (const [agentId, agent] of agentRegistry) {
    if (agent.status === "idle" && (now - agent.updatedAt) > EVICTION_IDLE_MS) {
      agentRegistry.delete(agentId);
      conversationHistory.delete(sessionKeyFor(agentId));
    }
  }
}

// ---------------------------------------------------------------------------
// Unix socket server -- receives events from OpenCode plugin
// ---------------------------------------------------------------------------

function startPluginSocket() {
  try { fs.unlinkSync(SOCKET_PATH); } catch (_) {}

  const server = net.createServer((conn) => {
    pluginSocket = conn;
    pluginBuffer = "";
    conn.setEncoding("utf8");

    conn.on("data", (chunk) => {
      pluginBuffer += chunk;
      if (pluginBuffer.length > MAX_PLUGIN_BUFFER) {
        console.warn("[opencode-adapter] plugin buffer exceeded", MAX_PLUGIN_BUFFER, "bytes, dropping connection");
        conn.destroy();
        return;
      }
      let idx;
      while ((idx = pluginBuffer.indexOf("\n")) >= 0) {
        const line = pluginBuffer.slice(0, idx);
        pluginBuffer = pluginBuffer.slice(idx + 1);
        if (!line) continue;
        try {
          handlePluginMessage(JSON.parse(line));
        } catch (_) {}
      }
    });

    conn.on("close", () => {
      pluginSocket = null;
    });

    conn.on("error", () => {
      pluginSocket = null;
    });
  });

  server.listen(SOCKET_PATH, () => {
    console.log(`[opencode-adapter] Plugin socket at ${SOCKET_PATH}`);
  });

  return server;
}

function writeToPlugin(frame) {
  if (!pluginSocket) return false;
  try {
    pluginSocket.write(JSON.stringify(frame) + "\n");
    return true;
  } catch (_) {
    return false;
  }
}

function callPluginRpc(method, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    const rpcId = "rpc_" + randomId();
    const timer = setTimeout(() => {
      pendingRpcs.delete(rpcId);
      reject(new Error("RPC " + method + " timed out after " + timeoutMs + "ms"));
    }, timeoutMs || 15000);
    pendingRpcs.set(rpcId, { resolve, reject, timer });
    const sent = writeToPlugin({ type: "rpc", method, id: rpcId, params: params || {} });
    if (!sent) {
      clearTimeout(timer);
      pendingRpcs.delete(rpcId);
      reject(new Error("Plugin socket not connected"));
    }
  });
}

function handlePluginMessage(msg) {
  switch (msg.type) {
    case "subagent:created": {
      const p = msg.payload;
      if (!p || !p.id) break;
      cancelEviction(p.id);
      agentRegistry.set(p.id, {
        id: p.id,
        name: (p.title || p.agent || "Subagent").slice(0, 60),
        role: p.agent || "subagent",
        workspace: p.directory || "",
        identity: { name: p.title || p.agent || "Subagent", emoji: "🤖" },
        status: "running",
        updatedAt: Date.now(),
        parentId: p.parentId || "",
      });
      debouncedPresence();
      break;
    }

    case "subagent:updated": {
      const p = msg.payload;
      if (!p || !p.id) break;
      const agent = agentRegistry.get(p.id);
      if (agent) {
        cancelEviction(p.id);
        if (p.title) agent.name = p.title.slice(0, 60);
        agent.updatedAt = Date.now();
        agent.status = "running";
        debouncedPresence();
      }
      break;
    }

    case "subagent:message": {
      const p = msg.payload;
      if (!p || !p.sessionId) break;
      const sKey = sessionKeyFor(p.sessionId);
      if (!conversationHistory.has(sKey)) conversationHistory.set(sKey, []);
      const history = conversationHistory.get(sKey);
      history.push({ role: p.role || "assistant", content: p.content || "", timestamp: p.timeCreated || Date.now() });
      if (history.length > 200) history.splice(0, history.length - 200);
      break;
    }

    case "subagent:delta": {
      const p = msg.payload;
      if (!p || !p.sessionId) break;
      const sKey = sessionKeyFor(p.sessionId);
      broadcastEvent({
        type: "event",
        event: "chat",
        seq: Date.now(),
        payload: {
          runId: p.messageId || randomId(),
          sessionKey: sKey,
          state: "delta",
          message: { role: "assistant", content: p.text || "" },
        },
      });
      break;
    }

    case "subagent:idle": {
      const p = msg.payload;
      if (!p || !p.id) break;
      const agent = agentRegistry.get(p.id);
      if (agent) {
        agent.status = "idle";
        agent.updatedAt = Date.now();
        scheduleEviction(p.id);
      }
      debouncedPresence();
      break;
    }

    case "subagent:deleted": {
      const p = msg.payload;
      if (!p || !p.id) break;
      cancelEviction(p.id);
      agentRegistry.delete(p.id);
      conversationHistory.delete(sessionKeyFor(p.id));
      debouncedPresence();
      break;
    }

    case "pong":
      break;

    case "rpc_result": {
      const pending = msg.id ? pendingRpcs.get(msg.id) : null;
      if (pending) {
        clearTimeout(pending.timer);
        pendingRpcs.delete(msg.id);
        if (msg.ok) {
          pending.resolve(msg.payload || {});
        } else {
          pending.reject(new Error(msg.error || "RPC failed"));
        }
      } else {
        console.warn("[opencode-adapter] rpc_result for unknown/expired id:", msg.id);
      }
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Claw3D Gateway protocol method handlers
// ---------------------------------------------------------------------------

async function handleMethod(method, params, id, sendEvent) {
  const p = params || {};

  switch (method) {
    case "agents.list": {
      return resOk(id, {
        defaultId: orchestratorId || ([...agentRegistry.keys()][0] || ""),
        mainKey: MAIN_KEY,
        agents: buildAgentListPayload(),
      });
    }

    case "agents.create": {
      const agentName = (typeof p.name === "string" && p.name.trim()) ? p.name.trim() : "Agent";
      const slug = agentName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const newId = slug + "-" + randomId();

      try {
        const result = await callPluginRpc("create_session", {
          parentId: orchestratorId,
          title: agentName,
          directory: p.workspace || "",
        }, 10000);
        const sessionId = result.id || newId;
        agentRegistry.set(sessionId, {
          id: sessionId, name: agentName, role: p.role || "",
          workspace: p.workspace || "", identity: { name: agentName, emoji: "🤖" },
          status: "running", updatedAt: Date.now(), parentId: orchestratorId || "",
        });
        debouncedPresence();
        return resOk(id, { agentId: sessionId, name: agentName, workspace: p.workspace || "/opencode" });
      } catch (_) {
        // Fallback: register locally without a real session
        agentRegistry.set(newId, {
          id: newId, name: agentName, role: p.role || "",
          workspace: p.workspace || "", identity: { name: agentName, emoji: "🤖" },
          status: "idle", updatedAt: Date.now(), parentId: orchestratorId || "",
        });
        debouncedPresence();
        return resOk(id, { agentId: newId, name: agentName, workspace: p.workspace || "/opencode" });
      }
    }

    case "agents.update": {
      const updId = typeof p.agentId === "string" ? p.agentId : "";
      const existing = agentRegistry.get(updId);
      if (existing) {
        if (typeof p.name === "string" && p.name.trim()) existing.name = p.name.trim();
        if (typeof p.workspace === "string" && p.workspace.trim()) existing.workspace = p.workspace.trim();
        if (typeof p.role === "string") existing.role = p.role.trim();
        debouncedPresence();
      }
      return resOk(id, { ok: true, removedBindings: 0 });
    }

    case "agents.delete": {
      const delId = typeof p.agentId === "string" ? p.agentId : "";
      if (delId && delId !== orchestratorId) {
        agentRegistry.delete(delId);
        conversationHistory.delete(sessionKeyFor(delId));
        try { await callPluginRpc("delete_session", { sessionId: delId }, 5000); } catch (_) {}
        debouncedPresence();
      }
      return resOk(id, { ok: true, removedBindings: 0 });
    }

    case "agents.files.get": {
      const fileAgentId = p.agentId || orchestratorId;
      const fileName = p.name || "";
      try {
        const result = await callPluginRpc("read_file", { path: (agentRegistry.get(fileAgentId)?.workspace || "") + "/" + fileName }, 10000);
        return resOk(id, { file: result.content !== undefined ? { content: result.content } : { missing: true } });
      } catch (_) {
        return resOk(id, { file: { missing: true } });
      }
    }

    case "agents.files.set": {
      return resOk(id, {});
    }

    case "sessions.list": {
      const sessions = [...agentRegistry.values()].map((agent) => {
        const sKey = sessionKeyFor(agent.id);
        return {
          key: sKey,
          agentId: agent.id,
          updatedAt: agent.updatedAt,
          displayName: "Main",
          origin: { label: agent.name, provider: "opencode" },
          model: "",
          modelProvider: "opencode",
        };
      });
      return resOk(id, { sessions });
    }

    case "sessions.preview": {
      const keys = Array.isArray(p.keys) ? p.keys : [];
      const limit = typeof p.limit === "number" ? p.limit : 8;
      const maxChars = typeof p.maxChars === "number" ? p.maxChars : 240;
      const previews = keys.map((key) => {
        const history = conversationHistory.get(key) || [];
        if (history.length === 0) return { key, status: "empty", items: [] };
        const items = history.slice(-limit).map((msg) => ({
          role: msg.role === "assistant" ? "assistant" : "user",
          text: String(msg.content || "").slice(0, maxChars),
          timestamp: msg.timestamp || Date.now(),
        }));
        return { key, status: "ok", items };
      });
      return resOk(id, { ts: Date.now(), previews });
    }

    case "sessions.patch":
      return resOk(id, { ok: true, key: p.key || "", entry: {}, resolved: { model: "", modelProvider: "opencode" } });

    case "sessions.reset": {
      const key = typeof p.key === "string" ? p.key : "";
      if (key) conversationHistory.delete(key);
      return resOk(id, { ok: true });
    }

    case "chat.send": {
      const sessionKey = typeof p.sessionKey === "string" ? p.sessionKey : "";
      const message = typeof p.message === "string" ? p.message.trim() : "";
      const runId = typeof p.idempotencyKey === "string" && p.idempotencyKey ? p.idempotencyKey : randomId();

      if (!message || !sessionKey) return resOk(id, { status: "no-op", runId });

      const agentId = sessionKey.startsWith("agent:") ? sessionKey.split(":")[1] : "";
      if (!agentId || !agentRegistry.has(agentId)) return resErr(id, "not_found", "Agent " + agentId + " not found");

      let aborted = false;
      const runEntry = { runId, sessionKey, agentId, abort: () => { aborted = true; } };
      activeRuns.set(runId, runEntry);

      // Fire RPC to plugin; clean up run when the subagent completes
      callPluginRpc("inject_message", { session_id: agentId, text: message }, 300000)
        .then(() => {
          if (activeRuns.get(runId) === runEntry) activeRuns.delete(runId);
        })
        .catch((err) => {
          console.warn("[opencode-adapter] chat.send RPC failed:", err.message);
          if (activeRuns.get(runId) === runEntry) activeRuns.delete(runId);
        });

      return resOk(id, { status: "started", runId });
    }

    case "chat.history": {
      const histKey = typeof p.sessionKey === "string" ? p.sessionKey : "";
      if (histKey && conversationHistory.has(histKey)) {
        return resOk(id, { sessionKey: histKey, messages: conversationHistory.get(histKey) });
      }
      return resOk(id, { sessionKey: histKey || "", messages: [] });
    }

    case "chat.abort": {
      const runId = typeof p.runId === "string" ? p.runId.trim() : "";
      if (runId && activeRuns.has(runId)) {
        activeRuns.get(runId).abort();
        activeRuns.delete(runId);
      }
      return resOk(id, { ok: true, aborted: runId ? 1 : 0 });
    }

    case "agent.wait": {
      const runId = typeof p.runId === "string" ? p.runId : "";
      const timeoutMs = typeof p.timeoutMs === "number" ? p.timeoutMs : 30000;
      const start = Date.now();
      while (activeRuns.has(runId) && Date.now() - start < timeoutMs) {
        await new Promise((r) => setTimeout(r, 100));
      }
      return resOk(id, { status: activeRuns.has(runId) ? "running" : "done" });
    }

    case "status":
      return resOk(id, buildPresencePayload());

    case "config.get":
      return resOk(id, {
        config: { gateway: { reload: { mode: "hot" } } },
        hash: "opencode-adapter",
        exists: true,
        path: "",
      });

    case "config.patch":
    case "config.set":
      return resOk(id, { hash: "opencode-adapter" });

    case "models.list": {
      let models;
      try {
        const db = require("./lib/opencode-db");
        models = db.getOpenCodeModels();
      } catch (_) {
        models = [{ id: "opencode/default", name: "Default", provider: "opencode" }];
      }
      return resOk(id, { models });
    }

    case "skills.status":
      return resOk(id, {
        workspaceDir: p.agentId ? `/opencode/agents/${p.agentId}` : "/opencode",
        managedSkillsDir: "/opencode/skills",
        skills: [],
      });

    case "skills.update":
      return resOk(id, { ok: true, skillKey: p.skillKey || "", config: {} });

    case "skills.install":
      return resOk(id, { ok: true, message: "Use agents.create + chat.send + agent.wait for skill installation.", stdout: "", stderr: "", code: 0 });

    case "skills.remove":
      return resOk(id, { removed: true, removedPath: "", source: "openclaw-workspace" });

    case "wake":
      return resOk(id, { ok: true });

    case "exec.approvals.get":
      return resOk(id, {
        path: "", exists: true, hash: "opencode-approvals",
        file: { version: 1, defaults: { security: "full", ask: "off", autoAllowSkills: true }, agents: {} },
      });

    case "exec.approvals.set":
      return resOk(id, { hash: "opencode-approvals" });

    case "exec.approval.resolve":
      return resOk(id, { ok: true });

    case "cron.list":
      return resOk(id, { jobs: [] });

    case "cron.add":
    case "cron.remove":
    case "cron.run":
    case "cron.patch":
      return resOk(id, { ok: true });

    case "tasks.list":
      return resOk(id, { tasks: [] });

    case "sessions.usage": {
      const startDate = typeof p.startDate === "number" ? p.startDate : 0;
      const endDate = typeof p.endDate === "number" ? p.endDate : Date.now();
      const limit = typeof p.limit === "number" ? p.limit : 200;
      try {
        const db = require("./lib/opencode-db");
        const sessions = db.getSessionsUsage(startDate, endDate, limit);
        const totals = sessions.reduce((acc, s) => ({
          input: acc.input + s.usage.input,
          output: acc.output + s.usage.output,
          cacheRead: acc.cacheRead + s.usage.cacheRead,
          cacheWrite: acc.cacheWrite + s.usage.cacheWrite,
          totalTokens: acc.totalTokens + s.usage.totalTokens,
          inputCost: acc.inputCost + s.usage.inputCost,
          outputCost: acc.outputCost + s.usage.outputCost,
          cacheReadCost: acc.cacheReadCost + s.usage.cacheReadCost,
          cacheWriteCost: acc.cacheWriteCost + s.usage.cacheWriteCost,
          totalCost: acc.totalCost + s.usage.totalCost,
        }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, inputCost: 0, outputCost: 0, cacheReadCost: 0, cacheWriteCost: 0, totalCost: 0 });
        return resOk(id, { sessions, totals });
      } catch (err) {
        console.warn("[opencode-adapter] sessions.usage error:", err.message);
        return resOk(id, { sessions: [], totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, inputCost: 0, outputCost: 0, cacheReadCost: 0, cacheWriteCost: 0, totalCost: 0 } });
      }
    }

    case "usage.cost": {
      const startDate = typeof p.startDate === "number" ? p.startDate : 0;
      const endDate = typeof p.endDate === "number" ? p.endDate : Date.now();
      try {
        const db = require("./lib/opencode-db");
        const daily = db.getUsageCost(startDate, endDate);
        return resOk(id, { daily });
      } catch (err) {
        console.warn("[opencode-adapter] usage.cost error:", err.message);
        return resOk(id, { daily: [] });
      }
    }

    default:
      return resOk(id, {});
  }
}

// ---------------------------------------------------------------------------
// WebSocket server and startup
// ---------------------------------------------------------------------------

function startAdapter() {
  // Seed agent registry from DB on startup
  try {
    const db = require("./lib/opencode-db");

    // Load the orchestrator (main session without parent_id)
    const orchestrator = db.getOrchestratorSession();
    if (orchestrator && !agentRegistry.has(orchestrator.id)) {
      agentRegistry.set(orchestrator.id, {
        id: orchestrator.id,
        name: "Orchestrator",
        role: orchestrator.agent || "opencode",
        workspace: orchestrator.directory || "",
        identity: { name: "Orchestrator", emoji: "🧠" },
        status: "running",
        updatedAt: Date.now(),
        parentId: "",
      });
      orchestratorId = orchestrator.id;
      console.log("[opencode-adapter] Orchestrator:", orchestrator.id);
    }

    // Load recent child sessions (subagents)
    const childSessions = db.getChildSessions(50, 60);
    for (const session of childSessions) {
      if (!agentRegistry.has(session.id)) {
        agentRegistry.set(session.id, {
          id: session.id,
          name: session.title.slice(0, 60),
          role: session.agent || "subagent",
          workspace: session.directory || "",
          identity: { name: session.title, emoji: "🤖" },
          status: "idle",
          updatedAt: Date.now(),
          parentId: session.parentId || "",
        });
      }
    }
    console.log("[opencode-adapter] Seeded " + childSessions.length + " recent subagents from opencode.db");
  } catch (err) {
    console.warn("[opencode-adapter] Could not seed from DB:", err.message);
  }

  // Periodic eviction sweep as safety net
  evictionSweepTimer = setInterval(sweepEvictions, EVICTION_SWEEP_MS);

  // Start Unix socket for plugin communication
  const pluginServer = startPluginSocket();

  // Start HTTP server
  const httpServer = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("OpenCode Gateway Adapter for Claw3D\n");
  });

  // Start WebSocket server
  const wss = new WebSocketServer({ server: httpServer });
  let globalSeq = 0;

  wss.on("connection", (ws) => {
    let connected = false;

    const send = (frame) => {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(typeof frame === "string" ? frame : JSON.stringify(frame));
    };

    const sendEventFn = (frame) => {
      if (frame && typeof frame === "object" && frame.type === "event" && typeof frame.seq !== "number") {
        frame.seq = globalSeq++;
        send(frame);
        return;
      }
      send(frame);
    };

    activeSendEventFns.add(sendEventFn);
    send({ type: "event", event: "connect.challenge", payload: { nonce: randomId() } });

    ws.on("message", async (raw) => {
      let frame;
      try {
        frame = JSON.parse(raw.toString("utf8"));
      } catch { return; }
      if (!frame || frame.type !== "req") return;
      const { id, method, params } = frame;
      if (typeof id !== "string" || typeof method !== "string") return;

      if (method === "connect") {
        connected = true;
        send({
          type: "res", id, ok: true,
          payload: {
            type: "hello-ok",
            protocol: 3,
            adapterType: "opencode",
            features: {
              methods: [
                "agents.list", "agents.create", "agents.update", "agents.delete",
                "agents.files.get", "agents.files.set",
                "sessions.list", "sessions.preview", "sessions.usage",
                "sessions.patch", "sessions.reset", "chat.send",
                "chat.abort", "chat.history", "agent.wait", "status",
                "config.get", "config.set", "config.patch",
                "models.list", "skills.status", "skills.update",
                "skills.install", "skills.remove", "wake",
                "usage.cost",
                "exec.approvals.get", "exec.approvals.set", "exec.approval.resolve",
              ],
              events: ["chat", "presence", "heartbeat"],
            },
            snapshot: {
              health: {
                agents: [...agentRegistry.values()].map((a) => ({
                  agentId: a.id, name: a.name, isDefault: false,
                })),
                defaultAgentId: orchestratorId || ([...agentRegistry.keys()][0] || ""),
              },
              sessionDefaults: { mainKey: MAIN_KEY },
            },
            auth: { role: "operator", scopes: ["operator.admin"] },
            policy: { tickIntervalMs: 30000 },
          },
        });
        return;
      }

      if (!connected) {
        send(resErr(id, "not_connected", "Send connect first."));
        return;
      }

      try {
        send(await handleMethod(method, params, id, sendEventFn));
      } catch (error) {
        send(resErr(id, "internal_error", error instanceof Error ? error.message : "Internal error"));
      }
    });

    ws.on("close", () => activeSendEventFns.delete(sendEventFn));
    ws.on("error", () => activeSendEventFns.delete(sendEventFn));
  });

  httpServer.listen(ADAPTER_PORT, ADAPTER_HOST, () => {
    console.log("[opencode-adapter] WebSocket server at ws://localhost:" + ADAPTER_PORT);
    console.log("[opencode-adapter] Connect Claw3D using 'OpenCode' backend profile");
  });

  const cleanup = () => {
    console.log("\n[opencode-adapter] Shutting down...");
    wss.close();
    httpServer.close();
    pluginServer.close();
    try { fs.unlinkSync(SOCKET_PATH); } catch (_) {}
    // Clear all eviction timers
    if (evictionSweepTimer) clearInterval(evictionSweepTimer);
    for (const [agentId, timer] of evictionTimers) {
      clearTimeout(timer);
    }
    evictionTimers.clear();
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

if (require.main === module) {
  startAdapter();
}

module.exports = { startAdapter, handleMethod };
