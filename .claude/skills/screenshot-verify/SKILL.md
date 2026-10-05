---
name: screenshot-verify
description: "visual verification loop, screenshot comparison, before/after evidence, take_screenshot, frame-verify, runtime_assert, screenshot_diff, render regression, GPU viewport, headless blank detection — use when an operation affected visuals, when you need to confirm the rendered result, or when you suspect a render regression"
---

## Visual verification loop (before/after evidence)

This skill is the visual verification primitive that other skills can reach for. Core rule: for any operation that affects visuals, screenshot before and after and compare.

**When to use**: after operations that affect visuals (scene tree / materials / animation / UI), when you need to confirm the rendered result, or suspect a render regression (headless blank / GPU lost).

**checklist**:
- [ ] 1. `screenshot(action=capture)` — screenshot before the operation (baseline evidence, note imagePath)
- [ ] 2. Make the change (edit_script / add_node / material edits etc.)
- [ ] 3. `screenshot(action=capture)` — screenshot after the operation (same viewport, same node)
- [ ] 4. `screenshot(action=analyze, detail=thumbnail)` — analyze the before and after images separately (thumbnail saves tokens), compare by eye or with the AI
- [ ] 5. For a programmatic assertion: `runtime_assert(action=screenshot_diff, reference=<baseline path>, project_path=<project path>, threshold=0.12, max_diff_ratio=0.05)` (threshold = per-pixel tolerance, a pixel counts only when its normalised RGB distance is strictly greater, smaller is stricter; max_diff_ratio = max share of differing pixels, 0 for strict pixel regression; qa suites can use the screenshot_diff assertion step directly)
- [ ] 6. Headless warning: if fileSize < 2048 or BLANK_DETECTED, use bridge take_screenshot (GPU viewport) instead

**Common deviations**:
- Screenshotting only after, not before (no baseline, can't compare for regressions)
- Reporting a headless blank as a bug (wrong: headless RendererDummy has no GPU rendering; blank 2D/3D is a known limitation, not a bug)
- Comparing with screenshot(action=analyze, detail=full) (wastes tokens: thumbnail is enough to see differences, full only when details matter)