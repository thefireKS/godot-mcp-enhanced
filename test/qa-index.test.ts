// test/qa-index.test.ts — qa 工具入口层参数校验（含审查 Important-1 的 spec_path 白名单）
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

// runner mock：入口层测试不触执行链（INVALID_* 分支都在 runner 之前返回）
vi.mock('../src/tools/qa/runner.js', () => ({
  runQaSuite: vi.fn(),
}));

import { handleTool, getToolDefinitions } from '../src/tools/qa/index.js';
import { runQaSuite } from '../src/tools/qa/runner.js';
import { clearRegistry } from '../src/tools/qa/registry.js';
import type { QaReport } from '../src/tools/qa/report.js';

function parse(res: { content: Array<{ type: string; text?: string }> }): Record<string, unknown> {
  return JSON.parse(res.content[0]!.text!) as Record<string, unknown>;
}

describe('qa handleTool 入口校验', () => {
  let allowedRoot: string;
  const prevAllowed = process.env.ALLOWED_PROJECT_PATHS;
  const prevUnrestricted = process.env.GODOT_MCP_UNRESTRICTED;

  beforeEach(() => {
    allowedRoot = mkdtempSync(join(tmpdir(), 'qa-idx-'));
    process.env.ALLOWED_PROJECT_PATHS = allowedRoot;
    delete process.env.GODOT_MCP_UNRESTRICTED; // UNRESTRICTED 是显式逃生口，白名单用例须排除
    process.env.GODOT_MCP_QA_REPORTS_DIR = mkdtempSync(join(tmpdir(), 'qa-idx-reports-'));
    vi.clearAllMocks();
  });

  afterEach(() => {
    rmSync(allowedRoot, { recursive: true, force: true });
    if (prevAllowed === undefined) delete process.env.ALLOWED_PROJECT_PATHS;
    else process.env.ALLOWED_PROJECT_PATHS = prevAllowed;
    if (prevUnrestricted === undefined) delete process.env.GODOT_MCP_UNRESTRICTED;
    else process.env.GODOT_MCP_UNRESTRICTED = prevUnrestricted;
  });

  const ctx = {} as Parameters<typeof handleTool>[2];

  it('unknown action → UNKNOWN_ACTION', async () => {
    const r = await handleTool('qa', { action: 'nope' }, ctx);
    expect(parse(r!)).toMatchObject({ error_code: 'UNKNOWN_ACTION' });
  });

  it('run 无 spec/spec_path → INVALID_PARAMS', async () => {
    const r = await handleTool('qa', { action: 'run' }, ctx);
    expect(parse(r!)).toMatchObject({ error_code: 'INVALID_PARAMS' });
  });

  it('安全（审查 Important-1）：spec_path 白名单外 → INVALID_PATH 且不读文件', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'qa-outside-'));
    writeFileSync(join(outside, 'spec.json'), JSON.stringify({ name: 'x', steps: [{ type: 'sleep', ms: 100 }] }));
    const r = await handleTool('qa', { action: 'run', spec_path: join(outside, 'spec.json') }, ctx);
    expect(parse(r!)).toMatchObject({ error_code: 'INVALID_PATH' });
    rmSync(outside, { recursive: true, force: true });
  });

  it('spec_path 白名单内但非法 JSON → INVALID_SPEC（源格式错误，不进 zod）', async () => {
    const badSpec = join(allowedRoot, 'bad.json');
    writeFileSync(badSpec, 'not json at all', 'utf-8');
    const r = await handleTool('qa', { action: 'run', spec_path: badSpec }, ctx);
    const j = parse(r!);
    expect(j.error_code).toBe('INVALID_SPEC');
    expect(String(j.error)).toContain('qa-spec'); // extractSpecJson 的源格式错误消息
  });

  it('inline spec 缺 project_path → INVALID_PARAMS（在 runner 之前拦截）', async () => {
    const r = await handleTool('qa', {
      action: 'run',
      spec: { name: 'x', steps: [{ type: 'sleep', ms: 100 }] },
    }, ctx);
    expect(parse(r!)).toMatchObject({ error_code: 'INVALID_PARAMS' });
  });

  it('TOOL_NAMES 导出（C-1 归组对账契约）', async () => {
    const { TOOL_NAMES } = await import('../src/tools/qa/index.js');
    expect([...TOOL_NAMES]).toEqual(['qa']);
  });

  it('qa description 收敛(Nit-3):<600B 且步骤细节移入 schema', () => {
    const def = getToolDefinitions()[0]!;
    const bytes = Buffer.byteLength(def.description!, 'utf8');
    expect(bytes).toBeLessThan(600);
    // 新 description 关键词锁定(改坏措辞时测试报警)
    expect(def.description).toContain('QA test suite orchestration');
    expect(def.description).toContain('regression diff');
    expect(def.description).toContain('watch_start');      // Task 2 新步骤类型已进索引级概述
    expect(def.description).toContain('monitor_start');
    expect(def.description).not.toContain('options:');     // 选项说明移入字段 description
    expect(def.description).not.toContain('相似度');        // spec §0.5:screenshot_diff 一律"像素差异容忍"措辞
    // 细节迁移落点:各 schema 字段 description 就位
    const props = def.inputSchema.properties as Record<string, { description?: string }> | undefined;
    expect(props?.spec_path?.description).toBeTruthy();
    expect(props?.spec_path?.description).toContain('ALLOWED_PROJECT_PATHS');
    expect(props?.spec?.description).toBeTruthy();
    expect(props?.spec?.description).toContain('watch_start');
    expect(props?.spec?.description).toContain('monitor_start');
  });

  it('负向：入口层不消费 ctx 之外的执行面（spec 校验失败时 runner 零调用）', async () => {
    await handleTool('qa', { action: 'run', spec: { steps: [] } }, ctx);
    expect(runQaSuite).not.toHaveBeenCalled();
    void resolve; // 保持 import 使用（Windows resolve 与 join 混用环境）
  });
});

