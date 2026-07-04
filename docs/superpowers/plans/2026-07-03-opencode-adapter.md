# OpenCode Subagent Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) for syntax tracking.

**Goal:** Build an adapter that visualizes OpenCode subagents (child sessions spawned via `task()`) as characters in Claw3D's 3D office.

**Architecture:** An OpenCode plugin (`opencode-claw3d.js`) hooks the event bus and forwards subagent lifecycle events over a Unix socket to a standalone Node.js WebSocket gateway adapter (`opencode-gateway-adapter.js`). The adapter speaks the Claw3D gateway protocol on port 18790. A setup script installs both pieces.

**Tech Stack:** Node.js (built-in `net`, `http`, `ws`), OpenCode plugin SDK (event bus hooks), `better-sqlite3` for DB queries, Claw3D gateway protocol.

---

### Task 1: Create DB Utility Module

**Files:**
- Create: `claw3d/server/lib/opencode-db.js`

- [ ] **Step 1: Write the utility module**

`claw3d/server/lib/opencode-db.js`:
```js
"use strict";

const { homedir } = require("node:os");
const { join } = require("node:path");
const { execSync } = require("node:child_process");

function getDbPath() {
  return (
    process.env.OPENCODE_DB_PATH ||
    join(homedir(), ".local/share/opencode/opencode.db")
  );
}

function getConfigPath() {
  return (
    process.env.OPENCODE_CONFIG_PATH ||
    join(homedir(), ".config/opencode/opencode.json")
  );
}

/**
 * Query opencode.db for sessions with parent_id (child/subagent sessions).
 * Returns an array of agent-like session objects.
 */
function getChildSessions(limit = 50) {
  const dbPath = getDbPath();
  try {
    const rows = queryDb(
      `SELECT id, parent_id, agent, title, directory, time_created, time_updated, model
       FROM session
       WHERE parent_id IS NOT NULL
       ORDER BY time_created DESC
       LIMIT ${Number.isFinite(limit) ? Math.max(1, Math.min(500, limit)) : 50}`
    );
    return rows.map(normalizeSessionRow);
  } catch {
    return [];
  }
}

/**
 * Get messages for a given session.
 */
function getSessionMessages(sessionId, limit = 20) {
  try {
    const rows = queryDb(
      `SELECT id, time_created, data
       FROM message
       WHERE session_id = ?
       ORDER BY time_created ASC
       LIMIT ${Number.isFinite(limit) ? Math.max(1, Math.min(200, limit)) : 20}`,
      [sessionId]
    );
    return rows.map((row) => {
      let data = {};
      try { data = JSON.parse(row.data || "{}"); } catch {}
      return {
        id: row.id,
        role: data.role || "user",
        content: data.content || data.text || "",
        timeCreated: row.time_created,
      };
    });
  } catch {
    return [];
  }
}

/**
 * Read the opencode config JSON for model definitions.
 */
function getOpenCodeModels() {
  try {
    const configPath = getConfigPath();
    const fs = require("fs");
    const raw = fs.readFileSync(configPath, "utf8");
    const config = JSON.parse(raw);
    const models = [];
    if (config.provider) {
      for (const [providerName, provider] of Object.entries(config.provider)) {
        if (provider.models && typeof provider.models === "object") {
          for (const modelId of Object.keys(provider.models)) {
            models.push({ id: `${providerName}/${modelId}`, name: modelId, provider: providerName });
          }
        }
      }
    }
    return models.length > 0 ? models : [{ id: "opencode/default", name: "Default", provider: "opencode" }];
  } catch {
    return [{ id: "opencode/default", name: "Default", provider: "opencode" }];
  }
}

function normalizeSessionRow(row) {
  return {
    id: row.id,
    parentId: row.parent_id,
    agent: row.agent || "subagent",
    title: (row.title || "Agent").slice(0, 60),
    directory: row.directory || "",
    timeCreated: row.time_created,
    timeUpdated: row.time_updated,
    model: row.model || "",
  };
}

function queryDb(sql, params = []) {
  // Try better-sqlite3 first (may be globally available via opencode)
  try {
    const Database = require("better-sqlite3");
    const db = new Database(getDbPath(), { readonly: true, fileMustExist: true });
    try {
      const stmt = db.prepare(sql);
      const rows = params.length > 0 ? stmt.all(...params) : stmt.all();
      return rows;
    } finally {
      db.close();
    }
  } catch (_) {
    // Fallback: shell out to `opencode db` CLI
    const sanitized = sql.replace(/\s+/g, " ").trim();
    const safe = sanitized.replace(/['"]/g, "");
    const out = execSync(`opencode db "${safe}" --format json 2>/dev/null`, {
      encoding: "utf8",
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const parsed = JSON.parse(out.trim());
    return Array.isArray(parsed) ? parsed : [];
  }
}

module.exports = { getChildSessions, getSessionMessages, getOpenCodeModels, getDbPath, getConfigPath };
```

