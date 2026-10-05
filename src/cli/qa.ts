/** qa 命令 — CLI 侧 QA 套件执行 / 报告 / 回归 diff / 夜间跑批（nightly）
 *
 * 用法:
 *   godot-mcp-enhanced qa run <spec.json|spec.md> [--project <path>] [--json]
 *   godot-mcp-enhanced qa nightly <spec-dir> [--project <path>] [--json]
 *   godot-mcp-enhanced qa report [latest|prev|<run_id>]
 *   godot-mcp-enhanced qa diff [base] [head]        （默认 prev vs latest）
 *
 * MCP 工具 qa 的同源 CLI 包装：直接调 tools/qa 的 handleTool（进程内，不起 MCP server），
 * ctx 仿 e2e makeCtx 模式委托 process-state 单例。
 * NIT-7 修复：CLI 直调不经 ToolDispatcher（无 confirm/audit 门），run/nightly 成功后手动
 * appendAuditLine 留痕（best-effort，失败不阻断跑批）——夜间跑批的操作审计可追溯。
 */
import { join } from 'path';
import { readdirSync, readFileSync } from 'fs';
import { opt } from './args.js';
import { makeCtx } from './ctx.js';
import * as qaTool from '../tools/qa/index.js';
import { findPreviousReport, diffReports, type QaReport } from '../tools/qa/report.js';
import { appendAuditLine, isAuditEnabled } from '../core/audit-log.js';

function usage(): void {
  console.log(`godot-mcp-enhanced qa — QA test suites (nightly batch)

Usage:
  qa run <spec> [--project <path>] [--json]   run a suite (.json, or .md with a \`\`\`qa-spec fence)
  qa nightly <spec-dir> [--project <path>] [--json]
                                              runs every *.json/*.md spec in the directory, diffs each suite
                                              against its previous result, and summarises regressions
  qa report [latest|prev|<run_id>]            read a report (default latest)
  qa diff [base] [head]                       regression diff (default prev vs latest)

Exit codes: run/nightly by suite result 0 = all PASSED / 1 = some FAILED; bad arguments 2.`);
}

function parseFlag(rest: string[], name: string): { value?: string; positional: string[] } {
  // F-2/P2-8(2026-08-21 七维度审核,对齐 d20b1ff 实现):值提取走共享 opt(双形式);
  // positional 剥除同步覆盖两种形态
  const bare = name.replace(/^--/, '');
  const out: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === `--${bare}` && rest[i + 1]) {
      i++; // 空格形式:吞 flag+值(对齐原「有值才吞」语义,防误吞 positional)
    } else if (a.startsWith(`--${bare}=`)) {
      // 等号形式:仅吞 flag 本身(此前只认空格形式,--project=<path> 时 value 静默
      // 丢失且 token 混入 positional → QA 对错误项目静默执行)
    } else {
      out.push(a);
    }
  }
  // 审查 Important-2：--json 是无值 flag，前置形态（qa run --json spec.json）不得混入
  // positional（否则 spec_path 被取成 '--json'）。统一在此剥除，各调用点免重复处理。
  return { value: opt(rest, bare), positional: out.filter(a => a !== '--json') };
}

/** 解析 handleTool 的 textResult JSON；返回 {json, isError} */
async function callQa(action: string, args: Record<string, unknown>): Promise<{ json: Record<string, unknown> | null; text: string; isError: boolean }> {
  const res = await qaTool.handleTool('qa', { action, ...args }, makeCtx());
  if (!res) return { json: null, text: 'null result', isError: true };
  const text = res.content[0]?.type === 'text' ? res.content[0].text : '';
  try {
    return { json: JSON.parse(text) as Record<string, unknown>, text, isError: res.isError === true };
  } catch {
    return { json: null, text, isError: res.isError === true };
  }
}

/** NIT-7：CLI 直调不经 dispatcher 的 audit 门，手动留痕（best-effort，失败静默不阻断跑批）。
 * 审查 Important-1：与 dispatcher 写审计点对称检查 isAuditEnabled（GODOT_MCP_AUDIT=false
 * 时用户显式关审计，CLI 路径不得无视——否则 nightly 向用户项目追加写入违背配置意图）。 */
