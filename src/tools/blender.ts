import { join, dirname } from 'path';
import { existsSync, writeFileSync, unlinkSync, statSync } from 'fs';
import { tmpdir } from 'os';
import type { Tool } from "@modelcontextprotocol/server";
import type { ToolContext, ToolResult } from '../types.js';
import { textResult } from '../types.js';
import { requireProjectPath, resolveWithinRoot, normalizeUserProjectPath, ensureDir } from '../helpers.js';
import { opsErrorResult, validateTimeout } from './shared.js';
import { findBlender } from '../core/blender-finder.js';
import { runBlenderHeadless } from '../core/blender-spawn.js';
import { scanBpySandbox } from '../core/bpy-sandbox.js';
import type { RiskLevel } from '../core/tool-registry.js';

const HEADER = `import bpy, bmesh, mathutils, math, sys
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.context.scene.unit_settings.system = 'METRIC'`;

const FOOTER = `bpy.ops.export_scene.gltf(filepath=sys.argv[sys.argv.index("--") + 1], export_format='GLB', export_apply=True)`;

/** 包装 AI 片段：header（空场景）+ AI code + footer（argv export）。 */
export function buildBlenderScript(code: string): string {
  return `${HEADER}\n# ===== AI snippet =====\n${code}\n# ===== auto export =====\n${FOOTER}`;
}

export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean; actionRisks?: Record<string, RiskLevel> }> = {
  blender: {
    readonly: false,
    long_running: false,
    // execute_bpy 启动 blender headless 子进程跑全功能 Python（RCE 面），对齐 execute_gdscript:'process'。
    actionRisks: { execute_bpy: 'process' } satisfies Record<'execute_bpy', RiskLevel>,
  },
};

export function getToolDefinitions(): Tool[] {
  return [{
    name: 'blender',
    description: 'Procedural modeling in Blender. action=execute_bpy: the AI writes a bpy snippet, it runs headless and the result is exported as glb into res://. '
      + '(⚠️ bpy is full Python: the threat surface is host RCE, an order of magnitude above the execute_gdscript sandbox. '
      + 'bpy code goes through a sandbox scan (known dangerous API patterns, list not published so the boundary can\'t be probed) + a double opt-in bypass, same philosophy as execute_gdscript; '
      + 'the glb export target is additionally constrained by resolveWithinRoot. Local single-user trust model.)',
    inputSchema: {
      type: 'object' as const,
      properties: {
        project_path: { type: 'string', description: 'Godot project directory' },
        action: { type: 'string', enum: ['execute_bpy'], description: 'Operation' },
        export_path: { type: 'string', description: 'glb export path relative to the project root, optional res:// prefix (e.g. assets/models/rock.glb)' },
        code: { type: 'string', description: 'bpy modeling snippet (no import/export needed, godot-mcp wraps it)' },
        timeout: { type: 'number', description: 'Timeout in seconds (default 60)', default: 60 },
      },
      required: ['action', 'export_path', 'code'],
    },
  }];
}

export async function handleTool(
  name: string, args: Record<string, unknown>, _ctx: ToolContext,
): Promise<ToolResult | null> {
  if (name !== 'blender') return null;
  const action = args.action as string;
  if (action !== 'execute_bpy') return opsErrorResult('INVALID_PARAMS', `Unknown action: ${action}`);

  const projectPath = requireProjectPath(args);
  const exportPathRaw = args.export_path as string;
  const code = args.code as string;
  if (!exportPathRaw || typeof exportPathRaw !== 'string')
    return opsErrorResult('INVALID_PARAMS', 'export_path must be a non-empty string.');
  if (!code || typeof code !== 'string')
    return opsErrorResult('INVALID_PARAMS', 'code must be a non-empty string.');
  const timeout = validateTimeout(args.timeout, 5, 120, 60);

  // glb 导出落点校验：剥 res://（带/不带前缀都走通 normalizeUserProjectPath）→ 文件系统落点校验。
  // ⚠️ 此处仅校验 godot-mcp 注入的 export filepath；bpy 代码内部 open()/os.remove()/os.system() 等
  // 危险 API 由下方 scanBpySandbox 沙箱扫描兜底（bpy-sandbox.ts，双 opt-in 旁路）。
  let fsExport: string;
  try {
    fsExport = resolveWithinRoot(projectPath, normalizeUserProjectPath(exportPathRaw));
  } catch {
    return opsErrorResult('EXPORT_PATH_TRAVERSAL', `export_path escapes project root: ${exportPathRaw}`);
  }
  ensureDir(dirname(fsExport));

  // 找 blender
  let blenderPath: string;
  try {
    blenderPath = await findBlender();
  } catch {
    return opsErrorResult('BLENDER_NOT_FOUND',
      'Blender not found. Set GODOT_BLENDER_PATH env or install Blender on PATH.');
  }

  // 写临时脚本前:对齐 execute_gdscript 纵深防御,扫描危险 Python API。
  const sandboxWarnings = scanBpySandbox(code);
  if (sandboxWarnings.length > 0) {
    return opsErrorResult('SANDBOX_BLOCKED',
      `execute_bpy code blocked by sandbox (set GODOT_MCP_DISABLE_SAFETY=true for local trust override):\n${sandboxWarnings.join('\n')}`);
  }
  // 写临时脚本（系统 temp，非项目内）
  const tmpScript = join(tmpdir(), `mcp-blender-${process.pid}-${Date.now()}.py`);
  writeFileSync(tmpScript, buildBlenderScript(code), 'utf-8');
  try {
    const result = await runBlenderHeadless(
      ['--background', '--factory-startup', '--python', tmpScript, '--', fsExport],
      blenderPath, timeout * 1000,
    );
    if (result.exitCode === null)
      return opsErrorResult('TIMEOUT', `Blender timed out after ${timeout}s`);
    if (result.exitCode !== 0)
      return opsErrorResult('BLENDER_EXIT_NONZERO',
        `Blender exited ${result.exitCode}\nstderr:\n${result.stderr.slice(-2000)}`);
    if (!existsSync(fsExport))
      return opsErrorResult('EXPORT_FILE_MISSING',
        `Blender succeeded but glb not generated (snippet may have created no objects). stdout:\n${result.stdout.slice(-2000)}`);
    const glbSize = statSync(fsExport).size;
    return textResult(
      `✅ glb exported: ${fsExport} (${glbSize} bytes)\n\n` +
      `[SECURITY] bpy ran as full Python (host RCE surface). Only the export filepath was ` +
      `constrained; bpy-internal file ops were not. Local single-user trust model.\n\n` +
      `--- Blender stdout (tail) ---\n${result.stdout.slice(-2000)}`,
    );
  } finally {
    try { unlinkSync(tmpScript); } catch { /* best effort */ }
  }
}
