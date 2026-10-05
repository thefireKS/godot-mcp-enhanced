// 原型几何翻译器(spec: docs/superpowers/specs/2026-08-16-prototype-import-design.md §2.1/§2.2)。
// 纯函数零 Godot 依赖:proto-geometry JSON(扁平视口坐标)→ UiNodeSpec 树(相对父 rect)。
// 树最终由 genUiBuildLayoutScript 消费(锚点求解/容器壳/spacer 均由既有链路处理)。
//
// 结构口径:
// - 输出树恒有合成根 _PrototypeRoot(透明 Panel 壳,rect=viewport),顶层输入节点挂其下——
//   translateGeometry 契约要求单根 UiNodeSpec,多顶层天然支持,名字与输入清洗后 name 去重。
// - 深度 cap 10 按**最终输出树**计(合成根=depth 1),对齐 genUiBuildLayoutScript 的
//   validateUiNodeSpec(tree, 1) 语义,保证下游消费不炸。
// - flow 节点(spec 规则 5 + 需求裁定):自身保留 name/rect 成为壳 Panel(无 bg 则
//   self_modulate 透明),子层插 {HBox|VBox}Container(name+'_Flow', full_rect),flow 的
//   直接子节点丢 rect、flex.min_width/min_height 取原 rect 尺寸;孙层 rect 仍按
//   "相对其输入父原点"统一公式相对化(容器排布后位置为近似)。

import { z } from 'zod';
import { CONTROL_TYPES } from './types.js';
import type { StyleBoxFlatSpec, StyleBoxOverride, StyleBoxSlot, UiNodeSpec } from './types.js';
import type { Rect } from './anchor-solver.js';
import { flattenTargets } from './layout-diff.js';

// ─── 类型(Interface,Task 2/3 依赖) ─────────────────────────────────────────

/** CSS 侧对齐枚举 → Godot horizontal_alignment。 */
export type ProtoAlign = 'left' | 'center' | 'right';

export interface GeometryNode {
  name: string;
  rect: Rect;
  type?: string;
  text?: string;
  fontSize?: number;
  color?: string | number[];
  bg?: string | number[];
  fill?: string | number[];                                                    // PR-1:ProgressBar fill 槽色
  borderRadius?: number | { tl?: number; tr?: number; br?: number; bl?: number };  // PR-1:四角
  border?: { width: number; color: string | number[] };                        // PR-1:统一四边
  align?: ProtoAlign;
  value?: number;
  flow?: 'row' | 'column';
  justify?: 'flex-start' | 'center' | 'flex-end' | 'space-between' | 'space-around' | 'space-evenly';
  interactive?: boolean;
}

export interface PrototypeGeometry {
  viewport: { w: number; h: number };
  nodes: GeometryNode[];
}

export interface TranslateResult {
  tree: UiNodeSpec;
  warnings: string[];
  coverage: { targets: number; total_nodes: number };
  /** PR-2(spec §4.2):flow 直接子节点期望清单——path 为最终树内路径(含 _Flow
   * 容器层与 uniqueName 改名后的合成根名),rect 为输入视口绝对坐标。 */
  flow_expect: Array<{ path: string; rect: Rect }>;
}

// ─── zod schema(v4,参照 src/tools/qa/spec.ts 先例) ────────────────────────

/** [r,g,b] 值 0-255(归一在翻译层做)。 */
const Rgb255 = z.tuple([
  z.number().finite().min(0).max(255),
  z.number().finite().min(0).max(255),
  z.number().finite().min(0).max(255),
]);

/** [r,g,b,a] 值 0-1(直接用)。 */
const Rgba01 = z.tuple([
  z.number().finite().min(0).max(1),
  z.number().finite().min(0).max(1),
  z.number().finite().min(0).max(1),
  z.number().finite().min(0).max(1),
]);

/**
 * PR-1:颜色 string 分支收紧为 #rrggbb(原任意 string 在翻译层 normalizeColor 才拒)——
 * bg/color/fill/border.color 在 schema 层早拒绝,坏颜色不进翻译层;normalizeColor 的
 * 解析保留为深度防御(parse 后输入已保证格式)。
 */
