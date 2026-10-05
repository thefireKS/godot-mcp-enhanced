import type { Tool } from "@modelcontextprotocol/server";

// src/tools/self-update.ts
// 单工具 self_update + action enum=[check,update]。
// ⚠️ 粒度选择：不能用两个独立无-action工具——guard.ts:65 action==null → return false
//    会导致 update 的 confirm 门静默失效。action enum 让 args.action='update' 命中确认门。
import type { ToolContext, ToolResult } from '../types.js';
import { textResult } from '../types.js';
import { opsSuccess, opsErrorResult } from './shared.js';
import { checkForUpdateCached, compareVersion } from '../core/update-checker.js';
import { readAddonVersion, updateAddon } from '../core/addon-version.js';
import { getAllowedProjectPaths } from '../core/path-utils.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
// src/tools/ → 上两级包根 → package.json（与 update-checker.ts:11 同款 idiom）
const pkgVersion: string = require('../../package.json').version;

const ACTIONS = ['check', 'update'] as const;

// readonly 不可设 true（否则 update 在 readOnly 模式放行绕过保护）。
// 见 spec §5：ReadOnlyGuard 工具级判定，readonly=false → readOnly 拒整工具（check 也拒）。
export const TOOL_META = {
  self_update: {
    readonly: false,
    long_running: false,
    actionRisks: {
      check: 'read' as const,
      update: 'write' as const,
    },
  },
};

export function getToolDefinitions(): Tool[] {
  return [{
    name: 'self_update',
    description: 'Check/update enhanced itself. check: latest npm version + addon version drift per project (read-only). update: update a project\'s addon to the package version (overwrite install, needs confirmation).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['check', 'update'],
          description: 'check = version status (read-only) / update = update the project addon (destructive, needs confirmation)',
        },
        project_path: {
          type: 'string',
          description: 'Target Godot project path (required for update; optional for check, defaults to scanning everything in ALLOWED_PROJECT_PATHS)',
        },
      },
      required: ['action'],
    },
  }];
}

export async function handleTool(
  name: string, args: Record<string, unknown>, _ctx: ToolContext,
): Promise<ToolResult | null> {
  if (name !== 'self_update') return null;
  const action = args.action as string;
  if (!(ACTIONS as readonly string[]).includes(action as 'check' | 'update')) {
    return opsErrorResult('UNKNOWN_ACTION', `Unknown action: ${action}`);
  }
  return action === 'check' ? handleCheck(args) : handleUpdate(args);
}

async function handleCheck(args: Record<string, unknown>): Promise<ToolResult> {
  const npm = await checkForUpdateCached({ force: true });
  const hasProjectArg = !!args.project_path;
  const targetPaths = args.project_path
    ? [String(args.project_path)]
    : getAllowedProjectPaths();
  const addons = targetPaths.map(p => {
    try {
      const { version, installed } = readAddonVersion(p);
      return {
        project_path: p,
        installed_version: version,
        expected_version: installed ? pkgVersion : null,
        matches: installed ? version === pkgVersion : false,
        installed,
      };
    } catch (e) {
      return { project_path: p, installed: false, installed_version: null,
        expected_version: null, matches: false,
        error: e instanceof Error ? e.message : String(e) };
    }
  });
  // M7：spec §4.3 — 无 project_path 参数 且 ALLOWED_PROJECT_PATHS 未配置时返提示
  const data: Record<string, unknown> = { npm, addons };
  if (!hasProjectArg && targetPaths.length === 0) {
    data.hint = 'ALLOWED_PROJECT_PATHS is not configured, can\'t scan project addons. Set ALLOWED_PROJECT_PATHS=/path1;/path2 or pass project_path for a single project';
  }
  return textResult(JSON.stringify(opsSuccess(data)));
}

async function handleUpdate(args: Record<string, unknown>): Promise<ToolResult> {
  const projectPath = args.project_path;
  if (typeof projectPath !== 'string' || !projectPath) {
    return opsErrorResult('INVALID_PARAMS', 'The update action needs the project_path parameter');
  }
  // 降级保护：null（未安装/malformed）直 cp 修复；非 null 且 >包版本 才拒绝
  // I-1：readAddonVersion 内 isPathInAllowedRoots 若拒会 throw，包 try/catch 返结构化错误
  // （与 handleCheck 对齐，避免 ToolDispatcher re-throw 成 MCP -32603 generic error 让 AI 无法区分错误源）
  let installed: string | null;
  let isInstalled: boolean;
  try {
    ({ version: installed, installed: isInstalled } = readAddonVersion(projectPath));
  } catch (e) {
    return opsErrorResult('PATH_NOT_ALLOWED', e instanceof Error ? e.message : String(e));
  }
  if (isInstalled && installed != null && compareVersion(installed, pkgVersion) > 0) {
    return opsErrorResult('DOWNGRADE_REFUSED',
      `The project addon version ${installed} is newer than the package version ${pkgVersion}; looks like a downgrade, refusing`);
  }
  try {
    const { dest, verifyOk } = updateAddon(projectPath);
    if (!verifyOk) {
      return opsErrorResult('VERIFY_FAILED', `plugin.cfg check failed after updating the addon: ${dest}`);
    }
    return textResult(JSON.stringify(opsSuccess({
      project_path: projectPath,
      updated_from: installed,
      updated_to: pkgVersion,
      verifyOk,
      dest,
    })));
  } catch (e) {
    return opsErrorResult('UPDATE_FAILED', e instanceof Error ? e.message : String(e));
  }
}
