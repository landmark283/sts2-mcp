using System.Collections;
using System.Buffers.Binary;
using System.Linq;
using System.Net;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Godot;
using MegaCrit.Sts2.Core.Combat;
using MegaCrit.Sts2.Core.Entities.Cards;
using MegaCrit.Sts2.Core.Entities.Creatures;
using MegaCrit.Sts2.Core.Entities.Merchant;
using MegaCrit.Sts2.Core.Entities.Players;
using MegaCrit.Sts2.Core.Entities.RestSite;
using MegaCrit.Sts2.Core.Events;
using MegaCrit.Sts2.Core.GameActions;
using MegaCrit.Sts2.Core.Map;
using MegaCrit.Sts2.Core.Models;
using MegaCrit.Sts2.Core.MonsterMoves.Intents;
using MegaCrit.Sts2.Core.MonsterMoves.MonsterMoveStateMachine;
using MegaCrit.Sts2.Core.Multiplayer.Game.PeerInput;
using MegaCrit.Sts2.Core.Nodes;
using MegaCrit.Sts2.Core.Nodes.Cards.Holders;
using MegaCrit.Sts2.Core.Nodes.Combat;
using MegaCrit.Sts2.Core.Nodes.CommonUi;
using MegaCrit.Sts2.Core.Nodes.Events;
using MegaCrit.Sts2.Core.Nodes.Rewards;
using MegaCrit.Sts2.Core.Nodes.RestSite;
using MegaCrit.Sts2.Core.Nodes.Rooms;
using MegaCrit.Sts2.Core.Nodes.Screens;
using MegaCrit.Sts2.Core.Nodes.Screens.CharacterSelect;
using MegaCrit.Sts2.Core.Nodes.Screens.CardSelection;
using MegaCrit.Sts2.Core.Nodes.Screens.Map;
using MegaCrit.Sts2.Core.Nodes.Screens.Shops;
using MegaCrit.Sts2.Core.Rewards;
using MegaCrit.Sts2.Core.Rooms;
using MegaCrit.Sts2.Core.Runs;

namespace Sts2McpBridge.Scripts;

internal sealed class BridgeActionRequest
{
    [JsonPropertyName("action_id")]
    public string? ActionId { get; set; }

    [JsonPropertyName("action")]
    public string? LegacyActionId { get; set; }

    [JsonPropertyName("expected_state_version")]
    public int? ExpectedStateVersion { get; set; }

    [JsonPropertyName("wait_after_ms")]
    public int? WaitAfterMs { get; set; }

    [JsonIgnore]
    public string? RequestedActionId => ActionId ?? LegacyActionId;
}

internal sealed class BridgeRequestException : Exception
{
    public BridgeRequestException(
        HttpStatusCode statusCode,
        string errorCode,
        string message,
        object? details = null)
        : base(message)
    {
        StatusCode = statusCode;
        ErrorCode = errorCode;
        Details = details;
    }

    public HttpStatusCode StatusCode { get; }

    public string ErrorCode { get; }

    public object? Details { get; }
}

internal static class BridgeGameApi
{
    private static readonly JsonSerializerOptions HashJsonOptions = new()
    {
        WriteIndented = false
    };

    public static Task<object> GetStateResponseAsync()
    {
        EnsureDispatcherReady();
        BridgeDebugTrace.Write("get_state requested");

        return BridgeCoordinator.RunOnMainThreadAsync(() =>
        {
            BridgeDebugTrace.Write("get_state executing on main thread");
            var snapshot = CaptureSnapshot();
            BridgeDebugTrace.Write($"get_state completed state_version={snapshot.StateVersion}");
            return snapshot.StatePayload;
        });
    }

    public static Task<object> GetActionsResponseAsync()
    {
        EnsureDispatcherReady();
        BridgeDebugTrace.Write("get_actions requested");

        return BridgeCoordinator.RunOnMainThreadAsync(() =>
        {
            BridgeDebugTrace.Write("get_actions executing on main thread");
            var snapshot = CaptureSnapshot();
            BridgeDebugTrace.Write($"get_actions completed count={snapshot.ActionPayloads.Count}");
            return CreateActionsPayload(snapshot);
        });
    }

    public static async Task<object> PerformActionResponseAsync(
        BridgeActionRequest? request,
        CancellationToken cancellationToken)
    {
        EnsureDispatcherReady();

        request ??= new BridgeActionRequest();

        var actionId = request.RequestedActionId?.Trim();
        if (string.IsNullOrWhiteSpace(actionId))
        {
            throw new BridgeRequestException(
                HttpStatusCode.BadRequest,
                "missing_action_id",
                "Request body must include a non-empty action_id.");
        }

        var before = await BridgeCoordinator.RunOnMainThreadAsync(CaptureSnapshot);
        BridgeDebugTrace.Write($"perform_action snapshot_before action={actionId} version={before.StateVersion}");

        if (request.ExpectedStateVersion is int expectedStateVersion &&
            expectedStateVersion != before.StateVersion)
        {
            throw new BridgeRequestException(
                HttpStatusCode.Conflict,
                "state_version_conflict",
                $"Expected state_version {expectedStateVersion}, but the current state_version is {before.StateVersion}.",
                new
                {
                    action_id = actionId,
                    expected_state_version = expectedStateVersion,
                    current_state_version = before.StateVersion,
                    current_state_hash = before.StateHash,
                    current_screen = before.Fields.Screen,
                    available_actions = before.ActionPayloads
                });
        }

        if (!before.ActionLookup.TryGetValue(actionId, out var action))
        {
            throw new BridgeRequestException(
                HttpStatusCode.Conflict,
                "action_not_available",
                $"Action '{actionId}' is not currently available.",
                new
                {
                    action_id = actionId,
                    current_state_version = before.StateVersion,
                    current_state_hash = before.StateHash,
                    current_screen = before.Fields.Screen,
                    available_actions = before.ActionPayloads
                });
        }

        await BridgeCoordinator.RunOnMainThreadAsync(() =>
        {
            BridgeDebugTrace.Write($"perform_action executing action={actionId}");
            action.Execute();
            return true;
        });

        var waitAfterMs = Math.Clamp(request.WaitAfterMs ?? 0, 0, 5000);
        if (waitAfterMs > 0)
        {
            await Task.Delay(waitAfterMs, cancellationToken);
        }

        var after = await BridgeCoordinator.RunOnMainThreadAsync(CaptureSnapshot);
        var autoExecutedActions = new List<object>();

        if (IsRewardResolutionAction(actionId))
        {
            (after, autoExecutedActions) = await MaybeAutoProceedAfterRewardActionAsync(after, cancellationToken);
        }
        else if (IsCardSelectionResolutionAction(actionId))
        {
            (after, autoExecutedActions) = await MaybeAutoCompleteCardSelectionAsync(after, cancellationToken);
        }

        BridgeDebugTrace.Write($"perform_action snapshot_after action={actionId} version={after.StateVersion}");

        return new
        {
            ok = true,
            action_id = actionId,
            matched_action = action.Payload,
            wait_after_ms = waitAfterMs,
            state_version_before = before.StateVersion,
            state_hash_before = before.StateHash,
            state_version_after = after.StateVersion,
            state_hash_after = after.StateHash,
            state_changed = before.StateVersion != after.StateVersion || before.StateHash != after.StateHash,
            auto_executed_actions = autoExecutedActions,
            actions = after.ActionPayloads,
            state = after.StatePayload
        };
    }

    private static BridgeSnapshot CaptureSnapshot()
    {
        BridgeDebugTrace.Write("capture_snapshot start");
        var context = CaptureContext();
        BridgeDebugTrace.Write($"capture_snapshot context screen={context.Screen}");
        var actions = BuildResolvedActions(context);
        BridgeDebugTrace.Write($"capture_snapshot actions={actions.Count}");
        var actionPayloads = actions.Select(static action => action.Payload).ToArray();
        var fields = BuildStateFields(context, actionPayloads);
        var corePayload = CreateStateCore(fields);
        var stateHash = ComputeStateHash(corePayload);
        var stateVersion = ComputeStateVersion(stateHash);
        var statePayload = CreateStatePayload(fields, stateVersion, stateHash);
        BridgeDebugTrace.Write($"capture_snapshot complete version={stateVersion}");

        return new BridgeSnapshot
        {
            Fields = fields,
            StateHash = stateHash,
            StatePayload = statePayload,
            StateVersion = stateVersion,
            Actions = actions,
            ActionPayloads = actionPayloads,
            ActionLookup = actions.ToDictionary(static action => action.ActionId, StringComparer.Ordinal)
        };
    }

    private static BridgeWorldContext CaptureContext()
    {
        var game = NGame.Instance;
        if (game is null || !GodotObject.IsInstanceValid(game))
        {
            throw new BridgeRequestException(
                HttpStatusCode.ServiceUnavailable,
                "game_not_ready",
                "NGame.Instance is not available yet.");
        }

        var runNode = game.CurrentRunNode ?? NRun.Instance;
        var runManager = RunManager.Instance;
        var combatManager = CombatManager.Instance;
        var runState = TryGetRunState(runManager);
        var combatState = TryGetCombatState(combatManager);
        var combatRoom = runNode?.CombatRoom;
        var combatUi = combatRoom?.Ui;
        var playerHand = combatUi?.Hand;
        var endTurnButton = combatUi?.EndTurnButton;
        var mapScreen = NMapScreen.Instance;
        var restSiteRoom = NRestSiteRoom.Instance;
        var restSiteProceedButton = restSiteRoom?.ProceedButton;
        var merchantRoom = NMerchantRoom.Instance;
        var merchantInventory = merchantRoom?.Inventory;
        var merchantButton = merchantRoom?.MerchantButton;
        var merchantProceedButton = merchantRoom?.ProceedButton;
        var merchantBackButton = GetHiddenFieldValue(merchantInventory, "_backButton") as NBackButton;
        var proceedButton = ResolveVisibleProceedButton(
            game,
            combatRoom?.ProceedButton,
            restSiteProceedButton,
            merchantProceedButton);
        var merchantSlots = merchantInventory is null
            ? new List<NMerchantSlot>()
            : SortByVisualPosition(merchantInventory.GetAllSlots().Where(IsNodeVisible));
        var rewardsScreen = FindFirstVisibleDescendant<NRewardsScreen>(game);
        var rewardProceedButton = ResolveFirstVisibleNode(
            GetHiddenPropertyObjectValue(rewardsScreen, "ProceedButton") as NProceedButton,
            GetHiddenFieldValue(rewardsScreen, "_proceedButton") as NProceedButton);
        var cardRewardScreen = FindFirstVisibleDescendant<NCardRewardSelectionScreen>(game);
        var characterSelectScreen = FindFirstVisibleDescendant<NCharacterSelectScreen>(game);
        var deckUpgradeScreen = FindFirstVisibleDescendant<NDeckUpgradeSelectScreen>(game);
        Node cardSelectionSearchRoot = game.GetTree()?.Root is Node sceneRoot
            ? sceneRoot
            : game;
        var cardSelectionScreen = ResolveVisibleCardSelectionScreen(
            cardSelectionSearchRoot,
            cardRewardScreen,
            deckUpgradeScreen) ?? ResolveCombatHandSelectionNode(playerHand);
        var restSiteButtons = SortByVisualPosition(FindVisibleDescendants<NRestSiteButton>(restSiteRoom));
        var characterButtons = SortByVisualPosition(FindVisibleDescendants<NCharacterSelectButton>(characterSelectScreen));
        var selectedCharacterButton = GetHiddenFieldValue(characterSelectScreen, "_selectedButton") as NCharacterSelectButton;
        var embarkButton = GetHiddenFieldValue(characterSelectScreen, "_embarkButton") as NConfirmButton;
        var rewardButtons = SortByVisualPosition(FindVisibleDescendants<NRewardButton>(rewardsScreen));
        var cardRewardOptions = SortByVisualPosition(FindVisibleDescendants<NCardHolder>(cardRewardScreen));
        var deckUpgradeOptions = deckUpgradeScreen is null
            ? new List<NCardHolder>()
            : SortByVisualPosition(
                FindVisibleDescendants<NCardHolder>(deckUpgradeScreen)
                    .Where(holder => !IsDeckUpgradePreviewHolder(deckUpgradeScreen, holder)));
        var cardSelectionOptions = GetCardSelectionOptions(cardSelectionScreen);
        var deckUpgradeCancelButton = ResolveFirstVisibleNode(
            GetHiddenFieldValue(deckUpgradeScreen, "_singlePreviewCancelButton") as NBackButton,
            GetHiddenFieldValue(deckUpgradeScreen, "_multiPreviewCancelButton") as NBackButton);
        var deckUpgradeConfirmButton = ResolveFirstVisibleNode(
            GetHiddenFieldValue(deckUpgradeScreen, "_singlePreviewConfirmButton") as NConfirmButton,
            GetHiddenFieldValue(deckUpgradeScreen, "_multiPreviewConfirmButton") as NConfirmButton);
        var deckUpgradeCloseButton = GetHiddenFieldValue(deckUpgradeScreen, "_closeButton") as NBackButton;
        var cardSelectionConfirmButton = ResolveFirstVisibleNode(
            GetHiddenFieldValue(cardSelectionScreen, "_confirmButton") as Node,
            GetHiddenFieldValue(cardSelectionScreen, "_previewConfirmButton") as Node,
            GetHiddenFieldValue(cardSelectionScreen, "_selectModeConfirmButton") as Node);
        var cardSelectionCancelButton = GetHiddenFieldValue(cardSelectionScreen, "_previewCancelButton") as Node;
        var cardSelectionCloseButton = GetHiddenFieldValue(cardSelectionScreen, "_closeButton") as Node;
        var cardSelectionSkipButton = GetHiddenFieldValue(cardSelectionScreen, "_skipButton") as Node;
        var eventOptionButtons = SortByVisualPosition(FindVisibleDescendants<NEventOptionButton>(game))
            .Where(static button => button.Option is not null)
            .ToList();
        var mapPoints = FindVisibleDescendants<NMapPoint>(mapScreen)
            .OrderBy(static point => point.Point.coord.row)
            .ThenBy(static point => point.Point.coord.col)
            .ToList();
        var mainMenuRoot = FindFirstVisibleDescendant(
            game,
            static node => IsTypeFullName(node, "MegaCrit.Sts2.Core.Nodes.Screens.MainMenu.NMainMenu"));
        var mainMenuContinueButton = FindFirstVisibleDescendant(
            game,
            static node => IsTypeFullName(node, "MegaCrit.Sts2.Core.Nodes.Screens.MainMenu.NMainMenuContinueButton"));
        var mainMenuTextButtons = SortByVisualPosition(
            FindVisibleDescendants(
                game,
                static node => IsTypeFullName(node, "MegaCrit.Sts2.Core.Nodes.Screens.MainMenu.NMainMenuTextButton")));
        var runModeSubmenu = FindFirstVisibleDescendant(
            game,
            static node => IsTypeFullName(node, "MegaCrit.Sts2.Core.Nodes.Screens.MainMenu.NSingleplayerSubmenu"));
        var runModeStandardButton = GetHiddenFieldValue(runModeSubmenu, "_standardButton") as Node;
        var runModeDailyButton = GetHiddenFieldValue(runModeSubmenu, "_dailyButton") as Node;
        var runModeCustomButton = GetHiddenFieldValue(runModeSubmenu, "_customButton") as Node;
        var runModeBackButton = GetHiddenFieldValue(runModeSubmenu, "_backButton") as NBackButton;
        var continueRunInfo = FindFirstVisibleDescendant(
            game,
            static node => IsTypeFullName(node, "MegaCrit.Sts2.Core.Nodes.Screens.MainMenu.NContinueRunInfo"));
        var abandonRunConfirmPopup = FindFirstVisibleDescendant(
            game,
            static node => IsTypeFullName(node, "MegaCrit.Sts2.Core.Nodes.CommonUi.NAbandonRunConfirmPopup"));
        var abandonRunConfirmButtons = SortByVisualPosition(FindVisibleDescendants<NPopupYesNoButton>(abandonRunConfirmPopup));

        return new BridgeWorldContext
        {
            Game = game,
            RunNode = runNode,
            RunManager = runManager,
            CombatManager = combatManager,
            RunState = runState,
            CombatState = combatState,
            Screen = ResolveCurrentScreen(
                runNode?.ScreenStateTracker,
                combatManager,
                mapScreen,
                restSiteRoom,
                merchantRoom,
                merchantInventory,
                rewardsScreen,
                rewardProceedButton,
                rewardButtons,
                cardRewardScreen,
                cardRewardOptions,
                cardSelectionScreen,
                characterSelectScreen,
                deckUpgradeScreen,
                eventOptionButtons,
                mainMenuRoot,
                runModeSubmenu,
                abandonRunConfirmPopup),
            CombatRoom = combatRoom,
            CombatUi = combatUi,
            EndTurnButton = endTurnButton,
            ProceedButton = proceedButton,
            MapScreen = mapScreen,
            RestSiteRoom = restSiteRoom,
            MerchantRoom = merchantRoom,
            MerchantInventory = merchantInventory,
            RewardsScreen = rewardsScreen,
            RewardProceedButton = rewardProceedButton,
            CardRewardScreen = cardRewardScreen,
            CardSelectionScreen = cardSelectionScreen,
            CharacterSelectScreen = characterSelectScreen,
            DeckUpgradeScreen = deckUpgradeScreen,
            RestSiteProceedButton = restSiteProceedButton,
            MerchantButton = merchantButton,
            MerchantProceedButton = merchantProceedButton,
            MerchantBackButton = merchantBackButton,
            SelectedCharacterButton = selectedCharacterButton,
            EmbarkButton = embarkButton,
            RewardButtons = rewardButtons,
            CardRewardOptions = cardRewardOptions,
            CardSelectionOptions = cardSelectionOptions,
            DeckUpgradeOptions = deckUpgradeOptions,
            CharacterButtons = characterButtons,
            EventOptionButtons = eventOptionButtons,
            MapPoints = mapPoints,
            RestSiteButtons = restSiteButtons,
            MerchantSlots = merchantSlots,
            MainMenuRoot = mainMenuRoot,
            MainMenuContinueButton = mainMenuContinueButton,
            MainMenuTextButtons = mainMenuTextButtons,
            RunModeSubmenu = runModeSubmenu,
            RunModeStandardButton = runModeStandardButton,
            RunModeDailyButton = runModeDailyButton,
            RunModeCustomButton = runModeCustomButton,
            RunModeBackButton = runModeBackButton,
            ContinueRunInfo = continueRunInfo,
            AbandonRunConfirmPopup = abandonRunConfirmPopup,
            AbandonRunConfirmButtons = abandonRunConfirmButtons,
            CardSelectionConfirmButton = cardSelectionConfirmButton,
            CardSelectionCancelButton = cardSelectionCancelButton,
            CardSelectionCloseButton = cardSelectionCloseButton,
            CardSelectionSkipButton = cardSelectionSkipButton,
            DeckUpgradeCancelButton = deckUpgradeCancelButton,
            DeckUpgradeConfirmButton = deckUpgradeConfirmButton,
            DeckUpgradeCloseButton = deckUpgradeCloseButton
        };
    }