// ─── PR-1b Task 4：mode:async 后台执行 + status/cancel action（核心接线）─────────

describe('qa run mode:async + status/cancel（PR-1b）', () => {
  let allowedRoot: string;
  let reportsDir: string;
  const prevAllowed = process.env.ALLOWED_PROJECT_PATHS;
  const prevUnrestricted = process.env.GODOT_MCP_UNRESTRICTED;
  const prevReportsDir = process.env.GODOT_MCP_QA_REPORTS_DIR;
  const ctx = {} as Parameters<typeof handleTool>[2];

  const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

  beforeEach(() => {
    allowedRoot = mkdtempSync(join(tmpdir(), 'qa-async-'));
    reportsDir = mkdtempSync(join(tmpdir(), 'qa-async-reports-'));
    process.env.ALLOWED_PROJECT_PATHS = allowedRoot;
    delete process.env.GODOT_MCP_UNRESTRICTED;
    process.env.GODOT_MCP_QA_REPORTS_DIR = reportsDir;
    // clearAllMocks 只清调用记录不清 implementation——用例间须 reset 防 mock 泄漏
    vi.mocked(runQaSuite).mockReset();
    clearRegistry();
  });

  afterEach(() => {
    rmSync(allowedRoot, { recursive: true, force: true });
    rmSync(reportsDir, { recursive: true, force: true });
    if (prevAllowed === undefined) delete process.env.ALLOWED_PROJECT_PATHS;
    else process.env.ALLOWED_PROJECT_PATHS = prevAllowed;
    if (prevUnrestricted === undefined) delete process.env.GODOT_MCP_UNRESTRICTED;
    else process.env.GODOT_MCP_UNRESTRICTED = prevUnrestricted;
    if (prevReportsDir === undefined) delete process.env.GODOT_MCP_QA_REPORTS_DIR;
    else process.env.GODOT_MCP_QA_REPORTS_DIR = prevReportsDir;
    // BUSY 用例收尾保险：残留 working record 会毒化后续用例（brief 前置注记 6）
    clearRegistry();
  });

  /** mock runner 用的最小合法报告（run_id 必须与 runIdOverride 一致，注册表与落盘同一 id） */
  function fakeReport(runId: string, name: string, projectPath: string, status: 'PASSED' | 'CANCELLED'): QaReport {
    const cancelled = status === 'CANCELLED';
    return {
      version: 1,
      run_id: runId,
      suite: { name, project_path: projectPath, started_at: new Date().toISOString(), spec_source: 'inline' },
      options: {},
      summary: { total: 2, passed: cancelled ? 1 : 2, failed: 0, errors: 0, skipped: cancelled ? 1 : 0, status, duration_ms: 5 },
      steps: [
        { index: 0, label: 's1', type: 'sleep', status: 'PASSED', elapsed_ms: 2 },
        cancelled
          ? { index: 1, label: 's2', type: 'sleep', status: 'SKIPPED', elapsed_ms: 0, skip_reason: 'cancelled by user' }
          : { index: 1, label: 's2', type: 'sleep', status: 'PASSED', elapsed_ms: 2 },
      ],
    };
  }

  /** 轮询 qa status 至非 working（上限 timeoutMs），返回 condenseRecord 视图 */
  async function waitForTerminal(runId: string, timeoutMs = 10_000): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const res = await handleTool('qa', { action: 'status', run_id: runId }, ctx);
      const j = parse(res!);
      if (j.success === true) {
        const run = (j.data as { run: Record<string, unknown> }).run;
        if (run.status !== 'working') return run;
      }
      if (Date.now() > deadline) throw new Error(`run ${runId} 未在 ${timeoutMs}ms 内到终态`);
      await sleep(25);
    }
  }

  it('async 立即返回 run_id/working/hint，后台完成后 status 见终态与报告路径', async () => {
    vi.mocked(runQaSuite).mockImplementation(async (suite, _pp, _ctx, _src, _ctl, runIdOverride) => {
      await sleep(200); // 模拟慢套件
      return fakeReport(runIdOverride!, suite.name, allowedRoot, 'PASSED');
    });
    const t0 = Date.now();
    const r1 = await handleTool('qa', {
      action: 'run', mode: 'async',
      spec: { name: 'async-ok', steps: [{ type: 'sleep', ms: 100 }, { type: 'sleep', ms: 100 }] },
      project_path: allowedRoot,
    }, ctx);
    const d1 = parse(r1!).data as Record<string, unknown>;
    expect(Date.now() - t0).toBeLessThan(150); // 立即返回，不等后台 200ms
    expect(d1.status).toBe('working');
    expect(typeof d1.run_id).toBe('string');
    expect(String(d1.hint)).toContain('qa status');
    expect(d1.steps_total).toBe(2);

    const run = await waitForTerminal(String(d1.run_id));
    expect(run.status).toBe('completed');
    const rep = run.report as { json_path: string; md_path: string };
    expect(rep.json_path.endsWith(`${String(d1.run_id)}.json`)).toBe(true);
    expect((run.summary as { status: string }).status).toBe('PASSED');
  });

  it('BUSY：async 进行中再发 run → BUSY 错误带当前 run_id（sync/async 一视同仁）', async () => {
    let release!: (rep: QaReport) => void;
    vi.mocked(runQaSuite).mockImplementation(() => new Promise<QaReport>(res => { release = res; }));
    const r1 = await handleTool('qa', {
      action: 'run', mode: 'async',
      spec: { name: 'busy-first', steps: [{ type: 'sleep', ms: 100 }] },
      project_path: allowedRoot,
    }, ctx);
    const rid1 = (parse(r1!).data as { run_id: string }).run_id;

    const r2 = await handleTool('qa', {
      action: 'run', mode: 'async',
      spec: { name: 'busy-second', steps: [{ type: 'sleep', ms: 100 }] },
      project_path: allowedRoot,
    }, ctx);
    const j2 = parse(r2!);
    expect(j2.error_code).toBe('BUSY');
    expect(String(j2.error)).toContain(rid1); // 错误带当前 run_id

    const r3 = await handleTool('qa', {
      action: 'run', // 默认 sync，同样被 BUSY 门拦
      spec: { name: 'busy-third', steps: [{ type: 'sleep', ms: 100 }] },
      project_path: allowedRoot,
    }, ctx);
    expect(parse(r3!).error_code).toBe('BUSY');

    // 收尾：resolve 挂起 promise，等第一 run 终态（否则 registry 留 working 影响后续用例）
    release(fakeReport(rid1, 'busy-first', allowedRoot, 'PASSED'));
    const run = await waitForTerminal(rid1);
    expect(run.status).toBe('completed');
  });

  it('sync 模式（默认）仍同步返回完整结果且入注册表（终态）', async () => {
    vi.mocked(runQaSuite).mockImplementation(async (suite, _pp, _ctx, _src, _ctl, runIdOverride) =>
      fakeReport(runIdOverride!, suite.name, allowedRoot, 'PASSED'));
    const r = await handleTool('qa', {
      action: 'run',
      spec: { name: 'sync-ok', steps: [{ type: 'sleep', ms: 100 }, { type: 'sleep', ms: 100 }] },
      project_path: allowedRoot,
    }, ctx);
    const j = parse(r!);
    expect(j.success).toBe(true);
    const d = j.data as Record<string, unknown>;
    // 既有响应结构关键字段（回归红线：sync 响应零变化）
    expect(d.suite_name).toBe('sync-ok');
    expect((d.summary as { status: string }).status).toBe('PASSED');
    expect((d.report as { json_path: string }).json_path).toBeTruthy();
    const steps = d.steps as Array<Record<string, unknown>>;
    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({ index: 0, label: 's1', type: 'sleep', status: 'PASSED' });
    // 入注册表：status 立即见终态（无需轮询）
    const st = await handleTool('qa', { action: 'status', run_id: d.run_id }, ctx);
    const run = (parse(st!).data as { run: Record<string, unknown> }).run;
    expect(run.status).toBe('completed');
  });

  it('status 不传 run_id → 列表含刚完成的 run', async () => {
    vi.mocked(runQaSuite).mockImplementation(async (suite, _pp, _ctx, _src, _ctl, runIdOverride) =>
      fakeReport(runIdOverride!, suite.name, allowedRoot, 'PASSED'));
    const r = await handleTool('qa', {
      action: 'run',
      spec: { name: 'list-me', steps: [{ type: 'sleep', ms: 100 }, { type: 'sleep', ms: 100 }] },
      project_path: allowedRoot,
    }, ctx);
    const rid = (parse(r!).data as { run_id: string }).run_id;

    const st = await handleTool('qa', { action: 'status' }, ctx);
    const runs = (parse(st!).data as { runs: Array<{ run_id: string; status: string }> }).runs;
    expect(Array.isArray(runs)).toBe(true);
    expect(runs.find(x => x.run_id === rid)?.status).toBe('completed');
  });

  it('status 未知 run_id → RUN_NOT_FOUND + 可行动提示读 qa report', async () => {
    const st = await handleTool('qa', { action: 'status', run_id: '20990101-000000-ghost' }, ctx);
    const j = parse(st!);
    expect(j.error_code).toBe('RUN_NOT_FOUND');
    expect(String(j.error)).toContain('qa report');
  });

  it('cancel：working → ok；后台 run 以 CANCELLED 终态（steps SKIPPED cancelled by user）', async () => {
    vi.mocked(runQaSuite).mockImplementation(async (suite, _pp, _ctx, _src, ctl, runIdOverride) => {
      // 模拟慢步骤：轮询取消信号（上限 10s @20ms），取消时返回 CANCELLED 报告
      for (let i = 0; i < 500; i++) {
        ctl?.onProgress?.(1, 2, 'sleep (slow)');
        if (ctl?.cancelRequested()) return fakeReport(runIdOverride!, suite.name, allowedRoot, 'CANCELLED');
        await sleep(20);
      }
      return fakeReport(runIdOverride!, suite.name, allowedRoot, 'PASSED');
    });
    const r1 = await handleTool('qa', {
      action: 'run', mode: 'async',
      spec: { name: 'cancel-me', steps: [{ type: 'sleep', ms: 100 }, { type: 'sleep', ms: 100 }] },
      project_path: allowedRoot,
    }, ctx);
    const rid = (parse(r1!).data as { run_id: string }).run_id;

    const c = await handleTool('qa', { action: 'cancel', run_id: rid }, ctx);
    const cj = parse(c!);
    expect(cj.success).toBe(true);
    expect((cj.data as { cancel_requested: boolean }).cancel_requested).toBe(true);

    const run = await waitForTerminal(rid);
    expect(run.status).toBe('cancelled');
    expect((run.summary as { status: string }).status).toBe('CANCELLED');
    // 落盘报告：剩余步骤 SKIPPED cancelled by user
    const onDisk = JSON.parse(readFileSync((run.report as { json_path: string }).json_path, 'utf-8')) as QaReport;
    expect(onDisk.steps[1]?.skip_reason).toBe('cancelled by user');
  });

  it('cancel 已终态 run → INVALID_PARAMS + message 含终态', async () => {
    vi.mocked(runQaSuite).mockImplementation(async (suite, _pp, _ctx, _src, _ctl, runIdOverride) =>
      fakeReport(runIdOverride!, suite.name, allowedRoot, 'PASSED'));
    const r = await handleTool('qa', {
      action: 'run',
      spec: { name: 'done-run', steps: [{ type: 'sleep', ms: 100 }, { type: 'sleep', ms: 100 }] },
      project_path: allowedRoot,
    }, ctx);
    const rid = (parse(r!).data as { run_id: string }).run_id;

    const c = await handleTool('qa', { action: 'cancel', run_id: rid }, ctx);
    const j = parse(c!);
    expect(j.error_code).toBe('INVALID_PARAMS');
    expect(String(j.error)).toContain('completed'); // message 含终态
  });

  it('异常安全：writeReport 抛错 → record 置 failed 不死锁 BUSY（brief Step 3 注记）', async () => {
    vi.mocked(runQaSuite).mockImplementation(async (suite, _pp, _ctx, _src, _ctl, runIdOverride) =>
      fakeReport(runIdOverride!, suite.name, allowedRoot, 'PASSED'));
    // 报告目录指向一个文件 → writeReport 的 mkdirSync 抛（ENOTDIR/EEXIST）
    const notADir = join(allowedRoot, 'not-a-dir');
    writeFileSync(notADir, 'x', 'utf-8');
    process.env.GODOT_MCP_QA_REPORTS_DIR = notADir;

    const r1 = await handleTool('qa', {
      action: 'run', mode: 'async',
      spec: { name: 'boom-write', steps: [{ type: 'sleep', ms: 100 }, { type: 'sleep', ms: 100 }] },
      project_path: allowedRoot,
    }, ctx);
    const rid = (parse(r1!).data as { run_id: string }).run_id;
    const run = await waitForTerminal(rid);
    expect(run.status).toBe('failed'); // 兜底 finishRun('failed')，不是永远 working

    // BUSY 未死锁：恢复目录后新 run 可正常注册执行
    process.env.GODOT_MCP_QA_REPORTS_DIR = reportsDir;
    const r2 = await handleTool('qa', {
      action: 'run',
      spec: { name: 'after-boom', steps: [{ type: 'sleep', ms: 100 }, { type: 'sleep', ms: 100 }] },
      project_path: allowedRoot,
    }, ctx);
    expect(parse(r2!).error_code).toBeUndefined();
    expect((parse(r2!).data as { run_id: string }).run_id).toBeTruthy();
  });
});

