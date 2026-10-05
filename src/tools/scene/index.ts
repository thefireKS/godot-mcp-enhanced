// Scene tool entry point: definitions, handler, and meta.

import { join, dirname } from 'path';
import type { Tool } from "@modelcontextprotocol/server";
import { existsSync, readFileSync, writeFileSync, statSync } from 'fs';
import type { ToolContext, ToolResult } from '../../types.js';
import { textResult, errorResult } from '../../types.js';
import { requireProjectPath, resolveWithinRoot, normalizeUserProjectPath, ensureDir, parseMcpScriptOutput } from '../../helpers.js';
import { parseTscn, parseTscnSummary } from '../../tscn/tscn-parser.js';
import { executeGdscript } from '../../gdscript-executor.js';
import { normalizeNodePath, escapeForGdLiteral, SCENE_TREE_HEADER, opsErrorResult, parseGdscriptResult, sanitizeResPath } from '../shared.js';
import { addNode } from '../../tscn/tscn-editor.js';
import { acquireShortRunningSlot, releaseShortRunningSlot } from '../../core/process-state.js';
import { spawnGodot } from '../spawn-helper.js';
import { ACTIONS, requireScenePath, writeAtomic, BLOCKED_PROPS } from './helpers.js';
import { handleInstanceScene, handleSetInstanceProperty, handleDetachInstance } from './scene-instance.js';
import { mergeTscn, checkSceneHealth } from './scene-merge.js';
import { handleCreate3dNode } from '../node-3d-ops.js';
import { handleCommitAction } from './scene-commit-tool.js';
import { scanScriptSandboxOrThrow } from '../script.js';
import type { RiskLevel } from '../../core/tool-registry.js';

export { mergeTscn, checkSceneHealth };

