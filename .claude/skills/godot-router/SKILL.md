---
name: godot-router
description: "godot-mcp skill router: unsure which flow, entry ramp, decision tree, E2E, safe editing, verification loop, animation audit — use when you are unsure which godot-mcp flow fits, or need to dispatch a task to a specific sub-flow. Don't use this skill for simple single-tool operations (one-line edit / single screenshot); call the tool directly"
---

## godot-mcp flow routing

This skill is the router of the godot-mcp skill set. When you are unsure which flow to use, dispatch with the decision tree below.

**When to use**: the request is vague (e.g. "change the scene for me", "check it"), or a task spans several skills.

**Main flow (idea → deliverable)**:
- [ ] 1. Changing code/scenes → screenshot-verify first for evidence, then edit with godot-mcp-safe-edit, finish with godot-mcp-verify-loop
- [ ] 2. Unsure how to change it → read real runtime values with the game tool's game_query action instead of guessing on paper
- [ ] 3. Creating many nodes/files → use the batch path of godot-mcp-safe-edit

**Entry ramps (by task type)**:
- [ ] E2E tests / simulated input / regression tests → `godot-mcp-bridge-e2e`
- [ ] Animation/motion feels off (stutter / no bounce / wrong direction) → `godot-tween-taste`
- [ ] Visual verification (before/after screenshots) → `screenshot-verify`
- [ ] Safe editing (.gd/.tscn changes) → `godot-mcp-safe-edit`
- [ ] Self-check before delivery → `godot-mcp-verify-loop`

**When not to use a skill**:
- One-line .gd change → `edit_script` directly
- Read-only exploration (looking at scene structure) → `read_scene` / `game_query` directly
- A single screenshot → `screenshot` directly

**Common deviations**:
- Routing every operation through the router (overkill: call tools directly for simple operations, use the router only when unsure)
- Not verifying after routing (gap: even when the router dispatches, finish with verify-loop or screenshot-verify)