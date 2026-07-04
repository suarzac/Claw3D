# OpenCode Subagent Adapter for Claw3D

This adapter visualizes OpenCode subagents (child sessions spawned via `task()`) as characters in Claw3D's 3D office. It also provides analytics data from OpenCode's session database.

## Architecture

```
OpenCode Process
  ┌──────────────────────────────┐
  │  Plugin (opencode-claw3d.js) │  ← hooks event bus, connects via Unix socket
  └──────────────┬───────────────┘
                 │ Unix socket (~/.config/opencode/opencode-claw3d.sock)
┌────────────────▼────────────────┐
│  opencode-gateway-adapter.js     │  ← standalone WS server @ :18790
│  speaks Claw3D gateway protocol  │
└────────────────┬────────────────┘
                 │ WebSocket
┌────────────────▼────────────────┐
│  Claw3D browser                  │
│  "OpenCode" backend profile      │
└─────────────────────────────────┘
```

## Quick Start

```bash
# 1. Install/register the plugin (one-time)
npm run setup:opencode

# 2. Start the gateway adapter
npm run opencode-adapter

# 3. Start Claw3D dev server
npm run dev

# 4. Open http://localhost:3000/office
#    Select "OpenCode" backend
#    Connect to ws://localhost:18790
```

## Files

| File | Purpose |
|---|---|
| `~/.config/opencode/plugins/opencode-claw3d.js` | Plugin — hooks OpenCode event bus, forwards subagent lifecycle over Unix socket |
| `server/opencode-gateway-adapter.js` | Gateway adapter — WebSocket server @ :18790, Claw3D protocol, plugin RPCs |
| `server/lib/opencode-db.js` | DB utility — queries opencode.db for sessions, messages, analytics |
| `scripts/setup-opencode-adapter.mjs` | Setup script — installs plugin and registers in opencode.json |

## Components

### Plugin (opencode-claw3d.js)

An OpenCode plugin that connects to the adapter over a Unix socket. It:

- **Forwards events**: session.created → subagent:created, session.idle → subagent:idle, etc.
- **Handles RPCs**: `inject_message`, `create_session`, `prompt_session`, `delete_session`, `read_file`
- **Auto-reconnects**: retries every 2 seconds if the adapter socket is down
- **Guards against double-install**: uses `Symbol.for` singleton pattern

### Gateway Adapter (opencode-gateway-adapter.js)

A standalone Node.js WebSocket server that speaks the Claw3D gateway protocol. It:

- **WebSocket server** on port 18790 (configurable via `OPENCODE_ADAPTER_PORT`)
- **Unix socket server** at `~/.config/opencode/opencode-claw3d.sock`
- **Agent registry**: tracks subagents from plugin events + seeds from opencode.db
- **Idle eviction**: removes agents after 5 minutes of inactivity
- **Plugin RPCs**: `callPluginRpc()` — sends RPC commands to plugin, returns response
- **CLI fallbacks**: if plugin socket is disconnected, falls back to `opencode` CLI commands

### Gateway Protocol Methods

| Method | Implementation |
|---|---|
| `agents.list` | Lists orchestrator + subagents from registry |
| `agents.create` | Creates real child session via plugin RPC (fallback: local registry) |
| `agents.update` | Updates local agent registry |
| `agents.delete` | Deletes session via plugin RPC + cleans up registry |
| `chat.send` | Injects message into session via plugin RPC |
| `agent.wait` | Polls active runs for completion |
| `sessions.usage` | Returns per-session cost/tokens/model from opencode.db |
| `usage.cost` | Returns daily cost breakdown from opencode.db |
| `skills.status` | Returns workspace/managed skill directories |
| `skills.update/install/remove` | Stubs (use agents.create + chat.send for real install flow) |
| `models.list` | Reads models from opencode.json |
| `status` | Returns presence data for all tracked agents |

### Analytics Data

The adapter queries opencode.db directly (via better-sqlite3) for:

| Dashboard Widget | Data Source |
|---|---|
| Total Spend | `session.cost` (proportionally allocated to token types) |
| Token Usage | `session.tokens_input/output/cache_read/cache_write` |
| Top Agents | `session.agent` grouped with cost/token aggregates |
| Model Breakdown | `session.model` JSON parsed for provider + model ID |
| Daily Cost | `time_created / 86400000` grouped by day |
| Message Counts | `message` table — total, user, assistant, errors per session |
| Tool Calls | Not available — tool calls embedded in message parts |

## Troubleshooting

### "OpenCode plugin socket not connected"

**Cause**: The plugin hasn't connected to the adapter's Unix socket.

**Fix**:
1. Ensure `opencode web` or your OpenCode session is running with the plugin loaded
2. The plugin is registered in `~/.config/opencode/opencode.json` — verify the `plugin` array includes `file:///Users/suarzac-pro/.config/opencode/plugins/opencode-claw3d.js`
3. Restart OpenCode: `kill $(ps aux | grep "opencode web" | grep -v grep | awk '{print $2}')` then `opencode web --hostname 0.0.0.0`
4. Check the plugin log: `cat /tmp/opencode-web.log | grep "claw3d"`

