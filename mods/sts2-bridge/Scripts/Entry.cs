using HarmonyLib;
using MegaCrit.Sts2.Core.Logging;
using MegaCrit.Sts2.Core.Modding;

namespace Sts2McpBridge.Scripts;

[ModInitializer("Init")]
public static class Entry
{
    private static bool _initialized;

    public static void Init()
    {
        if (_initialized)
        {
            return;
        }

        _initialized = true;

        var harmony = new Harmony(BridgeRuntime.HarmonyId);
        harmony.PatchAll();

        var bridgeStarted = BridgeServer.Start();

        if (bridgeStarted)
        {
            Log.Info(
                $"[{BridgeRuntime.ModId}] Initialized {BridgeRuntime.BridgeName} v{BridgeRuntime.BridgeVersion} " +
                $"for game assembly {BridgeRuntime.GameAssemblyVersion}.");
        }
        else
        {
            Log.Warn(
                $"[{BridgeRuntime.ModId}] Mod initialized, but the HTTP bridge did not start. " +
                $"Check earlier log lines for the underlying error.");
        }
    }
}
