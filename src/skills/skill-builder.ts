// src/skills/skill-builder.ts
// 从 rule-templates.ts 的 workflow 模板派生 Claude Code SKILL.md（仓库自身开发用）
// 单一内容源 = DETAILED_RULE_TEMPLATES 的 3 个 workflow 模板；改 workflow 只改 rule-templates.ts
// 然后跑 npm run build:skills 重生成 .claude/skills/<name>/SKILL.md

import { DETAILED_RULE_TEMPLATES } from '../tools/rule-templates.js';

/** workflow 模板 key → skill name 映射（去 workflow- 中缀，verify 特例 -loop） */
export const WORKFLOW_TO_SKILL: Record<string, string> = {
  'godot-mcp-workflow-bridge-e2e.md': 'godot-mcp-bridge-e2e',
  'godot-mcp-workflow-verify.md': 'godot-mcp-verify-loop',
  'godot-mcp-workflow-safe-edit.md': 'godot-mcp-safe-edit',
};

// ─── Tier2-1: 手写 skill（非派生）──────────────────────────────────────────
// 借鉴 mattpocock 路由器/原语 + emilkowalski advisor-worker，性质非 workflow，
// 走手写路径不套 workflow 模板。所有 skill 保持 model-invoked（不加 disable-model-invocation，
// 因 Claude Code 该 flag 有已知 bug issue #43809/#77740，可能完全不可用）。

const GODOT_ROUTER_SKILL = `---
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
- [ ] E2E tests / simulated input / regression tests → \`godot-mcp-bridge-e2e\`
- [ ] Animation/motion feels off (stutter / no bounce / wrong direction) → \`godot-tween-taste\`
- [ ] Visual verification (before/after screenshots) → \`screenshot-verify\`
- [ ] Safe editing (.gd/.tscn changes) → \`godot-mcp-safe-edit\`
- [ ] Self-check before delivery → \`godot-mcp-verify-loop\`

**When not to use a skill**:
- One-line .gd change → \`edit_script\` directly
- Read-only exploration (looking at scene structure) → \`read_scene\` / \`game_query\` directly
- A single screenshot → \`screenshot\` directly

**Common deviations**:
- Routing every operation through the router (overkill: call tools directly for simple operations, use the router only when unsure)
- Not verifying after routing (gap: even when the router dispatches, finish with verify-loop or screenshot-verify)`;

const SCREENSHOT_VERIFY_SKILL = `---
name: screenshot-verify
description: "visual verification loop, screenshot comparison, before/after evidence, take_screenshot, frame-verify, runtime_assert, screenshot_diff, render regression, GPU viewport, headless blank detection — use when an operation affected visuals, when you need to confirm the rendered result, or when you suspect a render regression"
---

## Visual verification loop (before/after evidence)

This skill is the visual verification primitive that other skills can reach for. Core rule: for any operation that affects visuals, screenshot before and after and compare.

**When to use**: after operations that affect visuals (scene tree / materials / animation / UI), when you need to confirm the rendered result, or suspect a render regression (headless blank / GPU lost).

**checklist**:
- [ ] 1. \`screenshot(action=capture)\` — screenshot before the operation (baseline evidence, note imagePath)
- [ ] 2. Make the change (edit_script / add_node / material edits etc.)
- [ ] 3. \`screenshot(action=capture)\` — screenshot after the operation (same viewport, same node)
- [ ] 4. \`screenshot(action=analyze, detail=thumbnail)\` — analyze the before and after images separately (thumbnail saves tokens), compare by eye or with the AI
- [ ] 5. For a programmatic assertion: \`runtime_assert(action=screenshot_diff, reference=<baseline path>, project_path=<project path>, threshold=0.12, max_diff_ratio=0.05)\` (threshold = per-pixel tolerance, a pixel counts only when its normalised RGB distance is strictly greater, smaller is stricter; max_diff_ratio = max share of differing pixels, 0 for strict pixel regression; qa suites can use the screenshot_diff assertion step directly)
- [ ] 6. Headless warning: if fileSize < 2048 or BLANK_DETECTED, use bridge take_screenshot (GPU viewport) instead

**Common deviations**:
- Screenshotting only after, not before (no baseline, can't compare for regressions)
- Reporting a headless blank as a bug (wrong: headless RendererDummy has no GPU rendering; blank 2D/3D is a known limitation, not a bug)
- Comparing with screenshot(action=analyze, detail=full) (wastes tokens: thumbnail is enough to see differences, full only when details matter)`;

