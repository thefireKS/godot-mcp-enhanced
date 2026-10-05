// M6 (2026-06-23): write_script 创建含 class_name 的 .gd 后自动触发 --import 重建 cache。
// 根因:ASSET_SCAN_DIRS=['assets','scenes','scripts'] 不扫 autoload/combat/data 等自定义目录,
// needsImport 漏检 → execute_gdscript 不 warm → 新 class_name "Identifier not declared"。
import { expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Mock import-check 避免 --import 真实 spawn godot
vi.mock('../src/tools/import-check.js', () => ({
  runImport: vi.fn().mockResolvedValue(undefined),
  needsImport: () => false,
  resetImportCache: () => {},
}));

describe('write_script class_name import (M6)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mcp-m6-'));
    writeFileSync(join(tmpDir, 'project.godot'), '[application]\nconfig/name="t"\nconfig/features=PackedStringArray("4.6")\n');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('triggers runImport when .gd contains class_name (custom dir, not in ASSET_SCAN_DIRS)', async () => {
    const { handleTool } = await import('../src/tools/script.js');
    const { runImport } = await import('../src/tools/import-check.js');
    runImport.mockClear();

    const ctx = { findGodot: async () => '/fake/godot' };
    const res = await handleTool('script', {
      action: 'write_script',
      project_path: tmpDir,
      script_path: 'autoload/player_data.gd',
      content: 'class_name PlayerData\nextends RefCounted\n\nvar hp: int = 100\n',
    }, ctx);

    expect(runImport).toHaveBeenCalledTimes(1);
    expect(runImport).toHaveBeenCalledWith(tmpDir, '/fake/godot', 30_000);
    const text = res.content[0].text;
    expect(text).toContain("class_name 'PlayerData'");
    expect(text).toContain('--import');
  });

  it('does not trigger runImport when .gd has no class_name', async () => {
    const { handleTool } = await import('../src/tools/script.js');
    const { runImport } = await import('../src/tools/import-check.js');
    runImport.mockClear();

    const ctx = { findGodot: async () => '/fake/godot' };
    await handleTool('script', {
      action: 'write_script',
      project_path: tmpDir,
      script_path: 'scripts/no_class.gd',
      content: 'extends Node\n\nfunc _ready():\n\tpass\n',
    }, ctx);

    expect(runImport).not.toHaveBeenCalled();
  });

  it('does not trigger runImport for non-.gd files', async () => {
    const { handleTool } = await import('../src/tools/script.js');
    const { runImport } = await import('../src/tools/import-check.js');
    runImport.mockClear();

    const ctx = { findGodot: async () => '/fake/godot' };
    await handleTool('script', {
      action: 'write_script',
      project_path: tmpDir,
      script_path: 'README.md',
      content: '# class_name InComment\n',
    }, ctx);

    expect(runImport).not.toHaveBeenCalled();
  });

  it('still succeeds (with hint) when runImport throws', async () => {
    const { handleTool } = await import('../src/tools/script.js');
    const { runImport } = await import('../src/tools/import-check.js');
    runImport.mockRejectedValueOnce(new Error('godot not found'));

    const ctx = { findGodot: async () => '/fake/godot' };
    const res = await handleTool('script', {
      action: 'write_script',
      project_path: tmpDir,
      script_path: 'autoload/x.gd',
      content: 'class_name X\nextends RefCounted\n',
    }, ctx);

    expect(res.isError).toBeFalsy();
    const text = res.content[0].text;
    expect(text).toContain('the automatic --import failed');
    expect(text).toContain('manually');
  });
});