const ProtoColor = z.union([z.string().regex(/^#([0-9a-fA-F]{6})$/), Rgb255, Rgba01]);

/**
 * strict:未知字段拒绝(v2 N-1 "非法输入直接拒绝"精神)——AI 生产者拼错字段名
 * (如 font-size)时早暴露,不静默丢字段导致翻译结果偏差。
 */
const NodeSchema = z.strictObject({
  name: z.string().min(1),
  rect: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
    w: z.number().finite().positive(),
    h: z.number().finite().positive(),
  }),
  type: z.string().optional(),
  text: z.string().optional(),
  fontSize: z.number().finite().positive().optional(),
  color: ProtoColor.optional(),
  bg: ProtoColor.optional(),
  fill: ProtoColor.optional(),
  borderRadius: z.union([
    z.number().finite().min(0),
    z.strictObject({
      tl: z.number().finite().min(0).optional(),
      tr: z.number().finite().min(0).optional(),
      br: z.number().finite().min(0).optional(),
      bl: z.number().finite().min(0).optional(),
    }),
  ]).optional(),
  border: z.strictObject({
    width: z.number().finite().min(0),
    color: ProtoColor,
  }).optional(),
  align: z.enum(['left', 'center', 'right']).optional(),
  value: z.number().finite().min(0).max(1).optional(),
  flow: z.enum(['row', 'column']).optional(),
  justify: z.enum(['flex-start', 'center', 'flex-end', 'space-between', 'space-around', 'space-evenly']).optional(),
  interactive: z.boolean().optional(),
});

const GeometrySchema = z.strictObject({
  viewport: z.object({
    w: z.number().finite().positive(),
    h: z.number().finite().positive(),
  }),
  nodes: z.array(NodeSchema).max(500),
});

export function parseGeometry(raw: unknown): PrototypeGeometry {
  const r = GeometrySchema.safeParse(raw);
  if (!r.success) {
    const detail = r.error.issues
      .map(i => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new Error(`INVALID_PARAMS: geometry schema validation failed: ${detail}`);
  }
  return r.data;
}

// ─── 建树(容差 1px) ────────────────────────────────────────────────────────

const TOL = 1;
const MAX_NODES = 500;
const MAX_DEPTH = 10; // 与 ui-layout.ts MAX_NESTING_DEPTH 对齐(最终树根=1)
export const ROOT_NAME = '_PrototypeRoot';

/** 包含判定(需求裁定公式,容差 1px)。 */
function contains(a: Rect, b: Rect): boolean {
  return a.x - TOL <= b.x && a.y - TOL <= b.y
    && a.x + a.w + TOL >= b.x + b.w && a.y + a.h + TOL >= b.y + b.h;
}

/** 各边差 ≤1px 的"近似相等 rect"(互含且不可区分父子 → 报错)。 */
function rectNearEqual(a: Rect, b: Rect): boolean {
  return Math.abs(a.x - b.x) <= TOL && Math.abs(a.y - b.y) <= TOL
    && Math.abs(a.w - b.w) <= TOL && Math.abs(a.h - b.h) <= TOL;
}

/** 建树工作节点:输入 spec + 清洗名 + 子列表。 */
interface WorkNode {
  spec: GeometryNode;
  cleanName: string;
  children: WorkNode[];
}

function buildTree(geo: PrototypeGeometry, cleanNames: string[]): WorkNode[] {
  const nodes = geo.nodes;
  const rects = nodes.map(nd => nd.rect);

  // O(n²) 两两校验:包含 / 容差相离 / 近似相等与交叉 → INVALID_PARAMS。
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = rects[i]!, b = rects[j]!;
      const ab = contains(a, b), ba = contains(b, a);
      if (ab && ba && rectNearEqual(a, b)) {
        throw new Error(
          `INVALID_PARAMS: nodes "${nodes[i]!.name}" and "${nodes[j]!.name}" have nearly equal rects (mutually containing, each edge within 1px), parent/child can't be determined`);
      }
      if (ab || ba) continue;
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (ox > TOL && oy > TOL) {
        throw new Error(
          `INVALID_PARAMS: nodes "${nodes[i]!.name}" and "${nodes[j]!.name}" have crossing rects (neither contains the other, overlap ${ox}x${oy}px)`);
      }
    }
  }

  // 每节点父 = 包含它的最小面积节点;无 → 顶层(挂合成根)。
  // 容差互含对(nearEqual 已拦截"近似相等",但边差 1~2px 的互含仍可能):仅大面积方
  // 作父候选,避免双向挂成环(实测:相邻层差 1px 的嵌套链会触发,如 (0,0,200,100) ⊂ (1,1,198,98) 容差互含)。
  const work: WorkNode[] = nodes.map((spec, i) => ({ spec, cleanName: cleanNames[i]!, children: [] }));
  const area = (r: Rect) => r.w * r.h;
  const parentOf = new Map<WorkNode, WorkNode>();
  for (let i = 0; i < work.length; i++) {
    let best: WorkNode | null = null;
    let bestArea = Infinity;
    for (let j = 0; j < work.length; j++) {
      if (i === j) continue;
      if (!contains(rects[j]!, rects[i]!)) continue;
      if (contains(rects[i]!, rects[j]!) && area(rects[j]!) <= area(rects[i]!)) continue;
      if (area(rects[j]!) < bestArea) {
        best = work[j]!;
        bestArea = area(rects[j]!);
      }
    }
    if (best) {
      best.children.push(work[i]!);
      parentOf.set(work[i]!, best);
    }
  }
  return work.filter(w => !parentOf.has(w));
}

