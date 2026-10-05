// src/tools/qa/index.ts — QA 测试套件编排工具（v0.30 B 批；PR-1b 增 async/status/cancel）
//
// 定位：把既有原语（bridge 输入/等待/断言、确定性 playtest、截图证据）编排成
// "规范 → 执行 → 报告 → 回归 diff" 的闭环，对标商业 AI QA 工具（StraySpark 模式）
// 的免费开源实现。五个 action：
//   run    — 执行套件（inline spec / spec 文件），落盘 ~/.godot-mcp/qa-reports。
//            mode:sync（同步等完整结果）| async（注册 → 后台执行 → 立即返回
//            run_id，长套件防客户端超时）。显式 mode 优先；未显式指定时，客户端
//            声明 tasks 能力则自动 async，否则 sync。全局单 working 互斥（bridge
//            单连接），冲突返回 BUSY。
//   report — 读报告（'latest'/'prev'/路径/文件名）
//   diff   — 两份报告按用例对比（回归/修复/新增/移除）
//   status — 查运行注册表（run_id 省略=列全部；内存态，server 重启即丢，
//            查不到时引导 qa report 读落盘报告）
//   cancel — 对 working run 置取消标志（当前步骤结束后生效，teardown 照常收尾）
//
// 安全：run/cancel 声明 'process' 风险（run 装 bridge + 起游戏 + 输入/写状态，
// cancel 干预运行中进程），经 ToolDispatcher 的 confirm+audit 门一次性覆盖整个
// 套件（与 confirm_and_execute 对已确认操作直调模块的语义一致）；report/diff/status 只读。
// call 步骤受 bridge 只读白名单 + GODOT_MCP_BRIDGE_EXTRA_METHODS 约束，不绕过。

import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { Tool } from '@modelcontextprotocol/server';
import type { ToolResult, ToolContext } from '../../types.js';
import { textResult } from '../../types.js';
import { opsErrorResult } from '../shared.js';
import { requireProjectPath } from '../../helpers.js';
import { isPathInAllowedRoots } from '../../core/path-utils.js';
import { classifyError } from '../../core/tool-errors.js';
import { getLogger } from '../../core/logger.js';
import { parseQaSuite } from './spec.js';
import { runQaSuite, type QaRunControl } from './runner.js';
import { writeReport, readReport, listReports, diffReports, makeRunId, type QaReport } from './report.js';
import {
  registerRun, getRun, listRuns, activeWorkingRun, requestCancel, finishRun, updateProgress,
  QaBusyError, type RunRecord,
} from './registry.js';

// C-1 惯例：导出 TOOL_NAMES 供 scripts/check-tool-groups.mjs 归组对账（audit 第 4 次游离教训）
const TOOL_NAMES = ['qa'] as const;
export { TOOL_NAMES };

export function getToolDefinitions(): Tool[] {
  return [{
    name: 'qa',
    description: 'QA test suite orchestration: structured test spec → auto-install the bridge → run the game → execute step by step → aggregated report + regression diff. '
      + 'Step types: input/wait/wait_frames/freeze/unfreeze/step_until/snapshot/restore/set/call/ '
      + 'watch_start|stop/monitor_start|stop/assert/screenshot/sleep; the 8 assertion kinds and each field\'s meaning are in the schema field descriptions. '
      + 'run supports mode:async for background runs (managed with qa status/cancel). '
      + 'Reports go to ~/.godot-mcp/qa-reports/<run_id>.{json,md}.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['run', 'report', 'diff', 'status', 'cancel'],
          description: 'run = run a suite; report = read a report; diff = compare two reports for regressions; status = run registry (progress/final state); cancel = cancel a run in progress',
        },
        // run
        mode: {
          type: 'string',
          enum: ['sync', 'async'],
          description: 'run: sync = wait for the full result; async = return run_id immediately and run in the background (poll with qa status, cancel with qa cancel). Default when unspecified: async if the client declares the MCP tasks capability, otherwise sync',
        },
        run_id: { type: 'string', description: 'status/cancel: target run_id (omitted for status = list all registered runs)' },
        // assert 8 种(node_state/scene_structure/screen_text/perf/screenshot_diff/signal/errors/monitor)
        // 的字段级语义在 spec.ts zod 注释与 runtime-assert schema description(Task 6),此处只做索引级概述,避免双份维护
        spec: { type: 'object', description: 'run: inline suite spec object. Steps are a discriminated union (the type field decides the shape): input (method+params, native bridge params), wait (polls wait_for_node/wait_for_property), wait_frames (deterministic 1-60 frame advance), freeze/unfreeze, step_until (structured conditions {path,property,op,value}[], avoids RCE), snapshot/restore, set (write node properties), call (bridge read-only whitelist; write methods need GODOT_MCP_BRIDGE_EXTRA_METHODS), watch_start (node_path+signal_name, one watch per suite), watch_stop, monitor_start (node_path+properties[], one monitor per suite), monitor_stop, screenshot (evidence saved to the report directory), sleep. Give steps a label so diffs line up' },
        spec_path: { type: 'string', description: 'run: spec file path (.json, or .md with a ```qa-spec fence); use a file for big suites to avoid token truncation; must be inside the ALLOWED_PROJECT_PATHS whitelist' },
        project_path: { type: 'string', description: 'run: project path (overrides project_path in the spec; required if the spec has none)' },
        // report / diff
        report_path: { type: 'string', description: 'report: report path or run_id; latest = newest, prev = second newest' },
        base_path: { type: 'string', description: 'diff: baseline report (default prev)' },
        head_path: { type: 'string', description: 'diff: report to compare (default latest)' },
      },
      required: ['action'],
    },
  }];
}

