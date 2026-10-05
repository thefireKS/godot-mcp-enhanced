import { describe, it, expect, vi } from 'vitest';
import { listPrompts, getPrompt, listPromptDefs, getPromptDef, resolveCompletion, handleCompletion } from '../src/prompts.js';

// mock scanFiles 避免 IO，测 resolveCompletion/handleCompletion 的 scenes 归一化逻辑
vi.mock('../src/core/file-scanner.js', () => ({
  scanFiles: vi.fn(() => [
    '/proj/scenes/main.tscn',
    '/proj/scenes/level1.tscn',
    '/proj/scenes/sub/deep.tscn',
    '/proj/other.tscn',
  ]),
  DEFAULT_SKIP_DIRS: [],
}));

describe('prompts', () => {
  it('listPrompts returns 5 templates', () => {
    const prompts = listPrompts();
    expect(prompts).toHaveLength(5);
    expect(prompts.map(p => p.name)).toContain('create_platformer');
    expect(prompts.map(p => p.name)).toContain('setup_player_controller');
    expect(prompts.map(p => p.name)).toContain('optimize_scene');
    expect(prompts.map(p => p.name)).toContain('debug_performance');
    expect(prompts.map(p => p.name)).toContain('scene_editing_strategy');
  });

  it('getPrompt returns content with injected args', async () => {
    const result = await getPrompt('create_platformer', { project_name: 'my-game', resolution: '1920x1080' });
    expect(result.messages.length).toBeGreaterThan(0);
    const text = (result.messages[0].content as any).text;
    expect(text).toContain('my-game');
    expect(text).toContain('1920x1080');
  });

  it('getPrompt uses defaults when args empty', async () => {
    const result = await getPrompt('create_platformer', {});
    const text = (result.messages[0].content as any).text;
    expect(text).toContain('platformer');
  });

  it('getPrompt throws for unknown name', async () => {
    await expect(getPrompt('nonexistent', {})).rejects.toThrow();
  });

  it('debug_performance works without args', async () => {
    const result = await getPrompt('debug_performance', {});
    const text = (result.messages[0].content as any).text;
    expect(text).toContain('Performance');
  });

  it('scene_editing_strategy returns content with operation_type', async () => {
    const result = await getPrompt('scene_editing_strategy', { operation_type: 'add_node' });
    const text = (result.messages[0].content as any).text;
    expect(text).toContain('add_node');
    expect(text).toContain('capability discovery');
    expect(text).toContain('decision tree');
    expect(text).toContain('closed-loop verification');
  });

  it('scene_editing_strategy uses default when args empty', async () => {
    const result = await getPrompt('scene_editing_strategy', {});
    const text = (result.messages[0].content as any).text;
    expect(text).toContain('general');
  });
});

describe('listPromptDefs', () => {
  it('returns all registered prompt defs', () => {
    const defs = listPromptDefs();
    expect(defs.length).toBeGreaterThanOrEqual(5);
    const names = defs.map(d => d.name);
    expect(names).toContain('create_platformer');
    expect(names).toContain('setup_player_controller');
    expect(names).toContain('optimize_scene');
    expect(names).toContain('debug_performance');
    expect(names).toContain('scene_editing_strategy');
  });

  it('each def has name and description', () => {
    for (const d of listPromptDefs()) {
      expect(typeof d.name).toBe('string');
      expect(typeof d.description).toBe('string');
    }
  });
});

describe('prompt completion', () => {
  it('getPromptDef 返回指定 prompt 定义', () => {
    const def = getPromptDef('optimize_scene');
    expect(def?.name).toBe('optimize_scene');
    expect(def?.arguments?.find(a => a.name === 'scene_path')?.completion).toEqual({ type: 'scenes' });
  });

  it('getPromptDef 未知 name → undefined', () => {
    expect(getPromptDef('nonexistent')).toBeUndefined();
  });

  it('resolveCompletion enum 过滤 prefix', async () => {
    const r = await resolveCompletion({ type: 'enum', values: ['2d', '3d'] }, '2');
    expect(r).toEqual(['2d']);
  });

  it('resolveCompletion enum 空 prefix → 全部', async () => {
    const r = await resolveCompletion({ type: 'enum', values: ['2d', '3d'] }, '');
    expect(r).toEqual(['2d', '3d']);
  });

  it('resolveCompletion scenes 归一化 res:// + 过滤 prefix', async () => {
    const r = await resolveCompletion({ type: 'scenes' }, 'res://scenes/', '/proj');
    expect(r).toEqual(['res://scenes/main.tscn', 'res://scenes/level1.tscn', 'res://scenes/sub/deep.tscn']);
  });

  it('resolveCompletion scenes 无 projectPath → 空', async () => {
    const r = await resolveCompletion({ type: 'scenes' }, '', undefined);
    expect(r).toEqual([]);
  });

  it('handleCompletion ref/prompt + enum 参数 → values', async () => {
    const r = await handleCompletion({ type: 'ref/prompt', name: 'setup_player_controller' }, { name: 'dimension', value: '' }, undefined);
    expect(r.completion.values).toEqual(['2d', '3d']);
    expect(r.completion.total).toBe(2);
    expect(r.completion.hasMore).toBe(false);
  });

  it('handleCompletion ref 非 ref/prompt → 空', async () => {
    const r = await handleCompletion({ type: 'ref/resource', name: 'x' }, { name: 'y', value: '' }, undefined);
    expect(r.completion.values).toEqual([]);
  });

  it('handleCompletion 未知 prompt / 参数无 completion → 空', async () => {
    const r1 = await handleCompletion({ type: 'ref/prompt', name: 'nonexistent' }, { name: 'x', value: '' }, undefined);
    expect(r1.completion.values).toEqual([]);
    // create_platformer.project_name 无 completion 配置
    const r2 = await handleCompletion({ type: 'ref/prompt', name: 'create_platformer' }, { name: 'project_name', value: '' }, undefined);
    expect(r2.completion.values).toEqual([]);
  });

  it('handleCompletion scenes 超 MAX → values 截断 100 + total=all.length + hasMore', async () => {
    const { scanFiles } = await import('../src/core/file-scanner.js');
    (scanFiles as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      Array.from({ length: 150 }, (_, i) => `/proj/s${i}.tscn`),
    );
    const r = await handleCompletion({ type: 'ref/prompt', name: 'optimize_scene' }, { name: 'scene_path', value: '' }, '/proj');
    expect(r.completion.values).toHaveLength(100);
    expect(r.completion.total).toBe(150);  // total=all.length 非 truncated.length（SDK :5511）
    expect(r.completion.hasMore).toBe(true);
  });

  it('handleCompletion scene_editing_strategy operation_type → enum values', async () => {
    const r = await handleCompletion(
      { type: 'ref/prompt', name: 'scene_editing_strategy' },
      { name: 'operation_type', value: '' },
      undefined,
    );
    expect(r.completion.values).toEqual(['add_node', 'edit_node', 'remove_node', 'create_scene', 'read_scene']);
    expect(r.completion.total).toBe(5);
    expect(r.completion.hasMore).toBe(false);
  });
});
