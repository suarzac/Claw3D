#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PLUGIN_FILE = join(homedir(), ".config", "opencode", "plugins", "opencode-claw3d.js");
const CONFIG_PATH = join(homedir(), ".config", "opencode", "opencode.json");

function log(label, msg) {
  console.log("  " + label.padEnd(14) + msg);
}

async function main() {
  console.log("\n  OpenCode-Claw3D Adapter Setup\n");

  // Check plugin exists
  if (!existsSync(PLUGIN_FILE)) {
    log("MISSING", "Plugin not found at " + PLUGIN_FILE);
    log("", "Run Task 2 first or copy the plugin manually.");
    process.exit(1);
  }
  log("EXISTS", "Plugin at " + PLUGIN_FILE.replace(homedir(), "~"));

  // Register in opencode.json
  if (!existsSync(CONFIG_PATH)) {
    log("SKIP", "opencode.json not found at " + CONFIG_PATH);
    log("", "Install the plugin manually by adding to opencode.json plugin array:");
    log("", '  "file://' + PLUGIN_FILE + '"');
    process.exit(0);
  }

  const raw = readFileSync(CONFIG_PATH, "utf8");
  let config;
  try {
    config = JSON.parse(raw);
  } catch {
    log("ERROR", "Invalid JSON in " + CONFIG_PATH);
    process.exit(1);
  }

  if (!Array.isArray(config.plugin)) {
    config.plugin = [];
  }

  const pluginEntry = "file://" + PLUGIN_FILE;
  const alreadyInstalled = config.plugin.some(function(p) {
    return String(p).includes("opencode-claw3d");
  });

  if (alreadyInstalled) {
    log("OK", "Plugin already registered in opencode.json");
  } else {
    config.plugin.push(pluginEntry);
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf8");
    log("REGISTER", "Plugin added to opencode.json");
  }

  console.log("\n  " + "\u2713" + " Setup complete!\n");
  console.log("  Next steps:");
  console.log("    1. Run: npm run opencode-adapter");
  console.log("    2. Open Claw3D, connect to ws://localhost:18790 as 'OpenCode' backend");
  console.log("    3. Start using OpenCode — subagents will appear in the 3D office\n");
}

main().catch(function(err) {
  console.error("Setup failed:", err.message);
  process.exit(1);
});
