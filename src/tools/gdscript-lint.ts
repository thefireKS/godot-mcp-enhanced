// See deprecated-properties.ts for the canonical deprecated property list

// ─── Lint Types ─────────────────────────────────────────────────────────────

export interface LintRule {
  id: string;
  severity: "error" | "warning";
  pattern: RegExp;
  message: string;
  suggestion: string;
  requiresSemanticValidation?: boolean;
  contextFilter?: (match: RegExpMatchArray, context: LintContext) => boolean;
  isCallOrder?: boolean;
}

export interface LintResult {
  rule: string;
  severity: "error" | "warning";
  line: number;
  message: string;
  suggestion: string;
  confirmed: boolean;
}

export interface LintContext {
  precedingLines: string[];
}

export interface LintOutput {
  errors: LintResult[];
  warnings: LintResult[];
  meta: {
    godot_target: string;
    rules_count: number;
    last_reviewed: string;
  };
}

// ─── Utility Functions ──────────────────────────────────────────────────────
// v0.30 C 批：以下三个 helper 改导出 —— analysis/gdscan.ts 静态信号扫描复用
// （同源防 drift；此前为模块私有，复用只能复制）。

export function isInComment(line: string, matchIndex: number): boolean {
  let inString = false;
  let stringChar = '';
  for (let i = 0; i < matchIndex && i < line.length; i++) {
    if (!inString) {
      if (line[i]! === '#') return true;
      if (line[i]! === '"' || line[i]! === "'") {
        inString = true;
        stringChar = line[i]!;
      }
    } else {
      if (line[i]! === stringChar && (i === 0 || line[i - 1]! !== '\\')) {
        inString = false;
      }
    }
  }
  return false;
}

export function isInString(line: string, matchIndex: number): boolean {
  let inString = false;
  let stringChar = '';
  for (let i = 0; i < matchIndex && i < line.length; i++) {
    if (!inString) {
      if (line[i]! === '"' || line[i]! === "'") {
        inString = true;
        stringChar = line[i]!;
      }
    } else {
      if (line[i]! === stringChar && (i === 0 || line[i - 1]! !== '\\')) {
        inString = false;
      }
    }
  }
  return inString;
}

export function isInCommentOrString(line: string, matchIndex: number): boolean {
  return isInComment(line, matchIndex) || isInString(line, matchIndex);
}

interface FunctionInfo {
  name: string;
  body: string;
  bodyLines: string[];
  startLine: number;
  endLine: number;
}

function extractFunctions(code: string): FunctionInfo[] {
  const functions: FunctionInfo[] = [];
  const lines = code.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i]!.match(/^(\s*)func\s+(\w+)\s*\(/);
    if (!match) continue;

    const baseIndent = match[1]!.length;
    const funcName = match[2]!;
    const startLine = i + 1;
    const bodyLines: string[] = [];

    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]!;
      if (line.trim() === '') {
        bodyLines.push(line);
        continue;
      }
      const lineIndent = line.match(/^(\s*)/)?.[1]!.length ?? 0;
      if (lineIndent <= baseIndent && line.trim() !== '') break;
      bodyLines.push(line);
    }

    functions.push({
      name: funcName,
      body: bodyLines.join('\n'),
      bodyLines,
      startLine,
      endLine: startLine + bodyLines.length,
    });
  }

  return functions;
}

function extractContext(code: string, matchIndex: number): LintContext {
  const lines = code.split(/\r?\n/);
  let charCount = 0;
  let matchLine = 0;

  for (let i = 0; i < lines.length; i++) {
    if (charCount + lines[i]!.length >= matchIndex) {
      matchLine = i;
      break;
    }
    charCount += lines[i]!.length + 1;
  }

  const startLine = Math.max(0, matchLine - 50);
  const precedingLines = lines.slice(startLine, matchLine);

  return { precedingLines };
}

