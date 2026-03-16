"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { setTimeout: delay } = require("timers/promises");

const SERVER_NAME = "sts2";
const SERVER_VERSION = "0.4.5";
const FALLBACK_PROTOCOL_VERSION = "2025-03-26";
const DEFAULT_LOG_FILE_NAME = "mcp-stdio.log";
const MAX_LOG_PREVIEW = 600;
const DEFAULT_HTTP_TIMEOUT_MS = 10000;
const DEFAULT_ACTION_WAIT_MS = 1200;
const MAX_ACTION_WAIT_MS = 5000;
const DEFAULT_WAIT_TIMEOUT_MS = 20000;
const MAX_WAIT_TIMEOUT_MS = 120000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const MIN_POLL_INTERVAL_MS = 100;
const MAX_POLL_INTERVAL_MS = 2000;
const END_TURN_SETTLE_TIMEOUT_MS = 8000;
const END_TURN_SETTLE_POLL_INTERVAL_MS = 200;
const END_TURN_STABLE_POLL_TARGET = 6;
const COMBAT_ACTION_SETTLE_TIMEOUT_MS = 5000;
const COMBAT_ACTION_SETTLE_POLL_INTERVAL_MS = 200;
const COMBAT_ACTION_STABLE_POLL_TARGET = 2;
const ROOM_EXIT_SETTLE_TIMEOUT_MS = 5000;
const ROOM_EXIT_SETTLE_POLL_INTERVAL_MS = 200;

