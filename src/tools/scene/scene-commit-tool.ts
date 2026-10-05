import type { Tool } from "@modelcontextprotocol/server";

// src/tools/scene-commit-tool.ts
// P2: MCP tool wrapper for scene_commit.
import type { ToolContext, ToolResult } from '../../types.js';
import { textResult } from '../../types.js';
import { requireProjectPath, resolveWithinRoot, normalizeUserProjectPath } from '../../helpers.js';
import { executeGdscript } from '../../gdscript-executor.js';
import { generateCommitScript, validateCommitOperations, TILESET_RESOURCE_OPS, type CommitOperation } from './scene-commit.js';
import { acquireShortRunningSlot, releaseShortRunningSlot } from '../../core/process-state.js';
import { opsErrorResult } from '../shared.js';
import { existsSync } from 'fs';
import { resolve } from 'path';

export function getToolDefinitions(): Tool[] {
  console.warn(`[DEPRECATED] scene-commit-tool module is absorbed into scene. Do not register directly.`);
  return [{
    name: 'scene_commit',
    description: 'Run a batch of scene edits (tile_set/tile_fill/tile_erase/tile_clear/tileset_assign/node_property/node_add + the 9 TileSet layer-config ops) in a single Godot process call. Good for batch edits that must persist.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        project_path: { type: 'string', description: 'Godot project directory (optional; defaults to the GODOT_PROJECT_PATH env var or the current directory)' },
        scene_path: { type: 'string', description: 'Target scene path (e.g. res://scenes/Level.tscn)' },
        operations: {
          type: 'array',
          description: 'Operations',
          items: {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['tile_set', 'tile_fill', 'tile_erase', 'tile_clear', 'tileset_assign', 'node_property', 'node_add', 'tileset_physics_layer_add', 'tile_collision_set', 'tileset_physics_layer_set', 'tileset_physics_layer_remove', 'tileset_navigation_layer_add', 'tile_navigation_set', 'tileset_custom_data_layer_add', 'tile_custom_data_set', 'tile_collision_clear'] },
              node_path: { type: 'string', description: 'TileMap/TileMapLayer node path (required for tile ops)' },
              coords: { type: 'object', description: 'Cell coordinates {x, y}' },
              region: { type: 'object', description: 'Rectangle {x, y, w, h}' },
              source_id: { type: 'number', description: 'TileSet source ID' },
              atlas: { type: 'object', description: 'Atlas coordinates {x, y}' },
              alternative_tile: { type: 'number', description: 'Alternative tile index (default 0)' },
              tileset_path: { type: 'string', description: 'TileSet resource path (tileset_assign + the 9 layer-config ops; layer-config ops accept res:// .tres inside the project only)' },
              collision_layer: { type: 'number', description: 'tileset_physics_layer_add/set: collision layer bitmask' },
              collision_mask: { type: 'number', description: 'tileset_physics_layer_add/set: collision mask bitmask' },
              physics_layer: { type: 'number', description: 'tile_collision_set/clear: physics layer index (0-based)' },
              layer: { type: 'number', description: 'tileset_physics_layer_set/remove and tile_custom_data_set: layer index (0-based)' },
              layers: { type: 'number', description: 'tileset_navigation_layer_add: navigation layer bitmask (optional)' },
              navigation_layer: { type: 'number', description: 'tile_navigation_set: navigation layer index (0-based)' },
              shape: { type: 'string', enum: ['rect', 'polygon'], description: 'tile_collision_set/tile_navigation_set: rect = the whole cell\'s four corners; polygon = custom points' },
              points: { type: 'array', items: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } } }, description: 'Points for polygon mode [{x,y}]' },
              one_way: { type: 'boolean', description: 'tile_collision_set: one-way collision (optional)' },
              name: { type: 'string', description: 'Node name (node_add) / custom data layer name (tileset_custom_data_layer_add)' },
              type: { type: 'string', description: 'Node type (node_add) / data layer type int|float|bool|string|color|vector2 (optional)' },
              path: { type: 'string', description: 'Node path (node_property)' },
              property: { type: 'string', description: 'Property name' },
              value: { description: 'Property value (node_property) / custom data value (tile_custom_data_set)' },
              parent: { type: 'string', description: 'Parent node path (node_add)' },
            },
            required: ['op'],
          },
        },
        save: { type: 'boolean', description: 'Save to file (default true)', default: true },
        stop_on_error: { type: 'boolean', description: 'Stop on error (default true)', default: true },
      },
      required: ['scene_path', 'operations'],
    },
  }];
}

// ─── Core handler (shared by handleTool and scene module) ─────────────────

