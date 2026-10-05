import type { Tool } from "@modelcontextprotocol/server";
import type { ToolContext, ToolResult } from '../types.js';
import { opsErrorResult } from './shared.js';
import type { RiskLevel } from '../core/tool-registry.js';

// ─── CMP-4 (2026-08-08): engine 组 — 实时 ClassDB 内省 (editor-only) ──────────
//
// 让 AI 发现运行中引擎的实际可用类/方法/属性/信号/枚举。
// 补静态 docs 工具(extension_api.json 4.7 快照)的缺口:
// - 第三方 addon 注册的 ClassDB 类不在静态 JSON 里
// - 4.6/4.8 build 的 API 差异不在 4.7 快照里
// - 自定义 C# / GDExtension 注册的类不在 JSON 里
//
// 心智模型:静态查 docs / 实时查 engine。docs 是离线快照(4.7),
// engine 是运行中引擎的真实 ClassDB(实际版本 + 第三方 addon + 自定义类)。
//
// Headless mode: 三个 action 硬返回 EDITOR_ONLY — ClassDB 在 gdscript-executor
// 沙箱里被列为危险模式(gdscript-executor.ts:83),实时内省走 editor 层直调(不经沙箱)。

const TOOL_NAMES = ['engine'] as const;
export { TOOL_NAMES };

const ACTIONS = ['class_info', 'search', 'get_inheritance', 'call_method'] as const;

// ─── Tool definitions ──────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'engine',
      description: [
        'Live ClassDB introspection + node method calls (editor-only): query the classes/methods/properties/signals/enums the running engine actually has, or call an instance method on a node in the editor scene tree.',
        'class_info: full structure of one class (properties/methods/signals/enums/inheritance); default no_inherit=true shows only its own members.',
        'search: substring match on class names (returns a {name, parent} list, max 100). Then use class_info for the members.',
        'get_inheritance: the class inheritance chain (from the class up to Object).',
        'call_method: call an instance method on a node in the editor scene tree (like node.call). args are coerced to the declared parameter types ([1,2,3] becomes a Vector3). The deny-list blocks dangerous methods by default (free/queue_free/set_script/call/emit_signal etc.); env GODOT_MCP_EDITOR_CALL_DENYLIST_OVERRIDE adds to it (union with the default list, can only add; an explicit empty string lifts it). Calls cannot be undone (the response says undoable=false).',
        '⚠️ Fills the gap in the docs tool: docs is a static 4.7 snapshot (no third-party addons/custom classes/4.6/4.8 differences), engine is the running engine\'s real ClassDB.',
        '⚠️ editor-only: headless mode returns EDITOR_ONLY (ClassDB is blocked in the sandbox, so it goes through the editor layer).',
      ].join(' '),
      inputSchema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            enum: [...ACTIONS],
            description: 'Action type: class_info | search | get_inheritance | call_method',
          },
          class: {
            type: 'string',
            description: 'class_info/get_inheritance: class name (e.g. Node, Sprite2D, RigidBody3D, or a class registered by a third-party addon)',
          },
          query: {
            type: 'string',
            description: 'search: substring match on class names (case-insensitive)',
          },
          no_inherit: {
            type: 'boolean',
            description: 'class_info: true = own members only (default; walking the inheritance chain buries new APIs); false = merge the inheritance chain',
          },
          node_path: {
            type: 'string',
            description: 'call_method: target node path (e.g. "root/Player", "Player/Sprite2D", relative to the editor scene tree root)',
          },
          method: {
            type: 'string',
            description: 'call_method: method to call (unknown methods get did-you-mean suggestions; the deny-list blocks free/queue_free/set_script/call and other dangerous methods by default)',
          },
          args: {
            type: 'array',
            description: 'call_method: positional argument array (coerced to the declared parameter types, e.g. [1,2,3] for a Vector3). At most 8 arguments',
            items: {},
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
  if (name !== 'engine') return null;

  const action = args.action as string;
  if (!action) return opsErrorResult('INVALID_PARAMS', 'action is required');
  if (!(ACTIONS as readonly string[]).includes(action)) {
    return opsErrorResult('INVALID_ACTION', `Unknown action: ${action}. Supported: ${ACTIONS.join(', ')}`);
  }

  // All actions are editor-only: ClassDB introspection runs in the editor addon
  // (not through the sandboxed gdscript-executor where ClassDB is blocked).
  return opsErrorResult(
    'EDITOR_ONLY',
    `Action "${action}" requires Editor mode. Set GODOT_MCP_MODE=editor and install the Godot plugin. ` +
      'ClassDB introspection runs in the editor addon (not the sandboxed executor).',
  );
}

// ─── Tool metadata ──────────────────────────────────────────────────────────

export const TOOL_META: Record<
  string,
  { readonly: boolean; long_running: boolean; actionRisks?: Record<string, RiskLevel> }
> = {
  engine: {
    // CMP-9-A 后含 call_method(write),组级不再是纯只读。readOnlyHint 由 deriveMcpHints 按 actionRisks 派生。
    readonly: false,
    long_running: false,
    actionRisks: {
      class_info: 'read',
      search: 'read',
      get_inheritance: 'read',
      call_method: 'write',  // CMP-9-A: 方法可能有副作用(deny-list 挡高危,但剩余方法非 readonly)
    } satisfies Record<typeof ACTIONS[number], RiskLevel>,
  },
};