    private static BridgeStateFields BuildStateFields(BridgeWorldContext context, object[] actionPayloads)
    {
        return new BridgeStateFields
        {
            Screen = context.Screen,
            Automation = BuildAutomationPayload(),
            Run = BuildRunPayload(context.RunState),
            Combat = BuildCombatPayload(context.CombatManager, context.CombatState),
            Players = BuildPlayersPayload(context.RunState, context.CombatManager, context.CombatState),
            Rewards = BuildRewardsPayload(
                context.RewardsScreen,
                context.RewardProceedButton,
                context.MapScreen,
                context.RewardButtons),
            CardRewardSelection = BuildCardRewardSelectionPayload(context.CardRewardScreen, context.CardRewardOptions),
            CardSelection = BuildCardSelectionPayload(
                context.CardSelectionScreen,
                context.CardSelectionOptions,
                context.CardSelectionConfirmButton,
                context.CardSelectionCancelButton,
                context.CardSelectionCloseButton,
                context.CardSelectionSkipButton),
            CharacterSelection = BuildCharacterSelectionPayload(
                context.CharacterSelectScreen,
                context.CharacterButtons,
                context.SelectedCharacterButton,
                context.EmbarkButton),
            RunModeSelection = BuildRunModeSelectionPayload(
                context.RunModeSubmenu,
                context.RunModeStandardButton,
                context.RunModeDailyButton,
                context.RunModeCustomButton,
                context.RunModeBackButton),
            EventOptions = BuildEventOptionsPayload(context.EventOptionButtons, context.MapScreen),
            Map = BuildMapPayload(context.RunState, context.MapScreen, context.MapPoints),
            RestSite = BuildRestSitePayload(
                context.MapScreen,
                context.RestSiteRoom,
                context.RestSiteButtons,
                context.RestSiteProceedButton),
            DeckUpgradeSelection = BuildDeckUpgradeSelectionPayload(
                context.DeckUpgradeScreen,
                context.DeckUpgradeOptions,
                context.DeckUpgradeConfirmButton,
                context.DeckUpgradeCancelButton,
                context.DeckUpgradeCloseButton),
            Shop = BuildShopPayload(
                context.MerchantRoom,
                context.MerchantInventory,
                context.MerchantSlots,
                context.MerchantButton,
                context.MerchantProceedButton,
                context.MerchantBackButton),
            MainMenu = BuildMainMenuPayload(
                context.MainMenuRoot,
                context.MainMenuContinueButton,
                context.MainMenuTextButtons,
                context.ContinueRunInfo,
                context.AbandonRunConfirmPopup,
                context.AbandonRunConfirmButtons),
            AvailableActions = actionPayloads
        };
    }

    private static object CreateStateCore(BridgeStateFields fields)
    {
        return new
        {
            schema_version = BridgeRuntime.StateSchemaVersion,
            screen = fields.Screen,
            automation = fields.Automation,
            run = fields.Run,
            combat = fields.Combat,
            players = fields.Players,
            rewards = fields.Rewards,
            card_reward_selection = fields.CardRewardSelection,
            card_selection = fields.CardSelection,
            character_selection = fields.CharacterSelection,
            run_mode_selection = fields.RunModeSelection,
            event_options = fields.EventOptions,
            map = fields.Map,
            rest_site = fields.RestSite,
            deck_upgrade_selection = fields.DeckUpgradeSelection,
            shop = fields.Shop,
            main_menu = fields.MainMenu,
            available_actions = fields.AvailableActions
        };
    }

    private static object CreateStatePayload(BridgeStateFields fields, int stateVersion, string stateHash)
    {
        return new
        {
            ok = true,
            bridge_version = BridgeRuntime.BridgeVersion,
            schema_version = BridgeRuntime.StateSchemaVersion,
            state_version = stateVersion,
            state_hash = stateHash,
            captured_at_utc = DateTimeOffset.UtcNow,
            screen = fields.Screen,
            automation = fields.Automation,
            run = fields.Run,
            combat = fields.Combat,
            players = fields.Players,
            rewards = fields.Rewards,
            card_reward_selection = fields.CardRewardSelection,
            card_selection = fields.CardSelection,
            character_selection = fields.CharacterSelection,
            run_mode_selection = fields.RunModeSelection,
            event_options = fields.EventOptions,
            map = fields.Map,
            rest_site = fields.RestSite,
            deck_upgrade_selection = fields.DeckUpgradeSelection,
            shop = fields.Shop,
            main_menu = fields.MainMenu,
            available_actions = fields.AvailableActions
        };
    }

    private static object CreateActionsPayload(BridgeSnapshot snapshot)
    {
        return new
        {
            ok = true,
            schema_version = BridgeRuntime.StateSchemaVersion,
            state_version = snapshot.StateVersion,
            state_hash = snapshot.StateHash,
            captured_at_utc = DateTimeOffset.UtcNow,
            screen = snapshot.Fields.Screen,
            actions = snapshot.ActionPayloads
        };
    }

    private static List<BridgeResolvedAction> BuildResolvedActions(BridgeWorldContext context)
    {
        var actions = new List<BridgeResolvedAction>();

        AddAutomationActions(actions, context);
        AddRunModeActions(actions, context);
        AddMainMenuActions(actions, context);
        AddDeckUpgradeActions(actions, context);
        AddCardSelectionActions(actions, context);
        AddRestSiteActions(actions, context);
        AddShopActions(actions, context);

        for (var index = 0; index < context.CharacterButtons.Count; index++)
        {
            var button = context.CharacterButtons[index];
            if (!IsNodeVisible(button) || button.IsLocked || ReferenceEquals(button, context.SelectedCharacterButton))
            {
                continue;
            }

            var actionId = $"character_select:{index}";
            actions.Add(new BridgeResolvedAction
            {
                ActionId = actionId,
                Payload = new
                {
                    action_id = actionId,
                    kind = "character_select",
                    index,
                    label = $"Select character {index}: {DescribeCharacter(button.Character)}",
                    character = BuildCharacterPayload(button.Character),
                    is_random = button.IsRandom,
                    screen = context.Screen
                },
                Execute = () => InvokeButtonAction(button, "ForceClick", "OnPress")
            });
        }

        if (context.EmbarkButton is not null &&
            IsNodeVisible(context.EmbarkButton) &&
            IsButtonEnabled(context.EmbarkButton))
        {
            actions.Add(new BridgeResolvedAction
            {
                ActionId = "embark",
                Payload = new
                {
                    action_id = "embark",
                    kind = "character_select",
                    label = "Embark",
                    selected_character = BuildCharacterPayload(context.SelectedCharacterButton?.Character),
                    screen = context.Screen
                },
                Execute = () => InvokeButtonAction(context.EmbarkButton, "ForceClick", "OnRelease")
            });
        }

        if (context.CombatManager?.IsInProgress == true &&
            !IsCardSelectionVisible(context) &&
            !context.CombatManager.PlayerActionsDisabled)
        {
            AddCombatCardActions(actions, context);
            AddCombatPotionActions(actions, context);
        }

        if (context.CombatManager?.IsInProgress == true &&
            !IsCardSelectionVisible(context) &&
            !context.CombatManager.PlayerActionsDisabled &&
            context.EndTurnButton is not null &&
            IsNodeVisible(context.EndTurnButton))
        {
            actions.Add(new BridgeResolvedAction
            {
                ActionId = "end_turn",
                Payload = new
                {
                    action_id = "end_turn",
                    kind = "combat",
                    label = "End Turn",
                    screen = context.Screen
                },
                Execute = () => InvokeButtonAction(context.EndTurnButton, "OnRelease", "CallReleaseLogic")
            });
        }

        AddPotionDiscardActions(actions, context);

        if (IsTerminalRewardsProceedVisible(context))
        {
            actions.Add(new BridgeResolvedAction
            {
                ActionId = "proceed",
                Payload = new
                {
                    action_id = "proceed",
                    kind = "proceed",
                    label = "Proceed from terminal rewards",
                    is_skip = false,
                    proceed_source = "terminal_rewards",
                    screen = context.Screen
                },
                Execute = () => InvokeTerminalRewardsProceed(
                    context.RunManager,
                    context.RewardsScreen,
                    context.RewardProceedButton)
            });
        }
        else if (context.MapScreen?.IsOpen != true &&
                 context.ProceedButton is not null &&
                 IsNodeVisible(context.ProceedButton))
        {
            var label = context.ProceedButton.IsSkip ? "Skip" : "Proceed";
            actions.Add(new BridgeResolvedAction
            {
                ActionId = "proceed",
                Payload = new
                {
                    action_id = "proceed",
                    kind = "proceed",
                    label,
                    is_skip = context.ProceedButton.IsSkip,
                    proceed_source = "room",
                    screen = context.Screen
                },
                Execute = () => InvokeRoomProceedAction(context)
            });
        }

        for (var index = 0; index < context.RewardButtons.Count; index++)
        {
            var button = context.RewardButtons[index];
            if (!IsNodeVisible(button))
            {
                continue;
            }

            var rewardDescription = DescribeReward(button.Reward);
            var actionId = $"reward:{index}";

            actions.Add(new BridgeResolvedAction
            {
                ActionId = actionId,
                Payload = new
                {
                    action_id = actionId,
                    kind = "reward",
                    index,
                    label = $"Claim reward {index}: {rewardDescription}",
                    reward = BuildRewardPayload(button.Reward),
                    screen = context.Screen
                },
                Execute = () => InvokeButtonAction(button, "OnRelease")
            });
        }

        if (context.CardRewardScreen is not null)
        {
            for (var index = 0; index < context.CardRewardOptions.Count; index++)
            {
                var cardHolder = context.CardRewardOptions[index];
                if (!IsNodeVisible(cardHolder))
                {
                    continue;
                }

                var actionId = $"card_reward:{index}";
                actions.Add(new BridgeResolvedAction
                {
                    ActionId = actionId,
                    Payload = new
                    {
                        action_id = actionId,
                        kind = "card_reward",
                        index,
                        label = $"Pick card {index}: {cardHolder.CardModel?.Title ?? "<missing>"}",
                        card = BuildCardPayload(cardHolder.CardModel),
                        screen = context.Screen
                    },
                    Execute = () => InvokeSingleArgumentAction(context.CardRewardScreen, "SelectCard", cardHolder)
                });
            }
        }

        if (context.MapScreen is null || !context.MapScreen.IsOpen)
        {
            for (var index = 0; index < context.EventOptionButtons.Count; index++)
            {
                var button = context.EventOptionButtons[index];
                var option = button.Option;
                if (!IsNodeVisible(button) || option is null || option.IsLocked)
                {
                    continue;
                }

                var actionId = $"event_option:{index}";
                actions.Add(new BridgeResolvedAction
                {
                    ActionId = actionId,
                    Payload = new
                    {
                        action_id = actionId,
                        kind = "event_option",
                        index,
                        label = $"Choose option {index}: {TextOf(option.Title)}",
                        option = BuildEventOptionPayload(button, index),
                        screen = context.Screen
                    },
                    Execute = () => InvokeButtonAction(button, "OnRelease")
                });
            }
        }

        if (context.MapScreen is not null &&
            context.MapScreen.IsOpen &&
            context.MapScreen.IsTravelEnabled &&
            !context.MapScreen.IsTraveling)
        {
            foreach (var pointNode in context.MapPoints)
            {
                if (!IsMapPointTravelable(pointNode))
                {
                    continue;
                }

                var coord = pointNode.Point.coord;
                var actionId = $"map:{coord.col},{coord.row}";
                actions.Add(new BridgeResolvedAction
                {
                    ActionId = actionId,
                    Payload = new
                    {
                        action_id = actionId,
                        kind = "map",
                        label = $"Travel to ({coord.col}, {coord.row}) {pointNode.Point.PointType}",
                        coord = BuildMapCoord(coord),
                        point_type = pointNode.Point.PointType.ToString(),
                        state = pointNode.State.ToString(),
                        screen = context.Screen
                    },
                    Execute = () => InvokeButtonAction(pointNode, "OnRelease")
                });
            }
        }

        return actions;
    }

    private static void AddRunModeActions(List<BridgeResolvedAction> actions, BridgeWorldContext context)
    {
        if (!IsRunModeSelectionVisible(context))
        {
            return;
        }

        AddRunModeAction(
            actions,
            context,
            context.RunModeStandardButton,
            "standard",
            "Start standard run",
            "OpenCharacterSelect");
        AddRunModeAction(
            actions,
            context,
            context.RunModeDailyButton,
            "daily",
            "Open daily challenge",
            "OpenDailyScreen");
        AddRunModeAction(
            actions,
            context,
            context.RunModeCustomButton,
            "custom",
            "Open custom run setup",
            "OpenCustomScreen");

        if (context.RunModeBackButton is null || !IsNodeVisible(context.RunModeBackButton))
        {
            return;
        }

        actions.Add(new BridgeResolvedAction
        {
            ActionId = "run_mode:back",
            Payload = new
            {
                action_id = "run_mode:back",
                kind = "run_mode_selection",
                run_mode_action = "back",
                button_text = TryGetNodeText(context.RunModeBackButton),
                label = "Back",
                screen = context.Screen
            },
            Execute = () => InvokeMenuButtonAction(context.RunModeBackButton)
        });
    }

    private static void AddRestSiteActions(List<BridgeResolvedAction> actions, BridgeWorldContext context)
    {
        if (IsDeckUpgradeSelectionVisible(context))
        {
            return;
        }

        if (context.MapScreen?.IsOpen == true)
        {
            return;
        }

        if (context.RestSiteRoom is null || !IsNodeVisible(context.RestSiteRoom))
        {
            return;
        }

        var canProceed = !HasVisibleRestSiteOptions(context.RestSiteButtons);

        for (var index = 0; index < context.RestSiteButtons.Count; index++)
        {
            var button = context.RestSiteButtons[index];
            var option = button.Option;
            if (!IsNodeVisible(button) || option is null)
            {
                continue;
            }

            var actionId = $"rest_site:{index}";
            actions.Add(new BridgeResolvedAction
            {
                ActionId = actionId,
                Payload = new
                {
                    action_id = actionId,
                    kind = "rest_site",
                    index,
                    label = $"Rest site option {index}: {TextOf(option.Title)}",
                    option = BuildRestSiteOptionPayload(option, index),
                    screen = context.Screen
                },
                Execute = () => InvokeClickablePressAndRelease(button)
            });
        }

        if (canProceed &&
            context.RestSiteProceedButton is not null &&
            IsNodeVisible(context.RestSiteProceedButton))
        {
            actions.Add(new BridgeResolvedAction
            {
                ActionId = "rest_site:proceed",
                Payload = new
                {
                    action_id = "rest_site:proceed",
                    kind = "rest_site",
                    label = "Rest site proceed",
                    screen = context.Screen
                },
                Execute = () => InvokeRestSiteProceedAction(context.RestSiteRoom, context.RestSiteProceedButton)
            });
        }
    }

    private static void AddDeckUpgradeActions(List<BridgeResolvedAction> actions, BridgeWorldContext context)
    {
        if (!IsDeckUpgradeSelectionVisible(context) || context.DeckUpgradeScreen is null)
        {
            return;
        }

        for (var index = 0; index < context.DeckUpgradeOptions.Count; index++)
        {
            var cardHolder = context.DeckUpgradeOptions[index];
            if (!IsNodeVisible(cardHolder) || cardHolder.CardModel is null)
            {
                continue;
            }

            var actionId = $"deck_upgrade:select:{index}";
            actions.Add(new BridgeResolvedAction
            {
                ActionId = actionId,
                Payload = new
                {
                    action_id = actionId,
                    kind = "deck_upgrade",
                    upgrade_action = "select_card",
                    index,
                    label = $"Select upgrade card {index}: {cardHolder.CardModel.Title}",
                    card = BuildCardPayload(cardHolder.CardModel),
                    screen = context.Screen
                },
                Execute = () => InvokeSingleArgumentAction(context.DeckUpgradeScreen, "OnCardClicked", cardHolder.CardModel)
            });
        }

        if (context.DeckUpgradeConfirmButton is not null &&
            IsNodeVisible(context.DeckUpgradeConfirmButton) &&
            IsButtonEnabled(context.DeckUpgradeConfirmButton))
        {
            actions.Add(new BridgeResolvedAction
            {
                ActionId = "deck_upgrade:confirm",
                Payload = new
                {
                    action_id = "deck_upgrade:confirm",
                    kind = "deck_upgrade",
                    upgrade_action = "confirm",
                    label = "Confirm upgrade selection",
                    screen = context.Screen
                },
                Execute = () => InvokeSingleArgumentAction(
                    context.DeckUpgradeScreen,
                    "ConfirmSelection",
                    context.DeckUpgradeConfirmButton)
            });
        }

        if (context.DeckUpgradeCancelButton is not null &&
            IsNodeVisible(context.DeckUpgradeCancelButton) &&
            IsButtonEnabled(context.DeckUpgradeCancelButton))
        {
            actions.Add(new BridgeResolvedAction
            {
                ActionId = "deck_upgrade:cancel",
                Payload = new
                {
                    action_id = "deck_upgrade:cancel",
                    kind = "deck_upgrade",
                    upgrade_action = "cancel",
                    label = "Cancel upgrade selection",
                    screen = context.Screen
                },
                Execute = () => InvokeSingleArgumentAction(
                    context.DeckUpgradeScreen,
                    "CancelSelection",
                    context.DeckUpgradeCancelButton)
            });
        }

        if (context.DeckUpgradeCloseButton is not null &&
            IsNodeVisible(context.DeckUpgradeCloseButton) &&
            IsButtonEnabled(context.DeckUpgradeCloseButton))
        {
            actions.Add(new BridgeResolvedAction
            {
                ActionId = "deck_upgrade:close",
                Payload = new
                {
                    action_id = "deck_upgrade:close",
                    kind = "deck_upgrade",
                    upgrade_action = "close",
                    label = "Close upgrade selection",
                    screen = context.Screen
                },
                Execute = () => InvokeSingleArgumentAction(
                    context.DeckUpgradeScreen,
                    "CloseSelection",
                    context.DeckUpgradeCloseButton)
            });
        }
    }