### Plugin fails to connect (ENOENT on socket)

**Cause**: The plugin tried to connect before the adapter created the socket.

**Fix**: The plugin auto-reconnects every 2 seconds. If it's stuck, the plugin's error handler may not be triggering reconnection. Ensure the error handler calls `socket.destroy()` to trigger the `close` → reconnect path.

### No agents visible in the office

**Cause**: Eviction sweep removed agents with stale timestamps.

**Fix**: Agents loaded from the database need `updatedAt: Date.now()` (not the DB timestamp) so the eviction sweep doesn't remove them immediately. The orchestrator should have `status: "running"` to skip eviction entirely.

### Duplicate agents / too many old agents

**Cause**: Loading all child sessions from all time brings in stale agents.

**Fix**: The adapter only loads subagents from the last 60 minutes. Completed agents are evicted after 5 minutes of idle.

### Budget limits and alerts are local only

Budget limits (`dailySpendLimitUsd`, `monthlySpendLimitUsd`, `perAgentSoftLimitUsd`, `alertThresholdPct`) are stored as Studio preferences in the local settings file — they are not stored in OpenCode or enforced server-side. The analytics panel computes budget status from `totals.totalCost` vs stored limits. No adapter changes needed.

### Analytics shows 0 cost / 0 tokens

**Cause**: The CLI JSON fallback truncates at ~64KB, returning empty results.

**Fix**: Ensure `better-sqlite3` npm package is installed: `npm install --save better-sqlite3`. This lets the adapter read opencode.db directly without output limits.

### Analytics date filter doesn't work

**Cause**: The Claw3D UI sends dates as `"YYYY-MM-DD"` strings, but the adapter expected epoch ms numbers. Also, the end date was treated as midnight (start of day), excluding sessions from later that day.

**Fix**: Use `toEpochMs()` helper that parses string dates and adds 86400000ms for end dates (treating them as end-of-day).

### Can't access Claw3D from other devices on Tailscale

**Cause 1**: The dev server binds to `127.0.0.1` by default, only reachable locally.

**Fix**: Use Tailscale Serve to proxy HTTPS traffic to localhost:
```bash
/Applications/Tailscale.app/Contents/MacOS/Tailscale serve --bg --https 443 http://127.0.0.1:3000
```
Then access at `https://<hostname>.ts.net/` from any Tailscale device.

**Cause 2**: Next.js dev server breaks on non-localhost hosts (client chunks fail, HMR WebSocket broken).

**Fix**: Bind to `127.0.0.1` and use Tailscale Serve as the external-facing proxy. Do NOT set `HOST=0.0.0.0` or a Tailscale IP directly.

**Cause 3**: The `STUDIO_ACCESS_TOKEN` cookie must be set when binding to public hosts.

**Fix**: Don't set `STUDIO_ACCESS_TOKEN` when using Tailscale Serve — the server stays on localhost and the proxy handles external access.

### WebSocket connection fails from mobile

**Cause**: The gateway URL `ws://localhost:18790` resolves to the phone's localhost, not the dev machine.

**Fix**: Use the Tailscale IP for the adapter URL: `ws://100.72.89.47:18790` (your dev machine's Tailscale IP). The WebSocket connects through Tailscale directly to the adapter.

### Agent names show as "null"

**Cause**: Some OpenCode sessions have `NULL` in the `agent` column (created without an agent type).

**Fix**: The adapter defaults to `"subagent"` when `agent IS NULL`.

### Skills marketplace errors "Cannot read properties of undefined (reading 'trim')"

**Cause**: Claw3D's skill marketplace UI tries to parse `skill.skillKey.trim()` where `skillKey` is undefined. This is a pre-existing Claw3D UI bug when skills are returned with empty fields.

**Fix**: The adapter now returns complete skill status objects with `workspaceDir`, `managedSkillsDir`, and empty `skills` array.

### "Cannot read properties of undefined (reading 'map')" in task board

**Cause**: Pre-existing Claw3D bug in `useTaskBoardController.ts:530`. The `buildPlaybookCards` function receives `undefined` instead of an array from gateway cron data.

**Fix**: Upstream fix in commit `40be0d5` — pull the latest upstream changes.

### Adapter rate limit hit on gateway proxy

**Cause**: The `/api/task-store` endpoint polls aggressively through the WebSocket proxy, saturating the 120-frame burst cap.

**Fix**: The burst limit was increased from 120 to 500 in `server/gateway-proxy.js`.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `OPENCODE_ADAPTER_PORT` | `18790` | WebSocket port for the gateway adapter |
| `OPENCODE_CLAW3D_SOCKET` | `~/.config/opencode/opencode-claw3d.sock` | Unix socket path for plugin communication |
| `OPENCODE_DB_PATH` | `~/.local/share/opencode/opencode.db` | Override opencode.db path |
| `OPENCODE_CONFIG_PATH` | `~/.config/opencode/opencode.json` | Override opencode config path |
