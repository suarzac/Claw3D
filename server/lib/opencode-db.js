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

function getChildSessions(limit = 50) {
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

module.exports = { getChildSessions, getSessionMessages, getOpenCodeModels, getDbPath, getConfigPath };
