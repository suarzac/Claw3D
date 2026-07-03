"use strict";

const { homedir } = require("node:os");
const { join } = require("node:path");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");

let dbSingleton = null;

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

function getChildSessions(limit = 50, windowMinutes = 60) {
  try {
    const cutoff = Date.now() - (windowMinutes * 60 * 1000);
    const rows = queryDb(
      `SELECT id, parent_id, agent, title, directory, time_created, time_updated, model
       FROM session
       WHERE parent_id IS NOT NULL
       AND time_created >= ${cutoff}
       ORDER BY time_created DESC
       LIMIT ${Number.isFinite(limit) ? Math.max(1, Math.min(500, limit)) : 50}`
    );
    return rows.map(normalizeSessionRow);
  } catch {
    return [];
  }
}

function getOrchestratorSession() {
  try {
    const rows = queryDb(
      `SELECT id, parent_id, agent, title, directory, time_created, time_updated, model
       FROM session
       WHERE (parent_id IS NULL OR parent_id = '')
       AND agent IS NOT NULL AND agent != ''
       ORDER BY time_created DESC
       LIMIT 1`
    );
    return rows.length > 0 ? normalizeSessionRow(rows[0]) : null;
  } catch {
    return null;
  }
}

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

function getOpenCodeModels() {
  try {
    const raw = fs.readFileSync(getConfigPath(), "utf8");
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

/**
 * Parse session.model JSON field into { provider, model }.
 * Model is stored as e.g. {"id":"deepseek-v4-flash","providerID":"opencode-go"}
 */
function parseModelField(raw) {
  if (!raw) return { provider: null, model: null };
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return {
      provider: parsed.providerID || null,
      model: parsed.id || null,
    };
  } catch {
    return { provider: null, model: null };
  }
}

/**
 * Allocate total cost proportionally across token types.
 */
function allocateCost(cost, input, output, cacheRead, cacheWrite) {
  const total = input + output + cacheRead + cacheWrite;
  if (total <= 0 || !cost) return { inputCost: 0, outputCost: 0, cacheReadCost: 0, cacheWriteCost: 0, totalCost: 0 };
  const c = Number(cost) || 0;
  return {
    inputCost: c * (input / total),
    outputCost: c * (output / total),
    cacheReadCost: c * (cacheRead / total),
    cacheWriteCost: c * (cacheWrite / total),
    totalCost: c,
  };
}

function toEpochMs(value, fallback) {
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) return new Date(value).getTime();
  return fallback;
}

/**
 * Query sessions with usage/cost data for the analytics dashboard.
 * Returns array of objects matching Claw3D's UsageSessionRow shape.
 */
function getSessionsUsage(startDate, endDate, limit) {
  try {
    const startMs = toEpochMs(startDate, Date.now() - 30 * 86400000);
    const endMs = toEpochMs(endDate, Date.now());
    const rowLimit = Number.isFinite(limit) ? Math.max(1, Math.min(1000, limit)) : 200;

    const rows = queryDb(
      `SELECT id, agent, title, model, cost,
              tokens_input, tokens_output, tokens_reasoning,
              tokens_cache_read, tokens_cache_write,
              time_created, time_updated
       FROM session
       WHERE time_created >= ${startMs}
       AND time_created <= ${endMs}
       ORDER BY time_created DESC
       LIMIT ${rowLimit}`
    );

    return rows.map(function(row) {
      const modelInfo = parseModelField(row.model);
      const input = Number(row.tokens_input) || 0;
      const output = Number(row.tokens_output) || 0;
      const cacheRead = Number(row.tokens_cache_read) || 0;
      const cacheWrite = Number(row.tokens_cache_write) || 0;
      const totalTokens = input + output + cacheRead + cacheWrite;
      const costs = allocateCost(row.cost, input, output, cacheRead, cacheWrite);

      return {
        key: row.id,
        label: row.title || null,
        agentId: row.agent || null,
        modelProvider: modelInfo.provider,
        model: modelInfo.model,
        origin: { provider: modelInfo.provider || "opencode" },
        channel: null,
        updatedAt: row.time_updated || row.time_created || null,
        usage: {
          input: input,
          output: output,
          cacheRead: cacheRead,
          cacheWrite: cacheWrite,
          totalTokens: totalTokens,
          inputCost: costs.inputCost,
          outputCost: costs.outputCost,
          cacheReadCost: costs.cacheReadCost,
          cacheWriteCost: costs.cacheWriteCost,
          totalCost: costs.totalCost,
          durationMs: 0,
        },
      };
    });
  } catch {
    return [];
  }
}

/**
 * Get daily cost breakdown for the analytics dashboard.
 * Returns array of { date, input, output, cacheRead, cacheWrite, totalTokens, inputCost, outputCost, ... }.
 */
function getUsageCost(startDate, endDate) {
  try {
    const startMs = toEpochMs(startDate, Date.now() - 30 * 86400000);
    const endMs = toEpochMs(endDate, Date.now());

    const rows = queryDb(
      `SELECT (time_created / 86400000) AS day_epoch,
              SUM(tokens_input) AS total_input,
              SUM(tokens_output) AS total_output,
              SUM(tokens_cache_read) AS total_cache_read,
              SUM(tokens_cache_write) AS total_cache_write,
              SUM(cost) AS total_cost
       FROM session
       WHERE time_created >= ${startMs}
       AND time_created <= ${endMs}
       GROUP BY day_epoch
       ORDER BY day_epoch ASC`
    );

    return rows.map(function(row) {
      const input = Number(row.total_input) || 0;
      const output = Number(row.total_output) || 0;
      const cacheRead = Number(row.total_cache_read) || 0;
      const cacheWrite = Number(row.total_cache_write) || 0;
      const totalTokens = input + output + cacheRead + cacheWrite;
      const costs = allocateCost(row.total_cost, input, output, cacheRead, cacheWrite);

      // Convert epoch day (days since Unix epoch) to YYYY-MM-DD
      const date = new Date(Number(row.day_epoch) * 86400000).toISOString().slice(0, 10);

      return {
        date: date,
        input: input,
        output: output,
        cacheRead: cacheRead,
        cacheWrite: cacheWrite,
        totalTokens: totalTokens,
        inputCost: costs.inputCost,
        outputCost: costs.outputCost,
        cacheReadCost: costs.cacheReadCost,
        cacheWriteCost: costs.cacheWriteCost,
        totalCost: costs.totalCost,
      };
    });
  } catch {
    return [];
  }
}

function queryDb(sql, params = []) {
  try {
    const Database = require("better-sqlite3");
    if (!dbSingleton) {
      dbSingleton = new Database(getDbPath(), { readonly: true, fileMustExist: true });
    }
    const stmt = dbSingleton.prepare(sql);
    return params.length > 0 ? stmt.all(...params) : stmt.all();
  } catch (dbErr) {
    // Fallback: use opencode CLI
    try {
      const sanitizedSql = sql.replace(/\s+/g, " ").trim();
      const args = ["db", sanitizedSql, "--format", "json"];
      const out = execFileSync("opencode", args, {
        encoding: "utf8",
        timeout: 10000,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const parsed = JSON.parse(out.trim());
      return Array.isArray(parsed) ? parsed : [];
    } catch (cliErr) {
      console.error("[opencode-db] queryDb failed: better-sqlite3:", dbErr.message, "| CLI fallback:", cliErr.message);
      return [];
    }
  }
}

module.exports = { getChildSessions, getOrchestratorSession, getSessionMessages, getOpenCodeModels, getSessionsUsage, getUsageCost, getDbPath, getConfigPath };
