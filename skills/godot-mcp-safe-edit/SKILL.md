---
name: godot-mcp-safe-edit
description: "safe editing, edit_script, search_and_replace, validate_scripts, confirmation tokens, remove_node, headless disk writes, editor overwrite, sandbox, misuse protection, CRLF, tab indentation — use when editing .gd/.tscn, deleting nodes or running dangerous operations"
---

## Safe editing flow

Protective checklist for editing `.gd`/`.tscn`, deleting nodes and running dangerous operations. Tool details in `godot-mcp-core.md` and `godot-mcp-editor.md`.

**When to use**: editing `.gd`/`.tscn`, deleting nodes, running dangerous operations.

**Checklist**:
- [ ] 1. `edit_script` **with search_and_replace first** (content matching, survives line shifts, CRLF-safe, no confirmation token); **never edit .gd with the built-in Edit tool** (tab indentation rarely matches)
- [ ] 2. Always run `validate_scripts` after changing a `.gd` (syntax check)
- [ ] 3. Headless disk write + the editor has the same scene open → Ctrl+S overwrite risk: reload the scene in the editor or close it before continuing
- [ ] 4. Dangerous operations (`remove_node` etc.) need an explicit confirmation token
- [ ] 5. The GDScript sandbox is **a guard against misuse, not against adversaries** (indirect construction gets past it; real isolation needs a container/VM + `GODOT_MCP_ALLOW_UNSAFE=false`)
- [ ] 6. `write_script`/`edit_script` also sandbox-scan before writing a .gd (same threat surface as `execute_gdscript`; known dangerous API patterns (including @tool run-on-load etc., list not published so it can't be probed) are blocked with SANDBOX_VIOLATION; double opt-in bypass `UNRESTRICTED + DISABLE_SAFETY`)

**Common deviations**:
- Editing a `.gd` with the built-in Edit tool (tab indentation fails)
- Not validating after changes
- After a headless disk write, the editor's old version overwrites it on Ctrl+S (MCP can't control it, reload first)
