// ui_pixel_verify 纯函数层(spec 2026-08-17-prototype-stylebox-loop-design.md §5,PR-3):
// 采样点 clamp 数学 / PNG 像素读取 / RGB 距离判定 / bg 目标收集。
// capture 编排(runPixelVerify)同文件下方,Task 2 已落地。
// 颜色语义:输入 bg 经 normalizeColor 归一为 0-1 RGBA,目标色换算 round(c*255) 进 0-255
// 空间与 PNG 采样值直接欧氏距离(Godot 2D canvas 默认不做 linear-sRGB 转换;若集成实测
// 发现系统性偏移,在 Task 4 校准并如实记录,不静默调阈值掩盖)。
import { readFileSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { PNG } from 'pngjs';
import { captureScreenshot, getBlankHint } from '../../screenshot.js';
import type { Rect } from './anchor-solver.js';
import { normalizeColor } from './prototype-import.js';
import type { PrototypeGeometry } from './prototype-import.js';

/** 采样点标识:中心 + 四角(tl/tr/br/bl)。 */
export type SamplePointId = 'center' | 'tl' | 'tr' | 'br' | 'bl';

export interface SamplePoint { id: SamplePointId; x: number; y: number }

export interface PixelSample {
  id: SamplePointId;
  x: number; y: number;                    // 实际采样坐标(编排层可能已按 PNG/viewport 比例缩放)
  rgb: [number, number, number] | null;    // 0-255;越界/读不到 → null
  distance: number | null;                 // 与 target 的 0-255 欧氏距离;rgb null 时 null
  ok: boolean;
}

export interface NodePixelResult {
  name: string;
  rect: Rect;                              // 输入视口 rect(采样基准)
  target: [number, number, number];        // 0-255
  samples: PixelSample[];
  ok: boolean;                             // 全采样点过
}

export interface BgTarget {
  name: string;
  rect: Rect;
  target: [number, number, number];
  borderRadius: number;                    // per-corner 对象已取 max
  borderWidth: number;
  /** 带 text 节点为 true(F3):文字水平居中排版,中心点必踩文字渲染/抗锯齿像素,
   *  编排层组装采样点时过滤掉 center(四角 inset>0 避开文字,仍可判)。 */
  skipCenter: boolean;
}

/** 判定容差(0-255 欧氏距离):中心严格、角点宽松(spec §5,阈值 §10.2 集成校准——
 * 2026-08-18 集成校准(css-card,真渲染):13 采样点 distance=0.0,零底噪零偏移,无需裕量)。 */
export const CENTER_TOL = 20;
export const CORNER_TOL = 60;

/**
 * 中心 + 四角内缩采样点(spec §5)。内缩量 clamp:min(borderRadius + borderWidth,
 * 短边/2 − 2)——防 borderRadius > 短边一半时角点越界;短边 < 4 时下限回落 0
 * (角点=rect 角,仍在图内,由 pixelAt 越界 null 兜底)。中心点不内缩(圆角矩形
 * 中心必在填充区内)。半开区间语义(F4,2026-08-18 集成取证):rect 覆盖像素列
 * [x, x+w)、行 [y, y+h),右/下缘最后有效像素格是 x+w−1 / y+h−1——角点右/下分量
 * 取 x+w−1−inset / y+h−1−inset(左/上分量 x+inset / y+inset 不变),否则 inset=0
 * 时角点落在覆盖区外一像素格、采到节点外背景(实测 css-card HpBar 角点 d=65.7)。
 * 坐标 floor 到整数像素格(0-indexed:奇数尺寸中心取左中像素,如 w=101 → 50;
 * Math.round 对 half 值向上取整得 51/31,与测试断言 50/30 冲突,以断言为准裁定
 * floor,整数输入下两者等价)。
 */
export function computeSamplePoints(rect: Rect, borderRadius: number, borderWidth: number): SamplePoint[] {
  const minSide = Math.min(rect.w, rect.h);
  const inset = Math.max(0, Math.min(borderRadius + borderWidth, minSide / 2 - 2));
  const cx = Math.floor(rect.x + rect.w / 2);
  const cy = Math.floor(rect.y + rect.h / 2);
  return [
    { id: 'center', x: cx, y: cy },
    { id: 'tl', x: Math.floor(rect.x + inset), y: Math.floor(rect.y + inset) },
    { id: 'tr', x: Math.floor(rect.x + rect.w - 1 - inset), y: Math.floor(rect.y + inset) },
    { id: 'br', x: Math.floor(rect.x + rect.w - 1 - inset), y: Math.floor(rect.y + rect.h - 1 - inset) },
    { id: 'bl', x: Math.floor(rect.x + inset), y: Math.floor(rect.y + rect.h - 1 - inset) },
  ];
}

/** 读 PNG(解码后 {width,height,data:RGBA Buffer})指定像素 RGB;越界返回 null。 */
export function pixelAt(png: { width: number; height: number; data: Buffer }, x: number, y: number): [number, number, number] | null {
  if (!Number.isInteger(x) || !Number.isInteger(y)) return null;
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) return null;
  const idx = (y * png.width + x) * 4;
  return [png.data[idx]!, png.data[idx + 1]!, png.data[idx + 2]!];
}

