import { readFileSync, existsSync, statSync } from 'fs';
import type { DimensionResult, DimensionStatus, GdscriptReport } from '../types.js';
import { WEIGHTS, NA_SCORE, WARN_PENALTY } from '../dimensions.js';

/** collector 读取的 CI artifact 最大字节(A1)。 */
const MAX_REPORT_BYTES = 10 * 1024 * 1024; // 10MB

/**
 * 解析 check-gdscript 产出的 report.json。三态:
 *  - report 不存在/坏 JSON/缺字段 → na(环境降级,不卡 gate)
 *  - incomplete(check-gdscript 断言失败) → score=0(<60 硬否决卡 gate),优先于 errors
 *  - 正常 → errors 归零硬否决 / warnings×WARN_PENALTY 渐进
 * errors 归零(布尔:有错 addon 不可用);梯度制造虚假精度,errors 数量在 raw 保留诊断。
 */
export function collectGdscript(reportPath: string): DimensionResult {
  if (!existsSync(reportPath)) {
    return { score: NA_SCORE, weight: WEIGHTS.gdscript, status: 'na',
             detail: `Report does not exist: ${reportPath}` };
  }
  const size = statSync(reportPath).size;
  if (size > MAX_REPORT_BYTES) {
    return { score: NA_SCORE, weight: WEIGHTS.gdscript, status: 'na',
             detail: `Report too large: ${size} bytes > ${MAX_REPORT_BYTES}` };
  }
  let report: GdscriptReport;
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch (e) {
    return { score: NA_SCORE, weight: WEIGHTS.gdscript, status: 'na',
             detail: `Failed to parse report: ${(e as Error).message}` };
  }

  // incomplete 优先于 errors/warnings:检查不完整则 errors 不可信
  if (report.incomplete) {
    return { score: 0, weight: WEIGHTS.gdscript, status: 'fail',
             detail: `Check incomplete: ${report.reason ?? 'setup failed'}`,
             raw: { errors: 0, warnings: 0, files: report.files ?? 0,
                    details: [], detailsTotal: 0, incomplete: true } };
  }

  if (typeof report.errors !== 'number' || typeof report.warnings !== 'number') {
    return { score: NA_SCORE, weight: WEIGHTS.gdscript, status: 'na',
             detail: 'Report is missing the errors/warnings fields' };
  }

  const { errors, warnings } = report;
  const score = errors >= 1 ? 0 : Math.max(0, 100 - warnings * WARN_PENALTY);
  // 80/60,与 security/integration 一致;集中抽取待 N+1 collector
  const status: DimensionStatus = score >= 80 ? 'pass' : score >= 60 ? 'warn' : 'fail';
  return { score, weight: WEIGHTS.gdscript, status,
           raw: { errors, warnings, files: report.files ?? 0,
                  details: report.details ?? [], detailsTotal: errors + warnings } };
}
