// test/qa-spec.test.ts — QA 套件 spec 解析（正例 + 负向：非法形态必须拒绝）
import { describe, it, expect } from 'vitest';
import { parseQaSuite, extractSpecJson } from '../src/tools/qa/spec.js';

const validSuite = {
  name: 'smoke',
  project_path: 'D:/proj/demo',
  steps: [
    { type: 'input', method: 'send_key', params: { key: 'space', pressed: true }, label: '跳' },
    { type: 'wait', method: 'wait_for_property', params: { path: '/root/Root', property: 'position', value: { x: 1, y: 0, z: 0 } } },
    { type: 'assert', assert: 'node_state', path: '/root/Root', expect: { health: 100 }, tolerance: 0.01, label: '满血' },
    { type: 'screenshot' },
  ],
};

describe('parseQaSuite 正例', () => {
  it('inline 对象解析成功且 options 填默认值', () => {
    const r = parseQaSuite(validSuite);
    expect(r.ok).toBe(true);
    expect(r.suite!.steps).toHaveLength(4);
    expect(r.suite!.options.auto_install_bridge).toBe(true);
    expect(r.suite!.options.step_timeout_ms).toBe(30000);
    expect(r.suite!.options.wait_timeout_ms).toBe(10000);
    expect(r.suite!.options.run_timeout_s).toBe(600);
    expect(r.suite!.options.suite_budget_ms).toBe(300000);
    expect(r.suite!.options.continue_on_failure).toBe(false);
  });

  it('省略 options → 默认空对象解析', () => {
    const r = parseQaSuite({ name: 'x', steps: [{ type: 'sleep', ms: 200 }] });
    expect(r.ok).toBe(true);
    expect(r.suite!.options.stop_after).toBe(true);
  });

  it('裸 JSON 字符串解析', () => {
    const r = parseQaSuite(JSON.stringify(validSuite));
    expect(r.ok).toBe(true);
  });

  it('markdown ```qa-spec 围栏解析（含 info 后缀）', () => {
    const md = `# 用例\n\n说明文字\n\n\`\`\`qa-spec json\n${JSON.stringify(validSuite)}\n\`\`\`\n\n结尾\n`;
    const r = parseQaSuite(md);
    expect(r.ok).toBe(true);
    expect(r.suite!.name).toBe('smoke');
  });

  it('extractSpecJson 围栏提取', () => {
    const v = extractSpecJson('```qa-spec\n{"name":"a","steps":[]}\n```') as { name: string };
    expect(v.name).toBe('a');
  });

  it('全部 13 种 step type 均可解析', () => {
    const suite = {
      name: 'all-types',
      steps: [
        { type: 'input', method: 'send_mouse_click', params: { x: 1, y: 2 } },
        { type: 'input', method: 'send_text', params: { text: 'hi' } },
        { type: 'wait', method: 'wait_for_node', params: { path: '/root/Root' } },
        { type: 'wait_frames', frames: 5 },
        { type: 'freeze' },
        { type: 'unfreeze' },
        { type: 'step_until', conditions: [{ path: '/root/Root', property: 'x', op: '>=', value: 3 }] },
        { type: 'snapshot' },
        { type: 'restore' },
        { type: 'set', path: '/root/Root', property: 'x', value: 3 },
        { type: 'call', path: '/root/Root', method: 'get_health' },
        { type: 'assert', assert: 'screen_text', text: 'Game Over', present: false },
        { type: 'sleep', ms: 150 },
      ],
    };
    const r = parseQaSuite(suite);
    expect(r.ok).toBe(true);
    expect(r.suite!.steps).toHaveLength(13);
  });
});

