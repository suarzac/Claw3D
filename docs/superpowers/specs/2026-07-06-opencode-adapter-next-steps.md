# OpenCode-Claw3D Adapter: Next Steps

**Date:** 2026-07-06
**Status:** Design spec + implementation plan

## Overview

Comprehensive roadmap for the OpenCode-Claw3D adapter covering polish of existing features (tool call tracking, analytics aggregation, budget alerts), new capabilities (session controls, skill installation, real-time agent state), and fixes for pre-existing Claw3D bugs.

---

# Part 1: Polish Existing Features

## 1.1 Tool Call Tracking in Analytics

### Problem
The analytics `sessions.usage` response has `messageCounts.toolCalls: 0` and no `toolUsage` field. Tool calls are not displayed in the analytics dashboard.

### Data Source
Tool calls are stored in the `event` table as `message.part.updated.1` events with `data.$.part.type = "tool"`. Each unique tool invocation has a `callID` and generates 2-3 event rows (pending → running → completed/error). The tool name is in `data.$.part.tool`, session ID in `data.$.sessionID`.

### Approach
Add `getToolUsage(sessionIds)` to `server/lib/opencode-db.js` that queries the event table:

```sql
SELECT
  json_extract(data, '$.sessionID') AS sid,
  json_extract(data, '$.part.tool') AS tool,
  COUNT(DISTINCT json_extract(data, '$.part.callID')) AS cnt
FROM event
WHERE json_extract(data, '$.part.type') = 'tool'
  AND json_extract(data, '$.sessionID') IN (?, ?, ...)
GROUP BY sid, tool
ORDER BY sid, cnt DESC;
```

### Deliverable
- `getToolUsage(sessionIds)` → `Map<sessionId, { totalCalls, tools: [{ name, count }] }>`
- Integration into `getSessionsUsage()` to populate `messageCounts.toolCalls` and add `usage.toolUsage`
- Use `better-sqlite3` batch query (same pattern as `getMessageCounts`)

### Files
- Modify: `server/lib/opencode-db.js` (~30 lines)

---

## 1.2 Per-Agent / Per-Model Analytics Aggregation

### Problem
The `sessions.usage` response returns raw session rows. The Claw3D analytics UI expects server-side aggregated `aggregates` or `byAgent`/`byModel` fields for the top-agents-by-spend and model-breakdown widgets. Currently these are computed client-side, which can be slow for large datasets.

### Approach
Add server-side aggregation to the `sessions.usage` handler:

```js
const byAgent = sessions.reduce((acc, s) => {
  const key = s.agentId || "unknown";
  if (!acc[key]) acc[key] = { agentId: key, sessionCount: 0, totals: zeroTotals() };
  acc[key].sessionCount++;
  addTotals(acc[key].totals, s.usage);
  return acc;
}, {});
```

Return these in the `aggregates` field:
```ts
{
  sessions: UsageSessionRow[],
  totals: UsageTotals,
  aggregates: {
    byAgent: UsageAgentAggregate[],
    byModel: UsageModelRecord[],
    daily: CostDailyRow[],
    tools: { totalCalls: number, tools: { name: string, count: number }[] },
    messages: { total: number, toolCalls: number, errors: number },
  }
}
```

### Deliverable
- Server-side aggregation of `byAgent`, `byModel`, `daily`, `tools`, `messages`
- Returned as `aggregates` in `sessions.usage` response
- Reduces client-side computation, enables running on large datasets

### Files
- Modify: `server/opencode-gateway-adapter.js` (~40 lines in `sessions.usage` handler)

---

## 1.3 Budget Alerts

### Problem
OpenCode has no budget table — `session.cost` is the only cost data. Budget limits (`dailySpendLimitUsd`, `monthlySpendLimitUsd`, `perAgentSoftLimitUsd`, `alertThresholdPct`) are stored as local Studio preferences in `StudioAnalyticsBudgetSettings`. There's no server-side enforcement or alerting.

### Approach
No code changes needed. The Claw3D UI already handles budget limits locally:
- Budget settings are persisted per-gateway in Studio settings
- The UI computes over/under budget from `totals.totalCost` vs the stored limits
- No server-side enforcement exists in the upstream Claw3D either

