using System.Diagnostics;
using System.Security.Cryptography;
using MegaCrit.Sts2.Core.Modding;

namespace Sts2McpBridge.Scripts;

internal static class BridgeRuntime
{
    public const string ModId = "sts2-bridge";
    public const string HarmonyId = "dev.yidhar.sts2.bridge";
    public const string BridgeName = "STS2 MCP Bridge";
    public const string BridgeVersion = "0.7.9";
    public const string StateSchemaVersion = "2026-03-17.1";
    public const int PreferredPort = 27100;
    public const int MaxPort = 27110;
    public const bool VisibleOnly = true;

    public static int Port { get; private set; } = PreferredPort;

    public static string BaseUrl => $"http://127.0.0.1:{Port}/";

    public static string SessionId { get; } = Guid.NewGuid().ToString("n");

    public static string SessionToken { get; } = CreateSessionToken();

    public static DateTimeOffset StartedAtUtc { get; } = DateTimeOffset.UtcNow;

    public static int ProcessId { get; } = Process.GetCurrentProcess().Id;

    public static string SessionDirectoryPath { get; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "SlayTheSpire2",
        "bridge");

    public static string SessionFilePath { get; } = Path.Combine(
        SessionDirectoryPath,
        "session.json");

    public static string GameAssemblyVersion =>
        typeof(Mod).Assembly.GetName().Version?.ToString() ?? "unknown";

    public static void SetPort(int port)
    {
        Port = port;
    }

    private static string CreateSessionToken()
    {
        var bytes = RandomNumberGenerator.GetBytes(32);
        return Convert.ToBase64String(bytes)
            .Replace('+', '-')
            .Replace('/', '_')
            .TrimEnd('=');
    }
}