const TOOL_DEFINITIONS = [
  {
    name: "sts2_get_bridge_status",
    description:
      "Read the Slay the Spire 2 bridge session file and verify the current /health endpoint.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: "sts2_get_state",
    description:
      "Fetch the current visible bridge state, including screen, combat state, map state, rewards, and legal actions.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: "sts2_list_actions",
    description:
      "Fetch the currently legal bridge actions without repeating the full state payload.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: "sts2_perform_action",
    description:
      "Execute one currently legal bridge action by action_id and return the resulting state snapshot.",
    inputSchema: {
      type: "object",
      properties: {
        action_id: {
          type: "string",
          minLength: 1
        },
        expected_state_version: {
          type: "integer"
        },
        wait_after_ms: {
          type: "integer",
          minimum: 0,
          maximum: MAX_ACTION_WAIT_MS
        }
      },
      required: ["action_id"],
      additionalProperties: false
    }
  },
  {
    name: "sts2_end_turn",
    description:
      "Convenience wrapper around sts2_perform_action for the combat end_turn action.",
    inputSchema: {
      type: "object",
      properties: {
        expected_state_version: {
          type: "integer"
        },
        wait_after_ms: {
          type: "integer",
          minimum: 0,
          maximum: MAX_ACTION_WAIT_MS
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "sts2_resolve_room_rewards",
    description:
      "Inspect the current room-end rewards, optionally choose one card reward by index, claim safe rewards, and auto-advance through reward/proceed cleanup when possible.",
    inputSchema: {
      type: "object",
      properties: {
        pick_card_index: {
          type: "integer",
          minimum: 0
        },
        skip_card_reward: {
          type: "boolean"
        },
        take_potions: {
          type: "boolean"
        },
        auto_proceed: {
          type: "boolean"
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "sts2_resolve_rest_site",
    description:
      "Resolve a campfire in one tool call: choose rest/smith, optionally choose a smith upgrade target, then auto-advance back to the map when possible.",
    inputSchema: {
      type: "object",
      properties: {
        option_index: {
          type: "integer",
          minimum: 0
        },
        upgrade_card_index: {
          type: "integer",
          minimum: 0
        },
        auto_proceed: {
          type: "boolean"
        }
      },
      required: ["option_index"],
      additionalProperties: false
    }
  },
  {
    name: "sts2_resolve_card_selection",
    description:
      "Resolve the currently visible card-selection flow in one tool call: optionally choose one or more current option indices, then confirm/cancel/skip/close without one MCP request per selected card.",
    inputSchema: {
      type: "object",
      properties: {
        select_indices: {
          type: "array",
          items: {
            type: "integer",
            minimum: 0
          }
        },
        terminal_action: {
          type: "string",
          enum: ["confirm", "cancel", "skip", "close", "none"]
        },
        expected_min_select: {
          type: "integer",
          minimum: 0
        },
        expected_max_select: {
          type: "integer",
          minimum: 0
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "sts2_wait_for_change",
    description:
      "Poll the bridge until the state_version or state_hash changes from a known baseline.",
    inputSchema: {
      type: "object",
      properties: {
        baseline_state_version: {
          type: "integer"
        },
        baseline_state_hash: {
          type: "string"
        },
        timeout_ms: {
          type: "integer",
          minimum: 1,
          maximum: MAX_WAIT_TIMEOUT_MS
        },
        poll_interval_ms: {
          type: "integer",
          minimum: MIN_POLL_INTERVAL_MS,
          maximum: MAX_POLL_INTERVAL_MS
        }
      },
      additionalProperties: false
    }
  }
];

let incomingTextBuffer = "";
let processingChain = Promise.resolve();
let loggedFirstStdinChunk = false;

logInfo(
  `process started pid=${process.pid} node=${process.version} cwd=${process.cwd()}`
);
logDebug(`argv=${safeJson(process.argv)}`);
logDebug(`session_file_path=${getSessionFilePath()}`);
logDebug(`log_file_path=${getLogFilePath()}`);
logDebug("transport=stdio newline-delimited json-rpc");

process.stdin.setEncoding("utf8");

process.stdin.on("data", (chunk) => {
  if (!chunk) {
    return;
  }

  const chunkSize = Buffer.byteLength(chunk, "utf8");
  if (!loggedFirstStdinChunk) {
    logDebug(`first_stdin_chunk_bytes=${chunkSize}`);
    logDebug(`first_stdin_chunk_preview=${sanitizeForLog(chunk)}`);
    loggedFirstStdinChunk = true;
  } else {
    logDebug(`stdin_chunk_bytes=${chunkSize}`);
  }

  incomingTextBuffer += chunk;
  processingChain = processingChain
    .then(() => processIncomingMessages())
    .catch((error) => {
      logError("failed to process incoming MCP message", error);
    });
});

process.stdin.on("end", () => {
  logInfo("stdin ended");
  process.exit(0);
});

process.stdin.on("error", (error) => {
  logError("stdin error", error);
});

process.on("uncaughtException", (error) => {
  logError("uncaught exception", error);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logError("unhandled rejection", reason);
  process.exit(1);
});

async function processIncomingMessages() {
  while (true) {
    const newlineIndex = incomingTextBuffer.indexOf("\n");
    if (newlineIndex === -1) {
      return;
    }

    let rawLine = incomingTextBuffer.slice(0, newlineIndex);
    incomingTextBuffer = incomingTextBuffer.slice(newlineIndex + 1);

    if (rawLine.endsWith("\r")) {
      rawLine = rawLine.slice(0, -1);
    }

    if (!rawLine.trim()) {
      continue;
    }

    logDebug(`stdin_line=${sanitizeForLog(rawLine)}`);

    let message;
    try {
      message = JSON.parse(rawLine);
    } catch (error) {
      logError("failed to parse MCP JSON payload", error);
      continue;
    }

    if (Array.isArray(message)) {
      logDebug(`parsed_json_batch length=${message.length}`);
      for (const item of message) {
        await handleMessage(item);
      }
      continue;
    }

    await handleMessage(message);
  }
}

async function handleMessage(message) {
  if (!message || typeof message !== "object") {
    logDebug("ignoring non-object MCP message");
    return;
  }

  const hasId = Object.prototype.hasOwnProperty.call(message, "id");
  const method =
    typeof message.method === "string" && message.method.length > 0 ? message.method : null;

  if (!hasId) {
    if (method) {
      logDebug(`received_notification method=${method}`);
    } else {
      logDebug("received message without id or method; ignoring");
    }
    return;
  }

  if (!method) {
    logDebug(`received message without method id=${safeJson(message.id)}; ignoring`);
    return;
  }

  logDebug(`received_request method=${method} id=${safeJson(message.id)}`);

  try {
    switch (method) {
      case "initialize":
        return writeResult(message.id, {
          protocolVersion:
            message.params && typeof message.params.protocolVersion === "string"
              ? message.params.protocolVersion
              : FALLBACK_PROTOCOL_VERSION,
          capabilities: {
            tools: {
              listChanged: false
            }
          },
          serverInfo: {
            name: SERVER_NAME,
            version: SERVER_VERSION
          },
          instructions:
            "Use sts2_get_state and sts2_list_actions to observe the game, then sts2_perform_action or sts2_end_turn to execute only legal actions."
        });
      case "ping":
        return writeResult(message.id, {});
      case "tools/list":
        return writeResult(message.id, {
          tools: TOOL_DEFINITIONS
        });
      case "tools/call":
        return writeResult(message.id, await handleToolCall(message.params || {}));
      default:
        return writeError(message.id, -32601, `Method not found: ${method}`);
    }
  } catch (error) {
    logError(`request failed for method ${method}`, error);
    return writeError(message.id, -32603, error instanceof Error ? error.message : String(error));
  }
}

async function handleToolCall(params) {
  const toolName = typeof params.name === "string" ? params.name : "";
  const args = isPlainObject(params.arguments) ? params.arguments : {};

  switch (toolName) {
    case "sts2_get_bridge_status":
      return await getBridgeStatus();
    case "sts2_get_state":
      return await getStateTool();
    case "sts2_list_actions":
      return await listActionsTool();
    case "sts2_perform_action":
      return await performActionTool(args);
    case "sts2_end_turn":
      return await endTurnTool(args);
    case "sts2_resolve_room_rewards":
      return await resolveRoomRewardsTool(args);
    case "sts2_resolve_rest_site":
      return await resolveRestSiteTool(args);
    case "sts2_resolve_card_selection":
      return await resolveCardSelectionTool(args);
    case "sts2_wait_for_change":
      return await waitForChangeTool(args);
    default:
      return asToolResult(
        {
          ok: false,
          error: "unknown_tool",
          tool: toolName
        },
        true
      );
  }
}

async function getBridgeStatus() {
  const sessionFilePath = getSessionFilePath();
  const status = {
    ok: false,
    session_file_path: sessionFilePath,
    session_file_exists: false,
    pid_alive: false,
    health_ok: false
  };

  if (!fs.existsSync(sessionFilePath)) {
    status.error = "session_file_missing";
    status.message = "Bridge session file was not found.";
    return asToolResult(status, true);
  }

  status.session_file_exists = true;

  let session;
  try {
    session = readSessionFile(sessionFilePath);
  } catch (error) {
    return asToolResult(
      {
        ...status,
        error: "invalid_session_file",
        message: error instanceof Error ? error.message : String(error)
      },
      true
    );
  }

  status.session = session;
  status.pid_alive = isProcessAlive(session.pid);

  if (!status.pid_alive) {
    status.error = "stale_session";
    status.message = "Session file exists, but the recorded game process is not alive.";
    return asToolResult(status, true);
  }

  if (!session.base_url || typeof session.base_url !== "string") {
    status.error = "invalid_session_file";
    status.message = "Session file does not contain a valid base_url.";
    return asToolResult(status, true);
  }

  const healthUrl = new URL("health", ensureTrailingSlash(session.base_url)).toString();
  status.health_url = healthUrl;

  try {
    const response = await fetch(healthUrl, {
      method: "GET",
      headers: buildAuthHeaders(session),
      signal: AbortSignal.timeout(DEFAULT_HTTP_TIMEOUT_MS)
    });

    const body = await readJsonResponseBody(response);
    status.health_status = response.status;
    status.health_ok = response.ok;
    status.bridge_health = body;
    status.ok = response.ok;

    return asToolResult(status, !response.ok);
  } catch (error) {
    status.error = "health_request_failed";
    status.message = error instanceof Error ? error.message : String(error);
    return asToolResult(status, true);
  }
}

async function getStateTool() {
  try {
    const session = getLiveSession();
    const response = await bridgeRequestJson(session, "state", {
      method: "GET"
    });
    return asToolResult(attachInteractionHints(response.payload), false);
  } catch (error) {
    return asToolResult(toolErrorPayload(error), true);
  }
}

async function listActionsTool() {
  try {
    const session = getLiveSession();
    const response = await bridgeRequestJson(session, "actions", {
      method: "GET"
    });
    return asToolResult(response.payload, false);
  } catch (error) {
    return asToolResult(toolErrorPayload(error), true);
  }
}

async function performActionTool(args) {
  try {
    const actionId = requireNonEmptyString(args.action_id, "action_id");
    const expectedStateVersion = optionalInteger(
      args.expected_state_version,
      "expected_state_version"
    );
    const waitAfterMs = clampInteger(
      args.wait_after_ms,
      DEFAULT_ACTION_WAIT_MS,
      0,
      MAX_ACTION_WAIT_MS,
      "wait_after_ms"
    );

    const session = getLiveSession();
    const result = await performBridgeAction(
      session,
      actionId,
      waitAfterMs,
      expectedStateVersion
    );

    return asToolResult(attachInteractionHints(result), false);
  } catch (error) {
    return asToolResult(toolErrorPayload(error), true);
  }
}

async function endTurnTool(args) {
  try {
    const expectedStateVersion = optionalInteger(
      args.expected_state_version,
      "expected_state_version"
    );
    const waitAfterMs = clampInteger(
      args.wait_after_ms,
      DEFAULT_ACTION_WAIT_MS,
      0,
      MAX_ACTION_WAIT_MS,
      "wait_after_ms"
    );

    const session = getLiveSession();
    const result = await performBridgeAction(
      session,
      "end_turn",
      waitAfterMs,
      expectedStateVersion
    );

    return asToolResult(attachInteractionHints(result), false);
  } catch (error) {
    return asToolResult(toolErrorPayload(error), true);
  }
}

async function resolveRoomRewardsTool(args) {
  try {
    const pickCardIndex = optionalInteger(args.pick_card_index, "pick_card_index");
    if (pickCardIndex !== undefined && pickCardIndex < 0) {
      throw new ToolPayloadError(
        "invalid_arguments",
        "pick_card_index must be 0 or greater when provided.",
        {
          field: "pick_card_index"
        }
      );
    }

    const skipCardReward = optionalBoolean(args.skip_card_reward, "skip_card_reward") ?? false;
    const takePotions = optionalBoolean(args.take_potions, "take_potions") ?? true;
    const autoProceed = optionalBoolean(args.auto_proceed, "auto_proceed") ?? true;

    if (pickCardIndex !== undefined && skipCardReward) {
      throw new ToolPayloadError(
        "invalid_arguments",
        "pick_card_index and skip_card_reward cannot be used together.",
        {
          fields: ["pick_card_index", "skip_card_reward"]
        }
      );
    }

    const session = getLiveSession();
    let state = await getBridgeState(session);
    const initialRewardBundle = buildRewardBundle(state);

    if (!initialRewardBundle.in_reward_flow) {
      return asToolResult(
        {
          ok: false,
          resolved: false,
          reason: "not_in_reward_flow",
          reward_bundle: initialRewardBundle,
          state
        },
        false
      );
    }

    const preflightBlocker = getRewardResolutionBlocker(initialRewardBundle, {
      pickCardIndex,
      skipCardReward,
      takePotions
    });
    if (preflightBlocker) {
      return asToolResult(
        {
          ok: false,
          resolved: false,
          ...preflightBlocker,
          reward_bundle: initialRewardBundle,
          state
        },
        false
      );
    }

    const executedActions = [];
    const claimedRewards = [];
    let selectedCard = null;

    while (true) {
      state = await getBridgeState(session);
      const bundle = buildRewardBundle(state);

      if (bundle.card_reward_selection.visible) {
        if (skipCardReward) {
          break;
        }

        if (pickCardIndex === undefined) {
          return asToolResult(
            {
              ok: false,
              resolved: false,
              reason: "card_choice_required",
              reward_bundle: bundle,
              executed_actions: executedActions,
              claimed_rewards: claimedRewards,
              state
            },
            false
          );
        }

        if (pickCardIndex >= bundle.card_reward_selection.options.length) {
          return asToolResult(
            {
              ok: false,
              resolved: false,
              reason: "card_choice_out_of_range",
              reward_bundle: bundle,
              requested_pick_card_index: pickCardIndex,
              executed_actions: executedActions,
              claimed_rewards: claimedRewards,
              state
            },
            false
          );
        }

        const cardOption = bundle.card_reward_selection.options[pickCardIndex];
        const cardActionId = `card_reward:${pickCardIndex}`;
        const cardResult = await performBridgeAction(session, cardActionId, 1800);
        executedActions.push(summarizeExecutedAction(cardResult));
        selectedCard = {
          index: pickCardIndex,
          card: cardOption.card
        };
        state = cardResult.state;
        continue;
      }

      if (!bundle.rewards.visible) {
        break;
      }

      const nextReward = chooseNextReward(bundle, {
        skipCardReward,
        takePotions
      });
      if (!nextReward) {
        break;
      }

      const rewardResult = await performBridgeAction(session, nextReward.action_id, 1200);
      executedActions.push(summarizeExecutedAction(rewardResult));
      claimedRewards.push(nextReward);
      state = rewardResult.state;
    }

    if (autoProceed) {
      const autoProceedResult = await autoAdvanceProceedChain(session, state);
      state = autoProceedResult.state;
      executedActions.push(...autoProceedResult.executed_actions);
    }

    return asToolResult(
      {
        ok: true,
        resolved: true,
        reward_bundle: initialRewardBundle,
        claimed_rewards: claimedRewards,
        selected_card: selectedCard,
        executed_actions: executedActions,
        final_state: state
      },
      false
    );
  } catch (error) {
    return asToolResult(toolErrorPayload(error), true);
  }
}

async function resolveRestSiteTool(args) {
  try {
    const optionIndex = optionalInteger(args.option_index, "option_index");
    const upgradeCardIndex = optionalInteger(args.upgrade_card_index, "upgrade_card_index");
    const autoProceed = optionalBoolean(args.auto_proceed, "auto_proceed") ?? true;

    if (optionIndex === undefined || optionIndex < 0) {
      throw new ToolPayloadError(
        "invalid_arguments",
        "option_index must be 0 or greater.",
        {
          field: "option_index"
        }
      );
    }

    if (upgradeCardIndex !== undefined && upgradeCardIndex < 0) {
      throw new ToolPayloadError(
        "invalid_arguments",
        "upgrade_card_index must be 0 or greater when provided.",
        {
          field: "upgrade_card_index"
        }
      );
    }

    const session = getLiveSession();
    let state = await getBridgeState(session);
    const initialRestSiteBundle = buildRestSiteBundle(state);

    if (!initialRestSiteBundle.in_rest_site_flow) {
      return asToolResult(
        {
          ok: false,
          resolved: false,
          reason: "not_in_rest_site_flow",
          rest_site_bundle: initialRestSiteBundle,
          state
        },
        false
      );
    }

    if (!initialRestSiteBundle.rest_site.visible) {
      return asToolResult(
        {
          ok: false,
          resolved: false,
          reason: "rest_site_not_visible",
          rest_site_bundle: initialRestSiteBundle,
          state
        },
        false
      );
    }

    if (optionIndex >= initialRestSiteBundle.rest_site.options.length) {
      return asToolResult(
        {
          ok: false,
          resolved: false,
          reason: "rest_site_option_out_of_range",
          requested_option_index: optionIndex,
          rest_site_bundle: initialRestSiteBundle,
          state
        },
        false
      );
    }

    const selectedOption = initialRestSiteBundle.rest_site.options[optionIndex];
    const executedActions = [];
    let selectedUpgradeCard = null;

    const optionResult = await performBridgeAction(session, `rest_site:${optionIndex}`, 1800);
    executedActions.push(summarizeExecutedAction(optionResult));
    state = optionResult.state;

    let restSiteBundle = buildRestSiteBundle(state);
    if (restSiteBundle.deck_upgrade_selection.visible) {
      if (upgradeCardIndex === undefined) {
        return asToolResult(
          {
            ok: false,
            resolved: false,
            reason: "upgrade_choice_required",
            selected_option: selectedOption,
            rest_site_bundle: restSiteBundle,
            executed_actions: executedActions,
            state
          },
          false
        );
      }

      if (upgradeCardIndex >= restSiteBundle.deck_upgrade_selection.options.length) {
        return asToolResult(
          {
            ok: false,
            resolved: false,
            reason: "upgrade_choice_out_of_range",
            requested_upgrade_card_index: upgradeCardIndex,
            selected_option: selectedOption,
            rest_site_bundle: restSiteBundle,
            executed_actions: executedActions,
            state
          },
          false
        );
      }

      selectedUpgradeCard = restSiteBundle.deck_upgrade_selection.options[upgradeCardIndex];
      const upgradeResult = await performBridgeAction(
        session,
        `deck_upgrade:${upgradeCardIndex}`,
        1800
      );
      executedActions.push(summarizeExecutedAction(upgradeResult));
      state = upgradeResult.state;
      restSiteBundle = buildRestSiteBundle(state);
    }

    if (autoProceed) {
      const autoProceedResult = await autoAdvanceRestSiteProceedChain(session, state);
      state = autoProceedResult.state;
      executedActions.push(...autoProceedResult.executed_actions);
      restSiteBundle = buildRestSiteBundle(state);
    }

    return asToolResult(
      {
        ok: true,
        resolved: isMapReadyState(state) || !restSiteBundle.in_rest_site_flow,
        selected_option: selectedOption,
        selected_upgrade_card: selectedUpgradeCard,
        rest_site_bundle: initialRestSiteBundle,
        executed_actions: executedActions,
        final_state: state
      },
      false
    );
  } catch (error) {
    return asToolResult(toolErrorPayload(error), true);
  }
}

async function resolveCardSelectionTool(args) {
  try {
    const selectIndices = optionalIntegerArray(args.select_indices, "select_indices") ?? [];
    const terminalAction = normalizeCardSelectionTerminalAction(args.terminal_action);
    const expectedMinSelect = optionalInteger(
      args.expected_min_select,
      "expected_min_select"
    );
    const expectedMaxSelect = optionalInteger(
      args.expected_max_select,
      "expected_max_select"
    );

    if (expectedMinSelect !== undefined && expectedMinSelect < 0) {
      throw new ToolPayloadError(
        "invalid_arguments",
        "expected_min_select must be 0 or greater when provided.",
        {
          field: "expected_min_select"
        }
      );
    }

    if (expectedMaxSelect !== undefined && expectedMaxSelect < 0) {
      throw new ToolPayloadError(
        "invalid_arguments",
        "expected_max_select must be 0 or greater when provided.",
        {
          field: "expected_max_select"
        }
      );
    }

    if (
      expectedMinSelect !== undefined &&
      expectedMaxSelect !== undefined &&
      expectedMinSelect > expectedMaxSelect
    ) {
      throw new ToolPayloadError(
        "invalid_arguments",
        "expected_min_select cannot be greater than expected_max_select.",
        {
          fields: ["expected_min_select", "expected_max_select"]
        }
      );
    }

    const uniqueSelectIndices = [...new Set(selectIndices)];
    if (uniqueSelectIndices.length !== selectIndices.length) {
      throw new ToolPayloadError(
        "invalid_arguments",
        "select_indices cannot contain duplicates.",
        {
          field: "select_indices"
        }
      );
    }

    if (uniqueSelectIndices.length === 0 && terminalAction === "none") {
      throw new ToolPayloadError(
        "invalid_arguments",
        "Provide at least one select_indices entry or a terminal_action other than none.",
        {
          fields: ["select_indices", "terminal_action"]
        }
      );
    }

    const session = getLiveSession();
    let state = await getBridgeState(session);
    const initialCardSelectionBundle = buildCardSelectionBundle(state);

    if (!initialCardSelectionBundle.in_card_selection_flow) {
      return asToolResult(
        {
          ok: false,
          resolved: false,
          reason: "not_in_card_selection_flow",
          card_selection_bundle: initialCardSelectionBundle,
          state
        },
        false
      );
    }

    if (!initialCardSelectionBundle.card_selection.visible) {
      return asToolResult(
        {
          ok: false,
          resolved: false,
          reason: "card_selection_not_visible",
          card_selection_bundle: initialCardSelectionBundle,
          state
        },
        false
      );
    }

    if (
      expectedMinSelect !== undefined &&
      initialCardSelectionBundle.card_selection.min_select !== expectedMinSelect
    ) {
      return asToolResult(
        {
          ok: false,
          resolved: false,
          reason: "min_select_mismatch",
          expected_min_select: expectedMinSelect,
          observed_min_select: initialCardSelectionBundle.card_selection.min_select,
          card_selection_bundle: initialCardSelectionBundle,
          state
        },
        false
      );
    }

    if (
      expectedMaxSelect !== undefined &&
      initialCardSelectionBundle.card_selection.max_select !== expectedMaxSelect
    ) {
      return asToolResult(
        {
          ok: false,
          resolved: false,
          reason: "max_select_mismatch",
          expected_max_select: expectedMaxSelect,
          observed_max_select: initialCardSelectionBundle.card_selection.max_select,
          card_selection_bundle: initialCardSelectionBundle,
          state
        },
        false
      );
    }

    if (
      uniqueSelectIndices.some(
        (index) => index >= initialCardSelectionBundle.card_selection.options.length
      )
    ) {
      return asToolResult(
        {
          ok: false,
          resolved: false,
          reason: "card_selection_option_out_of_range",
          requested_select_indices: uniqueSelectIndices,
          option_count: initialCardSelectionBundle.card_selection.options.length,
          card_selection_bundle: initialCardSelectionBundle,
          state
        },
        false
      );
    }

    const initialSelectedCount = initialCardSelectionBundle.card_selection.selected_count ?? 0;
    const initialMaxSelect = initialCardSelectionBundle.card_selection.max_select;
    if (
      Number.isInteger(initialMaxSelect) &&
      initialSelectedCount + uniqueSelectIndices.length > initialMaxSelect
    ) {
      return asToolResult(
        {
          ok: false,
          resolved: false,
          reason: "too_many_cards_requested",
          requested_select_count: uniqueSelectIndices.length,
          selected_count_before: initialSelectedCount,
          max_select: initialMaxSelect,
          card_selection_bundle: initialCardSelectionBundle,
          state
        },
        false
      );
    }

    const executedActions = [];
    const selectedCards = [];

    // Select from highest to lowest so lower indices remain stable if the UI
    // removes selected cards from the visible option list.
    for (const requestedIndex of [...uniqueSelectIndices].sort((left, right) => right - left)) {
      const currentCardSelectionBundle = buildCardSelectionBundle(state);
      if (
        !currentCardSelectionBundle.in_card_selection_flow ||
        !currentCardSelectionBundle.card_selection.visible
      ) {
        return asToolResult(
          {
            ok: false,
            resolved: false,
            reason: "card_selection_flow_closed_early",
            requested_select_indices: uniqueSelectIndices,
            selected_cards: selectedCards,
            executed_actions: executedActions,
            initial_card_selection_bundle: initialCardSelectionBundle,
            current_card_selection_bundle: currentCardSelectionBundle,
            state
          },
          false
        );
      }

      const currentOptions = currentCardSelectionBundle.card_selection.options;
      if (requestedIndex >= currentOptions.length) {
        return asToolResult(
          {
            ok: false,
            resolved: false,
            reason: "card_selection_option_out_of_range_after_reindex",
            requested_index: requestedIndex,
            current_option_count: currentOptions.length,
            selected_cards: selectedCards,
            executed_actions: executedActions,
            initial_card_selection_bundle: initialCardSelectionBundle,
            current_card_selection_bundle: currentCardSelectionBundle,
            state
          },
          false
        );
      }

      const option = currentOptions[requestedIndex];
      if (option?.is_selected === true) {
        return asToolResult(
          {
            ok: false,
            resolved: false,
            reason: "card_selection_option_already_selected",
            requested_index: requestedIndex,
            selected_cards: selectedCards,
            executed_actions: executedActions,
            initial_card_selection_bundle: initialCardSelectionBundle,
            current_card_selection_bundle: currentCardSelectionBundle,
            state
          },
          false
        );
      }

      const actionId = `card_selection:select:${requestedIndex}`;
      if (!currentCardSelectionBundle.non_automation_action_ids.includes(actionId)) {
        return asToolResult(
          {
            ok: false,
            resolved: false,
            reason: "card_selection_action_unavailable",
            requested_index: requestedIndex,
            requested_action_id: actionId,
            selected_cards: selectedCards,
            executed_actions: executedActions,
            initial_card_selection_bundle: initialCardSelectionBundle,
            current_card_selection_bundle: currentCardSelectionBundle,
            state
          },
          false
        );
      }

      const selectResult = await performBridgeAction(session, actionId, 1200);
      executedActions.push(summarizeExecutedAction(selectResult));
      selectedCards.push({
        requested_index: requestedIndex,
        card: option?.card ?? null
      });
      state = selectResult.state;
    }

    let finalCardSelectionBundle = buildCardSelectionBundle(state);
    let terminalActionResult = null;

    if (terminalAction !== "none") {
      const terminalActionId = `card_selection:${terminalAction}`;

      if (!finalCardSelectionBundle.in_card_selection_flow) {
        terminalActionResult = {
          requested_action_id: terminalActionId,
          executed: false,
          reason: "selection_flow_already_closed"
        };
      } else if (!finalCardSelectionBundle.non_automation_action_ids.includes(terminalActionId)) {
        return asToolResult(
          {
            ok: false,
            resolved: false,
            reason: "terminal_action_unavailable",
            requested_terminal_action: terminalAction,
            selected_cards: selectedCards,
            executed_actions: executedActions,
            initial_card_selection_bundle: initialCardSelectionBundle,
            current_card_selection_bundle: finalCardSelectionBundle,
            state
          },
          false
        );
      } else {
        if (terminalAction === "confirm") {
          const selectedCount = finalCardSelectionBundle.card_selection.selected_count ?? 0;
          const minSelect = finalCardSelectionBundle.card_selection.min_select ?? 0;
          if (selectedCount < minSelect) {
            return asToolResult(
              {
                ok: false,
                resolved: false,
                reason: "selection_incomplete",
                requested_terminal_action: terminalAction,
                selected_count: selectedCount,
                min_select: minSelect,
                selected_cards: selectedCards,
                executed_actions: executedActions,
                initial_card_selection_bundle: initialCardSelectionBundle,
                current_card_selection_bundle: finalCardSelectionBundle,
                state
              },
              false
            );
          }
        }

        const terminalResult = await performBridgeAction(session, terminalActionId, 1200);
        executedActions.push(summarizeExecutedAction(terminalResult));
        state = terminalResult.state;
        finalCardSelectionBundle = buildCardSelectionBundle(state);
        terminalActionResult = {
          requested_action_id: terminalActionId,
          executed: true,
          screen_after: state?.screen ?? null
        };
      }
    }

    return asToolResult(
      {
        ok: true,
        resolved: !finalCardSelectionBundle.in_card_selection_flow,
        initial_card_selection_bundle: initialCardSelectionBundle,
        selected_cards: selectedCards,
        terminal_action: terminalActionResult,
        executed_actions: executedActions,
        final_card_selection_bundle: finalCardSelectionBundle,
        final_state: state
      },
      false
    );
  } catch (error) {
    return asToolResult(toolErrorPayload(error), true);
  }
}

async function waitForChangeTool(args) {
  try {
    const session = getLiveSession();
    const timeoutMs = clampInteger(
      args.timeout_ms,
      DEFAULT_WAIT_TIMEOUT_MS,
      1,
      MAX_WAIT_TIMEOUT_MS,
      "timeout_ms"
    );
    const pollIntervalMs = clampInteger(
      args.poll_interval_ms,
      DEFAULT_POLL_INTERVAL_MS,
      MIN_POLL_INTERVAL_MS,
      MAX_POLL_INTERVAL_MS,
      "poll_interval_ms"
    );

    let baselineStateVersion = optionalInteger(
      args.baseline_state_version,
      "baseline_state_version"
    );
    let baselineStateHash = optionalString(args.baseline_state_hash, "baseline_state_hash");

    const initialResponse = await bridgeRequestJson(session, "state", {
      method: "GET"
    });
    const initialState = initialResponse.payload;

    if (baselineStateVersion === undefined && baselineStateHash === undefined) {
      baselineStateVersion = initialState.state_version;
      baselineStateHash = initialState.state_hash;
    }

    if (
      baselineStateVersion !== undefined &&
      initialState.state_version !== baselineStateVersion
    ) {
      return asToolResult(
        {
          ok: true,
          changed: true,
          reason: "state_version_mismatch",
          baseline_state_version: baselineStateVersion,
          baseline_state_hash: baselineStateHash ?? null,
          state: initialState
        },
        false
      );
    }

    if (baselineStateHash !== undefined && initialState.state_hash !== baselineStateHash) {
      return asToolResult(
        {
          ok: true,
          changed: true,
          reason: "state_hash_mismatch",
          baseline_state_version: baselineStateVersion ?? null,
          baseline_state_hash: baselineStateHash,
          state: initialState
        },
        false
      );
    }

    const deadline = Date.now() + timeoutMs;
    let lastState = initialState;

    while (Date.now() < deadline) {
      await delay(pollIntervalMs);

      const response = await bridgeRequestJson(session, "state", {
        method: "GET"
      });
      lastState = response.payload;

      const versionChanged =
        baselineStateVersion !== undefined && lastState.state_version !== baselineStateVersion;
      const hashChanged =
        baselineStateHash !== undefined && lastState.state_hash !== baselineStateHash;

      if (versionChanged || hashChanged) {
        return asToolResult(
          {
            ok: true,
            changed: true,
            reason: versionChanged ? "state_version_changed" : "state_hash_changed",
            baseline_state_version: baselineStateVersion ?? null,
            baseline_state_hash: baselineStateHash ?? null,
            state: lastState
          },
          false
        );
      }
    }

    return asToolResult(
      {
        ok: false,
        changed: false,
        error: "timeout",
        message: `State did not change within ${timeoutMs} ms.`,
        baseline_state_version: baselineStateVersion ?? null,
        baseline_state_hash: baselineStateHash ?? null,
        state: lastState
      },
      true
    );
  } catch (error) {
    return asToolResult(toolErrorPayload(error), true);
  }
}

async function getBridgeState(session) {
  const response = await bridgeRequestJson(session, "state", {
    method: "GET"
  });
  return response.payload;
}

async function performBridgeAction(session, actionId, waitAfterMs, expectedStateVersion) {
  const stateVersion =
    Number.isInteger(expectedStateVersion)
      ? expectedStateVersion
      : (await getBridgeState(session)).state_version;
  const response = await bridgeRequestJson(session, "action", {
    method: "POST",
    body: {
      action_id: actionId,
      expected_state_version: stateVersion,
      wait_after_ms: waitAfterMs
    },
    timeoutMs: DEFAULT_HTTP_TIMEOUT_MS + waitAfterMs + 5000
  });

  return maybeSettleAfterAction(session, actionId, response.payload);
}

async function maybeSettleAfterAction(session, actionId, result) {
  const settleStrategy = getPostActionSettleStrategy(actionId);
  if (!settleStrategy) {
    return result;
  }

  let settled = null;
  if (settleStrategy === "end_turn") {
    settled = await waitForEndTurnSettlement(session, result?.state ?? null);
  } else if (settleStrategy === "combat_action") {
    settled = await waitForCombatActionSettlement(session, result?.state ?? null);
  }

  if (!settled) {
    return result;
  }

  return {
    ...result,
    state: settled.state,
    state_version_after:
      settled?.state?.state_version ?? result?.state_version_after ?? null,
    state_hash_after:
      settled?.state?.state_hash ?? result?.state_hash_after ?? null,
    post_action_settled: settled.settled,
    post_action_settle_reason: settled.reason,
    post_action_settle_polls: settled.poll_count
  };
}

function getPostActionSettleStrategy(actionId) {
  if (typeof actionId !== "string" || actionId.length <= 0) {
    return null;
  }

  if (actionId === "end_turn") {
    return "end_turn";
  }

  if (
    actionId.startsWith("play_card:") ||
    actionId.startsWith("card_selection:") ||
    actionId.startsWith("use_potion:")
  ) {
    return "combat_action";
  }

  return null;
}

async function waitForEndTurnSettlement(session, initialState) {
  let state = initialState;
  let stablePolls = 0;
  let previousHash = typeof state?.state_hash === "string" ? state.state_hash : null;

  const initialVerdict = getEndTurnSettlementVerdict(state, stablePolls);
  if (initialVerdict.settled) {
    return {
      settled: true,
      reason: initialVerdict.reason,
      poll_count: 0,
      state
    };
  }

  const startedAt = Date.now();
  let pollCount = 0;
  while (Date.now() - startedAt < END_TURN_SETTLE_TIMEOUT_MS) {
    await delay(END_TURN_SETTLE_POLL_INTERVAL_MS);
    pollCount += 1;
    state = await getBridgeState(session);

    const currentHash = typeof state?.state_hash === "string" ? state.state_hash : null;
    stablePolls = currentHash !== null && currentHash === previousHash ? stablePolls + 1 : 0;
    previousHash = currentHash;

    const verdict = getEndTurnSettlementVerdict(state, stablePolls);
    if (verdict.settled) {
      return {
        settled: true,
        reason: verdict.reason,
        poll_count: pollCount,
        state
      };
    }
  }

  return {
    settled: false,
    reason: "timeout",
    poll_count: pollCount,
    state
  };
}

async function waitForCombatActionSettlement(session, initialState) {
  let state = initialState;
  let stablePolls = 0;
  let previousHash = typeof state?.state_hash === "string" ? state.state_hash : null;

  const initialVerdict = getCombatActionSettlementVerdict(state, stablePolls);
  if (initialVerdict.settled) {
    return {
      settled: true,
      reason: initialVerdict.reason,
      poll_count: 0,
      state
    };
  }

  const startedAt = Date.now();
  let pollCount = 0;
  while (Date.now() - startedAt < COMBAT_ACTION_SETTLE_TIMEOUT_MS) {
    await delay(COMBAT_ACTION_SETTLE_POLL_INTERVAL_MS);
    pollCount += 1;
    state = await getBridgeState(session);

    const currentHash = typeof state?.state_hash === "string" ? state.state_hash : null;
    stablePolls = currentHash !== null && currentHash === previousHash ? stablePolls + 1 : 0;
    previousHash = currentHash;

    const verdict = getCombatActionSettlementVerdict(state, stablePolls);
    if (verdict.settled) {
      return {
        settled: true,
        reason: verdict.reason,
        poll_count: pollCount,
        state
      };
    }
  }

  return {
    settled: false,
    reason: "timeout",
    poll_count: pollCount,
    state
  };
}

function getEndTurnSettlementVerdict(state, stablePolls) {
  if (!state || typeof state !== "object") {
    return {
      settled: false,
      reason: "missing_state"
    };
  }

  if (typeof state.screen === "string" && state.screen !== "COMBAT") {
    return {
      settled: true,
      reason: `screen:${state.screen}`
    };
  }

  const combat = isPlainObject(state.combat) ? state.combat : {};
  if (combat.in_progress !== true) {
    return {
      settled: true,
      reason: "combat_not_in_progress"
    };
  }

  if (
    combat.current_side !== "Player" ||
    combat.is_play_phase !== true ||
    combat.player_actions_disabled === true
  ) {
    return {
      settled: false,
      reason: "waiting_for_player_turn"
    };
  }

  const handCount = getPileCount(state?.players?.[0]?.combat?.hand);
  const drawCount = getPileCount(state?.players?.[0]?.combat?.draw_pile);
  const discardCount = getPileCount(state?.players?.[0]?.combat?.discard_pile);
  const totalDrawableCount =
    handCount !== null && drawCount !== null && discardCount !== null
      ? handCount + drawCount + discardCount
      : null;
  const targetHandCount =
    totalDrawableCount !== null ? Math.min(5, totalDrawableCount) : null;
  const nonAutomationActions = getNonAutomationActions(state);
  const hasMeaningfulAction = nonAutomationActions.some(
    (action) => action?.action_id && action.action_id !== "end_turn"
  );

  if (
    handCount !== null &&
    targetHandCount !== null &&
    handCount >= targetHandCount &&
    (hasMeaningfulAction || nonAutomationActions.length > 0)
  ) {
    return {
      settled: true,
      reason: "player_turn_ready"
    };
  }

  if (
    stablePolls >= END_TURN_STABLE_POLL_TARGET &&
    handCount !== null &&
    handCount > 0 &&
    (hasMeaningfulAction || nonAutomationActions.length > 0)
  ) {
    return {
      settled: true,
      reason: "player_turn_stable_fallback"
    };
  }

  return {
    settled: false,
    reason: "waiting_for_hand_fill"
  };
}

function getCombatActionSettlementVerdict(state, stablePolls) {
  if (!state || typeof state !== "object") {
    return {
      settled: false,
      reason: "missing_state"
    };
  }

  if (typeof state.screen === "string" && state.screen !== "COMBAT") {
    return {
      settled: true,
      reason: `screen:${state.screen}`
    };
  }

  const cardSelectionBundle = buildCardSelectionBundle(state);
  if (cardSelectionBundle.in_card_selection_flow) {
    return {
      settled: true,
      reason: "card_selection_ready"
    };
  }

  const combat = isPlainObject(state?.combat) ? state.combat : {};
  if (combat.in_progress !== true) {
    return {
      settled: true,
      reason: "combat_not_in_progress"
    };
  }

  if (
    combat.current_side !== "Player" ||
    combat.is_play_phase !== true ||
    combat.player_actions_disabled === true
  ) {
    return {
      settled: false,
      reason: "waiting_for_combat_resolution"
    };
  }

  const nonAutomationActions = getNonAutomationActions(state);
  if (nonAutomationActions.length <= 0) {
    return {
      settled: false,
      reason: "waiting_for_action_list"
    };
  }

  const hasMeaningfulAction = nonAutomationActions.some(
    (action) => action?.action_id && action.action_id !== "end_turn"
  );
  if (stablePolls >= COMBAT_ACTION_STABLE_POLL_TARGET) {
    return {
      settled: true,
      reason: hasMeaningfulAction
        ? "player_turn_stable"
        : "player_turn_stable_end_turn_only"
    };
  }

  return {
    settled: false,
    reason: "waiting_for_stable_player_turn"
  };
}

function getPileCount(pile) {
  if (!pile || typeof pile !== "object") {
    return null;
  }

  if (Number.isInteger(pile.count)) {
    return pile.count;
  }

  if (Array.isArray(pile.cards)) {
    return pile.cards.length;
  }

  return null;
}

function getNonAutomationActions(state) {
  return Array.isArray(state?.available_actions)
    ? state.available_actions.filter(
        (action) =>
          typeof action?.action_id === "string" && !action.action_id.startsWith("automation:")
      )
    : [];
}

function buildRewardBundle(state) {
  const rewards = Array.isArray(state?.rewards?.rewards)
    ? state.rewards.rewards.map((entry) => ({
        index: Number.isInteger(entry?.index) ? entry.index : null,
        action_id:
          Number.isInteger(entry?.index) && Number.isInteger(entry?.index)
            ? `reward:${entry.index}`
            : null,
        reward: entry?.reward ?? null
      }))
    : [];
  const cardRewardSelectionOptions = Array.isArray(state?.card_reward_selection?.options)
    ? state.card_reward_selection.options.map((option) => ({
        index: Number.isInteger(option?.index) ? option.index : null,
        card: option?.card ?? null
      }))
    : [];
  const potionSlots = Array.isArray(state?.players?.[0]?.potions)
    ? state.players[0].potions.map((potion, index) => ({
        index,
        potion,
        is_empty: potion?.empty === true
      }))
    : [];
  const hasProceed = Array.isArray(state?.available_actions)
    ? state.available_actions.some((action) => action?.action_id === "proceed")
    : false;
  const screen = typeof state?.screen === "string" ? state.screen : null;
  const rewardsVisible = state?.rewards?.visible === true;
  const terminalProceedVisible = state?.rewards?.terminal_proceed_visible === true;
  const cardRewardVisible = state?.card_reward_selection?.visible === true;
  const inRewardFlow =
    rewardsVisible ||
    cardRewardVisible ||
    terminalProceedVisible ||
    screen === "REWARDS" ||
    screen === "CARD_REWARD_SELECTION";

  return {
    in_reward_flow: inRewardFlow,
    screen,
    rewards: {
      visible: rewardsVisible,
      terminal_proceed_visible: terminalProceedVisible,
      entries: rewards
    },
    card_reward_selection: {
      visible: cardRewardVisible,
      options: cardRewardSelectionOptions
    },
    potion_slots: potionSlots,
    empty_potion_slot_count: potionSlots.filter((slot) => slot.is_empty).length,
    has_proceed: hasProceed
  };
}

function buildRestSiteBundle(state) {
  const mapReady = isMapReadyState(state);
  const screen = typeof state?.screen === "string" ? state.screen : null;
  const restSiteVisible = state?.rest_site?.visible === true && !mapReady;
  const restSiteProceedVisible = state?.rest_site?.proceed_visible === true && !mapReady;
  const deckUpgradeVisible = state?.deck_upgrade_selection?.visible === true;
  const restSiteOptions = Array.isArray(state?.rest_site?.options)
    ? state.rest_site.options.map((option) => ({
        index: Number.isInteger(option?.index) ? option.index : null,
        option_id: option?.option_id ?? null,
        option_type: option?.option_type ?? null,
        title: option?.title ?? null,
        description: option?.description ?? null
      }))
    : [];
  const deckUpgradeOptions = Array.isArray(state?.deck_upgrade_selection?.options)
    ? state.deck_upgrade_selection.options.map((option) => ({
        index: Number.isInteger(option?.index) ? option.index : null,
        card: option?.card ?? null
      }))
    : [];
  const nonAutomationActions = getNonAutomationActions(state);

  return {
    in_rest_site_flow:
      deckUpgradeVisible ||
      (!mapReady &&
        (restSiteVisible || restSiteProceedVisible || screen === "REST_SITE")),
    screen,
    map_ready: mapReady,
    rest_site: {
      visible: restSiteVisible,
      header: state?.rest_site?.header ?? null,
      description: state?.rest_site?.description ?? null,
      proceed_visible: restSiteProceedVisible,
      options: restSiteOptions
    },
    deck_upgrade_selection: {
      visible: deckUpgradeVisible,
      options: deckUpgradeOptions
    },
    non_automation_action_ids: nonAutomationActions
      .map((action) => action?.action_id)
      .filter((actionId) => typeof actionId === "string")
  };
}

function buildCardSelectionBundle(state) {
  const screen = typeof state?.screen === "string" ? state.screen : null;
  const rawCardSelection = isPlainObject(state?.card_selection) ? state.card_selection : {};
  const options = Array.isArray(rawCardSelection.options)
    ? rawCardSelection.options.map((option) => ({
        index: Number.isInteger(option?.index) ? option.index : null,
        card: option?.card ?? null,
        is_selected: option?.is_selected === true
      }))
    : [];
  const nonAutomationActionIds = getNonAutomationActions(state)
    .map((action) => action?.action_id)
    .filter((actionId) => typeof actionId === "string");
  const visible = rawCardSelection.visible === true;

  return {
    in_card_selection_flow:
      visible ||
      screen === "CARD_SELECTION" ||
      nonAutomationActionIds.some((actionId) => actionId.startsWith("card_selection:")),
    screen,
    card_selection: {
      visible,
      screen_type:
        typeof rawCardSelection.screen_type === "string" ? rawCardSelection.screen_type : null,
      prompt: typeof rawCardSelection.prompt === "string" ? rawCardSelection.prompt : null,
      selected_count: Number.isInteger(rawCardSelection.selected_count)
        ? rawCardSelection.selected_count
        : null,
      min_select: Number.isInteger(rawCardSelection.min_select)
        ? rawCardSelection.min_select
        : null,
      max_select: Number.isInteger(rawCardSelection.max_select)
        ? rawCardSelection.max_select
        : null,
      requires_manual_confirmation:
        typeof rawCardSelection.requires_manual_confirmation === "boolean"
          ? rawCardSelection.requires_manual_confirmation
          : null,
      cancelable:
        typeof rawCardSelection.cancelable === "boolean"
          ? rawCardSelection.cancelable
          : null,
      confirm_visible: rawCardSelection.confirm_visible === true,
      cancel_visible: rawCardSelection.cancel_visible === true,
      close_visible: rawCardSelection.close_visible === true,
      skip_visible: rawCardSelection.skip_visible === true,
      options
    },
    non_automation_action_ids: nonAutomationActionIds
  };
}

function getRewardResolutionBlocker(rewardBundle, options) {
  const cardRewardEntry = rewardBundle.rewards.entries.find(
    (entry) => entry?.reward?.reward_type === "card"
  );
  const potionRewards = rewardBundle.rewards.entries.filter(
    (entry) => entry?.reward?.reward_type === "potion"
  );
  const hasVisibleCardSelection = rewardBundle.card_reward_selection.visible;

  if ((cardRewardEntry || hasVisibleCardSelection) &&
      options.pickCardIndex === undefined &&
      !options.skipCardReward) {
    return {
      reason: "card_choice_required",
      message:
        "A card reward is present. Provide pick_card_index to resolve it in one tool call, or set skip_card_reward=true."
    };
  }

  if (options.takePotions &&
      potionRewards.length > 0 &&
      rewardBundle.empty_potion_slot_count <= 0) {
    return {
      reason: "potion_slots_full",
      message:
        "A potion reward is present, but all potion slots are full. This still needs a separate replacement/drop decision flow."
    };
  }

  return null;
}

function chooseNextReward(rewardBundle, options) {
  const claimableRewards = rewardBundle.rewards.entries.filter((entry) => {
    const rewardType = entry?.reward?.reward_type;

    if (!entry?.action_id || !rewardType) {
      return false;
    }

    if (rewardType === "gold" || rewardType === "relic") {
      return true;
    }

    if (rewardType === "potion") {
      return options.takePotions && rewardBundle.empty_potion_slot_count > 0;
    }

    if (rewardType === "card") {
      return !options.skipCardReward;
    }

    return false;
  });

  return claimableRewards[0] ?? null;
}

async function autoAdvanceProceedChain(session, initialState) {
  const executedActions = [];
  let state = initialState;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const nonAutomationActions = Array.isArray(state?.available_actions)
      ? state.available_actions.filter(
          (action) => typeof action?.action_id === "string" && !action.action_id.startsWith("automation:")
        )
      : [];

    if (
      nonAutomationActions.length !== 1 ||
      nonAutomationActions[0].action_id !== "proceed"
    ) {
      break;
    }

    const baselineStateVersion = state?.state_version ?? null;
    const baselineStateHash = state?.state_hash ?? null;
    const result = await performBridgeAction(session, "proceed", 1800);
    executedActions.push(summarizeExecutedAction(result));
    state = result.state;

    const stateChanged =
      state?.state_version !== baselineStateVersion ||
      state?.state_hash !== baselineStateHash;

    if (!stateChanged) {
      break;
    }
  }

  return {
    state,
    executed_actions: executedActions
  };
}

async function autoAdvanceRestSiteProceedChain(session, initialState) {
  const executedActions = [];
  let state = await waitForRoomExitSettlement(
    session,
    initialState,
    (candidate) => isMapReadyState(candidate) || !buildRestSiteBundle(candidate).in_rest_site_flow
  );

  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (isMapReadyState(state)) {
      break;
    }

    const actionIds = getNonAutomationActions(state)
      .map((action) => action?.action_id)
      .filter((actionId) => typeof actionId === "string");

    if (!actionIds.includes("rest_site:proceed")) {
      break;
    }

    const result = await performBridgeAction(session, "rest_site:proceed", 1800);
    executedActions.push(summarizeExecutedAction(result));
    state = await waitForRoomExitSettlement(
      session,
      result.state,
      (candidate) => isMapReadyState(candidate) || !buildRestSiteBundle(candidate).in_rest_site_flow
    );

    if (isMapReadyState(state)) {
      break;
    }

    const remainingActionIds = getNonAutomationActions(state)
      .map((action) => action?.action_id)
      .filter((actionId) => typeof actionId === "string");
    if (
      remainingActionIds.length !== 1 ||
      remainingActionIds[0] !== "rest_site:proceed"
    ) {
      break;
    }
  }

  return {
    state,
    executed_actions: executedActions
  };
}

async function waitForRoomExitSettlement(session, initialState, predicate) {
  let state = initialState;
  if (predicate(state)) {
    return state;
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < ROOM_EXIT_SETTLE_TIMEOUT_MS) {
    await delay(ROOM_EXIT_SETTLE_POLL_INTERVAL_MS);
    state = await getBridgeState(session);
    if (predicate(state)) {
      return state;
    }
  }

  return state;
}

function isMapReadyState(state) {
  return (
    state?.screen === "MAP" &&
    state?.map?.is_open === true &&
    state?.map?.is_travel_enabled === true
  );
}

function summarizeExecutedAction(result) {
  return {
    action_id: result?.action_id ?? null,
    matched_action: result?.matched_action ?? null,
    auto_executed_actions: Array.isArray(result?.auto_executed_actions)
      ? result.auto_executed_actions
      : [],
    post_action_settled: result?.post_action_settled ?? null,
    post_action_settle_reason: result?.post_action_settle_reason ?? null,
    post_action_settle_polls: result?.post_action_settle_polls ?? null,
    state_version_after: result?.state_version_after ?? result?.state?.state_version ?? null,
    screen_after: result?.state?.screen ?? null
  };
}

function getSessionFilePath() {
  if (process.env.STS2_BRIDGE_SESSION_FILE) {
    return process.env.STS2_BRIDGE_SESSION_FILE;
  }

  if (process.env.APPDATA) {
    return path.join(process.env.APPDATA, "SlayTheSpire2", "bridge", "session.json");
  }

  return path.join(
    os.homedir(),
    "AppData",
    "Roaming",
    "SlayTheSpire2",
    "bridge",
    "session.json"
  );
}

function getLogFilePath() {
  if (process.env.STS2_MCP_LOG_FILE) {
    return process.env.STS2_MCP_LOG_FILE;
  }

  if (process.env.APPDATA) {
    return path.join(process.env.APPDATA, "SlayTheSpire2", "bridge", DEFAULT_LOG_FILE_NAME);
  }

  return path.join(
    os.homedir(),
    "AppData",
    "Roaming",
    "SlayTheSpire2",
    "bridge",
    DEFAULT_LOG_FILE_NAME
  );
}

function getLiveSession() {
  const sessionFilePath = getSessionFilePath();

  if (!fs.existsSync(sessionFilePath)) {
    throw new ToolPayloadError(
      "session_file_missing",
      "Bridge session file was not found.",
      {
        session_file_path: sessionFilePath
      }
    );
  }

  const session = readSessionFile(sessionFilePath);
  if (!isProcessAlive(session.pid)) {
    throw new ToolPayloadError(
      "stale_session",
      "Session file exists, but the recorded game process is not alive.",
      {
        session_file_path: sessionFilePath,
        session
      }
    );
  }

  if (!session.base_url || typeof session.base_url !== "string") {
    throw new ToolPayloadError(
      "invalid_session_file",
      "Session file does not contain a valid base_url.",
      {
        session_file_path: sessionFilePath,
        session
      }
    );
  }

  return session;
}

function readSessionFile(sessionFilePath) {
  const rawSession = fs.readFileSync(sessionFilePath, "utf8");
  return JSON.parse(rawSession);
}

function buildAuthHeaders(session) {
  return session.token
    ? {
        Authorization: `Bearer ${session.token}`
      }
    : {};
}

async function bridgeRequestJson(session, endpointPath, options) {
  const method = options && options.method ? options.method : "GET";
  const timeoutMs =
    options && Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_HTTP_TIMEOUT_MS;
  const url = new URL(endpointPath, ensureTrailingSlash(session.base_url)).toString();
  const headers = buildAuthHeaders(session);
  const requestOptions = {
    method,
    headers,
    signal: AbortSignal.timeout(timeoutMs)
  };

  if (options && Object.prototype.hasOwnProperty.call(options, "body")) {
    requestOptions.body = JSON.stringify(options.body);
    requestOptions.headers = {
      ...headers,
      "Content-Type": "application/json"
    };
  }

  let response;
  try {
    response = await fetch(url, requestOptions);
  } catch (error) {
    throw new ToolPayloadError(
      "bridge_request_failed",
      error instanceof Error ? error.message : String(error),
      {
        url,
        method,
        timeout_ms: timeoutMs
      }
    );
  }

  const payload = await readJsonResponseBody(response);
  if (!response.ok) {
    throw new BridgeHttpError(
      response.status,
      payload && typeof payload.error === "string" ? payload.error : "bridge_http_error",
      payload && typeof payload.message === "string"
        ? payload.message
        : `Bridge request failed with status ${response.status}.`,
      {
        url,
        method,
        status: response.status,
        payload
      }
    );
  }

  return {
    url,
    status: response.status,
    payload
  };
}

async function readJsonResponseBody(response) {
  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ToolPayloadError(
      "invalid_bridge_response",
      "Bridge response was not valid JSON.",
      {
        status: response.status,
        raw_text: text
      }
    );
  }
}

function ensureTrailingSlash(value) {
  return value.endsWith("/") ? value : `${value}/`;
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "EPERM") {
      return true;
    }
    return false;
  }
}

function requireNonEmptyString(value, fieldName) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ToolPayloadError(
      "invalid_arguments",
      `${fieldName} must be a non-empty string.`,
      {
        field: fieldName
      }
    );
  }

  return value.trim();
}

function optionalString(value, fieldName) {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new ToolPayloadError(
      "invalid_arguments",
      `${fieldName} must be a string when provided.`,
      {
        field: fieldName
      }
    );
  }

  return value;
}

function optionalBoolean(value, fieldName) {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "boolean") {
    throw new ToolPayloadError(
      "invalid_arguments",
      `${fieldName} must be a boolean when provided.`,
      {
        field: fieldName
      }
    );
  }

  return value;
}

