import type { Tool } from "@modelcontextprotocol/server";

// src/tools/manage-tools.ts — manage_tools meta-tool (Task 4)
//
// Always-available tool for dynamically managing tool group activation.
// Belongs to the protected 'core' group and cannot be deactivated.
import type { RiskLevel } from '../core/tool-registry.js';
import type { ToolContext, ToolResult } from '../types.js';
import { textResult } from '../types.js';
import type { ConnectionState } from '../types.js';
import {
  TOOL_GROUPS,
  setActiveGroups,
  getActiveGroups,
  notifyToolsChanged,
  LEGACY_TOOL_MAP,
} from '../core/tool-registry.js';
import { opsSuccess, opsError } from './shared.js';

// ─── Constants ─────────────────────────────────────────────────────────────

const ACTIONS = ['list_groups', 'activate', 'deactivate', 'sync', 'reconnect', 'migrate'] as const;

type ManageAction = (typeof ACTIONS)[number];

export interface ConnectionStatus {
  editor: { installed: boolean; connected: boolean; state: ConnectionState | null };
  bridge: { note: string };
}

/** Optional callback fired when groups change (set by GodotServer). */
let _onGroupsChanged: (() => void) | null = null;

/** Connection status provider (set by GodotServer). */
let _connectionStatusProvider: (() => ConnectionStatus) | null = null;

/** Reconnect editor handler (set by GodotServer). */
let _reconnectEditor: (() => Promise<{ connected: boolean; detail: string }>) | null = null;

/** Set notification callback (called by GodotServer). */
export function setOnGroupsChanged(fn: (() => void) | null): void {
  _onGroupsChanged = fn;
}

/** Set connection status provider (called by GodotServer). */
export function setConnectionStatusProvider(fn: (() => ConnectionStatus) | null): void {
  _connectionStatusProvider = fn;
}

/** Set reconnect editor handler (called by GodotServer). */
export function setReconnectEditor(fn: (() => Promise<{ connected: boolean; detail: string }>) | null): void {
  _reconnectEditor = fn;
}

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'manage_tools',
      description:
        'Enable/disable tool groups dynamically. Always available, cannot be disabled. ' +
        'Supports list_groups (list all groups), activate (enable groups), deactivate (disable groups), sync (sync connection state), reconnect (reconnect manually).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            enum: [...ACTIONS],
            description: 'Operation',
          },
          groups: {
            type: 'array',
            items: { type: 'string' },
            description: 'Target group names (activate/deactivate)',
          },
        },
        required: ['action'],
      },
    },
  ];
}

export async function handleTool(
  toolName: string,
  args: Record<string, unknown>,
  _ctx: ToolContext,
): Promise<ToolResult | null> {
  if (toolName !== 'manage_tools') return null;

  const action = args.action as ManageAction;

  switch (action) {
    case 'list_groups': return handleListGroups();
    case 'activate': return handleActivate(args);
    case 'deactivate': return handleDeactivate(args);
    case 'sync': return handleSync();
    case 'reconnect': return await handleReconnect();
    case 'migrate': return handleMigrate();
    default:
      return textResult(JSON.stringify(opsError('INVALID_ACTION', `Unknown action: ${action}`)));
  }
}

function handleListGroups(): ToolResult {
  const active = getActiveGroups();
  const groups = Object.entries(TOOL_GROUPS).map(([name, def]) => ({
    name,
    description: def.description,
    active: active.has(name),
    protected: def.protected ?? false,
    requires: def.requires,
    toolCount: def.tools.length,
  }));
  return textResult(JSON.stringify(opsSuccess({ groups })));
}

