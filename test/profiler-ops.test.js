import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockSuccessResult } from './helpers/mock-results.js';

// Mock gdscript-executor before importing the module under test
vi.mock('../src/gdscript-executor.js', () => ({
  executeGdscript: vi.fn(async () => mockSuccessResult({
    outputs: [
      { key: 'snapshot', value: '{"fps":60,"memory_static_mb":50}' },
    ],
  })),
}));

import {
  getToolDefinitions,
  handleTool,
  TOOL_META,
} from '../src/tools/profiler-ops.js';
import { executeGdscript } from '../src/gdscript-executor.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function createMockCtx() {
  return {
    opsScript: '/fake/ops.gd',
    findGodot: vi.fn(async () => '/fake/godot'),
    runningProcess: null,
    setRunningProcess: vi.fn(),
    outputBuffer: [],
    setOutputBuffer: vi.fn(),
    processStartTime: 0,
    setProcessStartTime: vi.fn(),
    projectDir: '/fake/project',
    setProjectDir: vi.fn(),
    parseGodotConfig: vi.fn(),
  };
}

// ─── getToolDefinitions ─────────────────────────────────────────────────────

describe('profiler-ops getToolDefinitions', () => {
  it('returns a non-empty array', () => {
    const defs = getToolDefinitions();
    expect(Array.isArray(defs)).toBe(true);
    expect(defs.length).toBeGreaterThan(0);
  });

  it('has exactly 1 tool definition named profiler', () => {
    const defs = getToolDefinitions();
    expect(defs.length).toBe(1);
    expect(defs[0].name).toBe('profiler');
  });

  it('profiler definition has action enum with all sub-actions', () => {
    const defs = getToolDefinitions();
    const schema = defs[0].inputSchema;
    const actionEnum = schema.properties.action.enum;
    expect(actionEnum).toContain('snapshot');
    expect(actionEnum).toContain('start');
    expect(actionEnum).toContain('stop');
    expect(actionEnum).toContain('get_data');
    expect(actionEnum).toContain('get_active_processes');
    expect(actionEnum).toContain('get_signal_connections');
  });

  it('requires project_path and action', () => {
    const defs = getToolDefinitions();
    const required = defs[0].inputSchema.required;
    expect(required).toContain('action');
  });

  it('has dimensions parameter in get_data schema', () => {
    const defs = getToolDefinitions();
    const schema = defs[0].inputSchema;
    expect(schema.properties.dimensions).toBeDefined();
    expect(schema.properties.dimensions.type).toBe('array');
    expect(schema.properties.dimensions.description).toContain('dimensions');
  });

  it('has leak_threshold_mb parameter in get_data schema', () => {
    const defs = getToolDefinitions();
    const schema = defs[0].inputSchema;
    expect(schema.properties.leak_threshold_mb).toBeDefined();
    expect(schema.properties.leak_threshold_mb.type).toBe('number');
    expect(schema.properties.leak_threshold_mb.description).toContain('leak');
  });
});

// ─── TOOL_META ──────────────────────────────────────────────────────────────

describe('profiler-ops TOOL_META', () => {
  it('has entry for profiler', () => {
    expect(Object.keys(TOOL_META).length).toBe(1);
    expect(TOOL_META.profiler).toBeDefined();
  });

  it('profiler is marked non-readonly and non-long-running', () => {
    expect(TOOL_META.profiler.readonly).toBe(false);
    expect(TOOL_META.profiler.long_running).toBe(false);
  });
});

// ─── handleTool — unknown tool ──────────────────────────────────────────────

describe('profiler-ops handleTool — unknown tool', () => {
  it('returns null for an unrecognized tool name', async () => {
    const result = await handleTool('unknown_tool', {}, createMockCtx());
    expect(result).toBeNull();
  });
});

// ─── handleTool — profiler snapshot ─────────────────────────────────────────

describe('profiler-ops handleTool — profiler snapshot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls executeGdscript and returns result for snapshot action', async () => {
    const ctx = createMockCtx();
    const result = await handleTool('profiler', {
      project_path: '/fake/project',
      action: 'snapshot',
    }, ctx);

    expect(result).not.toBeNull();
    expect(executeGdscript).toHaveBeenCalledTimes(1);
    const callArgs = executeGdscript.mock.calls[0][0];
    expect(callArgs.code).toContain('Performance.get_monitor');
    expect(callArgs.code).toContain('snapshot');
  });
});

