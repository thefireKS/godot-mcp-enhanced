// test/ui-import-single.test.ts
// PR-4 Task 1 TDD:ui_import_prototype 单 spawn 合成脚本模板(spec §6)结构契约。
// 三段组装:①genUiBuildLayoutScript(persist=true) 尾部 layout_built+_mcp_done 替换为
// call_deferred("_measure_go");②genUiMeasureScript 输出自 'var _frames := 0' 截取并
// 剥离 _initialize(其 _mcp_load_scene 是裸 load,同进程二载命中 ResourceCache 旧实例
// ——spec B-1,reload 分支由 _measure_go 自带);③追加 _measure_go(引用全部前向声明,
// 规避 GDScript 前向引用风险——buildThenMeasure 先例实证的结构)。
import { describe, it, expect } from 'vitest';
import { genUiImportSingleScript } from '../src/tools/ui/ui-import-single.js';
import type { UiNodeSpec } from '../src/tools/ui/types.js';

const TREE: UiNodeSpec = {
  type: 'Panel', name: '_PrototypeRoot', rect: { x: 0, y: 0, w: 800, h: 600 },
  children: [
    { type: 'Label', name: 'Title', rect: { x: 10, y: 20, w: 200, h: 24 } },
  ],
};

describe('genUiImportSingleScript 组装结构契约', () => {
  const script = genUiImportSingleScript('res://scene.tscn', '/root', TREE, { w: 800, h: 600 });

  it('build 尾部替换:含 call_deferred("_measure_go"),不含 layout_built 输出', () => {
    expect(script).toContain('call_deferred("_measure_go")');
    expect(script).not.toContain('"layout_built"');
  });

  it('reload 分支带 CACHE_MODE_IGNORE(spec B-1 核心契约)', () => {
    expect(script).toContain('ResourceLoader.load');
    expect(script).toContain('ResourceLoader.CACHE_MODE_IGNORE');
  });

  it('persist 块与 measure 核心均在(单进程合成完整链)', () => {
    expect(script).toContain('ResourceSaver.save');           // build 侧原子写
    expect(script).toContain('process_frame.connect');        // measure 侧稳定等待
    expect(script).toContain('_on_measure_frame');
    expect(script).toContain('_all_slots');                    // PR-2 style 读回核心
  });

  it('函数零重复定义(SCENE_TREE_HEADER 只一份,measure _initialize 已剥离)', () => {
    expect(script.match(/func _initialize\(\):/g)).toHaveLength(1);
    expect(script.match(/func _mcp_load_scene\(/g)).toHaveLength(1);
    expect(script.match(/func _measure_go\(\)/g)).toHaveLength(1);
    expect(script.match(/func _on_measure_frame\(/g)).toHaveLength(1);
  });

  it('reload 错误信息内嵌恢复语义(persist 先于 measure,spec §6)', () => {
    expect(script).toContain('Scene reload failed (post-persist)');
    expect(script).toContain('already persisted, you can re-run ui_measure_layout');
  });

  it('np 定位段按 parentPath 注入(_mcp_get_scene_node,与 measure _initialize 同款)', () => {
    expect(script).toContain('_mcp_get_scene_node("/root")');
    const nonRoot = genUiImportSingleScript('res://scene.tscn', '/Main/HUD', TREE, { w: 800, h: 600 });
    expect(nonRoot).toContain('_mcp_get_scene_node("/Main/HUD")');
  });

  // Task 2(debt-cleanup-20260818):sp/np 内嵌 reload load/npLookup/错误信息均为纯字面量
  // (不参与 % 格式化),gdEscape 的 % 双写会静默改写路径 → reload 加载失败;须走
  // escapeForGdLiteral。覆盖链:①段 build persist _full + :735;③段 reload load。
  it('T2: scenePath/parentPath 含 % 不双写——reload load 与 npLookup 纯字面量正确', () => {
    const s = genUiImportSingleScript('res://a%b.tscn', '/root/%HUD', TREE, { w: 800, h: 600 });
    expect(s).toContain('ResourceLoader.load("res://a%b.tscn"');
    expect(s).toContain('var _full := "res://a%b.tscn"');
    expect(s).toContain('_mcp_get_scene_node("/root/%HUD")');
    expect(s).not.toContain('a%%b');
    expect(s).not.toContain('%%HUD');
  });
});

describe('genUiImportSingleScript styleExpect 注入', () => {
  it('期望清单非空 → _measure_go 内嵌 JSON.parse_string + path 键', () => {
    const s = genUiImportSingleScript('res://scene.tscn', '/root', TREE, { w: 800, h: 600 },
      [{ path: '_PrototypeRoot', slots: ['panel'] }]);
    expect(s).toContain('JSON.parse_string');
    expect(s).toContain('_PrototypeRoot');
    // 注入位置在 _measure_go(非 build 段):parse 行出现在 _measure_go 之后
    expect(s.indexOf('JSON.parse_string')).toBeGreaterThan(s.indexOf('func _measure_go'));
  });

  it('期望清单空 → 不注入 JSON.parse_string(_style_expect 保持空字典)', () => {
    const s = genUiImportSingleScript('res://scene.tscn', '/root', TREE, { w: 800, h: 600 }, undefined);
    expect(s).not.toContain('JSON.parse_string');
  });
});
