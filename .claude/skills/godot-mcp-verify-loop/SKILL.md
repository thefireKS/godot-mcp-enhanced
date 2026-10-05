---
name: godot-mcp-verify-loop
description: "verification loop, run_and_verify, validate_scripts, verify_delivery, read_scene, edit_script, delivery gate, compilation, cross-file dependencies, parse error, scene tree integrity — use when you have changed code/scenes and need to verify, or to self-check before delivery"
---

## Change → run → verify loop

Turns "understand → change → run → compile check → delivery gate" into a checklist so you don't deliver after just one kind of check. Tool details in `godot-mcp-core.md`.

**When to use**: after changing code/scenes when you need to verify, or to self-check before delivery.

**Checklist**:
- [ ] 1. `read_scene` / `read_script` — understand the existing structure (property type resolution)
- [ ] 2. `edit_script` (**search_and_replace first**) / `write_script` — make the change
- [ ] 3. `run_and_verify(capture_tree=true)` — headless run + structured error analysis (recognises autoload-related headless_limitation automatically)
- [ ] 4. `validate_scripts` — triggers Godot's full `load()` compilation (including **cross-file dependencies**, catching Parse Errors a headless run misses)
- [ ] 5. `verify_delivery` — delivery gate (scene tree integrity + script health + performance + custom assertions + GDD compliance)

**Common deviations**:
- Running only `run_and_verify` without `validate_scripts` (misses cross-file compile errors — the two may disagree; trust the actual run of run_and_verify, but validate_scripts covers cross-file dependencies)
- Mistaking runtime tools (signal/tilemap/particles etc.) for persistent ones (lost when headless exits; persist with add_node + save_scene)
- Forgetting `_mcp_done()` (execute_gdscript snippet mode times out)