function optionalInteger(value, fieldName) {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (!Number.isInteger(value)) {
    throw new ToolPayloadError(
      "invalid_arguments",
      `${fieldName} must be an integer when provided.`,
      {
        field: fieldName
      }
    );
  }

  return value;
}

function optionalIntegerArray(value, fieldName) {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new ToolPayloadError(
      "invalid_arguments",
      `${fieldName} must be an array of integers when provided.`,
      {
        field: fieldName
      }
    );
  }

  return value.map((entry, index) => {
    if (!Number.isInteger(entry)) {
      throw new ToolPayloadError(
        "invalid_arguments",
        `${fieldName}[${index}] must be an integer.`,
        {
          field: fieldName,
          index
        }
      );
    }

    if (entry < 0) {
      throw new ToolPayloadError(
        "invalid_arguments",
        `${fieldName}[${index}] must be 0 or greater.`,
        {
          field: fieldName,
          index
        }
      );
    }

    return entry;
  });
}

function normalizeCardSelectionTerminalAction(value) {
  const normalized = optionalString(value, "terminal_action") ?? "confirm";
  if (
    normalized !== "confirm" &&
    normalized !== "cancel" &&
    normalized !== "skip" &&
    normalized !== "close" &&
    normalized !== "none"
  ) {
    throw new ToolPayloadError(
      "invalid_arguments",
      "terminal_action must be one of confirm, cancel, skip, close, or none.",
      {
        field: "terminal_action"
      }
    );
  }

  return normalized;
}