    private static void AddCardSelectionActions(List<BridgeResolvedAction> actions, BridgeWorldContext context)
    {
        if (!IsCardSelectionVisible(context))
        {
            return;
        }

        for (var index = 0; index < context.CardSelectionOptions.Count; index++)
        {
            var cardHolder = context.CardSelectionOptions[index];
            if (!IsNodeVisible(cardHolder))
            {
                continue;
            }

            var actionId = $"card_selection:select:{index}";
            actions.Add(new BridgeResolvedAction
            {
                ActionId = actionId,
                Payload = new
                {
                    action_id = actionId,
                    kind = "card_selection",
                    selection_action = "select",
                    index,
                    label = $"Select card {index}: {cardHolder.CardModel?.Title ?? "<missing>"}",
                    card = BuildCardPayload(cardHolder.CardModel),
                    screen = context.Screen,
                    screen_type = context.CardSelectionScreen?.GetType().Name
                },
                Execute = () => InvokeCardSelectionOptionAction(context.CardSelectionScreen, cardHolder)
            });
        }

        if (context.CardSelectionConfirmButton is not null &&
            IsNodeVisible(context.CardSelectionConfirmButton) &&
            IsButtonEnabled(context.CardSelectionConfirmButton))
        {
            actions.Add(new BridgeResolvedAction
            {
                ActionId = "card_selection:confirm",
                Payload = new
                {
                    action_id = "card_selection:confirm",
                    kind = "card_selection",
                    selection_action = "confirm",
                    label = "Confirm selected cards",
                    screen = context.Screen,
                    screen_type = context.CardSelectionScreen?.GetType().Name
                },
                Execute = () => InvokeCardSelectionConfirmAction(
                    context.CardSelectionScreen,
                    context.CardSelectionConfirmButton)
            });
        }

        if (context.CardSelectionCancelButton is not null &&
            IsNodeVisible(context.CardSelectionCancelButton) &&
            IsButtonEnabled(context.CardSelectionCancelButton))
        {
            actions.Add(new BridgeResolvedAction
            {
                ActionId = "card_selection:cancel",
                Payload = new
                {
                    action_id = "card_selection:cancel",
                    kind = "card_selection",
                    selection_action = "cancel",
                    label = "Cancel card selection preview",
                    screen = context.Screen,
                    screen_type = context.CardSelectionScreen?.GetType().Name
                },
                Execute = () => InvokeCardSelectionCancelAction(
                    context.CardSelectionScreen,
                    context.CardSelectionCancelButton)
            });
        }

        if (context.CardSelectionCloseButton is not null &&
            IsNodeVisible(context.CardSelectionCloseButton) &&
            IsButtonEnabled(context.CardSelectionCloseButton))
        {
            actions.Add(new BridgeResolvedAction
            {
                ActionId = "card_selection:close",
                Payload = new
                {
                    action_id = "card_selection:close",
                    kind = "card_selection",
                    selection_action = "close",
                    label = "Close card selection",
                    screen = context.Screen,
                    screen_type = context.CardSelectionScreen?.GetType().Name
                },
                Execute = () => InvokeCardSelectionCloseAction(
                    context.CardSelectionScreen,
                    context.CardSelectionCloseButton)
            });
        }

        if (context.CardSelectionSkipButton is not null &&
            IsNodeVisible(context.CardSelectionSkipButton) &&
            IsButtonEnabled(context.CardSelectionSkipButton))
        {
            actions.Add(new BridgeResolvedAction
            {
                ActionId = "card_selection:skip",
                Payload = new
                {
                    action_id = "card_selection:skip",
                    kind = "card_selection",
                    selection_action = "skip",
                    label = "Skip card selection",
                    screen = context.Screen,
                    screen_type = context.CardSelectionScreen?.GetType().Name
                },
                Execute = () => InvokeCardSelectionSkipAction(
                    context.CardSelectionScreen,
                    context.CardSelectionSkipButton)
            });
        }
    }

    private static void AddShopActions(List<BridgeResolvedAction> actions, BridgeWorldContext context)
    {
        if (context.MerchantRoom is null ||
            (!IsNodeVisible(context.MerchantRoom) && context.MerchantInventory?.IsOpen != true))
        {
            return;
        }

        var inventoryIsOpen = context.MerchantInventory?.IsOpen == true;

        if (!inventoryIsOpen &&
            context.MerchantButton is not null &&
            IsNodeVisible(context.MerchantButton))
        {
            actions.Add(new BridgeResolvedAction
            {
                ActionId = "shop:open",
                Payload = new
                {
                    action_id = "shop:open",
                    kind = "shop",
                    shop_action = "open",
                    label = "Open merchant inventory",
                    screen = context.Screen
                },
                Execute = () => InvokeButtonAction(context.MerchantButton, "OnRelease", "OnPress")
            });
        }

        if (inventoryIsOpen && context.MerchantInventory is not null)
        {
            for (var index = 0; index < context.MerchantSlots.Count; index++)
            {
                var slot = context.MerchantSlots[index];
                var entry = slot.Entry;
                if (!IsNodeVisible(slot) || !CanPurchaseMerchantEntry(entry))
                {
                    continue;
                }

                var actionId = $"shop:buy:{index}";
                actions.Add(new BridgeResolvedAction
                {
                    ActionId = actionId,
                    Payload = new
                    {
                        action_id = actionId,
                        kind = "shop",
                        shop_action = "buy",
                        index,
                        label = $"Buy shop item {index}: {DescribeMerchantEntry(entry)}",
                        item = BuildShopSlotPayload(slot, index),
                        screen = context.Screen
                    },
                    Execute = () => ExecuteShopPurchase(slot, context.MerchantInventory)
                });
            }
        }

        if (context.MerchantBackButton is not null && IsNodeVisible(context.MerchantBackButton))
        {
            actions.Add(new BridgeResolvedAction
            {
                ActionId = "shop:back",
                Payload = new
                {
                    action_id = "shop:back",
                    kind = "shop",
                    shop_action = "back",
                    label = "Close merchant inventory",
                    screen = context.Screen
                },
                Execute = () => InvokeButtonAction(context.MerchantBackButton, "OnPress")
            });
        }

        if (context.MerchantProceedButton is not null && IsNodeVisible(context.MerchantProceedButton))
        {
            actions.Add(new BridgeResolvedAction
            {
                ActionId = "shop:leave",
                Payload = new
                {
                    action_id = "shop:leave",
                    kind = "shop",
                    shop_action = "leave",
                    label = "Leave shop",
                    screen = context.Screen
                },
                Execute = () => InvokeMerchantLeaveAction(context.MerchantRoom, context.MerchantProceedButton)
            });
        }
    }

    private static void AddAutomationActions(List<BridgeResolvedAction> actions, BridgeWorldContext context)
    {
        var automationPayload = BuildAutomationPayload();
        if (BridgeAutoSlay.IsActive)
        {
            actions.Add(new BridgeResolvedAction
            {
                ActionId = "automation:stop_autoslay",
                Payload = new
                {
                    action_id = "automation:stop_autoslay",
                    kind = "automation",
                    automation_action = "stop_autoslay",
                    label = "Stop AutoSlay",
                    automation = automationPayload,
                    screen = context.Screen
                },
                Execute = BridgeAutoSlay.Stop
            });

            return;
        }

        actions.Add(new BridgeResolvedAction
        {
            ActionId = "automation:start_autoslay",
            Payload = new
            {
                action_id = "automation:start_autoslay",
                kind = "automation",
                automation_action = "start_autoslay",
                label = "Start AutoSlay",
                automation = automationPayload,
                screen = context.Screen
            },
            Execute = () => BridgeAutoSlay.Start()
        });
    }

    private static void AddMainMenuActions(List<BridgeResolvedAction> actions, BridgeWorldContext context)
    {
        if (IsRunModeSelectionVisible(context))
        {
            return;
        }

        if (context.AbandonRunConfirmPopup is not null && IsNodeVisible(context.AbandonRunConfirmPopup))
        {
            for (var index = 0; index < context.AbandonRunConfirmButtons.Count; index++)
            {
                var button = context.AbandonRunConfirmButtons[index];
                if (!IsNodeVisible(button))
                {
                    continue;
                }

                var buttonText = TryGetNodeText(button);
                var semanticAction = TryGetAbandonConfirmSemanticAction(buttonText);
                var actionId = semanticAction switch
                {
                    "confirm" => "main_menu:confirm_abandon_run",
                    "cancel" => "main_menu:cancel_abandon_run",
                    _ => $"main_menu:abandon_confirm:{index}"
                };
                var label = semanticAction switch
                {
                    "confirm" => "Confirm abandon current game",
                    "cancel" => "Cancel abandon current game",
                    _ when !string.IsNullOrWhiteSpace(buttonText) => $"Abandon confirmation: {buttonText}",
                    _ => $"Abandon confirmation button {index}"
                };

                actions.Add(new BridgeResolvedAction
                {
                    ActionId = actionId,
                    Payload = new
                    {
                        action_id = actionId,
                        kind = "main_menu",
                        menu_action = semanticAction ?? "abandon_confirm_button",
                        button_index = index,
                        button_text = buttonText,
                        label,
                        screen = context.Screen
                    },
                    Execute = () => InvokeMenuButtonAction(button)
                });
            }

            return;
        }

        if (context.MainMenuContinueButton is not null && IsNodeVisible(context.MainMenuContinueButton))
        {
            var buttonText = TryGetNodeText(context.MainMenuContinueButton);
            actions.Add(new BridgeResolvedAction
            {
                ActionId = "main_menu:continue",
                Payload = new
                {
                    action_id = "main_menu:continue",
                    kind = "main_menu",
                    menu_action = "continue",
                    button_text = buttonText,
                    label = !string.IsNullOrWhiteSpace(buttonText) ? buttonText : "Continue Game",
                    screen = context.Screen
                },
                Execute = () => InvokeMenuButtonAction(context.MainMenuContinueButton)
            });
        }

        for (var index = 0; index < context.MainMenuTextButtons.Count; index++)
        {
            var button = context.MainMenuTextButtons[index];
            if (!IsNodeVisible(button))
            {
                continue;
            }

            var buttonText = TryGetNodeText(button);
            var semanticAction = TryGetMainMenuSemanticAction(buttonText);
            var actionId = semanticAction is not null
                ? $"main_menu:{semanticAction}"
                : $"main_menu:button:{index}";
            var label = !string.IsNullOrWhiteSpace(buttonText)
                ? buttonText
                : $"Main menu button {index}";

            if (actions.Any(existing => existing.ActionId.Equals(actionId, StringComparison.Ordinal)))
            {
                actionId = $"main_menu:button:{index}";
            }

            actions.Add(new BridgeResolvedAction
            {
                ActionId = actionId,
                Payload = new
                {
                    action_id = actionId,
                    kind = "main_menu",
                    menu_action = semanticAction ?? "button",
                    button_index = index,
                    button_text = buttonText,
                    label,
                    screen = context.Screen
                },
                Execute = () => InvokeMenuButtonAction(button)
            });
        }
    }

    private static void AddRunModeAction(
        List<BridgeResolvedAction> actions,
        BridgeWorldContext context,
        Node? button,
        string actionSuffix,
        string fallbackLabel,
        string submenuMethodName)
    {
        if (button is null || !IsNodeVisible(button))
        {
            return;
        }

        var texts = CollectVisibleText(button, 4).ToArray();
        var buttonText = texts.FirstOrDefault(static text => !string.IsNullOrWhiteSpace(text)) ?? fallbackLabel;
        var actionId = $"run_mode:{actionSuffix}";

        actions.Add(new BridgeResolvedAction
        {
            ActionId = actionId,
            Payload = new
            {
                action_id = actionId,
                kind = "run_mode_selection",
                run_mode_action = actionSuffix,
                button_text = buttonText,
                texts,
                label = fallbackLabel,
                screen = context.Screen
            },
            Execute = () => InvokeRunModeSelectionAction(context.RunModeSubmenu, button, submenuMethodName)
        });
    }

    private static void AddCombatCardActions(List<BridgeResolvedAction> actions, BridgeWorldContext context)
    {
        if (context.CombatState is null)
        {
            return;
        }

        for (var playerIndex = 0; playerIndex < context.CombatState.Players.Count; playerIndex++)
        {
            var player = context.CombatState.Players[playerIndex];
            var handCards = player.PlayerCombatState?.Hand?.Cards;
            if (handCards is null)
            {
                continue;
            }

            for (var handIndex = 0; handIndex < handCards.Count; handIndex++)
            {
                var card = handCards[handIndex];
                if (card is null || !CanPlayCard(card))
                {
                    continue;
                }

                foreach (var resolvedTarget in ResolvePlayableCardTargets(context, player, card))
                {
                    var actionId = $"play_card:{playerIndex}:{handIndex}";
                    if (!string.IsNullOrEmpty(resolvedTarget.ActionSuffix))
                    {
                        actionId += $":{resolvedTarget.ActionSuffix}";
                    }

                    var targetLabel = string.IsNullOrEmpty(resolvedTarget.LabelSuffix)
                        ? string.Empty
                        : $" -> {resolvedTarget.LabelSuffix}";
                    var cardTitle = TextOf(card.Title);

                    actions.Add(new BridgeResolvedAction
                    {
                        ActionId = actionId,
                        Payload = new
                        {
                            action_id = actionId,
                            kind = "play_card",
                            label = $"Play card {handIndex}: {cardTitle}{targetLabel}",
                            player_index = playerIndex,
                            player_net_id = player.NetId,
                            hand_index = handIndex,
                            card = BuildCardPayload(card),
                            target = resolvedTarget.Target is null ? null : BuildCreaturePayload(resolvedTarget.Target),
                            target_scope = card.TargetType.ToString(),
                            requires_target_selection = resolvedTarget.RequiresTargetSelection,
                            screen = context.Screen
                        },
                        Execute = () => ExecuteCardPlay(card, resolvedTarget.Target)
                    });
                }
            }
        }
    }

    private static void AddCombatPotionActions(List<BridgeResolvedAction> actions, BridgeWorldContext context)
    {
        if (context.CombatState is null)
        {
            return;
        }

        for (var playerIndex = 0; playerIndex < context.CombatState.Players.Count; playerIndex++)
        {
            var player = context.CombatState.Players[playerIndex];
            var potionSlots = player.PotionSlots;
            if (potionSlots is null)
            {
                continue;
            }

            for (var slotIndex = 0; slotIndex < potionSlots.Count; slotIndex++)
            {
                var potion = potionSlots[slotIndex];
                if (potion is null || !CanUsePotion(potion))
                {
                    continue;
                }

                foreach (var resolvedTarget in ResolveUsablePotionTargets(context, player, potion))
                {
                    var actionId = $"use_potion:{playerIndex}:{slotIndex}";
                    if (!string.IsNullOrEmpty(resolvedTarget.ActionSuffix))
                    {
                        actionId += $":{resolvedTarget.ActionSuffix}";
                    }

                    var targetLabel = string.IsNullOrEmpty(resolvedTarget.LabelSuffix)
                        ? string.Empty
                        : $" -> {resolvedTarget.LabelSuffix}";
                    var potionTitle = TextOf(potion.Title);

                    actions.Add(new BridgeResolvedAction
                    {
                        ActionId = actionId,
                        Payload = new
                        {
                            action_id = actionId,
                            kind = "use_potion",
                            label = $"Use potion {slotIndex}: {potionTitle}{targetLabel}",
                            player_index = playerIndex,
                            player_net_id = player.NetId,
                            slot_index = slotIndex,
                            potion = BuildPotionPayload(potion),
                            target = resolvedTarget.Target is null ? null : BuildCreaturePayload(resolvedTarget.Target),
                            target_scope = potion.TargetType.ToString(),
                            requires_target_selection = resolvedTarget.RequiresTargetSelection,
                            screen = context.Screen
                        },
                        Execute = () => ExecutePotionUse(
                            player,
                            slotIndex,
                            potion,
                            resolvedTarget.Target,
                            context.CombatManager?.IsInProgress == true)
                    });
                }
            }
        }
    }

    private static void AddPotionDiscardActions(List<BridgeResolvedAction> actions, BridgeWorldContext context)
    {
        if (IsCardSelectionVisible(context))
        {
            return;
        }

        var players = context.RunState?.Players ?? context.CombatState?.Players ?? Array.Empty<Player>();
        for (var playerIndex = 0; playerIndex < players.Count; playerIndex++)
        {
            var player = players[playerIndex];
            var potionSlots = player.PotionSlots;
            if (potionSlots is null || !player.CanRemovePotions)
            {
                continue;
            }

            for (var slotIndex = 0; slotIndex < potionSlots.Count; slotIndex++)
            {
                var potion = potionSlots[slotIndex];
                if (!CanDiscardPotion(player, potion))
                {
                    continue;
                }

                var actionId = $"discard_potion:{playerIndex}:{slotIndex}";
                var potionTitle = TextOf(potion!.Title);
                actions.Add(new BridgeResolvedAction
                {
                    ActionId = actionId,
                    Payload = new
                    {
                        action_id = actionId,
                        kind = "discard_potion",
                        label = $"Discard potion {slotIndex}: {potionTitle}",
                        player_index = playerIndex,
                        player_net_id = player.NetId,
                        slot_index = slotIndex,
                        potion = BuildPotionPayload(potion),
                        can_remove_potions = player.CanRemovePotions,
                        screen = context.Screen
                    },
                    Execute = () => ExecutePotionDiscard(
                        player,
                        slotIndex,
                        potion,
                        context.CombatManager?.IsInProgress == true)
                });
            }
        }
    }