- [ ] **Step 2: Verify the module loads**

Run: `node -e "require('./server/lib/opencode-db.js')" -p "Object.keys(require('./server/lib/opencode-db.js'))"`

Expected: `[ 'getChildSessions', 'getSessionMessages', 'getOpenCodeModels', 'getDbPath', 'getConfigPath' ]`

- [ ] **Step 3: Add `better-sqlite3` as a dependency**

Run: `npm install --save better-sqlite3` in `claw3d/`

---

### Task 2: Create OpenCode Plugin

**Files:**
- Create: `~/.config/opencode/plugins/opencode-claw3d.js`
- Reference: `~/.config/opencode/plugins/cmux-session.js` (existing pattern)

- [ ] **Step 1: Write the plugin**

`~/.config/opencode/plugins/opencode-claw3d.js`:
```js
// opencode-claw3d v1
// Bridges OpenCode subagent lifecycle events to Claw3D's gateway adapter
// via Unix socket.
// Installed by `npm run setup:opencode` in the claw3d project.
// DO NOT EDIT MANUALLY. Run the setup script to upgrade.

import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

const SOCKET_PATH = process.env.OPENCODE_CLAW3D_SOCKET_PATH ||
  join(homedir(), ".config/opencode/opencode-claw3d.sock");
const RECONNECT_DELAY_MS = 2000;

let client = null;
let buffered = "";
let reconnectTimer = null;
const pendingRpcs = new Map();

function connectSocket() {
  try {
    const conn = connect(SOCKET_PATH);
    conn.setEncoding("utf8");
    conn.on("data", (chunk) => {
      buffered += chunk;
      let idx;
      while ((idx = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, idx);
        buffered = buffered.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          // Handle RPC responses
          if (msg.id && pendingRpcs.has(msg.id)) {
            pendingRpcs.get(msg.id)(msg);
            pendingRpcs.delete(msg.id);
          }
          // Handle inject_message commands
          if (msg.command === "inject_message" && msg.sessionId && msg.message) {
            handleInjectMessage(msg.sessionId, msg.message, msg.id);
          }
          if (msg.command === "ping") {
            write({ type: "pong" });
          }
        } catch {}
      }
    });
    conn.on("close", () => {
      client = null;
      scheduleReconnect();
    });
    conn.on("error", () => {
      client = null;
      scheduleReconnect();
    });
    return conn;
  } catch {
    scheduleReconnect();
    return null;
  }
}

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    if (!client) client = connectSocket();
  }, RECONNECT_DELAY_MS);
}

function write(frame) {
  if (!client) client = connectSocket();
  if (!client) return;
  try {
    client.write(JSON.stringify(frame) + "\n");
  } catch {}
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

function eventProperties(event) {
  return (event && typeof event === "object" && event.properties) || {};
}

async function handleInjectMessage(sessionId, message, rpcId) {
  try {
    // Use the OpenCode SDK to inject a message into the target session
    const raw = await import("opencode/sdk");
    const opencode = raw.default || raw;
    if (opencode?.client?.session?.promptAsync) {
      await opencode.client.session.promptAsync({
        path: { id: sessionId },
        body: {
          parts: [{ type: "text", text: message }],
        },
      });
      write({ type: "inject_message:result", id: rpcId, ok: true });
    } else if (globalThis?.__opencode__?.client?.session?.promptAsync) {
      await globalThis.__opencode__.client.session.promptAsync({
        path: { id: sessionId },
        body: {
          parts: [{ type: "text", text: message }],
        },
      });
      write({ type: "inject_message:result", id: rpcId, ok: true });
    } else {
      // Fallback: use the ctx provided at plugin init
      write({ type: "inject_message:result", id: rpcId, ok: false, error: "SDK not available" });
    }
  } catch (err) {
    write({ type: "inject_message:result", id: rpcId, ok: false, error: err.message });
  }
}

const CLAW3D_PLUGIN_KEY = Symbol.for("opencode.claw3d.plugin.installed");

export const OpenCodeClaw3d = async (ctx) => {
  if (globalThis[CLAW3D_PLUGIN_KEY]) return {};
  globalThis[CLAW3D_PLUGIN_KEY] = true;

  // Store ctx for inject_message handler
  globalThis.__opencode__ = ctx;

  return {
    name: "opencode-claw3d",
    event: async ({ event }) => {
      const props = eventProperties(event);
      const info = props.info || {};

      switch (event.type) {
        case "session.created.1": {
          // Only forward sessions that have a parent_id (these are subagents)
          const parentId = info.parentId || info.parent_id || props.parentId || props.parent_id;
          if (parentId) {
            write({
              type: "subagent:created",
              payload: {
                id: info.id || event.sessionId || "",
                parentId,
                agent: info.agent || props.agent || "",
                title: info.title || props.title || "Agent",
                directory: info.directory || props.directory || "",
                timeCreated: info.timeCreated || props.timeCreated || Date.now(),
              },
            });
          }
          break;
        }

        case "session.updated.1": {
          const sid = info.id || props.sessionID || "";
          if (sid) {
            write({
              type: "subagent:updated",
              payload: { id: sid, title: info.title || props.title || "" },
            });
          }
          break;
        }

        case "session.idle": {
          const sid = props.sessionID || info.id || "";
          if (sid) {
            write({ type: "subagent:idle", payload: { id: sid } });
          }
          break;
        }

        case "session.deleted": {
          const sid = info.id || props.sessionID || "";
          if (sid) {
            write({ type: "subagent:deleted", payload: { id: sid } });
          }
          break;
        }

        default:
          break;
      }
    },
  };
};

export default OpenCodeClaw3d;
```

