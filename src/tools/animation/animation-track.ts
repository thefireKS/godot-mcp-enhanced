import type { Tool } from "@modelcontextprotocol/server";
import type { ToolContext, ToolResult } from '../../types.js';
import type { RiskLevel } from '../../core/tool-registry.js';
import { requireProjectPath } from '../../helpers.js';
import { executeGdscript } from '../../gdscript-executor.js';
import { normalizeNodePath, gdEscape, escapeForGdLiteral } from '../shared.js';
import { SCENE_TREE_HEADER, NON_PERSIST, opsErrorResult, parseGdscriptResult } from '../shared.js';
import { TRACK_TYPES, ensureNumber, valueToGd, animErrorMapper } from './animation-shared.js';

// ─── Constants ─────────────────────────────────────────────────────────────

const TOOL_NAMES = ['animation_track'] as const;

export { TOOL_NAMES };

// ─── Tool Definitions ──────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'animation_track',
      description:
        'Animation track and keyframe operations. Tracks: add_track, remove_track. Keyframes: add_keyframe, remove_keyframe, update_keyframe. Curves: set_curve. ' +
        NON_PERSIST,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot project directory (optional; defaults to the GODOT_PROJECT_PATH env var or the current directory)' },
          action: {
            type: 'string',
            enum: ['add_track', 'remove_track', 'add_keyframe', 'remove_keyframe', 'update_keyframe', 'set_curve'],
            description: 'Operation',
          },
          node_path: { type: 'string', description: 'AnimationPlayer node path' },
          animation_name: { type: 'string', description: 'Animation name' },
          track_type: {
            type: 'string',
            enum: [...TRACK_TYPES],
            description: 'Track type (required for add_track)',
          },
          track_path: { type: 'string', description: 'Track path, e.g. "Sprite2D:frame" (optional for add_track)' },
          track_index: { type: 'number', description: 'Track index' },
          insert_at: { type: 'number', description: 'Track insert position, -1 = end (optional for add_track)' },
          keyframe_index: { type: 'number', description: 'Keyframe index (required for remove_keyframe/update_keyframe/set_curve)' },
          time: { type: 'number', description: 'Keyframe time in seconds (required for add_keyframe)' },
          value: { description: 'Keyframe value (add_keyframe/update_keyframe)' },
          transition: { type: 'number', description: 'Transition curve, 1.0 = linear' },
          in_handle: {
            type: 'object',
            properties: { x: { type: 'number' }, y: { type: 'number' } },
            description: 'In-handle coordinates (set_curve)',
          },
          out_handle: {
            type: 'object',
            properties: { x: { type: 'number' }, y: { type: 'number' } },
            description: 'Out-handle coordinates (set_curve)',
          },
          load_autoloads: { type: 'boolean', description: 'Load the Autoload context (default true)' },
        },
        required: ['action'],
      },
    },
  ];
}



// ─── GDScript Generators ───────────────────────────────────────────────────

function genAnimationTrackAdd(nodePath: string, animName: string, trackType: string, trackPath: string | undefined, insertAt: number | undefined): string {
  const typeMap: Record<string, number> = {
    value: 0, position_3d: 1, rotation_3d: 2, scale_3d: 3,
    blend_shape: 4, method: 5, bezier: 6, audio: 7, animation: 8,
  };
  const typeVal = typeMap[trackType] ?? 0;
  const insertLine = insertAt !== undefined && insertAt >= 0
    ? `_anim.add_track(${typeVal}, ${insertAt})`
    : `_anim.add_track(${typeVal})`;
  const pathLine = trackPath
    ? `\n\t_anim.track_set_path(_idx, NodePath("${escapeForGdLiteral(trackPath)}"))`
    : '';
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar _ap: AnimationPlayer = _mcp_get_node("${escapeForGdLiteral(nodePath)}")
\tif _ap == null or not (_ap is AnimationPlayer):
\t\t_mcp_output("error", "AnimationPlayer not found")
\t\t_mcp_done()
\t\treturn
\tif not _ap.has_animation("${gdEscape(animName)}"):
\t\t_mcp_output("error", "Animation not found")
\t\t_mcp_done()
\t\treturn
\tvar _anim: Animation = _ap.get_animation("${gdEscape(animName)}")
\t${insertLine}
\tvar _idx: int = _anim.get_track_count() - 1${pathLine}
\t_mcp_output("result", {"track_index": _idx, "track_type": ${typeVal}})
\t_mcp_done()
`;
}

function genAnimationTrackRemove(nodePath: string, animName: string, trackIdx: number): string {
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar _ap: AnimationPlayer = _mcp_get_node("${escapeForGdLiteral(nodePath)}")
\tif _ap == null or not (_ap is AnimationPlayer):
\t\t_mcp_output("error", "AnimationPlayer not found")
\t\t_mcp_done()
\t\treturn
\tif not _ap.has_animation("${gdEscape(animName)}"):
\t\t_mcp_output("error", "Animation not found")
\t\t_mcp_done()
\t\treturn
\tvar _anim: Animation = _ap.get_animation("${gdEscape(animName)}")
\tif ${trackIdx} < 0 or ${trackIdx} >= _anim.get_track_count():
\t\t_mcp_output("error", "Track index out of range")
\t\t_mcp_done()
\t\treturn
\t_anim.remove_track(${trackIdx})
\t_mcp_output("result", {"removed_track": ${trackIdx}})
\t_mcp_done()
`;
}