const GODOT_TWEEN_TASTE_SKILL = `---
name: godot-tween-taste
description: "Tween motion taste audit, create_tween, tween_property, set_trans, set_ease, TRANS types, Ease direction, duration, bounce, stutter, wrong direction, read-only, self-contained fix plan, advisor — use when working with Tweener, when Tween motion feels off (stutter / no bounce / wrong direction), or to audit Tween quality. For a one-line Tween value change, edit_script is enough"
---

## Tween motion taste audit (advisor-worker mode)

This skill is an advisor (reads, never edits source): it scans Tween calls, audits them for taste and produces self-contained fix plans for a worker. Borrows the 4-phase workflow of emilkowalski's improve-animations.

**When to use**: Tween motion feels "off" (stutter / no bounce / wrong direction / stiff), a batch audit of Tween quality, or to confirm TRANS/Ease choices when using Tweener.

**Phase 1 — Recon (read-only, map the Tweens)**:
- [ ] 1. \`read_scene\` + grep \`create_tween|tween_property|set_trans|set_ease\` to find every Tween call
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
- Reporting by-design choices as bugs (noise: vet out deliberate trade-offs first)`;

/**
 * 手写 skill（非派生）。key = skill name，value = 完整 SKILL.md 内容（含 frontmatter）。
 * Tier2-1: 性质非 workflow（路由器/原语/advisor），走手写路径不套 workflow 模板。
 */
export const HANDWRITTEN_SKILLS: Map<string, string> = new Map([
  ['godot-router', GODOT_ROUTER_SKILL],
  ['screenshot-verify', SCREENSHOT_VERIFY_SKILL],
  ['godot-tween-taste', GODOT_TWEEN_TASTE_SKILL],
]);

/**
 * 从单个 workflow 模板派生 SKILL.md 内容（纯函数）。
 *
 * 派生规则：
 * 1. 剥 rule frontmatter（首部 ---\n...\n---\n，含 description + alwaysApply）
 * 2. 提取 description 引号内纯文本（rule-templates.ts 的 description 形如 description: "..."）
 * 3. 剃到首个 ## 标题前的所有内容（版本引用行 > 适用于 ... {{MCP_VERSION}}+ + 紧随空行）
 * 4. 组装 SKILL.md：---\nname: <skillName>\ndescription: "<纯文本>"\n---\n\n<正文从 ## 起>
 *    （description 重新包双引号；正文不加 H1，从 rule 的 H2 起）
 */
export function deriveSkillFromWorkflow(tpl: string, skillName: string): string {
  // 1. 剥 rule frontmatter
  const fmMatch = tpl.match(/^---\n([\s\S]*?)\n---\n/);
  if (!fmMatch) throw new Error(`skill-builder: the workflow template of ${skillName} is missing the rule frontmatter (---...---)`);
  const frontmatter = fmMatch[1]!;
  const afterFm = tpl.slice(fmMatch[0].length);

  // 2. 提取 description 引号内纯文本
  const descMatch = frontmatter.match(/^description:\s*"([\s\S]*?)"\s*$/m);
  if (!descMatch) throw new Error(`skill-builder: the workflow frontmatter of ${skillName} is missing a (quoted) description`);
  const description = descMatch[1]!;

  // 3. 剃到首个 ## 前（版本引用行 + 空行）
  const h2Idx = afterFm.search(/^##\s/m);
  if (h2Idx === -1) throw new Error(`skill-builder: the workflow template of ${skillName} is missing a ## heading`);
  const body = afterFm.slice(h2Idx);

  // 4. 组装（description 重新包引号，不加 H1）
  return `---\nname: ${skillName}\ndescription: "${description}"\n---\n\n${body}`;
}

/** 遍历所有 skill（派生 + 手写），返回 skill name → SKILL.md 内容。 */
export function buildAllSkills(): Map<string, string> {
  const result = new Map<string, string>();
  // 派生 skill（现有 3 个，从 rule-templates.ts workflow 模板派生）
  for (const [workflowKey, skillName] of Object.entries(WORKFLOW_TO_SKILL)) {
    const tpl = DETAILED_RULE_TEMPLATES[workflowKey];
    if (!tpl) throw new Error(`skill-builder: DETAILED_RULE_TEMPLATES has no workflow template ${workflowKey}`);
    result.set(skillName, deriveSkillFromWorkflow(tpl, skillName));
  }
  // 手写 skill（Tier2-1 新增 3 个：路由器/原语/advisor）
  for (const [name, content] of HANDWRITTEN_SKILLS) {
    result.set(name, content);
  }
  return result;
}