- [ ] **Step 2: Verify plugin syntax**

Run: `node --experimental-modules -e "
  import('./Users/suarzac-pro/.config/opencode/plugins/opencode-claw3d.js').then(m => {
    console.log('Plugin loads OK. Exports:', Object.keys(m));
  }).catch(e => console.error('Load failed:', e.message));
"`

Expected: Logs "Plugin loads OK. Exports: ..."

---

### Task 3: Create the Gateway Adapter (core)

**Files:**
- Create: `claw3d/server/opencode-gateway-adapter.js`
- Reference: `claw3d/server/demo-gateway-adapter.js` (protocol pattern)

- [ ] **Step 1: Write the adapter — header, imports, state, and helpers**

Write the top portion of `claw3d/server/opencode-gateway-adapter.js`:
```js
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

const ADAPTER_PORT = parseInt(process.env.OPENCODE_ADAPTER_PORT || "18790", 10);
const SOCKET_PATH = process.env.OPENCODE_CLAW3D_SOCKET ||
  path.join(os.homedir(), ".config/opencode/opencode-claw3d.sock");
const MAIN_KEY = "main";

// Agent registry: maps sessionId → AgentInfo
const agentRegistry = new Map();
// Conversation history: maps sessionKey → messages[]
const conversationHistory = new Map();
// Active WebSocket send functions for broadcasting
const activeSendEventFns = new Set();
// Active chat runs (for abort tracking)
const activeRuns = new Map();

// Plugin socket connection
let pluginSocket = null;
let pluginBuffer = "";

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
  const json = JSON.stringify(frame);
  for (const sendFn of activeSendEventFns) {
    try { sendFn(json); } catch {}
  }
}

function debouncedBroadcastEvent() {
  let timer = null;
  let pending = null;
  return (frame) => {
    pending = frame;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (pending) broadcastEvent(pending);
      pending = null;
    }, 200);
  };
}

const broadcastPresence = debouncedBroadcastEvent();

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
```