function clampInteger(value, defaultValue, minValue, maxValue, fieldName) {
  if (value === undefined || value === null) {
    return defaultValue;
  }

  if (!Number.isInteger(value)) {
    throw new ToolPayloadError(
      "invalid_arguments",
      `${fieldName} must be an integer.`,
      {
        field: fieldName
      }
    );
  }

  if (value < minValue || value > maxValue) {
    throw new ToolPayloadError(
      "invalid_arguments",
      `${fieldName} must be between ${minValue} and ${maxValue}.`,
      {
        field: fieldName,
        min: minValue,
        max: maxValue
      }
    );
  }

  return value;
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function toolErrorPayload(error) {
  if (error instanceof BridgeHttpError) {
    const payload = error.details && error.details.payload;
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      return payload;
    }

    return {
      ok: false,
      error: error.code,
      message: error.message,
      details: error.details
    };
  }

  if (error instanceof ToolPayloadError) {
    return {
      ok: false,
      error: error.code,
      message: error.message,
      details: error.details
    };
  }

  return {
    ok: false,
    error: "internal_error",
    message: error instanceof Error ? error.message : String(error)
  };
}

function attachInteractionHints(payload) {
  if (!isPlainObject(payload) || !isPlainObject(payload.state)) {
    return payload;
  }

  const cardSelectionBundle = buildCardSelectionBundle(payload.state);
  if (!cardSelectionBundle.in_card_selection_flow) {
    return payload;
  }

  return {
    ...payload,
    interaction_hints: {
      card_selection: {
        selected_count: cardSelectionBundle.card_selection.selected_count,
        min_select: cardSelectionBundle.card_selection.min_select,
        max_select: cardSelectionBundle.card_selection.max_select,
        option_count: cardSelectionBundle.card_selection.options.length,
        recommended_tool: "sts2_resolve_card_selection"
      }
    }
  };
}