function genAnimationKeyframeAdd(nodePath: string, animName: string, trackIdx: number, time: number, value: unknown, transition: number | undefined): string {
  const transStr = transition ?? 1.0;
  const valueStr = value !== undefined ? valueToGd(value) : 'null';
  const rotValueStr = value !== undefined && Array.isArray(value) && value.length === 3
    ? `Quaternion.from_euler(Vector3(${Number(value[0])}, ${Number(value[1])}, ${Number(value[2])}))`
    : valueStr;
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar _ap: AnimationPlayer = _mcp_get_node("${escapeForGdLiteral(nodePath)}")
\tif _ap == null or not (_ap is AnimationPlayer):
\t\t_mcp_output("error", "AnimationPlayer not found")
\t\t_mcp_done()
\t\treturn
\tif not _ap.has_animation("${gdEscape(animName)}"):
\t\t_mcp_output("error", "Animation not found")
\t\t_mcp_done()
\t\treturn
\tvar _anim: Animation = _ap.get_animation("${gdEscape(animName)}")
\tif ${trackIdx} < 0 or ${trackIdx} >= _anim.get_track_count():
\t\t_mcp_output("error", "Track index out of range")
\t\t_mcp_done()
\t\treturn
\tvar _kf_idx: int = -1
\tif _anim.track_get_type(${trackIdx}) == Animation.TYPE_VALUE or _anim.track_get_type(${trackIdx}) == Animation.TYPE_BEZIER:
\t\t_kf_idx = _anim.track_insert_key(${trackIdx}, ${time}, ${valueStr}, ${transStr})
\telif _anim.track_get_type(${trackIdx}) == Animation.TYPE_POSITION_3D:
\t\t_kf_idx = _anim.position_track_insert_key(${trackIdx}, ${time}, ${valueStr})
\telif _anim.track_get_type(${trackIdx}) == Animation.TYPE_ROTATION_3D:
\t\t_kf_idx = _anim.rotation_track_insert_key(${trackIdx}, ${time}, ${rotValueStr})
\telif _anim.track_get_type(${trackIdx}) == Animation.TYPE_SCALE_3D:
\t\t_kf_idx = _anim.scale_track_insert_key(${trackIdx}, ${time}, ${valueStr})
\t_mcp_output("result", {"keyframe_index": _kf_idx, "time": ${time}, "track_index": ${trackIdx}})
\t_mcp_done()
`;
}

function genAnimationKeyframeRemove(nodePath: string, animName: string, trackIdx: number, kfIdx: number): string {
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar _ap: AnimationPlayer = _mcp_get_node("${escapeForGdLiteral(nodePath)}")
\tif _ap == null or not (_ap is AnimationPlayer):
\t\t_mcp_output("error", "AnimationPlayer not found")
\t\t_mcp_done()
\t\treturn
\tif not _ap.has_animation("${gdEscape(animName)}"):
\t\t_mcp_output("error", "Animation not found")
\t\t_mcp_done()
\t\treturn
\tvar _anim: Animation = _ap.get_animation("${gdEscape(animName)}")
\tif ${trackIdx} < 0 or ${trackIdx} >= _anim.get_track_count():
\t\t_mcp_output("error", "Track index out of range")
\t\t_mcp_done()
\t\treturn
\tif ${kfIdx} < 0 or ${kfIdx} >= _anim.track_get_key_count(${trackIdx}):
\t\t_mcp_output("error", "Keyframe index out of range")
\t\t_mcp_done()
\t\treturn
\t_anim.track_remove_key(${trackIdx}, ${kfIdx})
\t_mcp_output("result", {"removed_keyframe": ${kfIdx}, "track_index": ${trackIdx}})
\t_mcp_done()
`;
}