// ─── Tool definitions ──────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'scene',
      description: 'Scene operations. Read/create: read_scene, create_scene, quick_scene. Nodes: add_node, batch_add_nodes, edit_node, remove_node. Save/resources: save_scene, load_sprite. Query: query_scene_tree, inspect_node. Instances: instance_scene, set_instance_property, detach_instance.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot project directory' },
          action: {
            type: 'string',
            enum: [...ACTIONS],
            description: 'Operation',
          },
          scene_path: { type: 'string', description: 'Scene path (absolute for read_scene, project-relative for everything else)' },
          summary_only: { type: 'boolean', description: 'read_scene: return a summary instead of the full JSON' },
          root_node_type: { type: 'string', description: 'create_scene/quick_scene: root node type (default Node2D)' },
          root_node_name: { type: 'string', description: 'quick_scene: root node name (default: PascalCase of the file name)' },
          script_path: { type: 'string', description: 'quick_scene: script path (optional)' },
          script_content: { type: 'string', description: 'quick_scene: script content (the script is created if missing)' },
          node_type: { type: 'string', description: 'add_node: node type (e.g. Sprite2D, Camera2D)' },
          node_name: { type: 'string', description: 'add_node: node name' },
          parent_node_path: { type: 'string', description: 'add_node/instance_scene: parent node path (default root)' },
          properties: { type: 'object', description: 'add_node/edit_node/instance_scene: properties object' },
          new_path: { type: 'string', description: 'save_scene: new save path (optional) / merge_scene: path of the theirs scene (required)' },
          texture_path: { type: 'string', description: 'load_sprite: texture path (e.g. res://assets/player.png)' },
          node_path: { type: 'string', description: 'inspect_node/edit_node/remove_node/load_sprite/detach_instance/set_instance_property: node path' },
          max_depth: { type: 'number', description: 'query_scene_tree/inspect_node: max traversal depth' },
          include_signals: { type: 'boolean', description: 'inspect_node: include signal connections (default true)' },
          include_properties: { type: 'boolean', description: 'inspect_node: include property values (default true)' },
          nodes: {
            type: 'array',
            description: 'batch_add_nodes: array of node definitions',
            items: {
              type: 'object',
              properties: {
                node_type: { type: 'string', description: 'Node type' },
                node_name: { type: 'string', description: 'Node name' },
                parent_node_path: { type: 'string', description: 'Parent path (default root)' },
                properties: { type: 'object', description: 'Properties' },
              },
              required: ['node_type', 'node_name'],
            },
          },
          instance_path: { type: 'string', description: 'Scene to instance (res://…tscn)' },
          property: { type: 'string', description: 'set_instance_property: property name' },
          value: { description: 'Property value (set_instance_property)' },
          load_autoloads: { type: 'boolean', description: 'Load the Autoload context (default true)' },
          // create_3d_node 参数
          type: { type: 'string', description: 'Type (create_3d_node, whitelisted)' },
          name: { type: 'string', description: 'Name (create_3d_node)' },
          parent: { type: 'string', description: 'create_3d_node: parent node path (default root)' },
          // commit 参数
          operations: {
            type: 'array',
            description: 'commit: list of batch operations (enum in the op field; painting / TileSet layer config / nodes)',
            items: {
              type: 'object',
              properties: {
                op: { type: 'string', enum: ['tile_set', 'tile_fill', 'tile_erase', 'tile_clear', 'tileset_assign', 'node_property', 'node_add', 'tileset_physics_layer_add', 'tile_collision_set', 'tileset_physics_layer_set', 'tileset_physics_layer_remove', 'tileset_navigation_layer_add', 'tile_navigation_set', 'tileset_custom_data_layer_add', 'tile_custom_data_set', 'tile_collision_clear'] },
                node_path: { type: 'string', description: 'TileMap/TileMapLayer node path' },
                coords: { type: 'object', description: 'Cell coordinates {x, y}' },
                region: { type: 'object', description: 'Rectangle {x, y, w, h}' },
                source_id: { type: 'number', description: 'TileSet source ID' },
                atlas: { type: 'object', description: 'Atlas coordinates {x, y}' },
                alternative_tile: { type: 'number', description: 'Alternative tile index (default 0)' },
                tileset_path: { type: 'string', description: 'TileSet .tres path (the 9 layer-config ops accept res:// inside the project only)' },
                collision_layer: { type: 'number', description: 'Physics layer bitmask (physics add/set)' },
                collision_mask: { type: 'number', description: 'Physics mask bitmask (physics add/set)' },
                physics_layer: { type: 'number', description: 'Physics layer index, 0-based (collision set/clear)' },
                layer: { type: 'number', description: 'Layer index, 0-based (physics set/remove, cdata set)' },
                layers: { type: 'number', description: 'Navigation layer bitmask (navigation add, optional)' },
                navigation_layer: { type: 'number', description: 'Navigation layer index, 0-based (navigation set)' },
                shape: { type: 'string', enum: ['rect', 'polygon'], description: 'rect = the whole cell\'s four corners; polygon = custom points' },
                points: { type: 'array', description: 'Polygon points [{x,y}] (omit for rect; each checked at runtime)' },
                one_way: { type: 'boolean', description: 'One-way collision (collision set, default false)' },
                name: { type: 'string', description: 'Node name (node_add) / data layer name (cdata add)' },
                type: { type: 'string', description: 'Node type (node_add) / int|float|bool|string|color|vector2 (cdata add)' },
                path: { type: 'string', description: 'Node path (node_property)' },
                property: { type: 'string', description: 'Property name' },
                value: { description: 'Property value (node_property) / data value (cdata set, must match the layer type)' },
                parent: { type: 'string', description: 'Parent node path (node_add)' },
              },
            },
          },
          save: { type: 'boolean', description: 'commit: save to file (default true)' },
          stop_on_error: { type: 'boolean', description: 'Stop on error (default true; with false a failure doesn\'t block later ops or writing the .tres)' },
          godot_path: { type: 'string', description: 'Override the Godot binary path (optional; takes precedence over project config and env vars)' },
        },
        required: ['action'],
      },
    },
  ];
}

// ─── Tool Handler ───────────────────────────────────────────────────────────

