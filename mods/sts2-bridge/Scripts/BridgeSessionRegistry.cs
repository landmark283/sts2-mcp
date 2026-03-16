using System.Text.Json;
using MegaCrit.Sts2.Core.Logging;

namespace Sts2McpBridge.Scripts;

internal static class BridgeSessionRegistry
{
    public static void WriteSessionFile()
    {
        var payload = new
        {
            ok = true,
            bridge_name = BridgeRuntime.BridgeName,
            bridge_version = BridgeRuntime.BridgeVersion,
            session_id = BridgeRuntime.SessionId,
            token = BridgeRuntime.SessionToken,
            started_at_utc = BridgeRuntime.StartedAtUtc,
            pid = BridgeRuntime.ProcessId,
            base_url = BridgeRuntime.BaseUrl,
            port = BridgeRuntime.Port,
            preferred_port = BridgeRuntime.PreferredPort,
            max_port = BridgeRuntime.MaxPort,
            visible_only = BridgeRuntime.VisibleOnly,
            game_assembly_version = BridgeRuntime.GameAssemblyVersion
        };

        Directory.CreateDirectory(BridgeRuntime.SessionDirectoryPath);

        var json = JsonSerializer.Serialize(payload, new JsonSerializerOptions
        {
            WriteIndented = true
        });

        File.WriteAllText(BridgeRuntime.SessionFilePath, json);

        Log.Info(
            $"[{BridgeRuntime.ModId}] Wrote bridge session file to {BridgeRuntime.SessionFilePath}");
    }
}