- [ ] **Step 2: Write the Unix socket server (plugin communication)**

Append to `claw3d/server/opencode-gateway-adapter.js`:
```js
// ---------------------------------------------------------------------------
// Unix socket server — receives events from OpenCode plugin
// ---------------------------------------------------------------------------

function startPluginSocket() {
  // Remove stale socket file
  try { fs.unlinkSync(SOCKET_PATH); } catch {}

  const server = net.createServer((conn) => {
    pluginSocket = conn;
    pluginBuffer = "";
    conn.setEncoding("utf8");

    conn.on("data", (chunk) => {
      pluginBuffer += chunk;
      let idx;
      while ((idx = pluginBuffer.indexOf("\n")) >= 0) {
        const line = pluginBuffer.slice(0, idx);
        pluginBuffer = pluginBuffer.slice(idx + 1);
        if (!line) continue;
        try {
          handlePluginMessage(JSON.parse(line));
        } catch {}
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
  } catch {
    return false;
  }
}

function handlePluginMessage(msg) {
  switch (msg.type) {
    case "subagent:created": {
      const p = msg.payload;
      if (!p || !p.id) break;
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
      broadcastPresence(buildPresencePayload());
      break;
    }

    case "subagent:updated": {
      const p = msg.payload;
      if (!p || !p.id) break;
      const agent = agentRegistry.get(p.id);
      if (agent) {
        if (p.title) agent.name = p.title.slice(0, 60);
        agent.updatedAt = Date.now();
        broadcastPresence(buildPresencePayload());
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
      // Forward chat deltas to connected Claw3D clients
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
      }
      broadcastPresence(buildPresencePayload());
      break;
    }

    case "subagent:deleted": {
      const p = msg.payload;
      if (!p || !p.id) break;
      agentRegistry.delete(p.id);
      conversationHistory.delete(sessionKeyFor(p.id));
      broadcastPresence(buildPresencePayload());
      break;
    }

    case "pong":
      break;
  }
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
```

- [ ] **Step 3: Write the Claw3D gateway method handlers**

Append to `claw3d/server/opencode-gateway-adapter.js`:
```js
// ---------------------------------------------------------------------------
// Claw3D Gateway protocol method handlers
// ---------------------------------------------------------------------------

async function handleMethod(method, params, id, sendEvent) {
  const p = params || {};

  switch (method) {
    case "agents.list": {
      const defaultAgent = [...agentRegistry.values()][0];
      return resOk(id, {
        defaultId: defaultAgent ? defaultAgent.id : "",
        mainKey: MAIN_KEY,
        agents: buildAgentListPayload(),
      });
    }

    case "sessions.list": {
      const sessions = [...agentRegistry.values()].map((agent) => {
        const sKey = sessionKeyFor(agent.id);
        const history = conversationHistory.get(sKey) || [];
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

      // Extract agent ID from sessionKey ("agent:<id>:main")
      const agentId = sessionKey.startsWith("agent:") ? sessionKey.split(":")[1] : "";
      if (!agentId || !agentRegistry.has(agentId)) return resErr(id, "not_found", `Agent ${agentId} not found`);

      let aborted = false;
      activeRuns.set(runId, { runId, sessionKey, agentId, abort: () => { aborted = true; } });

      // Forward to plugin for injection
      const sent = writeToPlugin({
        command: "inject_message",
        id: runId,
        sessionId: agentId,
        message,
      });

      if (!sent) {
        activeRuns.delete(runId);
        return resErr(id, "plugin_unavailable", "OpenCode plugin socket not connected");
      }

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
      } catch {
        models = [{ id: "opencode/default", name: "Default", provider: "opencode" }];
      }
      return resOk(id, { models });
    }

    case "skills.status":
      return resOk(id, { skills: [] });

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

    default:
      console.warn(`[opencode-adapter] Unhandled method: ${method}`);
      return resOk(id, {});
  }
}
```