// ─── handleTool — profiler start ────────────────────────────────────────────

describe('profiler-ops handleTool — profiler start', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls executeGdscript for start action', async () => {
    const ctx = createMockCtx();
    const result = await handleTool('profiler', {
      project_path: '/fake/project',
      action: 'start',
    }, ctx);

    expect(result).not.toBeNull();
    expect(executeGdscript).toHaveBeenCalledTimes(1);
    const callArgs = executeGdscript.mock.calls[0][0];
    expect(callArgs.code).toContain('profiling_started');
  });
});

// ─── handleTool — profiler stop ─────────────────────────────────────────────

describe('profiler-ops handleTool — profiler stop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls executeGdscript for stop action', async () => {
    const ctx = createMockCtx();
    const result = await handleTool('profiler', {
      project_path: '/fake/project',
      action: 'stop',
    }, ctx);

    expect(result).not.toBeNull();
    expect(executeGdscript).toHaveBeenCalledTimes(1);
    const callArgs = executeGdscript.mock.calls[0][0];
    expect(callArgs.code).toContain('profiling_stopped');
  });
});

// ─── handleTool — profiler get_data ─────────────────────────────────────────

describe('profiler-ops handleTool — profiler get_data', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls executeGdscript with frame collection code', async () => {
    const ctx = createMockCtx();
    const result = await handleTool('profiler', {
      project_path: '/fake/project',
      action: 'get_data',
      target_fps: 60,
      frame_count: 30,
    }, ctx);

    expect(result).not.toBeNull();
    expect(executeGdscript).toHaveBeenCalledTimes(1);
    const callArgs = executeGdscript.mock.calls[0][0];
    expect(callArgs.code).toContain('_mcp_frame_count');
    expect(callArgs.code).toContain('_mcp_target_fps');
    expect(callArgs.timeout).toBe(45);
  });

  it('uses default target_fps and frame_count when not specified', async () => {
    const ctx = createMockCtx();
    await handleTool('profiler', {
      project_path: '/fake/project',
      action: 'get_data',
    }, ctx);

    const callArgs = executeGdscript.mock.calls[0][0];
    expect(callArgs.code).toContain('_mcp_target_fps: float = 60');
    expect(callArgs.code).toContain('_mcp_frame_count: int = 60');
  });

  it('rejects invalid dimension strings and falls back to process', async () => {
    const ctx = createMockCtx();
    const result = await handleTool('profiler', {
      project_path: '/fake/project',
      action: 'get_data',
      dimensions: ['typo', 'process'],
    }, ctx);

    expect(result).not.toBeNull();
    const callArgs = executeGdscript.mock.calls[0][0];
    expect(callArgs.code).toContain('Performance.TIME_PROCESS');
    expect(callArgs.code).not.toContain('Performance.TIME_NAVIGATION');
    // Check warning in result
    const text = result.content[0].text;
    expect(text).toContain('typo');
  });

  it('falls back to process when all dimensions are invalid', async () => {
    const ctx = createMockCtx();
    const result = await handleTool('profiler', {
      project_path: '/fake/project',
      action: 'get_data',
      dimensions: ['bogus'],
    }, ctx);

    expect(result).not.toBeNull();
    const callArgs = executeGdscript.mock.calls[0][0];
    expect(callArgs.code).toContain('Performance.TIME_PROCESS');
  });

  it('accepts valid dimensions array', async () => {
    const ctx = createMockCtx();
    await handleTool('profiler', {
      project_path: '/fake/project',
      action: 'get_data',
      dimensions: ['process', 'physics'],
    }, ctx);

    const callArgs = executeGdscript.mock.calls[0][0];
    expect(callArgs.code).toContain('Performance.TIME_PROCESS');
    expect(callArgs.code).toContain('Performance.TIME_PHYSICS_PROCESS');
  });

  it('generates multi-dimension sampling code', async () => {
    const ctx = createMockCtx();
    await handleTool('profiler', {
      project_path: '/fake/project',
      action: 'get_data',
      dimensions: ['process', 'physics'],
    }, ctx);

    const code = executeGdscript.mock.calls[0][0].code;
    expect(code).toContain('_mcp_dim_process');
    expect(code).toContain('_mcp_dim_physics');
  });

  it('includes p99 percentile in generated code', async () => {
    const ctx = createMockCtx();
    await handleTool('profiler', {
      project_path: '/fake/project',
      action: 'get_data',
    }, ctx);

    const code = executeGdscript.mock.calls[0][0].code;
    expect(code).toContain('0.99');
  });

  it('includes degradation detection with division-by-zero guard', async () => {
    const ctx = createMockCtx();
    await handleTool('profiler', {
      project_path: '/fake/project',
      action: 'get_data',
    }, ctx);

    const code = executeGdscript.mock.calls[0][0].code;
    expect(code).toContain('degradation');
    expect(code).toContain('>= 2');
  });

  it('includes memory trend sampling', async () => {
    const ctx = createMockCtx();
    await handleTool('profiler', {
      project_path: '/fake/project',
      action: 'get_data',
    }, ctx);

    const code = executeGdscript.mock.calls[0][0].code;
    expect(code).toContain('_capture_memory');
    expect(code).toContain('memory_trend');
    expect(code).toContain('leak_suspected');
  });

  it('includes render stats as independent block', async () => {
    const ctx = createMockCtx();
    await handleTool('profiler', {
      project_path: '/fake/project',
      action: 'get_data',
    }, ctx);

    const code = executeGdscript.mock.calls[0][0].code;
    expect(code).toContain('render_stats');
    expect(code).toContain('RENDER_TOTAL_DRAW_CALLS_IN_FRAME');
    expect(code).not.toContain('_mcp_dim_render');
  });

  it('uses leak_threshold_mb in generated code', async () => {
    const ctx = createMockCtx();
    await handleTool('profiler', {
      project_path: '/fake/project',
      action: 'get_data',
      leak_threshold_mb: 5.0,
    }, ctx);

    const code = executeGdscript.mock.calls[0][0].code;
    expect(code).toContain('5.0');
  });

  it('preserves default behavior when no new params given', async () => {
    const ctx = createMockCtx();
    await handleTool('profiler', {
      project_path: '/fake/project',
      action: 'get_data',
    }, ctx);

    const code = executeGdscript.mock.calls[0][0].code;
    expect(code).toContain('frame_budget');
    expect(code).toContain('_mcp_target_fps');
    expect(code).toContain('_mcp_frame_count');
  });

  it('generates safe code for frame_count=1 (T2: no division-by-zero in degradation)', async () => {
    const ctx = createMockCtx();
    const result = await handleTool('profiler', {
      project_path: '/fake/project',
      action: 'get_data',
      frame_count: 1,
    }, ctx);

    expect(result).not.toBeNull();
    const code = executeGdscript.mock.calls[0][0].code;
    // Degradation guard must be present: _n >= 2 means with 1 frame, degradation is skipped
    expect(code).toContain('>= 2');
    // Should NOT produce division by zero - half = 0 scenario is avoided by the guard
    expect(code).not.toContain('/ 0)');
    // Should still produce valid output (no crash paths)
    expect(code).toContain('_mcp_done()');
  });

  // A-02: leak_threshold_mb boundary tests
  it('falls back to default when leak_threshold_mb is NaN', async () => {
    const ctx = createMockCtx();
    await handleTool('profiler', {
      project_path: '/fake/project',
      action: 'get_data',
      leak_threshold_mb: NaN,
    }, ctx);

    const code = executeGdscript.mock.calls[0][0].code;
    expect(code).toContain('2.0'); // default fallback
  });

  it('falls back to default when leak_threshold_mb is negative', async () => {
    const ctx = createMockCtx();
    await handleTool('profiler', {
      project_path: '/fake/project',
      action: 'get_data',
      leak_threshold_mb: -5.0,
    }, ctx);

    const code = executeGdscript.mock.calls[0][0].code;
    expect(code).toContain('2.0'); // default fallback
  });

  it('falls back to default when leak_threshold_mb is Infinity', async () => {
    const ctx = createMockCtx();
    await handleTool('profiler', {
      project_path: '/fake/project',
      action: 'get_data',
      leak_threshold_mb: Infinity,
    }, ctx);

    const code = executeGdscript.mock.calls[0][0].code;
    expect(code).toContain('2.0'); // default fallback
  });

  it('falls back to default when leak_threshold_mb is zero', async () => {
    const ctx = createMockCtx();
    await handleTool('profiler', {
      project_path: '/fake/project',
      action: 'get_data',
      leak_threshold_mb: 0,
    }, ctx);

    const code = executeGdscript.mock.calls[0][0].code;
    expect(code).toContain('2.0'); // default fallback
  });

  // I-03: non-string dimension elements warning
  it('warns about non-string dimension elements', async () => {
    const ctx = createMockCtx();
    const result = await handleTool('profiler', {
      project_path: '/fake/project',
      action: 'get_data',
      dimensions: [123, 'process', true],
    }, ctx);

    expect(result).not.toBeNull();
    const text = result.content[0].text;
    expect(text).toContain('Non-string');
    // 'process' should still work
    const code = executeGdscript.mock.calls[0][0].code;
    expect(code).toContain('Performance.TIME_PROCESS');
  });

  it('falls back to process when dimensions is empty array', async () => {
    const ctx = createMockCtx();
    const result = await handleTool('profiler', {
      project_path: '/fake/project',
      action: 'get_data',
      dimensions: [],
    }, ctx);

    expect(result).not.toBeNull();
    const code = executeGdscript.mock.calls[0][0].code;
    expect(code).toContain('Performance.TIME_PROCESS');
  });

  // IMPORTANT-02: spike detection restored
  it('includes spike detection in generated code', async () => {
    const ctx = createMockCtx();
    await handleTool('profiler', {
      project_path: '/fake/project',
      action: 'get_data',
    }, ctx);

    const code = executeGdscript.mock.calls[0][0].code;
    expect(code).toContain('spike_threshold');
    expect(code).toContain('spike_count');
    expect(code).toContain('spikes');
  });
});

