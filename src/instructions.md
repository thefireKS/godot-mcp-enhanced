# Godot MCP Enhanced quick reference

Three-layer architecture (headless + editor + bridge) covering scenes, scripts, UI, animation, physics, audio, tests. Tool list: `manage_tools` / `docs/capability-matrix.md`.

## Picking a layer

- **Static read/write of .tscn/.gd** → headless: `edit_script` (prefer `search_and_replace`) / `write_script` / `batch_*`
- **Live editor scene** → editor: `launch_editor` + `editor_*` (needs the plugin connected)
- **Running game** → bridge: `game_query` / `game_input` / `game_write` (needs `game_bridge_install` + the game running)
- **One-shot verification** → `run_and_verify` / `verify_delivery` / `validate_scripts`

## Five fatal traps

1. **Runtime tools don't persist**: headless runtime changes from `signal_*` / `particles_*` / `ui_*` / `audio_*` etc. are lost when the process exits; to persist use `add_node` + `save_scene` or `write_script`.
2. **edit_script: prefer search_and_replace**: content matching survives line shifts and CRLF; built-in Edit often misses tab indentation in .gd.
3. **2D screenshots may be blank in headless**: on `BLANK_DETECTED` use ① bridge `take_screenshot` (game running) / ② `screenshot(action=analyze)` on an external screenshot / ③ a manual one. 3D is unaffected.
4. **Node paths need the /root/ prefix**: every game_* path/node_path (game_query, game_write, game_wait, game_input, click_button, monitor, watch) starts with `/root/`, e.g. `/root/Main/Player`.
5. **Bridge secret has a 5 min TTL**: the first call after a long idle may be slower; for permission loops set `GODOT_MCP_BRIDGE_PERSISTENT_SECRET=true` before launching the game.

## Security model

The deny-by-default path whitelist (`ALLOWED_PROJECT_PATHS`) + the GDScript sandbox are a **guard against mistakes**, not an unbypassable security boundary; use a container/VM for untrusted environments.

## Runtime details

`manage_tools` (tool group activation/status) · `godot_get_context` (session overview: mode/connections/scene/performance)
