// test/qa-cli-nightly.test.ts — CLI qa nightly 接线（QA 收尾批②）
//
// 验证目标（删掉 nightly 实现测试必红）：
// - 目录内全部 spec 逐个跑（mock qa handleTool，验证 spec_path 逐文件传递）
// - 每套件与上次同套件基线 diff（report.ts 真函数 + 预置基线报告），输出回归清单
// - 汇总与退出码（任一 FAILED → exit 1）
// - NIT-7：每套件 run 后 appendAuditLine 留痕
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { textResult } from '../src/types.js';

vi.mock('../src/tools/qa/index.js', () => ({
  handleTool: vi.fn(),
  TOOL_NAMES: ['qa'],
}));
vi.mock('../src/core/audit-log.js', () => ({
  appendAuditLine: vi.fn(async () => undefined),
  // 审查 Important-1：真实 isAuditEnabled 读 env；mock 版同样读 env 保持开关语义可测
  isAuditEnabled: () => process.env.GODOT_MCP_AUDIT !== 'false',
}));

import { handleTool as qaHandleTool } from '../src/tools/qa/index.js';
import { appendAuditLine } from '../src/core/audit-log.js';
import { runQa } from '../src/cli/qa.js';
import { writeReport, type QaReport, type StepRecord } from '../src/tools/qa/report.js';

const PROJECT = 'D:/proj/demo';

function step(i: number, label: string, status: StepRecord['status']): StepRecord {
  return { index: i, label, type: 'sleep', status, elapsed_ms: 5 };
}
function report(runId: string, name: string, steps: StepRecord[]): QaReport {
  const passed = steps.filter(s => s.status === 'PASSED').length;
  const failed = steps.filter(s => s.status === 'FAILED').length;
  return {
    version: 1, run_id: runId,
    suite: { name, project_path: PROJECT, started_at: '2026-08-16T00:00:00Z', spec_source: 'cli' },
    options: {},
    summary: { total: steps.length, passed, failed, errors: 0, skipped: 0, status: failed > 0 ? 'FAILED' : 'PASSED', duration_ms: 10 },
    steps,
  };
}

let specDir: string;
let reportsDir: string;
let exitSpy: ReturnType<typeof vi.spyOn>;
let logs: string[];
let logSpy: ReturnType<typeof vi.spyOn>;
const prevEnv = process.env.GODOT_MCP_QA_REPORTS_DIR;

beforeEach(() => {
  specDir = mkdtempSync(join(tmpdir(), 'qa-nightly-spec-'));
  reportsDir = mkdtempSync(join(tmpdir(), 'qa-nightly-reports-'));
  process.env.GODOT_MCP_QA_REPORTS_DIR = reportsDir;
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw Object.assign(new Error('exit'), { code: code ?? 0 }); }) as never);
  logs = [];
  logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
  vi.clearAllMocks();
});

afterEach(() => {
  logSpy.mockRestore();
  exitSpy.mockRestore();
  rmSync(specDir, { recursive: true, force: true });
  rmSync(reportsDir, { recursive: true, force: true });
  if (prevEnv === undefined) delete process.env.GODOT_MCP_QA_REPORTS_DIR;
  else process.env.GODOT_MCP_QA_REPORTS_DIR = prevEnv;
});

/** 预置 spec 文件 + mock qa handleTool：每个 spec 返回一次 run 响应（head 报告真落盘供 diff 读） */
function arrange(suites: Array<{ specFile: string; runId: string; name: string; head: QaReport }>): void {
  const bySpec = new Map<string, { runId: string; data: unknown }>();
  for (const s of suites) {
    writeFileSync(join(specDir, s.specFile), JSON.stringify({ name: s.name, steps: [] }));
    const paths = writeReport(s.head); // head 报告落真盘（nightly 从 json_path 读）
    bySpec.set(s.specFile, {
      runId: s.runId,
      data: {
        run_id: s.runId, suite_name: s.name, project_path: PROJECT,
        summary: s.head.summary, report: paths,
      },
    });
  }
  vi.mocked(qaHandleTool).mockImplementation(async (_n, args) => {
    const a = args as { action: string; spec_path?: string };
    if (a.action !== 'run') return textResult(JSON.stringify({ success: true, data: {} }));
    const key = Object.keys(Object.fromEntries(bySpec)).find(k => a.spec_path?.endsWith(k));
    const hit = bySpec.get(key ?? '');
    if (!hit) return textResult(JSON.stringify({ success: false }));
    return textResult(JSON.stringify({ success: true, data: hit.data }));
  });
}

