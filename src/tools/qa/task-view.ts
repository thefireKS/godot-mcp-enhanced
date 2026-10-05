// src/tools/qa/task-view.ts — qa run 注册表 → MCP 2025-11-25 tasks wire 视图(PR-2)
//
// 依赖方向裁定:与 registry 同目录(不放 core/,防 core→tools 分层倒置,仓库 P0-arch-cleanup 教训)。
// wire 契约(Task/GetTaskResult/CancelTaskResult 平铺五字段)2026-08-17 实测:
// 必填 taskId/status/ttl(秒)/createdAt/lastUpdatedAt,可选 statusMessage;枚举 working|input_required|completed|failed|cancelled。

import type { RunRecord } from './registry.js';
import { TaskSchema } from '@modelcontextprotocol/core/internal';

// type alias 而非 interface:TS 对象字面量 type 有隐式 index signature,可赋给 SDK
// 3 参 schema 重载 handler 的 Result 返回类型 {[x: string]: unknown}(interface 不行)。
export type WireTask = {
  taskId: string;
  status: 'working' | 'completed' | 'failed' | 'cancelled';
  ttl: number;              // 秒(wire 单位;registry 内部 ms)
  createdAt: string;
  lastUpdatedAt: string;
  statusMessage?: string;   // working 进度文本(TaskSchema 无结构化 progress 字段,I-8)
};

/** RunRecord → wire Task。ttl ms→s;working 时经 statusMessage 承载进度。 */
export function toWireTask(r: RunRecord): WireTask {
  const t: WireTask = {
    taskId: r.taskId,
    status: r.status,
    ttl: Math.round(r.ttl / 1000),
    createdAt: r.createdAt,
    lastUpdatedAt: r.lastUpdatedAt,
  };
  if (r.status === 'working') {
    const cur = r.progress.current ? `: ${r.progress.current}` : '';
    t.statusMessage = `step ${r.progress.step}/${r.progress.total}${cur}`;
  }
  return t;
}

/** tasks/result 的 payload(终态报告摘要;working 抛错由 handler 转 JSON-RPC error) */
export function toTaskPayload(r: RunRecord): Record<string, unknown> {
  if (r.status === 'working') throw new Error(`task ${r.taskId} not terminal (status: working)`);
  return {
    run_id: r.taskId,
    summary: r.report?.summary,
    report_paths: r.reportPaths,
    ...(r.error !== undefined ? { error: r.error } : {}),
  };
}

/** wire 校验:TaskSchema.safeParse 失败即实现 bug(注册表字段与契约漂移),早爆。 */
export function assertTaskWire(t: WireTask): void {
  const r = TaskSchema.safeParse(t);
  if (!r.success) throw new Error(`task wire validation failed (implementation bug): ${JSON.stringify(r.error.issues.map(i => `${i.path.join('.')}: ${i.message}`))}`);
}
