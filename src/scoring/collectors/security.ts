import { readFileSync, existsSync, statSync } from 'fs';
import type { DimensionResult } from '../types.js';
import { WEIGHTS, NA_SCORE } from '../dimensions.js';

/** collector 读取的 CI artifact 最大字节(A1:防超大文件撑爆内存)。 */
const MAX_REPORT_BYTES = 10 * 1024 * 1024; // 10MB

/** npm audit --json v2 的 severity 计数 */
interface AuditVulnCounts {
  info?: number;
  low?: number;
  moderate?: number;
  high?: number;
  critical?: number;
  total?: number;
}
interface AuditReport {
  metadata?: { vulnerabilities?: AuditVulnCounts };
}

/** 各 severity 的扣分权重 */
const DEDUCTION: Record<keyof AuditVulnCounts, number> = {
  critical: 30,
  high: 10,
  moderate: 5,
  low: 2,
  info: 0,
  total: 0,
};

const SEV_FIELDS: Array<keyof AuditVulnCounts> = ['info', 'low', 'moderate', 'high', 'critical', 'total'];

/**
 * 解析 npm audit --json 产出,按漏洞 severity 加权扣分。
 * score = max(0, 100 - Σ(count × deduction));critical -30 / high -10 / moderate -5 / low -2 / info 0。
 * 状态分级:>=80 pass,[60,80) warn,<60 fail(对齐 security 硬否决线 60)。
 * 文件缺失 / 解析失败 / 无 metadata / 字段类型异常 / 超大 → na。
 */
export function collectSecurity(auditJsonPath: string): DimensionResult {
  if (!existsSync(auditJsonPath)) {
    return { score: NA_SCORE, weight: WEIGHTS.security, status: 'na', detail: `audit json does not exist: ${auditJsonPath}` };
  }
  const size = statSync(auditJsonPath).size;
  if (size > MAX_REPORT_BYTES) {
    return { score: NA_SCORE, weight: WEIGHTS.security, status: 'na', detail: `audit json too large: ${size} bytes > ${MAX_REPORT_BYTES}` };
  }
  let report: AuditReport;
  try {
    report = JSON.parse(readFileSync(auditJsonPath, 'utf8'));
  } catch (e) {
    return { score: NA_SCORE, weight: WEIGHTS.security, status: 'na', detail: `Failed to parse audit json: ${(e as Error).message}` };
  }
  const v = report.metadata?.vulnerabilities;
  if (!v) {
    return { score: NA_SCORE, weight: WEIGHTS.security, status: 'na', detail: 'audit json has no metadata.vulnerabilities' };
  }
  // A3:severity 字段存在但非有限数字 → 视为污染,na(防 'corrupt' 等非数字类型致扣分 NaN 传播)
  for (const k of SEV_FIELDS) {
    const val = v[k];
    if (val !== undefined && val !== null && (typeof val !== 'number' || !Number.isFinite(val))) {
      return { score: NA_SCORE, weight: WEIGHTS.security, status: 'na', detail: `audit json field ${String(k)} has the wrong type` };
    }
  }
  const counts = { info: v.info ?? 0, low: v.low ?? 0, moderate: v.moderate ?? 0, high: v.high ?? 0, critical: v.critical ?? 0 };
  const total = v.total ?? (counts.info + counts.low + counts.moderate + counts.high + counts.critical);
  const deduction =
    counts.critical * DEDUCTION.critical +
    counts.high * DEDUCTION.high +
    counts.moderate * DEDUCTION.moderate +
    counts.low * DEDUCTION.low;
  const score = Math.max(0, 100 - deduction);
  const status: DimensionResult['status'] = score >= 80 ? 'pass' : score >= 60 ? 'warn' : 'fail';
  return { score, weight: WEIGHTS.security, status, raw: { ...counts, total, deduction } };
}
