# OpenCode Subagent Adapter for Claw3D

**Date:** 2026-07-03
**Status:** Design spec

## Overview

An adapter that visualizes OpenCode subagents as characters in Claw3D's 3D office. Each OpenCode child session (spawned via `task()`) appears as its own agent in the office with name, role label, and conversation history.

## Architecture

```
┌─────────────────────────────────────────────┐
│              OpenCode Process                 │
│  ┌────────────────────────────────────────┐  │
│  │  Plugin: opencode-claw3d.js             │  │
│  │  Hooks event bus, forwards lifecycle    │  │
│  │  events over Unix socket. Handles       │  │
│  │  inject_message RPC for chat.send.      │  │
│  └──────────────┬─────────────────────────┘  │
│                 │ Unix socket                 │
│                 │ ~/.config/opencode/         │
│                 │ opencode-claw3d.sock        │
└─────────────────┼────────────────────────────┘
                  │
┌─────────────────▼────────────────────────────┐
│  opencode-gateway-adapter.js                  │
│  standalone Node.js WebSocket server          │
│                                               │
│  • WS server @ ws://localhost:18790           │
│  • Connects to plugin via Unix socket         │
│  • Queries opencode.db on startup             │
│  • Speaks Claw3D gateway protocol             │
│  • Routes chat.send ←→ plugin RPC            │
│                                               │
└─────────────────┬────────────────────────────┘
                  │ WebSocket (Claw3D protocol)
┌─────────────────▼────────────────────────────┐
│  Claw3D browser (via Studio proxy)            │
│  "OpenCode" backend profile                   │
└──────────────────────────────────────────────┘
```

## Data Flow

### Subagent Discovery (real-time)
1. OpenCode spawns a subagent via `task()` → creates child session with `parent_id`
2. Plugin receives `session.created` event → checks for `parent_id`
3. Plugin writes `subagent:created` to Unix socket
4. Adapter adds entry to agent registry
5. Next time Claw3D requests `agents.list` or gets `presence` event → subagent appears in office

### Subagent Discovery (startup)
1. On boot, adapter queries `opencode.db`: `SELECT * FROM session WHERE parent_id IS NOT NULL ORDER BY time_created DESC LIMIT 50`
2. Seeds agent registry with recent child sessions

### Chat Flow (Claw3D → Subagent)
1. User sends message in Claw3D chat panel
2. Claw3D sends `chat.send` via WebSocket
3. Adapter writes `inject_message` JSON to Unix socket
4. Plugin calls `ctx.client.session.promptAsync({path: {id: sessionId}, body: {parts: [{type: "text", text: message}], agent: agentType}})`
5. OpenCode processes the message naturally
6. Plugin receives `message.part.updated` → forwards delta to adapter
7. Adapter forwards as `chat` event to Claw3D

### Chat Flow (Subagent → Claw3D, passive observation)
1. Subagent sends message deltas while working
2. Plugin forwards all deltas to adapter
3. Adapter forwards as `chat` events to Claw3D
4. Claw3D renders in the agent's chat panel

## Component Details

### 1. OpenCode Plugin

**File:** `~/.config/opencode/plugins/opencode-claw3d.js`
**Pattern:** Follows `cmux-session.js` / `cmux-feed.js` event hook shape.

#### Exports
```js
export const OpenCodeClaw3d = async (ctx) => { ... }
export default OpenCodeClaw3d
```

#### Event → Socket Mappings

| OpenCode Event | Socket Message | Payload |
|---|---|---|
| `session.created` + has parent_id | `subagent:created` | `{id, parentId, agent, title, directory, timeCreated}` |
| `session.updated` | `subagent:updated` | `{id, title}` |
| `message.updated` | `subagent:message` | `{sessionId, role, content, timeCreated}` |
| `message.part.updated` (text delta, assistant) | `subagent:delta` | `{sessionId, text, messageId}` |
| `session.idle` | `subagent:idle` | `{sessionId}` |
| `session.deleted` | `subagent:deleted` | `{sessionId}` |

