import { readFileSync, existsSync, statSync } from 'fs';
import type { DimensionResult } from '../types.js';
import { WEIGHTS, NA_SCORE } from '../dimensions.js';

/** collector 读取的 CI artifact 最大字节(A1:防超大文件撑爆内存)。 */
const MAX_REPORT_BYTES = 10 * 1024 * 1024; // 10MB

/**
 * 解析 lcov.info,按 DA: 行(line data)算语句命中率。
 * 状态分级:>=60 pass,[40,60) warn,<40 fail。
 * 文件缺失/无 DA 行/超大 → na。
 */
export function collectCoverage(lcovPath: string): DimensionResult {
  if (!existsSync(lcovPath)) {
    return {
      score: NA_SCORE,
      weight: WEIGHTS.coverage,
      status: 'na',
      detail: `lcov does not exist: ${lcovPath}`,
    };
  }
  const size = statSync(lcovPath).size;
  if (size > MAX_REPORT_BYTES) {
    return { score: NA_SCORE, weight: WEIGHTS.coverage, status: 'na', detail: `lcov too large: ${size} bytes > ${MAX_REPORT_BYTES}` };
  }
  const text = readFileSync(lcovPath, 'utf8');
  let found = 0;
  let hit = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('DA:')) {
      const parts = line.slice(3).split(',');
      found++;
      if (Number(parts[1]) > 0) hit++;
    }
  }
  if (found === 0) {
    return {
      score: NA_SCORE,
      weight: WEIGHTS.coverage,
      status: 'na',
      detail: 'lcov has no DA lines',
    };
  }
  const pct = (hit / found) * 100;
  const score = Math.round(pct * 10) / 10;
  const status: DimensionResult['status'] = score >= 60 ? 'pass' : score >= 40 ? 'warn' : 'fail';
  return { score, weight: WEIGHTS.coverage, status, raw: { hit, found, pct } };
}
