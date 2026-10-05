---
name: godot-mcp-bridge-e2e
description: "bridge e2e, runtime verification, game_bridge_install, run_project, wait_for_bridge, game_query ping, game_input, game_wait, take_screenshot, frame-verify, recording, regression tests, input simulation — use when you need to verify runtime behaviour, run E2E tests, simulate input or run regression tests"
---

## Runtime verification / E2E flow

Turns "install the bridge → start the game → connect → simulate input → keep evidence" into a checklist so no precondition is skipped. Tool details in `godot-mcp-bridge.md` and `godot-mcp-recording.md`.

**When to use**: to verify runtime behaviour, run E2E tests, simulate input, run regression tests, reproduce bugs.

**Checklist**:
- [ ] 1. `game_bridge_install(project_path)` — one-off install of the bridge autoload (port 9081, writes project.godot)
- [ ] 2. `run_project(project_path, wait_for_bridge=true)` — start the game and wait for the bridge (`bridge_timeout` default 10s)
- [ ] 3. `game_query(method="ping")` — confirm the connection (expect `status: "ok"`); if not connected check: not installed / game not running / secret permissions
- [ ] 4. Act + verify: simulate input with `game_input` (send_key/send_mouse_click/send_text) → wait for state changes with `game_wait` (wait_for_node/wait_for_property)
- [ ] 5. Keep evidence: `take_screenshot` (**real GPU viewport rendering**, not a blank headless one) / or `frame-verify` (anti-cheating degradation detection)

**Common deviations**:
- Forgetting `game_bridge_install` (query/input fail straight away with BRIDGE_NOT_CONNECTED)
- Querying before the game runs (the bridge only listens while the game runs)
- Using headless `screenshot` for runtime visual checks (headless uses RendererDummy, 2D/3D are blank) → use bridge `take_screenshot`
- Not using absolute node paths (the `path` of `game_write`/`game_wait` must start with `/root/`)
