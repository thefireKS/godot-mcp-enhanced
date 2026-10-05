// src/tools/qa/registry.ts — QA run 注册表(PR-1b 应用级异步;PR-2 tasks 层的单一事实源)
//
// 词汇对齐 SEP-1686 task lifecycle:status = working|completed|failed|cancelled,
// taskId = 报告 run_id(单一标识)。内存 Map + 惰性 TTL 清扫(不起常驻 timer,
// get/list 时顺带清过期终态;server 重启即丢,status 查不到时引导读落盘报告)。
// 并发约束:全局同一时刻仅 1 个 working run(bridge 单连接 + watch/monitor 单订阅槽,
// 并行 run 必互踩)——registerRun 对 working 互斥,抛 QaBusyError。

import type { QaReport } from './report.js';

export type QaRunStatus = 'working' | 'completed' | 'failed' | 'cancelled';

export interface RunRecord {
  taskId: string;
  status: QaRunStatus;
  suite_name: string;
  project_path: string;
  createdAt: string;
  lastUpdatedAt: string;
  /** 终态保留时长(ms,默认 1h);透传 wire TaskStatusNotificationParams.ttl 时按目标单位换算 */
  ttl: number;
  progress: { step: number; total: number; current?: string };
  /** 内部字段,不出 wire */
  cancelRequested: boolean;
  /** 内部字段,不出 wire;close 收尾 await 用 */
  done?: Promise<void>;
  report?: QaReport;
  reportPaths?: { json_path: string; md_path: string };
  /** 终态失败原因(PR-1b M-8);finishRun 尾参写入 */
  error?: string;
}

const DEFAULT_TTL_MS = 3_600_000;
const registry = new Map<string, RunRecord>();

export class QaBusyError extends Error {
  readonly currentRunId: string;
  constructor(currentRunId: string) {
    super(`A QA run is already in progress (${currentRunId}); the single bridge connection allows only 1 run at a time — poll it with qa status until it finishes, or cancel it with qa cancel`);
    this.name = 'QaBusyError';
    this.currentRunId = currentRunId;
  }
}

function isTerminal(r: RunRecord): boolean {
  return r.status !== 'working';
}

function sweepExpired(): void {
  for (const [id, r] of registry) {
    if (isTerminal(r) && Date.now() - Date.parse(r.lastUpdatedAt) > r.ttl) registry.delete(id);
  }
}

export function registerRun(runId: string, suiteName: string, projectPath: string, stepsTotal: number): RunRecord {
  const working = activeWorkingRun();
  if (working) throw new QaBusyError(working.taskId);
  const now = new Date().toISOString();
  const rec: RunRecord = {
    taskId: runId, status: 'working',
    suite_name: suiteName, project_path: projectPath,
    createdAt: now, lastUpdatedAt: now, ttl: DEFAULT_TTL_MS,
    progress: { step: 0, total: stepsTotal },
    cancelRequested: false,
  };
  registry.set(runId, rec);
  return rec;
}

export function getRun(runId: string): RunRecord | undefined {
  sweepExpired();
  return registry.get(runId);
}

export function listRuns(): RunRecord[] {
  sweepExpired();
  return [...registry.values()];
}

export function activeWorkingRun(): RunRecord | undefined {
  for (const r of registry.values()) if (r.status === 'working') return r;
  return undefined;
}

export function requestCancel(runId: string): { ok: boolean; message?: string } {
  const r = registry.get(runId);
  if (!r) return { ok: false, message: `run_id is not in the run registry (the server may have restarted); try qa report "${runId}" to read the saved report` };
  if (r.status !== 'working') return { ok: false, message: `run already finished (${r.status}), cannot cancel` };
  r.cancelRequested = true;
  r.lastUpdatedAt = new Date().toISOString();
  return { ok: true };
}

/** 终态通知钩子(PR-2 tasks wire):finishRun 到终态时回调(发 notifications/tasks/status 用)。
 * null = 注销。回调抛异常 best-effort 吞掉(记日志由调用方包装),不影响状态写入。 */
let terminalNotifier: ((runId: string, status: 'completed' | 'failed' | 'cancelled') => void) | null = null;

export function setTerminalNotifier(fn: ((runId: string, status: 'completed' | 'failed' | 'cancelled') => void) | null): void {
  terminalNotifier = fn;
}

export function finishRun(
  runId: string,
  status: 'completed' | 'failed' | 'cancelled',
  report?: QaReport,
  reportPaths?: { json_path: string; md_path: string },
  error?: string,
): void {
  const r = registry.get(runId);
  if (!r) return;
  r.status = status;
  r.lastUpdatedAt = new Date().toISOString();
  if (report) r.report = report;
  if (reportPaths) r.reportPaths = reportPaths;
  if (error !== undefined) r.error = error;
  if (terminalNotifier) {
    try { terminalNotifier(runId, status); } catch { /* best-effort:通知失败不影响注册表 */ }
  }
}

export function updateProgress(runId: string, step: number, total: number, current?: string): void {
  const r = registry.get(runId);
  if (!r || r.status !== 'working') return;
  r.progress = current !== undefined ? { step, total, current } : { step, total };
  r.lastUpdatedAt = new Date().toISOString();
}

export function clearRegistry(): void {
  registry.clear();
}

/**
 * close 优雅收尾:对 working run 置取消并等待 settle(报告落 CANCELLED + 录制证据落盘),
 * 供 GodotServer.close 的 safeStep 序列调用。超时放弃等——killProcess 进程级兜底已有,不重复。
 *
 * 等待上限:spec §2.4 原文 = suite_budget_ms,registry 无 budget 字段,近似取 min(maxWaitMs, ttl)。
 * settled 判定可靠性:done settle 意味着 finishRun 已执行(done = exec.then(...),finishRun
 * 在 exec 的 then/catch 回调内、先于 done resolve),故 await 返回后 status 必已更新。
 */
export async function cancelAndAwaitWorkingRun(
  maxWaitMs = 60_000,
): Promise<{ cancelled: string | null; settled: boolean }> {
  const rec = activeWorkingRun();
  if (!rec) return { cancelled: null, settled: true };
  requestCancel(rec.taskId);
  try {
    await Promise.race([
      rec.done ?? Promise.resolve(),
      new Promise(r => setTimeout(r, Math.min(maxWaitMs, rec.ttl))),
    ]);
    return { cancelled: rec.taskId, settled: rec.status !== 'working' };
  } catch {
    return { cancelled: rec.taskId, settled: false };
  }
}