export const TOOL_META = {
  'qa': {
    readonly: false,
    long_running: true,
    actionRisks: {
      run: 'process' as const,  // 装 bridge + 起游戏 + 输入/写游戏状态：dispatcher 层 confirm+audit 一次覆盖
      report: 'read' as const,
      diff: 'read' as const,
      status: 'read' as const,
      cancel: 'process' as const,   // 干预运行中进程（置取消标志，teardown 收尾）
    },
  },
};

export async function handleTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult | null> {
  if (name !== 'qa') return null;
  const action = args.action as string;

  try {
    switch (action) {
      case 'run':
        return await handleRun(args, ctx);
      case 'report':
        return handleReport(args);
      case 'diff':
        return handleDiff(args);
      case 'status':
        return handleStatus(args);
      case 'cancel':
        return handleCancel(args);
      default:
        return opsErrorResult('UNKNOWN_ACTION', `Unknown action: ${action} (available: run/report/diff/status/cancel)`);
    }
  } catch (err) {
    // P2-17 残留点补修(2026-08-21 问题对账): 工具层 catch 直拼 err.message(常含
    // 绝对路径)绕过主 catch 的 G2 PII 护栏——改走 classifyError.safeMessage
    // (runtime-assert 顶层同款),完整错误只进 server 日志。
    getLogger().error('qa', `action=${action} failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    const { safeMessage } = classifyError(err);
    return opsErrorResult('QA_ERROR', `qa.${action} failed: ${safeMessage}`);
  }
}

// ─── run ─────────────────────────────────────────────────────────────────────

async function handleRun(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  let specInput: unknown;
  let specSource: QaReport['suite']['spec_source'] = 'inline';
  if (args.spec !== undefined && args.spec !== null) {
    specInput = args.spec;
  } else if (typeof args.spec_path === 'string' && args.spec_path) {
    // 审查 Important-1 修复：spec_path 是文件读取入口，必须与 project_path 同标准过
    // ALLOWED_PROJECT_PATHS 白名单（此前是全 src/tools 唯一 readFileSync(args.*) 直读口子）
    const specAbs = resolve(args.spec_path);
    if (!isPathInAllowedRoots(specAbs)) {
      return opsErrorResult('INVALID_PATH',
        `spec_path is not in the ALLOWED_PROJECT_PATHS whitelist: ${specAbs}. Put the spec file under a whitelisted root, or use the inline spec parameter.`);
    }
    try {
      specInput = readFileSync(specAbs, 'utf-8');
      specSource = 'file';
    } catch (err) {
      return opsErrorResult('INVALID_PARAMS', `spec_path unreadable: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    return opsErrorResult('INVALID_PARAMS', 'run needs spec (inline object) or spec_path (file path)');
  }

  const parsed = parseQaSuite(specInput);
  if (!parsed.ok || !parsed.suite) {
    return opsErrorResult('INVALID_SPEC', parsed.error ?? 'Failed to parse spec');
  }
  const suite = parsed.suite;

  const rawProject = (typeof args.project_path === 'string' && args.project_path) || suite.project_path;
  if (!rawProject) {
    return opsErrorResult('INVALID_PARAMS', 'project_path missing (give it in the tool arguments or in the spec)');
  }
  let projectPath: string;
  try {
    projectPath = requireProjectPath({ project_path: rawProject });
  } catch (err) {
    return opsErrorResult('INVALID_PATH', err instanceof Error ? err.message : String(err));
  }

  // PR-2 Task 4: 客户端声明 tasks 能力(ctx.taskAugmented,由 GodotServer tools/call handler
  // 从 getClientCapabilities() 读出注入)且未显式指定 mode 时自动转 async——客户端经
  // _meta.relatedTask 回指 + tasks/get 轮询,防长套件阻塞 tools/call。显式 mode 优先
  // (审查 Important-1 修复:能力协商只提供默认值,显式参数覆盖默认值——声明 tasks 能力
  // 的客户端显式传 mode:'sync' 仍走同步路径)。
  const mode = args.mode === 'sync' ? 'sync' : (args.mode === 'async' || ctx.taskAugmented === true ? 'async' : 'sync');
  const runId = makeRunId(suite.name);   // index 层生成，注册表 taskId 与报告 run_id 同一标识
  // BUSY 门：sync/async 一视同仁（bridge 单连接，全局同时仅 1 个 run）
  let record: RunRecord;
  try {
    record = registerRun(runId, suite.name, projectPath, suite.steps.length);
  } catch (busy) {
    if (busy instanceof QaBusyError) {
      // opsErrorResult opts 不支持任意结构化字段，current_run_id 已内嵌于 QaBusyError.message
      const cur = activeWorkingRun();
      const progress = cur ? ` (progress step ${cur.progress.step}/${cur.progress.total})` : '';
      return opsErrorResult('BUSY', `${busy.message}${progress}`, {
        suggestion: `Poll qa status(run_id:"${busy.currentRunId}") until it finishes and retry, or cancel it with qa cancel(run_id:"${busy.currentRunId}")`,
        retryable: true,
      });
    }
    throw busy;
  }
  const ctl: QaRunControl = {
    cancelRequested: () => record.cancelRequested,
    onProgress: (step, total, current) => updateProgress(runId, step, total, current),
  };
  const exec = runQaSuite(suite, projectPath, ctx, specSource, ctl, runId)
    .then((report) => {
      const paths = writeReport(report);
      finishRun(runId,
        report.summary.status === 'PASSED' ? 'completed' : report.summary.status === 'CANCELLED' ? 'cancelled' : 'failed',
        report, paths);
      return { report, paths };
    })
    .catch((err: unknown) => {
      // 异常安全（brief Step 3 注记修正，必须落实）：writeReport/runQaSuite 抛错时兜底置
      // failed，防 record 永远 working 死锁 BUSY。rethrow 由两条路径消化——sync 的 await
      // （→ 外层 catch → QA_ERROR，行为与 PR-1a 前一致）；async 调用方已离开，由下方
      // record.done 的吞错 handler 接住（同时防 unhandled rejection）。
      // T2 审查 Minor-2：兜底也带 error（否则 tasks/result payload 只剩 run_id，不可诊断）。
      finishRun(runId, 'failed', undefined, undefined, `Suite execution error: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    });
  record.done = exec.then(() => undefined, () => undefined);

  if (mode === 'async') {
    const res = textResult(JSON.stringify({
      success: true,
      data: {
        run_id: runId, status: 'working',
        suite_name: suite.name, steps_total: suite.steps.length,
        hint: `Poll progress with qa status(run_id:"${runId}"); read results with qa report(report_path:"${runId}"); cancel with qa cancel(run_id:"${runId}")`,
      },
    }));
    // PR-2 Task 4: _meta.relatedTask 回指(taskAugmented 客户端的协议入口,spec §3.2 组件 3)。
    // 类型断言放宽同 G2 先例(ToolDispatcher.ts healthSample):CallToolResult._meta 推断类型
    // 只声明 serverInfo key;G2 注入用 {...result._meta, trace_id, duration_ms} 展开,未知键
    // (relatedTask)天然透传到 wire——集成测试实测锁定(test/qa-tasks-wire.test.ts Task 4)。
    (res as ToolResult & { _meta?: Record<string, unknown> })._meta = { relatedTask: { taskId: runId, status: 'working' } };
    return res;
  }
  // sync：等完整结果（行为与 PR-1a 前一致，响应结构不变）
  const { report, paths } = await exec;

  // 响应只带摘要 + 紧凑步骤表（完整 mismatch/证据在报告文件里，防响应膨胀）
  const stepsCondensed = report.steps.map(s => ({
    index: s.index,
    label: s.label,
    type: s.type,
    status: s.status,
    detail: s.detail?.slice(0, 120),
    skip_reason: s.skip_reason,
    screenshot: s.evidence?.screenshot_path,
  }));
  return textResult(JSON.stringify({
    success: true,
    data: {
      run_id: report.run_id,
      // CLI nightly（同套件上次基线 diff）与 audit 留痕需要；报告 json 内同源
      suite_name: report.suite.name,
      project_path: report.suite.project_path,
      summary: report.summary,
      setup_error: report.setup_error,
      recording: report.recording_path,
      steps: stepsCondensed,
      report: paths,
    },
    warnings: report.teardown_warnings ?? [],
  }));
}

// ─── report ──────────────────────────────────────────────────────────────────

function handleReport(args: Record<string, unknown>): ToolResult {
  const ref = typeof args.report_path === 'string' && args.report_path ? args.report_path : 'latest';
  try {
    const report = readReport(ref);
    return textResult(JSON.stringify({ success: true, data: { report } }));
  } catch (err) {
    return opsErrorResult('REPORT_NOT_FOUND', err instanceof Error ? err.message : String(err),
      { suggestion: `Available reports: ${listReports().slice(0, 10).join(', ') || '(none)'}` });
  }
}

// ─── diff ────────────────────────────────────────────────────────────────────

function handleDiff(args: Record<string, unknown>): ToolResult {
  const baseRef = typeof args.base_path === 'string' && args.base_path ? args.base_path : 'prev';
  const headRef = typeof args.head_path === 'string' && args.head_path ? args.head_path : 'latest';
  try {
    const base = readReport(baseRef);
    const head = readReport(headRef);
    if (base.run_id === head.run_id) {
      return opsErrorResult('INVALID_PARAMS', `base and head are the same report (${base.run_id})`);
    }
    return textResult(JSON.stringify({ success: true, data: diffReports(base, head) }));
  } catch (err) {
    return opsErrorResult('REPORT_NOT_FOUND', err instanceof Error ? err.message : String(err),
      { suggestion: `Available reports: ${listReports().slice(0, 10).join(', ') || '(none)'}` });
  }
}

// ─── status / cancel（PR-1b）─────────────────────────────────────────────────

/** RunRecord → wire 紧凑视图（snake_case 与工具参数/响应命名一致；不含内部字段
 *  cancelRequested/done，终态附报告路径与 summary 摘要，不含 report 全文） */
function condenseRecord(r: RunRecord): Record<string, unknown> {
  const base: Record<string, unknown> = {
    run_id: r.taskId,
    status: r.status,
    suite_name: r.suite_name,
    progress: r.progress,
    created_at: r.createdAt,
    last_updated_at: r.lastUpdatedAt,
  };
  if (r.status !== 'working') {
    base.report = r.reportPaths;
    base.summary = r.report?.summary;
  }
  return base;
}

function handleStatus(args: Record<string, unknown>): ToolResult {
  const rid = typeof args.run_id === 'string' && args.run_id ? args.run_id : undefined;
  if (!rid) {
    return textResult(JSON.stringify({ success: true, data: { runs: listRuns().map(condenseRecord) } }));
  }
  const r = getRun(rid);
  if (!r) {
    return opsErrorResult('RUN_NOT_FOUND',
      `run_id "${rid}" is not in the run registry (the server may have restarted or it expired). Try qa report(report_path:"${rid}") to read the saved report.`);
  }
  return textResult(JSON.stringify({ success: true, data: { run: condenseRecord(r) } }));
}

function handleCancel(args: Record<string, unknown>): ToolResult {
  const rid = typeof args.run_id === 'string' && args.run_id ? args.run_id : '';
  if (!rid) return opsErrorResult('INVALID_PARAMS', 'cancel needs run_id');
  const r = requestCancel(rid);
  if (!r.ok) return opsErrorResult('INVALID_PARAMS', r.message ?? 'Cancel failed');
  return textResult(JSON.stringify({
    success: true,
    data: { run_id: rid, cancel_requested: true, note: 'Cancellation takes effect after the current step; teardown runs as usual' },
  }));
}
