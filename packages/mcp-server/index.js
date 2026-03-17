"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { setTimeout: delay } = require("timers/promises");

const SERVER_NAME = "sts2";
const SERVER_VERSION = "0.4.11";
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
const MAP_ROUTE_SETTLE_TIMEOUT_MS = 4000;
const MAP_ROUTE_SETTLE_POLL_INTERVAL_MS = 200;
const MAP_ROUTE_STABLE_POLL_TARGET = 2;

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
    name: "sts2_get_map_routes",
    description:
      "Build a pruned future-only map route forest from the currently travelable frontier points, excluding the current node, past rows, and unreachable branches. Defaults to summary mode; use detail=full to include the full reachable node table.",
    inputSchema: {
      type: "object",
      properties: {
        detail: {
          type: "string",
          enum: ["summary", "full"]
        }
      },
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
    name: "sts2_play_card_sequence",
    description:
      "Execute multiple currently planned play_card actions in one tool call. Later steps are automatically rematched against the current hand and legal targets after each card resolves, so the caller does not need to manually rewrite hand indices after reordering or draws.",
    inputSchema: {
      type: "object",
      properties: {
        action_ids: {
          type: "array",
          minItems: 1,
          items: {
            type: "string",
            minLength: 1
          }
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
      required: ["action_ids"],
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
    name: "sts2_resolve_shop_visit",
    description:
      "Resolve a shop visit in one tool call: optionally open the merchant, buy one or more planned shop items with automatic reindexing between purchases, optionally remove one card after buying card removal, then close and/or leave the shop.",
    inputSchema: {
      type: "object",
      properties: {
        purchases: {
          type: "array",
          items: {
            type: "object",
            properties: {
              action_id: {
                type: "string",
                minLength: 1
              },
              title: {
                type: "string",
                minLength: 1
              },
              item_kind: {
                type: "string",
                enum: ["card", "relic", "potion", "card_removal"]
              }
            },
            additionalProperties: false
          }
        },
        remove_card_title: {
          type: "string",
          minLength: 1
        },
        remove_card_index: {
          type: "integer",
          minimum: 0
        },
        open_shop: {
          type: "boolean"
        },
        close_inventory: {
          type: "boolean"
        },
        leave_shop: {
          type: "boolean"
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
    case "sts2_get_map_routes":
      return await getMapRoutesTool(args);
    case "sts2_perform_action":
      return await performActionTool(args);
    case "sts2_play_card_sequence":
      return await playCardSequenceTool(args);
    case "sts2_end_turn":
      return await endTurnTool(args);
    case "sts2_resolve_room_rewards":
      return await resolveRoomRewardsTool(args);
    case "sts2_resolve_rest_site":
      return await resolveRestSiteTool(args);
    case "sts2_resolve_card_selection":
      return await resolveCardSelectionTool(args);
    case "sts2_resolve_shop_visit":
      return await resolveShopVisitTool(args);
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

async function getMapRoutesTool(args) {
  try {
    const detail = normalizeMapRoutesDetail(args?.detail);
    const session = getLiveSession();
    const settledSnapshot = await waitForStableMapRouteSnapshot(session);
    const payload = buildMapRoutesPayload(settledSnapshot.state, {
      detail,
      snapshot_status: {
        settled: settledSnapshot.settled,
        reason: settledSnapshot.reason,
        poll_count: settledSnapshot.poll_count,
        frontier_action_match: settledSnapshot.frontier_action_match,
        state_action_state_version_match:
          settledSnapshot.state_action_state_version_match
      }
    });
    return asToolResult(payload, false);
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

async function playCardSequenceTool(args) {
  try {
    const finalize = (payload) => asToolResult(attachInteractionHints(payload), false);
    const actionIds = requireNonEmptyStringArray(args.action_ids, "action_ids");
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

    if (new Set(actionIds).size !== actionIds.length) {
      throw new ToolPayloadError(
        "invalid_arguments",
        "action_ids cannot contain duplicates.",
        {
          field: "action_ids"
        }
      );
    }

    const session = getLiveSession();
    let state = await getBridgeState(session);

    if (
      Number.isInteger(expectedStateVersion) &&
      Number.isInteger(state?.state_version) &&
      state.state_version !== expectedStateVersion
    ) {
      return asToolResult(
        attachInteractionHints(
        {
          ok: false,
          resolved: false,
          reason: "state_version_mismatch",
          expected_state_version: expectedStateVersion,
          observed_state_version: state.state_version,
          state
        }),
        false
      );
    }

    const initialBlocker = getPlayCardSequenceContinuationBlocker(state);
    if (initialBlocker) {
      return finalize(
        {
          ok: false,
          resolved: false,
          ...initialBlocker,
          requested_action_count: actionIds.length,
          state
        }
      );
    }

    const initialPlayCardActions = getPlayableCardActions(state);
    const sequencePlan = [];
    for (let sequenceIndex = 0; sequenceIndex < actionIds.length; sequenceIndex += 1) {
      const requestedActionId = actionIds[sequenceIndex];
      const matchedAction = initialPlayCardActions.find(
        (action) => action?.action_id === requestedActionId
      );
      if (!matchedAction) {
        return finalize(
          {
            ok: false,
            resolved: false,
            reason: "requested_play_card_action_unavailable",
            sequence_index: sequenceIndex,
            requested_action_id: requestedActionId,
            available_play_card_actions: initialPlayCardActions.map((action) =>
              summarizeActionForAgent(action)
            ),
            state
          }
        );
      }

      sequencePlan.push(buildPlannedPlayCardSequenceStep(matchedAction, sequenceIndex));
    }
    const sequencePlanOutput = sequencePlan.map(summarizePlayCardSequencePlanStep);

    const executedSteps = [];

    for (let sequenceIndex = 0; sequenceIndex < sequencePlan.length; sequenceIndex += 1) {
      const blocker = getPlayCardSequenceContinuationBlocker(state);
      if (blocker) {
        return finalize(
          {
            ok: true,
            resolved: false,
            reason: blocker.reason,
            message: blocker.message,
            requested_action_count: sequencePlan.length,
            executed_count: executedSteps.length,
            remaining_count: sequencePlan.length - executedSteps.length,
            next_sequence_index: sequenceIndex,
            sequence_plan: sequencePlanOutput,
            executed_steps: executedSteps,
            state
          }
        );
      }

      const planStep = sequencePlan[sequenceIndex];
      const currentPlayCardActions = getPlayableCardActions(state);
      const resolution = resolvePlannedPlayCardStep(planStep, currentPlayCardActions);
      if (!resolution.action) {
        return finalize(
          {
            ok: true,
            resolved: false,
            reason: "requested_play_card_action_unavailable_after_reindex",
            requested_action_count: sequencePlan.length,
            executed_count: executedSteps.length,
            remaining_count: sequencePlan.length - executedSteps.length,
            next_sequence_index: sequenceIndex,
            failed_step: summarizePlayCardSequencePlanStep(planStep),
            sequence_plan: sequencePlanOutput,
            executed_steps: executedSteps,
            available_play_card_actions: currentPlayCardActions.map((action) =>
              summarizeActionForAgent(action)
            ),
            state
          }
        );
      }

      const result = await performBridgeAction(
        session,
        resolution.action.action_id,
        waitAfterMs
      );
      executedSteps.push({
        sequence_index: sequenceIndex,
        requested_action_id: planStep.requested_action_id,
        executed_action_id: resolution.action.action_id,
        match_type: resolution.match_type,
        compatible_candidate_count: resolution.compatible_candidate_count,
        matched_action: summarizeActionForAgent(resolution.action),
        execution: summarizeExecutedAction(result)
      });
      state = result.state;
    }

    return finalize(
      {
        ok: true,
        resolved: true,
        requested_action_count: sequencePlan.length,
        executed_count: executedSteps.length,
        remaining_count: 0,
        sequence_plan: sequencePlanOutput,
        executed_steps: executedSteps,
        state
      }
    );
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

async function resolveShopVisitTool(args) {
  try {
    const finalize = (payload) => asToolResult(attachInteractionHints(payload), false);
    const purchases = normalizeShopPurchaseRequests(args.purchases);
    const removeCardTitle = optionalString(args.remove_card_title, "remove_card_title");
    const removeCardIndex = optionalInteger(args.remove_card_index, "remove_card_index");
    const openShop = optionalBoolean(args.open_shop, "open_shop") ?? true;
    const closeInventory =
      optionalBoolean(args.close_inventory, "close_inventory") ?? true;
    const leaveShop = optionalBoolean(args.leave_shop, "leave_shop") ?? true;
    const waitAfterMs = clampInteger(
      args.wait_after_ms,
      DEFAULT_ACTION_WAIT_MS,
      0,
      MAX_ACTION_WAIT_MS,
      "wait_after_ms"
    );

    if (removeCardTitle !== undefined && removeCardIndex !== undefined) {
      throw new ToolPayloadError(
        "invalid_arguments",
        "remove_card_title and remove_card_index cannot both be provided.",
        {
          fields: ["remove_card_title", "remove_card_index"]
        }
      );
    }

    const session = getLiveSession();
    let state = await getBridgeState(session);
    let shopBundle = buildShopBundle(state);
    const initialShopBundle = shopBundle;
    let cardSelectionBundle = buildCardSelectionBundle(state);

    if (!shopBundle.in_shop_flow && !cardSelectionBundle.in_card_selection_flow) {
      return finalize({
        ok: false,
        resolved: false,
        reason: "not_in_shop_flow",
        shop_bundle: initialShopBundle,
        state
      });
    }

    const executedActions = [];
    const purchasedItems = [];
    let removedCard = null;

    if (cardSelectionBundle.in_card_selection_flow) {
      const cardSelectionResolution = await maybeResolveShopCardRemovalSelection(
        session,
        state,
        {
          removeCardTitle,
          removeCardIndex,
          waitAfterMs
        }
      );
      if (cardSelectionResolution.failed) {
        return finalize({
          ok: false,
          resolved: false,
          reason: cardSelectionResolution.reason,
          message: cardSelectionResolution.message,
          removed_card: removedCard,
          executed_actions: executedActions,
          card_selection_bundle: cardSelectionResolution.card_selection_bundle,
          available_cards: cardSelectionResolution.available_cards,
          state: cardSelectionResolution.state
        });
      }
      if (cardSelectionResolution.required_but_missing) {
        return finalize({
          ok: true,
          resolved: false,
          reason: "shop_card_removal_choice_required",
          removed_card: removedCard,
          executed_actions: executedActions,
          card_selection_bundle: cardSelectionResolution.card_selection_bundle,
          state: cardSelectionResolution.state
        });
      }
      if (cardSelectionResolution.performed) {
        removedCard = cardSelectionResolution.removed_card;
        executedActions.push(...cardSelectionResolution.executed_actions);
        state = cardSelectionResolution.state;
        shopBundle = buildShopBundle(state);
        cardSelectionBundle = buildCardSelectionBundle(state);
      }
    }

    if (openShop && shopBundle.shop.visible && shopBundle.shop.is_open !== true) {
      if (!shopBundle.non_automation_action_ids.includes("shop:open")) {
        return finalize({
          ok: false,
          resolved: false,
          reason: "shop_open_action_unavailable",
          shop_bundle: shopBundle,
          state
        });
      }

      const openResult = await performBridgeAction(session, "shop:open", waitAfterMs);
      executedActions.push(summarizeExecutedAction(openResult));
      state = openResult.state;
      shopBundle = buildShopBundle(state);
    }

    const purchasePlan = [];
    for (let sequenceIndex = 0; sequenceIndex < purchases.length; sequenceIndex += 1) {
      const request = purchases[sequenceIndex];
      const matchedAction = resolveInitialShopPurchaseRequest(request, state);
      if (!matchedAction) {
        return finalize({
          ok: false,
          resolved: false,
          reason: "shop_purchase_request_unavailable",
          sequence_index: sequenceIndex,
          request,
          shop_bundle: shopBundle,
          available_shop_actions: getShopBuyActions(state).map(summarizeShopBuyActionForAgent),
          state
        });
      }

      purchasePlan.push(
        buildPlannedShopPurchaseStep(matchedAction, request, sequenceIndex)
      );
    }
    const purchasePlanOutput = purchasePlan.map(summarizeShopPurchasePlanStep);

    for (let sequenceIndex = 0; sequenceIndex < purchasePlan.length; sequenceIndex += 1) {
      shopBundle = buildShopBundle(state);
      const blocker = getShopVisitContinuationBlocker(state);
      if (blocker) {
        return finalize({
          ok: true,
          resolved: false,
          reason: blocker.reason,
          message: blocker.message,
          next_sequence_index: sequenceIndex,
          purchase_plan: purchasePlanOutput,
          purchased_items: purchasedItems,
          removed_card: removedCard,
          executed_actions: executedActions,
          shop_bundle: shopBundle,
          state
        });
      }

      const planStep = purchasePlan[sequenceIndex];
      const currentShopActions = getShopBuyActions(state);
      const resolution = resolvePlannedShopPurchaseStep(planStep, currentShopActions);
      if (!resolution.action) {
        return finalize({
          ok: true,
          resolved: false,
          reason: "shop_purchase_unavailable_after_reindex",
          next_sequence_index: sequenceIndex,
          failed_step: summarizeShopPurchasePlanStep(planStep),
          purchase_plan: purchasePlanOutput,
          purchased_items: purchasedItems,
          removed_card: removedCard,
          executed_actions: executedActions,
          available_shop_actions: currentShopActions.map(summarizeShopBuyActionForAgent),
          shop_bundle: shopBundle,
          state
        });
      }

      const purchaseResult = await performBridgeAction(
        session,
        resolution.action.action_id,
        waitAfterMs
      );
      executedActions.push(summarizeExecutedAction(purchaseResult));
      purchasedItems.push({
        sequence_index: sequenceIndex,
        request: summarizeShopPurchaseRequest(planStep.request),
        requested_action_id: planStep.requested_action_id,
        executed_action_id: resolution.action.action_id,
        match_type: resolution.match_type,
        compatible_candidate_count: resolution.compatible_candidate_count,
        item: summarizeShopItemForAgent(resolution.action.item)
      });
      state = purchaseResult.state;

      const cardSelectionResolution = await maybeResolveShopCardRemovalSelection(
        session,
        state,
        {
          removeCardTitle,
          removeCardIndex,
          waitAfterMs
        }
      );
      if (cardSelectionResolution.required_but_missing) {
        return finalize({
          ok: true,
          resolved: false,
          reason: "shop_card_removal_choice_required",
          purchase_plan: purchasePlanOutput,
          purchased_items: purchasedItems,
          removed_card: removedCard,
          executed_actions: executedActions,
          card_selection_bundle: cardSelectionResolution.card_selection_bundle,
          state
        });
      }

      if (cardSelectionResolution.failed) {
        return finalize({
          ok: false,
          resolved: false,
          reason: cardSelectionResolution.reason,
          message: cardSelectionResolution.message,
          purchase_plan: purchasePlanOutput,
          purchased_items: purchasedItems,
          removed_card: removedCard,
          executed_actions: executedActions,
          card_selection_bundle: cardSelectionResolution.card_selection_bundle,
          available_cards: cardSelectionResolution.available_cards,
          state: cardSelectionResolution.state
        });
      }

      if (cardSelectionResolution.performed) {
        removedCard = cardSelectionResolution.removed_card;
        executedActions.push(...cardSelectionResolution.executed_actions);
        state = cardSelectionResolution.state;
      }
    }

    shopBundle = buildShopBundle(state);

    if (closeInventory && shopBundle.shop.is_open === true) {
      if (shopBundle.non_automation_action_ids.includes("shop:back")) {
        const backResult = await performBridgeAction(session, "shop:back", waitAfterMs);
        executedActions.push(summarizeExecutedAction(backResult));
        state = backResult.state;
        shopBundle = buildShopBundle(state);
      }
    }

    if (leaveShop) {
      if (shopBundle.non_automation_action_ids.includes("shop:leave")) {
        const leaveResult = await performBridgeAction(session, "shop:leave", waitAfterMs);
        executedActions.push(summarizeExecutedAction(leaveResult));
        state = leaveResult.state;
        shopBundle = buildShopBundle(state);
      }
    }

    return finalize({
      ok: true,
      resolved: true,
      purchase_plan: purchasePlanOutput,
      purchased_items: purchasedItems,
      removed_card: removedCard,
      shop_bundle: initialShopBundle,
      executed_actions: executedActions,
      final_state: state
    });
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

async function getBridgeActions(session) {
  const response = await bridgeRequestJson(session, "actions", {
    method: "GET"
  });
  return response.payload;
}

async function waitForStableMapRouteSnapshot(session) {
  let snapshot = await captureMapRouteSnapshot(session);
  let previousFingerprint = snapshot.fingerprint;
  let stablePolls = 0;

  const initialVerdict = getMapRouteSnapshotVerdict(snapshot, stablePolls);
  if (initialVerdict.settled) {
    return {
      ...initialVerdict,
      state: snapshot.state,
      frontier_action_match: snapshot.frontier_action_match,
      state_action_state_version_match: snapshot.state_action_state_version_match
    };
  }

  const startedAt = Date.now();
  let pollCount = 0;
  while (Date.now() - startedAt < MAP_ROUTE_SETTLE_TIMEOUT_MS) {
    await delay(MAP_ROUTE_SETTLE_POLL_INTERVAL_MS);
    pollCount += 1;
    snapshot = await captureMapRouteSnapshot(session);

    stablePolls =
      snapshot.fingerprint === previousFingerprint ? stablePolls + 1 : 0;
    previousFingerprint = snapshot.fingerprint;

    const verdict = getMapRouteSnapshotVerdict(snapshot, stablePolls);
    if (verdict.settled) {
      return {
        ...verdict,
        poll_count: pollCount,
        state: snapshot.state,
        frontier_action_match: snapshot.frontier_action_match,
        state_action_state_version_match:
          snapshot.state_action_state_version_match
      };
    }
  }

  return {
    settled: false,
    reason: "timeout",
    poll_count: pollCount,
    state: snapshot.state,
    frontier_action_match: snapshot.frontier_action_match,
    state_action_state_version_match: snapshot.state_action_state_version_match
  };
}

async function captureMapRouteSnapshot(session) {
  const [state, actionsPayload] = await Promise.all([
    getBridgeState(session),
    getBridgeActions(session)
  ]);
  return buildMapRouteSnapshot(state, actionsPayload);
}

function buildMapRouteSnapshot(state, actionsPayload) {
  const frontierKeys = extractTravelableMapKeysFromState(state);
  const mapActionKeys = extractMapActionKeys(actionsPayload);
  const currentCoord = extractMapCurrentCoord(state);
  const currentCoordKey = toCoordKey(currentCoord);
  const stateVersion = Number.isInteger(state?.state_version)
    ? state.state_version
    : null;
  const actionStateVersion = Number.isInteger(actionsPayload?.state_version)
    ? actionsPayload.state_version
    : null;
  const stateActionStateVersionMatch =
    stateVersion === null ||
    actionStateVersion === null ||
    stateVersion === actionStateVersion;
  const frontierActionMatch = areCoordKeySetsEqual(frontierKeys, mapActionKeys);
  const fingerprint = JSON.stringify({
    screen: typeof state?.screen === "string" ? state.screen : null,
    map_open: state?.map?.is_open === true,
    map_traveling: state?.map?.is_traveling === true,
    current_coord_key: currentCoordKey,
    frontier_keys: frontierKeys,
    map_action_keys: mapActionKeys,
    state_version: stateVersion,
    action_state_version: actionStateVersion
  });

  return {
    state,
    actions_payload: actionsPayload,
    frontierKeys,
    mapActionKeys,
    currentCoordKey,
    frontier_action_match: frontierActionMatch,
    state_action_state_version_match: stateActionStateVersionMatch,
    fingerprint
  };
}

function getMapRouteSnapshotVerdict(snapshot, stablePolls) {
  const state = snapshot?.state;
  if (!isPlainObject(state)) {
    return {
      settled: false,
      reason: "missing_state"
    };
  }

  const screen = typeof state.screen === "string" ? state.screen : null;
  if (screen !== "MAP") {
    return {
      settled: false,
      reason: `waiting_for_map_screen:${screen ?? "unknown"}`
    };
  }

  if (state?.map?.is_open !== true) {
    return {
      settled: false,
      reason: "waiting_for_map_open"
    };
  }

  if (state?.map?.is_traveling === true) {
    return {
      settled: false,
      reason: "waiting_for_map_travel_finish"
    };
  }

  if (!snapshot.state_action_state_version_match) {
    return {
      settled: false,
      reason: "waiting_for_state_action_version_match"
    };
  }

  if (!snapshot.frontier_action_match) {
    return {
      settled: false,
      reason: "waiting_for_frontier_action_match"
    };
  }

  if (stablePolls < MAP_ROUTE_STABLE_POLL_TARGET) {
    return {
      settled: false,
      reason: `waiting_for_stable_map_snapshot:${stablePolls}/${MAP_ROUTE_STABLE_POLL_TARGET}`
    };
  }

  return {
    settled: true,
    reason: "map_snapshot_stable",
    poll_count: 0
  };
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
  } else if (settleStrategy === "screen_transition") {
    settled = await waitForScreenTransitionSettlement(session, actionId, result?.state ?? null);
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

  if (actionId === "main_menu:continue") {
    return "screen_transition";
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

async function waitForScreenTransitionSettlement(session, actionId, initialState) {
  let state = initialState;
  const initialScreen = typeof initialState?.screen === "string" ? initialState.screen : null;

  const initialVerdict = getScreenTransitionSettlementVerdict(actionId, state, initialScreen);
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
  while (Date.now() - startedAt < ROOM_EXIT_SETTLE_TIMEOUT_MS) {
    await delay(ROOM_EXIT_SETTLE_POLL_INTERVAL_MS);
    pollCount += 1;
    state = await getBridgeState(session);

    const verdict = getScreenTransitionSettlementVerdict(actionId, state, initialScreen);
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

function getScreenTransitionSettlementVerdict(actionId, state, initialScreen) {
  if (!isPlainObject(state)) {
    return {
      settled: false,
      reason: "missing_state"
    };
  }

  const screen = typeof state.screen === "string" ? state.screen : null;
  const stableReason = getOutOfCombatStableStateReason(state);

  if (actionId === "main_menu:continue") {
    if (state?.main_menu?.visible === true || screen === "MAIN_MENU") {
      return {
        settled: false,
        reason: "waiting_for_main_menu_exit"
      };
    }

    if (stableReason) {
      return {
        settled: true,
        reason: stableReason
      };
    }

    return {
      settled: false,
      reason:
        screen !== null && screen !== initialScreen
          ? `waiting_for_stable_loaded_run_state:${screen}`
          : "waiting_for_loaded_run_state"
    };
  }

  return {
    settled: false,
    reason: "unsupported_transition_action"
  };
}

function getEndTurnSettlementVerdict(state, stablePolls) {
  if (!state || typeof state !== "object") {
    return {
      settled: false,
      reason: "missing_state"
    };
  }

  const roomTransitionReason = getOutOfCombatStableStateReason(state);
  if (roomTransitionReason) {
    return {
      settled: true,
      reason: roomTransitionReason
    };
  }

  if (typeof state.screen === "string" && state.screen !== "COMBAT") {
    return {
      settled: false,
      reason: `waiting_for_room_transition:${state.screen}`
    };
  }

  const combat = isPlainObject(state.combat) ? state.combat : {};
  if (combat.in_progress !== true) {
    return {
      settled: false,
      reason: "waiting_for_room_transition"
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

  const roomTransitionReason = getOutOfCombatStableStateReason(state);
  if (roomTransitionReason) {
    return {
      settled: true,
      reason: roomTransitionReason
    };
  }

  const cardSelectionBundle = buildCardSelectionBundle(state);
  if (cardSelectionBundle.in_card_selection_flow) {
    return {
      settled: true,
      reason: "card_selection_ready"
    };
  }

  if (typeof state.screen === "string" && state.screen !== "COMBAT") {
    return {
      settled: false,
      reason: `waiting_for_room_transition:${state.screen}`
    };
  }

  const combat = isPlainObject(state?.combat) ? state.combat : {};
  if (combat.in_progress !== true) {
    return {
      settled: false,
      reason: "waiting_for_room_transition"
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

function getOutOfCombatStableStateReason(state) {
  if (!isPlainObject(state)) {
    return null;
  }

  const cardSelectionBundle = buildCardSelectionBundle(state);
  if (cardSelectionBundle.in_card_selection_flow) {
    return "card_selection_ready";
  }

  const rewardBundle = buildRewardBundle(state);
  if (
    rewardBundle.in_reward_flow &&
    (rewardBundle.rewards.visible ||
      rewardBundle.card_reward_selection.visible ||
      rewardBundle.has_proceed)
  ) {
    return rewardBundle.card_reward_selection.visible
      ? "reward_card_selection_ready"
      : "reward_flow_ready";
  }

  const restSiteBundle = buildRestSiteBundle(state);
  if (
    restSiteBundle.in_rest_site_flow &&
    (restSiteBundle.rest_site.visible ||
      restSiteBundle.rest_site.proceed_visible ||
      restSiteBundle.deck_upgrade_selection.visible)
  ) {
    return restSiteBundle.deck_upgrade_selection.visible
      ? "rest_site_upgrade_ready"
      : "rest_site_ready";
  }

  if (isMapReadyState(state)) {
    return "map_ready";
  }

  if (state?.event_options?.visible === true) {
    return "event_ready";
  }

  if (state?.shop?.visible === true || state?.shop?.is_open === true) {
    return "shop_ready";
  }

  return null;
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

function isPlayCardAction(action) {
  return (
    isPlainObject(action) &&
    typeof action.action_id === "string" &&
    action.action_id.startsWith("play_card:")
  );
}

function getPlayableCardActions(state) {
  return getNonAutomationActions(state).filter(isPlayCardAction);
}

function getPlayCardSequenceContinuationBlocker(state) {
  if (!isPlainObject(state)) {
    return {
      reason: "missing_state",
      message: "Bridge state was missing while resolving the play-card sequence."
    };
  }

  const cardSelectionBundle = buildCardSelectionBundle(state);
  if (cardSelectionBundle.in_card_selection_flow) {
    return {
      reason: "card_selection_ready",
      message: "Card selection became visible before the requested play-card sequence finished."
    };
  }

  const rewardBundle = buildRewardBundle(state);
  if (rewardBundle.in_reward_flow) {
    return {
      reason: rewardBundle.card_reward_selection.visible
        ? "reward_card_selection_ready"
        : "reward_flow_ready",
      message: "Combat transitioned into rewards before the requested play-card sequence finished."
    };
  }

  const screen = typeof state.screen === "string" ? state.screen : null;
  if (screen !== "COMBAT") {
    return {
      reason: `screen:${screen ?? "unknown"}`,
      message: "The game is no longer on the combat screen."
    };
  }

  const combat = isPlainObject(state.combat) ? state.combat : {};
  if (combat.in_progress !== true) {
    return {
      reason: "combat_not_in_progress",
      message: "Combat is no longer in progress."
    };
  }

  if (combat.current_side !== "Player") {
    return {
      reason: "not_player_turn",
      message: "It is no longer the player's turn."
    };
  }

  if (combat.is_play_phase !== true) {
    return {
      reason: "not_play_phase",
      message: "Combat is not currently in the play phase."
    };
  }

  if (combat.player_actions_disabled === true) {
    return {
      reason: "player_actions_disabled",
      message: "Player actions are currently disabled."
    };
  }

  return null;
}

function buildPlannedPlayCardSequenceStep(action, sequenceIndex) {
  const targetActionSuffix =
    typeof action?.target_action_suffix === "string" ? action.target_action_suffix : null;
  const targetCombatId = Number.isFinite(action?.target_combat_id)
    ? action.target_combat_id
    : null;
  const targetSide = typeof action?.target_side === "string" ? action.target_side : null;
  const targetName = normalizeAgentText(action?.target_name);

  return {
    sequence_index: sequenceIndex,
    requested_action_id: action.action_id,
    player_index: Number.isInteger(action?.player_index) ? action.player_index : null,
    initial_hand_index: Number.isInteger(action?.hand_index) ? action.hand_index : null,
    card: summarizeCardForAgent(action?.card),
    target: {
      action_suffix: targetActionSuffix,
      combat_id: targetCombatId,
      side: targetSide,
      name: targetName
    },
    action_fingerprint: buildPlayCardActionFingerprint(action)
  };
}

function summarizePlayCardSequencePlanStep(planStep) {
  if (!isPlainObject(planStep)) {
    return null;
  }

  return {
    sequence_index: Number.isInteger(planStep.sequence_index) ? planStep.sequence_index : null,
    requested_action_id:
      typeof planStep.requested_action_id === "string" ? planStep.requested_action_id : null,
    player_index: Number.isInteger(planStep.player_index) ? planStep.player_index : null,
    initial_hand_index:
      Number.isInteger(planStep.initial_hand_index) ? planStep.initial_hand_index : null,
    card: isPlainObject(planStep.card) ? planStep.card : null,
    target: isPlainObject(planStep.target) ? planStep.target : null
  };
}

function resolvePlannedPlayCardStep(planStep, currentPlayCardActions) {
  const actions = Array.isArray(currentPlayCardActions) ? currentPlayCardActions : [];
  const exactMatch = actions.find(
    (action) =>
      action?.action_id === planStep?.requested_action_id &&
      doesPlayCardActionMatchPlanStep(action, planStep)
  );
  if (exactMatch) {
    return {
      action: exactMatch,
      match_type: "exact",
      compatible_candidate_count: 1
    };
  }

  const compatibleActions = actions.filter((action) =>
    doesPlayCardActionMatchPlanStep(action, planStep)
  );
  if (compatibleActions.length <= 0) {
    return {
      action: null,
      match_type: "unavailable",
      compatible_candidate_count: 0
    };
  }

  const rankedActions = compatibleActions
    .map((action) => ({
      action,
      score: scorePlayCardActionAgainstPlanStep(action, planStep)
    }))
    .sort((left, right) => right.score - left.score);

  return {
    action: rankedActions[0].action,
    match_type: compatibleActions.length === 1 ? "reindexed" : "reindexed_ambiguous",
    compatible_candidate_count: compatibleActions.length
  };
}

function doesPlayCardActionMatchPlanStep(action, planStep) {
  if (!isPlayCardAction(action) || !isPlainObject(planStep)) {
    return false;
  }

  if (
    Number.isInteger(planStep.player_index) &&
    Number.isInteger(action?.player_index) &&
    action.player_index !== planStep.player_index
  ) {
    return false;
  }

  if (
    buildPlayCardActionFingerprint(action) !== planStep.action_fingerprint
  ) {
    return false;
  }

  const planTargetSuffix =
    typeof planStep?.target?.action_suffix === "string"
      ? planStep.target.action_suffix
      : null;
  const actionTargetSuffix =
    typeof action?.target_action_suffix === "string" ? action.target_action_suffix : null;
  if (planTargetSuffix !== actionTargetSuffix) {
    return false;
  }

  const planTargetCombatId = Number.isFinite(planStep?.target?.combat_id)
    ? planStep.target.combat_id
    : null;
  const actionTargetCombatId = Number.isFinite(action?.target_combat_id)
    ? action.target_combat_id
    : null;
  if (planTargetCombatId !== null && actionTargetCombatId !== planTargetCombatId) {
    return false;
  }

  return true;
}

function scorePlayCardActionAgainstPlanStep(action, planStep) {
  let score = 0;

  const actionHandIndex = Number.isInteger(action?.hand_index) ? action.hand_index : null;
  const planHandIndex = Number.isInteger(planStep?.initial_hand_index)
    ? planStep.initial_hand_index
    : null;
  if (actionHandIndex !== null && planHandIndex !== null) {
    score += 20 - Math.min(Math.abs(actionHandIndex - planHandIndex), 20);
  }

  if (
    Number.isFinite(action?.target_combat_id) &&
    Number.isFinite(planStep?.target?.combat_id) &&
    action.target_combat_id === planStep.target.combat_id
  ) {
    score += 5;
  }

  if (
    typeof action?.target_action_suffix === "string" &&
    typeof planStep?.target?.action_suffix === "string" &&
    action.target_action_suffix === planStep.target.action_suffix
  ) {
    score += 3;
  }

  return score;
}

function buildStableCardTextFingerprint(value) {
  const normalized = normalizeAgentText(value);
  if (typeof normalized !== "string" || !normalized.trim()) {
    return null;
  }

  return normalized
    .replace(/\d+(?:[.,]\d+)?/g, "#")
    .replace(/\s+/g, " ")
    .trim();
}

function compareNullableFingerprintNumbers(left, right) {
  const leftNumber = Number.isFinite(left) ? left : null;
  const rightNumber = Number.isFinite(right) ? right : null;

  if (leftNumber === rightNumber) {
    return 0;
  }

  if (leftNumber === null) {
    return -1;
  }

  if (rightNumber === null) {
    return 1;
  }

  return leftNumber - rightNumber;
}

function buildCardDynamicVarFingerprint(dynamicVars) {
  if (!Array.isArray(dynamicVars) || dynamicVars.length <= 0) {
    return [];
  }

  return dynamicVars
    .filter(
      (entry) => isPlainObject(entry) && typeof entry.name === "string" && entry.name.trim()
    )
    .map((entry) => ({
      name: entry.name,
      base_value: Number.isFinite(entry.base_value) ? entry.base_value : null,
      enchanted_value: Number.isFinite(entry.enchanted_value) ? entry.enchanted_value : null
    }))
    .sort((left, right) => {
      const nameComparison = left.name.localeCompare(right.name);
      if (nameComparison !== 0) {
        return nameComparison;
      }

      const baseComparison = compareNullableFingerprintNumbers(
        left.base_value,
        right.base_value
      );
      if (baseComparison !== 0) {
        return baseComparison;
      }

      return compareNullableFingerprintNumbers(
        left.enchanted_value,
        right.enchanted_value
      );
    });
}

function buildPlayCardActionFingerprint(action) {
  const card = isPlainObject(action?.card) ? action.card : {};

  // Keep this fingerprint stable across target-state-dependent preview changes
  // such as Vulnerable, Strength, or kill-trigger resource refunds. Dynamic
  // preview values are useful for scoring decisions, but too unstable for
  // same-card rematching after earlier sequence steps resolve.
  return JSON.stringify({
    card_id: typeof card.id === "string" ? card.id : null,
    title: normalizeAgentText(card.title),
    description_shape: buildStableCardTextFingerprint(card.description),
    type: typeof card.type === "string" ? card.type : null,
    rarity: typeof card.rarity === "string" ? card.rarity : null,
    target_type: typeof card.target_type === "string" ? card.target_type : null,
    canonical_energy_cost: Number.isInteger(card.canonical_energy_cost)
      ? card.canonical_energy_cost
      : null,
    canonical_star_cost: Number.isInteger(card.canonical_star_cost)
      ? card.canonical_star_cost
      : null,
    costs_x: card.costs_x === true,
    has_star_cost_x: card.has_star_cost_x === true,
    dynamic_vars: buildCardDynamicVarFingerprint(card.dynamic_vars)
  });
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

function buildShopBundle(state) {
  const screen = typeof state?.screen === "string" ? state.screen : null;
  const rawShop = isPlainObject(state?.shop) ? state.shop : {};
  const items = Array.isArray(rawShop.items)
    ? rawShop.items.map((item) => ({
        index: Number.isInteger(item?.index) ? item.index : null,
        item_kind: typeof item?.item_kind === "string" ? item.item_kind : null,
        title: typeof item?.title === "string" ? item.title : null,
        description: typeof item?.description === "string" ? item.description : null,
        cost: Number.isFinite(item?.cost) ? item.cost : null,
        is_affordable: item?.is_affordable === true,
        used: typeof item?.used === "boolean" ? item.used : null,
        card: item?.card ?? null,
        relic: item?.relic ?? null,
        potion: item?.potion ?? null
      }))
    : [];
  const nonAutomationActionIds = getNonAutomationActions(state)
    .map((action) => action?.action_id)
    .filter((actionId) => typeof actionId === "string");

  return {
    in_shop_flow:
      rawShop.visible === true ||
      rawShop.is_open === true ||
      screen === "SHOP" ||
      nonAutomationActionIds.some((actionId) => actionId.startsWith("shop:")),
    screen,
    shop: {
      visible: rawShop.visible === true,
      is_open: rawShop.is_open === true,
      gold: Number.isFinite(rawShop.gold) ? rawShop.gold : null,
      merchant_button_visible: rawShop.merchant_button_visible === true,
      back_button_visible: rawShop.back_button_visible === true,
      proceed_visible: rawShop.proceed_visible === true,
      items
    },
    non_automation_action_ids: nonAutomationActionIds
  };
}

function normalizeShopPurchaseRequests(value) {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new ToolPayloadError(
      "invalid_arguments",
      "purchases must be an array when provided.",
      {
        field: "purchases"
      }
    );
  }

  return value.map((entry, index) => {
    if (!isPlainObject(entry)) {
      throw new ToolPayloadError(
        "invalid_arguments",
        `purchases[${index}] must be an object.`,
        {
          field: `purchases[${index}]`
        }
      );
    }

    const actionId = optionalString(entry.action_id, `purchases[${index}].action_id`);
    const title = optionalString(entry.title, `purchases[${index}].title`);
    const itemKind = normalizeOptionalShopItemKind(
      entry.item_kind,
      `purchases[${index}].item_kind`
    );

    if (actionId === undefined && title === undefined) {
      throw new ToolPayloadError(
        "invalid_arguments",
        `purchases[${index}] must provide action_id or title.`,
        {
          field: `purchases[${index}]`
        }
      );
    }

    return {
      action_id: actionId,
      title: title === undefined ? undefined : normalizeAgentText(title) ?? title.trim(),
      item_kind: itemKind
    };
  });
}

function normalizeOptionalShopItemKind(value, fieldName) {
  if (value === undefined) {
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

  const normalized = value.trim();
  if (["card", "relic", "potion", "card_removal"].includes(normalized)) {
    return normalized;
  }

  throw new ToolPayloadError(
    "invalid_arguments",
    `${fieldName} must be one of: card, relic, potion, card_removal.`,
    {
      field: fieldName
    }
  );
}

function normalizeTextComparisonKey(value) {
  const normalized = normalizeAgentText(value);
  if (typeof normalized !== "string" || !normalized.trim()) {
    return null;
  }

  return normalized.trim().toLowerCase();
}

function isShopBuyAction(action) {
  return (
    isPlainObject(action) &&
    typeof action.action_id === "string" &&
    action.action_id.startsWith("shop:buy:")
  );
}

function getShopBuyActions(state) {
  return getNonAutomationActions(state).filter(isShopBuyAction);
}

function summarizeShopBuyActionForAgent(action) {
  if (!isShopBuyAction(action)) {
    return summarizeActionForAgent(action);
  }

  return {
    action_id: action.action_id,
    label: normalizeAgentText(action.label),
    item: summarizeShopItemForAgent(action.item)
  };
}

function getShopActionIndex(action) {
  if (Number.isInteger(action?.index)) {
    return action.index;
  }

  if (Number.isInteger(action?.item?.index)) {
    return action.item.index;
  }

  return parseIndexedActionId(action?.action_id, "shop:buy:");
}

function parseIndexedActionId(actionId, prefix) {
  if (typeof actionId !== "string" || typeof prefix !== "string") {
    return null;
  }

  if (!actionId.startsWith(prefix)) {
    return null;
  }

  const suffix = actionId.slice(prefix.length);
  return /^\d+$/.test(suffix) ? Number.parseInt(suffix, 10) : null;
}

function getShopActionTitle(action) {
  if (typeof action?.item?.title === "string" && action.item.title.trim()) {
    return normalizeAgentText(action.item.title);
  }

  if (typeof action?.label === "string" && action.label.trim()) {
    return normalizeAgentText(action.label);
  }

  return null;
}

function getShopActionItemKind(action) {
  const itemKind =
    typeof action?.item?.item_kind === "string" ? action.item.item_kind.trim() : null;
  return itemKind && ["card", "relic", "potion", "card_removal"].includes(itemKind)
    ? itemKind
    : null;
}

function resolveInitialShopPurchaseRequest(request, state) {
  const actions = getShopBuyActions(state);
  if (actions.length <= 0 || !isPlainObject(request)) {
    return null;
  }

  const requestTitleKey = normalizeTextComparisonKey(request.title);
  const requestItemKind = normalizeOptionalShopItemKind(
    request.item_kind,
    "request.item_kind"
  );
  const hasDescriptor = requestTitleKey !== null || requestItemKind !== undefined;

  if (!hasDescriptor) {
    return typeof request.action_id === "string"
      ? actions.find((action) => action.action_id === request.action_id) ?? null
      : null;
  }

  const compatibleActions = actions.filter((action) => {
    if (requestItemKind !== undefined && getShopActionItemKind(action) !== requestItemKind) {
      return false;
    }

    if (requestTitleKey !== null && normalizeTextComparisonKey(getShopActionTitle(action)) !== requestTitleKey) {
      return false;
    }

    return true;
  });

  if (compatibleActions.length <= 0) {
    return null;
  }

  if (typeof request.action_id === "string") {
    const exactAction = compatibleActions.find(
      (action) => action.action_id === request.action_id
    );
    if (exactAction) {
      return exactAction;
    }
  }

  return compatibleActions
    .map((action) => ({
      action,
      score: scoreShopBuyActionAgainstRequest(action, request)
    }))
    .sort((left, right) => right.score - left.score)[0].action;
}

function scoreShopBuyActionAgainstRequest(action, request) {
  let score = 0;

  if (typeof request?.action_id === "string") {
    if (action?.action_id === request.action_id) {
      score += 100;
    }

    const requestedIndex = parseIndexedActionId(request.action_id, "shop:buy:");
    const actionIndex = getShopActionIndex(action);
    if (requestedIndex !== null && actionIndex !== null) {
      score += 20 - Math.min(Math.abs(actionIndex - requestedIndex), 20);
    }
  }

  const requestTitleKey = normalizeTextComparisonKey(request?.title);
  if (requestTitleKey !== null && normalizeTextComparisonKey(getShopActionTitle(action)) === requestTitleKey) {
    score += 30;
  }

  if (
    typeof request?.item_kind === "string" &&
    getShopActionItemKind(action) === request.item_kind
  ) {
    score += 15;
  }

  return score;
}

function buildPlannedShopPurchaseStep(action, request, sequenceIndex) {
  return {
    sequence_index: sequenceIndex,
    request: summarizeShopPurchaseRequest(request),
    requested_action_id: typeof request?.action_id === "string" ? request.action_id : null,
    initial_action_id: typeof action?.action_id === "string" ? action.action_id : null,
    initial_shop_index: getShopActionIndex(action),
    item: summarizeShopItemForAgent(action?.item),
    action_fingerprint: buildShopBuyActionFingerprint(action)
  };
}

function summarizeShopPurchasePlanStep(planStep) {
  if (!isPlainObject(planStep)) {
    return null;
  }

  return {
    sequence_index: Number.isInteger(planStep.sequence_index) ? planStep.sequence_index : null,
    request: summarizeShopPurchaseRequest(planStep.request),
    requested_action_id:
      typeof planStep.requested_action_id === "string" ? planStep.requested_action_id : null,
    initial_action_id:
      typeof planStep.initial_action_id === "string" ? planStep.initial_action_id : null,
    initial_shop_index:
      Number.isInteger(planStep.initial_shop_index) ? planStep.initial_shop_index : null,
    item: summarizeShopItemForAgent(planStep.item)
  };
}

function getShopVisitContinuationBlocker(state) {
  if (!isPlainObject(state)) {
    return {
      reason: "missing_state",
      message: "Bridge state was missing while resolving the shop visit."
    };
  }

  const cardSelectionBundle = buildCardSelectionBundle(state);
  if (cardSelectionBundle.in_card_selection_flow && cardSelectionBundle.card_selection.visible) {
    return {
      reason: "card_selection_ready",
      message: "Card selection became visible before the requested shop visit finished."
    };
  }

  const shopBundle = buildShopBundle(state);
  if (!shopBundle.in_shop_flow) {
    return {
      reason: `screen:${typeof state.screen === "string" ? state.screen : "unknown"}`,
      message: "The game is no longer in a shop-related flow."
    };
  }

  if (shopBundle.shop.visible && shopBundle.shop.is_open !== true && getShopBuyActions(state).length <= 0) {
    return {
      reason: "shop_inventory_closed",
      message: "Merchant inventory is not open."
    };
  }

  return null;
}

function resolvePlannedShopPurchaseStep(planStep, currentShopActions) {
  const actions = Array.isArray(currentShopActions) ? currentShopActions : [];
  const exactCandidateIds = [
    typeof planStep?.initial_action_id === "string" ? planStep.initial_action_id : null,
    typeof planStep?.requested_action_id === "string" ? planStep.requested_action_id : null
  ].filter((value, index, array) => typeof value === "string" && array.indexOf(value) === index);

  const exactMatch = actions.find(
    (action) =>
      exactCandidateIds.includes(action?.action_id) &&
      doesShopBuyActionMatchPlanStep(action, planStep)
  );
  if (exactMatch) {
    return {
      action: exactMatch,
      match_type: "exact",
      compatible_candidate_count: 1
    };
  }

  const compatibleActions = actions.filter((action) =>
    doesShopBuyActionMatchPlanStep(action, planStep)
  );
  if (compatibleActions.length <= 0) {
    return {
      action: null,
      match_type: "unavailable",
      compatible_candidate_count: 0
    };
  }

  const rankedActions = compatibleActions
    .map((action) => ({
      action,
      score: scoreShopBuyActionAgainstPlanStep(action, planStep)
    }))
    .sort((left, right) => right.score - left.score);

  return {
    action: rankedActions[0].action,
    match_type: compatibleActions.length === 1 ? "reindexed" : "reindexed_ambiguous",
    compatible_candidate_count: compatibleActions.length
  };
}

function doesShopBuyActionMatchPlanStep(action, planStep) {
  if (!isShopBuyAction(action) || !isPlainObject(planStep)) {
    return false;
  }

  return buildShopBuyActionFingerprint(action) === planStep.action_fingerprint;
}

function scoreShopBuyActionAgainstPlanStep(action, planStep) {
  let score = 0;

  if (action?.action_id === planStep?.initial_action_id) {
    score += 100;
  }

  if (action?.action_id === planStep?.requested_action_id) {
    score += 80;
  }

  const actionIndex = getShopActionIndex(action);
  const initialIndex = Number.isInteger(planStep?.initial_shop_index)
    ? planStep.initial_shop_index
    : parseIndexedActionId(planStep?.initial_action_id, "shop:buy:");
  if (actionIndex !== null && initialIndex !== null) {
    score += 20 - Math.min(Math.abs(actionIndex - initialIndex), 20);
  }

  const requestTitleKey = normalizeTextComparisonKey(planStep?.request?.title);
  if (requestTitleKey !== null && normalizeTextComparisonKey(getShopActionTitle(action)) === requestTitleKey) {
    score += 10;
  }

  if (
    typeof planStep?.request?.item_kind === "string" &&
    getShopActionItemKind(action) === planStep.request.item_kind
  ) {
    score += 5;
  }

  return score;
}

function buildShopBuyActionFingerprint(action) {
  const item = isPlainObject(action?.item) ? action.item : {};
  const card = isPlainObject(item.card) ? item.card : {};
  const relic = isPlainObject(item.relic) ? item.relic : {};
  const potion = isPlainObject(item.potion) ? item.potion : {};
  const effectPreview = isPlainObject(card.effect_preview) ? card.effect_preview : {};

  return JSON.stringify({
    item_kind: getShopActionItemKind(action),
    title: normalizeAgentText(item.title),
    description: normalizeAgentText(item.description),
    cost: Number.isFinite(item.cost) ? item.cost : null,
    used: typeof item.used === "boolean" ? item.used : null,
    card: {
      id: typeof card.id === "string" ? card.id : null,
      title: normalizeAgentText(card.title),
      description: normalizeAgentText(card.description),
      type: typeof card.type === "string" ? card.type : null,
      target_type: typeof card.target_type === "string" ? card.target_type : null,
      canonical_energy_cost: Number.isInteger(card.canonical_energy_cost)
        ? card.canonical_energy_cost
        : null,
      resolved_energy_cost: Number.isInteger(card.resolved_energy_cost)
        ? card.resolved_energy_cost
        : null,
      effect_preview: {
        summary: normalizeAgentText(effectPreview.summary),
        total_damage: Number.isFinite(effectPreview.total_damage)
          ? effectPreview.total_damage
          : null,
        damage_per_hit: Number.isFinite(effectPreview.damage_per_hit)
          ? effectPreview.damage_per_hit
          : null,
        hits: Number.isFinite(effectPreview.hits) ? effectPreview.hits : null,
        total_block: Number.isFinite(effectPreview.total_block)
          ? effectPreview.total_block
          : null,
        draw: Number.isFinite(effectPreview.draw) ? effectPreview.draw : null,
        heal: Number.isFinite(effectPreview.heal) ? effectPreview.heal : null,
        weak: Number.isFinite(effectPreview.weak) ? effectPreview.weak : null,
        vulnerable: Number.isFinite(effectPreview.vulnerable)
          ? effectPreview.vulnerable
          : null,
        strength: Number.isFinite(effectPreview.strength) ? effectPreview.strength : null,
        dexterity: Number.isFinite(effectPreview.dexterity)
          ? effectPreview.dexterity
          : null,
        x_cost_value: Number.isFinite(effectPreview.x_cost_value)
          ? effectPreview.x_cost_value
          : null,
        x_cost_semantics:
          typeof effectPreview.x_cost_semantics === "string"
            ? effectPreview.x_cost_semantics
            : null
      }
    },
    relic: {
      id: typeof relic.id === "string" ? relic.id : null,
      title: normalizeAgentText(relic.title),
      description: normalizeAgentText(relic.description),
      rarity: typeof relic.rarity === "string" ? relic.rarity : null
    },
    potion: {
      id: typeof potion.id === "string" ? potion.id : null,
      title: normalizeAgentText(potion.title),
      description: normalizeAgentText(potion.description),
      rarity: typeof potion.rarity === "string" ? potion.rarity : null,
      target_type: typeof potion.target_type === "string" ? potion.target_type : null
    }
  });
}

function summarizeShopPurchaseRequest(request) {
  if (!isPlainObject(request)) {
    return null;
  }

  return {
    action_id: typeof request.action_id === "string" ? request.action_id : null,
    title: normalizeAgentText(request.title),
    item_kind: typeof request.item_kind === "string" ? request.item_kind : null
  };
}

function summarizeCardSelectionOptionForAgent(option, fallbackIndex = null) {
  if (!isPlainObject(option)) {
    return null;
  }

  const optionIndex = Number.isInteger(option.index) ? option.index : fallbackIndex;
  return {
    index: Number.isInteger(optionIndex) ? optionIndex : null,
    is_selected: option.is_selected === true,
    card: summarizeCardForAgent(option.card)
  };
}

function resolveShopCardRemovalOption(cardSelectionBundle, options) {
  const visibleOptions = Array.isArray(cardSelectionBundle?.card_selection?.options)
    ? cardSelectionBundle.card_selection.options
    : [];
  const normalizedOptions = visibleOptions.map((option, fallbackIndex) => ({
    option,
    option_index: Number.isInteger(option?.index) ? option.index : fallbackIndex,
    title_key: normalizeTextComparisonKey(option?.card?.title)
  }));

  if (Number.isInteger(options?.removeCardIndex)) {
    const indexedMatch = normalizedOptions.find(
      (entry) => entry.option_index === options.removeCardIndex
    );
    if (!indexedMatch) {
      return {
        option: null,
        reason: "shop_card_removal_index_unavailable",
        message: `Card removal option ${options.removeCardIndex} is not available.`,
        available_cards: normalizedOptions
          .map((entry) => summarizeCardSelectionOptionForAgent(entry.option, entry.option_index))
          .filter((entry) => entry !== null)
      };
    }

    return {
      option: {
        ...indexedMatch.option,
        index: indexedMatch.option_index
      },
      match_type: "index",
      compatible_option_count: 1
    };
  }

  const requestedTitleKey = normalizeTextComparisonKey(options?.removeCardTitle);
  if (requestedTitleKey === null) {
    return {
      option: null,
      reason: "shop_card_removal_target_missing",
      message: "No card removal target was provided."
    };
  }

  const titleMatches = normalizedOptions.filter(
    (entry) => entry.title_key !== null && entry.title_key === requestedTitleKey
  );
  if (titleMatches.length <= 0) {
    return {
      option: null,
      reason: "shop_card_removal_title_unavailable",
      message: `No visible card removal option matched ${options.removeCardTitle}.`,
      available_cards: normalizedOptions
        .map((entry) => summarizeCardSelectionOptionForAgent(entry.option, entry.option_index))
        .filter((entry) => entry !== null)
    };
  }

  return {
    option: {
      ...titleMatches[0].option,
      index: titleMatches[0].option_index
    },
    match_type: titleMatches.length === 1 ? "title" : "title_ambiguous",
    compatible_option_count: titleMatches.length
  };
}

async function maybeResolveShopCardRemovalSelection(session, state, options) {
  const executedActions = [];
  const cardSelectionBundle = buildCardSelectionBundle(state);
  const summarizedBundle = summarizeCardSelectionBundleForAgent(cardSelectionBundle);

  if (!cardSelectionBundle.in_card_selection_flow || !cardSelectionBundle.card_selection.visible) {
    return {
      performed: false,
      required_but_missing: false,
      failed: false,
      executed_actions: executedActions,
      card_selection_bundle: summarizedBundle,
      state
    };
  }

  if (options?.removeCardTitle === undefined && options?.removeCardIndex === undefined) {
    return {
      performed: false,
      required_but_missing: true,
      failed: false,
      executed_actions: executedActions,
      card_selection_bundle: summarizedBundle,
      state
    };
  }

  const selectionResolution = resolveShopCardRemovalOption(cardSelectionBundle, options);
  if (!selectionResolution.option || !Number.isInteger(selectionResolution.option.index)) {
    return {
      performed: false,
      required_but_missing: false,
      failed: true,
      reason: selectionResolution.reason ?? "shop_card_removal_target_unavailable",
      message:
        selectionResolution.message ??
        "The requested card removal target is not available in the current selection.",
      executed_actions: executedActions,
      card_selection_bundle: summarizedBundle,
      available_cards: selectionResolution.available_cards ?? [],
      state
    };
  }

  const selectActionId = `card_selection:select:${selectionResolution.option.index}`;
  if (!cardSelectionBundle.non_automation_action_ids.includes(selectActionId)) {
    return {
      performed: false,
      required_but_missing: false,
      failed: true,
      reason: "shop_card_removal_select_action_unavailable",
      message: `The bridge did not expose ${selectActionId} for the current card selection.`,
      executed_actions: executedActions,
      card_selection_bundle: summarizedBundle,
      available_cards:
        selectionResolution.available_cards ??
        cardSelectionBundle.card_selection.options
          .map((option, fallbackIndex) =>
            summarizeCardSelectionOptionForAgent(option, fallbackIndex)
          )
          .filter((entry) => entry !== null),
      state
    };
  }

  const selectedCardSummary = summarizeCardForAgent(selectionResolution.option.card);
  const waitAfterMs = Number.isInteger(options?.waitAfterMs)
    ? options.waitAfterMs
    : DEFAULT_ACTION_WAIT_MS;

  const selectResult = await performBridgeAction(session, selectActionId, waitAfterMs);
  executedActions.push(summarizeExecutedAction(selectResult));
  state = selectResult.state;

  let finalBundle = buildCardSelectionBundle(state);
  if (finalBundle.in_card_selection_flow && finalBundle.card_selection.visible) {
    if (!finalBundle.non_automation_action_ids.includes("card_selection:confirm")) {
      return {
        performed: false,
        required_but_missing: false,
        failed: true,
        reason: "shop_card_removal_confirmation_unavailable",
        message: "Card removal selection stayed open, but confirm was not available.",
        executed_actions: executedActions,
        card_selection_bundle: summarizeCardSelectionBundleForAgent(finalBundle),
        available_cards: finalBundle.card_selection.options
          .map((option, fallbackIndex) =>
            summarizeCardSelectionOptionForAgent(option, fallbackIndex)
          )
          .filter((entry) => entry !== null),
        state
      };
    }

    const confirmResult = await performBridgeAction(session, "card_selection:confirm", waitAfterMs);
    executedActions.push(summarizeExecutedAction(confirmResult));
    state = confirmResult.state;
    finalBundle = buildCardSelectionBundle(state);
  }

  return {
    performed: true,
    required_but_missing: false,
    failed: false,
    removed_card: {
      requested_title:
        typeof options?.removeCardTitle === "string" ? normalizeAgentText(options.removeCardTitle) : null,
      requested_index: Number.isInteger(options?.removeCardIndex) ? options.removeCardIndex : null,
      selected_option_index: selectionResolution.option.index,
      match_type: selectionResolution.match_type,
      compatible_option_count: selectionResolution.compatible_option_count,
      card: selectedCardSummary
    },
    executed_actions: executedActions,
    card_selection_bundle: summarizeCardSelectionBundleForAgent(finalBundle),
    state
  };
}

function compactStringArray(values, limit = 3) {
  const seen = new Set();
  const result = [];

  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }

    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }

    seen.add(trimmed);
    result.push(trimmed);
    if (result.length >= limit) {
      break;
    }
  }

  return result;
}

function normalizeAgentText(value, options = {}) {
  if (typeof value !== "string") {
    return null;
  }

  let text = value.replace(/\r\n?/g, "\n").trim();
  if (!text) {
    return null;
  }

  text = text.replace(/\[img\]([\s\S]*?)\[\/img\]/gi, (_, inner) =>
    summarizeImageTag(inner)
  );
  text = text.replace(/\[(\/)?[a-z_]+(?:=[^\]]+)?\]/gi, "");
  text = resolveAgentTextPlaceholders(text, options);
  text = text.replace(/[ \t]+\n/g, "\n").replace(/\n[ \t]+/g, "\n");
  text = text.replace(/[ \t]{2,}/g, " ").trim();

  return text || null;
}

function summarizeImageTag(inner) {
  const raw = typeof inner === "string" ? inner : "";
  if (/energy_icon/i.test(raw)) {
    return "1点能量";
  }

  return "图标";
}

function resolveAgentTextPlaceholders(text, options = {}) {
  if (typeof text !== "string" || !text.includes("{")) {
    return text;
  }

  const tokenMap = isPlainObject(options.token_map) ? options.token_map : {};
  return text.replace(/\{([^}:]+)(?::[^}]*)?\}/g, (_, rawToken) => {
    const token = String(rawToken || "").trim();
    if (!token) {
      return "";
    }

    if (Object.prototype.hasOwnProperty.call(tokenMap, token)) {
      return String(tokenMap[token]);
    }

    if (token === "Energy") {
      return "1点能量";
    }

    return token;
  });
}

function compactNumberArray(values, limit = 3) {
  const seen = new Set();
  const result = [];

  for (const value of values) {
    if (!Number.isFinite(value)) {
      continue;
    }

    if (seen.has(value)) {
      continue;
    }

    seen.add(value);
    result.push(value);
    if (result.length >= limit) {
      break;
    }
  }

  return result;
}

function summarizeActionForAgent(action) {
  if (!isPlainObject(action)) {
    return null;
  }

  const summary = {
    action_id: typeof action.action_id === "string" ? action.action_id : null,
    kind: typeof action.kind === "string" ? action.kind : null,
    label: normalizeAgentText(action.label)
  };

  const targetName =
    typeof action.target_name === "string"
      ? normalizeAgentText(action.target_name)
      : normalizeAgentText(action?.target?.name);
  const targetSide =
    typeof action.target_side === "string"
      ? action.target_side
      : typeof action?.target?.side === "string"
        ? action.target.side
        : null;
  const targetCombatId = Number.isFinite(action.target_combat_id)
    ? action.target_combat_id
    : Number.isFinite(action?.target?.combat_id)
      ? action.target.combat_id
      : null;
  const targetActionSuffix =
    typeof action.target_action_suffix === "string"
      ? action.target_action_suffix
      : typeof action?.target_mapping?.action_suffix === "string"
        ? action.target_mapping.action_suffix
        : null;

  if (
    targetName !== null ||
    targetSide !== null ||
    targetCombatId !== null ||
    targetActionSuffix !== null
  ) {
    summary.target = {
      action_suffix: targetActionSuffix,
      combat_id: targetCombatId,
      name: targetName,
      side: targetSide
    };
  }

  return summary;
}

function filterNonAutomationActions(actions) {
  if (!Array.isArray(actions)) {
    return [];
  }

  return actions.filter(
    (action) =>
      isPlainObject(action) &&
      typeof action.action_id === "string" &&
      !action.action_id.startsWith("automation:")
  );
}

function summarizeActionsForAgent(actions) {
  if (!Array.isArray(actions)) {
    return [];
  }

  return actions
    .map(summarizeActionForAgent)
    .filter((action) => action !== null);
}

function shouldIncludeCardDescriptionAlongsideEffect(description, effect) {
  if (typeof description !== "string" || !description.trim()) {
    return false;
  }

  if (typeof effect !== "string" || !effect.trim()) {
    return true;
  }

  if (description.includes("\n")) {
    return true;
  }

  const sentenceBreakCount = (description.match(/[。！？!?]/g) || []).length;
  if (sentenceBreakCount >= 2) {
    return true;
  }

  return description.length >= effect.length + 8;
}

function summarizeCardForAgent(card) {
  if (!isPlainObject(card)) {
    return null;
  }

  const summary = {
    title: normalizeAgentText(card.title),
    cost: Number.isInteger(card.resolved_energy_cost) ? card.resolved_energy_cost : null
  };

  const effect = typeof card?.effect_preview?.summary === "string"
    ? normalizeAgentText(card.effect_preview.summary)
    : null;
  const description = typeof card.description === "string" && card.description.trim()
    ? normalizeAgentText(card.description)
    : null;

  if (typeof card.type === "string" && card.type.trim()) {
    summary.type = card.type;
  }

  if (typeof card.target_type === "string" && card.target_type.trim()) {
    summary.target = card.target_type;
  }

  if (effect && effect.trim()) {
    summary.effect = effect;
  }

  if (shouldIncludeCardDescriptionAlongsideEffect(description, effect)) {
    summary.description = description;
  }

  return summary;
}

function summarizePowerForAgent(power) {
  if (!isPlainObject(power)) {
    return null;
  }

  return {
    title: normalizeAgentText(power.title),
    amount: Number.isFinite(power.amount) ? power.amount : null
  };
}

function summarizePotionForAgent(potion) {
  if (!isPlainObject(potion)) {
    return null;
  }

  const summary = {};
  if (typeof potion.title === "string" && potion.title.trim()) {
    summary.title = normalizeAgentText(potion.title);
  }

  if (typeof potion.description === "string" && potion.description.trim()) {
    summary.description = normalizeAgentText(potion.description);
  }

  return Object.keys(summary).length > 0 ? summary : null;
}

function summarizeRelicForAgent(relic) {
  if (!isPlainObject(relic)) {
    return null;
  }

  return {
    title: normalizeAgentText(relic.title)
  };
}

function summarizeShopItemForAgent(item) {
  if (!isPlainObject(item)) {
    return null;
  }

  const summary = {
    index: Number.isInteger(item.index) ? item.index : null,
    item_kind: typeof item.item_kind === "string" ? item.item_kind : null,
    title: normalizeAgentText(item.title),
    description: normalizeAgentText(item.description),
    cost: Number.isFinite(item.cost) ? item.cost : null,
    is_affordable: item.is_affordable === true
  };

  if (isPlainObject(item.card)) {
    summary.card = summarizeCardForAgent(item.card);
  }

  if (isPlainObject(item.relic)) {
    summary.relic = summarizeRelicForAgent(item.relic);
  }

  if (isPlainObject(item.potion)) {
    summary.potion = summarizePotionForAgent(item.potion);
  }

  return summary;
}

function summarizeIntentForAgent(intent) {
  if (!isPlainObject(intent)) {
    return null;
  }

  const title = typeof intent.title === "string" && intent.title.trim()
    ? normalizeAgentText(intent.title)
    : null;
  const rawCandidates = Array.isArray(intent.intents)
    ? intent.intents.filter((entry) => isPlainObject(entry))
    : [];
  const filteredCandidates = title
    ? rawCandidates.filter((entry) => entry.title === title)
    : rawCandidates;
  const candidates = filteredCandidates.length > 0 ? filteredCandidates : rawCandidates;

  const labels = compactStringArray(
    candidates
      .map((entry) => normalizeAgentText(entry.label))
      .filter((label) => typeof label === "string" && !label.includes("LocString"))
  );
  const texts = compactStringArray(
    candidates.map((entry) => normalizeAgentText(entry.description))
  );
  const totalDamages = compactNumberArray(candidates.map((entry) => entry.total_damage));

  const summary = {
    state_id: typeof intent.state_id === "string" ? intent.state_id : null,
    title
  };

  if (labels.length > 0) {
    summary.label = labels[0];
    if (labels.length > 1) {
      summary.alt_label_count = labels.length - 1;
    }
  }

  if (texts.length > 0) {
    summary.text = texts[0];
    if (texts.length > 1) {
      summary.alt_text_count = texts.length - 1;
    }
  }

  if (totalDamages.length > 0) {
    summary.total_damage = totalDamages[0];
    if (totalDamages.length > 1) {
      summary.alt_total_damage_count = totalDamages.length - 1;
    }
  }

  return summary;
}

function summarizeCreatureForAgent(creature) {
  if (!isPlainObject(creature)) {
    return null;
  }

  const summary = {
    combat_id: Number.isFinite(creature.combat_id) ? creature.combat_id : null,
    name: normalizeAgentText(creature.name),
    current_hp: Number.isFinite(creature.current_hp) ? creature.current_hp : null,
    max_hp: Number.isFinite(creature.max_hp) ? creature.max_hp : null,
    block: Number.isFinite(creature.block) ? creature.block : 0,
    powers: Array.isArray(creature.powers)
      ? creature.powers.map(summarizePowerForAgent).filter((power) => power !== null)
      : []
  };

  if (isPlainObject(creature.intent)) {
    summary.intent = summarizeIntentForAgent(creature.intent);
  }

  return summary;
}

function summarizeRewardForAgent(reward) {
  if (!isPlainObject(reward)) {
    return null;
  }

  const rewardType = typeof reward.reward_type === "string" ? reward.reward_type : null;
  const summary = {
    reward_type: rewardType,
    description: normalizeAgentText(reward.description)
  };

  if (rewardType === "gold" && Number.isFinite(reward.amount)) {
    summary.amount = reward.amount;
  }

  if (rewardType === "relic" && isPlainObject(reward.relic)) {
    summary.relic = summarizeRelicForAgent(reward.relic);
  }

  if (rewardType === "potion" && isPlainObject(reward.potion)) {
    summary.potion = summarizePotionForAgent(reward.potion);
  }

  if (rewardType === "card") {
    summary.can_skip = reward.can_skip === true;
    summary.cards = Array.isArray(reward.cards)
      ? reward.cards.map(summarizeCardForAgent).filter((card) => card !== null)
      : [];
  }

  return summary;
}

function summarizeRewardBundleForAgent(bundle) {
  if (!isPlainObject(bundle)) {
    return bundle;
  }

  const rewards = isPlainObject(bundle.rewards) ? bundle.rewards : {};
  const cardRewardSelection = isPlainObject(bundle.card_reward_selection)
    ? bundle.card_reward_selection
    : {};

  return {
    in_reward_flow: bundle.in_reward_flow === true,
    screen: typeof bundle.screen === "string" ? bundle.screen : null,
    rewards: {
      visible: rewards.visible === true,
      terminal_proceed_visible: rewards.terminal_proceed_visible === true,
      entries: Array.isArray(rewards.entries)
        ? rewards.entries.map((entry) => ({
            index: Number.isInteger(entry?.index) ? entry.index : null,
            action_id: typeof entry?.action_id === "string" ? entry.action_id : null,
            reward: summarizeRewardForAgent(entry?.reward)
          }))
        : []
    },
    card_reward_selection: {
      visible: cardRewardSelection.visible === true,
      options: Array.isArray(cardRewardSelection.options)
        ? cardRewardSelection.options.map((option) => ({
            index: Number.isInteger(option?.index) ? option.index : null,
            card: summarizeCardForAgent(option?.card)
          }))
        : []
    },
    potion_slots: Array.isArray(bundle.potion_slots)
      ? bundle.potion_slots.map((slot) => ({
          index: Number.isInteger(slot?.index) ? slot.index : null,
          is_empty: slot?.is_empty === true,
          ...(slot?.is_empty === true
            ? {}
            : { potion: summarizePotionForAgent(slot?.potion) })
        }))
      : [],
    empty_potion_slot_count: Number.isFinite(bundle.empty_potion_slot_count)
      ? bundle.empty_potion_slot_count
      : null,
    has_proceed: bundle.has_proceed === true
  };
}

function summarizeRestSiteBundleForAgent(bundle) {
  if (!isPlainObject(bundle)) {
    return bundle;
  }

  const restSite = isPlainObject(bundle.rest_site) ? bundle.rest_site : {};
  const deckUpgrade = isPlainObject(bundle.deck_upgrade_selection)
    ? bundle.deck_upgrade_selection
    : {};

  return {
    in_rest_site_flow: bundle.in_rest_site_flow === true,
    screen: typeof bundle.screen === "string" ? bundle.screen : null,
    map_ready: bundle.map_ready === true,
    rest_site: {
      visible: restSite.visible === true,
      header: normalizeAgentText(restSite.header),
      description: normalizeAgentText(restSite.description),
      proceed_visible: restSite.proceed_visible === true,
      options: Array.isArray(restSite.options)
        ? restSite.options.map((option) => ({
            index: Number.isInteger(option?.index) ? option.index : null,
            option_type: typeof option?.option_type === "string" ? option.option_type : null,
            title: normalizeAgentText(option?.title),
            description: normalizeAgentText(option?.description)
          }))
        : []
    },
    deck_upgrade_selection: {
      visible: deckUpgrade.visible === true,
      options: Array.isArray(deckUpgrade.options)
        ? deckUpgrade.options.map((option) => ({
            index: Number.isInteger(option?.index) ? option.index : null,
            card: summarizeCardForAgent(option?.card)
          }))
        : []
    },
    non_automation_action_ids: Array.isArray(bundle.non_automation_action_ids)
      ? bundle.non_automation_action_ids
      : []
  };
}

function summarizeCardSelectionBundleForAgent(bundle) {
  if (!isPlainObject(bundle)) {
    return bundle;
  }

  const cardSelection = isPlainObject(bundle.card_selection) ? bundle.card_selection : {};

  return {
    in_card_selection_flow: bundle.in_card_selection_flow === true,
    screen: typeof bundle.screen === "string" ? bundle.screen : null,
    card_selection: {
      visible: cardSelection.visible === true,
      screen_type:
        typeof cardSelection.screen_type === "string" ? cardSelection.screen_type : null,
      prompt: normalizeAgentText(cardSelection.prompt),
      selected_count: Number.isFinite(cardSelection.selected_count)
        ? cardSelection.selected_count
        : null,
      min_select: Number.isFinite(cardSelection.min_select) ? cardSelection.min_select : null,
      max_select: Number.isFinite(cardSelection.max_select) ? cardSelection.max_select : null,
      requires_manual_confirmation:
        typeof cardSelection.requires_manual_confirmation === "boolean"
          ? cardSelection.requires_manual_confirmation
          : null,
      cancelable:
        typeof cardSelection.cancelable === "boolean" ? cardSelection.cancelable : null,
      confirm_visible: cardSelection.confirm_visible === true,
      cancel_visible: cardSelection.cancel_visible === true,
      close_visible: cardSelection.close_visible === true,
      skip_visible: cardSelection.skip_visible === true,
      options: Array.isArray(cardSelection.options)
        ? cardSelection.options.map((option) => ({
            index: Number.isInteger(option?.index) ? option.index : null,
            is_selected: option?.is_selected === true,
            card: summarizeCardForAgent(option?.card)
          }))
        : []
    },
    non_automation_action_ids: Array.isArray(bundle.non_automation_action_ids)
      ? bundle.non_automation_action_ids
      : []
  };
}

function summarizeStateForAgent(state) {
  if (!isPlainObject(state)) {
    return state;
  }

  const player = state?.players?.[0];
  const playerCreature = isPlainObject(player?.creature) ? player.creature : {};
  const playerCombat = isPlainObject(player?.combat) ? player.combat : {};
  const combat = isPlainObject(state.combat) ? state.combat : {};
  const run = isPlainObject(state.run) ? state.run : {};
  const map = isPlainObject(state.map) ? state.map : {};
  const shop = isPlainObject(state.shop) ? state.shop : {};

  const summary = {
    screen: typeof state.screen === "string" ? state.screen : null,
    state_version: Number.isFinite(state.state_version) ? state.state_version : null,
    run: {
      act: typeof run?.act?.title === "string" ? run.act.title : null,
      act_floor: Number.isFinite(run.act_floor) ? run.act_floor : null,
      total_floor: Number.isFinite(run.total_floor) ? run.total_floor : null,
      room_type: typeof run?.current_room?.room_type === "string"
        ? run.current_room.room_type
        : null,
      room_model: typeof run?.current_room?.model_id === "string"
        ? run.current_room.model_id
        : null,
      room_pre_finished: run?.current_room?.is_pre_finished === true,
      current_map_coord: isPlainObject(run.current_map_coord) ? run.current_map_coord : null,
      is_game_over: run.is_game_over === true
    },
    player: {
      current_hp: Number.isFinite(playerCreature.current_hp) ? playerCreature.current_hp : null,
      max_hp: Number.isFinite(playerCreature.max_hp) ? playerCreature.max_hp : null,
      block: Number.isFinite(playerCreature.block) ? playerCreature.block : 0,
      powers: Array.isArray(playerCreature.powers)
        ? playerCreature.powers
            .map(summarizePowerForAgent)
            .filter((power) => power !== null)
        : [],
      gold: Number.isFinite(player?.gold) ? player.gold : null,
      potions: Array.isArray(player?.potions)
        ? player.potions.map((potion) => (potion?.empty === true ? "[empty]" : potion?.title ?? null))
        : [],
      relics: Array.isArray(player?.relics)
        ? player.relics.map((relic) => summarizeRelicForAgent(relic)).filter((relic) => relic !== null)
        : []
    },
    available_actions: summarizeActionsForAgent(getNonAutomationActions(state))
  };

  if (combat.in_progress === true || Array.isArray(playerCombat?.hand?.cards)) {
    summary.combat = {
      in_progress: combat.in_progress === true,
      round_number: Number.isFinite(combat.round_number) ? combat.round_number : null,
      current_side: typeof combat.current_side === "string" ? combat.current_side : null,
      is_play_phase: combat.is_play_phase === true,
      player_actions_disabled: combat.player_actions_disabled === true,
      energy: Number.isFinite(playerCombat.energy) ? playerCombat.energy : null,
      max_energy: Number.isFinite(playerCombat.max_energy) ? playerCombat.max_energy : null,
      hand: Array.isArray(playerCombat?.hand?.cards)
        ? playerCombat.hand.cards.map(summarizeCardForAgent).filter((card) => card !== null)
        : [],
      draw_pile_count: Number.isFinite(playerCombat?.draw_pile?.count)
        ? playerCombat.draw_pile.count
        : null,
      draw_top: Array.isArray(playerCombat?.draw_pile?.cards)
        ? playerCombat.draw_pile.cards
            .slice(0, 3)
            .map(summarizeCardForAgent)
            .filter((card) => card !== null)
        : [],
      discard_pile_count: Number.isFinite(playerCombat?.discard_pile?.count)
        ? playerCombat.discard_pile.count
        : null,
      exhaust_pile_count: Number.isFinite(playerCombat?.exhaust_pile?.count)
        ? playerCombat.exhaust_pile.count
        : null,
      enemies: Array.isArray(combat.enemy_creatures)
        ? combat.enemy_creatures.map(summarizeCreatureForAgent).filter((creature) => creature !== null)
        : [],
      target_index_map: Array.isArray(combat.target_index_map)
        ? combat.target_index_map
            .map((entry) => ({
              action_suffixes: Array.isArray(entry?.action_suffixes)
                ? entry.action_suffixes.filter((value) => typeof value === "string")
                : [],
              combat_id: Number.isFinite(entry?.combat_id) ? entry.combat_id : null,
              name: normalizeAgentText(entry?.name),
              side: typeof entry?.side === "string" ? entry.side : null,
              is_enemy: entry?.is_enemy === true,
              is_alive: entry?.is_alive === true
            }))
            .filter((entry) => entry.combat_id !== null || entry.name !== null)
        : []
    };
  }

  const rewardBundle = buildRewardBundle(state);
  if (rewardBundle.in_reward_flow) {
    summary.rewards = summarizeRewardBundleForAgent(rewardBundle);
  }

  const restSiteBundle = buildRestSiteBundle(state);
  if (restSiteBundle.in_rest_site_flow) {
    summary.rest_site = summarizeRestSiteBundleForAgent(restSiteBundle);
  }

  const cardSelectionBundle = buildCardSelectionBundle(state);
  if (cardSelectionBundle.in_card_selection_flow) {
    summary.card_selection = summarizeCardSelectionBundleForAgent(cardSelectionBundle);
  }

  if (map.is_open === true) {
    summary.map = {
      is_open: true,
      is_travel_enabled: map.is_travel_enabled === true,
      is_traveling: map.is_traveling === true,
      current_coord: isPlainObject(map.current_coord) ? map.current_coord : null,
      travelable_points: Array.isArray(map.points)
        ? map.points
            .filter((point) => point?.is_travelable === true || point?.state === "Travelable")
            .map((point) => ({
              coord: isPlainObject(point?.coord) ? point.coord : null,
              point_type: typeof point?.point_type === "string" ? point.point_type : null
            }))
        : []
    };
  }

  if (shop.is_open === true || shop.visible === true) {
    summary.shop = {
      is_open: shop.is_open === true,
      gold: Number.isFinite(shop.gold) ? shop.gold : null,
      items: Array.isArray(shop.items)
        ? shop.items
            .map((item) => summarizeShopItemForAgent(item))
            .filter((item) => item !== null)
        : []
    };
  }

  if (state?.event_options?.visible === true) {
    const visibleGlossary = Array.isArray(state.event_options.visible_glossary)
      ? state.event_options.visible_glossary
          .map((entry) => ({
            title: normalizeAgentText(entry?.title),
            description: normalizeAgentText(entry?.description)
          }))
          .filter((entry) => entry.title || entry.description)
      : [];
    const visibleGlossaryTexts = Array.isArray(
      state.event_options.visible_glossary_texts
    )
      ? state.event_options.visible_glossary_texts
          .map((text) => normalizeAgentText(text))
          .filter((text) => typeof text === "string" && text.length > 0)
      : [];
    summary.event_options = {
      visible: true,
      visible_glossary_source:
        typeof state.event_options.visible_glossary_source === "string"
          ? state.event_options.visible_glossary_source
          : null,
      visible_glossary:
        visibleGlossary.length > 0 ? visibleGlossary : undefined,
      visible_glossary_texts:
        visibleGlossary.length === 0 && visibleGlossaryTexts.length > 0
          ? visibleGlossaryTexts
          : undefined,
      options: Array.isArray(state.event_options.options)
        ? state.event_options.options.map((option) => ({
            index: Number.isInteger(option?.index) ? option.index : null,
            title: normalizeAgentText(option?.title),
            description: normalizeAgentText(option?.description),
            is_proceed: option?.is_proceed === true,
            glossary: Array.isArray(option?.glossary)
              ? option.glossary
                  .map((entry) => ({
                    title: normalizeAgentText(entry?.title),
                    description: normalizeAgentText(entry?.description)
                  }))
                  .filter((entry) => entry.title || entry.description)
              : undefined
          }))
        : []
    };
  }

  return summary;
}

function buildMapRoutesPayload(state, options = {}) {
  if (!isPlainObject(state)) {
    return {
      ok: false,
      error: "invalid_state_payload"
    };
  }

  const detail = normalizeMapRoutesDetail(options.detail);
  const snapshotStatus = isPlainObject(options.snapshot_status)
    ? options.snapshot_status
    : null;
  const map = isPlainObject(state.map) ? state.map : {};
  if (map.is_open !== true || !Array.isArray(map.points) || map.points.length === 0) {
    return {
      ok: false,
      error: "map_not_open",
      screen: typeof state.screen === "string" ? state.screen : null,
      map_open: map.is_open === true,
      detail,
      snapshot_settled: snapshotStatus?.settled ?? null,
      snapshot_settle_reason: snapshotStatus?.reason ?? null,
      snapshot_settle_polls: snapshotStatus?.poll_count ?? null
    };
  }

  const currentCoord = extractMapCurrentCoord(state);
  const currentRow = Number.isFinite(currentCoord?.row) ? currentCoord.row : null;
  const runContext = buildMapRunContext(state);

  const allPoints = map.points
    .filter((point) => isPlainObject(point) && isPlainObject(point.coord))
    .map((point) => ({
      coord: {
        col: Number.isFinite(point.coord.col) ? point.coord.col : null,
        row: Number.isFinite(point.coord.row) ? point.coord.row : null
      },
      point_type: typeof point.point_type === "string" ? point.point_type : null,
      state: typeof point.state === "string" ? point.state : null,
      is_travelable: point.is_travelable === true || point.state === "Travelable",
      children: Array.isArray(point.children)
        ? point.children
            .filter((child) => isPlainObject(child))
            .map((child) => ({
              col: Number.isFinite(child.col) ? child.col : null,
              row: Number.isFinite(child.row) ? child.row : null
            }))
            .filter((child) => child.col !== null && child.row !== null)
        : []
    }))
    .filter((point) => point.coord.col !== null && point.coord.row !== null);

  const points =
    currentRow === null
      ? allPoints
      : allPoints.filter((point) => point.coord.row > currentRow);

  const pointByKey = new Map(
    points.map((point) => [toCoordKey(point.coord), point])
  );
  const frontier = points.filter((point) => point.is_travelable === true);

  const reachableKeys = collectReachableMapKeys(frontier, pointByKey);
  const depthMemo = new Map();

  const routeRoots = frontier
    .map((point) => {
      const key = toCoordKey(point.coord);
      if (!key || !reachableKeys.has(key)) {
        return null;
      }

      const rootSummary = buildMapRouteRootSummary(key, pointByKey);

      return {
        key,
        point_type: point.point_type,
        child_keys: getReachableMapChildKeys(point, pointByKey, reachableKeys),
        reachable_node_count: countUniqueReachableMapNodesFromKey(key, pointByKey),
        max_depth: getReachableMapDepthFromKey(key, pointByKey, depthMemo),
        summary: rootSummary,
        run_aware: buildMapRouteRootRunAware(rootSummary, runContext)
      };
    })
    .filter((entry) => entry !== null)
    .sort(compareReachableMapNodeEntries);

  const routeNodes = Array.from(reachableKeys)
    .map((key) => {
      const point = pointByKey.get(key);
      if (!point) {
        return null;
      }

      return {
        key,
        point_type: point.point_type,
        child_keys: getReachableMapChildKeys(point, pointByKey, reachableKeys)
      };
    })
    .filter((entry) => entry !== null)
    .sort(compareReachableMapNodeEntries);

  return {
    ok: true,
    screen: typeof state.screen === "string" ? state.screen : null,
    current_coord: currentCoord,
    current_row: currentRow,
    run_context: runContext,
    detail,
    forced_route: routeRoots.length === 1,
    frontier_count: frontier.length,
    coord_key_format: "col,row",
    pruned_rules: [
      "exclude_current_node",
      "exclude_rows_at_or_before_current",
      "exclude_unreachable_nodes"
    ],
    snapshot_settled: snapshotStatus?.settled ?? null,
    snapshot_settle_reason: snapshotStatus?.reason ?? null,
    snapshot_settle_polls: snapshotStatus?.poll_count ?? null,
    frontier_action_match: snapshotStatus?.frontier_action_match ?? null,
    state_action_state_version_match:
      snapshotStatus?.state_action_state_version_match ?? null,
    route_root_count: routeRoots.length,
    route_node_count: routeNodes.length,
    route_roots: routeRoots,
    route_nodes: detail === "full" ? routeNodes : undefined
  };
}

function buildMapRouteRootSummary(startKey, pointByKey) {
  const pointTypeCounts = new Map();
  const minStepsByType = new Map();
  const visited = new Set();
  const bestStepsByKey = new Map();
  const pending = [
    {
      key: startKey,
      stepsFromCurrent: 1
    }
  ];

  while (pending.length > 0) {
    const current = pending.pop();
    const key = current?.key;
    const stepsFromCurrent = current?.stepsFromCurrent;
    if (typeof key !== "string" || !Number.isInteger(stepsFromCurrent)) {
      continue;
    }

    const bestKnownSteps = bestStepsByKey.get(key);
    if (bestKnownSteps !== undefined && bestKnownSteps <= stepsFromCurrent) {
      continue;
    }
    bestStepsByKey.set(key, stepsFromCurrent);

    const point = pointByKey.get(key);
    if (!point) {
      continue;
    }

    if (!visited.has(key)) {
      visited.add(key);
      if (typeof point.point_type === "string" && point.point_type.length > 0) {
        pointTypeCounts.set(
          point.point_type,
          (pointTypeCounts.get(point.point_type) ?? 0) + 1
        );
      }
    }

    if (typeof point.point_type === "string" && point.point_type.length > 0) {
      const previousMin = minStepsByType.get(point.point_type);
      if (previousMin === undefined || stepsFromCurrent < previousMin) {
        minStepsByType.set(point.point_type, stepsFromCurrent);
      }
    }

    for (const childKey of getReachableMapChildKeys(point, pointByKey)) {
      pending.push({
        key: childKey,
        stepsFromCurrent: stepsFromCurrent + 1
      });
    }
  }

  return {
    forced_path_steps_before_branch: countForcedMapPathSteps(startKey, pointByKey),
    reachable_point_type_counts: objectFromSortedMap(pointTypeCounts),
    steps_from_current_to_next_point_type: objectFromSortedMap(minStepsByType),
    can_reach_rest_site_before_elite: canReachTypeBeforeType(
      startKey,
      pointByKey,
      "RestSite",
      "Elite"
    ),
    can_reach_elite_then_rest_site: canReachEliteThenRestSite(startKey, pointByKey)
  };
}

function buildMapRunContext(state) {
  const run = isPlainObject(state?.run) ? state.run : {};
  const player = state?.players?.[0];
  const creature = isPlainObject(player?.creature) ? player.creature : {};
  const potions = Array.isArray(player?.potions) ? player.potions : [];
  const relics = Array.isArray(player?.relics) ? player.relics : [];
  const deck = isPlainObject(player?.deck) ? player.deck : {};
  const currentHp = Number.isFinite(creature.current_hp) ? creature.current_hp : null;
  const maxHp = Number.isFinite(creature.max_hp) ? creature.max_hp : null;
  const hpRatio =
    currentHp !== null && maxHp !== null && maxHp > 0
      ? Number((currentHp / maxHp).toFixed(3))
      : null;
  const emptyPotionSlots = potions.filter((potion) => potion?.empty === true).length;
  const filledPotionSlots = potions.filter((potion) => potion?.empty !== true).length;
  const nonStarterRelicCount = relics.filter(
    (relic) => String(relic?.rarity ?? "") !== "Starter"
  ).length;
  const deckCardCount = Number.isFinite(deck.count)
    ? deck.count
    : Array.isArray(deck.cards)
      ? deck.cards.length
      : null;

  return {
    act_floor: Number.isFinite(run.act_floor) ? run.act_floor : null,
    total_floor: Number.isFinite(run.total_floor) ? run.total_floor : null,
    hp: {
      current: currentHp,
      max: maxHp,
      ratio: hpRatio,
      band: getHpBand(hpRatio)
    },
    gold: Number.isFinite(player?.gold) ? player.gold : null,
    gold_band: getGoldBand(player?.gold),
    potion_slots: {
      total: potions.length,
      filled: filledPotionSlots,
      empty: emptyPotionSlots,
      band: getPotionSlotBand(emptyPotionSlots, potions.length)
    },
    deck_card_count: deckCardCount,
    relic_count: relics.length,
    non_starter_relic_count: nonStarterRelicCount
  };
}

function buildMapRouteRootRunAware(routeSummary, runContext) {
  const stepIndex = isPlainObject(routeSummary?.steps_from_current_to_next_point_type)
    ? routeSummary.steps_from_current_to_next_point_type
    : {};
  const nextEliteSteps = Number.isFinite(stepIndex.Elite) ? stepIndex.Elite : null;
  const nextRestSteps = Number.isFinite(stepIndex.RestSite) ? stepIndex.RestSite : null;
  const nextShopSteps = Number.isFinite(stepIndex.Shop) ? stepIndex.Shop : null;
  const eliteViability = rateEliteViability(routeSummary, runContext);
  const reasonTags = buildMapRouteReasonTags(routeSummary, runContext, eliteViability);

  return {
    rest_pressure: rateRestPressure(nextRestSteps, runContext),
    shop_access_value: rateShopAccessValue(nextShopSteps, runContext),
    potion_capacity_value: ratePotionCapacityValue(runContext),
    elite_plan: {
      next_elite_steps: nextEliteSteps,
      can_reach_rest_site_before_elite:
        routeSummary?.can_reach_rest_site_before_elite === true,
      can_reach_elite_then_rest_site:
        routeSummary?.can_reach_elite_then_rest_site === true,
      viability: eliteViability.rating,
      score: eliteViability.score
    },
    reason_tags: reasonTags
  };
}

function countForcedMapPathSteps(startKey, pointByKey) {
  let key = startKey;
  let steps = 0;

  while (typeof key === "string") {
    const point = pointByKey.get(key);
    if (!point) {
      break;
    }

    steps += 1;
    const childKeys = getReachableMapChildKeys(point, pointByKey);
    if (childKeys.length !== 1) {
      break;
    }

    key = childKeys[0];
  }

  return steps;
}

function canReachEliteThenRestSite(startKey, pointByKey) {
  const memo = new Map();
  return canReachEliteThenRestSiteRecursive(startKey, pointByKey, false, memo);
}

function canReachEliteThenRestSiteRecursive(startKey, pointByKey, seenElite, memo) {
  if (typeof startKey !== "string") {
    return false;
  }

  const memoKey = `${startKey}|${seenElite ? "1" : "0"}`;
  if (memo.has(memoKey)) {
    return memo.get(memoKey);
  }

  const point = pointByKey.get(startKey);
  if (!point) {
    memo.set(memoKey, false);
    return false;
  }

  const nextSeenElite = seenElite || point.point_type === "Elite";
  if (nextSeenElite && point.point_type === "RestSite") {
    memo.set(memoKey, true);
    return true;
  }

  const result = getReachableMapChildKeys(point, pointByKey).some((childKey) =>
    canReachEliteThenRestSiteRecursive(childKey, pointByKey, nextSeenElite, memo)
  );
  memo.set(memoKey, result);
  return result;
}

function canReachTypeBeforeType(startKey, pointByKey, desiredType, blockingType) {
  const memo = new Map();
  return canReachTypeBeforeTypeRecursive(
    startKey,
    pointByKey,
    desiredType,
    blockingType,
    memo
  );
}

function canReachTypeBeforeTypeRecursive(
  startKey,
  pointByKey,
  desiredType,
  blockingType,
  memo
) {
  if (typeof startKey !== "string") {
    return false;
  }

  const memoKey = `${startKey}|${desiredType}|${blockingType}`;
  if (memo.has(memoKey)) {
    return memo.get(memoKey);
  }

  const point = pointByKey.get(startKey);
  if (!point) {
    memo.set(memoKey, false);
    return false;
  }

  if (point.point_type === desiredType) {
    memo.set(memoKey, true);
    return true;
  }

  if (point.point_type === blockingType) {
    memo.set(memoKey, false);
    return false;
  }

  const result = getReachableMapChildKeys(point, pointByKey).some((childKey) =>
    canReachTypeBeforeTypeRecursive(
      childKey,
      pointByKey,
      desiredType,
      blockingType,
      memo
    )
  );
  memo.set(memoKey, result);
  return result;
}

function getHpBand(hpRatio) {
  if (!Number.isFinite(hpRatio)) {
    return null;
  }

  if (hpRatio >= 0.75) {
    return "healthy";
  }

  if (hpRatio >= 0.5) {
    return "stable";
  }

  if (hpRatio >= 0.3) {
    return "wounded";
  }

  return "critical";
}

function getGoldBand(gold) {
  if (!Number.isFinite(gold)) {
    return null;
  }

  if (gold >= 150) {
    return "rich";
  }

  if (gold >= 75) {
    return "shop_ready";
  }

  if (gold >= 40) {
    return "limited";
  }

  return "low";
}

function getPotionSlotBand(emptySlots, totalSlots) {
  if (!Number.isFinite(totalSlots) || totalSlots <= 0) {
    return null;
  }

  if (!Number.isFinite(emptySlots) || emptySlots <= 0) {
    return "full";
  }

  if (emptySlots >= 2) {
    return "open";
  }

  return "tight";
}

function rateRestPressure(nextRestSteps, runContext) {
  const hpRatio = Number.isFinite(runContext?.hp?.ratio) ? runContext.hp.ratio : null;
  if (!Number.isFinite(hpRatio)) {
    return "unknown";
  }

  if (hpRatio < 0.35) {
    return "high";
  }

  if (hpRatio < 0.55 && (!Number.isFinite(nextRestSteps) || nextRestSteps > 3)) {
    return "high";
  }

  if (hpRatio < 0.7 && (!Number.isFinite(nextRestSteps) || nextRestSteps > 4)) {
    return "medium";
  }

  return "low";
}

function rateShopAccessValue(nextShopSteps, runContext) {
  const gold = Number.isFinite(runContext?.gold) ? runContext.gold : null;
  if (!Number.isFinite(nextShopSteps)) {
    return "none";
  }

  if (!Number.isFinite(gold) || gold < 40) {
    return "low";
  }

  if ((gold >= 75 && nextShopSteps <= 2) || (gold >= 150 && nextShopSteps <= 4)) {
    return "high";
  }

  if ((gold >= 50 && nextShopSteps <= 3) || gold >= 100) {
    return "medium";
  }

  return "low";
}

function ratePotionCapacityValue(runContext) {
  const emptySlots = Number.isFinite(runContext?.potion_slots?.empty)
    ? runContext.potion_slots.empty
    : null;
  const totalSlots = Number.isFinite(runContext?.potion_slots?.total)
    ? runContext.potion_slots.total
    : null;
  if (!Number.isFinite(totalSlots) || totalSlots <= 0) {
    return "unknown";
  }

  if (!Number.isFinite(emptySlots) || emptySlots <= 0) {
    return "none";
  }

  if (emptySlots >= 2) {
    return "high";
  }

  return "medium";
}

function rateEliteViability(routeSummary, runContext) {
  const steps = isPlainObject(routeSummary?.steps_from_current_to_next_point_type)
    ? routeSummary.steps_from_current_to_next_point_type
    : {};
  const nextEliteSteps = Number.isFinite(steps.Elite) ? steps.Elite : null;
  if (!Number.isFinite(nextEliteSteps)) {
    return {
      rating: "none",
      score: null
    };
  }

  let score = 0;
  const hpBand = runContext?.hp?.band;
  if (hpBand === "healthy") {
    score += 2;
  } else if (hpBand === "stable") {
    score += 1;
  } else if (hpBand === "wounded") {
    score -= 1;
  } else if (hpBand === "critical") {
    score -= 2;
  }

  const filledPotionSlots = Number.isFinite(runContext?.potion_slots?.filled)
    ? runContext.potion_slots.filled
    : 0;
  if (filledPotionSlots >= 1) {
    score += 1;
  }

  const nonStarterRelicCount = Number.isFinite(runContext?.non_starter_relic_count)
    ? runContext.non_starter_relic_count
    : 0;
  if (nonStarterRelicCount >= 3) {
    score += 1;
  }

  if (nextEliteSteps >= 5) {
    score += 1;
  } else if (nextEliteSteps <= 2) {
    score -= 1;
  }

  if (routeSummary?.can_reach_rest_site_before_elite === true) {
    score += 1;
  }

  if (routeSummary?.can_reach_elite_then_rest_site === true) {
    score += 1;
  }

  if (score >= 4) {
    return { rating: "strong", score };
  }

  if (score >= 2) {
    return { rating: "okay", score };
  }

  if (score >= 0) {
    return { rating: "risky", score };
  }

  return { rating: "poor", score };
}

function buildMapRouteReasonTags(routeSummary, runContext, eliteViability) {
  const steps = isPlainObject(routeSummary?.steps_from_current_to_next_point_type)
    ? routeSummary.steps_from_current_to_next_point_type
    : {};
  const nextShopSteps = Number.isFinite(steps.Shop) ? steps.Shop : null;
  const tags = [];

  if (typeof runContext?.hp?.band === "string") {
    tags.push(`hp_${runContext.hp.band}`);
  }

  if (typeof runContext?.gold_band === "string") {
    tags.push(`gold_${runContext.gold_band}`);
  }

  if (typeof runContext?.potion_slots?.band === "string") {
    tags.push(`potions_${runContext.potion_slots.band}`);
  }

  if (typeof eliteViability?.rating === "string" && eliteViability.rating !== "none") {
    tags.push(`elite_${eliteViability.rating}`);
  }

  if (routeSummary?.can_reach_rest_site_before_elite === true) {
    tags.push("elite_rest_before");
  }

  if (routeSummary?.can_reach_elite_then_rest_site === true) {
    tags.push("elite_rest_after");
  }

  if (Number.isFinite(nextShopSteps)) {
    tags.push(`shop_${Math.min(nextShopSteps, 6)}_steps`);
  }

  return tags.slice(0, 6);
}

function toCoordKey(coord) {
  if (!isPlainObject(coord)) {
    return null;
  }

  const col = Number.isFinite(coord.col) ? coord.col : null;
  const row = Number.isFinite(coord.row) ? coord.row : null;
  if (col === null || row === null) {
    return null;
  }

  return `${col},${row}`;
}

function extractMapCurrentCoord(state) {
  if (!isPlainObject(state)) {
    return null;
  }

  const run = isPlainObject(state.run) ? state.run : {};
  const map = isPlainObject(state.map) ? state.map : {};
  return isPlainObject(run.current_map_coord)
    ? run.current_map_coord
    : isPlainObject(map.current_coord)
      ? map.current_coord
      : null;
}

function extractTravelableMapKeysFromState(state) {
  if (!isPlainObject(state?.map) || !Array.isArray(state.map.points)) {
    return [];
  }

  return state.map.points
    .filter(
      (point) =>
        isPlainObject(point) &&
        isPlainObject(point.coord) &&
        (point.is_travelable === true || point.state === "Travelable")
    )
    .map((point) => toCoordKey(point.coord))
    .filter((key) => typeof key === "string")
    .sort(compareCoordKeys);
}

function extractMapActionKeys(actionsPayload) {
  if (!isPlainObject(actionsPayload) || !Array.isArray(actionsPayload.actions)) {
    return [];
  }

  const keys = actionsPayload.actions
    .filter(
      (action) =>
        isPlainObject(action) &&
        typeof action.action_id === "string" &&
        action.action_id.startsWith("map:") &&
        !action.action_id.startsWith("automation:")
    )
    .map((action) => {
      if (isPlainObject(action.coord)) {
        return toCoordKey(action.coord);
      }

      return action.action_id.slice("map:".length);
    })
    .filter((key) => typeof key === "string" && parseCoordKey(key) !== null);

  return [...new Set(keys)].sort(compareCoordKeys);
}

function areCoordKeySetsEqual(leftKeys, rightKeys) {
  const left = Array.isArray(leftKeys) ? leftKeys : [];
  const right = Array.isArray(rightKeys) ? rightKeys : [];
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }

  return true;
}

function collectReachableMapKeys(frontier, pointByKey) {
  const reachableKeys = new Set();
  const pending = frontier
    .map((point) => toCoordKey(point?.coord))
    .filter((key) => typeof key === "string");

  while (pending.length > 0) {
    const key = pending.pop();
    if (!key || reachableKeys.has(key)) {
      continue;
    }

    const point = pointByKey.get(key);
    if (!point) {
      continue;
    }

    reachableKeys.add(key);
    for (const childKey of getReachableMapChildKeys(point, pointByKey)) {
      if (!reachableKeys.has(childKey)) {
        pending.push(childKey);
      }
    }
  }

  return reachableKeys;
}

function getReachableMapChildKeys(point, pointByKey, allowedKeys) {
  const seen = new Set();
  const childKeys = [];

  for (const child of Array.isArray(point?.children) ? point.children : []) {
    const childKey = toCoordKey(child);
    if (!childKey || seen.has(childKey)) {
      continue;
    }

    if (!pointByKey.has(childKey)) {
      continue;
    }

    if (allowedKeys instanceof Set && !allowedKeys.has(childKey)) {
      continue;
    }

    seen.add(childKey);
    childKeys.push(childKey);
  }

  return childKeys.sort(compareCoordKeys);
}

function countUniqueReachableMapNodesFromKey(startKey, pointByKey) {
  if (typeof startKey !== "string") {
    return 0;
  }

  const visited = new Set();
  const pending = [startKey];

  while (pending.length > 0) {
    const key = pending.pop();
    if (!key || visited.has(key)) {
      continue;
    }

    const point = pointByKey.get(key);
    if (!point) {
      continue;
    }

    visited.add(key);
    for (const childKey of getReachableMapChildKeys(point, pointByKey)) {
      if (!visited.has(childKey)) {
        pending.push(childKey);
      }
    }
  }

  return visited.size;
}

function getReachableMapDepthFromKey(startKey, pointByKey, memo) {
  if (typeof startKey !== "string") {
    return 0;
  }

  if (memo instanceof Map && memo.has(startKey)) {
    return memo.get(startKey);
  }

  const point = pointByKey.get(startKey);
  if (!point) {
    return 0;
  }

  const childKeys = getReachableMapChildKeys(point, pointByKey);
  const depth =
    childKeys.length === 0
      ? 1
      : 1 + Math.max(...childKeys.map((childKey) => getReachableMapDepthFromKey(childKey, pointByKey, memo)));

  if (memo instanceof Map) {
    memo.set(startKey, depth);
  }

  return depth;
}

function compareCoordKeys(left, right) {
  const leftCoord = parseCoordKey(left);
  const rightCoord = parseCoordKey(right);
  return compareCoords(leftCoord, rightCoord);
}

function compareReachableMapNodeEntries(left, right) {
  return compareCoordKeys(left?.key, right?.key);
}

function parseCoordKey(value) {
  if (typeof value !== "string") {
    return null;
  }

  const [colText, rowText] = value.split(",");
  const col = Number.parseInt(colText, 10);
  const row = Number.parseInt(rowText, 10);
  if (!Number.isFinite(col) || !Number.isFinite(row)) {
    return null;
  }

  return { col, row };
}

function compareCoords(left, right) {
  const leftRow = Number.isFinite(left?.row) ? left.row : Number.POSITIVE_INFINITY;
  const rightRow = Number.isFinite(right?.row) ? right.row : Number.POSITIVE_INFINITY;
  if (leftRow !== rightRow) {
    return leftRow - rightRow;
  }

  const leftCol = Number.isFinite(left?.col) ? left.col : Number.POSITIVE_INFINITY;
  const rightCol = Number.isFinite(right?.col) ? right.col : Number.POSITIVE_INFINITY;
  return leftCol - rightCol;
}

function objectFromSortedMap(map) {
  if (!(map instanceof Map) || map.size === 0) {
    return {};
  }

  return Object.fromEntries(
    Array.from(map.entries()).sort(([leftKey], [rightKey]) =>
      String(leftKey).localeCompare(String(rightKey))
    )
  );
}

function isBridgeStatePayload(payload) {
  return (
    isPlainObject(payload) &&
    typeof payload.screen === "string" &&
    (Array.isArray(payload.available_actions) ||
      isPlainObject(payload.run) ||
      isPlainObject(payload.combat))
  );
}

function isBridgeActionsPayload(payload) {
  return (
    isPlainObject(payload) &&
    Array.isArray(payload.actions) &&
    !isPlainObject(payload.state)
  );
}

function compactPayloadForOutput(payload) {
  if (!isPlainObject(payload)) {
    return payload;
  }

  if (isBridgeStatePayload(payload)) {
    return summarizeStateForAgent(payload);
  }

  if (isBridgeActionsPayload(payload)) {
    return {
      ok: payload.ok === true,
      schema_version: typeof payload.schema_version === "string" ? payload.schema_version : null,
      state_version: Number.isFinite(payload.state_version) ? payload.state_version : null,
      screen: typeof payload.screen === "string" ? payload.screen : null,
      actions: summarizeActionsForAgent(filterNonAutomationActions(payload.actions))
    };
  }

  const result = {
    ...payload
  };

  if (isPlainObject(payload.state)) {
    result.state = summarizeStateForAgent(payload.state);
  }

  if (isPlainObject(payload.final_state)) {
    result.final_state = summarizeStateForAgent(payload.final_state);
  }

  if (isPlainObject(payload.reward_bundle)) {
    result.reward_bundle = summarizeRewardBundleForAgent(payload.reward_bundle);
  }

  if (isPlainObject(payload.rest_site_bundle)) {
    result.rest_site_bundle = summarizeRestSiteBundleForAgent(payload.rest_site_bundle);
  }

  if (isPlainObject(payload.card_selection_bundle)) {
    result.card_selection_bundle = summarizeCardSelectionBundleForAgent(payload.card_selection_bundle);
  }

  if (isPlainObject(payload.initial_card_selection_bundle)) {
    result.initial_card_selection_bundle = summarizeCardSelectionBundleForAgent(payload.initial_card_selection_bundle);
  }

  if (isPlainObject(payload.current_card_selection_bundle)) {
    result.current_card_selection_bundle = summarizeCardSelectionBundleForAgent(payload.current_card_selection_bundle);
  }

  if (isPlainObject(payload.final_card_selection_bundle)) {
    result.final_card_selection_bundle = summarizeCardSelectionBundleForAgent(payload.final_card_selection_bundle);
  }

  if (Array.isArray(payload.executed_actions)) {
    result.executed_actions = payload.executed_actions.map(summarizeExecutedAction);
  }

  if (Array.isArray(payload.actions)) {
    result.actions = summarizeActionsForAgent(payload.actions);
  }

  if (isPlainObject(payload.matched_action)) {
    result.matched_action = summarizeActionForAgent(payload.matched_action);
  }

  return result;
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
    const nonAutomationActionIds = getNonAutomationActions(state)
      .map((action) => action?.action_id)
      .filter((actionId) => typeof actionId === "string");
    const rewardBundle = buildRewardBundle(state);
    const canAutoProceedFromRewardCleanup =
      rewardBundle.in_reward_flow &&
      rewardBundle.has_proceed === true &&
      rewardBundle.rewards.entries.length === 0 &&
      rewardBundle.card_reward_selection.visible !== true &&
      nonAutomationActionIds.includes("proceed") &&
      nonAutomationActionIds.every(
        (actionId) => actionId === "proceed" || actionId.startsWith("discard_potion:")
      );

    if (!canAutoProceedFromRewardCleanup) {
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
    matched_action: summarizeActionForAgent(result?.matched_action),
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

function requireNonEmptyStringArray(value, fieldName) {
  if (!Array.isArray(value) || value.length <= 0) {
    throw new ToolPayloadError(
      "invalid_arguments",
      `${fieldName} must be a non-empty array of strings.`,
      {
        field: fieldName
      }
    );
  }

  return value.map((entry, index) => {
    if (typeof entry !== "string" || entry.trim().length <= 0) {
      throw new ToolPayloadError(
        "invalid_arguments",
        `${fieldName}[${index}] must be a non-empty string.`,
        {
          field: fieldName,
          index
        }
      );
    }

    return entry.trim();
  });
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

function normalizeMapRoutesDetail(value) {
  const normalized = optionalString(value, "detail") ?? "summary";
  if (normalized !== "summary" && normalized !== "full") {
    throw new ToolPayloadError(
      "invalid_arguments",
      "detail must be either summary or full when provided.",
      {
        field: "detail"
      }
    );
  }

  return normalized;
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
  if (!isPlainObject(payload)) {
    return payload;
  }

  const state = isPlainObject(payload.state)
    ? payload.state
    : isBridgeStatePayload(payload)
      ? payload
      : null;
  if (!isPlainObject(state)) {
    return payload;
  }

  const hints = {};
  const playableCardActions = getPlayableCardActions(state);
  if (playableCardActions.length >= 2) {
    hints.play_card_sequence = {
      play_card_action_count: playableCardActions.length,
      recommended_tool: "sts2_play_card_sequence"
    };
  }

  const cardSelectionBundle = buildCardSelectionBundle(state);
  if (cardSelectionBundle.in_card_selection_flow) {
    hints.card_selection = {
      selected_count: cardSelectionBundle.card_selection.selected_count,
      min_select: cardSelectionBundle.card_selection.min_select,
      max_select: cardSelectionBundle.card_selection.max_select,
      option_count: cardSelectionBundle.card_selection.options.length,
      recommended_tool: "sts2_resolve_card_selection"
    };
  }

  return Object.keys(hints).length > 0
    ? {
        ...payload,
        interaction_hints: hints
      }
    : payload;
}

function asToolResult(payload, isError) {
  const finalPayload = isError ? payload : compactPayloadForOutput(payload);
  return {
    isError,
    content: [
      {
        type: "text",
        text: JSON.stringify(finalPayload, null, 2)
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
