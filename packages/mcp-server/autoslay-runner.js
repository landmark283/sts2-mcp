"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const serverPath = path.join(__dirname, "index.js");
const args = new Set(process.argv.slice(2));
const pollIntervalMs = 5000;
const timeoutMs = 90 * 60 * 1000;

let stdoutBuffer = "";
let nextId = 1;
const pending = new Map();

const child = spawn(process.execPath, [serverPath], {
  stdio: ["pipe", "pipe", "inherit"],
  env: {
    ...process.env
  }
});

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdoutBuffer += chunk;
  drainMessages();
});

child.on("exit", (code, signal) => {
  if (pending.size === 0) {
    return;
  }

  const error = new Error(
    `MCP child exited before all responses arrived (code=${code}, signal=${signal})`
  );
  for (const [, entry] of pending) {
    entry.reject(error);
  }
  pending.clear();
});

function parseMessages() {
  const messages = [];

  while (true) {
    const newlineIndex = stdoutBuffer.indexOf("\n");
    if (newlineIndex === -1) {
      return messages;
    }

    let line = stdoutBuffer.slice(0, newlineIndex);
    stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);

    if (line.endsWith("\r")) {
      line = line.slice(0, -1);
    }

    if (!line.trim()) {
      continue;
    }

    messages.push(JSON.parse(line));
  }
}

function drainMessages() {
  for (const message of parseMessages()) {
    if (!Object.prototype.hasOwnProperty.call(message, "id")) {
      continue;
    }

    const entry = pending.get(message.id);
    if (!entry) {
      continue;
    }

    pending.delete(message.id);
    entry.resolve(message);
  }
}

function sendMessage(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function sendRequest(method, params) {
  const id = nextId++;
  sendMessage({
    jsonrpc: "2.0",
    id,
    method,
    params
  });

  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });
}

async function initialize() {
  await sendRequest("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: {
      name: "sts2-autoslay-runner",
      version: "0.3.0"
    }
  });

  sendMessage({
    jsonrpc: "2.0",
    method: "notifications/initialized",
    params: {}
  });
}

async function callTool(name, argumentsObject) {
  const message = await sendRequest("tools/call", {
    name,
    arguments: argumentsObject
  });

  if (message.error) {
    throw new Error(`Tool call failed for ${name}: ${message.error.message}`);
  }

  const result = message.result;
  if (!result || !Array.isArray(result.content) || result.content.length === 0) {
    throw new Error(`Tool ${name} returned no content.`);
  }

  const textItem = result.content.find((item) => item.type === "text");
  if (!textItem || typeof textItem.text !== "string") {
    throw new Error(`Tool ${name} returned no text content.`);
  }

  const payload = JSON.parse(textItem.text);
  if (result.isError) {
    const errorMessage =
      payload && typeof payload.message === "string"
        ? payload.message
        : `Tool ${name} returned an error result.`;
    const error = new Error(errorMessage);
    error.payload = payload;
    throw error;
  }

  return payload;
}

async function getState() {
  return await callTool("sts2_get_state", {});
}

