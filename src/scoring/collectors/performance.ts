import { readFileSync, existsSync, statSync } from 'fs';
import type { DimensionResult, DimensionStatus } from '../types.js';
import { WEIGHTS, NA_SCORE, T_PASS_MS, T_WARN_MS } from '../dimensions.js';

/** collector 读取的 CI artifact 最大字节(A1)。 */
const MAX_REPORT_BYTES = 10 * 1024 * 1024; // 10MB

/**
 * 分段线性:≤T_PASS→100;T_PASS<≤T_WARN→线性100→60;>T_WARN→线性60→0 clamp。单位 ms。
 * warn→fail 段(60→0,跨度 T_WARN)退化比 pass→warn 段(100→60,跨度 T_WARN−T_PASS)宽——
 * 测试越慢扣分越缓,反映"测试慢是质量问题但非致命"(软扣分意图,ADVISORY 2)。
 */
function perfScore(ms: number): number {
  if (ms <= T_PASS_MS) return 100;
  if (ms <= T_WARN_MS) return 100 - (ms - T_PASS_MS) / (T_WARN_MS - T_PASS_MS) * 40;
  return Math.max(0, 60 - (ms - T_WARN_MS) / T_WARN_MS * 60);
}

/** 解析 vitest json → 全套 wall-clock(max endTime - min startTime,非 Σ duration)→ 绝对阈值分段线性。文件缺失/无字段/负值/超大 → na。 */
export function collectPerformance(reportPath: string): DimensionResult {
  if (!existsSync(reportPath))
    return { score: NA_SCORE, weight: WEIGHTS.performance, status: 'na', detail: `Report does not exist: ${reportPath}` };
  const size = statSync(reportPath).size;
  if (size > MAX_REPORT_BYTES)
    return { score: NA_SCORE, weight: WEIGHTS.performance, status: 'na', detail: `Report too large: ${size} bytes > ${MAX_REPORT_BYTES}` };
  let report: { testResults?: { startTime?: number; endTime?: number }[] };
  try { report = JSON.parse(readFileSync(reportPath, 'utf8')); }
  catch (e) { return { score: NA_SCORE, weight: WEIGHTS.performance, status: 'na', detail: `Parse failed: ${(e as Error).message}` }; }
  const files = report.testResults;
  if (!Array.isArray(files) || files.length === 0)
    return { score: NA_SCORE, weight: WEIGHTS.performance, status: 'na', detail: 'No testResults' };
  const starts = files.map(t => t.startTime).filter((x): x is number => typeof x === 'number');
  const ends = files.map(t => t.endTime).filter((x): x is number => typeof x === 'number');
  if (starts.length === 0 || ends.length === 0)
    return { score: NA_SCORE, weight: WEIGHTS.performance, status: 'na', detail: 'testResults missing startTime/endTime' };
  const wallclockMs = Math.max(...ends) - Math.min(...starts);
  if (wallclockMs < 0)
    return { score: NA_SCORE, weight: WEIGHTS.performance, status: 'na', detail: `Negative wall-clock: ${wallclockMs}` };
  const score = perfScore(wallclockMs);
  // 80/60 复制第4处(coverage 60/40 有意分化;integration/security/gdscript/performance 80/60);集中抽取 statusFromScore 待 N+1
  const status: DimensionStatus = score >= 80 ? 'pass' : score >= 60 ? 'warn' : 'fail';
  return { score, weight: WEIGHTS.performance, status, raw: { wallclockMs, testResults: files.length } };
}