- [ ] **Step 4: Write the WebSocket server and startup**

Append to `claw3d/server/opencode-gateway-adapter.js`:
```js
// ---------------------------------------------------------------------------
// Claw3D Gateway WebSocket server
// ---------------------------------------------------------------------------

function startAdapter() {
  // Seed agent registry from DB on startup
  try {
    const db = require("./lib/opencode-db");
    const childSessions = db.getChildSessions(50);
    for (const session of childSessions) {
      if (!agentRegistry.has(session.id)) {
        agentRegistry.set(session.id, {
          id: session.id,
          name: session.title.slice(0, 60),
          role: session.agent || "subagent",
          workspace: session.directory || "",
          identity: { name: session.title, emoji: "🤖" },
          status: "idle",
          updatedAt: session.timeUpdated || session.timeCreated,
          parentId: session.parentId || "",
        });
      }
    }
    console.log(`[opencode-adapter] Seeded ${childSessions.length} subagents from opencode.db`);
  } catch (err) {
    console.warn("[opencode-adapter] Could not seed from DB:", err.message);
  }

  // Start Unix socket for plugin communication
  const pluginServer = startPluginSocket();

  // Start HTTP server for health check
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

    const sendEventFn = (jsonStr) => {
      // Used by broadcastEvent — frame is already JSON-stringified
      send(jsonStr);
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
                "agents.list", "sessions.list", "sessions.preview",
                "sessions.patch", "sessions.reset", "chat.send",
                "chat.abort", "chat.history", "agent.wait", "status",
                "config.get", "config.set", "config.patch",
                "models.list", "skills.status", "wake",
                "exec.approvals.get", "exec.approvals.set", "exec.approval.resolve",
              ],
              events: ["chat", "presence", "heartbeat"],
            },
            snapshot: {
              health: {
                agents: [...agentRegistry.values()].map((a) => ({
                  agentId: a.id, name: a.name, isDefault: false,
                })),
                defaultAgentId: [...agentRegistry.keys()][0] || "",
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

  httpServer.listen(ADAPTER_PORT, "127.0.0.1", () => {
    console.log(`[opencode-adapter] WebSocket server at ws://localhost:${ADAPTER_PORT}`);
    console.log("[opencode-adapter] Connect Claw3D using 'OpenCode' backend profile");
  });

  // Handle cleanup
  const cleanup = () => {
    console.log("\n[opencode-adapter] Shutting down...");
    wss.close();
    httpServer.close();
    pluginServer.close();
    try { fs.unlinkSync(SOCKET_PATH); } catch {}
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

if (require.main === module) {
  startAdapter();
}

module.exports = { startAdapter, handleMethod };
```

- [ ] **Step 5: Verify the adapter loads**

Run: `node -e "require('./server/opencode-gateway-adapter.js')" -p "Object.keys(require('./server/opencode-gateway-adapter.js'))"`

Expected: `[ 'startAdapter', 'handleMethod' ]`

- [ ] **Step 6: Test the adapter connects and responds**

```bash
# Start adapter in background
node server/opencode-gateway-adapter.js &
sleep 1

# Connect with a simple WS message
node -e "
const { WebSocket } = require('ws');
const ws = new WebSocket('ws://localhost:18790');
ws.on('open', () => {
  ws.send(JSON.stringify({type:'req',id:'1',method:'connect',params:{}}));
});
ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  console.log('Got:', JSON.stringify(msg).slice(0, 200));
  if (msg.type === 'res' && msg.id === '1') {
    ws.send(JSON.stringify({type:'req',id:'2',method:'agents.list',params:{}}));
  }
  if (msg.type === 'res' && msg.id === '2') {
    console.log('Agents:', JSON.stringify(msg.payload.agents.length));
    ws.close();
    process.exit(0);
  }
});
setTimeout(() => process.exit(1), 5000);
"