function hasTypeContext(precedingLines: string[], typeNames: string[]): boolean {
  const codeLines = precedingLines.filter(l => !l.trimStart().startsWith('#'));
  const text = codeLines.join('\n');
  return typeNames.some(t => text.includes(t));
}

// ─── Lint Metadata ──────────────────────────────────────────────────────────

const LINT_VERSION = {
  // 2026-08-19 升 4.7：与 docs/api/extension_api.json（4.7.stable 快照）恢复一致；
  // L025 已含 4.7 accessibility breaking 规则。last_reviewed 保持规则集逐条审阅日（本次仅升 target 声明）。
  godot_target: "4.7",
  last_reviewed: "2026-06-29",
  rules_count: 25,
};

// ─── RULES (populated in Tasks 2-4) ────────────────────────────────────────

const RULES: LintRule[] = [
  // L003: CylinderMesh.radius
  {
    id: "L003",
    severity: "error",
    pattern: /CylinderMesh\w*\.radius\s*=/,
    message: "CylinderMesh.radius doesn't exist in Godot 4; set top_radius and bottom_radius separately",
    suggestion: "Use mesh.top_radius = 0.5 and mesh.bottom_radius = 0.5",
  },
  // L004: Environment.adjustments_*
  {
    id: "L004",
    severity: "error",
    pattern: /\.adjustments_\w+\s*=/,
    message: "Environment's adjustments_* properties have no s in Godot 4: adjustment_*",
    suggestion: "Rename adjustments_enabled → adjustment_enabled, adjustments_brightness → adjustment_brightness, etc.",
  },
  // L005: Environment.tone_mapper
  {
    id: "L005",
    severity: "error",
    pattern: /\.tone_mapper\s*=/,
    message: "Environment.tone_mapper is renamed to tonemap_mode in Godot 4",
    suggestion: "Use env.tonemap_mode = Environment.TONE_MAPPER_LINEAR",
  },
  // L006: SoftBody3D.mass
  {
    id: "L006",
    severity: "error",
    pattern: /SoftBody3D\w*\.mass\s*=/,
    message: "SoftBody3D.mass is renamed to total_mass in Godot 4",
    suggestion: "Use softbody.total_mass = 2.0",
  },
  // L008: ArrayMesh.create_triangle_shape
  {
    id: "L008",
    severity: "error",
    pattern: /\.create_triangle_shape\s*\(/,
    message: "ArrayMesh.create_triangle_shape() doesn't exist in Godot 4; it is create_triangle_mesh()",
    suggestion: "Use mesh.create_triangle_mesh()",
  },
  // L009: Node.get_child_or_null
  {
    id: "L009",
    severity: "error",
    pattern: /\bget_child_or_null\s*\(/,
    message: "Node.get_child_or_null() is removed in Godot 4.x; use get_child() or find_child()",
    suggestion: "Use get_child(index) or find_child(\"name\")",
  },
  // L010: FogMaterial.albedo_color
  {
    id: "L010",
    severity: "error",
    pattern: /FogMaterial\w*\.albedo_color\s*=/,
    message: "FogMaterial.albedo_color is renamed to albedo in Godot 4",
    suggestion: "Use fog.albedo = Color.RED",
  },
  // L011: Environment.physically_based_lights_enabled
  {
    id: "L011",
    severity: "error",
    pattern: /\.physically_based_lights_enabled\s*=/,
    message: "Environment.physically_based_lights_enabled is removed in Godot 4",
    suggestion: "This property is removed, no direct replacement",
  },
  // L012: Line2D.dash_pattern non-typed array
  {
    id: "L012",
    severity: "error",
    pattern: /\.dash_pattern\s*=\s*\[/,
    message: "Line2D.dash_pattern needs a PackedFloat32Array, a plain array literal won't do",
    suggestion: "Use line.dash_pattern = PackedFloat32Array([1.0, 2.0])",
  },
  // L013: CharacterBody3D.body_entered
  {
    id: "L013",
    severity: "error",
    pattern: /CharacterBody\w*\.body_entered/,
    message: "CharacterBody3D has no body_entered signal; use an Area3D child for collision detection",
    suggestion: "Add an Area3D child and connect its body_entered/body_exited signals",
  },
  // L002: RigidBody3D.bounce
  {
    id: "L002",
    severity: "error",
    pattern: /\.bounce\s*=/,
    message: "RigidBody3D.bounce doesn't exist in Godot 4; use a PhysicsMaterial",
    suggestion: "Use a PhysicsMaterial:\n  var mat := PhysicsMaterial.new()\n  mat.bounce = 0.4\n  body.physics_material_override = mat",
    requiresSemanticValidation: true,
    contextFilter: (_match, context): boolean => {
      if (hasTypeContext(context.precedingLines, ['PhysicsMaterial'])) return false;
      return hasTypeContext(context.precedingLines, ['RigidBody3D', 'RigidDynamicBody3D', 'PhysicsBody3D']);
    },
  },
  // L007: Node3D.visibility_range_*
  {
    id: "L007",
    severity: "error",
    pattern: /\.visibility_range_\w+\s*=/,
    message: "visibility_range_* properties live on GeometryInstance3D, not Node3D",
    suggestion: "Make sure it is a GeometryInstance3D subclass such as MeshInstance3D/GPUParticles3D",
    requiresSemanticValidation: true,
    contextFilter: (_match, context): boolean => {
      const geoSubclasses = ['MeshInstance3D', 'GPUParticles3D', 'CPUParticles3D',
        'MultiMeshInstance3D', 'Decal', 'FogVolume', 'GeometryInstance3D',
        'VisualInstance3D', 'SpriteBase3D', 'Label3D'];
      if (hasTypeContext(context.precedingLines, geoSubclasses)) return false;
      return hasTypeContext(context.precedingLines, ['Node3D']);
    },
  },
  // L001: look_at before add_child
  { id: "L001", severity: "error", pattern: /^$/m, isCallOrder: true,
    message: "look_at() is called before add_child(); the node is not in the scene tree",
    suggestion: "Call add_child() first to put the node in the scene tree, then look_at()" },
  // L014: AStarGrid2D update clears point data
  { id: "L014", severity: "warning", pattern: /^$/m, isCallOrder: true,
    message: "set_point_solid() is called before update(); update() clears all point data",
    suggestion: "Call grid.update() first, then grid.set_point_solid()" },
  // L015: RigidBody3D.look_at in _process
  { id: "L015", severity: "error", pattern: /^$/m, isCallOrder: true,
    message: "Calling look_at() on a RigidBody3D inside _process/_physics_process breaks the physics simulation",
    suggestion: "Implement the follow logic in _integrate_forces()" },
  // L016: add_child followed by immediate method call
  { id: "L016", severity: "warning", pattern: /^$/m, isCallOrder: true,
    message: "Child methods are accessed right after add_child() in the same function; may fail because _ready hasn't fired yet",
    suggestion: "Wait a frame with await get_tree().process_frame before accessing it" },
  // L017: _unhandled_input with full-rect Control risk
  { id: "L017", severity: "warning", pattern: /_unhandled_input/,
    message: "_unhandled_input is used — if the scene has a full-screen Control (default mouse_filter=STOP), input events may be swallowed",
    suggestion: "Set mouse_filter = Control.MOUSE_FILTER_IGNORE explicitly on Controls covering the viewport, or use _input() instead" },
  // L018: TileSet add_source must precede TileData operations
  { id: "L018", severity: "error", pattern: /^$/m, isCallOrder: true,
    message: "TileData is touched before add_source(); the source_id is not registered yet",
    suggestion: "Call tileset.add_source(atlas_source) first to get the source_id, then work with TileData" },
  // L019: class_name cross-file resolution in headless
  { id: "L019", severity: "warning", pattern: /\bclass_name\s+\w+/,
    message: "class_name can't be resolved across files in a headless/MCP environment; other files can't reference this class by its type name",
    suggestion: "Alternatives:\n  1. In the using file add const MyClass := preload('res://my_class.gd') and use MyClass as the type annotation\n  2. Type exported functions with the base class: func spawn() -> Node: (not the custom class name)\n  3. For global type registration, use Engine.register_script_class() in _ready (Godot 4.4+)" },
  // L020: AnimationPlayer.add_animation() removed in Godot 4
  {
    id: "L020",
    severity: "error",
    pattern: /\.add_animation\s*\(/,
    message: "AnimationPlayer.add_animation() is removed in Godot 4; animations can't be added to an AnimationPlayer directly",
    suggestion: "Use get_animation_library(\"\").add_animation(name, anim) or create an AnimationLibrary:\n  var lib := AnimationLibrary.new()\n  lib.add_animation(name, anim)\n  player.add_animation_library(\"\", lib)",
    requiresSemanticValidation: true,
    contextFilter: (_match, context): boolean => {
      return hasTypeContext(context.precedingLines, ['AnimationPlayer', 'animation_player', 'anim_player', 'player']);
    },
  },
  // L021: Member variable shadows parent class member
  {
    id: "L021",
    severity: "warning",
    pattern: /^(\s*)var\s+(\w+)\s*[:=]/m,
    message: "A member variable may share its name with a parent class member and shadow it",
    suggestion: "Check whether the extended base class has a member with this name; if so, rename the variable",
    requiresSemanticValidation: true,
    contextFilter: (match, context): boolean => {
      const varName = match[2]!;
      const SHADOW_PRONE = [
        'velocity', 'position', 'rotation', 'scale', 'modulate', 'visible',
        'speed', 'health', 'damage', 'direction', 'state', 'current_state',
        'target', 'target_position', 'input', 'audio', 'animation',
        'collision_mask', 'collision_layer', 'mass', 'gravity',
        'process_mode', 'process_priority', 'script',
      ];
      if (!SHADOW_PRONE.includes(varName)) return false;
      return hasTypeContext(context.precedingLines, [
        'extends CharacterBody', 'extends RigidBody', 'extends StaticBody',
        'extends Node2D', 'extends Node3D', 'extends Control',
        'extends Area2D', 'extends Area3D', 'extends KinematicBody',
      ]);
    },
  },
  // L022: Polling pattern in _process/_physics_process
  {
    id: "L022",
    severity: "warning",
    pattern: /^(\s*)var\s+\w+\s*=\s*get_node\s*\(/m,
    message: "get_node() polling inside _process looks the node up again every frame, which is slow",
    suggestion: "Cache the node reference in _ready(): onready var node = %NodeName or onready var node = $Path",
    requiresSemanticValidation: true,
    contextFilter: (_match, context): boolean => {
      const recent = context.precedingLines.slice(-5).join('\n');
      return recent.includes('_process') || recent.includes('_physics_process');
    },
  },
  // L023: RichTextLabel ImageUpdateMask 枚举重命名 (Godot 4.7, GH-112617)
  {
    id: "L023",
    severity: "error",
    pattern: /ImageUpdateMask\.UPDATE_WIDTH_IN_PERCENT/,
    message: "RichTextLabel.ImageUpdateMask.UPDATE_WIDTH_IN_PERCENT is renamed to UPDATE_WIDTH_UNIT in Godot 4.7",
    suggestion: "Use ImageUpdateMask.UPDATE_WIDTH_UNIT (Godot 4.7+)",
  },
  // L024: AudioEffectSpectrumAnalyzer.tap_back_pos 移除 (Godot 4.7, GH-114355)
  {
    id: "L024",
    severity: "error",
    pattern: /\.tap_back_pos\b/,
    message: "AudioEffectSpectrumAnalyzer.tap_back_pos is removed in Godot 4.7",
    suggestion: "Remove tap_back_pos usage (Godot 4.7 migration guide GH-114355)",
  },
  // L025: DisplayServer accessibility API moved to AccessibilityServer in Godot 4.7 (GH-116839)
  {
    id: "L025",
    severity: "warning",
    pattern: /DisplayServer\.(accessibility_|AccessibilityLiveMode)/,
    message: "DisplayServer's accessibility methods/enums moved to the AccessibilityServer singleton in Godot 4.7 (GH-116839)",
    suggestion: "4.7 migration: DisplayServer.accessibility_xxx() → AccessibilityServer.xxx(); enum DisplayServer.AccessibilityLiveMode → AccessibilityServer.AccessibilityLiveMode (accessibility_live values LIVE_OFF/LIVE_POLITE/LIVE_ASSERTIVE)",
  },
];

// ─── Main Lint Function ────────────────────────────────────────────────────

export function lintGDScript(code: string): LintOutput {
  const errors: LintResult[] = [];
  const warnings: LintResult[] = [];
  const lines = code.split(/\r?\n/);
  const functions = extractFunctions(code);

  for (const rule of RULES) {
    if (rule.isCallOrder) {
      lintCallOrder(rule, functions, errors, warnings);
    } else {
      lintRegex(rule, code, lines, errors, warnings);
    }
  }

  return {
    errors,
    warnings,
    meta: {
      godot_target: LINT_VERSION.godot_target,
      rules_count: RULES.length,
      last_reviewed: LINT_VERSION.last_reviewed,
    },
  };
}

function lintCallOrder(
  rule: LintRule,
  functions: FunctionInfo[],
  errors: LintResult[],
  warnings: LintResult[],
): void {
  for (const func of functions) {
    const body = func.body;
    switch (rule.id) {
      case "L001": {
        const lookAtMatch = body.match(/\.look_at\s*\(/);
        const addChildMatch = body.match(/add_child\s*\(/);
        if (lookAtMatch && addChildMatch) {
          if (body.indexOf(lookAtMatch[0]) < body.indexOf(addChildMatch[0])) {
            errors.push({ rule: rule.id, severity: rule.severity, line: func.startLine,
              message: rule.message, suggestion: rule.suggestion, confirmed: true });
          }
        }
        break;
      }
      case "L014": {
        const solidMatch = body.match(/\.set_point_solid\s*\(/);
        const updateMatch = body.match(/\.update\s*\(\s*\)/);
        if (solidMatch && updateMatch) {
          if (body.indexOf(solidMatch[0]) < body.indexOf(updateMatch[0])) {
            warnings.push({ rule: rule.id, severity: rule.severity, line: func.startLine,
              message: rule.message, suggestion: rule.suggestion, confirmed: true });
          }
        }
        break;
      }
      case "L015": {
        if (func.name === '_process' || func.name === '_physics_process') {
          let hasLookAt = false;
          let hasRigidBody = false;
          for (const line of func.bodyLines) {
            const stripped = line.trimStart();
            if (stripped.startsWith('#')) continue;
            for (let pos = 0; pos < line.length; ) {
              const laMatch = line.indexOf('look_at', pos);
              const rbMatch = line.indexOf('RigidBody', pos);
              if (laMatch === -1 && rbMatch === -1) break;
              if (laMatch !== -1 && laMatch < (rbMatch === -1 ? Infinity : rbMatch)) {
                if (!isInCommentOrString(line, laMatch)) hasLookAt = true;
                pos = laMatch + 1;
              } else {
                if (!isInCommentOrString(line, rbMatch!)) hasRigidBody = true;
                pos = rbMatch! + 1;
              }
            }
            if (hasLookAt && hasRigidBody) break;
          }
          if (hasLookAt && hasRigidBody) {
            errors.push({ rule: rule.id, severity: rule.severity, line: func.startLine,
              message: rule.message, suggestion: rule.suggestion, confirmed: true });
          }
        }
        break;
      }
      case "L016": {
        // L016: Only detects variable-based patterns: add_child(var) followed by var.method()
        // Does not detect inline: add_child(SomeClass.new()) — no variable to access
        const acReg = /add_child\s*\(\s*(\w+)\s*\)/g;
        let acMatch;
        while ((acMatch = acReg.exec(body)) !== null) {
          const childVar = acMatch[1];
          const after = body.substring(acMatch.index + acMatch[0].length).trimStart();
          if (after.startsWith(childVar + '.') || after.startsWith(childVar + ' ')) {
            warnings.push({ rule: rule.id, severity: rule.severity, line: func.startLine,
              message: rule.message, suggestion: rule.suggestion, confirmed: true });
            break;
          }
        }
        break;
      }
      case "L018": {
        // L018: TileData operations must come after add_source
        const addSourceMatch = body.match(/\.add_source\s*\(/);
        const tileDataMatch = body.match(/\.get_tile_data\s*\(|\.set_tile_data\s*\(/);
        if (addSourceMatch && tileDataMatch) {
          if (body.indexOf(tileDataMatch[0]) < body.indexOf(addSourceMatch[0])) {
            errors.push({ rule: rule.id, severity: rule.severity, line: func.startLine,
              message: rule.message, suggestion: rule.suggestion, confirmed: true });
          }
        }
        break;
      }
    }
  }
}

function lintRegex(
  rule: LintRule,
  code: string,
  lines: string[],
  errors: LintResult[],
  warnings: LintResult[],
): void {
  // Precompute line start offsets
  const lineOffsets = new Uint32Array(lines.length + 1);
  for (let i = 0; i < lines.length; i++) {
    lineOffsets[i + 1] = lineOffsets[i]! + lines[i]!.length + 1;
  }
  const globalPattern = rule.pattern.global
    ? rule.pattern
    : new RegExp(rule.pattern.source, rule.pattern.flags ? rule.pattern.flags + 'g' : 'g');

  let match: RegExpMatchArray | null;
  while ((match = globalPattern.exec(code)) !== null) {
    const matchIndex = match.index!;
    // Binary search on lineOffsets to find 1-based line number
    let lo = 0, hi = lines.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (lineOffsets[mid]! <= matchIndex) lo = mid + 1;
      else hi = mid;
    }
    const lineNum = lo;
    const lineText = lines[lineNum - 1] || '';

    const lineOffset = matchIndex - lineOffsets[lineNum - 1]!;

    if (isInCommentOrString(lineText, Math.max(0, lineOffset))) continue;

    const result: LintResult = {
      rule: rule.id,
      severity: rule.severity,
      line: lineNum,
      message: rule.message,
      suggestion: rule.suggestion,
      confirmed: true,
    };

    if (rule.contextFilter) {
      const context = extractContext(code, matchIndex);
      if (!rule.contextFilter(match, context)) continue;
    }

    if (rule.severity === "error") {
      errors.push(result);
    } else {
      warnings.push(result);
    }
  }
}

/** 格式化 lint 结果为人类可读文本 */
export function formatLintResults(output: LintOutput): string {
  if (output.errors.length === 0 && output.warnings.length === 0) return '';

  const parts: string[] = [];
  if (output.errors.length > 0) {
    parts.push(`Lint Errors (${output.errors.length}):`);
    for (const e of output.errors) {
      parts.push(`  ${e.rule} (line ${e.line}): ${e.message}`);
      if (e.suggestion) parts.push(`    → ${e.suggestion.split('\n')[0]}`);
    }
  }
  if (output.warnings.length > 0) {
    parts.push(`Lint Warnings (${output.warnings.length}):`);
    for (const w of output.warnings) {
      parts.push(`  ${w.rule} (line ${w.line}): ${w.message}`);
      if (w.suggestion) parts.push(`    → ${w.suggestion.split('\n')[0]}`);
    }
  }
  return '\n\n' + parts.join('\n');
}
