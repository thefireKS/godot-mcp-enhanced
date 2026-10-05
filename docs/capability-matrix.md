# Capability Matrix

> Auto-generated, do not edit. Produced by `npm run build-matrix`; drift detection via `npm run diff-matrix`.

## Overview
- Total tools: 45
- securityLevel: danger-api 11 / guarded 23 / safe 11
- risk: read 124 / write 98 / destructive 10 / process 16
- L2 coverage: covered 0 / partial 0 / none 45
- Token budget: tools/list ≈ 96950B / ~24238 tokens (description 17713B / schema 79237B, schema is 82%)
- annotations: readOnly 10 / destructive 5 / idempotent 13
> Note: marked read but actually spawn processes / have side effects (deliberately trusted, no confirmation): `validation.run_and_verify`, `validation.verify_delivery`

## danger-api tools (L2 security regression first)
- `audit` (core)
- `godot_get_context` (core)
- `help` (core)
- `manage_tools` (core)
- `project` (core)
- `runtime` (core)
- `runtime_assert` (core)
- `scene` (core)
- `script` (core)
- `ui` (ui)
- `validation` (core)

## Coverage gaps (L2=none)
- `analysis` (code)
- `android` (android)
- `animation` (animation)
- `animation_track` (animation)
- `animtree` (animation)
- `asset` (asset)
- `audio` (audio)
- `audit` (core)
- `blender` (blender)
- `cpp` (code)
- `csv_to_resources` (unknown)
- `debug` (debug)
- `docs` (code)
- `editor` (editor)
- `engine` (engine)
- `game` (bridge)
- `godot_advanced_tool` (dynamic)
- `godot_get_context` (core)
- `godot_list_dynamic_routes` (dynamic)
- `godot_list_instances` (multi_instance)
- `godot_select_instance` (multi_instance)
- `help` (core)
- `load_skill` (code)
- `manage_tools` (core)
- `material` (visual)
- `nav` (navigation)
- `particles` (visual)
- `physics` (physics)
- `profiler` (profiler)
- `project` (core)
- `qa` (bridge)
- `runtime` (core)
- `runtime_assert` (core)
- `scene` (core)
- `screenshot` (visual)
- `script` (core)
- `self_update` (selfupdate)
- `signal` (signal)
- `testing` (unknown)
- `tilemap` (tilemap)
- `translation` (resources)
- `ui` (ui)
- `uid` (resources)
- `validation` (core)
- `workflow` (profiler)

## Scope decisions (explicitly out of scope)
The following categories were evaluated (competitor sweep, 2026-08-19) and are deliberately **not done**, not overlooked:
- **VisualShader graph editing** (yanhuifair: 8 tools / 40+ node types): the VisualShader node graph is a heavily interactive editor domain; text property paths (editing `VisualShaderNode*` properties) + the material/shader tools already cover most procedural material needs; maintaining graph-level orchestration (node type matrix × Godot versions) costs far more than it gives. Alternative: the `material` tool (shader_read/write/load/save_file) + dynamic construction via `execute_gdscript`.

## gdScriptImpl notes
- editor side: addons/godot_mcp_server/commands/*_commands.gd matched by group
- headless side: always exists=false (GDScript is generated at runtime by gdscript-executor, no static 1:1 file)
- editor side: exact routing by tool command (EDITOR_COMMAND_ROUTING, from the command_handler.gd handle() routing table)

## Token budget TOP 5
- `game` (bridge): desc 1240B / schema 6743B / total 7983B
- `ui` (ui): desc 1651B / schema 4909B / total 6560B
- `scene` (core): desc 274B / schema 6043B / total 6317B
- `workflow` (profiler): desc 228B / schema 4237B / total 4465B
- `screenshot` (visual): desc 269B / schema 3941B / total 4210B