export async function handleTool(
  name: string, args: Record<string, unknown>, ctx: ToolContext
): Promise<ToolResult | null> {
  if (name !== 'scene') return null;

  const action = args.action as string;
  if (!action) return opsErrorResult('INVALID_PARAMS', 'action is required');

  switch (action) {
    case 'read_scene': {
      const spErr = requireScenePath(args.scene_path);
      if (spErr) return spErr;
      const sp = resolveWithinRoot(requireProjectPath(args), normalizeUserProjectPath(args.scene_path as string));
      if (!existsSync(sp)) return textResult(`Scene file not found: ${sp}`);
      const content = readFileSync(sp, 'utf-8');
      if (args.summary_only) return textResult(parseTscnSummary(content));
      const parsed = parseTscn(content);
      const roots = parsed.nodes.filter(n => !n.parent);
      return textResult(JSON.stringify({ header: parsed.header, extResources: parsed.extResources, subResources: parsed.subResources, nodeTree: roots, connections: parsed.connections, totalNodes: parsed.nodes.length }, null, 2));
    }

    // P1 file-op shortcut for add_node: try pure text editing first,
    // fall through to spawnGodot if properties are unsupported.
    case 'add_node': {
      // Validate params
      const p = requireProjectPath(args);
      const sceneRelPath = normalizeUserProjectPath(args.scene_path as string);
      if (!/^[A-Za-z0-9_]+$/.test(String(args.node_type ?? ''))) {
        return textResult(`Error: node_type contains invalid characters: "${args.node_type}"`);
      }
      if (!String(args.node_name ?? '') || /[\]["/:\\]/.test(String(args.node_name))) {
        return textResult(`Error: node_name contains invalid characters: "${args.node_name}"`);
      }

      const absPath = resolveWithinRoot(p, sceneRelPath);
      if (!existsSync(absPath)) {
        return opsErrorResult('FILE_NOT_FOUND', `Scene file not found: ${sceneRelPath}`);
      }

      // P1-2 (2026-07-06 review): editor 场景写守卫 — add_node 写回前检查场景是否在编辑器打开,
      // 防覆盖编辑器内存状态致版本撕裂。headless 模式 checkEditorSceneSave 未注入, 直接放行。
      if (ctx.checkEditorSceneSave) {
        const sceneGuard = await ctx.checkEditorSceneSave(absPath);
        if (sceneGuard.blocked) return opsErrorResult('EDITOR_SCENE_OPEN', sceneGuard.message ?? `Scene open in editor: ${absPath}`);
      }

      // Convert parent_node_path to .tscn parent format
      const rawParent = String(args.parent_node_path || 'root');
      let tscnParent: string;
      if (rawParent === 'root' || rawParent === '/root' || rawParent === '') {
        tscnParent = '.';
      } else {
        // Strip "root/" prefix if present, keep the rest as tscn parent path
        const stripped = rawParent.replace(/^\/?root\/?/, '');
        tscnParent = stripped || '.';
      }

      const tscnContent = readFileSync(absPath, 'utf-8');
      const result = addNode(tscnContent, {
        parent: tscnParent,
        name: String(args.node_name),
        type: String(args.node_type),
        properties: args.properties as Record<string, unknown> | undefined,
      });

      if (result.success && result.fallback) {
        // Unsupported property types — fall back to spawnGodot
        if (!acquireShortRunningSlot()) return opsErrorResult('CONCURRENCY_LIMIT', 'too many concurrent headless operations (max 3). Please wait and retry.');
        let godot: string;
        try { godot = await ctx.findGodot(); } catch (e) { releaseShortRunningSlot(); throw e; }
        const fallbackParams: Record<string, unknown> = {
          scene_path: sceneRelPath,
          node_type: String(args.node_type),
          node_name: String(args.node_name),
          parent_node_path: String(args.parent_node_path || 'root'),
        };
        if (args.properties) fallbackParams.properties = args.properties;
        const spawnResult = await spawnGodot(godot, ['--headless', '--path', p, '--script', ctx.opsScript, 'add_node', JSON.stringify(fallbackParams)]);
        releaseShortRunningSlot();
        if (spawnResult.timedOut) return { content: [{ type: 'text', text: 'add_node timed out.' }], isError: true };
        if (spawnResult.exitCode === -1 && spawnResult.stdout.startsWith('SPAWN_FAILED:')) return opsErrorResult('SPAWN_FAILED', `Failed to spawn Godot: ${spawnResult.stdout.replace('SPAWN_FAILED: ', '')}`);
        if (spawnResult.exitCode !== 0) return { content: [{ type: 'text', text: `add_node failed (exit code ${spawnResult.exitCode}):\n${spawnResult.stdout}${spawnResult.stderr ? '\n' + spawnResult.stderr : ''}` }], isError: true };
        return { content: [{ type: 'text', text: spawnResult.stdout.trim() || 'add_node completed successfully.' }] };
      }

      if (!result.success) {
        return textResult(`Error: ${result.message}`);
      }

      // Write back the modified .tscn
      if (result.scene) {
        writeFileSync(absPath, result.scene, 'utf-8');
      }
      // S1 (2026-06-23): BLOCKED_PROPS 命中时前置明确警告(避免"设 script 看似成功但未落盘"的静默失败)
      if (result.blockedProps && result.blockedProps.length > 0) {
        const hint = result.blockedProps.includes('script')
          ? ' For scripts use quick_scene script_path, or add an [ext_resource] + "script = ExtResource(...)" line via Write .tscn.'
          : '';
        return textResult(`⚠️ Blocked properties NOT written (security policy): ${result.blockedProps.join(', ')}.${hint}\n${result.message}`);
      }
      // Tier1-1: 成功路径补 structuredContent,让 AI 无需正则解析文本即可拿结构化数据
      return {
        ...textResult(result.message),
        structuredContent: {
          action: 'add_node',
          node_name: String(args.node_name),
          node_type: String(args.node_type),
          parent: String(args.parent_node_path || 'root'),
          scene_path: sceneRelPath,
          persisted: true,
        },
      };
    }

    case 'create_scene':
    case 'save_scene':
    case 'load_sprite': {
      if (!acquireShortRunningSlot()) return opsErrorResult('CONCURRENCY_LIMIT', 'too many concurrent headless operations (max 3). Please wait and retry.');
      const p = requireProjectPath(args);
      let godot: string;
      try { godot = await ctx.findGodot(); } catch (e) { releaseShortRunningSlot(); throw e; }

      const params: Record<string, unknown> = {};
      if (action === 'create_scene') {
        try { const sp = normalizeUserProjectPath(args.scene_path as string); resolveWithinRoot(p, sp); params.scene_path = sp; } catch { releaseShortRunningSlot(); return opsErrorResult('INVALID_PATH', 'scene_path contains path traversal'); }
        // 2026-07-12 CRITICAL RCE 复合链修复：root_node_type 补字符校验
        // 与 add_node:141 / batch_add_nodes:315 / quick_scene:257 对齐。
        // 堵特殊字符注入（shell 元字符 / 路径穿越透传到 godot_operations.gd）。
        const rootNodeType = String(args.root_node_type || 'Node2D');
        if (!/^[A-Za-z0-9_]+$/.test(rootNodeType)) {
          releaseShortRunningSlot();
          return textResult(`Error: root_node_type contains invalid characters: "${rootNodeType}"`);
        }
        params.root_node_type = rootNodeType;
        if (args.root_node_name) params.root_node_name = args.root_node_name;
      } else if (action === 'save_scene') {
        try { const sp = normalizeUserProjectPath(args.scene_path as string); resolveWithinRoot(p, sp); params.scene_path = sp; } catch { releaseShortRunningSlot(); return opsErrorResult('INVALID_PATH', 'scene_path contains path traversal'); }
        if (args.new_path) { try { const np = normalizeUserProjectPath(String(args.new_path)); resolveWithinRoot(p, np); params.new_path = np; } catch { releaseShortRunningSlot(); return opsErrorResult('INVALID_PATH', 'new_path contains path traversal'); } }
      } else if (action === 'load_sprite') {
        try { const sp = normalizeUserProjectPath(args.scene_path as string); resolveWithinRoot(p, sp); params.scene_path = sp; } catch { releaseShortRunningSlot(); return opsErrorResult('INVALID_PATH', 'scene_path contains path traversal'); }
        const tp = String(args.texture_path);
        try { sanitizeResPath(tp, 'texture_path'); } catch { releaseShortRunningSlot(); return opsErrorResult('INVALID_PATH', 'texture_path contains path traversal'); }
        params.texture_path = tp; params.node_path = args.node_path || 'root';
      }

      const result = await spawnGodot(godot, ['--headless', '--path', p, '--script', ctx.opsScript, action, JSON.stringify(params)]);
      releaseShortRunningSlot();
      if (result.timedOut) return { content: [{ type: 'text', text: `${action} timed out.` }], isError: true };
      if (result.exitCode === -1 && result.stdout.startsWith('SPAWN_FAILED:')) return opsErrorResult('SPAWN_FAILED', `Failed to spawn Godot: ${result.stdout.replace('SPAWN_FAILED: ', '')}`);
      if (result.exitCode !== 0) return { content: [{ type: 'text', text: `${action} failed (exit code ${result.exitCode}):\n${result.stdout}${result.stderr ? '\n' + result.stderr : ''}` }], isError: true };
      return { content: [{ type: 'text', text: result.stdout.trim() || `${action} completed successfully.` }] };
    }

    case 'quick_scene': {
      const p = requireProjectPath(args);
      const rawScenePath = args.scene_path as string;
      if (!rawScenePath || !rawScenePath.trim()) return opsErrorResult('INVALID_PARAMS', 'scene_path is required for quick_scene');
      const sceneRelPath = normalizeUserProjectPath(rawScenePath);
      if (!sceneRelPath) return opsErrorResult('INVALID_PARAMS', 'scene_path is required for quick_scene');
      const scriptRelPath = args.script_path ? normalizeUserProjectPath(args.script_path as string) : undefined;
      const rootNodeType = (args.root_node_type as string) || 'Node2D';
      const scriptContent = args.script_content as string | undefined;
      if (!/^[A-Za-z0-9_]+$/.test(rootNodeType)) return textResult(`Error: root_node_type contains invalid characters: "${rootNodeType}"`);
      let rootNodeName = args.root_node_name as string;
      if (!rootNodeName) { const baseName = sceneRelPath.split('/').pop()!.replace(/\.tscn$/i, ''); rootNodeName = baseName ? baseName.split('_').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join('') : 'Root'; }
      if (!rootNodeName || !/^[A-Za-z0-9_]+$/.test(rootNodeName)) return textResult(`Error: root_node_name must match /^[A-Za-z0-9_]+$/, got: "${rootNodeName}"`);
      const sceneAbsPath = resolveWithinRoot(p, sceneRelPath);
      if (existsSync(sceneAbsPath)) return textResult(`Error: Scene already exists: ${sceneRelPath}. Remove it first or use a different path.`);
      let tscnContent: string;
      if (scriptRelPath) { tscnContent = ['[gd_scene load_steps=2 format=3]', '', `[ext_resource type="Script" path="res://${scriptRelPath.replace(/\\/g, '/')}" id="1"]`, '', `[node name="${rootNodeName}" type="${rootNodeType}"]`, 'script = ExtResource("1")', ''].join('\n'); }
      else { tscnContent = ['[gd_scene format=3]', '', `[node name="${rootNodeName}" type="${rootNodeType}"]`, ''].join('\n'); }
      // B-1 (SEC-P1-1): quick_scene scriptContent 写 .gd 前过沙箱扫描(此前裸 writeFileSync 绕过,
      // tscn 绑 ExtResource → 编辑器打开/run_project 即执行)。仅在确实要写脚本时扫(已存在则内容不落盘)。
      if (scriptRelPath && scriptContent && !existsSync(resolveWithinRoot(p, scriptRelPath))) {
        const sandboxGuard = scanScriptSandboxOrThrow(scriptContent, resolveWithinRoot(p, scriptRelPath));
        if (sandboxGuard) return sandboxGuard;
      }
      try { ensureDir(sceneAbsPath); writeFileSync(sceneAbsPath, tscnContent, 'utf-8'); } catch (e: unknown) { return textResult(`Error writing scene: ${(e as Error).message}`); }
      if (scriptRelPath && scriptContent) { const scriptAbsPath = resolveWithinRoot(p, scriptRelPath); if (!existsSync(scriptAbsPath)) { try { ensureDir(scriptAbsPath); writeFileSync(scriptAbsPath, scriptContent, 'utf-8'); } catch (e: unknown) { return textResult(`Scene created but script write failed: ${(e as Error).message}`); } } }
      const parts = [`Created scene: ${sceneRelPath}`, `Root: ${rootNodeName} [${rootNodeType}]`];
      if (scriptRelPath) parts.push(`Script: res://${scriptRelPath.replace(/\\/g, '/')}`);
      if (scriptRelPath && scriptContent) parts.push(`Script file created`);
      return textResult(parts.join('\n'));
    }

    case 'query_scene_tree': {
      if (!acquireShortRunningSlot()) return opsErrorResult('CONCURRENCY_LIMIT', 'too many concurrent headless operations (max 3). Please wait and retry.');
      const p = requireProjectPath(args);
      let godot: string; try { godot = await ctx.findGodot(); } catch (e) { releaseShortRunningSlot(); throw e; }
      const scriptsDir = dirname(ctx.opsScript); const treeScript = join(scriptsDir, 'query_scene_tree.gd');
      if (!existsSync(treeScript)) { releaseShortRunningSlot(); return textResult(`Error: query_scene_tree.gd not found at ${treeScript}`); }
      const _snapScenePath = normalizeUserProjectPath(args.scene_path as string);
      // M-3: 校验 scene_path 在项目内（防 ../ 逃逸读项目外 .tscn；inspect_node.gd 只补 res:// 前缀不防穿越）
      try { resolveWithinRoot(p, _snapScenePath); } catch { releaseShortRunningSlot(); return opsErrorResult('INVALID_PATH', 'scene_path contains path traversal'); }
      const params = { scene_path: _snapScenePath, max_depth: (args.max_depth as number) || 5 };
      const result = await spawnGodot(godot, ['--headless', '--path', p, '--script', treeScript, JSON.stringify(params)]);
      releaseShortRunningSlot();
      if (result.timedOut) return textResult('query_scene_tree timed out after 60s');
      if (result.exitCode === -1 && result.stdout.startsWith('SPAWN_FAILED:')) return textResult(result.stdout);
      return textResult(JSON.stringify(parseMcpScriptOutput(result.stdout, result.exitCode ?? 0), null, 2));
    }

    case 'inspect_node': {
      if (!acquireShortRunningSlot()) return opsErrorResult('CONCURRENCY_LIMIT', 'too many concurrent headless operations (max 3). Please wait and retry.');
      const p = requireProjectPath(args);
      let godot: string; try { godot = await ctx.findGodot(); } catch (e) { releaseShortRunningSlot(); throw e; }
      const scriptsDir = dirname(ctx.opsScript); const inspectScript = join(scriptsDir, 'inspect_node.gd');
      if (!existsSync(inspectScript)) { releaseShortRunningSlot(); return textResult(`Error: inspect_node.gd not found at ${inspectScript}`); }
      const _inspScenePath = normalizeUserProjectPath(args.scene_path as string);
      // M-3: 校验 scene_path 在项目内（防 ../ 逃逸读项目外 .tscn；inspect_node.gd 只补 res:// 前缀不防穿越）
      try { resolveWithinRoot(p, _inspScenePath); } catch { releaseShortRunningSlot(); return opsErrorResult('INVALID_PATH', 'scene_path contains path traversal'); }
      const params = { scene_path: _inspScenePath, node_path: args.node_path || 'root', max_depth: (args.max_depth as number) || 3, include_signals: args.include_signals !== false, include_properties: args.include_properties !== false };
      const result = await spawnGodot(godot, ['--headless', '--path', p, '--script', inspectScript, JSON.stringify(params)]);
      releaseShortRunningSlot();
      if (result.timedOut) return textResult('inspect_node timed out after 60s');
      if (result.exitCode === -1 && result.stdout.startsWith('SPAWN_FAILED:')) return textResult(result.stdout);
      return textResult(JSON.stringify(parseMcpScriptOutput(result.stdout, result.exitCode ?? 0), null, 2));
    }

    case 'batch_add_nodes': {
      if (!acquireShortRunningSlot()) return opsErrorResult('CONCURRENCY_LIMIT', 'too many concurrent headless operations (max 3). Please wait and retry.');
      const p = requireProjectPath(args);
      const scenePath = normalizeUserProjectPath(args.scene_path as string);
      const nodes = args.nodes as Array<{ node_type: string; node_name: string; parent_node_path?: string; properties?: Record<string, unknown> }>;
      if (!nodes || !Array.isArray(nodes) || nodes.length === 0) { releaseShortRunningSlot(); return opsErrorResult('INVALID_PARAMS', '"nodes" must be a non-empty array of node definitions.'); }
      if (nodes.length > 100) { releaseShortRunningSlot(); return textResult(`Error: Too many nodes (${nodes.length}). Maximum: 100`); }
      for (let i = 0; i < nodes.length; i++) { const n = nodes[i]!; if (!n.node_type || !/^[A-Za-z0-9_]+$/.test(String(n.node_type))) { releaseShortRunningSlot(); return textResult(`Error: nodes[${i}].node_type contains invalid characters: "${n.node_type}"`); } if (!n.node_name || /[\]["/:\\]/.test(String(n.node_name))) { releaseShortRunningSlot(); return textResult(`Error: nodes[${i}].node_name contains invalid characters: "${n.node_name}"`); } }
      // P1-2 (2026-07-19 spec editor-version-tear §6): editor 场景写守卫——batch_add_nodes fallback headless
      // 路径(若该场景在 editor 打开, headless 改盘会被 editor GUI save 覆盖回旧版)。此 case 无 try/finally,
      // 守卫 return 前手动 releaseShortRunningSlot(否则 slot 泄漏)。acquire 已在 :317 完成。
      const absPath = resolveWithinRoot(p, scenePath);
      if (!existsSync(absPath)) { releaseShortRunningSlot(); return opsErrorResult('FILE_NOT_FOUND', `Scene file not found: ${scenePath}`); }
      if (ctx.checkEditorSceneSave) {
        const sceneGuard = await ctx.checkEditorSceneSave(absPath);
        if (sceneGuard.blocked) { releaseShortRunningSlot(); return opsErrorResult('EDITOR_SCENE_OPEN', sceneGuard.message ?? `Scene open in editor: ${absPath}`); }
      }
      let godot: string; try { godot = await ctx.findGodot(); } catch (e) { releaseShortRunningSlot(); throw e; }
      const result = await spawnGodot(godot, ['--headless', '--path', p, '--script', ctx.opsScript, 'batch_add_nodes', JSON.stringify({ scene_path: scenePath, nodes })]);
      releaseShortRunningSlot();
      if (result.timedOut) return errorResult('batch_add_nodes timed out after 60s.');
      if (result.exitCode === -1 && result.stdout.startsWith('SPAWN_FAILED:')) return errorResult(result.stdout);
      if (result.exitCode !== 0) return errorResult(`batch_add_nodes failed (exit code ${result.exitCode}):\n${result.stdout}`);
      // IMPORTANT-1 (2026-06-23 审查修复): batch_add_nodes 走 GDScript ops(_is_safe_property 过滤),
      // 不经 TS _addNodesInner(其 allBlocked 聚合在此路径不生效)。TS 侧前置收集 BLOCKED_PROPS 命中,
      // 警告——与 add_node/edit_node 一致,避免 batch 路径静默 drop script 等(削弱 S1 完整性)。
      const batchBlocked: string[] = [];
      for (const n of nodes) {
        if (n.properties) for (const k of Object.keys(n.properties)) {
          if (BLOCKED_PROPS.has(k) && !batchBlocked.includes(k)) batchBlocked.push(k);
        }
      }
      const batchOut = result.stdout.trim() || `batch_add_nodes completed: ${nodes.length} nodes added.`;
      if (batchBlocked.length > 0) {
        const hint = batchBlocked.includes('script') ? ' For scripts use quick_scene script_path or Write .tscn ExtResource.' : '';
        return { content: [{ type: 'text' as const, text: `⚠️ Blocked properties NOT written (security policy): ${batchBlocked.join(', ')}.${hint}\n${batchOut}` }] };
      }
      return { content: [{ type: 'text', text: batchOut }] };
    }

    case 'edit_node': {
      const spErr = requireScenePath(args.scene_path); if (spErr) return spErr;
      if (!acquireShortRunningSlot()) return opsErrorResult('CONCURRENCY_LIMIT', 'too many concurrent headless operations (max 3). Please wait and retry.');
      try {
        const p = requireProjectPath(args);
        const scenePath = normalizeUserProjectPath(args.scene_path as string);
        // P1-2 (2026-07-19 spec editor-version-tear §6): editor 场景写守卫——edit_node fallback headless
        // 路径(若该场景在 editor 打开, headless 改盘会被 editor GUI save 覆盖回旧版)。守卫在 try 块内,
        // return 依赖 finally 的 releaseShortRunningSlot,此处不手动 release(否则 double-release)。
        const absPath = resolveWithinRoot(p, scenePath);
        if (!existsSync(absPath)) return opsErrorResult('FILE_NOT_FOUND', `Scene file not found: ${scenePath}`);
        if (ctx.checkEditorSceneSave) {
          const sceneGuard = await ctx.checkEditorSceneSave(absPath);
          if (sceneGuard.blocked) return opsErrorResult('EDITOR_SCENE_OPEN', sceneGuard.message ?? `Scene open in editor: ${absPath}`);
        }
        const nodePath = normalizeNodePath(args.node_path as string);
        const properties = args.properties as Record<string, unknown>;
        if (!properties || typeof properties !== 'object' || Object.keys(properties).length === 0) return opsErrorResult('INVALID_PARAMS', '"properties" must be a non-empty object.');
        // S1: BLOCKED_PROPS 前置警告（与 add_node/batch 一致，避免静默失败）
        const blockedKeys: string[] = [];
        for (const key of Object.keys(properties)) {
          if (BLOCKED_PROPS.has(key) && !blockedKeys.includes(key)) blockedKeys.push(key);
        }
        let godot: string;
        try { godot = await ctx.findGodot(); } catch (e) { releaseShortRunningSlot(); throw e; }
        const result = await spawnGodot(godot, ['--headless', '--path', p, '--script', ctx.opsScript, 'edit_node', JSON.stringify({ scene_path: scenePath, node_path: nodePath, properties })]);
        releaseShortRunningSlot();
        if (result.timedOut) return errorResult('edit_node timed out after 60s.');
        if (result.exitCode === -1 && result.stdout.startsWith('SPAWN_FAILED:')) return errorResult(result.stdout);
        if (result.exitCode !== 0) return errorResult(`edit_node failed (exit code ${result.exitCode}):\n${result.stdout}`);
        const out = result.stdout.trim() || `edit_node completed.`;
        if (blockedKeys.length > 0) {
          const hint = blockedKeys.includes('script') ? ' For scripts use quick_scene script_path or Write .tscn with [ext_resource].' : '';
          return { content: [{ type: 'text' as const, text: `⚠️ Blocked properties NOT applied (security policy): ${blockedKeys.join(', ')}.${hint}\n${out}` }] };
        }
        return { content: [{ type: 'text', text: out }] };
      } finally { releaseShortRunningSlot(); }
    }

    case 'remove_node': {
      const spErr = requireScenePath(args.scene_path); if (spErr) return spErr;
      if (!acquireShortRunningSlot()) return opsErrorResult('CONCURRENCY_LIMIT', 'too many concurrent headless operations (max 3). Please wait and retry.');
      try {
        const p = requireProjectPath(args); const scenePath = resolveWithinRoot(p, normalizeUserProjectPath(args.scene_path as string)); const nodePath = normalizeNodePath(args.node_path as string);
        const script = `${SCENE_TREE_HEADER}\nfunc _initialize():\n\tif not _mcp_load_scene("${escapeForGdLiteral(scenePath)}"):\n\t\t_mcp_done()\n\t\treturn\n\tvar node = _mcp_get_scene_node("${escapeForGdLiteral(nodePath)}")\n\tif node == null:\n\t\t_mcp_output("error", "Node not found: ${escapeForGdLiteral(nodePath)}")\n\t\t_mcp_done()\n\t\treturn\n\tvar parent = node.get_parent()\n\tvar node_name = node.name\n\tif parent:\n\t\tvar child_owner = node.owner\n\t\tparent.remove_child(node)\n\t\tnode.queue_free()\n\t\t_mcp_output("removed", {"node": "${escapeForGdLiteral(nodePath)}", "name": str(node_name)})\n\telse:\n\t\t_mcp_output("error", "Cannot remove root node")\n\t_mcp_done()\n`;
        const godot = await ctx.findGodot(); const loadAutoloads = args.load_autoloads !== false;
        return parseGdscriptResult(await executeGdscript({ godotPath: godot, projectPath: p, code: script, timeout: 30, loadAutoloads }), [], (msg) => msg.includes('not found') ? 'NODE_NOT_FOUND' : 'SCRIPT_EXEC_FAILED', { suggestion: 'Use query_scene_tree to list available nodes, or inspect_node to check a specific path.' });
      } finally { releaseShortRunningSlot(); }
    }

    case 'instance_scene': return handleInstanceScene(args, ctx);
    case 'set_instance_property': return handleSetInstanceProperty(args, ctx);
    case 'detach_instance': return handleDetachInstance(args);

    case 'open_scene': {
      // editor-only：editor 模式由 editor-method-map 提前拦截走 command_handler.handle_open_scene，
      // headless 无 EditorInterface（无"活动场景"概念）→ 返 EDITOR_ONLY（与 asset 写工具惯例一致）
      return opsErrorResult('EDITOR_ONLY', 'open_scene requires editor mode. Set GODOT_MCP_MODE=editor and install the Godot plugin.');
    }

    case 'health_check': {
      const p = requireProjectPath(args); const scenePath = args.scene_path as string;
      if (!scenePath || typeof scenePath !== 'string') return opsErrorResult('INVALID_PARAMS', 'scene_path is required for health_check', { suggestion: 'Provide the scene file path relative to project, e.g. "scenes/main.tscn"' });
      const fullPath = resolveWithinRoot(p, scenePath); if (!existsSync(fullPath)) return opsErrorResult('FILE_NOT_FOUND', `Scene not found: ${scenePath}`);
      const result = checkSceneHealth(readFileSync(fullPath, 'utf-8'), scenePath);
      return textResult(JSON.stringify({ scene: scenePath, healthy: result.issues.length === 0, issue_count: result.issues.length, issues: result.issues, nodes_checked: result.nodesChecked }, null, 2));
    }

    case 'merge_scene': {
      const p = requireProjectPath(args); const sceneA = args.scene_path as string; const sceneB = args.new_path as string;
      if (!sceneA || !sceneB) return opsErrorResult('INVALID_PARAMS', 'Both scene_path (ours) and new_path (theirs) are required', { suggestion: 'Provide two scene file paths: scene_path=ours.tscn new_path=theirs.tscn' });
      const fullPathA = resolveWithinRoot(p, sceneA); const fullPathB = resolveWithinRoot(p, sceneB);
      if (!existsSync(fullPathA)) return opsErrorResult('FILE_NOT_FOUND', `Scene A not found: ${sceneA}`);
      if (!existsSync(fullPathB)) return opsErrorResult('FILE_NOT_FOUND', `Scene B not found: ${sceneB}`);
      const MAX = 10 * 1024 * 1024; const statA = statSync(fullPathA); const statB = statSync(fullPathB);
      if (statA.size > MAX || statB.size > MAX) return opsErrorResult('FILE_TOO_LARGE', `Scene file exceeds 10MB merge limit (A: ${statA.size}B, B: ${statB.size}B)`);
      const ours = readFileSync(fullPathA, 'utf-8'); const theirs = readFileSync(fullPathB, 'utf-8');
      writeAtomic(fullPathA, mergeTscn(ours, theirs));
      return textResult(JSON.stringify({ merged_into: sceneA, source: sceneB, status: 'ok' }, null, 2));
    }

    case 'create_3d_node':
      return handleCreate3dNode(args, ctx);
    case 'commit':
      return handleCommitAction(args, ctx);

    default: return opsErrorResult('UNKNOWN_ACTION', `Unknown action: ${action}`);
  }
  // Unreachable for well-formed action strings, but satisfies TS control flow
  return null;
}


export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean; actionRisks?: Record<string, RiskLevel> }> = {
  scene: {
    readonly: false,
    long_running: true,
    actionRisks: {
      read_scene: 'read', query_scene_tree: 'read', inspect_node: 'read', health_check: 'read',
      create_scene: 'write', quick_scene: 'write', add_node: 'write', batch_add_nodes: 'write',
      edit_node: 'write', save_scene: 'write', load_sprite: 'write', instance_scene: 'write',
      set_instance_property: 'write', detach_instance: 'write', create_3d_node: 'write', commit: 'write',
      open_scene: 'write',
      remove_node: 'destructive', merge_scene: 'destructive',
    } satisfies Record<typeof ACTIONS[number], RiskLevel>,
  },
};
