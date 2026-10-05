import type { ScoreJson } from './types.js';
import { NA_SCORE, DIM_ORDER } from './dimensions.js';
import { dimMetric } from './metric.js';

const STATUS_BADGE: Record<string, string> = {
  pass: '✅ pass',
  warn: '⚠️ warn',
  fail: '❌ fail',
  na: '⊘ na',
};

/** 转义 markdown 表格/行内代码元字符,防采集内容破坏表格结构或注入代码块(A2,对齐 html.ts escapeHtml)。 */
function escapeMarkdown(s: unknown): string {
  return String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/`/g, '\\`');
}

/**
 * 渲染 score.json → 人读 markdown。
 * 头部时间取自 score.generatedAt(不重复 new Date(),保证与 score 时间一致)。
 * 容错:未知 status 显示原值;raw 缺失显示 "—"。
 * 所有外部插值经 escapeMarkdown 转义,防 | 破坏表格、` 注入代码块(A2)。
 */
export function renderScoreReport(score: ScoreJson): string {
  const overall = score.pass ? '✅ PASS' : '❌ FAIL';
  const total = Object.keys(score.dimensions).length;
  const verified = total - score.unverified.length;
  const lines: string[] = [];
  lines.push('# Quality score report');
  lines.push('');
  lines.push(`**Total ${score.total} / 100**  ${overall}  (partial: ${verified}/${total} dimensions verified)  · ${score.generatedAt}`);
  lines.push('');
  lines.push('## Dimensions');
  lines.push('');
  lines.push('| Dimension | Score | Weight | Status | Key metrics |');
  lines.push('|---|---|---|---|---|');
  for (const name of DIM_ORDER) {
    const d = score.dimensions[name];
    const scoreCell = d.score === NA_SCORE ? '—' : String(d.score);
    lines.push(`| ${escapeMarkdown(name)} | ${escapeMarkdown(scoreCell)} | ${escapeMarkdown(d.weight)} | ${escapeMarkdown(STATUS_BADGE[d.status] ?? d.status)} | ${escapeMarkdown(dimMetric(name, d))} |`);
  }
  lines.push('');
  lines.push('## Hard vetoes');
  if (score.hardFails.length === 0) {
    lines.push('(none)');
  } else {
    for (const hf of score.hardFails) {
      lines.push(`- ${escapeMarkdown(hf.dimension)}: ${escapeMarkdown(hf.reason)}(${hf.actual} < ${hf.threshold})`);
    }
  }
  lines.push('');
  lines.push('## Unverified dimensions');
  if (score.unverified.length === 0) {
    lines.push('(none)');
  } else {
    lines.push(score.unverified.map(escapeMarkdown).join(', ') + ' — wired in M3c-e');
  }
  lines.push('');
  return lines.join('\n');
}