export async function handleCommitAction(
  args: Record<string, unknown>, ctx: ToolContext,
): Promise<ToolResult | null> {
  const p = requireProjectPath(args);
  const scenePath = normalizeUserProjectPath(args.scene_path as string);
  const absPath = resolveWithinRoot(p, scenePath);
  const operations = args.operations as Array<Record<string, unknown>>;
  const save = args.save !== false;
  const stopOnError = args.stop_on_error !== false;

  if (!operations || !Array.isArray(operations) || operations.length === 0) {
    return opsErrorResult('INVALID_PARAMS', 'operations must be a non-empty array');
  }
  if (operations.length > 500) {
    return opsErrorResult('INVALID_PARAMS', `Too many operations (${operations.length}). Maximum: 500`);
  }

  // IMPORTANT-7 (review): operations 结构校验(原 as unknown as CommitOperation[] 无运行时校验,
  // 畸形 op 致 generateCommitScript 崩溃)。用 validateCommitOperations 便于单测。
  const validationError = validateCommitOperations(operations);
  if (validationError) {
    return opsErrorResult('INVALID_PARAMS', validationError);
  }

  // TileSet 资源 op(物理/导航/自定义数据层,共 9 个)经 ResourceSaver 写 .tres——
  // tileset_path 是写盘参数,必须过项目内校验(deny-by-default,防越界写)。
  // validateCommitOperations 已做 res:// 前缀 + 明文 .. 浅校验;此处对已存在的 .tres 追加
  // resolveWithinRoot realpath 纵深校验(拦 URL 编码/symlink 等绕过浅校验的形态,
  // memory: file-path-args-whitelist-blindspot)。不存在的路径无覆写面——GD 侧 load null
  // 走 "TileSet resource not found" 结构化错误,放行到执行层。
  for (const op of operations) {
    if (!TILESET_RESOURCE_OPS.has(op.op as string)) continue;
    const rel = normalizeUserProjectPath(op.tileset_path as string);
    if (existsSync(resolve(p, rel))) {
      try {
        resolveWithinRoot(p, rel);
      } catch {
        return opsErrorResult('INVALID_PARAMS', `Op tileset_path escapes project root: ${String(op.tileset_path)}`);
      }
    }
  }

  // F-1 (批 F, 2026-08-14): editor 场景写守卫——commit 走 headless spawn 写盘(不在 editor-method-map),
  // 若该场景在 editor 打开, headless 直写磁盘会被 editor GUI save 覆盖回旧内存态,批量写入静默丢失。
  // 调用方式对齐 index.ts edit_node(:385-388)同款;守卫在 acquireShortRunningSlot 之前,被拦截不占 slot。
  // headless 模式 checkEditorSceneSave 未注入, 直接放行。
  if (ctx.checkEditorSceneSave) {
    const sceneGuard = await ctx.checkEditorSceneSave(absPath);
    if (sceneGuard.blocked) return opsErrorResult('EDITOR_SCENE_OPEN', sceneGuard.message ?? `Scene open in editor: ${absPath}`);
  }

  // Generate GDScript
  const resPath = `res://${scenePath.replace(/\\/g, '/')}`;
  const script = generateCommitScript(
    resPath,
    operations as unknown as CommitOperation[],
    save,
    stopOnError,
  );

  // Execute via Godot process
  if (!acquireShortRunningSlot()) {
    return opsErrorResult('CONCURRENCY_LIMIT', 'too many concurrent headless operations (max 3). Please wait and retry.');
  }

  try {
    const godot = await ctx.findGodot();
    const result = await executeGdscript({
      godotPath: godot,
      projectPath: p,
      code: script,
      timeout: 120,
      loadAutoloads: false,
    });

    // Parse COMMIT_RESULT from output
    const commitResult = parseCommitResult(result.raw_output || result.run_error || '');
    // F-2 (批 F, 2026-08-14; 批F fix 收口): 真失败(COMMIT_RESULT success:false)不再假成功——
    // 顶层置 isError,防 AI 与 middleware 把失败当成功。单条件 success 驱动,统一覆盖三类真失败:
    // 保存失败(ENOSPC/EACCES → err != OK → success:false)/stopOnError 中止(stopBlock success:false,
    // 含 save=false 的中止——原 save && saved===false 条件把该 corner 误排除)/load 失败。
    // save=false 正常完成的 saved:false 伴随 success:true,不触发;commitResult 为 null
    // (GDScript 崩溃无 COMMIT_RESULT)时短路走 fallback,行为不变。
    if (commitResult?.success === false) {
      return { content: [{ type: 'text', text: JSON.stringify(commitResult, null, 2) }], isError: true };
    }
    return textResult(JSON.stringify(commitResult || {
      success: result.run_success,
      raw_output: result.raw_output,
      errors: result.errors,
    }, null, 2));
  } finally {
    releaseShortRunningSlot();
  }
}

// ─── Tool Handler ───────────────────────────────────────────────────────────

export async function handleTool(
  name: string, args: Record<string, unknown>, ctx: ToolContext,
): Promise<ToolResult | null> {
  if (name !== 'scene_commit') return null;
  return handleCommitAction(args, ctx);
}

/** Parse COMMIT_RESULT JSON from GDScript output. */
export function parseCommitResult(output: string): Record<string, unknown> | null {
  const marker = 'COMMIT_RESULT: ';
  const idx = output.lastIndexOf(marker);
  if (idx === -1) return null;
  try {
    const after = output.slice(idx + marker.length);
    // Find the end of the JSON value — match balanced braces
    let depth = 0;
    let end = -1;
    for (let i = 0; i < after.length; i++) {
      if (after[i] === '{') depth++;
      else if (after[i] === '}') {
        depth--;
        if (depth === 0) { end = i + 1; break; }
      }
    }
    if (end === -1) return null;
    return JSON.parse(after.slice(0, end));
  } catch {
    return null;
  }
}

export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean }> = {
  scene_commit: { readonly: false, long_running: true },
};
