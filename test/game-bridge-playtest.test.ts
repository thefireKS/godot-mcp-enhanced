import { describe, it, expect } from 'vitest';
import { PLAYTEST_METHODS, getToolDefinitions, TOOL_META, computePlaytestTimeoutMs } from '../src/tools/game-bridge.js';

// P2-4 确定性 playtest 单测:验证 method Set / action 注册 / actionRisks 声明
// (bridge 运行时行为靠 GD 侧 mcp_bridge.gd,TS 侧只测路由与元数据)

describe('P2-4 game_playtest method set', () => {
  it('PLAYTEST_METHODS 含 5 个确定性原语', () => {
    expect(PLAYTEST_METHODS.has('playtest.seed')).toBe(true);
    expect(PLAYTEST_METHODS.has('playtest.fixed_delta')).toBe(true);
    expect(PLAYTEST_METHODS.has('playtest.snapshot')).toBe(true);
    expect(PLAYTEST_METHODS.has('playtest.restore')).toBe(true);
    expect(PLAYTEST_METHODS.has('playtest.step')).toBe(true);
    expect(PLAYTEST_METHODS.size).toBe(5);
  });

  it('playtest.seed/fixed_delta/step 与 snapshot/restore 命名一致性(点分)', () => {
    for (const m of PLAYTEST_METHODS) {
      expect(m).toMatch(/^playtest\.[a-z_]+$/);
    }
  });
});

describe('P2-4 game_playtest tool registration', () => {
  const tools = getToolDefinitions();
  const tool = tools[0];

  it('action enum 含 game_playtest', () => {
    expect(tool.inputSchema.properties.action.enum).toContain('game_playtest');
  });

  it('method 描述含 playtest 5 原语', () => {
    const desc = tool.inputSchema.properties.method.description;
    expect(desc).toContain('playtest.seed');
    expect(desc).toContain('playtest.fixed_delta');
    expect(desc).toContain('playtest.step');
    expect(desc).toContain('playtest.snapshot');
    expect(desc).toContain('playtest.restore');
  });

  it('工具描述含 P2-4 确定性 playtest', () => {
    expect(tool.description).toContain('deterministic playtest');
    expect(tool.description).toContain('game_playtest');
  });
});

describe('P2-4 game_playtest actionRisks', () => {
  it('game_playtest 标为 process(改引擎时间/帧推进)', () => {
    expect(TOOL_META.game.actionRisks?.game_playtest).toBe('process');
  });

  it('install_override/uninstall_override 标为 write(P2-1 同批)', () => {
    expect(TOOL_META.game.actionRisks?.install_override).toBe('write');
    expect(TOOL_META.game.actionRisks?.uninstall_override).toBe('write');
  });
});

// ── G-3 (:942② + 批D移交): step_until TS 超时竞态 + wall_budget 描述漂移 ──────
// 根因: 原 timeout = min(max(raw,30000),60000) 与 GD 侧 idle 60s 同界——wall_budget_ms=60000
// 时 TS 先到期销毁常驻 socket(响应丢失+订阅断线)。批 D 已把 GD 侧 wall_budget clamp 50s,
// TS 侧对齐: timeout = wall_budget + 5s 余量(不再先到期),描述同步 1000-50000。
describe('G-3: computePlaytestTimeoutMs — step_until TS 超时 = wall_budget + 5s 余量', () => {
  it('step_until wall_budget=60000(超界入参) → TS timeout ≥ 65000(不与 GD idle 60s 同界)', () => {
    expect(computePlaytestTimeoutMs('playtest.step_until', 60000, 10000)).toBeGreaterThanOrEqual(65000);
  });

  it('step_until wall_budget=50000 → TS timeout 55000', () => {
    expect(computePlaytestTimeoutMs('playtest.step_until', 50000, 10000)).toBe(55000);
  });

  it('step_until wall_budget 未传 → 默认 30000 + 5s = 35000', () => {
    expect(computePlaytestTimeoutMs('playtest.step_until', undefined, 10000)).toBe(35000);
  });

  it('step_until wall_budget 无效值("abc"/null) → 回退默认 35000', () => {
    expect(computePlaytestTimeoutMs('playtest.step_until', 'abc', 10000)).toBe(35000);
    expect(computePlaytestTimeoutMs('playtest.step_until', null, 10000)).toBe(35000);
  });

  it('step_until 用户显式 timeout 更长时取 max(尊重显式意图)', () => {
    // wall=30000 → 35000;用户 raw=60000(clamp 上界) → 60000 不被 wall 公式压短
    expect(computePlaytestTimeoutMs('playtest.step_until', 30000, 60000)).toBe(60000);
  });

  it('非 step_until method 保持原行为: step 走 max(raw,30000) cap 60000;seed 同步原样', () => {
    expect(computePlaytestTimeoutMs('playtest.step', 50000, 10000)).toBe(30000);
    expect(computePlaytestTimeoutMs('playtest.step', 50000, 45000)).toBe(45000);
    expect(computePlaytestTimeoutMs('playtest.seed', undefined, 10000)).toBe(10000);
  });

  it('wall_budget_ms 描述对齐 GD 侧 clamp(1000-50000,批 D 移交描述漂移)', () => {
    const tools = getToolDefinitions();
    const paramsDesc = (tools[0].inputSchema.properties.params as { description: string }).description;
    expect(paramsDesc).toContain('wall_budget_ms?:int(1000-50000, default 30000)');
    expect(paramsDesc).not.toContain('1000-60000');
  });
});