function handleActivate(args: Record<string, unknown>): ToolResult {
  const targetGroups = (args.groups as string[]) ?? [];
  if (targetGroups.length === 0) {
    return textResult(JSON.stringify(opsError('MISSING_GROUPS', 'groups array is required for activate')));
  }
  const current = getActiveGroups();
  const updated = new Set(current);
  for (const g of targetGroups) {
    if (TOOL_GROUPS[g]) updated.add(g);
  }
  setActiveGroups(updated);
  _onGroupsChanged?.();
  notifyToolsChanged();
  return textResult(JSON.stringify(opsSuccess({
    activated: targetGroups,
    activeGroups: [...updated],
  })));
}

function handleDeactivate(args: Record<string, unknown>): ToolResult {
  const targetGroups = (args.groups as string[]) ?? [];
  if (targetGroups.length === 0) {
    return textResult(JSON.stringify(opsError('MISSING_GROUPS', 'groups array is required for deactivate')));
  }
  // Reject attempts to deactivate protected groups
  const protectedNames = targetGroups.filter(g => TOOL_GROUPS[g]?.protected);
  if (protectedNames.length > 0) {
    return textResult(JSON.stringify(opsError(
      'PROTECTED_GROUP',
      `Cannot deactivate protected groups: ${protectedNames.join(', ')}`,
    )));
  }
  const current = getActiveGroups();
  const updated = new Set(current);
  for (const g of targetGroups) updated.delete(g);
  setActiveGroups(updated);
  _onGroupsChanged?.();
  notifyToolsChanged();
  return textResult(JSON.stringify(opsSuccess({
    deactivated: targetGroups,
    activeGroups: [...updated],
  })));
}

async function handleReconnect(): Promise<ToolResult> {
  let editor: { reconnected: boolean; detail: string } | null;
  if (_reconnectEditor) {
    const r = await _reconnectEditor();
    editor = { reconnected: r.connected, detail: r.detail };
  } else {
    editor = null;
  }
  return textResult(JSON.stringify(opsSuccess({
    editor,
    bridge: { reconnected: false, detail: 'bridge 每请求建连,无需重连;用 game_query(method=ping) 探测' },
  })));
}

function handleSync(): ToolResult {
  const provider = _connectionStatusProvider;
  // M1: provider() 提循环外。原 groups.map 内每 group 调一次 + editor/bridge 各一次(N+2),
  // provider=buildConnectionStatus 同步无 I/O 故无害,但单次调用更清晰且避免重复构造。
  const cs = provider ? provider() : null;
  const groups = Object.entries(TOOL_GROUPS).map(([name, def]) => {
    const requires = def.requires ?? [];
    let status: string;
    if (!cs) {
      status = 'unknown (no provider)';
    } else {
      if (requires.includes('editor')) status = cs.editor.connected ? 'connected' : 'disconnected';
      else if (requires.includes('bridge')) status = 'probe-required';
      else status = 'n/a';
    }
    return { name, requires, status };
  });
  return textResult(JSON.stringify(opsSuccess({
    groups,
    editor: cs?.editor ?? null,
    bridge: cs?.bridge ?? null,
  })));
}

export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean; actionRisks?: Record<string, RiskLevel> }> = {
  manage_tools: {
    readonly: true,
    long_running: false,
    actionRisks: {
      list_groups: 'read',
      sync: 'read',
      reconnect: 'read',
      migrate: 'read',
      activate: 'write',
      deactivate: 'write',
    } satisfies Record<typeof ACTIONS[number], RiskLevel>,
  },
};

function handleMigrate(): ToolResult {
  const mapping: Record<string, { tool: string; action: string }> = {};
  const renamed: Record<string, string> = {};
  const removed: string[] = [];
  const unchanged = ['confirm_and_execute', 'godot_advanced_tool', 'manage_tools', 'godot_list_instances', 'godot_select_instance'];

  for (const [oldName, target] of Object.entries(LEGACY_TOOL_MAP)) {
    mapping[oldName] = target;
    removed.push(oldName);
    if (oldName.includes('_')) {
      renamed[oldName] = `${target.tool}(action="${target.action}")`;
    }
  }

  return textResult(JSON.stringify(opsSuccess({
    version: '0.18.0',
    description: 'Migration map from old tool names to new (tool, action)',
    mapping,
    renamed,
    removed,
    unchanged,
  })));
}