    private static IReadOnlyList<ResolvedCardTarget> ResolvePlayableCardTargets(
        BridgeWorldContext context,
        Player player,
        CardModel card)
    {
        var results = new List<ResolvedCardTarget>();
        var selfCreature = player.Creature;

        switch (card.TargetType)
        {
            case TargetType.AnyEnemy:
                foreach (var creature in context.CombatState?.Creatures ?? Array.Empty<Creature>())
                {
                    if (!creature.IsEnemy || !IsCombatTargetAvailable(creature) || !CanPlayCardTargeting(card, creature))
                    {
                        continue;
                    }

                    results.Add(new ResolvedCardTarget
                    {
                        ActionSuffix = creature.CombatId.ToString(),
                        LabelSuffix = DescribeCreatureTarget(creature),
                        Target = creature,
                        RequiresTargetSelection = true
                    });
                }
                break;

            case TargetType.AnyPlayer:
            case TargetType.AnyAlly:
                foreach (var creature in context.CombatState?.PlayerCreatures ?? Array.Empty<Creature>())
                {
                    if (!IsCombatTargetAvailable(creature) || !CanPlayCardTargeting(card, creature))
                    {
                        continue;
                    }

                    results.Add(new ResolvedCardTarget
                    {
                        ActionSuffix = creature.CombatId.ToString(),
                        LabelSuffix = DescribeCreatureTarget(creature),
                        Target = creature,
                        RequiresTargetSelection = true
                    });
                }
                break;

            case TargetType.Self:
                if (selfCreature is not null && selfCreature.IsAlive)
                {
                    results.Add(new ResolvedCardTarget
                    {
                        ActionSuffix = "self",
                        LabelSuffix = "self",
                        Target = selfCreature,
                        RequiresTargetSelection = false
                    });
                }
                break;

            case TargetType.None:
            case TargetType.AllEnemies:
            case TargetType.RandomEnemy:
            case TargetType.AllAllies:
            case TargetType.TargetedNoCreature:
            case TargetType.Osty:
            default:
                results.Add(new ResolvedCardTarget
                {
                    ActionSuffix = null,
                    LabelSuffix = null,
                    Target = null,
                    RequiresTargetSelection = false
                });
                break;
        }

        return results;
    }

    private static IReadOnlyList<ResolvedPotionTarget> ResolveUsablePotionTargets(
        BridgeWorldContext context,
        Player player,
        PotionModel potion)
    {
        var results = new List<ResolvedPotionTarget>();
        var selfCreature = player.Creature;
        var canThrowAtAlly = SafeCanThrowPotionAtAlly(potion);

        void AddResolvedTarget(Creature? target, string? actionSuffix, string? labelSuffix, bool requiresTargetSelection)
        {
            if (target is null)
            {
                if (!results.Any(static existing => existing.Target is null))
                {
                    results.Add(new ResolvedPotionTarget
                    {
                        ActionSuffix = actionSuffix,
                        LabelSuffix = labelSuffix,
                        Target = null,
                        RequiresTargetSelection = requiresTargetSelection
                    });
                }

                return;
            }

            if (results.Any(existing => ReferenceEquals(existing.Target, target)))
            {
                return;
            }

            results.Add(new ResolvedPotionTarget
            {
                ActionSuffix = actionSuffix,
                LabelSuffix = labelSuffix,
                Target = target,
                RequiresTargetSelection = requiresTargetSelection
            });
        }

        switch (potion.TargetType)
        {
            case TargetType.AnyEnemy:
                foreach (var creature in context.CombatState?.Creatures ?? Array.Empty<Creature>())
                {
                    if (!creature.IsEnemy || !CanUsePotionTargeting(potion, creature))
                    {
                        continue;
                    }

                    AddResolvedTarget(
                        creature,
                        creature.CombatId.ToString(),
                        DescribeCreatureTarget(creature),
                        true);
                }

                if (canThrowAtAlly)
                {
                    foreach (var creature in context.CombatState?.PlayerCreatures ?? Array.Empty<Creature>())
                    {
                        if (!CanUsePotionTargeting(potion, creature))
                        {
                            continue;
                        }

                        AddResolvedTarget(
                            creature,
                            creature.CombatId.ToString(),
                            DescribeCreatureTarget(creature),
                            true);
                    }
                }
                break;

            case TargetType.AnyPlayer:
            case TargetType.AnyAlly:
                foreach (var creature in context.CombatState?.PlayerCreatures ?? Array.Empty<Creature>())
                {
                    if (!CanUsePotionTargeting(potion, creature))
                    {
                        continue;
                    }

                    AddResolvedTarget(
                        creature,
                        creature.CombatId.ToString(),
                        DescribeCreatureTarget(creature),
                        true);
                }
                break;

            case TargetType.Self:
                if (selfCreature is not null && CanUsePotionTargeting(potion, selfCreature))
                {
                    AddResolvedTarget(selfCreature, "self", "self", false);
                }
                break;

            case TargetType.None:
            case TargetType.AllEnemies:
            case TargetType.RandomEnemy:
            case TargetType.AllAllies:
            case TargetType.TargetedNoCreature:
            case TargetType.Osty:
            default:
                AddResolvedTarget(null, null, null, false);
                break;
        }

        return results;
    }

    private static void ExecuteCardPlay(CardModel card, Creature? target)
    {
        var executionTargets = BuildCardExecutionTargets(card, target);
        var tryManualPlayMethod = FindMethod(card.GetType(), "TryManualPlay", 1);
        if (tryManualPlayMethod is not null)
        {
            foreach (var executionTarget in executionTargets)
            {
                var result = tryManualPlayMethod.Invoke(card, new object?[] { executionTarget });
                if (result is bool success && success)
                {
                    return;
                }
            }
        }

        var enqueueManualPlayMethod = FindMethod(card.GetType(), "EnqueueManualPlay", 1);
        if (enqueueManualPlayMethod is not null)
        {
            enqueueManualPlayMethod.Invoke(card, new object?[] { executionTargets[0] });
            return;
        }

        throw new BridgeRequestException(
            HttpStatusCode.Conflict,
            "play_card_failed",
            $"Could not play card '{TextOf(card.Title)}' with the current bridge integration.");
    }

    private static void ExecutePotionUse(
        Player player,
        int slotIndex,
        PotionModel potion,
        Creature? target,
        bool isCombatInProgress)
    {
        try
        {
            potion.EnqueueManualUse(target!);
            return;
        }
        catch
        {
        }

        try
        {
            var action = new UsePotionAction(potion, target!, isCombatInProgress);
            ExecuteGameActionSynchronously(action);
            return;
        }
        catch
        {
        }

        throw new BridgeRequestException(
            HttpStatusCode.Conflict,
            "use_potion_failed",
            $"Could not use potion '{TextOf(potion.Title)}' from slot {slotIndex}.");
    }

    private static void ExecutePotionDiscard(
        Player player,
        int slotIndex,
        PotionModel potion,
        bool isCombatInProgress)
    {
        try
        {
            potion.Discard();
            return;
        }
        catch
        {
        }

        try
        {
            var action = new DiscardPotionGameAction(player, (uint)slotIndex, isCombatInProgress);
            ExecuteGameActionSynchronously(action);
            return;
        }
        catch
        {
        }

        throw new BridgeRequestException(
            HttpStatusCode.Conflict,
            "discard_potion_failed",
            $"Could not discard potion '{TextOf(potion.Title)}' from slot {slotIndex}.");
    }

    private static IReadOnlyList<Creature?> BuildCardExecutionTargets(CardModel card, Creature? target)
    {
        var targets = new List<Creature?>();

        void AddTarget(Creature? candidate)
        {
            if (candidate is null)
            {
                if (!targets.Any(static existing => existing is null))
                {
                    targets.Add(null);
                }

                return;
            }

            if (!targets.Any(existing => ReferenceEquals(existing, candidate)))
            {
                targets.Add(candidate);
            }
        }

        switch (card.TargetType)
        {
            case TargetType.Self:
            case TargetType.None:
            case TargetType.AllEnemies:
            case TargetType.RandomEnemy:
            case TargetType.AllAllies:
            case TargetType.TargetedNoCreature:
            case TargetType.Osty:
                AddTarget(null);
                AddTarget(target);
                break;

            default:
                AddTarget(target);
                AddTarget(null);
                break;
        }

        return targets;
    }

    private static bool CanPlayCard(CardModel card)
    {
        if (TryInvokeBoolean(card, "CanPlay") is bool canPlay)
        {
            return canPlay;
        }

        return GetHiddenPropertyValue<bool>(card, "IsPlayable") ?? false;
    }

    private static bool CanPlayCardTargeting(CardModel card, Creature target)
    {
        if (TryInvokeBoolean(card, "CanPlayTargeting", target) is bool canPlayTargeting)
        {
            return canPlayTargeting;
        }

        if (TryInvokeBoolean(card, "IsValidTarget", target) is bool isValidTarget)
        {
            return isValidTarget;
        }

        return false;
    }

    private static bool IsCombatTargetAvailable(Creature creature)
    {
        return creature.IsAlive && SafeGetCreatureIsHittable(creature);
    }

    private static bool IsPotionTargetAvailable(Creature creature)
    {
        return creature.IsEnemy
            ? creature.IsAlive && SafeGetCreatureIsHittable(creature)
            : creature.IsAlive;
    }

    private static bool CanUsePotion(PotionModel? potion)
    {
        if (potion is null)
        {
            return false;
        }

        try
        {
            return potion.Owner is not null &&
                   !potion.HasBeenRemovedFromState &&
                   !potion.IsQueued &&
                   potion.PassesCustomUsabilityCheck;
        }
        catch
        {
            return false;
        }
    }

    private static bool CanDiscardPotion(Player player, PotionModel? potion)
    {
        if (potion is null)
        {
            return false;
        }

        try
        {
            return player.CanRemovePotions && !potion.HasBeenRemovedFromState;
        }
        catch
        {
            return false;
        }
    }

    private static bool CanUsePotionTargeting(PotionModel potion, Creature target)
    {
        if (!IsPotionTargetAvailable(target))
        {
            return false;
        }

        if (TryInvokeBoolean(potion, "ShouldAllowTargeting", target) is bool shouldAllowTargeting)
        {
            return shouldAllowTargeting;
        }

        return potion.TargetType switch
        {
            TargetType.Self => ReferenceEquals(target, potion.Owner?.Creature),
            TargetType.AnyEnemy => target.IsEnemy || (!target.IsEnemy && SafeCanThrowPotionAtAlly(potion)),
            TargetType.AnyPlayer or TargetType.AnyAlly => !target.IsEnemy,
            _ => true
        };
    }

    private static bool CanPurchaseMerchantEntry(MerchantEntry? entry)
    {
        return entry is not null &&
               entry.IsStocked &&
               entry.EnoughGold;
    }

    private static void ExecuteShopPurchase(NMerchantSlot slot, NMerchantInventory inventory)
    {
        var merchantInventory = inventory.Inventory;
        var onTryPurchase = FindMethod(slot.GetType(), "OnTryPurchase", 1);
        if (onTryPurchase is not null)
        {
            onTryPurchase.Invoke(slot, new object?[] { merchantInventory });
            return;
        }

        if (slot.Entry is not null)
        {
            var entryMethod = FindMethod(slot.Entry.GetType(), "OnTryPurchase", 2) ??
                              FindMethod(slot.Entry.GetType(), "OnTryPurchaseWrapper", 2);
            if (entryMethod is not null)
            {
                entryMethod.Invoke(slot.Entry, new object?[] { merchantInventory, false });
                return;
            }
        }

        if (TryInvokeParameterless(slot, "OnReleased"))
        {
            return;
        }

        throw new BridgeRequestException(
            HttpStatusCode.Conflict,
            "shop_purchase_failed",
            $"Could not purchase shop item '{DescribeMerchantEntry(slot.Entry)}'.");
    }

    private static string DescribeCreatureTarget(Creature creature)
    {
        return $"{creature.Name}#{creature.CombatId}";
    }

    private static object BuildRunPayload(RunState? runState)
    {
        if (runState is null)
        {
            return new
            {
                has_run = false
            };
        }

        return new
        {
            has_run = true,
            is_game_over = runState.IsGameOver,
            current_location = TextOf(runState.CurrentLocation),
            current_act_index = runState.CurrentActIndex,
            ascension_level = runState.AscensionLevel,
            act_floor = runState.ActFloor,
            total_floor = runState.TotalFloor,
            act = BuildModelPayload(runState.Act),
            acts = runState.Acts.Select(BuildModelPayload).ToArray(),
            modifiers = runState.Modifiers.Select(BuildModelPayload).ToArray(),
            current_map_coord = BuildMapCoord(runState.CurrentMapCoord),
            current_map_point = runState.CurrentMapPoint is null
                ? null
                : new
                {
                    coord = BuildMapCoord(runState.CurrentMapPoint.coord),
                    point_type = runState.CurrentMapPoint.PointType.ToString()
                },
            current_room = BuildRoomPayload(runState.CurrentRoom),
            player_count = runState.Players.Count
        };
    }

    private static object BuildCombatPayload(CombatManager? combatManager, CombatState? combatState)
    {
        if (combatManager is null || combatState is null || !combatManager.IsInProgress)
        {
            return new
            {
                in_progress = false
            };
        }

        return new
        {
            in_progress = combatManager.IsInProgress,
            is_play_phase = combatManager.IsPlayPhase,
            is_paused = combatManager.IsPaused,
            is_ending = combatManager.IsEnding,
            player_actions_disabled = combatManager.PlayerActionsDisabled,
            round_number = combatState.RoundNumber,
            current_side = combatState.CurrentSide.ToString(),
            player_creatures = combatState.PlayerCreatures.Select(BuildCreaturePayload).ToArray(),
            enemy_creatures = combatState.Creatures
                .Where(static creature => creature.IsEnemy)
                .Select(BuildCreaturePayload)
                .ToArray()
        };
    }

    private static object[] BuildPlayersPayload(
        RunState? runState,
        CombatManager? combatManager,
        CombatState? combatState)
    {
        var players = runState?.Players ?? combatState?.Players ?? Array.Empty<Player>();
        var includeCombatState = combatManager?.IsInProgress == true && combatState is not null;

        return players
            .Select((player, index) => new
            {
                index,
                net_id = player.NetId,
                character = BuildModelPayload(player.Character),
                gold = player.Gold,
                max_energy = player.MaxEnergy,
                creature = BuildCreaturePayload(player.Creature),
                combat = includeCombatState
                    ? BuildPlayerCombatPayload(player.PlayerCombatState)
                    : CreateNotInCombatPayload(),
                deck = BuildPilePayload(player.Deck),
                relics = player.Relics.Select(BuildRelicPayload).ToArray(),
                potions = player.PotionSlots.Select(BuildPotionPayload).ToArray()
            })
            .Cast<object>()
            .ToArray();
    }

    private static object BuildPlayerCombatPayload(PlayerCombatState? playerCombatState)
    {
        if (playerCombatState is null)
        {
            return CreateNotInCombatPayload();
        }

        return new
        {
            in_combat = true,
            energy = playerCombatState.Energy,
            max_energy = playerCombatState.MaxEnergy,
            stars = playerCombatState.Stars,
            hand = BuildPilePayload(playerCombatState.Hand),
            draw_pile = BuildPilePayload(playerCombatState.DrawPile),
            discard_pile = BuildPilePayload(playerCombatState.DiscardPile),
            exhaust_pile = BuildPilePayload(playerCombatState.ExhaustPile),
            play_pile = BuildPilePayload(playerCombatState.PlayPile)
        };
    }

    private static object CreateNotInCombatPayload()
    {
        return new
        {
            in_combat = false
        };
    }

    private static object BuildPilePayload(CardPile? pile)
    {
        if (pile is null)
        {
            return new
            {
                pile_type = "Unknown",
                count = 0,
                cards = Array.Empty<object>()
            };
        }

        return new
        {
            pile_type = pile.Type.ToString(),
            is_combat_pile = pile.IsCombatPile,
            count = pile.Cards.Count,
            cards = pile.Cards.Select(BuildCardPayload).ToArray()
        };
    }

    private static object BuildCardPayload(CardModel? card)
    {
        if (card is null)
        {
            return new
            {
                missing = true
            };
        }

        return new
        {
            id = card.Id.ToString(),
            title = card.Title,
            description = TextOf(card.Description),
            type = card.Type.ToString(),
            rarity = card.Rarity.ToString(),
            target_type = card.TargetType.ToString(),
            pile = card.Pile?.Type.ToString(),
            is_playable = GetHiddenPropertyValue<bool>(card, "IsPlayable") ?? false,
            canonical_energy_cost = card.EnergyCost.Canonical,
            resolved_energy_cost = card.EnergyCost.GetResolved(),
            costs_x = card.EnergyCost.CostsX,
            canonical_star_cost = card.CanonicalStarCost,
            current_star_cost = card.CurrentStarCost,
            has_star_cost_x = card.HasStarCostX
        };
    }

    private static object BuildCreaturePayload(Creature? creature)
    {
        if (creature is null)
        {
            return new
            {
                missing = true
            };
        }

        return new
        {
            name = creature.Name,
            model_id = creature.ModelId.ToString(),
            combat_id = creature.CombatId,
            side = creature.Side.ToString(),
            current_hp = creature.CurrentHp,
            max_hp = creature.MaxHp,
            block = creature.Block,
            is_alive = creature.IsAlive,
            is_hittable = SafeGetCreatureIsHittable(creature),
            powers = creature.Powers.Select(BuildPowerPayload).ToArray(),
            intent = creature.IsEnemy ? BuildEnemyIntentPayload(creature) : null
        };
    }

