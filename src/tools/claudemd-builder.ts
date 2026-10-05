// src/tools/claudemd-builder.ts
import { existsSync } from 'fs';
import { join } from 'path';
import type { GodotConfig } from '../helpers.js';
import { getLogger } from '../core/logger.js';
import { mergeSections as mergeSectionsGeneric } from './shared/section-merge.js';

// MCP 管理的章节标识（含旧格式，用于识别并替换）
export const SECTION_IDS = new Set([
  '## Engine version', '## Renderer', '## Key project paths', '## Main scene',
  '## Autoload', '## Input Map', '## Physics settings', '## Layer names',
  '## MCP rule mapping', '## Godot MCP Rules', '## GDScript typing conventions',
  '## Code best practices',
]);

// MCP 章节的固定顺序（仅新格式，用于幂等性检测和输出顺序）
export const SECTION_ORDER: string[] = [
  '## Engine version', '## Renderer', '## Key project paths', '## Main scene',
  '## Autoload', '## Input Map', '## Physics settings', '## Layer names',
  '## MCP rule mapping', '## GDScript typing conventions', '## Code best practices',
];

// 绑定 CLAUDE.md 的 SECTION_IDS，保持调用方（project.ts）签名不变
export function mergeSections(existing: string, newSections: Array<[string, string]>): string {
  return mergeSectionsGeneric(existing, newSections, SECTION_IDS);
}

// godot-mcp.md 固定模板内容
// {{MCP_VERSION}} 占位符由 setup_project_rules 在写入时插值（与 DETAILED_RULE_TEMPLATES 统一路径）
export const GODOT_MCP_RULES = `# Godot MCP development rules

> For godot-mcp-enhanced {{MCP_VERSION}}+

## General principles
- Tools marked "runtime operation" only affect the current process; to persist, edit the .tscn/.gd files
- Results of runtime tools are not kept across processes

## Script development
- Call validate_scripts right after edit_script / write_script
- Roll back the change when validation fails
- Preview project_replace with dry_run=true first

## Scene management
- After changing a .tscn, verify its structure with read_scene
- After node path changes, check whether any signal connections broke
- remove_node is destructive, confirm before running it

## Signals
- signal_emit supports primitive types only (string/number/bool/null)
- After renaming/deleting a node, check its signal connections

## Animation
- animation / animation_track / animtree operations are runtime operations
- The animation name must already exist in the AnimationPlayer

## Audio
- Runtime operation, not persisted
- Volume is in dB (-80 to 24)

## UI
- Runtime operation, not persisted
- Prefer ui_build_layout for complex layouts
- To reproduce an HTML prototype prefer ui_import_prototype (geometry JSON → translate + build + check in one call, always persisted; usage and the browser evaluate extraction template are in .claude/rules/godot-mcp-ui.md)

## TileMap
- Runtime operation, not persisted
- Coordinates are Vector2i

## Physics
- The physics tool has five operations: raycast / body_info / diagnose / query_spatial / collision_overlay
- diagnose has side effects (uses move_and_collide test_only)

## Navigation
- nav(action=bake_mesh) is a long-running operation
- Runtime operation, not persisted

## Particles
- Runtime operation, not persisted
- Prefer the preset parameter of particles_create

## Materials and shaders
- shader_edit write mode replaces the whole shader
- Runtime operation, not persisted

## IK and 3D
- Runtime operation, not persisted
- For TwoBoneIK3D, specify the bone_name parameter

## Runtime management
- run_project has a timeout; adjust it for long runs
- launch_editor starts the editor GUI, stop_project kills the running process
- dev_loop can run arbitrary GDScript

## Screenshots and debugging
- screenshot(action="capture") is experimental (rendering is limited in headless mode)
- profiler is for performance analysis (snapshot/start/stop/get_data)

## Game bridge
- Install the bridge and start the game first
- game_write changes runtime state, use with care

## Release gate
- Run verify_delivery(scope="full") before committing a version bump
- Every dimension must be error-free

## GDScript conventions
- Use static typing (var x: int = 0)
- Functions must declare a return type
- Signal callbacks are named with the _on_ prefix
`;

// ─── Simple builders ──────────────────────────────────────────────────────

export function buildEngineVersion(config: GodotConfig | null): string | null {
  if (!config) return null;
  const app = config.application as Record<string, unknown> | undefined;
  if (!app) return null;

  const features = app['config/features'];
  let version = '';

  if (typeof features === 'string') {
    // PackedStringArray("4.6", ...) → extract first quoted value
    const m = features.match(/PackedStringArray\("([^"]+)"/);
    version = m ? m[1]! : features;
  } else if (Array.isArray(features) && features.length > 0) {
    version = String(features[0]);
  }

  if (!version) version = '4.x (version unknown)';
  return `- Godot ${version}`;
}