// ─── 颜色归一 ──────────────────────────────────────────────────────────────

/** #rrggbb / [r,g,b]0-255 / [r,g,b,a]0-1 → [r,g,b,a] 0-1(值域已由 zod 保证)。 */
export function normalizeColor(c: string | number[], field: string, name: string): [number, number, number, number] {
  if (typeof c === 'string') {
    const m = /^#([0-9a-fA-F]{6})$/.exec(c);
    if (!m) throw new Error(`INVALID_PARAMS: ${field} "${c}" of node "${name}" can't be parsed (only #rrggbb / [r,g,b] 0-255 / [r,g,b,a] 0-1)`);
    const v = parseInt(m[1]!, 16);
    return [(v >> 16 & 255) / 255, (v >> 8 & 255) / 255, (v & 255) / 255, 1];
  }
  if (c.length === 3) return [c[0]! / 255, c[1]! / 255, c[2]! / 255, 1];
  return [c[0]!, c[1]!, c[2]!, c[3]!];
}

// ─── 规则实现 ──────────────────────────────────────────────────────────────

const ALIGN_MAP: Record<ProtoAlign, number> = { left: 0, center: 1, right: 2 };

/**
 * Godot 4.7 默认主题 ProgressBar 最小高度(px)——默认主题 stylebox 的最小高把
 * Control.minimum_size 顶到该值,rect.h 更小会被引擎钳制(clamp)。
 * 实测来源:2026-08-16 ui_import_prototype 集成验收,RTS HUD fixture HpBar
 * rect.h=16 落地实测 27px(Godot_v4.7.1-stable_win64 headless,dh=+11)。
 * 2026-08-17 Task 4 三组合实测补充:stylebox override 只降下限不除钳制——
 * h=16 落地值 无 override/bg-only/fill-only/bg+fill → 27/23/27/23(全被钳)。
 */
export const PROGRESS_BAR_MIN_HEIGHT = 27;

/** 规则 1/11:显式 type(白名单)> flow(壳 Panel,容器类型在 _Flow 层)> value > interactive+text > text > Panel。 */
function inferType(nd: GeometryNode, warnings: string[]): string {
  if (nd.type !== undefined) {
    if ((CONTROL_TYPES as readonly string[]).includes(nd.type)) return nd.type;
    warnings.push(`node "${nd.name}": non-whitelisted type "${nd.type}" downgraded to Panel`);
    return 'Panel';
  }
  if (nd.flow !== undefined) return 'Panel';
  if (nd.value !== undefined) return 'ProgressBar';
  if (nd.interactive === true && nd.text !== undefined) return 'Button';
  if (nd.text !== undefined) return 'Label';
  return 'Panel';
}

/** PR-1 规则:bg/border/radius → stylebox theme override 槽位(Godot 4.7 序列化名
 * theme_override_styles/<slot>);undefined = 控件无映射槽(spec §3.4)。 */
export function styleboxSlotFor(type: string): StyleBoxSlot | undefined {
  switch (type) {
    case 'Panel': return 'panel';
    case 'ProgressBar': return 'background';
    case 'Button':
    case 'Label': return 'normal';
    default: return undefined;
  }
}