    private static object? BuildEnemyIntentPayload(Creature creature)
    {
        var monster = creature.Monster;
        if (monster is null)
        {
            return null;
        }

        var targets = ResolveMonsterIntentTargets(creature);
        var nextMove = monster.NextMove;
        var intents = SafeGetMonsterIntents(monster, nextMove);

        return new
        {
            state_id = nextMove?.StateId,
            follow_up_state_id = nextMove?.FollowUpStateId,
            is_move = nextMove?.IsMove ?? false,
            title = intents.Select(GetMonsterIntentTitle)
                .FirstOrDefault(title => !string.IsNullOrWhiteSpace(title)),
            intents = intents.Select(intent => BuildMonsterIntentPayload(intent, creature, targets)).ToArray()
        };
    }

    private static IReadOnlyList<Creature> ResolveMonsterIntentTargets(Creature owner)
    {
        var combatState = owner.CombatState;
        if (combatState is null)
        {
            return Array.Empty<Creature>();
        }

        return combatState.PlayerCreatures
            .Where(static creature => creature.IsAlive)
            .ToArray();
    }

    private static IReadOnlyList<AbstractIntent> SafeGetMonsterIntents(MonsterModel monster, MoveState? nextMove)
    {
        try
        {
            var method = FindMethod(monster.GetType(), "GetIntents", 0);
            if (method?.Invoke(monster, Array.Empty<object>()) is IEnumerable<AbstractIntent> intents)
            {
                var intentList = intents.ToArray();
                if (intentList.Length > 0)
                {
                    return intentList;
                }
            }
        }
        catch
        {
        }

        return nextMove?.Intents?.ToArray() ?? Array.Empty<AbstractIntent>();
    }

    private static object BuildMonsterIntentPayload(
        AbstractIntent intent,
        Creature owner,
        IReadOnlyList<Creature> targets)
    {
        var repeats = intent switch
        {
            SingleAttackIntent singleAttackIntent => singleAttackIntent.Repeats,
            MultiAttackIntent multiAttackIntent => multiAttackIntent.Repeats,
            _ => 1
        };

        var totalDamage = intent switch
        {
            SingleAttackIntent singleAttackIntent => SafeGetIntentTotalDamage(singleAttackIntent, targets, owner),
            MultiAttackIntent multiAttackIntent => SafeGetIntentTotalDamage(multiAttackIntent, targets, owner),
            _ => null
        };
        int? damagePerHit = totalDamage.HasValue && repeats > 0 && totalDamage.Value % repeats == 0
            ? totalDamage.Value / repeats
            : null;

        return new
        {
            intent_type = intent.IntentType.ToString(),
            intent_class = intent.GetType().Name,
            title = GetMonsterIntentTitle(intent),
            label = SafeGetIntentLocString(intent, "GetIntentLabel", targets, owner),
            description = SafeGetIntentLocString(intent, "GetIntentDescription", targets, owner),
            has_tip = intent.HasIntentTip,
            repeats,
            total_damage = totalDamage,
            damage_per_hit = damagePerHit
        };
    }

    private static string GetMonsterIntentTitle(AbstractIntent intent)
    {
        return TextOf(GetHiddenPropertyObjectValue(intent, "IntentTitle"));
    }

    private static int? SafeGetIntentTotalDamage(object intent, IEnumerable<Creature> targets, Creature owner)
    {
        try
        {
            var method = FindMethod(intent.GetType(), "GetTotalDamage", 2);
            if (method?.Invoke(intent, new object?[] { targets, owner }) is int totalDamage)
            {
                return totalDamage;
            }
        }
        catch
        {
        }

        return null;
    }

    private static string SafeGetIntentLocString(
        object intent,
        string methodName,
        IEnumerable<Creature> targets,
        Creature owner)
    {
        try
        {
            var method = FindMethod(intent.GetType(), methodName, 2);
            return TextOf(method?.Invoke(intent, new object?[] { targets, owner }));
        }
        catch
        {
            return string.Empty;
        }
    }

    private static object BuildPowerPayload(PowerModel power)
    {
        return new
        {
            title = TextOf(power.Title),
            description = TextOf(power.Description),
            amount = power.Amount,
            display_amount = power.DisplayAmount,
            type = power.Type.ToString(),
            stack_type = power.StackType.ToString()
        };
    }

    private static object BuildRewardsPayload(
        NRewardsScreen? rewardsScreen,
        NProceedButton? rewardProceedButton,
        NMapScreen? mapScreen,
        IReadOnlyList<NRewardButton> rewardButtons)
    {
        var visible = IsRewardsScreenVisible(rewardsScreen, rewardProceedButton, mapScreen, rewardButtons);
        return new
        {
            visible,
            terminal_proceed_visible = visible &&
                                       rewardProceedButton is not null &&
                                       IsNodeVisible(rewardProceedButton),
            rewards = rewardButtons.Select((button, index) => new
            {
                index,
                reward = BuildRewardPayload(button.Reward)
            }).ToArray()
        };
    }

    private static object BuildRewardPayload(Reward? reward)
    {
        if (reward is null)
        {
            return new
            {
                reward_type = "unknown",
                missing = true
            };
        }

        return reward switch
        {
            CardReward cardReward => new
            {
                reward_type = "card",
                description = TextOf(cardReward.Description),
                can_skip = cardReward.CanSkip,
                can_reroll = cardReward.CanReroll,
                cards = cardReward.Cards.Select(BuildCardPayload).ToArray()
            },
            GoldReward goldReward => new
            {
                reward_type = "gold",
                description = TextOf(goldReward.Description),
                amount = goldReward.Amount
            },
            RelicReward relicReward => new
            {
                reward_type = "relic",
                description = TextOf(relicReward.Description),
                rarity = relicReward.Rarity.ToString(),
                relic = BuildRelicPayload(relicReward.ClaimedRelic)
            },
            PotionReward potionReward => new
            {
                reward_type = "potion",
                description = TextOf(potionReward.Description),
                potion = BuildPotionPayload(potionReward.Potion)
            },
            _ => new
            {
                reward_type = reward.GetType().Name,
                description = TextOf(reward.Description)
            }
        };
    }

    private static string DescribeReward(Reward? reward)
    {
        if (reward is null)
        {
            return "Unknown reward";
        }

        return reward switch
        {
            CardReward cardReward => $"Card reward ({cardReward.Cards.Count()} options)",
            GoldReward goldReward => $"{goldReward.Amount} gold",
            RelicReward relicReward => $"Relic {TextOf(relicReward.ClaimedRelic?.Title)}",
            PotionReward potionReward => $"Potion {TextOf(potionReward.Potion?.Title)}",
            _ => TextOf(reward.Description)
        };
    }

    private static object BuildCardRewardSelectionPayload(
        NCardRewardSelectionScreen? cardRewardScreen,
        IReadOnlyList<NCardHolder> cardRewardOptions)
    {
        return new
        {
            visible = cardRewardScreen is not null && IsNodeVisible(cardRewardScreen),
            options = cardRewardOptions.Select((holder, index) => new
            {
                index,
                card = BuildCardPayload(holder.CardModel)
            }).ToArray()
        };
    }

    private static object BuildCardSelectionPayload(
        Node? cardSelectionScreen,
        IReadOnlyList<NCardHolder> cardSelectionOptions,
        Node? cardSelectionConfirmButton,
        Node? cardSelectionCancelButton,
        Node? cardSelectionCloseButton,
        Node? cardSelectionSkipButton)
    {
        var visible = cardSelectionScreen is not null && IsNodeVisible(cardSelectionScreen);
        var texts = visible ? CollectVisibleText(cardSelectionScreen, 8).ToArray() : Array.Empty<string>();
        var prefs = GetHiddenFieldValue(cardSelectionScreen, "_prefs");

        return new
        {
            visible,
            screen_type = visible ? cardSelectionScreen!.GetType().Name : null,
            prompt = visible ? TryGetCardSelectionPrompt(cardSelectionScreen) : null,
            texts,
            selected_count = CountSelectedCardSelectionCards(cardSelectionScreen),
            min_select = GetHiddenPropertyValue<int>(prefs, "MinSelect"),
            max_select = GetHiddenPropertyValue<int>(prefs, "MaxSelect"),
            requires_manual_confirmation = GetHiddenPropertyValue<bool>(prefs, "RequireManualConfirmation"),
            cancelable = GetHiddenPropertyValue<bool>(prefs, "Cancelable"),
            confirm_visible = cardSelectionConfirmButton is not null &&
                              IsNodeVisible(cardSelectionConfirmButton) &&
                              IsButtonEnabled(cardSelectionConfirmButton),
            cancel_visible = cardSelectionCancelButton is not null &&
                             IsNodeVisible(cardSelectionCancelButton) &&
                             IsButtonEnabled(cardSelectionCancelButton),
            close_visible = cardSelectionCloseButton is not null &&
                            IsNodeVisible(cardSelectionCloseButton) &&
                            IsButtonEnabled(cardSelectionCloseButton),
            skip_visible = cardSelectionSkipButton is not null &&
                           IsNodeVisible(cardSelectionSkipButton) &&
                           IsButtonEnabled(cardSelectionSkipButton),
            options = cardSelectionOptions.Select((holder, index) => new
            {
                index,
                card = BuildCardPayload(holder.CardModel),
                is_selected = IsCardSelectionCardSelected(cardSelectionScreen, holder.CardModel)
            }).ToArray()
        };
    }

    private static object BuildCharacterSelectionPayload(
        NCharacterSelectScreen? characterSelectScreen,
        IReadOnlyList<NCharacterSelectButton> characterButtons,
        NCharacterSelectButton? selectedCharacterButton,
        NConfirmButton? embarkButton)
    {
        var visible = characterSelectScreen is not null && IsNodeVisible(characterSelectScreen);
        var selectedIndex = -1;

        for (var index = 0; index < characterButtons.Count; index++)
        {
            if (ReferenceEquals(characterButtons[index], selectedCharacterButton))
            {
                selectedIndex = index;
                break;
            }
        }

        return new
        {
            visible,
            can_embark = visible && embarkButton is not null && IsNodeVisible(embarkButton) && IsButtonEnabled(embarkButton),
            selected_index = selectedIndex >= 0 ? (int?)selectedIndex : null,
            selected_character = BuildCharacterPayload(selectedCharacterButton?.Character),
            options = characterButtons.Select((button, index) => new
            {
                index,
                character = BuildCharacterPayload(button.Character),
                is_selected = ReferenceEquals(button, selectedCharacterButton),
                is_locked = button.IsLocked,
                is_random = button.IsRandom,
                remote_selected_player_count = button.RemoteSelectedPlayers.Count
            }).ToArray()
        };
    }

    private static object BuildRunModeSelectionPayload(
        Node? runModeSubmenu,
        Node? runModeStandardButton,
        Node? runModeDailyButton,
        Node? runModeCustomButton,
        NBackButton? runModeBackButton)
    {
        return new
        {
            visible = runModeSubmenu is not null && IsNodeVisible(runModeSubmenu),
            options = new[]
            {
                BuildRunModeButtonPayload(runModeStandardButton, "standard", "Standard"),
                BuildRunModeButtonPayload(runModeDailyButton, "daily", "Daily"),
                BuildRunModeButtonPayload(runModeCustomButton, "custom", "Custom")
            },
            back_button = BuildRunModeButtonPayload(runModeBackButton, "back", "Back")
        };
    }

    private static object BuildRunModeButtonPayload(Node? button, string semanticAction, string fallbackLabel)
    {
        if (button is null || !IsNodeVisible(button))
        {
            return new
            {
                visible = false,
                semantic_action = semanticAction,
                label = fallbackLabel,
                texts = Array.Empty<string>()
            };
        }

        var texts = CollectVisibleText(button, 4).ToArray();
        var text = texts.FirstOrDefault(static candidate => !string.IsNullOrWhiteSpace(candidate)) ?? fallbackLabel;

        return new
        {
            visible = true,
            semantic_action = semanticAction,
            label = fallbackLabel,
            text,
            texts,
            node_type = button.GetType().FullName
        };
    }

    private static object BuildEventOptionsPayload(
        IReadOnlyList<NEventOptionButton> eventOptionButtons,
        NMapScreen? mapScreen)
    {
        if (mapScreen is not null && mapScreen.IsOpen)
        {
            return new
            {
                visible = false,
                options = Array.Empty<object>()
            };
        }

        return new
        {
            visible = eventOptionButtons.Count > 0,
            options = eventOptionButtons.Select((button, index) => BuildEventOptionPayload(button, index)).ToArray()
        };
    }

    private static object BuildDeckUpgradeSelectionPayload(
        NDeckUpgradeSelectScreen? deckUpgradeScreen,
        IReadOnlyList<NCardHolder> deckUpgradeOptions,
        NConfirmButton? deckUpgradeConfirmButton,
        NBackButton? deckUpgradeCancelButton,
        NBackButton? deckUpgradeCloseButton)
    {
        return new
        {
            visible = deckUpgradeScreen is not null && IsNodeVisible(deckUpgradeScreen),
            use_single_selection = GetHiddenPropertyValue<bool>(deckUpgradeScreen, "UseSingleSelection") ?? false,
            selected_count = CountSelectedDeckUpgradeCards(deckUpgradeScreen),
            confirm_visible = deckUpgradeConfirmButton is not null &&
                              IsNodeVisible(deckUpgradeConfirmButton) &&
                              IsButtonEnabled(deckUpgradeConfirmButton),
            cancel_visible = deckUpgradeCancelButton is not null &&
                             IsNodeVisible(deckUpgradeCancelButton) &&
                             IsButtonEnabled(deckUpgradeCancelButton),
            close_visible = deckUpgradeCloseButton is not null &&
                            IsNodeVisible(deckUpgradeCloseButton) &&
                            IsButtonEnabled(deckUpgradeCloseButton),
            options = deckUpgradeOptions.Select((holder, index) => new
            {
                index,
                card = BuildCardPayload(holder.CardModel),
                is_selected = IsDeckUpgradeCardSelected(deckUpgradeScreen, holder.CardModel)
            }).ToArray()
        };
    }

    private static object BuildMainMenuPayload(
        Node? mainMenuRoot,
        Node? mainMenuContinueButton,
        IReadOnlyList<Node> mainMenuTextButtons,
        Node? continueRunInfo,
        Node? abandonRunConfirmPopup,
        IReadOnlyList<NPopupYesNoButton> abandonRunConfirmButtons)
    {
        return new
        {
            visible = mainMenuRoot is not null && IsNodeVisible(mainMenuRoot),
            continue_button = BuildMainMenuButtonPayload(mainMenuContinueButton, null, "continue"),
            continue_run_info = new
            {
                visible = continueRunInfo is not null && IsNodeVisible(continueRunInfo),
                texts = CollectVisibleText(continueRunInfo, 8).ToArray()
            },
            buttons = mainMenuTextButtons
                .Select((button, index) => BuildMainMenuButtonPayload(button, index, TryGetMainMenuSemanticAction(TryGetNodeText(button))))
                .ToArray(),
            abandon_confirm = new
            {
                visible = abandonRunConfirmPopup is not null && IsNodeVisible(abandonRunConfirmPopup),
                buttons = abandonRunConfirmButtons
                    .Select((button, index) => BuildMainMenuButtonPayload(
                        button,
                        index,
                        TryGetAbandonConfirmSemanticAction(TryGetNodeText(button))))
                    .ToArray()
            }
        };
    }

    private static object BuildMainMenuButtonPayload(Node? button, int? index, string? semanticAction)
    {
        if (button is null || !IsNodeVisible(button))
        {
            return new
            {
                visible = false,
                index,
                semantic_action = semanticAction
            };
        }

        var text = TryGetNodeText(button);

        return new
        {
            visible = true,
            index,
            semantic_action = semanticAction,
            text,
            node_type = button.GetType().FullName
        };
    }

    private static object BuildEventOptionPayload(NEventOptionButton button, int index)
    {
        var option = button.Option;

        return new
        {
            index,
            title = TextOf(option?.Title),
            description = TextOf(option?.Description),
            is_locked = option?.IsLocked ?? true,
            is_proceed = option?.IsProceed ?? false
        };
    }

    private static object BuildMapPayload(
        RunState? runState,
        NMapScreen? mapScreen,
        IReadOnlyList<NMapPoint> mapPoints)
    {
        var map = runState?.Map;

        return new
        {
            is_open = mapScreen?.IsOpen ?? false,
            is_travel_enabled = mapScreen?.IsTravelEnabled ?? false,
            is_traveling = mapScreen?.IsTraveling ?? false,
            current_coord = BuildMapCoord(runState?.CurrentMapCoord),
            dimensions = map is null
                ? null
                : new
                {
                    rows = map.GetRowCount(),
                    columns = map.GetColumnCount()
                },
            points = mapPoints.Select(BuildMapPointPayload).ToArray()
        };
    }

    private static object BuildRestSitePayload(
        NMapScreen? mapScreen,
        NRestSiteRoom? restSiteRoom,
        IReadOnlyList<NRestSiteButton> restSiteButtons,
        NProceedButton? restSiteProceedButton)
    {
        var visible = mapScreen?.IsOpen != true &&
                      restSiteRoom is not null &&
                      IsNodeVisible(restSiteRoom);
        var options = visible
            ? restSiteButtons
                .Where(IsNodeVisible)
                .Select((button, index) => BuildRestSiteOptionPayload(button.Option, index))
                .ToArray()
            : new object[0];

        return new
        {
            visible,
            header = visible
                ? TryGetNodeText(GetHiddenFieldValue(restSiteRoom, "<Header>k__BackingField") as Node)
                : null,
            description = visible
                ? TryGetNodeText(GetHiddenFieldValue(restSiteRoom, "<Description>k__BackingField") as Node)
                : null,
            proceed_visible = visible &&
                              !HasVisibleRestSiteOptions(restSiteButtons) &&
                              restSiteProceedButton is not null &&
                              IsNodeVisible(restSiteProceedButton),
            options
        };
    }