// ─── PR-2 Task 4：taskAugmented 自动 async（客户端 tasks 能力协商 → _meta.relatedTask）──

describe('qa run taskAugmented 自动 async（PR-2 Task 4）', () => {
  let allowedRoot: string;
  let reportsDir: string;
  const prevAllowed = process.env.ALLOWED_PROJECT_PATHS;
  const prevUnrestricted = process.env.GODOT_MCP_UNRESTRICTED;
  const prevReportsDir = process.env.GODOT_MCP_QA_REPORTS_DIR;
  /** plainCtx 模拟未声明 tasks 能力的客户端（taskAugmented 缺省）；augCtx 模拟已声明。 */
  const plainCtx = {} as Parameters<typeof handleTool>[2];
  const augCtx = { taskAugmented: true } as Parameters<typeof handleTool>[2];

  const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

  beforeEach(() => {
    allowedRoot = mkdtempSync(join(tmpdir(), 'qa-taskaug-'));
    reportsDir = mkdtempSync(join(tmpdir(), 'qa-taskaug-reports-'));
    process.env.ALLOWED_PROJECT_PATHS = allowedRoot;
    delete process.env.GODOT_MCP_UNRESTRICTED;
    process.env.GODOT_MCP_QA_REPORTS_DIR = reportsDir;
    vi.mocked(runQaSuite).mockReset();
    clearRegistry();
  });

  afterEach(() => {
    rmSync(allowedRoot, { recursive: true, force: true });
    rmSync(reportsDir, { recursive: true, force: true });
    if (prevAllowed === undefined) delete process.env.ALLOWED_PROJECT_PATHS;
    else process.env.ALLOWED_PROJECT_PATHS = prevAllowed;
    if (prevUnrestricted === undefined) delete process.env.GODOT_MCP_UNRESTRICTED;
    else process.env.GODOT_MCP_UNRESTRICTED = prevUnrestricted;
    if (prevReportsDir === undefined) delete process.env.GODOT_MCP_QA_REPORTS_DIR;
    else process.env.GODOT_MCP_QA_REPORTS_DIR = prevReportsDir;
    clearRegistry();
  });

  function fakeReport(runId: string, name: string, projectPath: string, status: 'PASSED' | 'CANCELLED'): QaReport {
    const cancelled = status === 'CANCELLED';
    return {
      version: 1,
      run_id: runId,
      suite: { name, project_path: projectPath, started_at: new Date().toISOString(), spec_source: 'inline' },
      options: {},
      summary: { total: 1, passed: cancelled ? 0 : 1, failed: 0, errors: 0, skipped: cancelled ? 1 : 0, status, duration_ms: 5 },
      steps: [
        cancelled
          ? { index: 0, label: 's1', type: 'sleep', status: 'SKIPPED' as const, elapsed_ms: 0, skip_reason: 'cancelled by user' }
          : { index: 0, label: 's1', type: 'sleep', status: 'PASSED' as const, elapsed_ms: 2 },
      ],
    };
  }

  async function waitForTerminal(runId: string, timeoutMs = 10_000): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const res = await handleTool('qa', { action: 'status', run_id: runId }, plainCtx);
      const j = parse(res!);
      if (j.success === true) {
        const run = (j.data as { run: Record<string, unknown> }).run;
        if (run.status !== 'working') return run;
      }
      if (Date.now() > deadline) throw new Error(`run ${runId} 未在 ${timeoutMs}ms 内到终态`);
      await sleep(25);
    }
  }

  /** 从 ToolResult 提取 _meta.relatedTask（类型断言与 qa/index.ts 实现同款） */
  function relatedTaskOf(res: { content: Array<{ type: string; text?: string }> }): { taskId?: string; status?: string } | undefined {
    return (res as { _meta?: { relatedTask?: { taskId?: string; status?: string } } })._meta?.relatedTask;
  }

  it('taskAugmented:true + 不传 mode → 自动 async：data.status=working 且 _meta.relatedTask 回指 run_id', async () => {
    vi.mocked(runQaSuite).mockImplementation(async (suite, _pp, _ctx, _src, _ctl, runIdOverride) => {
      await sleep(100); // 模拟慢套件（async 分流应在完成前返回）
      return fakeReport(runIdOverride!, suite.name, allowedRoot, 'PASSED');
    });
    const t0 = Date.now();
    const r = await handleTool('qa', {
      action: 'run', // 不传 mode —— 分流唯一依据是 ctx.taskAugmented
      spec: { name: 'auto-async', steps: [{ type: 'sleep', ms: 100 }] },
      project_path: allowedRoot,
    }, augCtx);
    expect(Date.now() - t0).toBeLessThan(80); // 未等后台 100ms，立即返回
    const j = parse(r!);
    expect(j.success).toBe(true);
    const d = j.data as Record<string, unknown>;
    expect(d.status).toBe('working');
    expect(typeof d.run_id).toBe('string');
    const rel = relatedTaskOf(r!);
    expect(rel?.taskId).toBe(d.run_id); // _meta.relatedTask.taskId === data.run_id（验收核心）
    expect(rel?.status).toBe('working');
    // 后台收尾：等终态防 working 残留毒化后续用例
    const run = await waitForTerminal(String(d.run_id));
    expect(run.status).toBe('completed');
  });

  it('taskAugmented 缺省 + mode 缺省 → sync 既有回归（完整结果，无 _meta.relatedTask）', async () => {
    vi.mocked(runQaSuite).mockImplementation(async (suite, _pp, _ctx, _src, _ctl, runIdOverride) =>
      fakeReport(runIdOverride!, suite.name, allowedRoot, 'PASSED'));
    const r = await handleTool('qa', {
      action: 'run',
      spec: { name: 'sync-still', steps: [{ type: 'sleep', ms: 100 }] },
      project_path: allowedRoot,
    }, plainCtx);
    const j = parse(r!);
    expect(j.success).toBe(true);
    // sync 既有响应结构（PR-1b 回归红线：summary/steps 在 data 上）
    expect(j.data).toHaveProperty('summary');
    expect(relatedTaskOf(r!)).toBeUndefined(); // sync 响应不挂 _meta.relatedTask
  });

  it('审查 Important-1：taskAugmented:true + 显式 mode:sync → sync 响应（显式参数覆盖能力默认值）', async () => {
    vi.mocked(runQaSuite).mockImplementation(async (suite, _pp, _ctx, _src, _ctl, runIdOverride) => {
      await sleep(100); // 模拟慢套件：sync 路径应等它完成才返回（区别于 async 的立即返回）
      return fakeReport(runIdOverride!, suite.name, allowedRoot, 'PASSED');
    });
    const t0 = Date.now();
    const r = await handleTool('qa', {
      action: 'run', mode: 'sync',
      spec: { name: 'explicit-sync-wins', steps: [{ type: 'sleep', ms: 100 }] },
      project_path: allowedRoot,
    }, augCtx);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(90); // sync：等完整结果后才返回
    const j = parse(r!);
    expect(j.success).toBe(true);
    const d = j.data as Record<string, unknown>;
    // sync 响应结构（与 plainCtx + 缺省 mode 的 sync 回归同构）：summary/steps 在 data 上
    expect(d.summary).toBeTruthy();
    expect(Array.isArray(d.steps)).toBe(true);
    expect(d.status).toBeUndefined(); // 无 async 响应的 status:'working' 快照
    expect(relatedTaskOf(r!)).toBeUndefined(); // sync 响应不挂 _meta.relatedTask
  });

  it('taskAugmented:true 的 async 响应也适用于 spec_path 入口（分流在 source 解析之后）', async () => {
    vi.mocked(runQaSuite).mockImplementation(async (suite, _pp, _ctx, _src, _ctl, runIdOverride) =>
      fakeReport(runIdOverride!, suite.name, allowedRoot, 'PASSED'));
    const specFile = join(allowedRoot, 'spec-taskaug.json');
    writeFileSync(specFile, JSON.stringify({ name: 'file-entry', steps: [{ type: 'sleep', ms: 100 }] }), 'utf-8');
    const r = await handleTool('qa', { action: 'run', spec_path: specFile, project_path: allowedRoot }, augCtx);
    const d = parse(r!).data as Record<string, unknown>;
    expect(d.status).toBe('working');
    expect(relatedTaskOf(r!)?.taskId).toBe(d.run_id);
    await waitForTerminal(String(d.run_id));
  });
});