// ─── edit_script class_name import (Imp-8, Q-3) ──────────────────────────────
// 补 edit_script 三调用点的 ensureClassNameImport 测试(Q-3):原文件只覆盖 write_script。
// ensureClassNameImport 触发条件:编辑后有 class_name 且与编辑前不同(新增或改名)。
// auto_validate:false 跳过 validateAndRevert(否则真实 spawn /fake/godot 干扰);
// ensureClassNameImport 内部自调 ctx.findGodot() → mock runImport,不受 auto_validate 影响。
describe('edit_script class_name import (Imp-8, Q-3)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mcp-imp8-'));
    writeFileSync(join(tmpDir, 'project.godot'), '[application]\nconfig/name="t"\nconfig/features=PackedStringArray("4.6")\n');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const makeCtx = () => ({ findGodot: async () => '/fake/godot' });

  it('调用点1 search_and_replace occurrence=0(全部): 新增 class_name 触发 import', async () => {
    const { handleTool } = await import('../src/tools/script.js');
    const { runImport } = await import('../src/tools/import-check.js');
    runImport.mockClear();
    writeFileSync(join(tmpDir, 'weapon.gd'), 'extends RefCounted\n\nvar dmg: int = 10\n');

    await handleTool('script', {
      action: 'edit_script',
      project_path: tmpDir,
      script_path: 'weapon.gd',
      auto_validate: false,
      search_and_replace: { search: 'extends RefCounted', replace: 'class_name Weapon\nextends RefCounted', occurrence: 0 },
    }, makeCtx());

    expect(runImport).toHaveBeenCalledTimes(1);
    expect(runImport).toHaveBeenCalledWith(tmpDir, '/fake/godot', 30_000);
  });

  it('调用点2 search_and_replace occurrence=N(单次): 新增 class_name 触发 import', async () => {
    const { handleTool } = await import('../src/tools/script.js');
    const { runImport } = await import('../src/tools/import-check.js');
    runImport.mockClear();
    writeFileSync(join(tmpDir, 'armor.gd'), 'extends Node\n\nfunc foo():\n\tpass\n');

    await handleTool('script', {
      action: 'edit_script',
      project_path: tmpDir,
      script_path: 'armor.gd',
      auto_validate: false,
      search_and_replace: { search: 'extends Node', replace: 'class_name Armor\nextends Node', occurrence: 1 },
    }, makeCtx());

    expect(runImport).toHaveBeenCalledTimes(1);
  });

  it('调用点3 行号模式: 新增 class_name 触发 import', async () => {
    const { handleTool } = await import('../src/tools/script.js');
    const { runImport } = await import('../src/tools/import-check.js');
    runImport.mockClear();
    writeFileSync(join(tmpDir, 'skill.gd'), 'extends Node\n\nvar cd: int = 5\n');

    await handleTool('script', {
      action: 'edit_script',
      project_path: tmpDir,
      script_path: 'skill.gd',
      auto_validate: false,
      start_line: 1,
      end_line: 1,
      new_content: 'class_name Skill\nextends Node',
    }, makeCtx());

    expect(runImport).toHaveBeenCalledTimes(1);
  });

  it('class_name 未变化时不触发 import(避免每次 edit 都 30s import)', async () => {
    const { handleTool } = await import('../src/tools/script.js');
    const { runImport } = await import('../src/tools/import-check.js');
    runImport.mockClear();
    // 原文件已有 class_name Hero,edit 改其他部分 → before===after → 不触发
    writeFileSync(join(tmpDir, 'hero.gd'), 'class_name Hero\nextends Node\n\nvar hp: int = 100\n');

    await handleTool('script', {
      action: 'edit_script',
      project_path: tmpDir,
      script_path: 'hero.gd',
      auto_validate: false,
      search_and_replace: { search: 'var hp: int = 100', replace: 'var hp: int = 200', occurrence: 1 },
    }, makeCtx());

    expect(runImport).not.toHaveBeenCalled();
  });

  it('编辑后仍无 class_name 时不触发 import', async () => {
    const { handleTool } = await import('../src/tools/script.js');
    const { runImport } = await import('../src/tools/import-check.js');
    runImport.mockClear();
    writeFileSync(join(tmpDir, 'plain.gd'), 'extends Node\n\nvar x: int = 1\n');

    await handleTool('script', {
      action: 'edit_script',
      project_path: tmpDir,
      script_path: 'plain.gd',
      auto_validate: false,
      search_and_replace: { search: 'var x: int = 1', replace: 'var x: int = 2', occurrence: 1 },
    }, makeCtx());

    expect(runImport).not.toHaveBeenCalled();
  });
});