function genAnimationKeyframeUpdate(nodePath: string, animName: string, trackIdx: number, kfIdx: number, value: unknown, transition: number | undefined): string {
  const valueLine = value !== undefined
    ? `\t_anim.track_set_key_value(${trackIdx}, ${kfIdx}, ${valueToGd(value)})`
    : '';
  const transLine = transition !== undefined
    ? `\t_anim.track_set_key_transition(${trackIdx}, ${kfIdx}, ${transition})`
    : '';
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar _ap: AnimationPlayer = _mcp_get_node("${escapeForGdLiteral(nodePath)}")
\tif _ap == null or not (_ap is AnimationPlayer):
\t\t_mcp_output("error", "AnimationPlayer not found")
\t\t_mcp_done()
\t\treturn
\tif not _ap.has_animation("${gdEscape(animName)}"):
\t\t_mcp_output("error", "Animation not found")
\t\t_mcp_done()
\t\treturn
\tvar _anim: Animation = _ap.get_animation("${gdEscape(animName)}")
\tif ${trackIdx} < 0 or ${trackIdx} >= _anim.get_track_count():
\t\t_mcp_output("error", "Track index out of range")
\t\t_mcp_done()
\t\treturn
\tif ${kfIdx} < 0 or ${kfIdx} >= _anim.track_get_key_count(${trackIdx}):
\t\t_mcp_output("error", "Keyframe index out of range")
\t\t_mcp_done()
\t\treturn
${valueLine}
${transLine}
\t_mcp_output("result", {"updated_keyframe": ${kfIdx}, "track_index": ${trackIdx}})
\t_mcp_done()
`;
}

function genAnimationCurve(nodePath: string, animName: string, trackIdx: number, kfIdx: number, inHandle: { x: number; y: number } | undefined, outHandle: { x: number; y: number } | undefined): string {
  const inLine = inHandle
    ? `\t_anim.track_set_key_in_handle(${trackIdx}, ${kfIdx}, Vector2(${inHandle.x}, ${inHandle.y}))`
    : '';
  const outLine = outHandle
    ? `\t_anim.track_set_key_out_handle(${trackIdx}, ${kfIdx}, Vector2(${outHandle.x}, ${outHandle.y}))`
    : '';
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar _ap: AnimationPlayer = _mcp_get_node("${escapeForGdLiteral(nodePath)}")
\tif _ap == null or not (_ap is AnimationPlayer):
\t\t_mcp_output("error", "AnimationPlayer not found")
\t\t_mcp_done()
\t\treturn
\tif not _ap.has_animation("${gdEscape(animName)}"):
\t\t_mcp_output("error", "Animation not found")
\t\t_mcp_done()
\t\treturn
\tvar _anim: Animation = _ap.get_animation("${gdEscape(animName)}")
\tif ${trackIdx} < 0 or ${trackIdx} >= _anim.get_track_count():
\t\t_mcp_output("error", "Track index out of range")
\t\t_mcp_done()
\t\treturn
\tif ${kfIdx} < 0 or ${kfIdx} >= _anim.track_get_key_count(${trackIdx}):
\t\t_mcp_output("error", "Keyframe index out of range")
\t\t_mcp_done()
\t\treturn
${inLine}
${outLine}
\t_mcp_output("result", {"track_index": ${trackIdx}, "keyframe_index": ${kfIdx}, "in_handle": ${inHandle ? `Vector2(${inHandle.x}, ${inHandle.y})` : 'null'}, "out_handle": ${outHandle ? `Vector2(${outHandle.x}, ${outHandle.y})` : 'null'}})
\t_mcp_done()
`;
}

// Export generators for testing
export {
  genAnimationTrackAdd,
  genAnimationTrackRemove,
  genAnimationKeyframeAdd,
  genAnimationKeyframeRemove,
  genAnimationKeyframeUpdate,
  genAnimationCurve,
};

// ─── Tool Handler ──────────────────────────────────────────────────────────