    private static object BuildShopPayload(
        NMerchantRoom? merchantRoom,
        NMerchantInventory? merchantInventory,
        IReadOnlyList<NMerchantSlot> merchantSlots,
        NMerchantButton? merchantButton,
        NProceedButton? merchantProceedButton,
        NBackButton? merchantBackButton)
    {
        var visible = (merchantRoom is not null && IsNodeVisible(merchantRoom)) ||
                      (merchantInventory is not null && IsNodeVisible(merchantInventory));
        var inventory = merchantInventory?.Inventory;

        return new
        {
            visible,
            is_open = merchantInventory?.IsOpen ?? false,
            gold = inventory?.Player?.Gold,
            merchant_button_visible = merchantButton is not null && IsNodeVisible(merchantButton),
            back_button_visible = merchantBackButton is not null && IsNodeVisible(merchantBackButton),
            proceed_visible = merchantProceedButton is not null && IsNodeVisible(merchantProceedButton),
            items = merchantSlots.Select((slot, index) => BuildShopSlotPayload(slot, index)).ToArray()
        };
    }

    private static object BuildShopSlotPayload(NMerchantSlot slot, int index)
    {
        var entry = slot.Entry;
        var cardEntry = entry as MerchantCardEntry;
        var relicEntry = entry as MerchantRelicEntry;
        var potionEntry = entry as MerchantPotionEntry;
        var cardRemovalEntry = entry as MerchantCardRemovalEntry;

        return new
        {
            index,
            slot_type = slot.GetType().Name,
            item_kind = ResolveMerchantEntryKind(entry),
            title = DescribeMerchantEntry(entry),
            description = DescribeMerchantEntryDescription(entry),
            cost = entry?.Cost,
            enough_gold = entry?.EnoughGold ?? false,
            is_stocked = entry?.IsStocked ?? false,
            is_affordable = CanPurchaseMerchantEntry(entry),
            is_on_sale = cardEntry?.IsOnSale,
            used = cardRemovalEntry?.Used,
            card = cardEntry is null ? null : BuildCardPayload(cardEntry.CreationResult?.Card),
            relic = relicEntry is null ? null : BuildRelicPayload(relicEntry.Model),
            potion = potionEntry is null ? null : BuildPotionPayload(potionEntry.Model)
        };
    }

    private static string ResolveMerchantEntryKind(MerchantEntry? entry)
    {
        return entry switch
        {
            MerchantCardEntry => "card",
            MerchantRelicEntry => "relic",
            MerchantPotionEntry => "potion",
            MerchantCardRemovalEntry => "card_removal",
            null => "missing",
            _ => entry.GetType().Name
        };
    }

    private static string DescribeMerchantEntry(MerchantEntry? entry)
    {
        return entry switch
        {
            MerchantCardEntry cardEntry => TextOf(cardEntry.CreationResult?.Card?.Title),
            MerchantRelicEntry relicEntry => TextOf(relicEntry.Model?.Title),
            MerchantPotionEntry potionEntry => TextOf(potionEntry.Model?.Title),
            MerchantCardRemovalEntry => "Remove a card",
            null => "<missing>",
            _ => entry.GetType().Name
        };
    }

    private static string DescribeMerchantEntryDescription(MerchantEntry? entry)
    {
        return entry switch
        {
            MerchantCardEntry cardEntry => TextOf(cardEntry.CreationResult?.Card?.Description),
            MerchantRelicEntry relicEntry => TextOf(relicEntry.Model?.Description),
            MerchantPotionEntry potionEntry => TextOf(potionEntry.Model?.Description),
            MerchantCardRemovalEntry cardRemovalEntry => cardRemovalEntry.Used
                ? "Card removal already used"
                : "Remove a card from your deck",
            null => string.Empty,
            _ => string.Empty
        };
    }

    private static object BuildRestSiteOptionPayload(RestSiteOption? option, int index)
    {
        if (option is null)
        {
            return new
            {
                index,
                missing = true
            };
        }

        return new
        {
            index,
            option_id = option.OptionId,
            option_type = option.GetType().Name,
            title = TextOf(option.Title),
            description = TextOf(option.Description),
            is_enabled = option.IsEnabled
        };
    }

    private static object BuildAutomationPayload()
    {
        return new
        {
            autoslay = BridgeAutoSlay.GetStatusPayload()
        };
    }

    private static object BuildMapPointPayload(NMapPoint pointNode)
    {
        var point = pointNode.Point;
        var coord = point.coord;

        return new
        {
            coord = BuildMapCoord(coord),
            point_type = point.PointType.ToString(),
            state = pointNode.State.ToString(),
            is_enabled = pointNode.IsEnabled,
            is_travelable = IsMapPointTravelable(pointNode),
            children = point.Children.Select(static child => BuildMapCoord(child.coord)).ToArray()
        };
    }

    private static object BuildRoomPayload(AbstractRoom? room)
    {
        if (room is null)
        {
            return new
            {
                missing = true
            };
        }

        return new
        {
            room_type = room.RoomType.ToString(),
            model_id = room.ModelId?.ToString() ?? string.Empty,
            is_pre_finished = room.IsPreFinished,
            is_victory_room = room.IsVictoryRoom
        };
    }

    private static object BuildModelPayload(AbstractModel? model)
    {
        if (model is null)
        {
            return new
            {
                missing = true
            };
        }

        return new
        {
            id = model.Id.ToString(),
            title = TryGetTitle(model),
            description = TryGetDescription(model),
            kind = model.GetType().Name
        };
    }

    private static object BuildCharacterPayload(CharacterModel? character)
    {
        if (character is null)
        {
            return new
            {
                missing = true
            };
        }

        return new
        {
            id = character.Id.ToString(),
            title = TextOf(character.CharacterSelectTitle),
            description = TextOf(character.CharacterSelectDesc),
            starting_hp = character.StartingHp,
            starting_gold = character.StartingGold
        };
    }

    private static object BuildRelicPayload(RelicModel? relic)
    {
        if (relic is null)
        {
            return new
            {
                missing = true
            };
        }

        return new
        {
            id = relic.Id.ToString(),
            title = TextOf(relic.Title),
            description = TextOf(relic.Description),
            rarity = relic.Rarity.ToString()
        };
    }

    private static object BuildPotionPayload(PotionModel? potion)
    {
        if (potion is null)
        {
            return new
            {
                empty = true
            };
        }

        return new
        {
            id = potion.Id.ToString(),
            title = TextOf(potion.Title),
            description = TextOf(potion.Description),
            rarity = potion.Rarity.ToString(),
            target_type = potion.TargetType.ToString(),
            selection_screen_prompt = TextOf(potion.SelectionScreenPrompt),
            can_throw_at_ally = SafeCanThrowPotionAtAlly(potion),
            is_usable = SafeGetPotionIsUsable(potion),
            is_queued = SafeGetPotionIsQueued(potion)
        };
    }

    private static object? BuildMapCoord(MapCoord? coord)
    {
        return coord.HasValue ? BuildMapCoord(coord.Value) : null;
    }

    private static object BuildMapCoord(MapCoord coord)
    {
        return new
        {
            col = coord.col,
            row = coord.row
        };
    }

    private static string ResolveCurrentScreen(
        ScreenStateTracker? screenStateTracker,
        CombatManager? combatManager,
        NMapScreen? mapScreen,
        NRestSiteRoom? restSiteRoom,
        NMerchantRoom? merchantRoom,
        NMerchantInventory? merchantInventory,
        NRewardsScreen? rewardsScreen,
        NProceedButton? rewardProceedButton,
        IReadOnlyList<NRewardButton> rewardButtons,
        NCardRewardSelectionScreen? cardRewardScreen,
        IReadOnlyList<NCardHolder> cardRewardOptions,
        Node? cardSelectionScreen,
        NCharacterSelectScreen? characterSelectScreen,
        NDeckUpgradeSelectScreen? deckUpgradeScreen,
        IReadOnlyList<NEventOptionButton> eventOptionButtons,
        Node? mainMenuRoot,
        Node? runModeSubmenu,
        Node? abandonRunConfirmPopup)
    {
        var isRestSiteVisible = restSiteRoom is not null && IsNodeVisible(restSiteRoom);
        var isMerchantVisible = (merchantRoom is not null && IsNodeVisible(merchantRoom)) ||
                                merchantInventory?.IsOpen == true;
        var isMapOpen = mapScreen is not null && mapScreen.IsOpen;
        var isRewardsVisible = IsRewardsScreenVisible(
            rewardsScreen,
            rewardProceedButton,
            mapScreen,
            rewardButtons);
        var isCardRewardVisible = IsCardRewardSelectionVisible(cardRewardScreen, cardRewardOptions);
        var isCardSelectionVisible = cardSelectionScreen is not null && IsNodeVisible(cardSelectionScreen);
        var isDeckUpgradeVisible = deckUpgradeScreen is not null && IsNodeVisible(deckUpgradeScreen);
        var isRunModeVisible = runModeSubmenu is not null && IsNodeVisible(runModeSubmenu);
        var isCharacterSelectVisible = characterSelectScreen is not null && IsNodeVisible(characterSelectScreen);
        var currentScreen = InvokeParameterless(screenStateTracker, "GetCurrentScreen");
        if (currentScreen is not null)
        {
            var currentScreenText = currentScreen.ToString() ?? "UNKNOWN";
            if (abandonRunConfirmPopup is not null && IsNodeVisible(abandonRunConfirmPopup))
            {
                return "ABANDON_RUN_CONFIRM";
            }

            if (isDeckUpgradeVisible)
            {
                return "DECK_UPGRADE_SELECTION";
            }

            if (isCardSelectionVisible)
            {
                return "CARD_SELECTION";
            }

            if (isCardRewardVisible)
            {
                return "CARD_REWARD_SELECTION";
            }

            if (isRewardsVisible)
            {
                return "REWARDS";
            }

            if (isMapOpen)
            {
                return "MAP";
            }

            if (isCharacterSelectVisible)
            {
                return "CHARACTER_SELECT";
            }

            if (combatManager?.IsInProgress == true &&
                currentScreenText.Equals("Room", StringComparison.OrdinalIgnoreCase))
            {
                return "COMBAT";
            }

            if (currentScreenText.Equals("Room", StringComparison.OrdinalIgnoreCase))
            {
                if (isRestSiteVisible)
                {
                    return "REST_SITE";
                }

                if (isMerchantVisible)
                {
                    return "SHOP";
                }
            }

            if (isRunModeVisible)
            {
                return "RUN_MODE_SELECTION";
            }

            if (isMerchantVisible &&
                (currentScreenText.Contains("merchant", StringComparison.OrdinalIgnoreCase) ||
                 currentScreenText.Contains("shop", StringComparison.OrdinalIgnoreCase)))
            {
                return "SHOP";
            }

            return currentScreenText;
        }

        if (abandonRunConfirmPopup is not null && IsNodeVisible(abandonRunConfirmPopup))
        {
            return "ABANDON_RUN_CONFIRM";
        }

        if (isRunModeVisible)
        {
            return "RUN_MODE_SELECTION";
        }

        if (isCharacterSelectVisible)
        {
            return "CHARACTER_SELECT";
        }

        if (isDeckUpgradeVisible)
        {
            return "DECK_UPGRADE_SELECTION";
        }

        if (isCardSelectionVisible)
        {
            return "CARD_SELECTION";
        }

        if (mainMenuRoot is not null && IsNodeVisible(mainMenuRoot))
        {
            return "MAIN_MENU";
        }

        if (isMapOpen)
        {
            return "MAP";
        }

        if (restSiteRoom is not null && IsNodeVisible(restSiteRoom))
        {
            return "REST_SITE";
        }

        if (isMerchantVisible)
        {
            return "SHOP";
        }

        if (isCardRewardVisible)
        {
            return "CARD_REWARD_SELECTION";
        }

        if (isRewardsVisible)
        {
            return "REWARDS";
        }

        if (isMapOpen)
        {
            return "MAP";
        }

        if (eventOptionButtons.Count > 0)
        {
            return "EVENT";
        }

        if (combatManager?.IsInProgress == true)
        {
            return "COMBAT";
        }

        return "UNKNOWN";
    }

    private static RunState? TryGetRunState(RunManager? runManager)
    {
        if (runManager is null)
        {
            return null;
        }

        try
        {
            return runManager.DebugOnlyGetState();
        }
        catch
        {
            return null;
        }
    }

    private static CombatState? TryGetCombatState(CombatManager? combatManager)
    {
        if (combatManager is null)
        {
            return null;
        }

        try
        {
            return combatManager.DebugOnlyGetState();
        }
        catch
        {
            return null;
        }
    }

    private static void EnsureDispatcherReady()
    {
        if (!BridgeCoordinator.IsReady)
        {
            throw new BridgeRequestException(
                HttpStatusCode.ServiceUnavailable,
                "dispatcher_not_ready",
                "The bridge dispatcher is not attached yet. Wait for the game to finish loading and try again.");
        }
    }

    private static bool IsNodeVisible(Node? node)
    {
        if (node is null || !GodotObject.IsInstanceValid(node))
        {
            return false;
        }

        if (BridgeRuntime.VisibleOnly && node is CanvasItem canvasItem)
        {
            return canvasItem.IsVisibleInTree();
        }

        return true;
    }

    private static bool IsTypeFullName(Node? node, string fullTypeName)
    {
        return node is not null &&
               GodotObject.IsInstanceValid(node) &&
               string.Equals(node.GetType().FullName, fullTypeName, StringComparison.Ordinal);
    }

    private static bool IsMapPointTravelable(NMapPoint pointNode)
    {
        return GetHiddenPropertyValue<bool>(pointNode, "IsTravelable") ?? false;
    }

    private static bool HasVisibleRestSiteOptions(IReadOnlyList<NRestSiteButton> restSiteButtons)
    {
        return restSiteButtons.Any(static button => IsNodeVisible(button) && button.Option is not null);
    }

    private static bool IsButtonEnabled(object? target)
    {
        return target is not null && (GetHiddenPropertyValue<bool>(target, "IsEnabled") ?? true);
    }

    private static bool IsRunModeSelectionVisible(BridgeWorldContext context)
    {
        return context.RunModeSubmenu is not null && IsNodeVisible(context.RunModeSubmenu);
    }

    private static bool IsRewardsScreenVisible(
        NRewardsScreen? rewardsScreen,
        NProceedButton? rewardProceedButton,
        NMapScreen? mapScreen,
        IReadOnlyList<NRewardButton> rewardButtons)
    {
        if (mapScreen?.IsOpen == true && rewardButtons.Count == 0)
        {
            return false;
        }

        return (rewardsScreen is not null && IsNodeVisible(rewardsScreen)) ||
               (rewardProceedButton is not null && IsNodeVisible(rewardProceedButton));
    }

    private static bool IsCardRewardSelectionVisible(
        NCardRewardSelectionScreen? cardRewardScreen,
        IReadOnlyList<NCardHolder> cardRewardOptions)
    {
        return (cardRewardScreen is not null && IsNodeVisible(cardRewardScreen)) ||
               cardRewardOptions.Count > 0;
    }

    private static bool IsDeckUpgradeSelectionVisible(BridgeWorldContext context)
    {
        return context.DeckUpgradeScreen is not null && IsNodeVisible(context.DeckUpgradeScreen);
    }

    private static bool IsCardSelectionVisible(BridgeWorldContext context)
    {
        return context.CardSelectionScreen is not null && IsNodeVisible(context.CardSelectionScreen);
    }

    private static bool IsTerminalRewardsProceedVisible(BridgeWorldContext context)
    {
        return IsRewardsScreenVisible(
                   context.RewardsScreen,
                   context.RewardProceedButton,
                   context.MapScreen,
                   context.RewardButtons) &&
               context.RewardProceedButton is not null &&
               IsNodeVisible(context.RewardProceedButton) &&
               context.RewardButtons.Count == 0 &&
               context.MapScreen?.IsOpen != true &&
               !IsCardRewardSelectionVisible(context.CardRewardScreen, context.CardRewardOptions);
    }

    private static bool IsRewardResolutionAction(string actionId)
    {
        return actionId.StartsWith("reward:", StringComparison.Ordinal) ||
               actionId.StartsWith("card_reward:", StringComparison.Ordinal);
    }

    private static bool IsCardSelectionResolutionAction(string actionId)
    {
        return actionId.StartsWith("card_selection:select:", StringComparison.Ordinal);
    }

    private static async Task<(BridgeSnapshot Snapshot, List<object> AutoExecutedActions)> MaybeAutoProceedAfterRewardActionAsync(
        BridgeSnapshot snapshot,
        CancellationToken cancellationToken)
    {
        var autoExecutedActions = new List<object>();
        var autoProceedCount = 0;

        for (var attempt = 0; attempt < 12; attempt++)
        {
            var nonAutomationActions = snapshot.Actions
                .Where(action => !action.ActionId.StartsWith("automation:", StringComparison.Ordinal))
                .ToArray();

            if (nonAutomationActions.Length == 1 &&
                nonAutomationActions[0].ActionId.Equals("proceed", StringComparison.Ordinal))
            {
                if (autoProceedCount >= 3)
                {
                    return (snapshot, autoExecutedActions);
                }

                await BridgeCoordinator.RunOnMainThreadAsync(() =>
                {
                    nonAutomationActions[0].Execute();
                    return true;
                });

                const int autoProceedWaitMs = 2200;
                var stateVersionBeforeAutoProceed = snapshot.StateVersion;
                var stateHashBeforeAutoProceed = snapshot.StateHash;
                await Task.Delay(autoProceedWaitMs, cancellationToken);
                snapshot = await BridgeCoordinator.RunOnMainThreadAsync(CaptureSnapshot);
                autoProceedCount++;
                var stateChanged =
                    snapshot.StateVersion != stateVersionBeforeAutoProceed ||
                    !snapshot.StateHash.Equals(stateHashBeforeAutoProceed, StringComparison.Ordinal);
                autoExecutedActions.Add(new
                {
                    action_id = "proceed",
                    source = "auto_after_reward",
                    wait_after_ms = autoProceedWaitMs,
                    state_changed = stateChanged
                });

                if (!stateChanged)
                {
                    return (snapshot, autoExecutedActions);
                }

                continue;
            }

            if (nonAutomationActions.Length > 0)
            {
                return (snapshot, autoExecutedActions);
            }

            if (attempt >= 11)
            {
                break;
            }

            await Task.Delay(500, cancellationToken);
            snapshot = await BridgeCoordinator.RunOnMainThreadAsync(CaptureSnapshot);
        }

        return (snapshot, autoExecutedActions);
    }

