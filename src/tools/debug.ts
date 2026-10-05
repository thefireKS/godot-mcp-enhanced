import type { Tool } from "@modelcontextprotocol/server";
import type { ToolContext, ToolResult } from '../types.js';
import { opsErrorResult } from './shared.js';
import type { RiskLevel } from '../core/tool-registry.js';

// ─── debug 组 — Phase 1 断点管理 + Phase 2/3 调试器集成 (editor-only) ──────────
//
// Phase 1 (CMP-3): set/clear/list breakpoint — 走 CodeEdit gutter 路径(同步)。
// Phase 2 (CMP-14): stack_trace/inspect_frame/evaluate — 读栈帧/变量/表达式求值(异步)。
// Phase 3 (CMP-14): step/continue/pause/reload_scripts — 执行控制 + 热重载(异步)。
//
// Phase 2/3 经 EditorDebuggerPlugin 子类(debugger_bridge.gd)与运行中游戏调试会话交互。
// 对标竞品 regiellis/godot-mcp-go 的 debug 组(state/frame/step/resume/pause/reload_scripts)。
//
// Headless mode: 所有 action 硬返回 EDITOR_ONLY — 需要 EditorInterface +
// CodeEdit(Phase 1)+ EditorDebuggerSession(Phase 2/3),均为 editor 专属 API。

const TOOL_NAMES = ['debug'] as const;
export { TOOL_NAMES };

const ACTIONS = [
  // Phase 1(同步)
  'set_breakpoint', 'clear_breakpoint', 'list_breakpoints',
  // Phase 2(异步)
  'stack_trace',        // 读当前断点调用栈 + 当前帧变量
  'inspect_frame',      // 切栈帧 + 读该帧局部变量
  'evaluate',           // 断点上下文表达式求值(REPL)
  // Phase 3(异步)
  'step',               // 单步执行(mode: into/over)
  'continue',           // 继续运行到下一断点
  'pause',              // 请求中断(暂停运行中游戏)
  'reload_scripts',     // 热重载指定脚本到运行中游戏
] as const;

// ─── Tool definitions ──────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'debug',
      description: [
        'Interactive debugger — breakpoint management + Phase 2/3 debugger integration (editor-only).',
        'Phase 1: set/clear/list breakpoint (via the CodeEdit gutter; scripts open automatically since CMP-14).',
        'Phase 2: stack_trace (call stack + variables) / inspect_frame (switch frame + read variables) / evaluate (REPL in the breakpoint context).',
        'Phase 3: step (into/over) / continue (run to the next breakpoint) / pause (request a break) / reload_scripts (hot reload).',
        '⚠️ editor-only: needs GODOT_MCP_MODE=editor + the Godot plugin installed + the game running (F5).',
        '⚠️ Phase 2/3 need the game paused at a breakpoint (step/inspect/evaluate) or running (pause/reload).',
      ].join(' '),
      inputSchema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            enum: [...ACTIONS],
            description: 'Action type: set_breakpoint | clear_breakpoint | list_breakpoints | stack_trace | inspect_frame | evaluate | step | continue | pause | reload_scripts',
          },
          path: {
            type: 'string',
            description: 'set/clear/list: res:// path of the .gd script (opened automatically since CMP-14, no need to activate the tab first)',
          },
          line: {
            type: 'number',
            description: 'set/clear: 1-based line number',
          },
          frame_index: {
            type: 'number',
            description: 'inspect_frame: stack frame index to inspect (0 = innermost, default 0)',
          },
          expression: {
            type: 'string',
            description: 'evaluate: GDScript expression to evaluate in the breakpoint context',
          },
          mode: {
            type: 'string',
            enum: ['into', 'over'],
            description: 'step: step mode (into = step into, over = step over; note: Godot\'s wire protocol has no step out)',
          },
          paths: {
            type: 'array',
            items: { type: 'string' },
            description: 'reload_scripts: array of res:// script paths to hot-reload',
          },
          all_vars: {
            type: 'boolean',
            description: 'stack_trace/inspect_frame: true = return every variable (truncated to 100 by default)',
          },
          filter: {
            type: 'string',
            description: 'stack_trace/inspect_frame: variable name substring filter',
          },
        },
        required: ['action'],
      },
    },
  ];
}

// ─── Tool handler ───────────────────────────────────────────────────────────

export async function handleTool(
  name: string,
  args: Record<string, unknown>,
  _ctx: ToolContext,
): Promise<ToolResult | null> {
  if (name !== 'debug') return null;

  const action = args.action as string;
  if (!action) return opsErrorResult('INVALID_PARAMS', 'action is required');
  if (!(ACTIONS as readonly string[]).includes(action)) {
    return opsErrorResult('INVALID_ACTION', `Unknown action: ${action}. Supported: ${ACTIONS.join(', ')}`);
  }

  // All actions are editor-only: Phase 1 needs EditorInterface + CodeEdit;
  // Phase 2/3 needs EditorDebuggerSession + debugger plugin. All unavailable headless.
  return opsErrorResult(
    'EDITOR_ONLY',
    `Action "${action}" requires Editor mode. Set GODOT_MCP_MODE=editor and install the Godot plugin. ` +
      'Phase 1 (breakpoints) needs EditorInterface + CodeEdit; Phase 2/3 (stack/step/reload) needs a running game with the debugger attached.',
  );
}

// ─── Tool metadata ──────────────────────────────────────────────────────────

export const TOOL_META: Record<
  string,
  { readonly: boolean; long_running: boolean; actionRisks?: Record<string, RiskLevel> }
> = {
  debug: {
    // 组级:含 write action(step/continue/pause/reload),非纯只读
    readonly: false,
    // Phase 2/3 异步操作可能长时(step/reload),标 long_running
    long_running: true,
    actionRisks: {
      // Phase 1(断点是 gutter 操作,不改运行时状态)
      set_breakpoint: 'read',
      clear_breakpoint: 'read',
      list_breakpoints: 'read',
      // Phase 2(读取类)
      stack_trace: 'read',
      inspect_frame: 'read',
      evaluate: 'write',  // P1 (2026-08-11 审查): evaluate 发任意 GDScript expression 到游戏执行
                            // (OS.execute/load/eval/file IO),与 execute_gdscript 等价 RCE 面。原 'read'
                            // 低估威胁(注释"竞品也不 gate"是缺陷非标准)。改 'write' 触发 confirm
                            // (guard.ts:67 非 read 需确认)。注:RiskLevel 无 'execute','write' 等价触发。
                            // 第一层:action-gate('debug.evaluate' ∈ code-execution opt-in gate)。
                            // 第三层(GD 侧 scanGdscriptSandbox)deferred:GD 侧无现成沙箱,需单独实现。
      // Phase 3(执行控制/热重载有副作用)
      step: 'write',
      continue: 'write',
      pause: 'write',
      reload_scripts: 'write',
    } satisfies Record<typeof ACTIONS[number], RiskLevel>,
  },
};