export async function handleTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult | null> {
  if (!(TOOL_NAMES as readonly string[]).includes(name)) return null;

  try {
    const projectPath = requireProjectPath(args);
    const loadAutoloads = (args.load_autoloads as boolean) !== false;
    const godotPath = await ctx.findGodot();

    let code: string;
    const action = args.action as string;
    if (!action) return opsErrorResult('INVALID_PARAMS', 'action is required');

    const nodePath = normalizeNodePath((args.node_path as string) ?? '');
    const animName = (args.animation_name as string) ?? '';

    switch (action) {
      case 'add_track': {
        if (!nodePath || !animName) return opsErrorResult('INVALID_PARAMS', 'node_path and animation_name required');
        if (!args.track_type) return opsErrorResult('INVALID_PARAMS', 'track_type required for add_track');
        code = genAnimationTrackAdd(nodePath, animName, args.track_type as string, args.track_path as string | undefined,
          args.insert_at !== undefined ? ensureNumber(args.insert_at, 'insert_at') : undefined);
        break;
      }
      case 'remove_track': {
        if (!nodePath || !animName) return opsErrorResult('INVALID_PARAMS', 'node_path and animation_name required');
        if (args.track_index === undefined) return opsErrorResult('INVALID_PARAMS', 'track_index required for remove_track');
        code = genAnimationTrackRemove(nodePath, animName, ensureNumber(args.track_index, 'track_index'));
        break;
      }
      case 'add_keyframe': {
        const trackIdx = args.track_index !== undefined ? ensureNumber(args.track_index, 'track_index') : -1;
        if (!nodePath || !animName || trackIdx < 0) return opsErrorResult('INVALID_PARAMS', 'node_path, animation_name, track_index required');
        if (args.time === undefined) return opsErrorResult('INVALID_PARAMS', 'time required for add_keyframe');
        code = genAnimationKeyframeAdd(nodePath, animName, trackIdx, ensureNumber(args.time, 'time'), args.value,
          args.transition !== undefined ? ensureNumber(args.transition, 'transition') : undefined);
        break;
      }
      case 'remove_keyframe': {
        const trackIdx = args.track_index !== undefined ? ensureNumber(args.track_index, 'track_index') : -1;
        if (!nodePath || !animName || trackIdx < 0) return opsErrorResult('INVALID_PARAMS', 'node_path, animation_name, track_index required');
        if (args.keyframe_index === undefined) return opsErrorResult('INVALID_PARAMS', 'keyframe_index required for remove_keyframe');
        code = genAnimationKeyframeRemove(nodePath, animName, trackIdx, ensureNumber(args.keyframe_index, 'keyframe_index'));
        break;
      }
      case 'update_keyframe': {
        const trackIdx = args.track_index !== undefined ? ensureNumber(args.track_index, 'track_index') : -1;
        if (!nodePath || !animName || trackIdx < 0) return opsErrorResult('INVALID_PARAMS', 'node_path, animation_name, track_index required');
        if (args.keyframe_index === undefined) return opsErrorResult('INVALID_PARAMS', 'keyframe_index required for update_keyframe');
        code = genAnimationKeyframeUpdate(nodePath, animName, trackIdx, ensureNumber(args.keyframe_index, 'keyframe_index'),
          args.value,
          args.transition !== undefined ? ensureNumber(args.transition, 'transition') : undefined);
        break;
      }
      case 'set_curve': {
        const trackIdx = args.track_index !== undefined ? ensureNumber(args.track_index, 'track_index') : -1;
        const kfIdx = args.keyframe_index !== undefined ? ensureNumber(args.keyframe_index, 'keyframe_index') : -1;
        if (!nodePath || !animName || trackIdx < 0 || kfIdx < 0) return opsErrorResult('INVALID_PARAMS', 'node_path, animation_name, track_index, keyframe_index required');

        const rawIn = args.in_handle as { x?: number; y?: number } | undefined;
        const rawOut = args.out_handle as { x?: number; y?: number } | undefined;
        const inHandle = rawIn && rawIn.x !== undefined && rawIn.y !== undefined
          ? { x: ensureNumber(rawIn.x, 'in_handle.x'), y: ensureNumber(rawIn.y, 'in_handle.y') }
          : undefined;
        const outHandle = rawOut && rawOut.x !== undefined && rawOut.y !== undefined
          ? { x: ensureNumber(rawOut.x, 'out_handle.x'), y: ensureNumber(rawOut.y, 'out_handle.y') }
          : undefined;

        code = genAnimationCurve(nodePath, animName, trackIdx, kfIdx, inHandle, outHandle);
        break;
      }
      default:
        return opsErrorResult('INVALID_ACTION', `Unknown action: ${action}`);
    }

    const result = await executeGdscript({
      godotPath,
      projectPath,
      code,
      timeout: 30,
      loadAutoloads,
    });

    return parseGdscriptResult(result, [], animErrorMapper);
  } catch (err) {
    return opsErrorResult('INVALID_PARAMS', err instanceof Error ? err.message : String(err));
  }
}

export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean; actionRisks: Record<string, RiskLevel> }> = {
  animation_track: {
    readonly: false,
    long_running: false,
    // P0-2 (批次 E): remove_track/remove_keyframe/update_keyframe 是破坏性操作（删轨道/关键帧/改值），
    // 对齐兄弟模块 animation-ops.ts:691（同名操作标 destructive）。原标 'read' 绕确认门（spec §4.1
    // 零行为改变决策）是 bug——破坏性操作应确认。add_track/add_keyframe/set_curve 仍 read（非破坏）。
    // risk-coverage GUARDED_KEYS 加 'animation_track' 允许非 read。
    actionRisks: {
      add_track: 'read',
      remove_track: 'destructive',
      add_keyframe: 'read',
      remove_keyframe: 'destructive',
      update_keyframe: 'destructive',
      set_curve: 'read',
    },
  },
};
