import type { Tool } from "@modelcontextprotocol/server";

// UI tool entry point: definitions, handler, and meta.
import type { ToolContext, ToolResult } from '../../types.js';
import type { RiskLevel } from '../../core/tool-registry.js';
import { getErrorMessage } from '../../types.js';
import { requireProjectPath, resolveWithinRoot, normalizeUserProjectPath } from '../../helpers.js';
import { executeGdscriptTrusted } from '../../gdscript-executor.js';
import { normalizeNodePath, sanitizeResPath, opsErrorResult, parseGdscriptResult, opsSuccess, NON_PERSIST, appendRuntimePersistWarning } from '../shared.js';
import { ACTIONS, CONTROL_TYPES, ANCHOR_PRESETS, ERROR_CODES, DRAW_OP_KINDS, findBlockedProps } from './types.js';
import type { DrawOp, UiNodeSpec } from './types.js';
import { genUiCreateControlScript, genUiContainerAddScript, genUiAnchorPresetScript } from './ui-create.js';
import { genUiSetLayoutScript, genUiGetLayoutScript, genUiBuildLayoutScript } from './ui-layout.js';
import { genUiSetThemeScript, genThemeCreateScript, genThemeSetPropertyScript } from './ui-theme.js';
import { genUiDrawRecipeScript } from './ui-draw.js';
import { genUiMeasureScript } from './ui-measure.js';
import { genUiImportSingleScript } from './ui-import-single.js';
import { flattenTargets, flattenStyleTargets, styleExpectList, diffLayout, diffStyles, diffFlow, detectOverlaps, detectOutOfBounds } from './layout-diff.js';
import type { MeasuredNode } from './layout-diff.js';
import { parseGeometry, translateGeometry } from './prototype-import.js';
import type { PrototypeGeometry, TranslateResult } from './prototype-import.js';
import { runPixelVerify } from './pixel-verify.js';
import { textResult } from '../../types.js';
import { readFileSync } from 'node:fs';