function asToolResult(payload, isError) {
  return {
    isError,
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2)
      }
    ]
  };
}

function writeResult(id, result) {
  writeMessage({
    jsonrpc: "2.0",
    id,
    result
  });
}

function writeError(id, code, message) {
  writeMessage({
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message
    }
  });
}

function writeMessage(message) {
  logDebug(`stdout_message=${summarizeMessage(message)}`);
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function summarizeMessage(message) {
  const pieces = [];

  if (message && typeof message === "object") {
    if (Object.prototype.hasOwnProperty.call(message, "id")) {
      pieces.push(`id=${safeJson(message.id)}`);
    }

    if (message.result) {
      if (message.result.serverInfo && message.result.serverInfo.name) {
        pieces.push(`result=initialize:${message.result.serverInfo.name}`);
      } else if (Array.isArray(message.result.tools)) {
        pieces.push(`result=tools/list:${message.result.tools.length}`);
      } else {
        pieces.push("result=object");
      }
    }

    if (message.error) {
      pieces.push(`error=${safeJson(message.error.message || message.error.code)}`);
    }
  }

  return pieces.join(" ");
}

function logInfo(message) {
  writeLogLine("info", message);
  process.stderr.write(`[sts2-mcp] ${message}\n`);
}

function logDebug(message) {
  writeLogLine("debug", message);
}

function logError(message, error) {
  const detail = error instanceof Error ? error.stack || error.message : String(error);
  writeLogLine("error", `${message}: ${detail}`);
  process.stderr.write(`[sts2-mcp] ${message}: ${detail}\n`);
}

function writeLogLine(level, message) {
  try {
    const logFilePath = getLogFilePath();
    fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
    const line = `${new Date().toISOString()} ${level.toUpperCase()} ${message}\n`;
    fs.appendFileSync(logFilePath, line, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[sts2-mcp] log write failed: ${detail}\n`);
  }
}

function sanitizeForLog(value) {
  return value.replace(/\r/g, "\\r").replace(/\n/g, "\\n").slice(0, MAX_LOG_PREVIEW);
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch (error) {
    return JSON.stringify(String(value));
  }
}

class ToolPayloadError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

class BridgeHttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
