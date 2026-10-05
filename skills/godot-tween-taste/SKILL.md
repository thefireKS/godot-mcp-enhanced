---
name: godot-tween-taste
description: "Tween motion taste audit, create_tween, tween_property, set_trans, set_ease, TRANS types, Ease direction, duration, bounce, stutter, wrong direction, read-only, self-contained fix plan, advisor — use when working with Tweener, when Tween motion feels off (stutter / no bounce / wrong direction), or to audit Tween quality. For a one-line Tween value change, edit_script is enough"
---

## Tween motion taste audit (advisor-worker mode)

This skill is an advisor (reads, never edits source): it scans Tween calls, audits them for taste and produces self-contained fix plans for a worker. Borrows the 4-phase workflow of emilkowalski's improve-animations.

**When to use**: Tween motion feels "off" (stutter / no bounce / wrong direction / stiff), a batch audit of Tween quality, or to confirm TRANS/Ease choices when using Tweener.

**Phase 1 — Recon (read-only, map the Tweens)**:
- [ ] 1. `read_scene` + grep `create_tween|tween_property|set_trans|set_ease` to find every Tween call
- [ ] 2. Record each: file:line + TRANS type + Ease direction + duration + target property

**Phase 2 — Audit (7 categories, return only file:line + evidence)**:
- [ ] 3. TRANS_LINEAR used for UI animation (stiff, switch to TRANS_SINE/QUAD)
- [ ] 4. Missing Ease (the default ease_in_out may be wrong; UI entrances want ease_out)
- [ ] 5. Duration < 0.1s (too fast to see) or > 1.0s (too slow, drags)
- [ ] 6. Missing parallel() (several Tweens should run in parallel but run in sequence)
- [ ] 7. Tween never killed (leaks after scene change; connect tree_exited)

**Phase 3 — Vet & prioritize (drop false positives)**:
- [ ] 8. Re-read every finding, drop by-design ones (e.g. a LoadingScreen using LINEAR on purpose)
- [ ] 9. Sort by leverage (bigger impact on the player experience first)

**Phase 4 — Write plans (self-contained fix plans)**:
- [ ] 10. One plan per finding with exact values inline (e.g. "TRANS_LINEAR → TRANS_SINE, Ease In → Ease Out, 0.05s → 0.3s")
- [ ] 11. Hand the plans to a worker (any agent), who fixes them one by one with edit_script

**Common deviations**:
- The advisor edits source directly (out of bounds: the advisor is read-only, editing is the worker's job)
- Plans with vague instructions (drift: exact values inline are required, no "use a softer easing")
- Reporting by-design choices as bugs (noise: vet out deliberate trade-offs first)