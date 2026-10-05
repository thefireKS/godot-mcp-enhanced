import type { Tool } from "@modelcontextprotocol/server";
import type { ToolContext, ToolResult } from '../types.js';
import { opsErrorResult } from './shared.js';
import type { RiskLevel } from '../core/tool-registry.js';

// ─── P2-12 phase 1: McpTestSuite runner (editor-only) ────────────────────────
//
// This tool runs AI-authored GDScript test suites (`extends McpTestSuite`)
// in the editor via the `test_run` / `test_manage` command_handler cases.
//
// Headless mode: both actions hard-return EDITOR_ONLY — the GD-side runner
// needs EditorInterface + EditorUndoRedoManager (unavailable headless). In
// editor mode GodotServer.ts dispatches to EditorToolExecutor BEFORE this
// module, so this handleTool path only fires in headless (same pattern as
// the deprecated test-framework.ts export_* actions).

const TOOL_NAMES = ['testing'] as const;
export { TOOL_NAMES };

const ACTIONS = ['run', 'manage'] as const;

// ─── Tool definitions ──────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'testing',
      description: [
        'McpTestSuite test framework (editor-only): runs GDScript test suites written by the AI (`extends McpTestSuite`, placed in `res://tests/` or `addons/godot_mcp_server/testing/suites/`).',
        'run: discover and run suites; returns structured passed/failed/skipped/total/failures.',
        'manage: op="results_get" fetches the partial results of the last run (after a timeout/interruption).',
        '⚠️ P2-12 phase 2: runs as an async coroutine, yielding the main loop after each test (heartbeat keeps pinging), so long suites work (total budget 290s; on timeout split the run with suite=).',
        '⚠️ editor-only: headless mode returns EDITOR_ONLY. Needs `GODOT_MCP_MODE=editor` and the Godot plugin installed.',
      ].join(' '),
      inputSchema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            enum: [...ACTIONS],
            description: 'Action type: run | manage',
          },
          // run params
          suite: {
            type: 'string',
            description: 'run: suite name filter (exact match on suite_name(), empty = all)',
          },
          test_name: {
            type: 'string',
            description: 'run: test method name filter (substring, empty = all)',
          },
          exclude_test_name: {
            type: 'string',
            description: 'run: excluded test methods (comma-separated substrings)',
          },
          verbose: {
            type: 'boolean',
            description: 'run/manage: return per-test details (default: aggregate + failures only)',
          },
          // manage params
          op: {
            type: 'string',
            enum: ['results_get'],
            description: 'manage: operation (only results_get for now)',
          },
          project_path: {
            type: 'string',
            description: 'Path to Godot project directory (can be omitted in editor mode to use the open project)',
          },
        },
        required: ['action'],
      },
    },
  ];
}

// ─── Tool handler ───────────────────────────────────────────────────────────

export async function handleTool(
  name: string,
  args: Record<string, unknown>,
  _ctx: ToolContext,
): Promise<ToolResult | null> {
  if (name !== 'testing') return null;

  const action = args.action as string;
  if (!action) return opsErrorResult('INVALID_PARAMS', 'action is required');
  if (!(ACTIONS as readonly string[]).includes(action)) {
    return opsErrorResult('INVALID_ACTION', `Unknown action: ${action}. Supported: ${ACTIONS.join(', ')}`);
  }

  // Both actions are editor-only: the GD-side runner needs EditorInterface +
  // EditorUndoRedoManager. In editor mode GodotServer dispatches to
  // EditorToolExecutor before reaching this module, so this branch only fires
  // in headless (same pattern as test-framework.ts:78-80 export_* actions).
  return opsErrorResult(
    'EDITOR_ONLY',
    `Action "${action}" requires Editor mode. Set GODOT_MCP_MODE=editor and install the Godot plugin. ` +
      'McpTestSuite runner needs EditorInterface + EditorUndoRedoManager (unavailable headless).',
  );
}

// ─── Tool metadata ──────────────────────────────────────────────────────────

export const TOOL_META: Record<
  string,
  { readonly: boolean; long_running: boolean; actionRisks?: Record<string, RiskLevel> }
> = {
  testing: {
    readonly: true,
    long_running: true,
    actionRisks: {
      run: 'read',
      manage: 'read',
    } satisfies Record<typeof ACTIONS[number], RiskLevel>,
  },
};