// ─── Tool Definitions ──────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'ui',
      description: `UI operations. Nodes: ui_create_control, ui_container_add, ui_build_layout. Layout: ui_set_layout, ui_get_layout, ui_anchor_preset. Prototype: ui_import_prototype (geometry JSON → translate + build + measure + check + persist in one call; bg/fill/borderRadius/border→StyleBoxFlat saved as theme_override_styles/<slot>; returns style_verify per-slot style diff / flow_verify rect diff of a flow's direct children). Final pixel check: ui_pixel_verify (samples bg node screenshots vs target colour RGB distance; opens a window on Windows; run once after geometry + style_verify are all green). Theme: ui_set_theme, theme_create, theme_set_property. Drawing: ui_draw_recipe. ${NON_PERSIST}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot project directory' },
          action: {
            type: 'string',
            enum: [...ACTIONS],
            description: 'Operation',
          },
          scene_path: { type: 'string', description: 'Scene path (project-relative). Optional for ui_set_theme/theme_set_property; required for ui_pixel_verify — an already built scene (the output of ui_import_prototype persist)' },
          node_path: { type: 'string', description: 'Node path (ui_set_layout/ui_get_layout/ui_anchor_preset/ui_set_theme/ui_container_add/ui_draw_recipe)' },
          node_type: {
            type: 'string',
            enum: [...CONTROL_TYPES],
            description: 'ui_create_control/ui_container_add: Control subclass type',
          },
          node_name: { type: 'string', description: 'ui_create_control: new node name' },
          parent_node_path: { type: 'string', description: 'ui_create_control: parent node path (default root)' },
          properties: {
            type: 'object',
            description: 'ui_create_control: optional properties (string/number/bool/null)',
            additionalProperties: true,
          },
          anchors: {
            type: 'object',
            description: 'ui_set_layout: anchors {left, right, top, bottom}, values 0-1',
            properties: {
              left: { type: 'number' },
              right: { type: 'number' },
              top: { type: 'number' },
              bottom: { type: 'number' },
            },
          },
          offsets: {
            type: 'object',
            description: 'ui_set_layout: offsets {left, right, top, bottom} in pixels',
            properties: {
              left: { type: 'number' },
              right: { type: 'number' },
              top: { type: 'number' },
              bottom: { type: 'number' },
            },
          },
          min_size: {
            type: 'object',
            description: 'ui_set_layout: minimum size {x, y}',
            properties: { x: { type: 'number' }, y: { type: 'number' } },
          },
          custom_minimum_size: {
            type: 'object',
            description: 'ui_set_layout: custom minimum size {x, y}',
            properties: { x: { type: 'number' }, y: { type: 'number' } },
          },
          grow_direction: {
            type: 'string',
            enum: ['both', 'up', 'down', 'left', 'right'],
            description: 'ui_set_layout: grow direction',
          },
          preset: {
            type: 'string',
            enum: Object.keys(ANCHOR_PRESETS),
            description: 'ui_anchor_preset: anchor preset name',
          },
          theme_action: {
            type: 'string',
            enum: ['set_params', 'create', 'save', 'load'],
            description: 'ui_set_theme: operation (set_params/create/save/load)',
          },
          theme_path: { type: 'string', description: 'ui_set_theme: Theme resource path (required for save/load)' },
          params: {
            type: 'object',
            description: 'ui_set_theme(set_params): key/values (number/bool/string/array[4]→Color)',
            additionalProperties: true,
          },
          child_type: {
            type: 'string',
            enum: [...CONTROL_TYPES],
            description: 'ui_container_add: child Control type',
          },
          child_name: { type: 'string', description: 'ui_container_add: child node name' },
          child_properties: {
            type: 'object',
            description: 'ui_container_add: child properties (string/number/bool/null)',
            additionalProperties: true,
          },
          theme_create_action: {
            type: 'string',
            enum: ['create', 'extract'],
            description: 'theme_create: operation (create = empty Theme | extract = extract from a node)',
          },
          source_node_path: { type: 'string', description: 'theme_create(extract): source node path' },
          save_path: { type: 'string', description: 'theme_create: optional save path (res://themes/xxx.tres)' },
          theme_node_path: { type: 'string', description: 'theme_set_property: path of the node that owns the Theme' },
          item_type: {
            type: 'string',
            enum: ['default_font', 'color', 'constant', 'stylebox'],
            description: 'theme_set_property: item type',
          },
          prop_name: { type: 'string', description: 'theme_set_property: property name' },
          theme_type: { type: 'string', description: 'theme_set_property: Theme type name (optional)' },
          value: {
            description: 'theme_set_property: value (resource path for default_font/stylebox, [r,g,b,a] for color, a number for constant)',
          },
          ops: {
            type: 'array',
            description: 'ui_draw_recipe: drawing operations (max 200)',
            items: {
              type: 'object',
              properties: {
                kind: { type: 'string', enum: [...DRAW_OP_KINDS], description: 'Operation' },
                position: { type: 'array', items: { type: 'number' }, description: '[x, y]' },
                size: { type: 'array', items: { type: 'number' }, description: '[w, h]' },
                center: { type: 'array', items: { type: 'number' }, description: '[x, y] centre' },
                radius: { type: 'number', description: 'Radius' },
                from: { type: 'array', items: { type: 'number' }, description: '[x, y] start' },
                to: { type: 'array', items: { type: 'number' }, description: '[x, y] end' },
                start_angle: { type: 'number', description: 'Start angle (radians)' },
                end_angle: { type: 'number', description: 'End angle (radians)' },
                points: { type: 'array', items: { type: 'array', items: { type: 'number' } }, description: '[[x,y], ...]' },
                text: { type: 'string', description: 'Text' },
                color: { type: 'array', items: { type: 'number' }, description: '[r,g,b] or [r,g,b,a], 0-1' },
                width: { type: 'number', description: 'Line width' },
                filled: { type: 'boolean', description: 'Filled (default true)' },
                font_size: { type: 'number', description: 'Font size (default 16)' },
              },
              required: ['kind'],
            },
          },
          max_depth: { type: 'number', description: 'ui_measure_layout: max traversal depth (default 16, max 64)' },
          expect_tree: { type: 'object', description: 'ui_measure_layout: optional target tree (same as the ui_build_layout tree, with rects); when given, outputs per-node diffs / overlaps / out-of-bounds', additionalProperties: true },
          geometry: {
            type: 'object',
            description: 'ui_import_prototype/ui_pixel_verify: prototype geometry JSON (inline {viewport,nodes}, flat viewport coordinates; or geometry_path — this one wins if both are given; style fields: bg/fill (ProgressBar fill slot colour)/borderRadius (number or {tl,tr,br,bl})/border ({width,color}) → StyleBoxFlat in the slots of four controls (Panel/ProgressBar/Button/Label))',
            additionalProperties: true,
          },
          geometry_path: { type: 'string', description: 'ui_import_prototype/ui_pixel_verify: geometry JSON file path (project-relative, res:// prefix supported; or geometry)' },
          tolerance: { type: 'number', description: 'ui_import_prototype: layout_verify tolerance (px, default 2)' },
          parent_path: { type: 'string', description: 'ui_build_layout: parent node path; ui_import_prototype: must be a node aligned to the origin (global_position≈0,0), default root — when mounted elsewhere, layout_verify solves root-level entries against the viewport origin and root-level diffs are always false alarms' },
          tree: {
            type: 'object',
            description: 'ui_build_layout: UI node tree (max depth 10); nodes may carry styleboxes: [{slot: panel|normal|background|fill|hover|pressed|disabled, box: {bg_color:[r,g,b,a] 0-1, corner_radius: number or {tl,tr,br,bl}, border_width, border_color, draw_center}}] → add_theme_stylebox_override(StyleBoxFlat)',
            properties: {
              type: { type: 'string', enum: [...CONTROL_TYPES], description: 'Control subclass' },
              name: { type: 'string', description: 'Node name' },
              properties: { type: 'object', additionalProperties: true, description: 'Node properties' },
              anchor_preset: { type: 'string', enum: Object.keys(ANCHOR_PRESETS), description: 'Anchor preset' },
              layout: {
                type: 'object',
                description: 'CSS Flexbox layout description (overrides the type field when present)',
                properties: {
                  direction: { type: 'string', enum: ['row', 'column', 'row-reverse', 'column-reverse', 'grid'], description: 'Main axis direction' },
                  justify: { type: 'string', enum: ['flex-start', 'center', 'flex-end', 'space-between', 'space-around', 'space-evenly'], description: 'Main axis alignment' },
                  align: { type: 'string', enum: ['stretch', 'flex-start', 'center', 'flex-end'], description: 'Cross axis alignment' },
                  wrap: { type: 'string', enum: ['nowrap', 'wrap'], description: 'Wrap mode' },
                  gap: { type: 'number', description: 'Main axis gap' },
                  row_gap: { type: 'number', description: 'Row gap when wrapping (wrap mode only)' },
                  columns: { type: 'number', description: 'Grid column count (grid direction only)' },
                  padding: {
                    description: 'Padding: a number or [top, right, bottom, left]',
                    oneOf: [
                      { type: 'number' },
                      { type: 'array', items: { type: 'number' } },
                    ],
                  },
                },
                required: ['direction'],
              },
              flex: {
                type: 'object',
                description: 'Child flex settings',
                properties: {
                  grow: { type: 'number', description: 'Grow ratio (0 = don\'t grow)' },
                  shrink: { type: 'number', description: 'Shrink ratio (ignored, no Godot equivalent)' },
                  align_self: { type: 'string', enum: ['auto', 'flex-start', 'center', 'flex-end', 'stretch'], description: 'Per-item alignment override' },
                  min_width: { type: 'number', description: 'Min width' },
                  min_height: { type: 'number', description: 'Min height' },
                  max_width: { type: 'number', description: 'Max width (ignored, no Godot equivalent)' },
                  max_height: { type: 'number', description: 'Max height (ignored, no Godot equivalent)' },
                },
              },
              children: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'Children' },
            },
            required: ['type', 'name'],
          },
          load_autoloads: { type: 'boolean', description: 'Load the Autoload context (default true)' },
          viewport: {
            type: 'object',
            description: 'ui_build_layout: reference size {w, h} for solving the root rect (default 1280x720, must be positive; when it matches the project\'s display/window/size the root rect is the viewport\'s absolute geometry); ui_import_prototype: optional, defaults to geometry.viewport',
            properties: { w: { type: 'number', description: 'Width (px)' }, h: { type: 'number', description: 'Height (px)' } },
          },
          persist: { type: 'boolean', description: 'ui_build_layout: persist to .tscn (atomic write; default false = runtime only)' },
        },
        required: ['action'],
      },
    },
  ];
}

// ─── Tool Handler ───────────────────────────────────────────────────────────

// follow-up C5: Control 创造/改节点树（headless 退出丢失）→ 加提示；ui_get_layout 查询 +
// ui_set_theme/theme_create/theme_set_property（Theme 资源，C5 文案 add_node 错位）不加。
const UI_PERSIST_ACTIONS = new Set(['ui_create_control', 'ui_set_layout', 'ui_anchor_preset', 'ui_container_add', 'ui_draw_recipe', 'ui_build_layout']);

export async function handleTool(
  name: string, args: Record<string, unknown>, ctx: ToolContext
): Promise<ToolResult | null> {
  if (name !== 'ui') return null;

  const action = args.action as string;
  if (!action) return opsErrorResult('INVALID_PARAMS', 'action is required');

  try {
    const projectPath = requireProjectPath(args);
    const godot = await ctx.findGodot();
    const loadAutoloads = args.load_autoloads !== false;
    let script: string;

    switch (action) {
      case 'ui_create_control': {
        const scenePath = resolveWithinRoot(projectPath, normalizeUserProjectPath(args.scene_path as string));
        const nodeType = args.node_type as string;
        const nodeName = args.node_name as string;
        if (!CONTROL_TYPES.includes(nodeType as typeof CONTROL_TYPES[number])) {
          return opsErrorResult(ERROR_CODES.INVALID_CONTROL_TYPE,
            `Invalid node_type "${nodeType}". Must be one of: ${CONTROL_TYPES.join(', ')}`);
        }
        if (!nodeName) {
          return opsErrorResult(ERROR_CODES.INVALID_PARAMS, 'node_name is required');
        }
        const parentPath = normalizeNodePath((args.parent_node_path as string) || 'root');
        const properties = args.properties as Record<string, unknown> | undefined;
        const blocked = findBlockedProps(properties);
        if (blocked.length) {
          return opsErrorResult(ERROR_CODES.INVALID_PARAMS,
            `Property key(s) blocked (BLOCKED_PROPS security policy): ${blocked.join(', ')}. Keys like script/owner/name/instance are not settable via UI properties.`);
        }
        script = genUiCreateControlScript(scenePath, nodeType, nodeName, parentPath, properties);
        break;
      }
      case 'ui_set_layout': {
        const scenePath = resolveWithinRoot(projectPath, normalizeUserProjectPath(args.scene_path as string));
        const nodePath = normalizeNodePath(args.node_path as string);
        const anchors = args.anchors as { left?: number; right?: number; top?: number; bottom?: number } | undefined;
        const offsets = args.offsets as { left?: number; right?: number; top?: number; bottom?: number } | undefined;
        const minSize = args.min_size as { x?: number; y?: number } | undefined;
        const customMinSize = args.custom_minimum_size as { x?: number; y?: number } | undefined;
        const growDirection = args.grow_direction as string | undefined;
        script = genUiSetLayoutScript(scenePath, nodePath, anchors, offsets, minSize, customMinSize, growDirection);
        break;
      }
      case 'ui_get_layout': {
        const scenePath = resolveWithinRoot(projectPath, normalizeUserProjectPath(args.scene_path as string));
        const nodePath = normalizeNodePath(args.node_path as string);
        script = genUiGetLayoutScript(scenePath, nodePath);
        break;
      }
      case 'ui_anchor_preset': {
        const scenePath = resolveWithinRoot(projectPath, normalizeUserProjectPath(args.scene_path as string));
        const nodePath = normalizeNodePath(args.node_path as string);
        const presetName = args.preset as string;
        if (!(presetName in ANCHOR_PRESETS)) {
          return opsErrorResult(ERROR_CODES.INVALID_ANCHOR_PRESET,
            `Invalid preset "${presetName}". Must be one of: ${Object.keys(ANCHOR_PRESETS).join(', ')}`);
        }
        const presetValue = ANCHOR_PRESETS[presetName]!;
        script = genUiAnchorPresetScript(scenePath, nodePath, presetValue, presetName);
        break;
      }
      case 'ui_set_theme': {
        const scenePath = resolveWithinRoot(projectPath, normalizeUserProjectPath(args.scene_path as string));
        const nodePath = normalizeNodePath(args.node_path as string);
        const themeAction = args.theme_action as string;
        if (!['set_params', 'create', 'save', 'load'].includes(themeAction)) {
          return opsErrorResult(ERROR_CODES.INVALID_PARAMS,
            `Invalid theme_action "${themeAction}". Must be one of: set_params, create, save, load`);
        }
        const themePath = args.theme_path as string | undefined;
        if ((themeAction === 'save' || themeAction === 'load') && !themePath) {
          return opsErrorResult(ERROR_CODES.INVALID_PARAMS, `theme_path is required for ${themeAction} action`);
        }
        if (themePath) {
          try { sanitizeResPath(themePath, 'theme_path'); } catch {
            return opsErrorResult(ERROR_CODES.INVALID_PARAMS, 'theme_path contains path traversal');
          }
        }
        const params = args.params as Record<string, unknown> | undefined;
        script = genUiSetThemeScript(scenePath, nodePath, themeAction as 'set_params' | 'create' | 'save' | 'load', themePath, params);
        break;
      }
      case 'ui_container_add': {
        const scenePath = resolveWithinRoot(projectPath, normalizeUserProjectPath(args.scene_path as string));
        const nodePath = normalizeNodePath(args.node_path as string);
        const childType = args.child_type as string;
        if (!CONTROL_TYPES.includes(childType as typeof CONTROL_TYPES[number])) {
          return opsErrorResult(ERROR_CODES.INVALID_CONTROL_TYPE,
            `Invalid child_type "${childType}". Must be one of: ${CONTROL_TYPES.join(', ')}`);
        }
        const childName = args.child_name as string;
        if (!childName) {
          return opsErrorResult(ERROR_CODES.INVALID_PARAMS, 'child_name is required');
        }
        const childProperties = args.child_properties as Record<string, unknown> | undefined;
        const blocked = findBlockedProps(childProperties);
        if (blocked.length) {
          return opsErrorResult(ERROR_CODES.INVALID_PARAMS,
            `Child property key(s) blocked (BLOCKED_PROPS security policy): ${blocked.join(', ')}. Keys like script/owner/name/instance are not settable via UI properties.`);
        }
        script = genUiContainerAddScript(scenePath, nodePath, childType, childName, childProperties);
        break;
      }
      case 'theme_create': {
        const themeCreateAction = args.theme_create_action as string;
        if (!['create', 'extract'].includes(themeCreateAction)) {
          return opsErrorResult(ERROR_CODES.INVALID_PARAMS,
            `Invalid theme_create_action "${themeCreateAction}". Must be one of: create, extract`);
        }
        const sourceNodePath = args.source_node_path as string | undefined;
        const savePath = args.save_path as string | undefined;
        if (savePath) {
          try { sanitizeResPath(savePath, 'save_path'); } catch {
            return opsErrorResult(ERROR_CODES.INVALID_PARAMS, 'save_path contains path traversal');
          }
        }
        if (themeCreateAction === 'extract' && !sourceNodePath) {
          return opsErrorResult(ERROR_CODES.INVALID_PARAMS, 'source_node_path is required for extract action');
        }
        const scenePath = args.scene_path as string | undefined;
        const resolvedScenePath = scenePath
          ? resolveWithinRoot(projectPath, normalizeUserProjectPath(scenePath))
          : '';
        if (!resolvedScenePath) {
          return opsErrorResult(ERROR_CODES.INVALID_PARAMS, 'scene_path is required for theme_create');
        }
        const normalizedSourcePath = sourceNodePath ? normalizeNodePath(sourceNodePath) : undefined;
        script = genThemeCreateScript(resolvedScenePath, themeCreateAction as 'create' | 'extract', normalizedSourcePath, savePath);
        break;
      }
      case 'theme_set_property': {
        const themeNodePath = normalizeNodePath(args.theme_node_path as string);
        const itemType = args.item_type as string;
        if (!['default_font', 'color', 'constant', 'stylebox'].includes(itemType)) {
          return opsErrorResult(ERROR_CODES.INVALID_THEME_ITEM_TYPE,
            `Invalid item_type "${itemType}". Must be one of: default_font, color, constant, stylebox`);
        }
        const propName = (args.prop_name || args.name) as string;
        if (!propName) {
          return opsErrorResult(ERROR_CODES.INVALID_THEME_PROPERTY, 'prop_name (or name) is required');
        }
        const value = args.value;
        if (value === undefined || value === null) {
          return opsErrorResult(ERROR_CODES.INVALID_THEME_PROPERTY, 'value is required');
        }
        const themeType = args.theme_type as string | undefined;
        const scenePathParam = args.scene_path as string | undefined;
        const resolvedScenePath = scenePathParam
          ? resolveWithinRoot(projectPath, normalizeUserProjectPath(scenePathParam))
          : undefined;
        script = genThemeSetPropertyScript(
          projectPath, themeNodePath,
          itemType as 'default_font' | 'color' | 'constant' | 'stylebox',
          propName, value, themeType, resolvedScenePath,
        );
        break;
      }
      case 'ui_draw_recipe': {
        const scenePath = resolveWithinRoot(projectPath, normalizeUserProjectPath(args.scene_path as string));
        const nodePath = normalizeNodePath(args.node_path as string);
        const ops = args.ops as DrawOp[];
        if (!Array.isArray(ops)) {
          return opsErrorResult(ERROR_CODES.INVALID_DRAW_OP, 'ops must be an array');
        }
        try {
          script = genUiDrawRecipeScript(scenePath, nodePath, ops);
        } catch (err) {
          const msg = getErrorMessage(err);
          if (msg.includes('Unknown draw op kind') || msg.includes('Maximum') || msg.includes('Color must be')) {
            return opsErrorResult(ERROR_CODES.INVALID_DRAW_OP, msg);
          }
          return opsErrorResult(ERROR_CODES.SCRIPT_EXEC_FAILED, msg);
        }
        break;
      }
      case 'ui_build_layout': {
        const scenePath = resolveWithinRoot(projectPath, normalizeUserProjectPath(args.scene_path as string));
        const parentPath = normalizeNodePath((args.parent_path as string) || 'root');
        const tree = args.tree as UiNodeSpec;
        if (!tree || typeof tree !== 'object') {
          return opsErrorResult(ERROR_CODES.INVALID_PARAMS, 'tree is required and must be an object');
        }
        const persist = args.persist === true;
        // C1: viewport 参数——根节点 rect 的求解基准;非正数(含缺项/NaN)→ INVALID_PARAMS
        let viewport: { w: number; h: number } | undefined;
        if (args.viewport !== undefined) {
          const vp = args.viewport as { w?: unknown; h?: unknown };
          const w = typeof vp.w === 'number' ? vp.w : NaN;
          const h = typeof vp.h === 'number' ? vp.h : NaN;
          if (!(w > 0) || !(h > 0)) {
            return opsErrorResult(ERROR_CODES.INVALID_PARAMS, 'viewport must be an object {w, h} with positive numbers');
          }
          viewport = { w, h };
        }
        try {
          script = genUiBuildLayoutScript(scenePath, parentPath, tree, viewport, persist);
        } catch (err) {
          const msg = getErrorMessage(err);
          if (msg.includes('INVALID_CONTROL_TYPE')) {
            return opsErrorResult(ERROR_CODES.INVALID_CONTROL_TYPE, msg);
          }
          if (msg.includes('INVALID_ANCHOR_PRESET')) {
            return opsErrorResult(ERROR_CODES.INVALID_ANCHOR_PRESET, msg);
          }
          if (msg.includes('name is required') || msg.includes('Maximum nesting') || msg.includes('INVALID_PARAMS')) {
            return opsErrorResult(ERROR_CODES.INVALID_PARAMS, msg);
          }
          return opsErrorResult(ERROR_CODES.SCRIPT_EXEC_FAILED, msg);
        }
        break;
      }
      case 'ui_measure_layout': {
        const scenePath = resolveWithinRoot(projectPath, normalizeUserProjectPath(args.scene_path as string));
        const nodePathRaw = args.node_path as string | undefined;
        const maxDepth = typeof args.max_depth === 'number' ? args.max_depth : 16;
        const expectTree = args.expect_tree as UiNodeSpec | undefined;
        if (expectTree && (typeof expectTree !== 'object' || !expectTree.name)) {
          return opsErrorResult(ERROR_CODES.INVALID_PARAMS, 'expect_tree must be a tree object with name');
        }
        // PR-2:expect_tree 带 styleboxes → 期望清单内嵌 measure 脚本(读回判定并集左侧)
        const styleExpect = expectTree ? styleExpectList(flattenStyleTargets(expectTree)) : undefined;
        script = genUiMeasureScript(scenePath, nodePathRaw ? normalizeNodePath(nodePathRaw) : undefined, maxDepth, styleExpect);
        break;
      }
      case 'ui_pixel_verify':
        // 特殊链路:capture 是独立 spawn(窗口模式 driver 参数不同,spec §5 capture 不并入
        // executor 链),不走公共单次执行段,提前 return——同 ui_import_prototype 模式。
        return await handleUiPixelVerify(args, projectPath, godot);
      case 'ui_import_prototype':
        // 特殊链路:内部单 spawn 合成(build+persist→reload→measure,PR-4),不走公共单次执行段,提前 return。
        return handleUiImportPrototype(args, projectPath, godot, loadAutoloads);
      default:
        return opsErrorResult('UNKNOWN_ACTION', `Unknown action: ${action}`);
    }

    const result = await executeGdscriptTrusted({
      godotPath: godot,
      projectPath,
      code: script,
      timeout: 30,
      loadAutoloads,
    });

    let r = parseGdscriptResult(result, [], uiErrorMapper);
    // Task 4: expect_tree 注入——measure 成功输出后,把逐节点 diff/重叠/越界问题清单
    // 并回 data.layout_verify(Pascal verify_scene 模式,数字驱动收敛)。
    if (action === 'ui_measure_layout' && (args.expect_tree as UiNodeSpec | undefined)) {
      const expectTree = args.expect_tree as UiNodeSpec;
      try {
        const parsed = JSON.parse((r.content?.[0] as { text?: string } | undefined)?.text ?? '{}') as {
          success?: boolean;
          data?: { measure?: { nodes?: MeasuredNode[]; viewport?: { w: number; h: number } } };
          warnings?: string[];
        };
        // 仅成功结果注入:错误/异常输出保持原样,diff 缺失由 AI 视为未验证
        if (parsed.success === true) {
          const measure = parsed.data?.measure;
          const measured = measure?.nodes ?? [];
          const targets = flattenTargets(expectTree);
          // PR-2:expect_tree 同构复用 style_verify(spec §4.1 挂两处之二)
          const styleReadings = measured.flatMap(n => (n.styles ?? []).map(s => ({ ...s, path: n.path })));
          const wrapped = {
            targets,
            diff: diffLayout(measured, targets, 2),
            overlaps: detectOverlaps(measured),
            out_of_bounds: detectOutOfBounds(measured),
            // C1: 根级 rect 的参照系(measure 输出的 root Window 尺寸),供消费方核对
            viewport: measure?.viewport,
          };
          const merged = { ...parsed, data: { ...parsed.data, layout_verify: wrapped,
            style_verify: diffStyles(styleReadings, flattenStyleTargets(expectTree)) } };
          r = { ...r, content: [{ type: 'text', text: JSON.stringify(merged) }] };
        }
      } catch {
        // measure 输出异常时保持原样返回,diff 缺失由 AI 视为未验证
      }
    }
    // persist=true 的 ui_build_layout 已原子写落盘,不再 append "headless 退出即丢" 提示;其余照旧。
    if (UI_PERSIST_ACTIONS.has(action) && !(action === 'ui_build_layout' && args.persist === true)) {
      return appendRuntimePersistWarning(r, action);
    }
    return r;
  } catch (err) {
    const msg = getErrorMessage(err);
    if (msg.includes('NodePath')) return opsErrorResult('INVALID_PATH', msg);
    return opsErrorResult(ERROR_CODES.SCRIPT_EXEC_FAILED, msg);
  }
}

// ─── ui_import_prototype 内部链(spec §2.3)──────────────────────────────────

/** GDScript error 输出 → 错误码映射(handleTool 公共段与 ui_import_prototype 共用)。 */
const uiErrorMapper = (msg: string) => {
  if (msg.includes('not found')) return ERROR_CODES.NODE_NOT_FOUND;
  if (msg.includes('not a Control')) return ERROR_CODES.INVALID_PARAMS;
  if (msg.includes('no theme')) return ERROR_CODES.THEME_NOT_FOUND;
  if (msg.includes('not a Theme')) return ERROR_CODES.THEME_NOT_FOUND;
  return ERROR_CODES.SCRIPT_EXEC_FAILED;
};

/** geometry/geometry_path 二选一解析(ui_import_prototype 与 ui_pixel_verify 共用):
 * 都给 → geometry 优先 + warning;都不给 → INVALID_PARAMS;geometry_path 经
 * normalizeUserProjectPath + resolveWithinRoot 白名单(越界 INVALID_PARAMS)。 */
function resolveGeometryInput(
  args: Record<string, unknown>,
  projectPath: string,
): { ok: true; rawGeometry: unknown; preWarnings: string[] } | { ok: false; result: ToolResult } {
  const geometryPathRaw = args.geometry_path as string | undefined;
  if (args.geometry !== undefined && args.geometry !== null) {
    const preWarnings: string[] = [];
    if (geometryPathRaw !== undefined) {
      preWarnings.push('both geometry and geometry_path given: geometry wins, geometry_path is ignored');
    }
    return { ok: true, rawGeometry: args.geometry, preWarnings };
  }
  if (geometryPathRaw !== undefined) {
    let absGeometryPath: string;
    try {
      absGeometryPath = resolveWithinRoot(projectPath, normalizeUserProjectPath(geometryPathRaw));
    } catch (err) {
      return { ok: false, result: opsErrorResult(ERROR_CODES.INVALID_PARAMS, `Invalid geometry_path: ${getErrorMessage(err)}`) };
    }
    try {
      return { ok: true, rawGeometry: JSON.parse(readFileSync(absGeometryPath, 'utf-8')), preWarnings: [] };
    } catch (err) {
      return { ok: false, result: opsErrorResult(ERROR_CODES.INVALID_PARAMS, `Failed to read geometry_path or parse its JSON: ${getErrorMessage(err)}`) };
    }
  }
  return { ok: false, result: opsErrorResult(ERROR_CODES.INVALID_PARAMS, 'One of geometry or geometry_path is required') };
}

/**
 * ui_import_prototype 一次调用内部链:zod 校验 → translateGeometry 纯函数翻译 →
 * build(**固定 persist=true**)+persist→reload(CACHE_MODE_IGNORE)→measure **单 spawn 合成**(PR-4,spec §6;原两次 spawn 首版实测 ~6s)。B-1 契约保持:measure(reload)读磁盘场景,不持久化则 verify 全部 actual:null;因此也不入 UI_PERSIST_ACTIONS,无"退出即丢"可提示)→ diffLayout(目标=翻译树)→ 组装 {tree, build_warnings, measure, verify_coverage, layout_verify}。
 */
async function handleUiImportPrototype(
  args: Record<string, unknown>,
  projectPath: string,
  godot: string,
  loadAutoloads: boolean,
): Promise<ToolResult> {
  const scenePath = resolveWithinRoot(projectPath, normalizeUserProjectPath(args.scene_path as string));
  const parentPath = normalizeNodePath((args.parent_path as string) || 'root');

  // geometry / geometry_path 二选一(v2 N-6 白名单前置拦截),提取为 resolveGeometryInput
  // 与 ui_pixel_verify 共用——行为不变,prototype-import 单测保护。
  const resolved = resolveGeometryInput(args, projectPath);
  if (!resolved.ok) return resolved.result;
  const preWarnings = resolved.preWarnings;
  const rawGeometry = resolved.rawGeometry;

  let geo: PrototypeGeometry;
  let translated: TranslateResult;
  try {
    geo = parseGeometry(rawGeometry);
    translated = translateGeometry(geo);
  } catch (err) {
    // parseGeometry/translateGeometry 的非法输入(交叉重叠/等 rect/超限/重名…)均以
    // INVALID_PARAMS 前缀抛出(v2 N-1 拒绝而非静默),原样透传给 AI 修原型侧。
    return opsErrorResult(ERROR_CODES.INVALID_PARAMS, getErrorMessage(err));
  }

  // tolerance:有限非负数,默认 2(diffLayout 同款语义)
  const tolRaw = args.tolerance;
  const tolerance = typeof tolRaw === 'number' && Number.isFinite(tolRaw) && tolRaw >= 0 ? tolRaw : 2;

  // viewport:显式优先,默认 geometry.viewport(合成根 rect 的求解基准)
  let viewport = geo.viewport;
  if (args.viewport !== undefined) {
    const vp = args.viewport as { w?: unknown; h?: unknown };
    const w = typeof vp.w === 'number' ? vp.w : NaN;
    const h = typeof vp.h === 'number' ? vp.h : NaN;
    if (!(w > 0) || !(h > 0)) {
      return opsErrorResult(ERROR_CODES.INVALID_PARAMS, 'viewport must be an object {w, h} with positive numbers');
    }
    viewport = { w, h };
  }

  // ① 单 spawn 合成(PR-4,spec §6):build→persist→reload(CACHE_MODE_IGNORE)→measure
  // 一次 Godot 进程完成。固定 persist=true 保持 B-1 契约——measure(reload)读的是磁盘
  // 场景,不持久化则 verify 全部 actual:null。reload 阶段错误信息由模板内嵌
  // 「build 已持久化,可重跑 ui_measure_layout」恢复语义(persist 先于 measure),TS 侧
  // 不再二次拼接(原两阶段流程的 hint-append 逻辑随第二次 spawn 一起删除)。
  const styleTargets = flattenStyleTargets(translated.tree);
  const singleScript = genUiImportSingleScript(scenePath, parentPath, translated.tree, viewport, styleExpectList(styleTargets));
  const singleResult = await executeGdscriptTrusted({
    godotPath: godot, projectPath, code: singleScript, timeout: 30, loadAutoloads,
  });
  const parsed = parseGdscriptResult(singleResult, [], uiErrorMapper);
  if (parsed.isError) return parsed;

  let out: {
    data?: {
      persist?: { saved?: boolean };
      warnings?: unknown[];
      measure?: { nodes?: MeasuredNode[]; viewport?: { w: number; h: number }; stable_after_frames?: number; stalled?: boolean };
    };
    warnings?: string[];
  };
  try {
    out = JSON.parse((parsed.content?.[0] as { text?: string } | undefined)?.text ?? '{}');
  } catch {
    return parsed;
  }

  // build_warnings:输入消歧 + 翻译 warnings 透传 + 容差模糊带使用提示 + 生成器 warnings。
  // I-2(声明式修复):parent_path 非 root 时根级 diff 参照系限制提示(diff 算法不改——
  // measure 根级 target 的期望 rect 按视口原点求解,挂载父非原点对齐时恒误报)。
  // 审查遗留②:归一化判定(去尾斜杠)——'root/'/'/root/' 与 '/root' 语义等价,字符串全等
  // 会假阳性多弹 warning;场景根名(如 '/Main')仍保守提示(无害——原点对齐理论差异仍在)。
  const parentIsRoot = parentPath.replace(/\/+$/, '') === '/root';
  const buildWarnings = [
    ...preWarnings,
    ...translated.warnings,
    'Usage hint: avoid adjacent separate nodes ≤2px wide (tolerance blur band) — within the verify tolerance, sibling relations and offsets can\'t be told apart',
    ...(!parentIsRoot ? [
      `parent_path="${parentPath}" is not root: layout_verify solves root-level expected rects against the viewport origin, so when the mount parent is not aligned to the origin (global_position≈0,0) root-level diffs are always false alarms — make sure the mount parent is origin-aligned, or ignore root-level diff results`,
    ] : []),
  ];
  for (const w of out.data?.warnings ?? []) {
    buildWarnings.push(typeof w === 'object' && w !== null && 'message' in w ? String((w as { message: unknown }).message) : String(w));
  }
  if (out.data?.persist?.saved !== true) {
    buildWarnings.push('persist failed to write (saved=false): measure read the old scene from disk, layout_verify is unreliable; investigate and retry');
  }

  // ③ 组装返回(单 spawn:measure 与 build 输出同批;输出异常保持原样,diff 缺失由 AI 视为未验证)。
  try {
    const measure = out.data?.measure;
    const measured = measure?.nodes ?? [];
    const targets = flattenTargets(translated.tree);
    const layoutVerify = {
      targets,
      diff: diffLayout(measured, targets, tolerance),
      overlaps: detectOverlaps(measured),
      out_of_bounds: detectOutOfBounds(measured),
      // 根级 rect 的参照系(measure 输出的 root Window 尺寸),供消费方核对
      viewport: measure?.viewport,
    };
    // PR-2:style_verify(逐槽位样式 diff)+ flow_verify(flow 直接子层数字清单)
    const styleReadings = measured.flatMap(n => (n.styles ?? []).map(s => ({ ...s, path: n.path })));
    const styleVerify = diffStyles(styleReadings, styleTargets);
    const flowVerify = diffFlow(measured, translated.flow_expect, tolerance);
    const verifyCoverage = {
      ...translated.coverage,
      _note: 'targets = nodes covered by layout_verify geometry (including the synthetic root _PrototypeRoot; without flows = input nodes + 1); direct flow children drop their rect and are not covered by layout_verify — flow_verify covers them numerically (expected = input viewport rect); grandchildren are covered approximately by layout_verify (expected relative to the input parent origin, naturally offset after container layout)',
    };
    return textResult(JSON.stringify(opsSuccess({
      tree: translated.tree,
      build_warnings: buildWarnings,
      measure: {
        stable_after_frames: measure?.stable_after_frames,
        stalled: measure?.stalled,
        viewport: measure?.viewport,
      },
      verify_coverage: verifyCoverage,
      layout_verify: layoutVerify,
      style_verify: styleVerify,
      flow_verify: flowVerify,
      persist: out.data?.persist,
    }, out.warnings ?? [])));
  } catch {
    return parsed;
  }
}

/**
 * ui_pixel_verify(spec §5 终验):入参同 import(geometry/geometry_path 二选一 + 必填
 * scene_path 指向 ui_import_prototype persist 产物)→ parseGeometry → runPixelVerify
 * (capture → decode → 采样 → 判定)。不做 translate/translate 产物比对——采样基准是
 * 输入视口 rect(终验前提:layout_verify/style_verify 已全绿,期望≈实测)。
 */
async function handleUiPixelVerify(
  args: Record<string, unknown>,
  projectPath: string,
  godot: string,
): Promise<ToolResult> {
  const sceneRaw = args.scene_path as string | undefined;
  if (!sceneRaw || !String(sceneRaw).trim()) {
    return opsErrorResult(ERROR_CODES.INVALID_PARAMS, 'ui_pixel_verify needs scene_path pointing at an already built scene (the output of ui_import_prototype persist)');
  }
  let scenePath: string;
  try {
    scenePath = resolveWithinRoot(projectPath, normalizeUserProjectPath(String(sceneRaw)));
  } catch (err) {
    return opsErrorResult(ERROR_CODES.INVALID_PARAMS, `Invalid scene_path: ${getErrorMessage(err)}`);
  }
  const resolved = resolveGeometryInput(args, projectPath);
  if (!resolved.ok) return resolved.result;
  let geo: PrototypeGeometry;
  try {
    geo = parseGeometry(resolved.rawGeometry);
  } catch (err) {
    return opsErrorResult(ERROR_CODES.INVALID_PARAMS, getErrorMessage(err));
  }
  const r = await runPixelVerify({ godotPath: godot, projectPath, scenePath, geo });
  if (!r.ok) {
    return opsErrorResult(ERROR_CODES.SCRIPT_EXEC_FAILED, r.error + (r.hint ? `\nHint: ${r.hint}` : ''));
  }
  return textResult(JSON.stringify(opsSuccess({ pixel_verify: r.summary })));
}

// ─── Tool Meta ──────────────────────────────────────────────────────────────

export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean; actionRisks?: Record<string, RiskLevel> }> = {
  ui: {
    readonly: false,
    long_running: false,
    actionRisks: {
      ui_get_layout: 'read', ui_create_control: 'write', ui_set_layout: 'write',
      ui_anchor_preset: 'write', ui_set_theme: 'write', ui_container_add: 'write',
      ui_draw_recipe: 'write', ui_build_layout: 'write', ui_measure_layout: 'read',
      ui_import_prototype: 'write', ui_pixel_verify: 'write',
      theme_create: 'write', theme_set_property: 'write',
    } satisfies Record<typeof ACTIONS[number], RiskLevel>,
  },
};
