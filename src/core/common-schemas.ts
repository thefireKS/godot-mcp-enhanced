/**
 * 共享参数 schema 定义 — 所有工具引用而非重写。
 * @phase2 Phase 2 预留 — 统一 Action 路由启用后消费。
 */
export const COMMON_SCHEMAS = {
  project_path: {
    type: 'string' as const,
    description: 'Godot project directory (optional; defaults to the GODOT_PROJECT_PATH env var or the current directory)',
  },
  scene_path: {
    type: 'string' as const,
    description: 'Scene file path (project-relative, e.g. res://scenes/main.tscn)',
  },
  node_path: {
    type: 'string' as const,
    description: 'Node path (root/Player/Sprite2D)',
  },
  animation_name: {
    type: 'string' as const,
    description: 'Animation name',
  },
  load_autoloads: {
    type: 'boolean' as const,
    description: 'Load the Autoload context (default true)',
  },
} as const;

export type CommonSchemaKey = keyof typeof COMMON_SCHEMAS;

/** 构建工具 schema 时注入 common params。已有定义不覆盖。 */
export function withCommonParams(
  params: Record<string, unknown>,
  ...commonKeys: CommonSchemaKey[]
): Record<string, unknown> {
  const result = { ...params };
  for (const key of commonKeys) {
    if (!(key in result) && COMMON_SCHEMAS[key]) {
      result[key] = { ...COMMON_SCHEMAS[key] };
    }
  }
  return result;
}