describe('parseQaSuite 负向（非法必须拒绝且错误可读）', () => {
  it('空输入', () => {
    const r = parseQaSuite(undefined);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('spec is empty');
  });

  it('未知 step type', () => {
    const r = parseQaSuite({ name: 'x', steps: [{ type: 'teleport', where: 'moon' }] });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('steps.0');
  });

  it('steps 为空数组', () => {
    const r = parseQaSuite({ name: 'x', steps: [] });
    expect(r.ok).toBe(false);
  });

  it('缺 name', () => {
    const r = parseQaSuite({ steps: [{ type: 'sleep', ms: 200 }] });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('name');
  });

  it('sleep ms 超上界 10000', () => {
    const r = parseQaSuite({ name: 'x', steps: [{ type: 'sleep', ms: 99999 }] });
    expect(r.ok).toBe(false);
  });

  it('input method 不在白名单', () => {
    const r = parseQaSuite({ name: 'x', steps: [{ type: 'input', method: 'send_telepathy', params: {} }] });
    expect(r.ok).toBe(false);
  });

  it('step_until 无条件', () => {
    const r = parseQaSuite({ name: 'x', steps: [{ type: 'step_until', conditions: [] }] });
    expect(r.ok).toBe(false);
  });

  it('非 JSON 非 围栏 的字符串 → 源格式错误', () => {
    const r = parseQaSuite('就是一段普通中文');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('qa-spec');
  });

  it('围栏内 JSON 语法错误 → 源格式错误（不进 zod）', () => {
    const r = parseQaSuite('```qa-spec\n{"name": }\n```');
    expect(r.ok).toBe(false);
    expect(r.error).not.toContain('validation failed'); // 是 JSON.parse 的错误，不是 schema 错误
  });
});

describe('QA spec: watch/monitor 控制步骤 + 新断言（Task PR-1a）', () => {
  const base = { name: 's', steps: [{ type: 'input', method: 'send_key', params: { key: 'ui_accept' } }] };

  it('watch_start/watch_stop/monitor_start/monitor_stop 四控制步骤合法', () => {
    const r = parseQaSuite({
      ...base,
      steps: [
        { type: 'watch_start', node_path: '/root/Main', signal_name: 'pressed' },
        { type: 'watch_stop' },
        { type: 'monitor_start', node_path: '/root/Main/Player', properties: ['health'], interval_frames: 5 },
        { type: 'monitor_stop' },
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.suite?.steps.map(s => s.type)).toEqual(['watch_start', 'watch_stop', 'monitor_start', 'monitor_stop']);
  });

  it('watch_start 缺 signal_name → 校验失败且错误可读', () => {
    const r = parseQaSuite({ ...base, steps: [{ type: 'watch_start', node_path: '/root/Main' }] });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('signal_name');
  });

  it('monitor_start 空 properties 数组 → 校验失败', () => {
    const r = parseQaSuite({ ...base, steps: [{ type: 'monitor_start', node_path: '/root/M', properties: [] }] });
    expect(r.ok).toBe(false);
  });

  it('assert 扩展 4 值合法 + 新字段解析', () => {
    const r = parseQaSuite({
      ...base,
      steps: [
        { type: 'assert', assert: 'screenshot_diff', reference: 'D:/ref/x.png', threshold: 0.12, max_diff_ratio: 0.05 },
        { type: 'assert', assert: 'signal', min_count: 2, max_count: 5, args_match: [{ x: 1, y: 2 }] },
        { type: 'assert', assert: 'errors', kinds: ['error', 'script'], max_count: 0 },
        { type: 'assert', assert: 'monitor', property: 'fps', min: 30, monotonic: 'non_decreasing' },
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.suite?.steps[3]).toMatchObject({ assert: 'monitor', property: 'fps', monotonic: 'non_decreasing' });
  });

  it('assert 未知值仍被拒', () => {
    const r = parseQaSuite({ ...base, steps: [{ type: 'assert' as never, assert: 'nope' as never }] });
    expect(r.ok).toBe(false);
  });

  it('monotonic 非法值被拒', () => {
    const r = parseQaSuite({ ...base, steps: [{ type: 'assert', assert: 'monitor', property: 'x', monotonic: 'faster' as never }] });
    expect(r.ok).toBe(false);
  });
});