export function buildRenderer(config: GodotConfig | null): string | null {
  if (!config) return null;
  const rendering = config.rendering as Record<string, unknown> | undefined;
  if (!rendering) return null;

  const renderer = rendering['renderer/rendering_method'] ?? rendering['renderer'];
  if (!renderer || typeof renderer !== 'string') return null;
  return `- ${renderer}`;
}

export function buildMainScene(config: GodotConfig | null): string | null {
  if (!config) return null;
  const app = config.application as Record<string, unknown> | undefined;
  if (!app) return null;

  const scene = app['run/main_scene'] ?? app['run_main_scene'];
  if (!scene || typeof scene !== 'string') return null;
  return `- ${scene}`;
}

// ─── KeyPaths & Autoloads builders ────────────────────────────────────────

const KNOWN_DIRS: Array<{ name: string; label: string }> = [
  { name: 'scenes', label: 'Scene files' },
  { name: 'scripts', label: 'GDScript scripts' },
  { name: 'assets', label: 'Resource files' },
  { name: 'addons', label: 'Plugins' },
  { name: 'shaders', label: 'Shaders' },
  { name: 'resources', label: 'Resource definitions' },
  { name: 'sounds', label: 'Sound effects' },
  { name: 'music', label: 'Music' },
  { name: 'data', label: 'Data files' },
];

export function buildKeyPaths(projectDir: string): string | null {
  const existing: string[] = [];
  for (const { name, label } of KNOWN_DIRS) {
    try {
      if (existsSync(join(projectDir, name))) {
        existing.push(`├── ${name}/ — ${label}`);
      }
    } catch (err) { getLogger().debug('claudemd', `checking known dirs: ${err instanceof Error ? err.message : err}`); }
  }
  if (existing.length === 0) return null;
  // Fix last prefix: ├── → └──
  existing[existing.length - 1] = existing[existing.length - 1]!.replace('├──', '└──');
  return existing.join('\n');
}

export function buildAutoloads(config: GodotConfig | null): string | null {
  if (!config) return null;
  const autoload = config.autoload as Record<string, unknown> | undefined;
  if (!autoload) return null;

  const entries = Object.entries(autoload);
  if (entries.length === 0) return null;

  const rows = entries.map(([name, rawPath]) => {
    const path = typeof rawPath === 'string' ? rawPath.replace(/^\*/, '') : String(rawPath);
    const display = path.length > 40 ? path.slice(0, 37) + '…' : path;
    return `| ${name} | ${display} |`;
  });

  return '| Name | Path |\n|------|------|\n' + rows.join('\n');
}

// Godot 引擎默认物理参数（4.x）
const GODOT_DEFAULTS = { gravity3d: 9.8, gravity2d: 980, physicsFps: 60 };

// ─── InputMap, Physics, LayerNames, McpMapping builders ────────────────────

export function buildInputMap(config: GodotConfig | null): string | null {
  if (!config) return null;
  const input = config.input as Record<string, unknown> | undefined;
  if (!input) return null;

  const actions = Object.keys(input);
  if (actions.length === 0) return null;

  if (actions.length > 15) {
    const shown = actions.slice(0, 15).join(', ');
    return `- actions: ${shown}, ${actions.length} in total`;
  }

  const lines: string[] = [];
  for (let i = 0; i < actions.length; i += 5) {
    lines.push('- ' + actions.slice(i, i + 5).join(', '));
  }
  return lines.join('\n');
}

export function buildPhysics(config: GodotConfig | null): string | null {
  if (!config) return null;
  const physics = config.physics as Record<string, unknown> | undefined;
  if (!physics) return null;

  const lines: string[] = [];
  const gravity3d = physics['3d/default_gravity'];
  const gravity2d = physics['2d/default_gravity'];
  const fps = physics['common/physics_fps'];

  if (typeof gravity3d === 'number' && gravity3d !== GODOT_DEFAULTS.gravity3d) {
    lines.push(`- 3D gravity: ${gravity3d}`);
  }
  if (typeof gravity2d === 'number' && gravity2d !== GODOT_DEFAULTS.gravity2d) {
    lines.push(`- 2D gravity: ${gravity2d}`);
  }
  if (typeof fps === 'number' && fps !== GODOT_DEFAULTS.physicsFps) {
    lines.push(`- Physics FPS: ${fps}`);
  }

  return lines.length > 0 ? lines.join('\n') : null;
}