### Deliverable
- Document in `docs/opencode-adapter.md` that budget limits are local Studio preferences

---

# Part 2: New Capabilities

## 2.1 Session Controls from Claw3D

### Problem
Users can only passively view subagents. They cannot fork, abort, switch agents, or control sessions from Claw3D.

### SDK Methods Available
The plugin has access to `ctx.client.session` with these control methods:

| RPC | SDK Method | Parameters | Returns |
|-----|-----------|------------|---------|
| `fork_session` | `session.fork()` | `{ session_id, message_id?, directory? }` | New Session |
| `abort_session` | `session.abort()` | `{ session_id }` | boolean |
| `switch_agent` | `session.promptAsync()` with `agent` field | `{ session_id, agent }` | void |
| `switch_model` | `session.promptAsync()` with `model` field | `{ session_id, model, provider_id }` | void |
| `get_messages` | `session.messages()` | `{ session_id, limit? }` | Message[] |
| `get_children` | `session.children()` | `{ session_id }` | Session[] |
| `revert_message` | `session.revert()` | `{ session_id, message_id, part_id? }` | Session |
| `unrevert_session` | `session.unrevert()` | `{ session_id }` | Session |
| `execute_command` | `session.command()` | `{ session_id, command, arguments, agent? }` | result |
| `run_shell` | `session.shell()` | `{ session_id, command, agent, model? }` | Message |

### Approach
1. Add RPC handlers to `~/.config/opencode/plugins/opencode-claw3d.js` for each new method
2. Add gateway method handlers in `server/opencode-gateway-adapter.js` that call the plugin RPCs
3. No CLI fallback needed (these are OpenCode-specific operations)

**Agent/model switching** is done via `session.promptAsync()` with the `agent` or `model` field in the body — there is no dedicated `switchAgent()` SDK method. The switch emits `session.next.agent.switched.1` / `session.next.model.switched.1` events from the OpenCode runtime.

### Files
- Modify: `~/.config/opencode/plugins/opencode-claw3d.js` (~60 lines of new RPC cases)
- Modify: `server/opencode-gateway-adapter.js` (~30 lines of gateway method handlers)

---

## 2.2 Complete Skill Installation Flow

### Problem
The `skills.install` stub returns a redirect message instead of executing. The packaged skill install flow (via `installPackagedSkillViaGatewayAgent`) uses `agents.create` + `chat.send` + `agent.wait` — all of which are already implemented. The install flow should work but hasn't been tested end-to-end.

### Flow Map (already implemented)
| Step | RPC | Adapter Status |
|------|-----|----------------|
| Create installer agent | `agents.create` | ✅ Works |
| Apply tool overrides | `config.get` + `config.set` | ✅ Works (no-op) |
| Resolve main key | `agents.list` | ✅ Works |
| Send install message | `chat.send` | ✅ Works |
| Wait for agent | `agent.wait` | ✅ Works |
| Cleanup | `config.get` + `config.patch` | ✅ Works (no-op) |

### Approach
1. **Test end-to-end** — install a packaged skill (todo-board, task-manager, soundclaw) through the marketplace UI
2. If install fails, the most likely failure point is the installer subagent not writing files to the correct workspace path (the `read_file` RPC in the plugin uses `ctx.client.file.read()` which may fail)
3. **`skills.install` stub** — change redirect message to a clear explanation: "Skill dependencies cannot be installed on the OpenCode adapter. Use the packaged install flow (agents.create + chat.send)."

### Files
- No code changes needed unless testing reveals issues
- Potential fix: `server/lib/opencode-db.js` `readFile` RPC if workspace paths don't align

---

## 2.3 Real-Time Agent State Streaming

### Problem
Subagents appear as static characters. The 3D office doesn't show live activity — file edits, tool calls, thinking status.

