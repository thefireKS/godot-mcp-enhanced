// src/tools/audit.ts
/**
 * audit — 操作审计日志查询工具(G3,2026-08-13)。
 * action=get_log 读 {project}/.godot/mcp_audit.jsonl 统计回放;
 * action=suggest_rollback 对指定条目给诚实回滚建议(create 可删/project.godot before/其余 Git)。
 * 只读工具(审计数据由 ToolDispatcher 的 audit after middleware 自动落盘,见 audit-log.ts)。
 */
import type { Tool } from '@modelcontextprotocol/server';
import type { ToolResult, ToolContext } from '../types.js';
import { textResult } from '../types.js';
import { opsSuccess, opsErrorResult } from './shared.js';
import { readAuditLog, suggestRollback, AUDIT_LOG_REL } from '../core/audit-log.js';
import { resolveProjectPath } from '../core/path-utils.js';
import { join } from 'path';

// C-1 (2026-08-14): 导出 TOOL_NAMES 供 scripts/check-tool-groups.mjs 归组对账。
// 此前不导出 → 正则提取型守门扫描不到 audit → 游离 TOOL_GROUPS 未被发现(第 4 次同类盲区)。
const TOOL_NAMES = ['audit'] as const;
export { TOOL_NAMES };

export function getToolDefinitions(): Tool[] {
  return [{
    name: 'audit',
    description: 'Operation audit log (G3). action=get_log reads {project}/.godot/mcp_audit.jsonl as stats and replay '
      + '(operation counts / risk highlights / recent entries / time range); action=suggest_rollback gives an honest rollback suggestion for one entry '
      + '(created files can be deleted / project.godot before_values / everything else via Git). Write/destructive operations are logged automatically by the audit '
      + 'after-middleware (changed_files are project-relative, PII guarded).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['get_log', 'suggest_rollback'],
          description: 'get_log = stats and replay; suggest_rollback = rollback suggestion for one entry',
        },
        project_path: { type: 'string', description: 'Project path (default: auto-resolved by resolveProjectPath)' },
        limit: { type: 'number', description: 'get_log: take the last N entries (default all)' },
        since: { type: 'string', description: 'get_log: ISO time filter (only entries after it)' },
        entry_index: { type: 'number', description: 'suggest_rollback: entry index (from get_log entries[].index)' },
      },
      required: ['action'],
    },
  }];
}

export async function handleTool(
  toolName: string,
  args: Record<string, unknown>,
  _ctx: ToolContext,
): Promise<ToolResult | null> {
  if (toolName !== 'audit') return null;
  const action = args.action as string;
  const projectPath =
    (typeof args.project_path === 'string' && args.project_path) || resolveProjectPath();
  if (!projectPath) {
    return opsErrorResult(
      'INVALID_PARAMS',
      'project_path required (pass explicitly or run from a Godot project)',
    );
  }
  try {
    if (action === 'get_log') {
      const summary = await readAuditLog(projectPath, {
        limit: typeof args.limit === 'number' ? args.limit : undefined,
        since: typeof args.since === 'string' ? args.since : undefined,
      });
      return textResult(
        JSON.stringify(
          opsSuccess(summary, [
            `audit file: ${join(projectPath, ...AUDIT_LOG_REL)}`,
            'changed_files are project-relative (PII guard); riskHighlights mark destructive/delete/failed',
            'To roll back use suggest_rollback + entry_index',
          ]),
        ),
      );
    }
    if (action === 'suggest_rollback') {
      const idx = typeof args.entry_index === 'number' ? args.entry_index : -1;
      if (idx < 0) {
        return opsErrorResult(
          'INVALID_PARAMS',
          'entry_index required (get it from get_log entries[].index)',
        );
      }
      const summary = await readAuditLog(projectPath); // 全量,每条带全局 index
      const entry = summary.entries.find((e) => e.index === idx);
      if (!entry) {
        return opsErrorResult(
          'NOT_FOUND',
          `entry_index ${idx} not found (total entries: ${summary.entries.length})`,
        );
      }
      const suggestion = suggestRollback(entry);
      return textResult(
        JSON.stringify(
          opsSuccess({ entry, suggestion }, [
            'supported=true only for create-type entries (auto-delete) / project.godot needs before_values; everything else relies on Git (honestly)',
          ]),
        ),
      );
    }
    return opsErrorResult('INVALID_PARAMS', `unknown action: ${action}`);
  } catch (err) {
    return opsErrorResult(
      'AUDIT_ERROR',
      err instanceof Error ? err.message : String(err),
    );
  }
}

export const TOOL_META = {
  audit: {
    readonly: true,
    long_running: false,
    actionRisks: { get_log: 'read' as const, suggest_rollback: 'read' as const },
  },
};
