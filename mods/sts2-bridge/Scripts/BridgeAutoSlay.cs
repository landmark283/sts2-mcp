using MegaCrit.Sts2.Core.AutoSlay;
using MegaCrit.Sts2.Core.AutoSlay.Helpers;

namespace Sts2McpBridge.Scripts;

internal static class BridgeAutoSlay
{
    private static readonly object Sync = new();
    private static AutoSlayer? _autoSlayer;
    private static DateTimeOffset? _lastStartRequestedAtUtc;
    private static DateTimeOffset? _lastStopRequestedAtUtc;
    private static string? _lastRequestedSeed;
    private static string? _lastError;

    public static bool IsActive
    {
        get
        {
            lock (Sync)
            {
                return AutoSlayer.IsActive;
            }
        }
    }

    public static string LogFilePath { get; } = Path.Combine(
        BridgeRuntime.SessionDirectoryPath,
        "autoslay.log");

    public static void Start(string? seed = null)
    {
        lock (Sync)
        {
            if (AutoSlayer.IsActive)
            {
                return;
            }

            Directory.CreateDirectory(Path.GetDirectoryName(LogFilePath)!);

            _lastStartRequestedAtUtc = DateTimeOffset.UtcNow;
            _lastRequestedSeed = string.IsNullOrWhiteSpace(seed) ? null : seed.Trim();
            _lastError = null;
            _autoSlayer = new AutoSlayer();

            try
            {
                _autoSlayer.Start(_lastRequestedSeed ?? string.Empty, LogFilePath);
            }
            catch (Exception ex)
            {
                _lastError = ex.Message;
                _autoSlayer = null;
                throw;
            }
        }
    }

    public static void Stop()
    {
        lock (Sync)
        {
            _lastStopRequestedAtUtc = DateTimeOffset.UtcNow;
            _lastError = null;

            if (_autoSlayer is null)
            {
                return;
            }

            try
            {
                _autoSlayer.Stop();
            }
            catch (Exception ex)
            {
                _lastError = ex.Message;
                throw;
            }
        }
    }

    public static object GetStatusPayload()
    {
        lock (Sync)
        {
            var logExists = File.Exists(LogFilePath);
            var logLengthBytes = logExists ? new FileInfo(LogFilePath).Length : 0L;

            return new
            {
                available = true,
                active = AutoSlayer.IsActive,
                controller_initialized = _autoSlayer is not null,
                log_file_path = LogFilePath,
                log_exists = logExists,
                log_length_bytes = logLengthBytes,
                last_requested_seed = _lastRequestedSeed,
                last_start_requested_at_utc = _lastStartRequestedAtUtc,
                last_stop_requested_at_utc = _lastStopRequestedAtUtc,
                last_error = _lastError,
                watchdog_dump = TryDumpWatchdog()
            };
        }
    }

    private static string? TryDumpWatchdog()
    {
        try
        {
            return Watchdog.DumpState();
        }
        catch (Exception ex)
        {
            return $"watchdog_dump_failed: {ex.Message}";
        }
    }
}