#### RPC Handlers (Adapter → Plugin)

| RPC Command | Implementation |
|---|---|
| `inject_message` | Calls `ctx.client.session.promptAsync()` to inject user message into target session |
| `ping` | Responds `pong` |

#### Socket Protocol
- Unix domain socket: `~/.config/opencode/opencode-claw3d.sock`
- Plugin connects as a **client** to the adapter's socket
- JSON-line protocol (newline-delimited JSON messages, same as cmux)
- Plugin sends event pushes; receives RPC commands from adapter

### 2. Gateway Adapter

**File:** `claw3d/server/opencode-gateway-adapter.js`
**Pattern:** Clone of `demo-gateway-adapter.js` — same WebSocket server, same `handleMethod()` switch shape.

#### Instance State

```js
const agentRegistry = new Map();  // sessionId → AgentInfo
// AgentInfo: { id, name, role, workspace, status, updatedAt, parentId }

const conversationHistory = new Map();  // sessionKey → messages[]
const activeSendEventFns = new Set();   // connected WS clients
const activeRuns = new Map();           // runId → abort handle
```

#### Agent Info Shape

```js
{
  id: "ses_abc123",           // OpenCode session ID
  name: "Explore OpenCode server model",  // session title
  role: "explore",             // agent column value
  workspace: "/Users/.../claw3d",  // session directory
  identity: { name, emoji: "🤖" },
  status: "idle" | "running",  // derived from session idle/active
  updatedAt: timestamp,
  parentId: "ses_parent123"    // links to orchestrator
}
```

#### Gateway Method Handlers

| Method | Implementation |
|---|---|
| `connect` | Returns `hello-ok`, protocol 3, `adapterType: "opencode"`, features list with supported methods/events |
| `agents.list` | Returns `{defaultId, mainKey, agents: [...agentRegistry.values()]}` |
| `sessions.list` | Returns sessions per agent from `conversationHistory` |
| `sessions.preview` | Returns recent N messages per session key |
| `sessions.patch` | Stub — no-op, returns ok |
| `sessions.reset` | Clears conversation history for a session key |
| `chat.send` | Forwards `inject_message` to plugin socket; returns `{status: "started", runId}` |
| `chat.history` | Returns messages from `conversationHistory` for a session key |
| `chat.abort` | No-op (OpenCode manages abort natively) |
| `agent.wait` | Polls activeRuns for completion |
| `status` | Returns presence: recent sessions + by-agent grouping |
| `config.get` | Returns stub config |
| `models.list` | Reads models from `~/.config/opencode/opencode.json` |
| `skills.status` | Returns empty list |
| `wake` | No-op, returns ok |

#### Startup Sequence

1. Create Unix socket at `~/.config/opencode/opencode-claw3d.sock`
2. Query `opencode.db` for sessions: `SELECT id, parent_id, agent, title, directory, time_created FROM session WHERE parent_id IS NOT NULL ORDER BY time_created DESC LIMIT 50`
3. Seed `agentRegistry` with results
4. Read `~/.config/opencode/opencode.json` for available models
5. Start WebSocket server on port 18790
6. Listen for plugin connections on Unix socket

#### Plugin Connection Management

- Adapter is the Unix socket **server** (plugin connects to it)
- If plugin disconnects (OpenCode restart), adapter keeps running with last-known state
- Adapter uses `fs.watch` or timer to retry socket acceptance
- On reconnect, plugin re-sends current state

### 3. OpenCode DB Integration

**File:** `claw3d/server/lib/opencode-db.js`

Utility module wrapping SQLite queries against `opencode.db`.

```js
// Query sessions with parent_id
async function getChildSessions(limit = 50) { ... }

// Query messages for a session
async function getSessionMessages(sessionId, limit = 20) { ... }

// Get OpenCode config (models)
async function getOpenCodeConfig() { ... }

// Get OpenCode DB path
function getDbPath() {
  return process.env.OPENCODE_DB_PATH
    || path.join(os.homedir(), ".local/share/opencode/opencode.db");
}
```

### 4. Setup Script

