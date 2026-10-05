// src/tools/cpp.ts
// GDExtension (C++) 脚手架生成工具。纯文件生成,不联网/不编译。
import type { Tool } from "@modelcontextprotocol/server";
import { existsSync, readdirSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { ToolContext, ToolResult } from '../types.js';
import type { RiskLevel } from '../core/tool-registry.js';
import { textResult } from '../types.js';
import { opsErrorResult } from './shared.js';
import { requireProjectPath } from '../helpers.js';
import {
  renderScaffold, PARENT_CLASS_WHITELIST, SUPPORTED_GODOT_VERSIONS, CLASS_NAME_RE, godotCppCloneCommand,
} from './cpp-templates.js';

const ACTIONS = ['scaffold_gdextension'] as const;

// ─── Tool definitions ──────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'cpp',
      description: 'GDExtension (C++) scaffolding. scaffold_gdextension: generates a complete, buildable godot-cpp GDExtension project under project_path (src/Class.cpp/.h + register_types + SConstruct + .gdextension + .gitignore + README); no network, no compiling; follows the official godot-cpp example.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            enum: ['scaffold_gdextension'],
            description: 'Operation',
          },
          project_path: { type: 'string', description: 'Root directory of the generated GDExtension project (must be inside ALLOWED_PROJECT_PATHS)' },
          class_name: { type: 'string', description: 'Main class name (PascalCase, default Example)', default: 'Example' },
          parent_class: { type: 'string', description: 'Parent class (whitelist of Godot built-in classes, default Node)', default: 'Node' },
          godot_version: {
            type: 'string',
            description: 'Godot version (4.4–4.7; picks the godot-cpp clone ref, SConstruct api_version and .gdextension compatibility_minimum; 4.6/4.7 use godot-cpp master (v10) + api_version (no godot-4.x-stable ref), 4.4/4.5 use the godot-4.x-stable branch. Default 4.7)',
            default: '4.7',
            enum: ['4.4', '4.5', '4.6', '4.7'],
          },
          force: { type: 'boolean', description: 'Overwrite if the target exists and is not empty (default false)', default: false },
        },
        required: ['action', 'project_path'],
      },
    },
  ];
}

// ─── Tool handler ───────────────────────────────────────────────────────────

export async function handleTool(
  name: string, args: Record<string, unknown>, _ctx: ToolContext,
): Promise<ToolResult | null> {
  if (name !== 'cpp') return null;
  const action = args.action as string;
  if (!(ACTIONS as readonly string[]).includes(action)) return opsErrorResult('UNKNOWN_ACTION', `Unknown action: ${action}`);

  // 路径安全校验（越界 throw 由外层 ToolDispatcher 统一捕获）
  const projectPath = requireProjectPath(args);

  const className = (args.class_name as string) || 'Example';
  const parentClass = (args.parent_class as string) || 'Node';
  const godotVersion = (args.godot_version as string) || '4.7';
  const force = args.force === true;

  // 白名单前置校验（fail-fast，写盘前拒绝，避免半成品）
  if (!CLASS_NAME_RE.test(className)) {
    return textResult(`Error: class_name "${className}" must be PascalCase (e.g. MyExample).`);
  }
  const parentInc = PARENT_CLASS_WHITELIST[parentClass];
  if (!parentInc) {
    return textResult(`Error: parent_class "${parentClass}" not in whitelist. Allowed: ${Object.keys(PARENT_CLASS_WHITELIST).join(', ')}`);
  }
  if (!(SUPPORTED_GODOT_VERSIONS as readonly string[]).includes(godotVersion)) {
    return textResult(`Error: godot_version "${godotVersion}" not supported. Allowed: ${[...SUPPORTED_GODOT_VERSIONS].join(', ')}`);
  }

  // 防误覆盖：目标已存在且非空 + 未 force → 拒绝（与 create_project 检测存在即拒同思路）
  if (existsSync(projectPath) && readdirSync(projectPath).length > 0 && !force) {
    return textResult(`Error: target directory not empty: ${projectPath}. Use force=true to overwrite.`);
  }

  const lib = className.toLowerCase();
  const files = renderScaffold({ className, parentClass, parentInc, lib, godotVersion });

  mkdirSync(join(projectPath, 'src'), { recursive: true });
  for (const f of files) {
    const dirPart = f.path.substring(0, f.path.lastIndexOf('/')); // 根级文件 → '' → join(p,'')=p
    mkdirSync(join(projectPath, dirPart), { recursive: true });
    writeFileSync(join(projectPath, f.path), f.content, 'utf-8');
  }

  return textResult(JSON.stringify({
    files: files.map(f => f.path),
    gdextension_path: join(projectPath, `${lib}.gdextension`),
    godot_cpp_clone_hint: godotCppCloneCommand(godotVersion),
  }, null, 2));
}

// ─── Tool metadata ──────────────────────────────────────────────────────────

export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean; actionRisks: Record<string, RiskLevel> }> = {
  cpp: {
    readonly: false,
    long_running: false,
    // scaffold 写 8 文件 + 建目录 → 'write',requiresConfirmation 触发确认令牌
    // （guard.ts 读 actionRisks）。cpp 须在 test/risk-coverage.test.ts 的 GUARDED_KEYS 内。
    actionRisks: { scaffold_gdextension: 'write' },
  },
};