// ─── handleTool — profiler get_active_processes ─────────────────────────────

describe('profiler-ops handleTool — profiler get_active_processes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls executeGdscript for get_active_processes action', async () => {
    const ctx = createMockCtx();
    const result = await handleTool('profiler', {
      project_path: '/fake/project',
      action: 'get_active_processes',
      node_path: 'root/Player',
    }, ctx);

    expect(result).not.toBeNull();
    expect(executeGdscript).toHaveBeenCalledTimes(1);
    const callArgs = executeGdscript.mock.calls[0][0];
    expect(callArgs.code).toContain('active_processes');
    expect(callArgs.code).toContain('has_method');
  });
});

// ─── handleTool — profiler get_signal_connections ───────────────────────────

describe('profiler-ops handleTool — profiler get_signal_connections', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls executeGdscript for get_signal_connections action', async () => {
    const ctx = createMockCtx();
    const result = await handleTool('profiler', {
      project_path: '/fake/project',
      action: 'get_signal_connections',
      node_path: 'root/Player',
    }, ctx);

    expect(result).not.toBeNull();
    expect(executeGdscript).toHaveBeenCalledTimes(1);
    const callArgs = executeGdscript.mock.calls[0][0];
    expect(callArgs.code).toContain('signal_connections');
    expect(callArgs.code).toContain('get_signal_connection_list');
  });
});

// ─── handleTool — invalid action ────────────────────────────────────────────

describe('profiler-ops handleTool — invalid action', () => {
  it('returns error for unknown action', async () => {
    const ctx = createMockCtx();
    const result = await handleTool('profiler', {
      project_path: '/fake/project',
      action: 'nonexistent',
    }, ctx);

    expect(result).not.toBeNull();
    const text = result.content[0].text;
    expect(text).toContain('INVALID_ACTION');
  });

  it('returns error for out-of-range target_fps', async () => {
    const ctx = createMockCtx();
    const result = await handleTool('profiler', {
      project_path: '/fake/project',
      action: 'get_data',
      target_fps: 9999,
    }, ctx);

    expect(result).not.toBeNull();
    const text = result.content[0].text;
    expect(text).toContain('INVALID_PARAMS');
  });
});
