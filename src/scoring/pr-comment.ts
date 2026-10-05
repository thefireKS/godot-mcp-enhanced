import type { ScoreJson } from './types.js';
import { NA_SCORE, DIM_ORDER } from './dimensions.js';
import { evaluateGate } from './gate.js';

const STATUS_ICON: Record<string, string> = { pass: '✅', warn: '⚠️', fail: '❌', na: '⊘ na' };

/**
 * 渲染 PR comment 摘要 markdown(比 score-report.md 简短,适合 PR 显示)。
 * 复用 evaluateGate 得 reasons(失败时渲染),避免与 gate 双真相源。
 * 头部含 partial 标注(verified/total);na 维 ⊘ na;未知 status 显示原值(fallback)。
 */
export function renderPrComment(score: ScoreJson): string {
  const { passed, reasons } = evaluateGate(score);
  const overall = passed ? '✅ PASS' : '❌ FAIL';
  const total = Object.keys(score.dimensions).length;
  const verified = total - score.unverified.length;
  const partialTag = score.partial ? `(the rest are pending in M3c-e)` : '';
  const lines: string[] = [];
  lines.push(`## 📊 Quality score: ${score.total} ${overall} · ${verified}/${total} dimensions verified${partialTag}`);
  lines.push('');
  if (!passed) {
    for (const r of reasons) lines.push(`- ${r}`);
    lines.push('');
  }
  lines.push('| Dimension | Score | Status |');
  lines.push('|---|---|---|');
  for (const name of DIM_ORDER) {
    const d = score.dimensions[name];
    const s = d.score === NA_SCORE ? '—' : String(d.score);
    lines.push(`| ${name} | ${s} | ${STATUS_ICON[d.status] ?? d.status} |`);
  }
  lines.push('');
  return lines.join('\n');
}
