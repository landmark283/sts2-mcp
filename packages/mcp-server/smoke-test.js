"use strict";

const { spawn } = require("child_process");
const path = require("path");

const serverPath = path.join(__dirname, "index.js");
const child = spawn(process.execPath, [serverPath], {
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env
  }
});

let stdoutBuffer = "";
const pending = new Map();
let nextId = 1;

child.stderr.on("data", (chunk) => {
  process.stderr.write(chunk);
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

  const error = new Error(`MCP child exited before all responses arrived (code=${code}, signal=${signal})`);
  for (const [, reject] of pending.values()) {
    reject(error);
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

    const pendingEntry = pending.get(message.id);
    if (!pendingEntry) {
      continue;
    }

    pending.delete(message.id);
    pendingEntry.resolve(message);
  }
}

function sendMessage(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function sendRequest(method, params) {
  const id = nextId++;
  const message = {
    jsonrpc: "2.0",
    id,
    method,
    params
  };

  sendMessage(message);

  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });
}

function sendNotification(method, params) {
  sendMessage({
    jsonrpc: "2.0",
    method,
    params
  });
}

(async () => {
  const init = await sendRequest("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: {
      name: "sts2-smoke-test",
      version: "0.3.0"
    }
  });

  sendNotification("notifications/initialized", {});

  const list = await sendRequest("tools/list", {});
  const bridgeStatus = await sendRequest("tools/call", {
    name: "sts2_get_bridge_status",
    arguments: {}
  });
  const state = await sendRequest("tools/call", {
    name: "sts2_get_state",
    arguments: {}
  });
  const actions = await sendRequest("tools/call", {
    name: "sts2_list_actions",
    arguments: {}
  });

  console.log(
    JSON.stringify(
      {
        initialize: init,
        tools: list,
        bridgeStatus,
        state,
        actions
      },
      null,
      2
    )
  );
  child.kill();
})().catch((error) => {
  console.error(error);
  child.kill();
  process.exitCode = 1;
});