    private static async Task<(BridgeSnapshot Snapshot, List<object> AutoExecutedActions)> MaybeAutoCompleteCardSelectionAsync(
        BridgeSnapshot snapshot,
        CancellationToken cancellationToken)
    {
        var autoExecutedActions = new List<object>();

        if (!ShouldAutoCompleteCardSelection(snapshot))
        {
            return (snapshot, autoExecutedActions);
        }

        if (!snapshot.ActionLookup.TryGetValue("card_selection:confirm", out var confirmAction))
        {
            return (snapshot, autoExecutedActions);
        }

        await BridgeCoordinator.RunOnMainThreadAsync(() =>
        {
            confirmAction.Execute();
            return true;
        });

        const int autoConfirmWaitMs = 1800;
        await Task.Delay(autoConfirmWaitMs, cancellationToken);
        snapshot = await BridgeCoordinator.RunOnMainThreadAsync(CaptureSnapshot);
        autoExecutedActions.Add(new
        {
            action_id = "card_selection:confirm",
            source = "auto_after_card_selection",
            wait_after_ms = autoConfirmWaitMs
        });

        return (snapshot, autoExecutedActions);
    }

    private static bool ShouldAutoCompleteCardSelection(BridgeSnapshot snapshot)
    {
        var cardSelection = JsonSerializer.SerializeToElement(snapshot.Fields.CardSelection);
        if (!cardSelection.TryGetProperty("visible", out var visibleProperty) ||
            !visibleProperty.GetBoolean())
        {
            return false;
        }

        if (!cardSelection.TryGetProperty("confirm_visible", out var confirmVisibleProperty) ||
            !confirmVisibleProperty.GetBoolean())
        {
            return false;
        }

        if (!cardSelection.TryGetProperty("selected_count", out var selectedCountProperty) ||
            selectedCountProperty.GetInt32() <= 0)
        {
            return false;
        }

        var minSelect =
            cardSelection.TryGetProperty("min_select", out var minSelectProperty) &&
            minSelectProperty.ValueKind is not JsonValueKind.Null and not JsonValueKind.Undefined
                ? minSelectProperty.GetInt32()
                : 0;
        var maxSelect =
            cardSelection.TryGetProperty("max_select", out var maxSelectProperty) &&
            maxSelectProperty.ValueKind is not JsonValueKind.Null and not JsonValueKind.Undefined
                ? maxSelectProperty.GetInt32()
                : 0;

        return minSelect == 1 &&
               maxSelect == 1 &&
               snapshot.ActionLookup.ContainsKey("card_selection:confirm");
    }

    private static bool SafeGetCreatureIsHittable(Creature creature)
    {
        try
        {
            return creature.IsHittable;
        }
        catch
        {
            return false;
        }
    }

    private static bool SafeCanThrowPotionAtAlly(PotionModel potion)
    {
        try
        {
            return potion.CanThrowAtAlly();
        }
        catch
        {
            return false;
        }
    }

    private static bool SafeGetPotionIsUsable(PotionModel potion)
    {
        try
        {
            return potion.Owner is not null &&
                   !potion.HasBeenRemovedFromState &&
                   !potion.IsQueued &&
                   potion.PassesCustomUsabilityCheck;
        }
        catch
        {
            return false;
        }
    }

    private static bool SafeGetPotionIsQueued(PotionModel potion)
    {
        try
        {
            return potion.IsQueued;
        }
        catch
        {
            return false;
        }
    }

    private static List<T> FindVisibleDescendants<T>(Node? root) where T : Node
    {
        var result = new List<T>();
        if (root is null)
        {
            return result;
        }

        var seen = new HashSet<IntPtr>();

        void Visit(Node node)
        {
            if (!GodotObject.IsInstanceValid(node))
            {
                return;
            }

            if (node is T typed && seen.Add(typed.NativeInstance) && IsNodeVisible(typed))
            {
                result.Add(typed);
            }

            foreach (Node child in node.GetChildren())
            {
                Visit(child);
            }
        }

        Visit(root);
        return result;
    }

    private static List<Node> FindVisibleDescendants(Node? root, Func<Node, bool> predicate)
    {
        var result = new List<Node>();
        if (root is null)
        {
            return result;
        }

        var seen = new HashSet<IntPtr>();

        void Visit(Node node)
        {
            if (!GodotObject.IsInstanceValid(node))
            {
                return;
            }

            if (seen.Add(node.NativeInstance) && predicate(node) && IsNodeVisible(node))
            {
                result.Add(node);
            }

            foreach (Node child in node.GetChildren())
            {
                Visit(child);
            }
        }

        Visit(root);
        return result;
    }

    private static T? FindFirstVisibleDescendant<T>(Node? root) where T : Node
    {
        return FindVisibleDescendants<T>(root).FirstOrDefault();
    }

    private static Node? FindFirstVisibleDescendant(Node? root, Func<Node, bool> predicate)
    {
        return FindVisibleDescendants(root, predicate).FirstOrDefault();
    }

    private static List<T> SortByVisualPosition<T>(IEnumerable<T> nodes) where T : Node
    {
        return nodes
            .OrderBy(static node => node is Control control ? control.GlobalPosition.Y : 0f)
            .ThenBy(static node => node is Control control ? control.GlobalPosition.X : 0f)
            .ToList();
    }

    private static void InvokeMenuButtonAction(Node button)
    {
        if (TryInvokeParameterless(button, "ForceClick") ||
            TryInvokeParameterless(button, "OnRelease") ||
            TryInvokeParameterless(button, "OnPress") ||
            TryInvokeParameterless(button, "Pressed") ||
            TryInvokeParameterless(button, "OnButtonPressed"))
        {
            return;
        }

        throw new BridgeRequestException(
            HttpStatusCode.Conflict,
            "action_target_missing",
            $"Could not invoke a supported main-menu action on {button.GetType().FullName}.");
    }

    private static void InvokeClickablePressAndRelease(object target)
    {
        var didInvoke = false;

        if (TryInvokeParameterless(target, "OnPress"))
        {
            didInvoke = true;
        }

        if (TryInvokeParameterless(target, "OnRelease"))
        {
            didInvoke = true;
        }

        if (didInvoke || TryInvokeParameterless(target, "ForceClick"))
        {
            return;
        }

        throw new BridgeRequestException(
            HttpStatusCode.Conflict,
            "action_target_missing",
            $"Could not invoke click lifecycle on {target.GetType().FullName}.");
    }

    private static void InvokeProceedButtonAction(NProceedButton button)
    {
        InvokeClickablePressAndRelease(button);
    }

    private static void InvokeRoomProceedAction(BridgeWorldContext context)
    {
        if (context.ProceedButton is null)
        {
            throw new BridgeRequestException(
                HttpStatusCode.Conflict,
                "action_target_missing",
                "Could not find a visible room proceed button.");
        }

        if (context.CombatRoom is not null &&
            ReferenceEquals(context.ProceedButton, context.CombatRoom.ProceedButton))
        {
            InvokeCombatProceedAction(context.CombatRoom, context.ProceedButton);
            return;
        }

        InvokeProceedButtonAction(context.ProceedButton);
    }

    private static void InvokeCombatProceedAction(NCombatRoom? combatRoom, NProceedButton button)
    {
        if (TryInvokeSingleArgument(combatRoom, "OnProceedButtonPressed", button))
        {
            return;
        }

        InvokeProceedButtonAction(button);
    }

    private static void InvokeRestSiteProceedAction(NRestSiteRoom? restSiteRoom, NProceedButton button)
    {
        if (TryInvokeSingleArgument(restSiteRoom, "OnProceedButtonReleased", button))
        {
            return;
        }

        InvokeProceedButtonAction(button);
    }

    private static void InvokeMerchantLeaveAction(NMerchantRoom? merchantRoom, NProceedButton button)
    {
        if (TryInvokeSingleArgument(merchantRoom, "HideScreen", button))
        {
            return;
        }

        InvokeProceedButtonAction(button);
    }

    private static void InvokeCardSelectionOptionAction(Node? cardSelectionScreen, NCardHolder cardHolder)
    {
        if (cardSelectionScreen is NPlayerHand playerHand)
        {
            if (TryInvokeSingleArgument(playerHand, "OnHolderPressed", cardHolder))
            {
                TryAutoConfirmSelectedCardSelection(cardSelectionScreen);
                return;
            }

            if (cardHolder is NHandCardHolder handCardHolder &&
                (TryInvokeSingleArgument(playerHand, "SelectCardInSimpleMode", handCardHolder) ||
                 TryInvokeSingleArgument(playerHand, "SelectCardInUpgradeMode", handCardHolder)))
            {
                TryAutoConfirmSelectedCardSelection(cardSelectionScreen);
                return;
            }
        }

        if (TryInvokeSingleArgument(cardSelectionScreen, "SelectHolder", cardHolder))
        {
            TryAutoConfirmSelectedCardSelection(cardSelectionScreen);
            return;
        }

        if (cardHolder.CardModel is not null &&
            TryInvokeSingleArgument(cardSelectionScreen, "OnCardClicked", cardHolder.CardModel))
        {
            TryAutoConfirmSelectedCardSelection(cardSelectionScreen);
            return;
        }

        throw new BridgeRequestException(
            HttpStatusCode.Conflict,
            "action_target_missing",
            $"Could not resolve a supported card-selection action for {cardSelectionScreen?.GetType().FullName ?? "<missing screen>"}.");
    }

    private static bool ShouldAutoConfirmSingleCardSelection(Node? cardSelectionScreen)
    {
        var prefs = GetHiddenFieldValue(cardSelectionScreen, "_prefs");
        return (GetHiddenPropertyValue<int>(prefs, "MinSelect") ?? 0) == 1 &&
               (GetHiddenPropertyValue<int>(prefs, "MaxSelect") ?? 0) == 1;
    }

    private static void TryAutoConfirmSelectedCardSelection(Node? cardSelectionScreen)
    {
        if (!ShouldAutoConfirmSingleCardSelection(cardSelectionScreen) ||
            CountSelectedCardSelectionCards(cardSelectionScreen) <= 0)
        {
            return;
        }

        var confirmButton =
            GetHiddenFieldValue(cardSelectionScreen, "_confirmButton") as Node ??
            GetHiddenFieldValue(cardSelectionScreen, "_previewConfirmButton") as Node ??
            GetHiddenFieldValue(cardSelectionScreen, "_selectModeConfirmButton") as Node;
        if (confirmButton is null)
        {
            return;
        }

        InvokeCardSelectionConfirmAction(cardSelectionScreen, confirmButton);
    }

    private static void InvokeCardSelectionConfirmAction(Node? cardSelectionScreen, Node? confirmButton)
    {
        if (cardSelectionScreen is NPlayerHand playerHand &&
            confirmButton is not null &&
            TryInvokeSingleArgument(playerHand, "OnSelectModeConfirmButtonPressed", confirmButton))
        {
            return;
        }

        if (TryInvokeParameterless(cardSelectionScreen, "CompleteSelection"))
        {
            return;
        }

        if (confirmButton is not null &&
            TryInvokeSingleArgument(cardSelectionScreen, "ConfirmSelection", confirmButton))
        {
            return;
        }

        if (confirmButton is not null)
        {
            InvokeClickablePressAndRelease(confirmButton);
            return;
        }

        throw new BridgeRequestException(
            HttpStatusCode.Conflict,
            "action_target_missing",
            "Could not confirm the current card selection.");
    }

    private static void InvokeCardSelectionCancelAction(Node? cardSelectionScreen, Node? cancelButton)
    {
        if (cancelButton is not null &&
            TryInvokeSingleArgument(cardSelectionScreen, "CancelSelection", cancelButton))
        {
            return;
        }

        if (cancelButton is not null)
        {
            InvokeClickablePressAndRelease(cancelButton);
            return;
        }

        throw new BridgeRequestException(
            HttpStatusCode.Conflict,
            "action_target_missing",
            "Could not cancel the current card-selection preview.");
    }

    private static void InvokeCardSelectionCloseAction(Node? cardSelectionScreen, Node? closeButton)
    {
        if (closeButton is not null &&
            TryInvokeSingleArgument(cardSelectionScreen, "CloseSelection", closeButton))
        {
            return;
        }

        if (closeButton is not null)
        {
            InvokeClickablePressAndRelease(closeButton);
            return;
        }

        throw new BridgeRequestException(
            HttpStatusCode.Conflict,
            "action_target_missing",
            "Could not close the current card-selection screen.");
    }

    private static void InvokeCardSelectionSkipAction(Node? cardSelectionScreen, Node? skipButton)
    {
        if (skipButton is not null &&
            TryInvokeSingleArgument(cardSelectionScreen, "OnSkipButtonReleased", skipButton))
        {
            return;
        }

        if (skipButton is not null)
        {
            InvokeClickablePressAndRelease(skipButton);
            return;
        }

        throw new BridgeRequestException(
            HttpStatusCode.Conflict,
            "action_target_missing",
            "Could not skip the current card selection.");
    }

    private static void InvokeTerminalRewardsProceed(
        RunManager? runManager,
        NRewardsScreen? rewardsScreen,
        NProceedButton? rewardProceedButton)
    {
        if (TryInvokeParameterless(runManager, "ProceedFromTerminalRewardsScreen") ||
            TryInvokeParameterless(rewardsScreen, "ProceedFromTerminalRewardsScreen"))
        {
            return;
        }

        if (rewardProceedButton is not null)
        {
            InvokeProceedButtonAction(rewardProceedButton);
            return;
        }

        throw new BridgeRequestException(
            HttpStatusCode.Conflict,
            "action_target_missing",
            "Could not find a terminal rewards proceed target.");
    }

    private static void InvokeRunModeSelectionAction(Node? submenu, Node? button, string methodName)
    {
        if (submenu is not null)
        {
            if (TryInvokeParameterless(submenu, methodName))
            {
                return;
            }

            if (button is not null && TryInvokeSingleArgument(submenu, methodName, button))
            {
                return;
            }
        }

        if (button is not null)
        {
            InvokeMenuButtonAction(button);
            return;
        }

        throw new BridgeRequestException(
            HttpStatusCode.Conflict,
            "action_target_missing",
            $"Could not invoke run-mode selection action '{methodName}'.");
    }

    private static void InvokeButtonAction(object target, string methodName, string? fallbackMethodName = null)
    {
        if (TryInvokeParameterless(target, methodName))
        {
            return;
        }

        if (fallbackMethodName is not null && TryInvokeParameterless(target, fallbackMethodName))
        {
            return;
        }

        throw new BridgeRequestException(
            HttpStatusCode.Conflict,
            "action_target_missing",
            $"Could not invoke {methodName} on {target.GetType().FullName}.");
    }

    private static void InvokeSingleArgumentAction(object target, string methodName, object argument)
    {
        var method = FindMethod(target.GetType(), methodName, 1);
        if (method is null)
        {
            throw new BridgeRequestException(
                HttpStatusCode.Conflict,
                "action_target_missing",
                $"Could not find {methodName} on {target.GetType().FullName}.");
        }

        method.Invoke(target, new[] { argument });
    }

    private static object? InvokeParameterless(object? target, string methodName)
    {
        if (target is null)
        {
            return null;
        }

        var method = FindMethod(target.GetType(), methodName, 0);
        return method?.Invoke(target, Array.Empty<object>());
    }

    private static void ExecuteGameActionSynchronously(object action)
    {
        var result = InvokeParameterless(action, "ExecuteAction");
        if (result is Task task)
        {
            task.GetAwaiter().GetResult();
            return;
        }

        throw new BridgeRequestException(
            HttpStatusCode.Conflict,
            "action_execution_failed",
            $"Could not execute game action {action.GetType().FullName}.");
    }

    private static bool? TryInvokeBoolean(object? target, string methodName, params object?[] arguments)
    {
        if (target is null)
        {
            return null;
        }

        try
        {
            var method = FindMethod(target.GetType(), methodName, arguments.Length);
            if (method is null)
            {
                return null;
            }

            var result = method.Invoke(target, arguments);
            return result is bool boolResult ? boolResult : null;
        }
        catch
        {
            return null;
        }
    }

    private static bool TryInvokeParameterless(object? target, string methodName)
    {
        if (target is null)
        {
            return false;
        }

        var method = FindMethod(target.GetType(), methodName, 0);
        if (method is null)
        {
            return false;
        }

        method.Invoke(target, Array.Empty<object>());
        return true;
    }

    private static bool TryInvokeSingleArgument(object? target, string methodName, object argument)
    {
        if (target is null)
        {
            return false;
        }

        var method = FindMethod(target.GetType(), methodName, 1);
        if (method is null)
        {
            return false;
        }

        method.Invoke(target, new[] { argument });
        return true;
    }

    private static MethodInfo? FindMethod(Type? type, string methodName, int parameterCount)
    {
        while (type is not null)
        {
            var method = type
                .GetMethods(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly)
                .FirstOrDefault(candidate =>
                    candidate.Name.Equals(methodName, StringComparison.Ordinal) &&
                    candidate.GetParameters().Length == parameterCount);

            if (method is not null)
            {
                return method;
            }

            type = type.BaseType;
        }

        return null;
    }

    private static T? GetHiddenPropertyValue<T>(object? target, string propertyName) where T : struct
    {
        if (target is null)
        {
            return null;
        }

        var property = FindProperty(target.GetType(), propertyName);
        if (property is null)
        {
            return null;
        }

        var value = property.GetValue(target);
        return value is T typed ? typed : null;
    }

    private static object? GetHiddenPropertyObjectValue(object? target, string propertyName)
    {
        if (target is null)
        {
            return null;
        }

        var property = FindProperty(target.GetType(), propertyName);
        return property?.GetValue(target);
    }

    private static object? GetHiddenFieldValue(object? target, string fieldName)
    {
        if (target is null)
        {
            return null;
        }

        var field = FindField(target.GetType(), fieldName);
        return field?.GetValue(target);
    }

