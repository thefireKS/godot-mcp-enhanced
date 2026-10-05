import type { ScoreJson } from './types.js';
import { PASS_LINE } from './dimensions.js';

export interface GateResult {
  passed: boolean;
  reasons: string[];
}

/**
 * 门禁判定:total 为有效有限数且 ≥PASS_LINE、且无硬否决 → passed。
 * 直接判 score.total < PASS_LINE(而非聚合 score.pass),以区分"总分不足"与"硬否决"两种 fail 原因。
 * NaN/Infinity total → fail-closed(A4:防 aggregate 计算异常时 NaN<PASS 为 false 而 fail-open 放行)。
 * partial(unverified/na 维)不影响 passed——只进报告,不阻断(M3c-e 接入前避免永远卡门禁)。
 */
export function evaluateGate(score: ScoreJson): GateResult {
  const reasons: string[] = [];
  if (!Number.isFinite(score.total)) {
    reasons.push(`Invalid total score (${score.total}) — gate fails closed`);
  } else if (score.total < PASS_LINE) {
    reasons.push(`Total score ${score.total} < ${PASS_LINE} (pass line)`);
  }
  for (const hf of score.hardFails) {
    reasons.push(`Hard veto ${hf.dimension}: ${hf.reason} (${hf.actual} < ${hf.threshold})`);
  }
  return { passed: reasons.length === 0, reasons };
}