async function auditRun(data: {
  run_id: string; suite_name: string; project_path: string;
  summary: { status: string; duration_ms: number };
}): Promise<void> {
  try {
    if (!isAuditEnabled()) return;
    await appendAuditLine(data.project_path, {
      timestamp: new Date().toISOString(),
      trace_id: `cli-qa-${data.run_id}`,
      tool: 'qa',
      action: 'run',
      risk: 'process',
      ok: data.summary.status === 'PASSED',
      project_path: data.project_path,
      changed_files: [],
      duration_ms: data.summary.duration_ms,
    });
  } catch { /* 审计失败不影响跑批（对齐 G2 catch 哲学） */ }
}

/** run 响应 data 的形态（index.ts handleRun 契约） */
interface RunData {
  run_id: string;
  suite_name: string;
  project_path: string;
  summary: { status: string; passed: number; failed: number; errors: number; skipped: number; total: number; duration_ms: number };
  report: { json_path: string; md_path: string };
}

export async function runQa(args: string[]): Promise<void> {
  const [verb, ...rest] = args;

  if (verb === 'run') {
    const { value: project, positional } = parseFlag(rest, '--project');
    const asJson = rest.includes('--json');
    const specPath = positional[0];
    if (!specPath) {
      usage();
      process.exit(2);
    }
    const runArgs: Record<string, unknown> = { action: 'run', spec_path: specPath };
    if (project) runArgs.project_path = project;
    const { json, text, isError } = await callQa('run', runArgs);
    if (isError || !json || json.success !== true) {
      console.error(text);
      process.exit(2);
    }
    const data = json.data as RunData;
    await auditRun(data);
    if (asJson) {
      console.log(JSON.stringify(json.data, null, 2));
    } else {
      const s = data.summary;
      console.log(`QA ${data.summary.status}: ${s.passed} passed / ${s.failed} failed / ${s.errors} errors / ${s.skipped} skipped (${(s.duration_ms / 1000).toFixed(1)}s)`);
      console.log(`  report: ${data.report.md_path}`);
    }
    process.exit(data.summary.status === 'PASSED' ? 0 : 1);
  }

  if (verb === 'nightly') {
    const { value: project, positional } = parseFlag(rest, '--project');
    const asJson = rest.includes('--json');
    const specDir = positional[0];
    if (!specDir) {
      usage();
      process.exit(2);
    }
    // 安全裁决（审查 Nit-1，对齐 project.ts list_projects search_dir 先例）：specDir 为本地
    // CLI 用户自定目录，不做前置白名单（仅目录文件名元数据枚举，且 CLI 为本地主动运行非
    // MCP 远程面）；每个 spec 的**内容**仍经 handleRun 的 spec_path 白名单校验才执行。
    let files: string[];
    try {
      files = readdirSync(specDir).filter(f => f.endsWith('.json') || f.endsWith('.md')).sort();
    } catch (err) {
      console.error(`spec directory unreadable: ${specDir} (${err instanceof Error ? err.message : String(err)})`);
      process.exit(2);
    }
    if (files.length === 0) {
      console.error(`No spec files (*.json / *.md) in directory: ${specDir}`);
      process.exit(2);
    }

    const results: Array<Record<string, unknown>> = [];
    let anyFailed = false;
    let regressions = 0;
    let fixed = 0;
    for (let i = 0; i < files.length; i++) {
      const f = files[i]!;
      const runArgs: Record<string, unknown> = { action: 'run', spec_path: join(specDir, f) };
      if (project) runArgs.project_path = project;
      const { json, text, isError } = await callQa('run', runArgs);
      if (isError || !json || json.success !== true) {
        // spec 解析/参数错误（套件未跑）：计入失败并继续后续套件
        anyFailed = true;
        results.push({ file: f, error: text.slice(0, 500) });
        if (!asJson) console.log(`[${i + 1}/${files.length}] ${f}: SPEC ERROR — ${text.slice(0, 200)}`);
        continue;
      }
      const data = json.data as RunData;
      await auditRun(data);
      const failed = data.summary.status !== 'PASSED';
      if (failed) anyFailed = true;

      // 与上次同套件结果 diff（首次运行无基线则跳过；基线读取失败不阻断）
      let diff: ReturnType<typeof diffReports> | null = null;
      let baselineBroken = false;
      try {
        const prev = findPreviousReport(data.run_id, data.suite_name);
        if (prev) {
          const head = JSON.parse(readFileSync(data.report.json_path, 'utf8')) as QaReport;
          diff = diffReports(prev, head);
          if (diff.verdict === 'REGRESSED') regressions += diff.regressions.length;
          fixed += diff.fixed.length;
        }
      } catch {
        // Nit-2（审查）：基线读取链（findPreviousReport/基线 JSON/head JSON）失败 ≠ 首次运行；
        // 措辞保持中性（不预设是基线坏还是 head 坏，概率都极窄）
        baselineBroken = true;
      }

      results.push({
        file: f,
        run_id: data.run_id,
        suite: data.suite_name,
        summary: data.summary,
        report: data.report,
        ...(diff ? { diff_vs: diff.base_run_id, diff } : { diff_vs: null }),
      });
      if (!asJson) {
        const s = data.summary;
        console.log(`[${i + 1}/${files.length}] ${f}: ${s.status} (${s.passed}/${s.total} passed, ${(s.duration_ms / 1000).toFixed(1)}s)`);
        console.log(`  report: ${data.report.md_path}`);
        if (diff) {
          console.log(`  vs previous ${diff.base_run_id}: ${diff.verdict} (regressions:${diff.regressions.length} fixed:${diff.fixed.length} added:${diff.added.length} removed:${diff.removed.length})`);
          for (const r of diff.regressions) {
            console.log(`    REGRESSION  ${r.case}${r.head_detail ? ` — ${r.head_detail.slice(0, 120)}` : ''}`);
          }
        } else if (baselineBroken) {
          console.error(`  vs previous: (failed to read the baseline/head report, diff skipped — check the JSON in the qa-reports directory)`);
        } else {
          console.log('  vs previous: (first run, no baseline)');
        }
      }
    }

    const passedCount = results.filter(r => (r.summary as RunData['summary'] | undefined)?.status === 'PASSED').length;
    if (asJson) {
      console.log(JSON.stringify({ suites: results.length, passed: passedCount, failed: results.length - passedCount, regressions, fixed, results }, null, 2));
    } else {
      console.log(`\nnightly summary: ${results.length} suites · ${passedCount} PASSED / ${results.length - passedCount} FAILED · regressions ${regressions} · fixed ${fixed}`);
    }
    process.exit(anyFailed ? 1 : 0);
  }

  if (verb === 'report') {
    const { json, text, isError } = await callQa('report', { action: 'report', report_path: rest[0] ?? 'latest' });
    if (isError || !json || json.success !== true) {
      console.error(text);
      process.exit(2);
    }
    console.log(JSON.stringify((json.data as { report: unknown }).report, null, 2));
    return;
  }

  if (verb === 'diff') {
    const { json, text, isError } = await callQa('diff', {
      action: 'diff',
      base_path: rest[0] ?? 'prev',
      head_path: rest[1] ?? 'latest',
    });
    if (isError || !json || json.success !== true) {
      console.error(text);
      process.exit(2);
    }
    const d = json.data as { verdict: string; regressions: unknown[]; fixed: unknown[]; added: unknown[]; removed: unknown[]; base_run_id: string; head_run_id: string };
    console.log(`diff ${d.base_run_id} → ${d.head_run_id}: ${d.verdict}`);
    console.log(`  regressions: ${d.regressions.length}, fixed: ${d.fixed.length}, added: ${d.added.length}, removed: ${d.removed.length}`);
    for (const r of d.regressions as { case: string; head_detail?: string }[]) {
      console.log(`  REGRESSION  ${r.case}${r.head_detail ? ` — ${r.head_detail}` : ''}`);
    }
    process.exit(d.verdict === 'REGRESSED' ? 1 : 0);
  }

  usage();
  process.exit(2);
}