/** 在 taken 集合内生成唯一名(合成根与 _Flow 容器与输入清洗名隔离)。 */
function uniqueName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) { taken.add(base); return base; }
  let i = 2;
  while (taken.has(`${base}${i}`)) i++;
  const nm = `${base}${i}`;
  taken.add(nm);
  return nm;
}

/** 单节点 → UiNodeSpec(规则 2/3/4/6/7/8/9/10);flow 结构(规则 5)在此展开。 */
function buildSpec(
  node: WorkNode,
  parentAbs: { x: number; y: number },
  warnings: string[],
  taken: Set<string>,
  depth: number,
  pathPrefix: string,
  flowExpect: Array<{ path: string; rect: Rect }>,
): UiNodeSpec {
  const nd = node.spec;
  if (depth > MAX_DEPTH) {
    throw new Error(`INVALID_PARAMS: nesting depth exceeds ${MAX_DEPTH} (counting the synthetic root "${ROOT_NAME}" in the final tree), at node "${node.cleanName}"`);
  }

  const abs = nd.rect;
  const rel: Rect = { x: abs.x - parentAbs.x, y: abs.y - parentAbs.y, w: abs.w, h: abs.h };
  const type = inferType(nd, warnings);
  const props: Record<string, unknown> = {};

  if (nd.text !== undefined) props.text = nd.text;
  if (type === 'ProgressBar' && nd.value !== undefined) {
    // proto value 是 0-1 比例(spec §2.1),Godot ProgressBar 默认 max=100 → 同步设 0-1 量程
    props.min_value = 0;
    props.max_value = 1;
    props.value = nd.value;
  }
  if (nd.fontSize !== undefined) {
    props['theme_override_font_sizes/font_size'] = nd.fontSize;
    if (rel.h < nd.fontSize * 1.5) {
      warnings.push(`node "${node.cleanName}": rect.h=${rel.h} < fontSize*1.5=${nd.fontSize * 1.5}, may be clamped by the font's minimum line height`);
    }
  }
  // PR-1 规则 9v2:样式三件套 → StyleBoxFlat(modulate 近似通道删除)。
  // (规则 7 曾依赖本段产出的 styleboxes 变量做条件预警,2026-08-17 实测后恢复无条件,不再依赖。)
  const hasBg = nd.bg !== undefined;
  const hasBorderish = nd.border !== undefined || nd.borderRadius !== undefined;
  const hasFill = nd.fill !== undefined;
  const slot = styleboxSlotFor(type);
  let styleboxes: StyleBoxOverride[] | undefined;
  if (hasBg || hasBorderish || hasFill) {
    const box: StyleBoxFlatSpec = {};
    if (hasBg) {
      box.bg_color = normalizeColor(nd.bg!, 'bg', nd.name);
    } else if (hasBorderish) {
      box.draw_center = false; // spec I-2:CSS「有边框无背景」是透明底,引擎默认灰底+draw_center=true 会翻转
    }
    if (nd.borderRadius !== undefined) box.corner_radius = nd.borderRadius;
    if (nd.border !== undefined) {
      box.border_width = nd.border.width;
      box.border_color = normalizeColor(nd.border.color, 'border.color', nd.name);
    }
    if (slot !== undefined) {
      const overrides: StyleBoxOverride[] = [];
      // 仅 bg/border 至少其一才产主槽 override:空 StyleBoxFlat 覆盖控件默认主题样式
      // (行为翻转);fill-only 的非 ProgressBar 按「fill 仅 ProgressBar」warning 完全忽略。
      if (hasBg || hasBorderish) overrides.push({ slot, box });
      if (hasFill && type === 'ProgressBar') {
        overrides.push({ slot: 'fill', box: { bg_color: normalizeColor(nd.fill!, 'fill', nd.name) } });
      }
      if (overrides.length > 0) styleboxes = overrides;
    } else {
      warnings.push(`node "${node.cleanName}" (${type}): this control has no style slot for bg/fill/border, ignored (use Panel/Button/Label/ProgressBar or wrap it in a Panel)`);
    }
    if (hasFill && type !== 'ProgressBar') {
      // PR-2 顺手项 3/4(PR-1 终审转来):fill-only(无 bg/border)时不产任何 override
      // 且推断布局壳的透明壳被阻断 → 默认主题渲染。Panel 系是灰底(Label 默认透明),
      // 显式声明让 AI 可见;fill+bg 时有 override 不灰底,不发灰底措辞。
      if (type === 'Panel' && !hasBg && !hasBorderish) {
        warnings.push(`node "${node.cleanName}": fill is only supported on ProgressBar, ignored; and with no bg/border → no stylebox override and no transparent shell (inferred layout shell), it will render with the default theme's grey background — give bg explicitly if it should have a colour`);
      } else {
        warnings.push(`node "${node.cleanName}": fill is only supported on ProgressBar, ignored`);
      }
    }
  } else if (nd.flow !== undefined || (nd.type === undefined && nd.text === undefined && nd.value === undefined)) {
    // 规则 4(final review I-1 收窄):只有**推断为布局壳 Panel**才设透明壳;禁 modulate(级联陷阱)。
    props.self_modulate = [1, 1, 1, 0];
    warnings.push(`node "${node.cleanName}" inferred as layout-only Panel and set transparent (self_modulate alpha 0); set bg or type to keep it visible`);
  } else if (nd.type !== undefined && type === 'Panel') {
    warnings.push(`node "${node.cleanName}" explicit Panel without bg renders with the Godot default theme gray panel stylebox (web prototype div is transparent by default); set bg to match the prototype or drop type to let it be inferred as a transparent layout shell`);
  }
  // 规则 7(2026-08-17 Task 4 三组合实测后恢复无条件预警):ProgressBar h<27 一律警。
  // 旧版「有 stylebox override 不预警(钳制不可静态预知)」被实测推翻——Godot 4.7.1
  // 实测 h=16 落地值:无 override→27、bg-only→23、fill-only→27、bg+fill→23,即
  // **所有组合都被钳**(override 只降下限不除钳制),带 override 且 h<27 的场景同样
  // 需要预警,文案分档说明实测数据。
  if (type === 'ProgressBar' && rel.h < PROGRESS_BAR_MIN_HEIGHT) {
    warnings.push(`node "${node.cleanName}": ProgressBar height below Godot 4.7 default theme minimum (~${PROGRESS_BAR_MIN_HEIGHT}px): will be clamped (with stylebox overrides the clamp differs — measured Godot 4.7.1: no override/bg-only/fill-only/bg+fill → 27/23/27/23px)`);
  }
  if (nd.color !== undefined) {
    props['theme_override_colors/font_color'] = normalizeColor(nd.color, 'color', nd.name);
  }
  if (nd.text !== undefined) {
    // 规则 10 + spec §2.1 "默认 center":文本节点缺省 horizontal_alignment=1
    props.horizontal_alignment = nd.align !== undefined ? ALIGN_MAP[nd.align] : 1;
  }
  if (type === 'Label') props.vertical_alignment = 1; // 规则 3

  const spec: UiNodeSpec = {
    type, name: node.cleanName, rect: rel,
    ...(Object.keys(props).length > 0 ? { properties: props } : {}),
    ...(styleboxes !== undefined ? { styleboxes } : {}),
  };

  if (nd.flow !== undefined) {
    // 规则 5:flow 壳 + _Flow 容器;直接子节点丢 rect、min_size 取原尺寸。
    // 孙层相对化基准 = 直接子节点输入 abs(统一公式 rel = child.abs − parent.abs)。
    const flowType = nd.flow === 'row' ? 'HBoxContainer' : 'VBoxContainer';
    const flowLayout: UiNodeSpec['layout'] = { direction: nd.flow };
    if (nd.justify !== undefined) flowLayout.justify = nd.justify;
    // containerName 提前提取:children 的 map 回调同步执行,若在此引用 container.name
    // 会触发 TDZ ReferenceError(const container 尚未完成初始化)。
    const containerName = uniqueName(`${node.cleanName}_Flow`, taken);
    const container: UiNodeSpec = {
      type: flowType,
      name: containerName,
      anchor_preset: 'full_rect',
      layout: flowLayout,
      children: node.children.map(c => {
        // PR-2:flow 直接子层期望(视口绝对 rect;path=前缀/本节点/_Flow/子名)。
        // push 必须先于 buildSpec 子调用(子递归可能再产嵌套 flow 条目,顺序即树序)。
        flowExpect.push({ path: `${pathPrefix}/${node.cleanName}/${containerName}/${c.cleanName}`, rect: c.spec.rect });
        const child = buildSpec(c, { x: abs.x, y: abs.y }, warnings, taken, depth + 2,
          `${pathPrefix}/${node.cleanName}/${containerName}`, flowExpect);
        delete child.rect;
        child.flex = { min_width: c.spec.rect.w, min_height: c.spec.rect.h };
        warnings.push(`flow child "${c.cleanName}": rect size mapped to flex.min_width/min_height (may be too big for HUG text cases)`);
        return child;
      }),
    };
    spec.children = [container];
    return spec;
  }

  if (node.children.length > 0) {
    spec.children = node.children.map(c => buildSpec(c, { x: abs.x, y: abs.y }, warnings, taken, depth + 1,
      `${pathPrefix}/${node.cleanName}`, flowExpect));
  }
  return spec;
}