# Kill the adapter
kill %1 2>/dev/null; wait 2>/dev/null
```

Expected: Connects, receives `hello-ok`, receives agents list (may be empty if no opencode sessions yet).

---

### Task 4: Create the Setup Script

**Files:**
- Create: `claw3d/scripts/setup-opencode-adapter.mjs`

- [ ] **Step 1: Write the setup script**

`claw3d/scripts/setup-opencode-adapter.mjs`:
```js
#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const PLUGIN_NAME = "opencode-claw3d.js";
const PLUGIN_SOURCE = join(dirname(dirname(require.resolve("package.json"))), "server", "opencode-claw3d-plugin.js");
const PLUGIN_DEST = join(homedir(), ".config", "opencode", "plugins", PLUGIN_NAME);
const CONFIG_PATH = join(homedir(), ".config", "opencode", "opencode.json");

function log(label, msg) {
  console.log(`  ${label.padEnd(12)} ${msg}`);
}

async function main() {
  console.log("\n  OpenCode-Claw3D Adapter Setup\n");

  // Step 1: Ensure plugin source exists (fallback: inline it)
  const pluginCode = `// opencode-claw3d v1
// Bridges OpenCode subagent lifecycle events to Claw3D's gateway adapter
// via Unix socket.
// Installed by \`npm run setup:opencode\`.

import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

const SOCKET_PATH = process.env.OPENCODE_CLAW3D_SOCKET_PATH ||
  join(homedir(), ".config/opencode/opencode-claw3d.sock");
const RECONNECT_DELAY_MS = 2000;

let client = null;
let buffered = "";
let reconnectTimer = null;

function connectSocket() {
  try {
    const conn = connect(SOCKET_PATH);
    conn.setEncoding("utf8");
    conn.on("data", (chunk) => {
      buffered += chunk;
      let idx;
      while ((idx = buffered.indexOf("\\n")) >= 0) {
        const line = buffered.slice(0, idx);
        buffered = buffered.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.command === "inject_message" && msg.sessionId && msg.message) {
            handleInjectMessage(msg.sessionId, msg.message, msg.id);
          }
          if (msg.command === "ping") {
            write({ type: "pong" });
          }
        } catch {}
      }
    });
    conn.on("close", () => { client = null; scheduleReconnect(); });
    conn.on("error", () => { client = null; scheduleReconnect(); });
    return conn;
  } catch { scheduleReconnect(); return null; }
}

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    if (!client) client = connectSocket();
  }, RECONNECT_DELAY_MS);
}

function write(frame) {
  if (!client) client = connectSocket();
  if (!client) return;
  try { client.write(JSON.stringify(frame) + "\\n"); } catch {}
}

async function handleInjectMessage(sessionId, message, rpcId) {
  try {
    const ctx = globalThis.__opencode__;
    if (ctx?.client?.session?.promptAsync) {
      await ctx.client.session.promptAsync({
        path: { id: sessionId },
        body: { parts: [{ type: "text", text: message }] },
      });
      write({ type: "inject_message:result", id: rpcId, ok: true });
    } else {
      write({ type: "inject_message:result", id: rpcId, ok: false, error: "SDK not available" });
    }
  } catch (err) {
    write({ type: "inject_message:result", id: rpcId, ok: false, error: err.message });
  }
}

function eventProperties(event) {
  return (event && typeof event === "object" && event.properties) || {};
}

const INSTALLED_KEY = Symbol.for("opencode.claw3d.plugin.installed");

export const OpenCodeClaw3d = async (ctx) => {
  if (globalThis[INSTALLED_KEY]) return {};
  globalThis[INSTALLED_KEY] = true;
  globalThis.__opencode__ = ctx;

  return {
    name: "opencode-claw3d",
    event: async ({ event }) => {
      const props = eventProperties(event);
      const info = props.info || {};
      switch (event.type) {
        case "session.created.1": {
          const parentId = info.parentId || info.parent_id || props.parentId || props.parent_id;
          if (parentId) {
            write({
              type: "subagent:created",
              payload: {
                id: info.id || event.sessionId || "",
                parentId,
                agent: info.agent || props.agent || "",
                title: info.title || props.title || "Agent",
                directory: info.directory || props.directory || "",
                timeCreated: info.timeCreated || props.timeCreated || Date.now(),
              },
            });
          }
          break;
        }
        case "session.updated.1": {
          const sid = info.id || props.sessionID || "";
          if (sid) {
            write({ type: "subagent:updated", payload: { id: sid, title: info.title || props.title || "" } });
          }
          break;
        }
        case "session.idle": {
          const sid = props.sessionID || info.id || "";
          if (sid) write({ type: "subagent:idle", payload: { id: sid } });
          break;
        }
        case "session.deleted": {
          const sid = info.id || props.sessionID || "";
          if (sid) write({ type: "subagent:deleted", payload: { id: sid } });
          break;
        }
        default:
          break;
      }
    },
  };
};

export default OpenCodeClaw3d;
`;

  // Write plugin to opencode plugins directory
  const pluginDir = dirname(PLUGIN_DEST);
  if (!existsSync(pluginDir)) {
    mkdirSync(pluginDir, { recursive: true });
    log("CREATE", `~/.config/opencode/plugins/`);
  }

  writeFileSync(PLUGIN_DEST, pluginCode, "utf8");
  log("WRITE", `${pluginDir.replace(homedir(), "~")}/${PLUGIN_NAME}`);

  // Register in opencode.json if not already present
  if (existsSync(CONFIG_PATH)) {
    const raw = readFileSync(CONFIG_PATH, "utf8");
    const config = JSON.parse(raw);
    const pluginEntry = `file://${PLUGIN_DEST}`;

    if (!Array.isArray(config.plugin)) {
      config.plugin = [];
    }

    const alreadyInstalled = config.plugin.some((p) => String(p).includes(PLUGIN_NAME));
    if (!alreadyInstalled) {
      config.plugin.push(pluginEntry);
      writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf8");
      log("REGISTER", `Plugin added to opencode.json`);
    } else {
      log("OK", `Plugin already registered in opencode.json`);
    }
  } else {
    log("SKIP", "opencode.json not found — install plugin manually");
  }

  console.log("\n  ✓ Setup complete!\n");
  console.log("  Next steps:");
  console.log("    1. Run: npm run opencode-adapter    (start the gateway adapter)");
  console.log("    2. Open Claw3D, connect to ws://localhost:18790 as 'OpenCode' backend");
  console.log("    3. Start using OpenCode — subagents will appear in the 3D office\n");
}

