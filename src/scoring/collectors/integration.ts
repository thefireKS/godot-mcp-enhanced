import { readFileSync, existsSync, statSync } from 'fs';
import type { DimensionResult } from '../types.js';
import { WEIGHTS, NA_SCORE } from '../dimensions.js';

/** collector 读取的 CI artifact 最大字节(A1)。 */
const MAX_REPORT_BYTES = 10 * 1024 * 1024; // 10MB

/** vitest --reporter=json 产出的计数字段(只取需要的) */
interface VitestJsonReport {
  numTotalTests?: number;
  numPassedTests?: number;
  numFailedTests?: number;
  numPendingTests?: number;
}

const COUNT_FIELDS = ['numTotalTests', 'numPassedTests', 'numFailedTests', 'numPendingTests'] as const;

/**
 * 解析 vitest --reporter=json 产出,算真实集成通过率。
 * 通过率 = passed/(passed+failed)*100 —— 排除 pending(skip),因 skip 非"验证通过"也非"失败"。
 * passed+failed==0(全 skip,如本地无 Godot)→ na(无真实集成数据,不虚高分)。
 * 状态分级:>=80 pass,[60,80) warn,<60 fail(对齐 integration 硬否决线 80)。
 * 文件缺失 / 解析失败 / 字段类型异常 / 超大 → na。
 */
export function collectIntegration(jsonPath: string): DimensionResult {
  if (!existsSync(jsonPath)) {
    return { score: NA_SCORE, weight: WEIGHTS.integration, status: 'na', detail: `e2e json does not exist: ${jsonPath}` };
  }
  const size = statSync(jsonPath).size;
  if (size > MAX_REPORT_BYTES) {
    return { score: NA_SCORE, weight: WEIGHTS.integration, status: 'na', detail: `e2e json too large: ${size} bytes > ${MAX_REPORT_BYTES}` };
  }
  let report: VitestJsonReport;
  try {
    report = JSON.parse(readFileSync(jsonPath, 'utf8'));
  } catch (e) {
    return { score: NA_SCORE, weight: WEIGHTS.integration, status: 'na', detail: `Failed to parse e2e json: ${(e as Error).message}` };
  }
  // A3:计数字段存在但非有限数字 → 视为污染,na(防非数字类型致通过率 NaN 传播)
  for (const k of COUNT_FIELDS) {
    const val = (report as Record<string, unknown>)[k];
    if (val !== undefined && val !== null && (typeof val !== 'number' || !Number.isFinite(val))) {
      return { score: NA_SCORE, weight: WEIGHTS.integration, status: 'na', detail: `e2e json field ${k} has the wrong type` };
    }
  }
  const passed = report.numPassedTests ?? 0;
  const failed = report.numFailedTests ?? 0;
  const pending = report.numPendingTests ?? 0;
  const total = report.numTotalTests ?? (passed + failed + pending);
  const ran = passed + failed;
  if (ran === 0) {
    return {
      score: NA_SCORE, weight: WEIGHTS.integration, status: 'na',
      detail: 'All e2e tests skipped (no Godot?), no real integration data',
      raw: { passed, failed, pending, total },
    };
  }
  const pct = (passed / ran) * 100;
  const score = Math.round(pct * 10) / 10;
  const status: DimensionResult['status'] = score >= 80 ? 'pass' : score >= 60 ? 'warn' : 'fail';
  return { score, weight: WEIGHTS.integration, status, raw: { passed, failed, pending, total, ran } };
}