/** 0-255 空间 RGB 欧氏距离。 */
export function rgbDistance(a: [number, number, number], b: [number, number, number]): number {
  const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/**
 * 收集采样目标:输入 geometry 中带 bg 的节点(spec §5「每 bg 节点」;fill-only 不进——
 * fill 槽语义属 ProgressBar 内部渲染,非本工具首版范围)。跳过两类(诚实 skip,不伪装判定):
 * 1. 半透明 bg(alpha < 0.999):合成后采样色 ≠ bg_color,像素直判不可用;
 * 2. ProgressBar 系 bg(F2,2026-08-18 集成取证):ProgressBar 的 bg 渲染面被 fill 与
 *    百分比文字(show_percentage 默认 true,画在 bar 几何中心)覆盖,无可采样纯色区域
 *    ——bg 槽验证请依赖 style_verify 的数值 diff。
 * 带 text 节点标 skipCenter(F3):文字水平居中排版,中心点踩文字渲染像素(实测
 * css-card Title/TagChip center d≈48),由编排层过滤 center 采样点。
 * per-corner borderRadius 对象取四角 max(保守内缩)。
 * 注意:未映射控件(如 LineEdit 带 bg,规则 12)的 bg 被翻译层忽略、渲染无该色——
 * 本函数仍收集之,采样预期红;这与 build_warnings 的「样式丢失」警告互为印证,是诚实
 * 信号不是误报(实现期若发现高频误报噪声,可升级为按 styleboxSlotFor skip+reason,
 * 须同步单测)。
 */
export function collectBgTargets(geo: PrototypeGeometry): { targets: BgTarget[]; skipped: Array<{ name: string; reason: string }> } {
  const targets: BgTarget[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  for (const nd of geo.nodes) {
    if (nd.bg === undefined) continue;
    const rgba = normalizeColor(nd.bg, 'bg', nd.name);
    if (rgba[3] < 0.999) {
      skipped.push({ name: nd.name, reason: `bg alpha=${rgba[3]} (translucent): the sampled colour after compositing ≠ bg_color, a direct pixel check is not possible` });
      continue;
    }
    // type/value 两分支对齐翻译器 inferType 推断,fill 分支为保守扩展
    // (fill-only+bg 节点翻译后是可采样 Panel bg,保守跳过只少判不误绿)
    if (nd.type === 'ProgressBar' || nd.value !== undefined || nd.fill !== undefined) {
      skipped.push({ name: nd.name, reason: 'A ProgressBar\'s bg surface is covered by the fill and the percentage text, no solid area to sample — rely on style_verify\'s numeric check for the bg slot' });
      continue;
    }
    const r = typeof nd.borderRadius === 'number' ? nd.borderRadius
      : Math.max(nd.borderRadius?.tl ?? 0, nd.borderRadius?.tr ?? 0, nd.borderRadius?.br ?? 0, nd.borderRadius?.bl ?? 0);
    targets.push({
      name: nd.name,
      rect: nd.rect,
      target: [Math.round(rgba[0] * 255), Math.round(rgba[1] * 255), Math.round(rgba[2] * 255)],
      borderRadius: r,
      borderWidth: nd.border?.width ?? 0,
      skipCenter: nd.text !== undefined && nd.text !== '',
    });
  }
  return { targets, skipped };
}

/**
 * 逐点判定组装 NodePixelResult。points/samples 由编排层成对给出(samples 的 rgb 已
 * 含越界 null);中心点用 CENTER_TOL、角点用 CORNER_TOL;rgb null(越界/读不到)
 * 记 ok:false + distance:null——越界采样点是问题不是噪声,必须红。
 */
export function judgeNode(
  name: string, rect: Rect, target: [number, number, number],
  points: SamplePoint[], samples: Array<{ x: number; y: number; rgb: [number, number, number] | null }>,
): NodePixelResult {
  const out: PixelSample[] = points.map((p, i) => {
    const s = samples[i]!;
    const distance = s.rgb === null ? null : rgbDistance(s.rgb, target);
    const tol = p.id === 'center' ? CENTER_TOL : CORNER_TOL;
    return { id: p.id, x: s.x, y: s.y, rgb: s.rgb, distance, ok: distance !== null && distance <= tol };
  });
  return { name, rect, target, samples: out, ok: out.every(s => s.ok) };
}

// ─── capture 编排(Task 2)──────────────────────────────────────────────────

/** BLANK 双条件拦截的图像侧证据(F1):8x8=64 点网格采样,全部 RGB 相同才判均匀。
 *  与 stdout BLANK_DETECTED 独立——两证据同时成立才拦截(capture 层步进采样在
 *  800x600 等视口退化单列误报,真渲染内容丰富不均匀,不拦)。 */
function isUniformImage(png: { width: number; height: number; data: Buffer }): boolean {
  const first = pixelAt(png, 0, 0);
  if (first === null) return true;  // 读不到首像素(异常空图)——按均匀处理,拦截侧保守
  for (let gy = 0; gy < 8; gy++) {
    for (let gx = 0; gx < 8; gx++) {
      const x = Math.floor((gx + 0.5) * png.width / 8);
      const y = Math.floor((gy + 0.5) * png.height / 8);
      const rgb = pixelAt(png, x, y);
      if (rgb === null || rgb[0] !== first[0] || rgb[1] !== first[1] || rgb[2] !== first[2]) return false;
    }
  }
  return true;
}

export interface PixelVerifySummary {
  nodes: NodePixelResult[];
  pass: number;
  fail: number;
  skipped: Array<{ name: string; reason: string }>;
  viewport: { w: number; h: number };
  image: { width: number; height: number; scaled: boolean; cleaned_up: boolean };
  tolerances: { center: number; corner: number };
  note: string;
}

/** 绝对路径 → res:// 形式(screenshot_capture.gd 的 ResourceLoader.exists/load 需要)。 */
export function toResPath(projectPath: string, absPath: string): string {
  return 'res://' + relative(projectPath, absPath).replace(/\\/g, '/');
}

const PIXEL_VERIFY_NOTE = 'Final-check placement (spec §5): run once only after geometry layout_verify + style_verify are all green '
  + '(each capture opens a window and takes seconds; running it every iteration would wreck the convergence loop);'
  + 'sampling reference = the input geometry\'s viewport rect, the mount parent must be origin-aligned (same constraint as layout_verify);'
  + 'the actual render position of flow children is decided by container layout; its deviation from the input rect is exactly what flow_verify converges '
  + '(when the final-check precondition is all green, the deviation is within tolerance; if sampling is red, check flow_verify first — unconverged position and wrong colour both show as red)';

/**
 * ui_pixel_verify 编排:collectBgTargets → captureScreenshot(窗口模式,viewport=geo.viewport)
 * → PNG 解码 → BLANK 双条件拦截(stdout BLANK_DETECTED 且图像 8x8 网格均匀,见 isUniformImage)
 * → 逐节点采样点计算(skipCenter 过滤 center;必要时按 PNG/viewport 线性缩放)→ 判定
 * → try/finally 清理 PNG 中间产物(spec §5:临时名落项目内,失败路径也清理)。
 * 返回 ok:false 的三类:capture 失败 / BLANK 双条件命中 / PNG 解码失败。
 * cleaned_up 语义:finally 无条件 rmSync(force:true 不抛),成功路径直接写 true。
 */
export async function runPixelVerify(params: {
  godotPath: string; projectPath: string; scenePath: string; geo: PrototypeGeometry;
}): Promise<{ ok: true; summary: PixelVerifySummary } | { ok: false; error: string; hint?: string }> {
  const { godotPath, projectPath, scenePath, geo } = params;
  const { targets, skipped } = collectBgTargets(geo);
  const note = PIXEL_VERIFY_NOTE + (targets.length === 0 ? '; this geometry has no bg nodes, nothing to sample' : '');
  if (targets.length === 0) {
    return { ok: true, summary: emptySummary(geo, skipped, note) };
  }

  const tmpPng = join(projectPath, '.godot', 'mcp_pixel_verify.png');
  try {
    const shot = await captureScreenshot({
      godotPath, projectPath,
      scene: toResPath(projectPath, scenePath),
      outputPath: tmpPng,
      viewportSize: { width: geo.viewport.w, height: geo.viewport.h },
      timeout: 60,
    });
    if (!shot.success) {
      return { ok: false, error: `Pixel screenshot failed: ${shot.error ?? 'unknown'}`, hint: getBlankHint(shot.godotOutput ?? '') || undefined };
    }

    let png: PNG;
    try {
      png = PNG.sync.read(readFileSync(tmpPng));
    } catch (err) {
      return { ok: false, error: `PNG decode failed: ${err instanceof Error ? err.message : String(err)}` };
    }

    // BLANK 双条件拦截(F1,2026-08-18 集成取证):stdout BLANK_DETECTED 与 PNG 内容
    // 均匀两证据独立一致才拦——screenshot_capture.gd 的步进采样在部分视口(如 800x600,
    // step=6×w)退化为 x=0 单列误报 BLANK,而窗口模式真渲染图内容丰富,放行采样;
    // Linux headless 真空白两证据同时成立,拦截。getBlankHint 仅为错误信息附加 hint。
    const blankHint = getBlankHint(shot.godotOutput ?? '');
    if (blankHint && isUniformImage(png)) {
      return { ok: false, error: 'Pixel screenshot is blank (headless can\'t render 2D CanvasItems)', hint: blankHint };
    }

    // 采样坐标缩放:PNG 尺寸与 geometry viewport 不一致(如 content scale/窗口边框差异)时
    // 按线性比例缩放,保持采样点与渲染内容的相对位置;scaled 标记暴露给消费方。
    const scaled = png.width !== geo.viewport.w || png.height !== geo.viewport.h;
    const sx = png.width / geo.viewport.w;
    const sy = png.height / geo.viewport.h;

    const nodes: NodePixelResult[] = targets.map(t => {
      // skipCenter(F3):带 text 节点过滤 center 点(文字居中排版必踩文字像素),四角仍判
      const points = computeSamplePoints(t.rect, t.borderRadius, t.borderWidth)
        .filter(p => !(t.skipCenter && p.id === 'center'));
      const samples = points.map(p => {
        // 与 computeSamplePoints floor 语义一致(0-indexed 像素格左端),缩放后同样向下取整
        const x = Math.floor(p.x * sx);
        const y = Math.floor(p.y * sy);
        return { x, y, rgb: pixelAt(png, x, y) };
      });
      return judgeNode(t.name, t.rect, t.target, points, samples);
    });

    return {
      ok: true,
      summary: {
        nodes,
        pass: nodes.filter(n => n.ok).length,
        fail: nodes.filter(n => !n.ok).length,
        skipped,
        viewport: { w: geo.viewport.w, h: geo.viewport.h },
        image: { width: png.width, height: png.height, scaled, cleaned_up: true },
        tolerances: { center: CENTER_TOL, corner: CORNER_TOL },
        note,
      },
    };
  } finally {
    rmSync(tmpPng, { force: true });
  }
}

function emptySummary(geo: PrototypeGeometry, skipped: Array<{ name: string; reason: string }>, note: string): PixelVerifySummary {
  return {
    nodes: [], pass: 0, fail: 0, skipped,
    viewport: { w: geo.viewport.w, h: geo.viewport.h },
    image: { width: 0, height: 0, scaled: false, cleaned_up: true },
    tolerances: { center: CENTER_TOL, corner: CORNER_TOL },
    note,
  };
}