main().catch((err) => {
  console.error("Setup failed:", err.message);
  process.exit(1);
});
```

- [ ] **Step 2: Verify the script runs**

Run: `node scripts/setup-opencode-adapter.mjs`

Expected: Reports writing plugin and registering in opencode.json.

---

### Task 5: Add npm Scripts

**Files:**
- Modify: `claw3d/package.json`

- [ ] **Step 1: Add scripts to package.json**

Read `claw3d/package.json`, find the `"scripts": {` section, and add:
```json
    "opencode-adapter": "node server/opencode-gateway-adapter.js",
    "setup:opencode": "node scripts/setup-opencode-adapter.mjs",
```

- [ ] **Step 2: Verify scripts are registered**

Run: `node -e "const p = require('./package.json'); console.log('opencode-adapter:', p.scripts['opencode-adapter']); console.log('setup:opencode:', p.scripts['setup:opencode']);"`

Expected: Both script commands print.

---

### Task 6: Add Runtime Profile

**Files:**
- Modify: `claw3d/docs/runtime-profiles.md`

- [ ] **Step 1: Add `opencode` to the runtime profiles doc**

Read and edit the file to add an `opencode` profile entry (following the existing profile pattern):

````markdown
### `opencode`

The bundled OpenCode subagent adapter over the gateway-shaped WebSocket flow.

This adapter visualizes OpenCode subagents (child sessions spawned via `task()`) as individual characters in the 3D office. Subagents appear with their session title as the agent name and their agent type (explore, Sisyphus-Junior, etc.) as the role label.

Requires:
- The adapter running: `npm run opencode-adapter`
- The plugin installed: `npm run setup:opencode`
- OpenCode to be running with the plugin active

Typical URL:
```text
ws://localhost:18790
```
````

- [ ] **Step 2: Find and add `opencode` to runtime type definitions**

Search for the runtime adapter type list (used in connection UI) and add `opencode`:
```bash
grep -rn "adapterType" src/ | head -20
grep -rn "demo\|hermes\|custom\|local" src/features/gateway/ --include="*.ts" --include="*.tsx" | grep -i "type\|enum\|profile" | head -20
```

Based on results, add `opencode` to the appropriate type/union.

---

### Task 7: Smoke Test End-to-End

- [ ] **Step 1: Verify adapter starts cleanly**

Run: `node server/opencode-gateway-adapter.js &
ADAPTER_PID=$!
sleep 2
curl -s http://localhost:18790 | head -1
kill $ADAPTER_PID 2>/dev/null; wait $ADAPTER_PID 2>/dev/null`

Expected: Prints "OpenCode Gateway Adapter for Claw3D"

- [ ] **Step 2: Verify WebSocket handshake**

```bash
node server/opencode-gateway-adapter.js &
sleep 2

node -e "
const { WebSocket } = require('ws');
const ws = new WebSocket('ws://localhost:18790');
ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === 'event' && msg.event === 'connect.challenge') {
    ws.send(JSON.stringify({type:'req',id:'c1',method:'connect',params:{}}));
  }
  if (msg.type === 'res' && msg.ok && msg.payload?.type === 'hello-ok') {
    console.log('PROTOCOL:', msg.payload.protocol);
    console.log('ADAPTER TYPE:', msg.payload.adapterType);
    console.log('FEATURES:', msg.payload.features?.methods?.length, 'methods');
    ws.close();
    process.exit(0);
  }
});
setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 3000);
"