async function performAction(actionId, stateVersion) {
  return await callTool("sts2_perform_action", {
    action_id: actionId,
    expected_state_version: stateVersion,
    wait_after_ms: 1500
  });
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function summarizeState(state) {
  const player = Array.isArray(state.players) && state.players.length > 0 ? state.players[0] : null;
  const hp = player && player.creature ? `${player.creature.current_hp}/${player.creature.max_hp}` : "-";

  return {
    screen: state.screen,
    game_over: state.run && state.run.is_game_over === true,
    total_floor: state.run ? state.run.total_floor : null,
    current_location: state.run ? state.run.current_location : null,
    autoslay_active:
      state.automation &&
      state.automation.autoslay &&
      state.automation.autoslay.active === true,
    hp,
    action_count: Array.isArray(state.available_actions) ? state.available_actions.length : 0,
    watchdog:
      state.automation &&
      state.automation.autoslay &&
      typeof state.automation.autoslay.watchdog_dump === "string"
        ? state.automation.autoslay.watchdog_dump
            .split(/\r?\n/)
            .filter(Boolean)
            .slice(0, 4)
            .join(" | ")
        : null
  };
}

function printSummary(prefix, state) {
  const summary = summarizeState(state);
  console.log(
    JSON.stringify(
      {
        prefix,
        at: new Date().toISOString(),
        ...summary
      },
      null,
      2
    )
  );
}

function hasAction(state, actionId) {
  return (
    Array.isArray(state.available_actions) &&
    state.available_actions.some((action) => action && action.action_id === actionId)
  );
}

async function ensureAutoSlayStarted() {
  let state = await getState();
  printSummary("initial", state);

  if (args.has("--fresh-run") && hasAction(state, "main_menu:continue")) {
    if (!hasAction(state, "main_menu:abandon_current_game")) {
      throw new Error("Current save exists, but abandon_current_game is not available.");
    }

    console.log("Abandoning current run before starting AutoSlay.");
    let result = await performAction("main_menu:abandon_current_game", state.state_version);
    state = result.state;

    if (hasAction(state, "main_menu:confirm_abandon_run")) {
      result = await performAction("main_menu:confirm_abandon_run", state.state_version);
      state = result.state;
    } else {
      throw new Error("Abandon confirmation did not appear.");
    }
  }

  if (hasAction(state, "automation:start_autoslay")) {
    console.log("Starting AutoSlay.");
    const result = await performAction("automation:start_autoslay", state.state_version);
    state = result.state;
    printSummary("autoslay_started", state);
  } else if (
    state.automation &&
    state.automation.autoslay &&
    state.automation.autoslay.active === true
  ) {
    console.log("AutoSlay is already active.");
  } else {
    throw new Error("automation:start_autoslay is not available.");
  }
}

async function monitorUntilTerminal() {
  const startedAt = Date.now();
  let lastStateHash = null;
  let consecutiveErrors = 0;
  let lastLogFilePath = null;

  while (Date.now() - startedAt < timeoutMs) {
    await sleep(pollIntervalMs);

    let state;
    try {
      state = await getState();
      consecutiveErrors = 0;
    } catch (error) {
      consecutiveErrors += 1;
      console.error(
        `[monitor] get_state failed (${consecutiveErrors}): ${error.message}`
      );

      if (error.payload) {
        console.error(JSON.stringify(error.payload, null, 2));
      }

      const logOutcome = classifyAutoSlayOutcome(lastLogFilePath);
      if (logOutcome === "victory") {
        console.log(
          JSON.stringify(
            {
              prefix: "terminal_victory_from_log",
              at: new Date().toISOString(),
              log_file_path: lastLogFilePath
            },
            null,
            2
          )
        );
        return;
      }

      if (consecutiveErrors >= 6) {
        throw new Error("Too many consecutive get_state failures.");
      }

      continue;
    }

    if (state.state_hash !== lastStateHash) {
      printSummary("update", state);
      lastStateHash = state.state_hash;
    }

    lastLogFilePath =
      state.automation &&
      state.automation.autoslay &&
      typeof state.automation.autoslay.log_file_path === "string"
        ? state.automation.autoslay.log_file_path
        : lastLogFilePath;

    const logOutcome = classifyAutoSlayOutcome(lastLogFilePath);

    if (state.run && state.run.is_game_over === true) {
      if (logOutcome === "victory") {
        printSummary("terminal_victory", state);
        return;
      }

      if (logOutcome === "failure") {
        printSummary("terminal_game_over", state);
        return;
      }
    }

    if (
      state.automation &&
      state.automation.autoslay &&
      state.automation.autoslay.active === false
    ) {
      if (logOutcome === "victory") {
        printSummary("terminal_victory", state);
        return;
      }

      printSummary("terminal_autoslay_inactive", state);
      return;
    }
  }

  throw new Error("Timed out waiting for AutoSlay to reach a terminal state.");
}

function classifyAutoSlayOutcome(logFilePath) {
  const logTail = readAutoSlayLogTail(logFilePath, 40);
  if (!logTail) {
    return null;
  }

  if (
    logTail.includes("Run completed successfully") ||
    logTail.includes("Victory! Run completed and returned to main menu")
  ) {
    return "victory";
  }

  if (
    logTail.includes("Run failed") ||
    logTail.includes("Defeat") ||
    logTail.includes("Game over")
  ) {
    return "failure";
  }

  return null;
}

function readAutoSlayLogTail(logFilePath, lineCount) {
  if (!logFilePath || !fs.existsSync(logFilePath)) {
    return null;
  }

  const text = fs.readFileSync(logFilePath, "utf8");
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-lineCount)
    .join("\n");
}

(async () => {
  await initialize();

  if (!args.has("--monitor-only")) {
    await ensureAutoSlayStarted();
  }

  await monitorUntilTerminal();
})()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    child.kill();
  });