describe('cli qa nightly', () => {
  it('目录全量跑 + 同套件基线 diff（回归检出）+ 汇总 + exit 1', async () => {
    // 基线：昨天 smoke 全过
    writeReport(report('20260815-120000-smoke', 'smoke', [step(0, 'case-a', 'PASSED'), step(1, 'case-b', 'PASSED')]));
    // 今天 head：case-a 回归 FAILED → nightly 应报 REGRESSION
    arrange([{ specFile: 'smoke.json', runId: '20991231-010000-smoke', name: 'smoke', head: report('20991231-010000-smoke', 'smoke', [step(0, 'case-a', 'FAILED'), step(1, 'case-b', 'PASSED')]) }]);

    await expect(runQa(['nightly', specDir, '--project', PROJECT])).rejects.toMatchObject({ code: 1 });

    // spec 逐文件传递
    expect(qaHandleTool).toHaveBeenCalledWith('qa', expect.objectContaining({ action: 'run', spec_path: join(specDir, 'smoke.json'), project_path: PROJECT }), expect.anything());
    // NIT-7：CLI 直调 audit 留痕
    expect(appendAuditLine).toHaveBeenCalledTimes(1);
    expect(vi.mocked(appendAuditLine).mock.calls[0]![1]).toMatchObject({ tool: 'qa', action: 'run', risk: 'process', ok: false, project_path: PROJECT });
    // 回归清单 + 汇总 + 退出码
    const out = logs.join('\n');
    expect(out).toContain('REGRESSION  case-a');
    expect(out).toContain('nightly summary: 1 suites · 0 PASSED / 1 FAILED · regressions 1 · fixed 0');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('多套件混合结果 + 无基线套件跳过 diff + 全过 exit 0', async () => {
    // 基线：login 昨天 FAILED
    writeReport(report('20260815-120000-login', 'login', [step(0, 'case-x', 'FAILED')]));
    arrange([
      { specFile: 'a-login.json', runId: '20991231-010001-login', name: 'login', head: report('20991231-010001-login', 'login', [step(0, 'case-x', 'PASSED')]) }, // 修复
      { specFile: 'b-new.json', runId: '20991231-010002-fresh', name: 'fresh', head: report('20991231-010002-fresh', 'fresh', [step(0, 'n1', 'PASSED')]) }, // 首次无基线
    ]);

    await expect(runQa(['nightly', specDir])).rejects.toMatchObject({ code: 0 });

    const out = logs.join('\n');
    expect(out).toContain('IMPROVED');
    expect(out).toContain('first run, no baseline');
    expect(out).toContain('nightly summary: 2 suites · 2 PASSED / 0 FAILED · regressions 0 · fixed 1');
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(appendAuditLine).toHaveBeenCalledTimes(2);
  });

  it('spec 错误（套件未跑）：计入失败继续后续套件，不中断 nightly', async () => {
    writeFileSync(join(specDir, 'bad.json'), '{}');
    writeFileSync(join(specDir, 'good.json'), JSON.stringify({ name: 'good', steps: [] }));
    const paths = writeReport(report('20991231-010003-good', 'good', [step(0, 'g1', 'PASSED')]));
    vi.mocked(qaHandleTool).mockImplementation(async (_n, args) => {
      const a = args as { spec_path?: string };
      if (a.spec_path?.endsWith('bad.json')) return textResult(JSON.stringify({ success: false, error: { message: 'INVALID_SPEC: steps 至少 1 个' } }));
      return textResult(JSON.stringify({
        success: true,
        data: { run_id: '20991231-010003-good', suite_name: 'good', project_path: PROJECT, summary: { status: 'PASSED', passed: 1, failed: 0, errors: 0, skipped: 0, total: 1, duration_ms: 5 }, report: paths },
      }));
    });

    await expect(runQa(['nightly', specDir])).rejects.toMatchObject({ code: 1 });

    const out = logs.join('\n');
    expect(out).toContain('bad.json: SPEC ERROR');
    expect(out).toContain('[2/2] good.json: PASSED');
    expect(exitSpy).toHaveBeenCalledWith(1);
    // 失败的 spec 没跑到 run 完成 → 不审计
    expect(appendAuditLine).toHaveBeenCalledTimes(1);
  });

  it('空目录 / 缺参数 → usage + exit 2', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(runQa(['nightly', specDir])).rejects.toMatchObject({ code: 2 });
    await expect(runQa(['nightly'])).rejects.toMatchObject({ code: 2 });
    errSpy.mockRestore();
  });
});

describe('cli qa audit 开关（审查 Important-1）', () => {
  it('GODOT_MCP_AUDIT=false：appendAuditLine 零调用（与 dispatcher 开关语义对称）', async () => {
    const prev = process.env.GODOT_MCP_AUDIT;
    process.env.GODOT_MCP_AUDIT = 'false';
    try {
      arrange([{ specFile: 'ok.json', runId: '20991231-010009-ok', name: 'ok', head: report('20991231-010009-ok', 'ok', [step(0, 'k1', 'PASSED')]) }]);
      await expect(runQa(['nightly', specDir])).rejects.toMatchObject({ code: 0 });
      expect(appendAuditLine).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.GODOT_MCP_AUDIT;
      else process.env.GODOT_MCP_AUDIT = prev;
    }
  });

  it('默认（audit 开）：每套件一次 appendAuditLine（负例，防开关误反）', async () => {
    delete process.env.GODOT_MCP_AUDIT;
    arrange([{ specFile: 'ok.json', runId: '20991231-010010-ok', name: 'ok', head: report('20991231-010010-ok', 'ok', [step(0, 'k1', 'PASSED')]) }]);
    await expect(runQa(['nightly', specDir])).rejects.toMatchObject({ code: 0 });
    expect(appendAuditLine).toHaveBeenCalledTimes(1);
  });
});

describe('CLI flag 前置形态（审查 Important-2）', () => {
  it('qa nightly --json <dir>：--json 前置不混入 positional（specDir 正确解析）', async () => {
    arrange([{ specFile: 'ok.json', runId: '20991231-010020-ok', name: 'ok', head: report('20991231-010020-ok', 'ok', [step(0, 'k1', 'PASSED')]) }]);
    // --json 前置 + --project 后置混合形态
    await expect(runQa(['nightly', '--json', specDir, '--project', PROJECT])).rejects.toMatchObject({ code: 0 });
    // spec_path 仍正确传递（非 '--json'）
    expect(qaHandleTool).toHaveBeenCalledWith('qa', expect.objectContaining({ action: 'run', spec_path: join(specDir, 'ok.json'), project_path: PROJECT }), expect.anything());
  });
});
