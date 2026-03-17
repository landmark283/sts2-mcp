# sts2-mcp

[中文说明](./README.zh-CN.md)

`sts2-mcp` is a local control stack for **Slay the Spire 2** built around a
bridge mod plus an MCP server.

The project avoids screen scraping as the primary control path. Instead, it
reads visible in-game state from a native mod running inside the game process
and exposes legal actions to external agents through MCP.

## What Is In This Repo

- `mods/sts2-bridge`
  - C#/.NET 9 bridge mod loaded by Slay the Spire 2
  - exposes local loopback HTTP endpoints
  - serializes current run/combat/reward/map state
  - executes legal in-game actions
- `packages/mcp-server`
  - Node 22 stdio MCP server
  - reads the bridge discovery file
  - exposes bridge-backed MCP tools such as:
    - `sts2_get_state`
    - `sts2_list_actions`
    - `sts2_perform_action`
    - `sts2_play_card_sequence`
    - `sts2_resolve_room_rewards`
    - `sts2_resolve_rest_site`
    - `sts2_resolve_card_selection`
    - `sts2_resolve_shop_visit`

## Current Scope

This repository is focused on **source code** for the bridge and MCP server.

It does not include:

- local planning documents
- local experiment folders
- generated binaries
- local MCP config
- machine-specific logs or session files

## Status

The current codebase has already been live-tested against a local
`Slay the Spire 2` install on the `0.99+` line and includes working support for:

- bridge discovery through `%APPDATA%\\SlayTheSpire2\\bridge\\session.json`
- stable state reads while the game is running windowed
- legal action listing
- state-version-guarded action execution
- combat card play
- batched multi-card sequencing with rematching after hand reindex
- room reward batching
- campfire batching
- card-selection batching
- shop batching with purchase reindex handling
- map route summarization for route planning

## Requirements

- Windows
- Node.js 22 or newer
- .NET 9 SDK
- a local `Slay the Spire 2` install

## Build The Bridge

Pass the game install path explicitly:

```powershell
dotnet build .\mods\sts2-bridge\sts2-bridge.csproj `
  -p:Sts2Dir="E:\Program Files (x86)\Steam\steamapps\common\Slay the Spire 2" `
  -p:Sts2SkipDeploy=true
```

Or set an environment variable first:

```powershell
$env:STS2_DIR="E:\Program Files (x86)\Steam\steamapps\common\Slay the Spire 2"
dotnet build .\mods\sts2-bridge\sts2-bridge.csproj -p:Sts2SkipDeploy=true
```

To deploy the built DLL into the game's `mods\sts2-bridge` directory, omit
`-p:Sts2SkipDeploy=true`.

## Run The MCP Server

```powershell
node .\packages\mcp-server\index.js
```

The server discovers the active bridge session from:

```text
%APPDATA%\SlayTheSpire2\bridge\session.json
```

You can override that path with:

```text
STS2_BRIDGE_SESSION_FILE
```

## Repository Notes

- `packages/mcp-server/package.json` stays `private: true` because this project
  is not intended to be published as an npm package.
- `mods/sts2-bridge/sts2-bridge.csproj` intentionally avoids hardcoded local
  install paths. Use `Sts2Dir`, `STS2_DIR`, or `SLAY_THE_SPIRE_2_DIR`.
- `mods/sts2-bridge/sts2-bridge.json` is kept minimal and loader-facing.

## Disclaimer

This is an unofficial project and is not affiliated with the Slay the Spire 2
developers or publishers.

## License

[MIT](./LICENSE)