    private static int CountSelectedDeckUpgradeCards(NDeckUpgradeSelectScreen? deckUpgradeScreen)
    {
        return GetSelectedDeckUpgradeCards(deckUpgradeScreen).Count;
    }

    private static bool IsDeckUpgradeCardSelected(NDeckUpgradeSelectScreen? deckUpgradeScreen, CardModel? card)
    {
        if (card is null)
        {
            return false;
        }

        return GetSelectedDeckUpgradeCards(deckUpgradeScreen).Any(selected => ReferenceEquals(selected, card));
    }

    private static List<object> GetSelectedDeckUpgradeCards(NDeckUpgradeSelectScreen? deckUpgradeScreen)
    {
        if (GetHiddenFieldValue(deckUpgradeScreen, "_selectedCards") is not IEnumerable selectedCards)
        {
            return new List<object>();
        }

        return selectedCards
            .Cast<object?>()
            .Where(static selected => selected is not null)
            .Cast<object>()
            .ToList();
    }

    private static bool IsDeckUpgradePreviewHolder(NDeckUpgradeSelectScreen deckUpgradeScreen, NCardHolder holder)
    {
        return IsDescendantOf(holder, GetHiddenFieldValue(deckUpgradeScreen, "_singlePreview") as Node) ||
               IsDescendantOf(holder, GetHiddenFieldValue(deckUpgradeScreen, "_multiPreview") as Node) ||
               IsDescendantOf(holder, GetHiddenFieldValue(deckUpgradeScreen, "_upgradeSinglePreviewContainer") as Node) ||
               IsDescendantOf(holder, GetHiddenFieldValue(deckUpgradeScreen, "_upgradeMultiPreviewContainer") as Node);
    }

    private static bool IsDescendantOf(Node? node, Node? ancestor)
    {
        if (node is null || ancestor is null)
        {
            return false;
        }

        var current = node.GetParent();
        while (current is not null)
        {
            if (ReferenceEquals(current, ancestor))
            {
                return true;
            }

            current = current.GetParent();
        }

        return false;
    }

    private static T? ResolveFirstVisibleNode<T>(params T?[] candidates) where T : Node
    {
        return candidates.FirstOrDefault(IsNodeVisible);
    }

    private static Node? ResolveCombatHandSelectionNode(NPlayerHand? playerHand)
    {
        if (playerHand is null || !IsNodeVisible(playerHand))
        {
            return null;
        }

        return playerHand.IsInCardSelection ||
               GetHiddenPropertyValue<bool>(playerHand, "IsInCardSelection") == true
            ? playerHand
            : null;
    }

    private static Node? ResolveVisibleCardSelectionScreen(Node? root, params Node?[] excludedScreens)
    {
        if (root is null)
        {
            return null;
        }

        var excludedInstances = excludedScreens
            .Where(screen => screen is not null && GodotObject.IsInstanceValid(screen))
            .Select(screen => screen!.NativeInstance)
            .ToHashSet();

        return FindVisibleDescendants(
                root,
                node =>
                {
                    if (excludedInstances.Contains(node.NativeInstance))
                    {
                        return false;
                    }

                    var fullName = node.GetType().FullName;
                    return fullName is not null &&
                           fullName.StartsWith("MegaCrit.Sts2.Core.Nodes.Screens.CardSelection.", StringComparison.Ordinal) &&
                           fullName.EndsWith("Screen", StringComparison.Ordinal);
                })
            .OrderByDescending(node => node is Control control ? control.Size.X * control.Size.Y : 0f)
            .FirstOrDefault();
    }

    private static IReadOnlyList<NCardHolder> GetCardSelectionOptions(Node? cardSelectionScreen)
    {
        if (cardSelectionScreen is null)
        {
            return Array.Empty<NCardHolder>();
        }

        if (cardSelectionScreen is NPlayerHand playerHand)
        {
            return SortByVisualPosition(
                    FindVisibleDescendants<NCardHolder>(playerHand)
                        .Where(static holder =>
                            holder.CardModel is not null &&
                            holder is not NSelectedHandCardHolder))
                .DistinctBy(static holder => holder.CardModel, ReferenceEqualityComparer.Instance)
                .ToArray();
        }

        return SortByVisualPosition(
                FindVisibleDescendants<NCardHolder>(cardSelectionScreen)
                    .Where(static holder => holder.CardModel is not null))
            .DistinctBy(static holder => holder.CardModel, ReferenceEqualityComparer.Instance)
            .ToArray();
    }

    private static NProceedButton? ResolveVisibleProceedButton(
        Node? root,
        NProceedButton? preferredProceedButton,
        NProceedButton? restSiteProceedButton,
        NProceedButton? merchantProceedButton)
    {
        if (preferredProceedButton is not null && IsNodeVisible(preferredProceedButton))
        {
            return preferredProceedButton;
        }

        var excludedButtons = new HashSet<IntPtr>();
        if (restSiteProceedButton is not null && GodotObject.IsInstanceValid(restSiteProceedButton))
        {
            excludedButtons.Add(restSiteProceedButton.NativeInstance);
        }

        if (merchantProceedButton is not null && GodotObject.IsInstanceValid(merchantProceedButton))
        {
            excludedButtons.Add(merchantProceedButton.NativeInstance);
        }

        return SortByVisualPosition(
                FindVisibleDescendants<NProceedButton>(root)
                    .Where(button => !excludedButtons.Contains(button.NativeInstance)))
            .LastOrDefault();
    }

    private static string? TryGetCardSelectionPrompt(Node? cardSelectionScreen)
    {
        if (cardSelectionScreen is null)
        {
            return null;
        }

        var promptNode = ResolveFirstVisibleNode(
            GetHiddenFieldValue(cardSelectionScreen, "_selectionHeader") as Node,
            GetHiddenFieldValue(cardSelectionScreen, "_infoLabel") as Node,
            GetHiddenFieldValue(cardSelectionScreen, "_banner") as Node);
        var prompt = TryGetNodeText(promptNode);
        if (!string.IsNullOrWhiteSpace(prompt))
        {
            return prompt;
        }

        return CollectVisibleText(cardSelectionScreen, 1).FirstOrDefault();
    }

    private static int CountSelectedCardSelectionCards(Node? cardSelectionScreen)
    {
        if (cardSelectionScreen is null)
        {
            return 0;
        }

        if (GetHiddenFieldValue(cardSelectionScreen, "_selectedCards") is IEnumerable selectedCards)
        {
            return selectedCards.Cast<object?>().Count(static card => card is not null);
        }

        return GetHiddenFieldValue(cardSelectionScreen, "_cardSelected") is true ? 1 : 0;
    }

    private static bool IsCardSelectionCardSelected(Node? cardSelectionScreen, CardModel? card)
    {
        if (cardSelectionScreen is null || card is null)
        {
            return false;
        }

        if (GetHiddenFieldValue(cardSelectionScreen, "_selectedCards") is IEnumerable selectedCards)
        {
            return selectedCards.Cast<object?>().Any(selected => ReferenceEquals(selected, card));
        }

        return false;
    }

    private static PropertyInfo? FindProperty(Type? type, string propertyName)
    {
        while (type is not null)
        {
            var property = type.GetProperty(
                propertyName,
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly);

            if (property is not null)
            {
                return property;
            }

            type = type.BaseType;
        }

        return null;
    }

    private static FieldInfo? FindField(Type? type, string fieldName)
    {
        while (type is not null)
        {
            var field = type.GetField(
                fieldName,
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly);

            if (field is not null)
            {
                return field;
            }

            type = type.BaseType;
        }

        return null;
    }

    private static string DescribeCharacter(CharacterModel? character)
    {
        return TextOf(character?.CharacterSelectTitle);
    }

    private static string TryGetTitle(object model)
    {
        var property = FindProperty(model.GetType(), "Title");
        return TextOf(property?.GetValue(model));
    }

    private static string TryGetDescription(object model)
    {
        var property = FindProperty(model.GetType(), "Description");
        return TextOf(property?.GetValue(model));
    }

    private static string TextOf(object? value)
    {
        return value?.ToString() ?? string.Empty;
    }

    private static IReadOnlyList<string> CollectVisibleText(Node? root, int maxCount)
    {
        if (root is null || maxCount <= 0)
        {
            return Array.Empty<string>();
        }

        var texts = new List<string>(maxCount);
        var seenTexts = new HashSet<string>(StringComparer.Ordinal);

        void Visit(Node node)
        {
            if (texts.Count >= maxCount || !GodotObject.IsInstanceValid(node) || !IsNodeVisible(node))
            {
                return;
            }

            var text = TryGetOwnNodeText(node);
            if (!string.IsNullOrWhiteSpace(text) && seenTexts.Add(text))
            {
                texts.Add(text);
                if (texts.Count >= maxCount)
                {
                    return;
                }
            }

            foreach (Node child in node.GetChildren())
            {
                Visit(child);
                if (texts.Count >= maxCount)
                {
                    return;
                }
            }
        }

        Visit(root);
        return texts;
    }

    private static string TryGetNodeText(Node? node)
    {
        return CollectVisibleText(node, 1).FirstOrDefault() ?? string.Empty;
    }

    private static string TryGetOwnNodeText(Node node)
    {
        var propertyNames = new[]
        {
            "Text",
            "Title",
            "Label",
            "Subtitle",
            "Description",
            "CurrentText",
            "Value"
        };

        foreach (var propertyName in propertyNames)
        {
            var text = TryGetTextFromValue(GetHiddenPropertyObjectValue(node, propertyName));
            if (!string.IsNullOrWhiteSpace(text))
            {
                return text;
            }
        }

        var fieldNames = new[]
        {
            "_label",
            "_title",
            "_text",
            "Label",
            "Title",
            "Text"
        };

        foreach (var fieldName in fieldNames)
        {
            var text = TryGetTextFromValue(GetHiddenFieldValue(node, fieldName));
            if (!string.IsNullOrWhiteSpace(text))
            {
                return text;
            }
        }

        if (node is Label label)
        {
            return label.Text;
        }

        if (node is RichTextLabel richTextLabel)
        {
            return richTextLabel.Text;
        }

        return string.Empty;
    }

    private static string TryGetTextFromValue(object? value)
    {
        return value switch
        {
            null => string.Empty,
            string text => text,
            Node node => TryGetNodeText(node),
            _ when value is System.Collections.IEnumerable => string.Empty,
            _ => TextOf(value)
        };
    }

    private static string? TryGetMainMenuSemanticAction(string text)
    {
        var normalized = NormalizeMenuText(text);
        if (string.IsNullOrEmpty(normalized))
        {
            return null;
        }

        if (normalized.Contains("continue") || normalized.Contains("继续游戏"))
        {
            return "continue";
        }

        if (normalized.Contains("abandoncurrentgame") || normalized.Contains("放弃当前游戏"))
        {
            return "abandon_current_game";
        }

        if (normalized.Contains("newgame") || normalized.Contains("新游戏"))
        {
            return "new_game";
        }

        if (normalized.Contains("singleplayer") || normalized.Contains("单人模式"))
        {
            return "singleplayer";
        }

        if (normalized.Contains("multiplayer") || normalized.Contains("多人模式"))
        {
            return "multiplayer";
        }

        if (normalized.Contains("timeline") || normalized.Contains("时间线"))
        {
            return "timeline";
        }

        if (normalized.Contains("settings") || normalized.Contains("设置"))
        {
            return "settings";
        }

        if (normalized.Contains("compendium") || normalized.Contains("百科大全"))
        {
            return "compendium";
        }

        if (normalized.Contains("quit") || normalized.Contains("exit") || normalized.Contains("退出"))
        {
            return "quit";
        }

        return null;
    }

    private static string? TryGetAbandonConfirmSemanticAction(string text)
    {
        var normalized = NormalizeMenuText(text);
        if (string.IsNullOrEmpty(normalized))
        {
            return null;
        }

        if (normalized.Contains("cancel") ||
            normalized.Contains("取消") ||
            normalized.Contains("不了") ||
            normalized.Equals("否", StringComparison.Ordinal))
        {
            return "cancel";
        }

        if (normalized.Contains("confirm") ||
            normalized.Contains("abandon") ||
            normalized.Contains("确认") ||
            normalized.Contains("好的") ||
            normalized.Contains("放弃") ||
            normalized.Equals("是", StringComparison.Ordinal))
        {
            return "confirm";
        }

        return null;
    }

    private static string NormalizeMenuText(string text)
    {
        return string.Concat(text.Where(static character => !char.IsWhiteSpace(character))).ToLowerInvariant();
    }

    private static string ComputeStateHash(object payload)
    {
        var json = JsonSerializer.Serialize(payload, HashJsonOptions);
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(json));
        return Convert.ToHexString(bytes).ToLowerInvariant();
    }

    private static int ComputeStateVersion(string stateHash)
    {
        var bytes = Convert.FromHexString(stateHash);
        return unchecked((int)(BinaryPrimitives.ReadUInt32LittleEndian(bytes) & 0x7fffffff));
    }

    private sealed class BridgeWorldContext
    {
        public required NGame Game { get; init; }

        public NRun? RunNode { get; init; }

        public RunManager? RunManager { get; init; }

        public CombatManager? CombatManager { get; init; }

        public RunState? RunState { get; init; }

        public CombatState? CombatState { get; init; }

        public required string Screen { get; init; }

        public NCombatRoom? CombatRoom { get; init; }

        public NCombatUi? CombatUi { get; init; }

        public NEndTurnButton? EndTurnButton { get; init; }

        public NProceedButton? ProceedButton { get; init; }

        public NMapScreen? MapScreen { get; init; }

        public NRestSiteRoom? RestSiteRoom { get; init; }

        public NMerchantRoom? MerchantRoom { get; init; }

        public NMerchantInventory? MerchantInventory { get; init; }

        public NRewardsScreen? RewardsScreen { get; init; }

        public NProceedButton? RewardProceedButton { get; init; }

        public NCardRewardSelectionScreen? CardRewardScreen { get; init; }

        public Node? CardSelectionScreen { get; init; }

        public NCharacterSelectScreen? CharacterSelectScreen { get; init; }

        public NDeckUpgradeSelectScreen? DeckUpgradeScreen { get; init; }

        public NProceedButton? RestSiteProceedButton { get; init; }

        public NMerchantButton? MerchantButton { get; init; }

        public NProceedButton? MerchantProceedButton { get; init; }

        public NBackButton? MerchantBackButton { get; init; }

        public NCharacterSelectButton? SelectedCharacterButton { get; init; }

        public NConfirmButton? EmbarkButton { get; init; }

        public Node? CardSelectionConfirmButton { get; init; }

        public Node? CardSelectionCancelButton { get; init; }

        public Node? CardSelectionCloseButton { get; init; }

        public Node? CardSelectionSkipButton { get; init; }

        public NConfirmButton? DeckUpgradeConfirmButton { get; init; }

        public NBackButton? DeckUpgradeCancelButton { get; init; }

        public NBackButton? DeckUpgradeCloseButton { get; init; }

        public required IReadOnlyList<NRewardButton> RewardButtons { get; init; }

        public required IReadOnlyList<NCardHolder> CardRewardOptions { get; init; }

        public required IReadOnlyList<NCardHolder> CardSelectionOptions { get; init; }

        public required IReadOnlyList<NCardHolder> DeckUpgradeOptions { get; init; }

        public required IReadOnlyList<NCharacterSelectButton> CharacterButtons { get; init; }

        public required IReadOnlyList<NEventOptionButton> EventOptionButtons { get; init; }

        public required IReadOnlyList<NMapPoint> MapPoints { get; init; }

        public required IReadOnlyList<NRestSiteButton> RestSiteButtons { get; init; }

        public required IReadOnlyList<NMerchantSlot> MerchantSlots { get; init; }

        public Node? MainMenuRoot { get; init; }

        public Node? MainMenuContinueButton { get; init; }

        public required IReadOnlyList<Node> MainMenuTextButtons { get; init; }

        public Node? RunModeSubmenu { get; init; }

        public Node? RunModeStandardButton { get; init; }

        public Node? RunModeDailyButton { get; init; }

        public Node? RunModeCustomButton { get; init; }

        public NBackButton? RunModeBackButton { get; init; }

        public Node? ContinueRunInfo { get; init; }

        public Node? AbandonRunConfirmPopup { get; init; }

        public required IReadOnlyList<NPopupYesNoButton> AbandonRunConfirmButtons { get; init; }
    }

    private sealed class BridgeResolvedAction
    {
        public required string ActionId { get; init; }

        public required object Payload { get; init; }

        public required Action Execute { get; init; }
    }

    private sealed class ResolvedCardTarget
    {
        public string? ActionSuffix { get; init; }

        public string? LabelSuffix { get; init; }

        public Creature? Target { get; init; }

        public required bool RequiresTargetSelection { get; init; }
    }

    private sealed class ResolvedPotionTarget
    {
        public string? ActionSuffix { get; init; }

        public string? LabelSuffix { get; init; }

        public Creature? Target { get; init; }

        public required bool RequiresTargetSelection { get; init; }
    }

    private sealed class BridgeStateFields
    {
        public required string Screen { get; init; }

        public required object Automation { get; init; }

        public required object Run { get; init; }

        public required object Combat { get; init; }

        public required object[] Players { get; init; }

        public required object Rewards { get; init; }

        public required object CardRewardSelection { get; init; }

        public required object CardSelection { get; init; }

        public required object CharacterSelection { get; init; }

        public required object RunModeSelection { get; init; }

        public required object EventOptions { get; init; }

        public required object Map { get; init; }

        public required object RestSite { get; init; }

        public required object DeckUpgradeSelection { get; init; }

        public required object Shop { get; init; }

        public required object MainMenu { get; init; }

        public required object[] AvailableActions { get; init; }
    }

    private sealed class BridgeSnapshot
    {
        public required int StateVersion { get; init; }

        public required string StateHash { get; init; }

        public required BridgeStateFields Fields { get; init; }

        public required object StatePayload { get; init; }

        public required IReadOnlyList<BridgeResolvedAction> Actions { get; init; }

        public required IReadOnlyList<object> ActionPayloads { get; init; }

        public required IReadOnlyDictionary<string, BridgeResolvedAction> ActionLookup { get; init; }
    }
}