export function buildLayerNames(config: GodotConfig | null): string | null {
  if (!config) return null;
  const layers = config.layer_names as Record<string, unknown> | undefined;
  if (!layers) return null;

  const groups: Record<string, Array<{ idx: number; name: string }>> = {};

  for (const [key, value] of Object.entries(layers)) {
    if (!value || typeof value !== 'string') continue;
    const parts = key.split('/');
    if (parts.length !== 2) continue;
    const group = parts[0];
    const layerPart = parts[1];
    const match = layerPart!.match(/layer_(\d+)/);
    if (!match) continue;
    const idx = parseInt(match[1]!, 10);

    if (!groups[group!]) groups[group!] = [];
    groups[group!]!.push({ idx, name: value });
  }

  const LABELS: Record<string, string> = {
    '2d_physics': '2D physics', '2d_render': '2D render',
    '3d_physics': '3D physics', '3d_render': '3D render',
  };

  const lines: string[] = [];
  for (const [group, items] of Object.entries(groups)) {
    items.sort((a, b) => a.idx - b.idx);
    const label = LABELS[group] ?? group;
    const summary = items.map(it => `${it.idx}=${it.name}`).join(', ');
    lines.push(`- ${label}: ${summary}`);
  }

  return lines.length > 0 ? lines.join('\n') : null;
}

export function buildMcpMapping(): string {
  return [
    '| Area | rules file |',
    '|------|-----------|',
    '| All tool rules | .claude/rules/godot-mcp.md |',
    '| Core decision tree | .claude/rules/godot-mcp-core.md |',
    '| Game Bridge | .claude/rules/godot-mcp-bridge.md |',
    '| Editor mode | .claude/rules/godot-mcp-editor.md |',
    '| UI layout | .claude/rules/godot-mcp-ui.md |',
    '| Recording and replay | .claude/rules/godot-mcp-recording.md |',
    '| Engine traps | .claude/rules/godot-mcp-engine-quirks.md |',
    '| Runtime verification / E2E | .claude/rules/godot-mcp-workflow-bridge-e2e.md |',
    '| Change → run → verify loop | .claude/rules/godot-mcp-workflow-verify.md |',
    '| Safe editing flow | .claude/rules/godot-mcp-workflow-safe-edit.md |',
  ].join('\n');
}

export function buildTypeGuide(): string {
  return [
    '- **Strict type annotations**: `var speed: float = 100.0` (not `var speed = 100`)',
    '- **Typed parameters and return values**: `func move(dir: Vector2) -> void:`',
    '- **Typed @export**: `@export var health: int = 100`',
    '- **Typed @onready**: `@onready var sprite: Sprite2D = $Sprite2D`',
    '- **Signals in past tense**: `signal health_changed(new_value: int)`',
    '- **Constants in UPPER_SNAKE**: `const MAX_SPEED: float = 300.0`',
    '- **PascalCase node names, snake_case variables**',
    '- **class_name for reusable classes**: `class_name Player extends CharacterBody3D`',
    '',
    '> Why it matters: dynamic typing is the top cause of failed MCP tool calls (confirmed by the DEV.to comparison of 2026-05-20).',
  ].join('\n');
}

export function buildBestPractices(): string {
  return [
    '### Signals instead of polling',
    '- **Drive state changes with signals** instead of polling in `_process`',
    '  ```gdscript',
    '  # ❌ checking every frame',
    '  func _process(delta):',
    '      if enemy.dead: queue_free()',
    '',
    '  # ✅ signal-driven',
    '  func _ready():',
    '      enemy.died.connect(queue_free)',
    '  ```',
    '- **Cache node references**: get them with `@onready` in `_ready()`, don\'t call `get_node()` inside `_process`',
    '',
    '### Separation of concerns',
    '- **Manager classes do logic only**, UI classes only display, data classes only hold state',
    '- Typical split: `BuildManager` (logic) + `BuildUI` (interface) + `BuildingData` (data)',
    '- Consider splitting a script once it passes 300 lines',
    '',
    '### Avoid common traps',
    '- **Check parent class members**: common names like `velocity`, `position`, `state` override base class properties when you `extends CharacterBody3D`',
    '- **Godot 4 API changes**: `AnimationPlayer.add_animation()` is gone, use `get_animation_library("").add_animation()`',
    '- **The default animation library may not exist**: before adding the first animation check `has_animation_library("")` or create an `AnimationLibrary`',
    '- **Reduce per-frame work**: avoid string concatenation, array creation and heavy math inside `_process`',
  ].join('\n');
}

// ─── Merge Engine ─────────────────────────────────────────────────────────
// parseSections / mergeSections / Section / normalizeHeader 已抽离到
// src/tools/shared/section-merge.ts（参数化 sectionIds，供 AGENTS.md builder 复用）。
// 本文件通过上方 mergeSections 包装绑定 SECTION_IDS，保持 project.ts 零改动。

