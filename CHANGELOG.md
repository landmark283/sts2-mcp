# Changelog

## v0.7.10 - 2026-03-19

Repository release: `v0.7.10`

Bridge mod version: `0.7.10`

MCP server version: `0.4.18`

### Highlights

- Added native smith upgrade previews to `deck_upgrade_selection.options[*].upgrade_preview`, built from the game's own `CloneCard + UpgradeInternal` flow instead of guessed text or manually mapped values.
- Reduced high-noise MCP responses across combat, rewards, campfire, shop, and map tools so agents get the minimum usable state instead of 200-800 line raw payloads.
- Improved combat automation guidance and sequence handling so mixed combat plans can use one call instead of multiple fragile round trips.

### Bridge Mod Changes

- `BuildDeckUpgradeSelectionPayload(...)` now includes `upgrade_preview` for every smith candidate.
- Upgrade previews come from a cloned upgraded card payload, so title, cost, effect summary, description, and dynamic vars follow the same logic as the in-game preview UI.
- Rebuilt and deployed `sts2-bridge.dll` for this release.

### MCP Server Changes

- `sts2_perform_action` and `sts2_end_turn`
- `return_state_after=true` now returns a compact post-action summary instead of the full bridge state.
- Removed redundant fields such as duplicated hashes, raw action lists, and full state trees when a compact summary is available.

- `sts2_play_card_sequence` and `sts2_execute_combat_sequence`
- Added mixed combat sequence support so one sequence can include `play_card`, `use_potion`, and `end_turn`.
- Continued support for post-action reindex matching after hand shifts, draws, and target remaps.
- Compressed `executed_steps` output so exact successful steps collapse to the executed action id, while `requested_action_id` is only kept when a remap or failure actually matters.
- Updated tool descriptions and agent-facing hints to push consecutive combat actions toward sequence tools instead of parallel `sts2_perform_action` calls.

- `sts2_resolve_room_rewards`
- Added a specialized compact resolver payload.
- The tool now reports the reward resolution result, claimed rewards, selected card, executed actions, and final compact state without echoing the entire reward flow twice.
- Fixed the "safe rewards + card pick + auto proceed" one-call path so the result is usable without extra manual cleanup calls.

- `sts2_resolve_rest_site`
- Added a specialized compact resolver payload for both success and unresolved smith flows.
- Smith choice prompts now return compact preview strings such as `14:武装 -> 武装+ | 1费 | 获得5点格挡。 / 升级你手牌中的所有牌。`
- Removed duplicate `state.screen`, empty `selected_option` / `selected_upgrade_card`, and repeated rest-site sections from unresolved responses.

- `sts2_resolve_shop_visit`
- Added a specialized compact resolver payload for purchase plans, purchased items, removal choices, and final compact state.
- Shop and card-removal follow-up prompts now avoid duplicating large shop/state payload sections.

- `sts2_travel_to_coordinate`
- Added a specialized compact resolver payload.
- Travel responses now emphasize the requested coordinate, settle status, executed actions, and final compact state instead of returning the whole state tree.

- Shared payload compaction
- Added dedicated compactors for action results, room rewards, campfire, shop, travel, and combat sequences instead of relying only on a generic global compactor.
- Added payload-section deduplication to suppress repeated copies of the same summarized data.
- Added inline text compaction helpers for dense decision surfaces such as smith previews.

### Practical Result

- Smith unresolved responses dropped from roughly `7.3k` characters to about `1.0k` while still carrying upgrade decision context.
- Campfire responses now expose upgrade choices in a format that is short enough for agents but still specific enough to choose the correct upgrade.
- Mixed combat turns can be executed with fewer tool calls and lower token waste.

### Upgrade Notes

- Restart the game after replacing `sts2-bridge.dll`, otherwise the new bridge payload fields will not exist in `get_state`.
- Restart the long-lived `sts2` MCP process after updating `packages/mcp-server/index.js`, otherwise tool responses will still use the old compaction logic.

### Release Assets

- `sts2-bridge-v0.7.10.dll`
- `sts2-bridge-v0.7.10.zip`