// ─── 纯工厂(供 GodotServer 接线,可单测)────────────────────────────────────

export interface EditorConnLike {
  isConnected(): boolean;
  connect(): Promise<void>;
  /** C-RECONNECT-1: 可选,EditorConnection 实现。buildReconnectEditor connect 失败时启动后台重连循环。 */
  requestReconnect?(): void;
}
export interface HealthMonitorLike {
  getState(): ConnectionState;
}

export function buildConnectionStatus(
  editorConn: EditorConnLike | null,
  healthMonitor: HealthMonitorLike | null,
): ConnectionStatus {
  return {
    editor: {
      installed: editorConn !== null,
      connected: editorConn?.isConnected() ?? false,
      // M5: state 结合 connected。healthMonitor 默认 'connected'(基于工具调用健康,非 editor 连接),
      // 直接用作 editor.state 会在 editor 未连时报 "connected"(observed: state:"connected" 但 connected:false)。
      // editor 连上时 state 才用 healthMonitor(工具健康);未连报 disconnected;未启动报 null。
      state: (editorConn?.isConnected() ?? false)
        ? (healthMonitor?.getState() ?? 'connected')
        : (editorConn ? 'disconnected' : null),
    },
    bridge: { note: '每请求建连,无持久连接' },
  };
}

export function buildReconnectEditor(
  getEditor: () => EditorConnLike | null,
  rebuild?: () => Promise<{ connected: boolean; detail: string }>,
): () => Promise<{ connected: boolean; detail: string }> {
  return async () => {
    const ec = getEditor();
    if (!ec) {
      // 方案B: ec=null(editor 降级)且注入了 rebuild → 尝试重建连接(重新读 secret + new EditorConnection)。
      if (rebuild) {
        try {
          return await rebuild();
        } catch (e) {
          return { connected: false, detail: `重建失败: ${e instanceof Error ? e.message : String(e)}` };
        }
      }
      // 无 rebuild(向后兼容):中性表述 + 恢复指引。
      // 审查 IMPORTANT-3: ec=null 无法区分"从未安装"与"曾连接后降级",故不断言"未安装"
      // (降级时 editor 可能已装)。未启动→launch_editor/F5;降级→重启服务端。
      return { connected: false, detail: 'editor 未连接(可能未启动或已降级到 headless)。用 launch_editor / F5 启动编辑器;若已在运行,重启 MCP 服务端恢复' };
    }
    if (ec.isConnected()) return { connected: true, detail: '已连接' };
    // CMP-8 (2026-08-08): 按连接状态返回差异化恢复指引(AI 拿到精准诊断而非泛化提示)
    const state = 'getState' in ec ? (ec as { getState(): ConnectionState }).getState() : null;
    try {
      await ec.connect();
      return { connected: ec.isConnected(), detail: '手动重连完成' };
    } catch (e) {
      // C-RECONNECT-1: connect 一次性失败(编辑器暂未 ready/耗尽后)时启动后台自动重连循环,
      // 编辑器恢复后自动连上。避免用户须反复手动 reconnect 或重启 MCP 服务端。
      ec.requestReconnect?.();
      const errMsg = e instanceof Error ? e.message : String(e);
      // CMP-8: 按 state 给差异化 hint
      let hint = '已启动后台重试,编辑器恢复后自动连';
      if (state === 'reconnecting') hint = '自动重连进行中,编辑器恢复后自动连上,无需反复手动 reconnect';
      else if (state === 'degraded') hint = '连接降级(近有工具失败),编辑器可能卡住;若 launch_editor 后仍失败,重启 MCP 服务端';
      else if (state === 'disconnected') hint = '编辑器未运行,用 launch_editor / F5 启动;若已在运行,重启 MCP 服务端恢复';
      return { connected: false, detail: `重连失败(${hint}): ${errMsg}` };
    }
  };
}