kill %1 2>/dev/null; wait 2>/dev/null
```

Expected: `PROTOCOL: 3`, `ADAPTER TYPE: opencode`, `FEATURES: N methods`

---

### Task 8: Clean Up Stale Socket on Adapter Restart

- [ ] **Step 1: Ensure Unix socket file is cleaned up**

In `claw3d/server/opencode-gateway-adapter.js`, confirm the `startPluginSocket()` function removes stale socket before binding:
```js
function startPluginSocket() {
  try { fs.unlinkSync(SOCKET_PATH); } catch {}
  // ... rest of the function
}
```

This is already in Task 3 Step 2. Verify it's present.

---

### Self-Review Checklist

1. **Spec coverage:** Does the plan cover every requirement in the spec?
   - [x] Plugin (Task 2)
   - [x] Gateway adapter (Task 3)
   - [x] DB utility (Task 1)
   - [x] Setup script (Task 4)
   - [x] npm scripts (Task 5)
   - [x] Runtime profile (Task 6)

2. **Placeholder scan:** Any "TBD", "TODO", or missing code?
   - No — all steps have complete code.

3. **Type consistency:** Do method signatures, property names, and types stay consistent across tasks?
   - Yes — `sessionKeyFor`, `agentRegistry`, `broadcastEvent`, etc. are consistent.