**File:** `scripts/setup-opencode-adapter.mjs`

```bash
node scripts/setup-opencode-adapter.mjs
```

Does:
1. Writes `opencode-claw3d.js` plugin to `~/.config/opencode/plugins/`
2. Adds plugin to `~/.config/opencode/opencode.json` `plugin` array if not present
3. Prints success message with instructions

### 5. npm Scripts Addition

In `claw3d/package.json`:

```json
{
  "opencode-adapter": "node server/opencode-gateway-adapter.js",
  "setup:opencode": "node scripts/setup-opencode-adapter.mjs"
}
```

### 6. Runtime Profile

Add `opencode` to the runtime profiles so users can select "OpenCode" from the Claw3D connection screen.

**Files to modify:**
- `docs/runtime-profiles.md` — document the new profile
- `src/features/...` (wherever runtime types are defined) — add `opencode` to the enum/type

## Claw3D Gateway Protocol (reference)

For reference, the protocol spoken on `ws://localhost:18790`:

### Handshake
```
→ {"type":"req","id":"1","method":"connect","params":{"auth":{"token":"..."},"client":{"id":"webchat-ui","mode":"multi","version":"3"}}}
← {"type":"res","id":"1","ok":true,"payload":{"type":"hello-ok","protocol":3,"adapterType":"opencode","features":{"methods":["agents.list",...],"events":["chat","presence","heartbeat"]},"snapshot":{"health":{"agents":[...],"defaultAgentId":"..."},"sessionDefaults":{"mainKey":"main"}},"auth":{"role":"operator","scopes":["operator.admin"]},"policy":{"tickIntervalMs":30000}}}
```

### Request/Response
```
→ {"type":"req","id":"2","method":"agents.list","params":{}}
← {"type":"res","id":"2","ok":true,"payload":{"defaultId":"ses_main","mainKey":"main","agents":[...]}}
```

### Push Events
```
← {"type":"event","event":"presence","payload":{"sessions":{"recent":[...],"byAgent":[...]}}}
← {"type":"event","event":"chat","seq":0,"payload":{"runId":"...","sessionKey":"agent:ses_abc:main","state":"delta","message":{"role":"assistant","content":"..."}}}
```

## File Checklist

| File | Purpose | Est. LOC |
|---|---|---|
| `~/.config/opencode/plugins/opencode-claw3d.js` | Plugin — hooks event bus, Unix socket client | ~100 |
| `claw3d/server/opencode-gateway-adapter.js` | Gateway adapter — WebSocket server, protocol impl | ~400 |
| `claw3d/server/lib/opencode-db.js` | SQLite utility for opencode.db queries | ~50 |
| `scripts/setup-opencode-adapter.mjs` | One-time setup script | ~60 |
| Modifications to `claw3d/package.json` | `opencode-adapter` + `setup:opencode` scripts | ~5 lines |
| Documentation updates | `docs/runtime-profiles.md` | ~10 lines |

## Edge Cases & Considerations

1. **Plugin unavailable:** If plugin disconnects, adapter continues with last-known agent state. Chat.send returns error until reconnection.
2. **No OpenCode running:** Adapter starts but has no agents. Shows empty office. Graceful.
3. **Multiple OpenCode processes:** Only the one with the plugin installed and running will connect. The adapter tracks a single source.
4. **Port conflict:** Port 18790 may be in use. Falls back to env var `OPENCODE_ADAPTER_PORT`.
5. **DB busy:** SQLite may be locked by running OpenCode. Use WAL mode or retry with backoff.
6. **Session agent column is null:** Agents might not have a type set. Use "subagent" as fallback label.
7. **Very long session titles:** Truncate to 40 chars for agent name display.
8. **Rapid subagent spawn/complete:** Batch presence events within a short window (debounce 200ms) to avoid flooding.

## Future Considerations

- Agent emoji/avatar based on subagent type (🔍 for explore, 👷 for build, etc.)
- Ability to spawn new subagents directly from the 3D office
- Show subagent workspace file activity in the office
- Retro 3D office agent movement based on agent status