// ─── 翻译主函数 ────────────────────────────────────────────────────────────

export function translateGeometry(geo: PrototypeGeometry): TranslateResult {
  if (geo.nodes.length > MAX_NODES) {
    throw new Error(`INVALID_PARAMS: node count ${geo.nodes.length} exceeds the limit ${MAX_NODES}`);
  }

  // 规则 12:name 清洗([a-zA-Z0-9_] 外 → _)+ 清洗后重复检测(不静默重名)。
  const cleanNames = geo.nodes.map(nd => nd.name.replace(/[^a-zA-Z0-9_]/g, '_'));
  const seen = new Map<string, string[]>();
  geo.nodes.forEach((nd, i) => {
    const arr = seen.get(cleanNames[i]!) ?? [];
    arr.push(nd.name);
    seen.set(cleanNames[i]!, arr);
  });
  for (const [clean, originals] of seen) {
    if (originals.length > 1) {
      throw new Error(`INVALID_PARAMS: duplicate name "${clean}" after cleaning (originals: ${originals.map(o => `"${o}"`).join(', ')})`);
    }
  }

  const warnings: string[] = [];
  const work = buildTree(geo, cleanNames);
  const taken = new Set(cleanNames);
  const flowExpect: Array<{ path: string; rect: Rect }> = [];

  // 合成根:透明 Panel 壳,rect=viewport(视口原点);名字与输入清洗名去重。
  const rootName = uniqueName(ROOT_NAME, taken);
  const tree: UiNodeSpec = {
    type: 'Panel',
    name: rootName,
    rect: { x: 0, y: 0, w: geo.viewport.w, h: geo.viewport.h },
    properties: { self_modulate: [1, 1, 1, 0] },
    children: work.map(w => buildSpec(w, { x: 0, y: 0 }, warnings, taken, 2, rootName, flowExpect)),
  };

  // B-2(2026-08-18 PR-2 改写):flow 直接子节点丢 rect 不受 layout_verify 覆盖——
  // 补偿防线从「screenshot diff 兜底」升级为 flow_verify 数字清单(消解 B-2 盲区)。
  const flowChildCount = countDroppedRects(work);
  if (flowChildCount > 0) {
    const coverage = { targets: flattenTargets(tree).length, total_nodes: geo.nodes.length };
    warnings.push(
      `${flowChildCount} direct flow children: not covered by layout_verify (rect dropped), covered numerically by flow_verify (expected = input viewport rect vs measured global rect after container layout, per node Δx/Δy/Δw/Δh); grandchildren are covered approximately by layout_verify (expected relative to the input parent origin, naturally offset after container layout) (verify_coverage.targets=${coverage.targets}/total_nodes=${coverage.total_nodes})`);
  }

  return { tree, warnings, coverage: { targets: flattenTargets(tree).length, total_nodes: geo.nodes.length }, flow_expect: flowExpect };
}

/** flow 节点的直接子节点总数(= 丢 rect 不进 verify 的节点数;孙层保留 rect 不计)。 */
function countDroppedRects(nodes: WorkNode[]): number {
  let count = 0;
  for (const w of nodes) {
    if (w.spec.flow !== undefined) count += w.children.length;
    count += countDroppedRects(w.children);
  }
  return count;
}
