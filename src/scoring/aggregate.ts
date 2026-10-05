import type { DimensionName, DimensionResult, ScoreJson, HardFail } from './types.js';
import { WEIGHTS, HARD_FAILOUTS, PASS_LINE, NA_SCORE } from './dimensions.js';

/**
 * 纯函数:把 6 维标准化结果聚合成 ScoreJson。
 * - n/a 维度的权重按比例重分配给有值维度
 * - 任一硬否决维度低于红线 → pass=false(无视总分)
 * - total 保留一位小数
 * 无 IO,可单测。
 */
export function computeScore(
  dims: Record<DimensionName, DimensionResult>,
  meta: { godotVersion?: string; generatedAt: string },
): ScoreJson {
  const all = Object.keys(dims) as DimensionName[];
  const active = all.filter(k => dims[k].score !== NA_SCORE);
  const unverified = all.filter(k => dims[k].score === NA_SCORE);

  // 权重重分配:n/a 的权重补给有值维度
  const activeWeightSum = active.reduce((s, k) => s + WEIGHTS[k], 0);
  const total = activeWeightSum > 0
    ? active.reduce((s, k) => s + dims[k].score * (WEIGHTS[k] / activeWeightSum), 0)
    : 0;

  // 硬否决检测
  const hardFails: HardFail[] = [];
  for (const k of active) {
    const threshold = HARD_FAILOUTS[k];
    if (threshold !== undefined && dims[k].score < threshold) {
      hardFails.push({
        dimension: k,
        reason: `${k} scored ${dims[k].score}, below the hard veto line ${threshold}`,
        threshold,
        actual: dims[k].score,
      });
    }
  }

  const pass = hardFails.length === 0 && total >= PASS_LINE;

  return {
    total: Math.round(total * 10) / 10,
    pass,
    partial: unverified.length > 0,
    godotVersion: meta.godotVersion,
    generatedAt: meta.generatedAt,
    dimensions: dims,
    unverified,
    hardFails,
  };
}
