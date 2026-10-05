# game

> Game bridge. Install/remove: game_bridge_install, game_bridge_uninstall. P2-1 override injection: install_override/uninstall_override (inject any debug script into the project's autoloads before launching the game, e.g. log hooks / state snapshots). Query: game_query (ping, get_tree, find_nodes, get_node_properties, get_performance, get_viewport_info, take_screenshot). Write: game_write (set_node_property, call_method). Input: game_input (send_key, send_mouse_click, send_mouse_move, send_text, send_touch, send_drag, send_input_sequence — frame-timed input timeline). Wait: game_wait (wait_for_node, wait_for_property). P2-4 deterministic playtest: game_playtest (playtest.seed locks RNG, playtest.fixed_delta locks the step, playtest.step advances frames, playtest.snapshot/restore state snapshots). G1 control layer: playtest.freeze (freezes the game loop, the bridge still answers), playtest.unfreeze, playtest.step_until (stops when conditions hold / frames run out / wall timeout; structured conditions {path,property,op,value}[] ANDed). Monitoring: monitor_start/stop/poll (property timeline sampling). Signals: watch_start/stop/poll (signal event log). UI: find_ui_elements/click_button (UI element discovery + button clicks).

| Property | Value |
|------|-----|
| Layer | bridge |
| Safety level | guarded |
| Needs Godot | yes |
| Needs editor | no |
| Read-only | no |
| Long-running | no |

## Actions

- `game_bridge_install`
- `game_bridge_uninstall`
- `install_override`
- `uninstall_override`
- `game_query`
- `game_write`
- `game_input`
- `game_wait`
- `game_playtest`
- `monitor_start`
- `monitor_stop`
- `monitor_poll`
- `watch_start`
- `watch_stop`
- `watch_poll`
- `find_ui_elements`
- `click_button`

## Parameters

| Parameter | Type | Required | Description |
|------|------|------|------|
| `action` | enum (17 values) | ✓ | Operation |
| `project_path` | string |  | Godot project directory (optional; defaults to the GODOT_PROJECT_PATH env var or the current directory) |
| `port` | number |  | game_bridge_install: desired starting listen port (the actual port starts at the game-side env GODOT_MCP_BRIDGE_PORT and increments when taken; this parameter changes nothing and is kept for compatibility). The actual port is in the ping response and the instance registry |
| `source_script_path` | string |  | install_override/uninstall_override: absolute path of the debug script (must be inside the ALLOWED_PROJECT_PATHS whitelist; copied to the project root and registered as the MCPOVERRIDE_<basename> autoload, appended at the end of [autoload] = loads after the game's autoloads, so its _ready can use game singletons directly without await <Singleton>.ready) |
| `method` | string |  | Method for game_query/game_write/game_input/game_wait/game_playtest. game_query: ping, get_tree, find_nodes (a root param limits the search to a subtree, absolute paths like /root/Main recommended; a missing node is an error, not a silent whole-tree search), get_node_properties, get_node_layout, get_performance, get_viewport_info, take_screenshot, get_errors (game runtime errors; since_seq for increments + clear to read-and-clear), clear_errors (empty the error buffer). game_write: set_node_property, call_method (coroutine methods are fire-and-forget by default and return a {coroutine:true} marker + note; pass params.await_completion=true to wait for the return value via a deferred response, raise timeout for long coroutines). game_input: send_key, send_mouse_click (button: int 1-9/left/right/middle), send_mouse_move, send_text, send_touch, send_drag, send_input_sequence (frame-timed timeline, deferred response). game_wait: wait_for_node, wait_for_property. game_playtest: playtest.seed (locks the global RNG, covers randi/randf only), playtest.fixed_delta (locks the physics step, delta=1/hz), playtest.step (advance N frames, deferred coroutine response), playtest.snapshot (snapshot scene tree properties; signals/physics/freed nodes are not kept), playtest.restore (restore properties from the snapshot). G1 control layer: playtest.freeze (sets tree.paused), playtest.unfreeze, playtest.step_until (advance until conditions hold / frames run out / wall timeout; structured conditions {path,property,op,value}[] ANDed, no Expression) |
| `params` | object |  | Method arguments. game_query: depends on the method. get_errors {since_seq?:int (default 0, only seq>since_seq), clear?:bool (default false, empty the buffer after reading)}. game_write: set_node_property {path, property, value}, call_method {path, method, args}. call_method defaults to a read-only whitelist (get/has_*/get_meta etc.); env GODOT_MCP_BRIDGE_EXTRA_METHODS=method1,method2 extends it (including write methods like take_damage); EXTRA_METHODS_BLOCKLIST (free/queue_free/set_script/call/emit_signal etc.) is a hard floor that cannot be overridden. args are coerced to the declared parameter types ([1,2,3] becomes a Vector3). Unknown methods get did-you-mean suggestions. The response carries undoable=false (calls cannot be undone). game_input: send_key {key, pressed}, send_mouse_click {x, y, button, pressed}, send_mouse_move {x, y}, send_text {text}, send_touch {x, y, pressed, index}, send_drag {x, y, index, relative, speed}, send_input_sequence {timeline:[{at_frame:1-600 (Nth frame after the window opens),type:action|key|mouse_click|mouse_move|touch|drag,...event params}], settle_frames?:int(0-600), wall_budget_ms?:int(1000-50000), ≤256 events} (action fields name/pressed/strength?, other types use the same fields as their send_*; when frozen it opens a window to play and refreezes after). game_wait: wait_for_node {path}, wait_for_property {path, property, value}. game_playtest: playtest.seed {seed:int}, playtest.fixed_delta {hz:int}, playtest.step {frames:int(1-60)}, playtest.snapshot/restore take no params. G1 control: playtest.freeze/unfreeze take no params, playtest.step_until {conditions:[{path:String,property:String,op:String(==/!=/</>/<=/>=),value:scalar/geometry}], max_frames?:int(1-600, default 600), wall_budget_ms?:int(1000-50000, default 30000)} |
| `timeout` | number |  | game_query/game_write/game_input/game_wait: timeout in ms (default 10000). For game_wait it is the budget of the whole polling window (probes repeatedly until the condition holds). send_input_sequence responds late; its timeout widens to wall_budget+10s automatically (max 65000) |
| `interval_ms` | number |  | game_wait only: polling interval in ms (default 200, range 50-2000). Applies to wait_for_node/wait_for_property only |
| `node_path` | string |  | monitor_start: node path to monitor (e.g. /root/Player) |
| `properties` | array |  | monitor_start: property names to monitor (e.g. ["position", "health"]) |
| `interval_frames` | number |  | monitor_start: sampling interval in frames (default 10, min 1, max 300) |
| `signal_name` | string |  | watch_start: signal name to listen for (e.g. "pressed", "health_changed") |
| `max_events` | number |  | watch_start: max events to record (default 1000, max 5000) |
| `push` | boolean |  | P3-6 watch_start/monitor_start: push mode (sends an MCP notification on each event/sample, no polling). The client must subscribe via resources/subscribe to receive them |
| `pattern` | string |  | find_ui_elements: name/text match pattern (Godot match syntax) |
| `type` | string |  | find_ui_elements: filter by type (e.g. "Button", "Label") |
| `visible_only` | boolean |  | find_ui_elements: visible elements only (default true) |
| `limit` | number |  | find_ui_elements: max results (default 200, max 500) |
| `text` | string |  | click_button: button text (or path) |
| `path` | string |  | click_button: button node path (or text) |
| `godot_path` | string |  | Override the Godot binary path (optional; takes precedence over project config and env vars) |

## Risk breakdown

read 11 / write 4 / process 2

---
<!-- AUTO-GENERATED by scripts/gen-tool-docs.mjs from capability-matrix.json v0.32.11. DO NOT edit manually; re-run npm run gen:tool-docs after tool changes. -->
