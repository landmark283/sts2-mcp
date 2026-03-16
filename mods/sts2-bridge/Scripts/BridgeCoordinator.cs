using System.Collections.Concurrent;
using Godot;
using HarmonyLib;
using MegaCrit.Sts2.Core.Logging;
using MegaCrit.Sts2.Core.Nodes;
using MegaCrit.Sts2.Core.Nodes.CommonUi;

namespace Sts2McpBridge.Scripts;

internal static class BridgeCoordinator
{
    private static readonly object Sync = new();
    private static readonly ConcurrentQueue<Action> Queue = new();
    private static bool _isAttached;

    public static bool IsReady
    {
        get
        {
            lock (Sync)
            {
                return _isAttached &&
                       NGame.Instance is not null &&
                       GodotObject.IsInstanceValid(NGame.Instance);
            }
        }
    }

    public static void EnsureAttached(NGame? game)
    {
        if (game is null || !GodotObject.IsInstanceValid(game))
        {
            return;
        }

        lock (Sync)
        {
            if (_isAttached)
            {
                return;
            }

            _isAttached = true;

            Log.Info($"[{BridgeRuntime.ModId}] Attached bridge coordinator to NGame.");
            BridgeDebugTrace.Write("coordinator attached to NGame");
        }
    }

    public static void Detach()
    {
        lock (Sync)
        {
            while (Queue.TryDequeue(out _))
            {
            }

            BridgeDebugTrace.Write("coordinator detached");
            _isAttached = false;
        }
    }

    public static Task<T> RunOnMainThreadAsync<T>(Func<T> action)
    {
        if (NGame.Instance is not null &&
            GodotObject.IsInstanceValid(NGame.Instance) &&
            NGame.IsMainThread())
        {
            return Task.FromResult(action());
        }

        lock (Sync)
        {
            if (!_isAttached)
            {
                throw new InvalidOperationException("Bridge coordinator is not attached yet.");
            }
        }

        var tcs = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
        BridgeDebugTrace.Write("coordinator enqueue");

        Queue.Enqueue(() =>
        {
            try
            {
                tcs.TrySetResult(action());
            }
            catch (Exception ex)
            {
                tcs.TrySetException(ex);
            }
        });

        return tcs.Task;
    }

    public static void Pump()
    {
        var processedAny = false;

        while (Queue.TryDequeue(out var action))
        {
            processedAny = true;
            action();
        }

        if (processedAny)
        {
            BridgeDebugTrace.Write("coordinator processed queued work");
        }
    }

    [HarmonyPatch(typeof(NGame), nameof(NGame._Ready))]
    private static class NGameReadyPatch
    {
        [HarmonyPostfix]
        private static void Postfix(NGame __instance)
        {
            EnsureAttached(__instance);
        }
    }

    [HarmonyPatch(typeof(NGame), nameof(NGame._ExitTree))]
    private static class NGameExitTreePatch
    {
        [HarmonyPrefix]
        private static void Prefix()
        {
            Detach();
        }
    }

    [HarmonyPatch(typeof(NControllerManager), nameof(NControllerManager._Process))]
    private static class NControllerManagerProcessPatch
    {
        [HarmonyPostfix]
        private static void Postfix()
        {
            Pump();
        }
    }

    [HarmonyPatch(typeof(NRun), nameof(NRun._Process))]
    private static class NRunProcessPatch
    {
        [HarmonyPostfix]
        private static void Postfix()
        {
            Pump();
        }
    }
}
