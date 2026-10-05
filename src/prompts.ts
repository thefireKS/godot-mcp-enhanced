import type { PromptMessage } from "@modelcontextprotocol/server";

// src/prompts.ts — MCP Prompt templates for guided workflows
import { scanFiles } from './core/file-scanner.js';
import { relative } from 'node:path';

export type CompletionSource =
  | { type: 'enum'; values: string[] }
  | { type: 'scenes' };

export interface PromptDef {
  name: string;
  description: string;
  arguments?: Array<{
    name: string;
    description: string;
    required?: boolean;
    completion?: CompletionSource;
  }>;
}

/**
 * Phase 1 static prompt templates.
 *
 * These templates provide structured guidance text for common workflows.
 * They do not dynamically analyze the project — the parameters are used
 * only for string interpolation into the template text.
 *
 * Future phases will add dynamic context (scene analysis, project scan, etc.)
 * by replacing the static build() functions with tool-calling logic.
 */
const PROMPTS: Record<string, { def: PromptDef; build: (args: Record<string, string>) => PromptMessage[] }> = {
  create_platformer: {
    def: {
      name: 'create_platformer',
      description: '2D platformer game scaffold guidance',
      arguments: [
        { name: 'project_name', description: 'Project name', required: false },
        { name: 'resolution', description: 'Target resolution (e.g. 1920x1080)', required: false, completion: { type: 'enum', values: ['1280x720', '1920x1080', '2560x1440'] } },
      ],
    },
    build: (args) => [{
      role: 'user' as const,
      content: { type: 'text' as const, text: `# 2D Platformer Scaffold Guide — ${args.project_name || 'platformer'}\n\n## Resolution: ${args.resolution || '1280x720'}\n\n## Steps\n1. **Project Setup**: Create project with viewport ${args.resolution || '1280x720'}\n2. **Player Scene**: CharacterBody2D with sprite, collision shape, camera\n3. **Player Script**: move_and_slide with gravity, jump, horizontal movement\n4. **Level TileMap**: TileMapLayer with ground tiles and collision\n5. **Collectibles**: Area2D-based coins with animation\n6. **UI**: VBoxContainer with score label and lives counter\n7. **Game Loop**: game_over and restart logic\n\n## Key Tools\n- create_scene, write_script, tilemap_fill_rect, add_node, save_scene, run_and_verify` },
    }],
  },
  setup_player_controller: {
    def: {
      name: 'setup_player_controller',
      description: 'Player controller setup guidance',
      arguments: [
        { name: 'dimension', description: '2d or 3d', required: false, completion: { type: 'enum', values: ['2d', '3d'] } },
        { name: 'movement_type', description: 'topdown, platformer, or fps', required: false, completion: { type: 'enum', values: ['topdown', 'platformer', 'fps'] } },
      ],
    },
    build: (args) => [{
      role: 'user' as const,
      content: { type: 'text' as const, text: `# Player Controller Guide — ${(args.dimension || '2d').toUpperCase()} ${args.movement_type || 'platformer'}\n\n## Root: ${args.dimension === '3d' ? 'CharacterBody3D' : 'CharacterBody2D'}\n\n## Steps\n1. Define move_left, move_right, jump input actions\n2. Write move_and_slide() controller script\n3. Attach ${args.dimension === '3d' ? 'Camera3D' : 'Camera2D'}\n4. Wire sprite animations for idle/walk/jump` },
    }],
  },
  optimize_scene: {
    def: {
      name: 'optimize_scene',
      description: 'Scene optimization analysis guidance',
      arguments: [
        { name: 'scene_path', description: 'Scene file path', required: false, completion: { type: 'scenes' } },
      ],
    },
    build: (args) => [{
      role: 'user' as const,
      content: { type: 'text' as const, text: `# Scene Optimization Guide — ${args.scene_path || 'res://scenes/main.tscn'}\n\n## Analysis Steps\n1. read_scene to understand structure\n2. Count nodes (>500 may need splitting)\n3. Verify sprites use atlas textures\n4. Prefer simple collision shapes\n5. Check for script duplication\n\n## Verification\nRun verify_delivery(scope="scene") to check scene health.` },
    }],
  },
  debug_performance: {
    def: {
      name: 'debug_performance',
      description: 'Performance debugging walkthrough',
      arguments: [],
    },
    build: () => [{
      role: 'user' as const,
      content: { type: 'text' as const, text: `# Performance Debugging Guide\n\n## Step 1: Baseline\n- profiler snapshot for FPS, frame time, draw calls\n\n## Step 2: Identify Bottlenecks\n- Low FPS: check _process functions\n- High memory: look for resource leaks\n- Draw calls >1000: reduce visible nodes\n\n## Step 3: Common Fixes\n- Move heavy logic to timers\n- Disconnect unused signals\n- Use object pooling\n\n## Step 4: Measure Impact\nRun profiler_get_data after each fix.` },
    }],
  },
  scene_editing_strategy: {
    def: {
      name: 'scene_editing_strategy',
      description: 'Scene editing strategy: capability discovery, decision tree, and closed-loop verification',
      arguments: [
        {
          name: 'operation_type',
          description: 'Primary operation type (add_node, edit_node, remove_node, create_scene, read_scene)',
          required: false,
          completion: {
            type: 'enum',
            values: ['add_node', 'edit_node', 'remove_node', 'create_scene', 'read_scene'],
          },
        },
      ],
    },
    build: (args) => [{
      role: 'user' as const,
      content: { type: 'text' as const, text: `# Scene editing SOP — ${args.operation_type || 'general'}

> This guide turns the scattered "verify with screenshots" discipline into an SOP the AI follows automatically. Three layers: capability discovery → decision tree → closed-loop verification.

## Layer 0: capability discovery (learn the current environment)

First use the godot_get_context tool to detect the connection mode (connectionMode):
- **editor** (editor running): prefer live scene tree sync, undo support, add_node/edit_node take effect immediately
- **headless** (standalone Godot process): mostly file read/write, batch creation / one-shot verification
- **bridge** (game running): E2E tests, runtime debugging, input simulation

The best tool for the same operation can differ between modes; don't assume a default.

## Layer 1: operation decision tree (by operation_type)

Current operation: **${args.operation_type || 'general (unspecified, judge by the scene)'}**

- **add_node**: read_scene first to confirm the parent exists → scene's add_node action (with parent_node_path) → immediate in editor mode / headless needs save_scene to write it
- **edit_node**: inspect_node first for the current properties → edit_node with a properties object → undoable in editor mode
- **remove_node**: inspect_node first to confirm the target + impact on children → remove_node → verify scene tree integrity
- **create_scene**: create_scene with root_node_type → add_node for children → save_scene to write it
- **read_scene**: read_scene for the structure → summary_only=true for the skeleton first, a full read when details are needed

Fallback: if the editor is unavailable fall back to headless; if headless fails (e.g. needs EditorUndoRedoManager) consider the editor.

## Layer 2: closed-loop verification (screenshot + assertion at every step)

After each change, don't go straight to the next step:

1. **Screenshot**: the screenshot tool captures the current viewport (the editor in editor mode / the game in bridge mode)
2. **Assert**: use runtime_assert or verify_delivery to check the change was written / took effect
   - verify_delivery(scope="scene") checks scene tree integrity + script health
   - runtime_assert for custom assertions (e.g. \`node_count > 0\`, \`property == expected\`)
3. **On failure**: assertion fails → analyze_error → fix → verify again, never skip

## Key traps (see engine-quirks)

- GPU particles don't render headless; 2D/3D screenshots may be blank (not a bug)
- set_instance_property on the root node returns NODE_NOT_INSTANCE (use edit_node instead)
- TileMapLayer is a 4.3+ type; older projects may use TileMap, check the node type first
- after save_scene the .tscn may not reflect changes right away because of EditorPlugin caching; reading the file in headless mode is more reliable

## Verification checklist

When the change is done, verify finally:
- [ ] read_scene confirms the target node exists with correct properties
- [ ] validate_scripts reports 0 errors (if scripts changed)
- [ ] verify_delivery(scope="scene") passes
- [ ] screenshot visual check (not blank, as expected)` },
    }],
  },
};

