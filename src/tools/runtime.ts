import { spawn, type ChildProcess } from 'child_process';
import { opsErrorResult } from './shared.js';
import type { Tool } from "@modelcontextprotocol/server";
import type { ToolContext, ToolResult } from '../types.js';
import { textResult, errorResult } from '../types.js';
import { appendOutput, clearOutputBuffer, killProcess, forceKillTree, setProcessBusy, acquireProcessSlot, acquireShortRunningSlot, releaseShortRunningSlot, buildBusyErrorMessage, killOrphanGodotProcesses, registerSpawnedGodotPid, unregisterSpawnedGodotPid } from '../core/process-state.js';
import { requireProjectPath, checkVersionMismatch, buildSafeEnv } from '../helpers.js';
import { isBridgeReady } from './game-bridge.js';
import { detectGodotVersion } from '../core/godot-finder.js';
import { handleRecordingAction } from './recording.js';
import { existsSync } from 'fs';
import { join } from 'path';
import { getLogger } from '../core/logger.js';
import type { RiskLevel } from '../core/tool-registry.js';

const ACTIONS = [
  'launch_editor',
  'run_project',
  'stop_project',
  'get_debug_output',
  'run_tests',
  'get_godot_version',
  // ── Recording actions (merged from recording.ts, v0.18.0) ──
  'record_start',
  'record_stop',
  'record_save',
  'record_load',
  'record_play',
] as const;

// ─── classifyOutput helper ──────────────────────────────────────────────────

// A-06: Use precise pattern matching to avoid false positives like "no errors found"
const ERROR_PATTERNS = [
  /^\s*error:/i,           // "ERROR:" or "  error:" at line start
  /\berror\b(?!\s+found)/i, // "error" but not "error found" or "errors found"
  /traceback/i,
  /exception/i,
  /SCRIPT ERROR/i,
  /\*\*ERROR\*\*/i,
];

const WARN_PATTERNS = [
  /^\s*warn(?:ing)?:/i,    // "WARNING:" or "warn:" at line start
  /\bwarn(?:ing)?\b(?!\s+found)/i, // "warning"/"warn" but not "warning found" or "warnings found"
  /\*\*WARNING\*\*/i,
];

function classifyOutput(lines: string[]): {
  errors: string[];
  warnings: string[];
  prints: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];
  const prints: string[] = [];

  for (const line of lines) {
    if (ERROR_PATTERNS.some(p => p.test(line))) {
      errors.push(line);
    } else if (WARN_PATTERNS.some(p => p.test(line))) {
      warnings.push(line);
    } else {
      prints.push(line);
    }
  }

  return { errors, warnings, prints };
}

// ─── Tool definitions ──────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'runtime',
      description: 'Launch the editor, run/stop the project, get debug output, run tests, get the Godot version.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            enum: ['launch_editor', 'run_project', 'stop_project', 'get_debug_output', 'run_tests', 'get_godot_version', 'record_start', 'record_stop', 'record_save', 'record_load', 'record_play'],
            description: 'Operation',
          },
          project_path: { type: 'string', description: 'Godot project directory (optional; defaults to the GODOT_PROJECT_PATH env var or the current directory)' },
          timeout: { type: 'number', description: 'Auto-stop after N seconds (default 30; pass more, e.g. 120, for games with a >30s cold start; with wait_for_bridge it becomes max(bridge_timeout+10, timeout) to avoid racing bridge readiness)', default: 30 },
          wait_for_bridge: { type: 'boolean', default: false, description: 'When true, poll for bridge readiness after spawning (default false, backwards compatible)' },
          bridge_timeout: { type: 'number', default: 10, description: 'Total polling budget for wait_for_bridge (seconds, default 10)' },
          test_script: { type: 'string', description: 'Test script or directory path (default res://test/)', default: 'res://test/' },
          quit_flag: { type: 'string', enum: ['gquit', 'gexit'], default: 'gquit', description: 'GUT quit flag for run_tests. Default gquit (GUT ≤9.5); switch to gexit when GUT 9.6+ dropped -gquit (it reports Unknown arguments: -gquit)' },
          // ── Recording parameters (merged, v0.18.0) ──
          events_json: { type: 'string', description: 'Recording: event sequence as a JSON string' },
          file_name: { type: 'string', description: 'Recording save: always auto-named recording_YYYYMMDD_HHmmss.json (the file_name input is ignored), but file_name must still match recording_*.json (otherwise INVALID_FILE_NAME) and must not contain / \\\\ ..' },
          speed: { type: 'number', description: 'Recording: replay speed multiplier (default 1.0)' },
          load_autoloads: { type: 'boolean', description: 'Load the Autoload context (default true)' },
          godot_path: { type: 'string', description: 'Override the Godot binary path (optional; takes precedence over project config and env vars)' },
        },
        required: ['action'],
      },
    },
  ];
}

