import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { handleTool } from '../../src/tools/project.js';
import type { ToolContext } from '../../src/types.js';

// 最小 ToolContext mock（setup_project_rules 只用 parseGodotConfig）
function makeCtx(): ToolContext {
  return {
    parseGodotConfig: ((raw: string) => {
      // 极简解析：把 [application] config/name 提出来
      const m = raw.match(/config\/name="([^"]+)"/);
      return { application: { 'config/name': m?.[1] ?? 'Test' } } as never;
    }) as never,
  } as unknown as ToolContext;
}

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gmc-agents-'));
  writeFileSync(join(dir, 'project.godot'), '[application]\nconfig/name="TestGame"\nconfig/features=PackedStringArray("4.6")\n');
  return dir;
}

describe('setup_project_rules AGENTS.md 双写', () => {
  let project: string;
  beforeEach(() => { project = makeProject(); });
  afterEach(() => { rmSync(project, { recursive: true, force: true }); });

  it('默认（agents_md 未传）生成 AGENTS.md + CLAUDE.md', async () => {
    // hooks=false 避免写 .claude/settings.json 干扰
    const res = await handleTool('project', { action: 'setup_project_rules', project_path: project, hooks: false }, makeCtx());
    const text = JSON.parse((res as { content: Array<{ text: string }> }).content[0]!.text);
    expect(text.actions.some((a: string) => a.includes('AGENTS.md'))).toBe(true);
    expect(existsSync(join(project, 'AGENTS.md'))).toBe(true);
    expect(existsSync(join(project, 'CLAUDE.md'))).toBe(true);
  });

  it('agents_md=false 不生成 AGENTS.md', async () => {
    await handleTool('project', { action: 'setup_project_rules', project_path: project, hooks: false, agents_md: false }, makeCtx());
    expect(existsSync(join(project, 'AGENTS.md'))).toBe(false);
    expect(existsSync(join(project, 'CLAUDE.md'))).toBe(true);
  });

  it('AGENTS.md 含项目名 H1 + 引擎特性段', async () => {
    await handleTool('project', { action: 'setup_project_rules', project_path: project, hooks: false }, makeCtx());
    const md = readFileSync(join(project, 'AGENTS.md'), 'utf-8');
    expect(md).toContain('# TestGame');
    expect(md).toContain('## Godot MCP engine quirks');
  });

  it('幂等：再次运行不破坏用户段（保留用户自建 ## 段）', async () => {
    await handleTool('project', { action: 'setup_project_rules', project_path: project, hooks: false }, makeCtx());
    // 用户手动加一段
    const before = readFileSync(join(project, 'AGENTS.md'), 'utf-8');
    writeFileSync(join(project, 'AGENTS.md'), before + '\n## 我的自定义段\n\n保留我\n');
    await handleTool('project', { action: 'setup_project_rules', project_path: project, hooks: false, force: true }, makeCtx());
    const after = readFileSync(join(project, 'AGENTS.md'), 'utf-8');
    expect(after).toContain('## 我的自定义段');
    expect(after).toContain('保留我');
  });
});