### Available Event Data
The OpenCode event stream (via the plugin's `event` handler) provides:

| Event | Data Available | Streaming Use |
|-------|---------------|---------------|
| `message.part.updated.1` | `part.type` = "tool" / "text" / "reasoning" / "file" / "step-start" / "step-finish", tool name, callID, status | Show tool call in progress, thinking indicator |
| `message.updated.1` | Final message state | Clear activity indicator |
| `session.next.agent.switched.1` | New agent name | Update agent label |
| `session.next.model.switched.1` | Model provider/ID | Display model info |
| `session.idle` | — | Set agent to idle state |
| `session.created` | Session info | Add new agent |

### Part Type Activity Mapping

| `part.type` | 3D Office Display |
|-------------|------------------|
| `reasoning` | "Thinking..." indicator above agent |
| `tool` | Tool call badge with tool name (e.g., "🔧 bash") |
| `file` | File edit indicator |
| `text` | Chat message bubble |
| `step-start` | Activity pulse |
| `step-finish` | Brief completion flash |
| `patch` | File patch indicator |

### Approach
1. **Plugin enhancement**: Forward `message.part.updated.1` events to the adapter via the Unix socket as `subagent:activity` messages:

```js
// In plugin's event handler
case "message.part.updated.1": {
  const info = props.info || {};
  const part = info.part || {};
  if (part.type === "tool" || part.type === "reasoning" || part.type === "file") {
    writer.send({
      type: "subagent:activity",
      payload: {
        sessionId: info.sessionID || props.sessionID,
        activityType: part.type,        // "tool" | "reasoning" | "file"
        toolName: part.tool,            // for tool calls
        status: part.state?.status,     // "running" | "completed" | "error"
        callID: part.callID,
        timestamp: info.time || Date.now(),
      },
    });
  }
  break;
}
```

2. **Adapter enhancement**: Handle `subagent:activity` messages and expose the latest activity for each agent in the `agents.list` response or via a new `status` event.

3. **CLI fallback**: The adapter can poll the event table for recent activity events if the plugin disconnects, but the primary path is real-time via the plugin.

### Event Volume Consideration
The `message.part.updated.1` event fires for EVERY message part update, including text streaming (character-by-character in some cases). Rate-limiting is essential:

- Debounce `reasoning` events: only forward the first one per message
- Debounce `tool` events: only forward status transitions (running/completed)
- Ignore `text` parts (these are covered by `subagent:delta` which is already forwarded for chat)

### Files
- Modify: `~/.config/opencode/plugins/opencode-claw3d.js` (~20 lines in `mapEvent`)
- Modify: `server/opencode-gateway-adapter.js` (~20 lines in `handlePluginMessage`)

---

# Part 3: Fix Pre-Existing Claw3D Bugs

## 3.1 `buildPlaybookCards` Crash

### Problem
`useTaskBoardController.ts:530` calls `jobs.map()` where `jobs` is `undefined`. This happens when the gateway's `cron.list` returns malformed data or the response shape doesn't match expectations.

### Root Cause
The task board controller expects `cron.list` to return `{ jobs: [...] }`. If the response is missing the `jobs` field, or if the data is `undefined`, `.map()` throws.

### Current Status
✅ **Fixed** — Upstream commit `40be0d5` (pulled) added a guard:
```typescript
// After adding the guard, jobs is always an array
const jobs = result.jobs ?? [];
```
This change is already in our `opencode-adapter` branch (we rebased on upstream commits).

### Verification
Check that `useTaskBoardController.ts:647` has the nullish coalescing guard:
```typescript
const jobs = result.jobs ?? [];
```

---

## 3.2 Skill Marketplace `trim()` on Undefined

### Problem
`src/lib/skills/marketplace.ts:167` calls `skill.skillKey.trim().toLowerCase()` where `skill.skillKey` can be `undefined`. This throws `Cannot read properties of undefined (reading 'trim')`.

### Root Cause
The `buildFallbackMetadata` function receives a `SkillStatusEntry` where `skillKey` is undefined. This happens when the skills marketplace renders packaged skills from the catalog (todo-board, task-manager, soundclaw) that have hardcoded `SKILL_MARKETPLACE_OVERRIDES` but the base `SkillStatusEntry` is constructed with missing fields.

### Fix
```typescript
// marketplace.ts:167 — add nullish coalescing
const normalizedKey = (skill.skillKey ?? "").trim().toLowerCase();
```

Also fix line 204:
```typescript
const normalizedKey = (skill.skillKey ?? "").trim().toLowerCase();
```

### Files
- Modify: `src/lib/skills/marketplace.ts` (2 lines)

---

## 3.3 Other Known Issues

### 3.3.1 Pre-existing Lint Errors
AGENTS.md mentions "one pre-existing error (in `RetroOffice3D.tsx`)" — this is a lint/type error unrelated to our changes. No fix needed unless it causes functional issues.

### 3.3.2 Pre-existing Type Errors in Tests
AGENTS.md mentions "Pre-existing type errors exist in some test files (`agentChatPanel-*.test.ts`) due to a stale `onOpenSettings` prop." — test-only, no functional impact.

### 3.3.3 Pre-existing Test Failures
AGENTS.md mentions "A few pre-existing failures exist" in Vitest tests. Not investigated; test-only, no functional impact.

---

# Part 4: Implementation Plan

## Task Priority

| Priority | Task | Effort | Dependencies |
|----------|------|--------|-------------|
| P0 | 3.2 Skill marketplace trim() fix | 5 min | None |
| P1 | 1.1 Tool call tracking | 1 hr | None |
| P1 | 2.3 Real-time agent state | 1 hr | None |
| P2 | 1.2 Server-side aggregation | 30 min | Depends on 1.1 |
| P2 | 2.1 Session controls | 2 hrs | None |
| P3 | 2.2 Skill install E2E test | 1 hr | None |
| P3 | 1.3 Budget docs | 5 min | None |

## Task Breakdown

### Task A: Fix skill marketplace `trim()` bug

```typescript
// marketplace.ts line 167
const normalizedKey = (skill.skillKey ?? "").trim().toLowerCase();
// marketplace.ts line 204
const normalizedKey = (skill.skillKey ?? "").trim().toLowerCase();
```

### Task B: Implement `getToolUsage()`

**Files:** `server/lib/opencode-db.js`

Add function using `better-sqlite3` batch query (same pattern as `getMessageCounts`):
1. Accept `sessionIds: string[]`
2. Query event table with `json_extract` for tool parts
3. Return `Map<sessionId, { totalCalls, tools: [{ name, count }] }>`
4. Integrate into `getSessionsUsage()` to populate `messageCounts.toolCalls` and add `usage.toolUsage`

### Task C: Add real-time agent activity streaming

**Files:** `~/.config/opencode/plugins/opencode-claw3d.js`, `server/opencode-gateway-adapter.js`

1. Plugin: forward `message.part.updated.1` as `subagent:activity` for tool/reasoning/file parts
2. Adapter: store latest activity per agent, broadcast via presence events
3. Add rate-limiting: debounce reasoning (first per message), tool (status transitions only)

### Task D: Add server-side analytics aggregation

**Files:** `server/opencode-gateway-adapter.js`

In the `sessions.usage` handler, after fetching sessions:
1. Aggregate by agent: `byAgent[]` with session count, totals
2. Aggregate by model: `byModel[]` with count, totals
3. Aggregate tools: from `getToolUsage()` results
4. Return in `aggregates` field

### Task E: Implement session control RPCs

**Files:** `~/.config/opencode/plugins/opencode-claw3d.js`, `server/opencode-gateway-adapter.js`

1. Plugin: Add RPC handlers for `fork_session`, `abort_session`, `switch_agent`, `switch_model`, `get_messages`, `get_children`, `revert_message`, `unrevert_session`
2. Adapter: Add gateway method handlers that call plugin RPCs
3. CLI fallback: minimal (these are OpenCode-specific operations)

### Task F: Test skill installation end-to-end

1. Connect Claw3D with OpenCode backend
2. Install a marketplace skill (todo-board, task-manager, soundclaw)
3. Verify:
   - `agents.create` creates a real child session
   - `chat.send` injects the install message
   - `agent.wait` completes
   - Skill files appear in workspace

### Task G: Document budget limits

Add a note to `docs/opencode-adapter.md` that budget limits are local Studio preferences, not enforced server-side.