// ─── Helpers ────────────────────────────────────────────────────────────────

// computeRunTimeout:run_project 的 auto-stop timeout 计算(提取为纯函数便于测试)。
// wait_for_bridge 时 timeout 至少 bridge_timeout + 10,防 auto-stop 与 bridge 就绪 race
// (修复前默认 timeout=30 与 bridge_timeout=30 同量级,游戏在 bridge 就绪前被 auto-stop kill)。
export function computeRunTimeout(rawTimeout: unknown, bridgeTimeout: number, waitForBridge: boolean): number {
  const base = Math.max(5, Number(rawTimeout) || 30);
  return waitForBridge ? Math.max(bridgeTimeout + 10, base) : base;
}

// ─── Tool handler ───────────────────────────────────────────────────────────

export async function handleTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult | null> {
  if (name !== 'runtime') return null;
  const action = args.action as string;
  if (!(ACTIONS as readonly string[]).includes(action)) return opsErrorResult('UNKNOWN_ACTION', `Unknown action: ${action}`);

  switch (action) {
    case 'launch_editor': {
      const p = requireProjectPath(args);
      if (!existsSync(join(p, 'project.godot'))) {
        return textResult(`Error: Not a Godot project (no project.godot found): ${p}`);
      }
      const godot = await ctx.findGodot();
      const child = spawn(godot, ['--editor', '--path', p], { detached: true, stdio: 'ignore', env: buildSafeEnv() });
      child.on('error', (err) => {
        getLogger().error('runtime', `Failed to launch editor: ${err.message}`);
      });
      child.unref();
      return textResult(`Launched Godot editor for project: ${p}`);
    }

    case 'run_project': {
      const p = requireProjectPath(args);
      if (!existsSync(join(p, 'project.godot'))) {
        return textResult(`Error: Not a Godot project (no project.godot found): ${p}`);
      }
      const waitForBridge = args.wait_for_bridge === true;
      const bridgeTimeout = Math.max(1, Number(args.bridge_timeout) || 10);
      const timeout = computeRunTimeout(args.timeout, bridgeTimeout, waitForBridge);
      const godot = await ctx.findGodot();

      // Version mismatch warning
      const versionWarning = await checkVersionMismatch(p, godot);
      const warnPrefix = versionWarning ? versionWarning + '\n' : '';

      // Stop existing
      if (ctx.runningProcess) {
        setProcessBusy(false);
        await killProcess(ctx.runningProcess);
        ctx.setRunningProcess(null);
      }

      // Atomically acquire the process slot after clearing any existing process
      if (!await acquireProcessSlot('run_project')) {
        return textResult(buildBusyErrorMessage());
      }

      ctx.setProjectDir(p);
      clearOutputBuffer();
      ctx.setProcessStartTime(Date.now());

      // P1.1: spawn() 同步抛异常时,:178 的 'error' handler 尚未注册 → 必须主动释放槽,
      // 否则 :140 acquireProcessSlot 获取的 busy 槽永久泄漏,后续 run_project 永远 busy。
      let proc: ChildProcess;
      try {
        proc = spawn(godot, ['--path', p, '--debug'], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: buildSafeEnv(),
        });
      } catch (err) {
        setProcessBusy(false);
        ctx.setRunningProcess(null);
        const msg = err instanceof Error ? err.message : String(err);
        appendOutput([`Spawn error: ${msg}`]);
        return textResult(`Error: failed to spawn Godot: ${msg}`);
      }

      proc.stdout?.on('data', (data: Buffer) => {
        appendOutput(data.toString().split('\n'));
      });
      proc.stderr?.on('data', (data: Buffer) => {
        appendOutput(data.toString().split('\n'));
      });

      // Auto-stop after timeout
      let autoStopTimer: ReturnType<typeof setTimeout> | undefined;
      if (timeout > 0) {
        autoStopTimer = setTimeout(() => {
          if (ctx.runningProcess === proc) {
            setProcessBusy(false);
            void killProcess(proc);
            ctx.setRunningProcess(null);
          }
          if (proc.pid) unregisterSpawnedGodotPid(proc.pid);  // 守卫外：该 proc 退出即移除自身 pid
        }, timeout * 1000);
      }

      proc.on('close', () => {
        // Imp-4 (2026-06-24 审查): 守卫同 autoStopTimer(:169),避免进程被替换后误清新进程的 busy/running 状态
        if (ctx.runningProcess === proc) {
          setProcessBusy(false);
          ctx.setRunningProcess(null);
        }
        if (proc.pid) unregisterSpawnedGodotPid(proc.pid);  // 守卫外（ADVISORY-3）：旧 proc 被替换时守卫 false 但仍需移除
        if (autoStopTimer) clearTimeout(autoStopTimer);
      });

      proc.on('error', (err) => {
        // Imp-4: 同上守卫
        if (ctx.runningProcess === proc) {
          setProcessBusy(false);
          ctx.setRunningProcess(null);
        }
        if (proc.pid) unregisterSpawnedGodotPid(proc.pid);  // 守卫外
        if (autoStopTimer) clearTimeout(autoStopTimer);
        appendOutput([`Spawn error: ${err.message}`]);
      });

      ctx.setRunningProcess(proc, true); // skip busy check — slot acquired via acquireProcessSlot above
      if (proc.pid) registerSpawnedGodotPid(proc.pid);

      if (waitForBridge) {
        // M3: 显式命名 ms(isBridgeReady 接收 ms;bridgeTimeout 是秒,见 :130)
        const bridgeTimeoutMs = bridgeTimeout * 1000;
        const r = await isBridgeReady(p, bridgeTimeoutMs, {
          proc,
          isCancelled: () => ctx.runningProcess !== proc,
        });
        if (!r.ready) {
          // 问题 2 修复:bridge 未就绪 → isError(此前 textResult isError:false 误报,
          // 到 game_query ping 才暴露 BRIDGE_NOT_CONNECTED)。清理进程(游戏无 bridge 无用)。
          if (ctx.runningProcess === proc) {
            setProcessBusy(false);
            void killProcess(proc);
            ctx.setRunningProcess(null);
          }
          return errorResult(`${warnPrefix}Bridge not ready (${r.reason}). Game stopped. timeout=${timeout}s, bridge_timeout=${bridgeTimeout}s. 确认已 game_bridge_install 且游戏运行.`);
        }
        // P1-6 关联修复(2026-08-21 七维度审核): "Bridge ready." 是 bridge-session.ts /
        // qa/runner.ts 的 load-bearing 判据(子串匹配),仅在真的探测过 isBridgeReady 后
        // 才宣称——此前 wait_for_bridge=false(默认)时也无条件假宣称,误导直接调工具的 AI。
        return textResult(warnPrefix + 'Bridge ready. ' + `Running project at ${p} (timeout: ${timeout}s). Use get_debug_output or stop_project to check.`);
      }
      return textResult(warnPrefix + `Running project at ${p} (timeout: ${timeout}s; bridge not probed — wait_for_bridge=false). Use game_query(method="ping") to check bridge, or get_debug_output / stop_project.`);
    }

    case 'stop_project': {
      if (!ctx.runningProcess) {
        // V-01 second layer: scan for orphaned Godot processes
        const rawPath = args.project_path;
        const projectDir = (typeof rawPath === 'string' && rawPath.length > 0 ? rawPath : '') || ctx.projectDir || '';
        const orphanKilled = await killOrphanGodotProcesses(projectDir);
        if (orphanKilled > 0) {
          return textResult(`Cleaned up ${orphanKilled} orphaned Godot process(es) from this session.`);
        }
        return textResult('No project is currently running.');
      }
      await killProcess(ctx.runningProcess);
      setProcessBusy(false);
      ctx.setRunningProcess(null);

      const classified = classifyOutput(ctx.outputBuffer);
      // I-10: Guard against processStartTime=0 producing absurd runtime values
      const runtimeMs = ctx.processStartTime > 0 ? Date.now() - ctx.processStartTime : 0;
      const result = {
        status: 'stopped',
        runtime: `${(runtimeMs / 1000).toFixed(1)}s`,
        errors: classified.errors,
        warnings: classified.warnings,
        prints: classified.prints.slice(-50),
        total_lines: ctx.outputBuffer.length,
      };
      clearOutputBuffer();
      return textResult(JSON.stringify(result, null, 2));
    }

    case 'get_debug_output': {
      if (ctx.outputBuffer.length === 0 && !ctx.runningProcess) {
        return textResult('No debug output available. Run a project first.');
      }
      const classified = classifyOutput(ctx.outputBuffer);
      const debugRuntimeMs = ctx.processStartTime > 0 ? Date.now() - ctx.processStartTime : 0;
      const result = {
        running: ctx.runningProcess !== null,
        runtime: `${(debugRuntimeMs / 1000).toFixed(1)}s`,
        errors: classified.errors,
        warnings: classified.warnings,
        prints: classified.prints.slice(-50),
        total_lines: ctx.outputBuffer.length,
      };
      return textResult(JSON.stringify(result, null, 2));
    }

    case 'run_tests': {
      const p = requireProjectPath(args);
      if (!existsSync(join(p, 'project.godot'))) {
        return textResult(`Error: Not a Godot project (no project.godot found): ${p}`);
      }
      if (!acquireShortRunningSlot()) return textResult('Error: too many concurrent headless operations (max 3). Please wait and retry.');
      const rawTestScript = (args.test_script as string) || 'res://test/';
      // I-SEC-08: Validate test_script starts with res:// to prevent filesystem traversal
      if (!rawTestScript.startsWith('res://')) {
        releaseShortRunningSlot();
        return textResult(`Error: test_script must start with "res://", got: "${rawTestScript}"`);
      }
      const testScript = rawTestScript;
      const godot = await ctx.findGodot();
      // A4 (2026-07-04 反馈): GUT 退出标志参数化。默认 -gquit(GUT ≤9.5 惯例,GUT 9.6+ 移除);
      // 白名单二选一,非法值回落 gquit(值只拼进 spawn args 数组,无注入面,白名单是行为兜底)。
      const quitFlag = args.quit_flag === 'gexit' ? 'gexit' : 'gquit';

      return new Promise((resolve) => {
        let settled = false;
        const proc = spawn(godot, [
          '--headless', '--path', p,
          '--script', 'addons/gut/gut_cmdln.gd',
          '-gdir', testScript,
          `-${quitFlag}`,
        ], { stdio: ['pipe', 'pipe', 'pipe'], env: buildSafeEnv() });
        // P1-1: 注册到 _spawnedGodotPids，close/崩溃可清理 in-flight run_tests spawn。
        // 原 only-run_project 注册（runtime.ts:224）致 close() 清不到 run_tests 进程 +
        // 非 detached 非 unref 阻止 Node 退出最多 120s。对齐 gdscript-executor.ts:1198-1199。
        // 系 07-29 P1-② gdscript-executor spawn orphan 修复的遗漏分支。
        if (proc.pid) registerSpawnedGodotPid(proc.pid);
        const unregisterSpawn = () => { if (proc.pid) unregisterSpawnedGodotPid(proc.pid); };

        let out = '';
        const MAX_OUTPUT = 500_000;
        proc.stdout?.on('data', (d: Buffer) => { if (out.length < MAX_OUTPUT) out += d.toString(); });
        proc.stderr?.on('data', (d: Buffer) => { if (out.length < MAX_OUTPUT) out += d.toString(); });

        const timer = setTimeout(() => {
          if (!settled && !proc.killed) {
            settled = true;
            forceKillTree(proc);
            unregisterSpawn();  // P1-1: timeout 强杀后注销（exit 事件可能不触发）
            releaseShortRunningSlot();
            resolve(textResult('run_tests timed out after 120s'));
          }
        }, 120000);

        proc.on('close', (code) => {
          clearTimeout(timer);
          if (settled) return;
          settled = true;
          unregisterSpawn();  // P1-1: 正常 close 注销 PID
          releaseShortRunningSlot();
          const passed = (out.match(/Tests: (\d+)/g) || []).map(m => m.replace('Tests: ', ''));
          const failed = (out.match(/Failed: (\d+)/g) || []).map(m => m.replace('Failed: ', ''));
          // I-11: Truncate raw_output to prevent excessive MCP channel bandwidth
          const MAX_RAW_OUTPUT = 50_000;
          const rawOutput = out.length > MAX_RAW_OUTPUT
            ? out.slice(0, MAX_RAW_OUTPUT) + `\n... [truncated, ${out.length} total bytes]`
            : out;
          resolve({
            content: [{
              type: 'text',
              text: JSON.stringify({
                exit_code: code,
                passed: passed.join(', '),
                failed: failed.join(', '),
                raw_output: rawOutput,
              }, null, 2),
            }],
          });
        });

        proc.on('error', (err) => {
          clearTimeout(timer);
          if (settled) return;
          settled = true;
          unregisterSpawn();  // P1-1: spawn 错误（ENOENT 等）注销 PID
          releaseShortRunningSlot();
          resolve({ content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true });
        });
      });
    }

    case 'get_godot_version': {
      if (!acquireShortRunningSlot()) return textResult('Error: too many concurrent headless operations (max 3). Please wait and retry.');
      try {
        const godot = await ctx.findGodot();
        const v = await detectGodotVersion(godot);
        return textResult(v);
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true };
      } finally {
        releaseShortRunningSlot();
      }
    }

    // ── Recording actions (merged from recording.ts, v0.18.0) ──
    case 'record_start':
    case 'record_stop':
    case 'record_save':
    case 'record_load':
    case 'record_play': {
      return handleRecordingAction(action, args, ctx);
    }

    default:
      return opsErrorResult('UNKNOWN_ACTION', `Unknown action: ${action}`);
  }
}

export const TOOL_META: Record<
  string,
  { readonly: boolean; long_running: boolean; actionRisks?: Record<string, RiskLevel> }
> = {
  runtime: {
    readonly: false,
    long_running: true,
    actionRisks: {
      get_debug_output: 'read',
      get_godot_version: 'read',
      record_load: 'read',
      launch_editor: 'process',
      run_project: 'process',
      stop_project: 'process',
      run_tests: 'process',
      record_start: 'write',
      record_stop: 'write',
      record_save: 'write',
      record_play: 'write',
    } satisfies Record<typeof ACTIONS[number], RiskLevel>,
  },
};
