import type { DimensionName, DimensionResult } from './types.js';
import { NA_SCORE } from './dimensions.js';

export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** 按维度从 raw 提取"关键指标";na 维返回"未接入",raw 缺失返回 "—" */
export function dimMetric(name: DimensionName, d: DimensionResult): string {
  if (d.score === NA_SCORE || d.status === 'na') return 'Not wired';
  const raw = d.raw as Record<string, number> | undefined;
  if (!raw) return '—';
  switch (name) {
    case 'integration':
      return `${raw.passed ?? 0}/${raw.ran ?? 0} passed`;
    case 'coverage':
      return `${round1(raw.pct ?? 0)}% (${raw.hit ?? 0}/${raw.found ?? 0})`;
    case 'security':
      return `${(raw.high ?? 0) + (raw.critical ?? 0)} high/critical (-${raw.deduction ?? 0})`;
    case 'gdscript':
      return `${raw.errors ?? 0} err / ${raw.warnings ?? 0} warn`;
    case 'performance':
      return `${round1((raw.wallclockMs ?? 0) / 1000)}s`;
    default:
      return '—';
  }
}