export function listPrompts(): PromptDef[] {
  return Object.values(PROMPTS).map(p => p.def);
}

/** 列出所有已注册 prompt 的定义（name + description + arguments）。供 godot_get_context 的 workflows 字段使用。 */
export function listPromptDefs(): PromptDef[] {
  return Object.values(PROMPTS).map(p => p.def);
}

export async function getPrompt(name: string, args: Record<string, string>): Promise<{ messages: PromptMessage[] }> {
  const prompt = PROMPTS[name];
  if (!prompt) throw new Error(`Unknown prompt: ${name}`);
  return { messages: prompt.build(args) };
}

/** 按 name 查单个 PromptDef（CompleteRequest handler 用，访问 completion 配置的唯一干净路径） */
export function getPromptDef(name: string): PromptDef | undefined {
  return PROMPTS[name]?.def;
}

/**
 * 解析补全源 → values（按 prefix 过滤）。
 * enum: 固定枚举；scenes: scanFiles 列 .tscn 归一化 res://。失败/无 projectPath → 空。
 */
export async function resolveCompletion(
  source: CompletionSource, prefix: string, projectPath?: string,
): Promise<string[]> {
  if (source.type === 'enum') {
    return source.values.filter(v => v.startsWith(prefix));
  }
  if (!projectPath) return [];
  try {
    const files = scanFiles(projectPath, ['.tscn']);
    return files
      .map(f => 'res://' + relative(projectPath, f).replace(/\\/g, '/'))
      .filter(r => r.startsWith(prefix));
  } catch {
    return [];
  }
}

/** CompleteRequest 逻辑（提取自 GodotServer handler，可单测）。SDK :5511 total=all.length；:5507 MAX=100。 */
export async function handleCompletion(
  ref: { type: string; name: string },
  argument: { name: string; value: string },
  projectPath?: string,
): Promise<{ completion: { values: string[]; total: number; hasMore: boolean } }> {
  const EMPTY = { completion: { values: [] as string[], total: 0, hasMore: false } };
  if (ref.type !== 'ref/prompt') return EMPTY;
  const argDef = getPromptDef(ref.name)?.arguments?.find(a => a.name === argument.name);
  if (!argDef?.completion) return EMPTY;
  const all = await resolveCompletion(argDef.completion, argument.value, projectPath);
  const MAX = 100;
  const truncated = all.slice(0, MAX);
  return { completion: { values: truncated, total: all.length, hasMore: all.length > MAX } };
}
