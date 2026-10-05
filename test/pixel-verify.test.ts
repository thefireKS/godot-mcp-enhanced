// pixel-verify 单测(spec 2026-08-17-prototype-stylebox-loop-design.md §5,PR-3):
// Task 1 纯函数——采样点 clamp 数学 / PNG 像素读取(构造 PNG 精确断言)/ RGB 距离 / bg 目标收集(半透明 skip);
// Task 2 capture 编排——runPixelVerify(mock captureScreenshot + 真临时 PNG 文件)/ judgeNode 契约补充。
// 不含 handler 接线(Task 3)。
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PNG } from 'pngjs';
import {
  computeSamplePoints, pixelAt, rgbDistance, collectBgTargets, judgeNode,
  runPixelVerify, toResPath,
  CENTER_TOL, CORNER_TOL,
} from '../src/tools/ui/pixel-verify.js';
import { captureScreenshot, getBlankHint } from '../src/screenshot.js';
import type { PrototypeGeometry } from '../src/tools/ui/prototype-import.js';
import type { Rect } from '../src/tools/ui/anchor-solver.js';
import { handleTool, TOOL_META } from '../src/tools/ui/index.js';
import { ACTIONS } from '../src/tools/ui/types.js';
import type { ToolContext } from '../src/types.js';

vi.mock('../src/screenshot.js', () => ({
  captureScreenshot: vi.fn(),
  getBlankHint: vi.fn().mockReturnValue(''),
}));

const captureMock = vi.mocked(captureScreenshot);
const blankHintMock = vi.mocked(getBlankHint);

describe('computeSamplePoints(spec §5 内缩 clamp + 半开区间)', () => {
  // F4 修后公式:角点右/下分量 x+w-1-inset / y+h-1-inset(rect 覆盖像素 [x,x+w) 半开区间,
  // 右/下缘最后有效像素格是 x+w-1/y+h-1);左/上分量 x+inset 不变。
  // rect 100x60 @(10,20),radius 8 + border 2 → inset=min(10, 60/2-2=28)=10
  it('常规:borderRadius+border 宽度决定内缩', () => {
    const pts = computeSamplePoints({ x: 10, y: 20, w: 100, h: 60 }, 8, 2);
    expect(pts).toHaveLength(5);
    const by = Object.fromEntries(pts.map(p => [p.id, p]));
    expect(by.center).toEqual({ id: 'center', x: 60, y: 50 });
    expect(by.tl).toEqual({ id: 'tl', x: 20, y: 30 });
    expect(by.tr).toEqual({ id: 'tr', x: 99, y: 30 });
    expect(by.br).toEqual({ id: 'br', x: 99, y: 69 });
    expect(by.bl).toEqual({ id: 'bl', x: 20, y: 69 });
  });

  it('clamp 上界:borderRadius 超过短边一半时被 短边/2−2 钳制', () => {
    // rect 40x20,radius 30 → min(30, 20/2-2=8)=8;角点仍 rect 内(半开区间右/下 -1)
    const pts = computeSamplePoints({ x: 0, y: 0, w: 40, h: 20 }, 30, 0);
    const by = Object.fromEntries(pts.map(p => [p.id, p]));
    expect(by.tl).toEqual({ id: 'tl', x: 8, y: 8 });
    expect(by.br).toEqual({ id: 'br', x: 31, y: 11 });
  });

  it('clamp 下界:短边 <4 时 短边/2−2 为负,回落 0(角点=角,仍在图内)', () => {
    const pts = computeSamplePoints({ x: 5, y: 5, w: 3, h: 2 }, 0, 0);
    const by = Object.fromEntries(pts.map(p => [p.id, p]));
    expect(by.tl).toEqual({ id: 'tl', x: 5, y: 5 });
    expect(by.br).toEqual({ id: 'br', x: 7, y: 6 });
  });

  it('坐标 floor 到整数(奇数宽高中心)', () => {
    const pts = computeSamplePoints({ x: 0, y: 0, w: 101, h: 61 }, 0, 0);
    expect(pts.find(p => p.id === 'center')).toEqual({ id: 'center', x: 50, y: 30 });
  });

  it('inset=0 时四角均在 rect 覆盖半开区间内(右/下缘最后有效像素 x+w-1/y+h-1)', () => {
    // F4 回归锚点:css-card HpBar 形态(radius=0/border=0)——修前 tr/br/bl 落在
    // [x,x+w) 外一像素格采到节点外背景(实测清屏灰 d=65.7),修后全部区间内
    const pts = computeSamplePoints({ x: 56, y: 290, w: 280, h: 27 }, 0, 0);
    const by = Object.fromEntries(pts.map(p => [p.id, p]));
    expect(by.tl).toEqual({ id: 'tl', x: 56, y: 290 });
    expect(by.tr).toEqual({ id: 'tr', x: 335, y: 290 });
    expect(by.br).toEqual({ id: 'br', x: 335, y: 316 });
    expect(by.bl).toEqual({ id: 'bl', x: 56, y: 316 });
    // 全部在 [56,336)×[290,317) 覆盖区内
    for (const p of [by.tl, by.tr, by.br, by.bl] as Array<{ x: number; y: number }>) {
      expect(p.x).toBeGreaterThanOrEqual(56);
      expect(p.x).toBeLessThan(56 + 280);
      expect(p.y).toBeGreaterThanOrEqual(290);
      expect(p.y).toBeLessThan(290 + 27);
    }
  });
});

describe('pixelAt(构造 PNG 精确读值)', () => {
  function solidPng(w: number, h: number, rgb: [number, number, number]): PNG {
    const png = new PNG({ width: w, height: h });
    for (let i = 0; i < w * h; i++) {
      png.data[i * 4] = rgb[0]; png.data[i * 4 + 1] = rgb[1];
      png.data[i * 4 + 2] = rgb[2]; png.data[i * 4 + 3] = 255;
    }
    return png;
  }

  it('读回构造色值(红底)', () => {
    const png = solidPng(4, 4, [255, 0, 0]);
    expect(pixelAt(png, 0, 0)).toEqual([255, 0, 0]);
    expect(pixelAt(png, 3, 3)).toEqual([255, 0, 0]);
  });

  it('越界返回 null(x/y 负、≥尺寸)', () => {
    const png = solidPng(4, 4, [0, 0, 255]);
    expect(pixelAt(png, -1, 0)).toBeNull();
    expect(pixelAt(png, 0, -1)).toBeNull();
    expect(pixelAt(png, 4, 0)).toBeNull();
    expect(pixelAt(png, 0, 4)).toBeNull();
  });
});

describe('rgbDistance', () => {
  it('0-255 空间欧氏距离', () => {
    expect(rgbDistance([0, 0, 0], [0, 0, 0])).toBe(0);
    expect(rgbDistance([255, 0, 0], [0, 0, 0])).toBeCloseTo(255, 5);
    expect(rgbDistance([255, 255, 0], [0, 0, 0])).toBeCloseTo(Math.sqrt(2) * 255, 5);
  });
});

describe('collectBgTargets(spec §5 「每 bg 节点」)', () => {
  const geo: PrototypeGeometry = {
    viewport: { w: 800, h: 600 },
    nodes: [
      { name: 'Card', rect: { x: 0, y: 0, w: 200, h: 80 }, bg: '#1a1f2e', borderRadius: 8, border: { width: 2, color: '#3ddc84' } },
      { name: 'HpBar', rect: { x: 10, y: 90, w: 120, h: 16 }, bg: '#222222' },
      { name: 'Plain', rect: { x: 10, y: 120, w: 50, h: 20 } },                        // 无 bg → 不采样
      { name: 'Ghost', rect: { x: 10, y: 150, w: 50, h: 20 }, bg: [10, 20, 30, 0.5] }, // 半透明 → skipped
      { name: 'Corners', rect: { x: 10, y: 180, w: 60, h: 60 }, bg: '#ff0000', borderRadius: { tl: 4, tr: 6, br: 10, bl: 2 } },
    ],
  };

  it('收集 bg 节点,hex 目标转 0-255,fill-only 不进(仅 bg 语义)', () => {
    const { targets, skipped } = collectBgTargets(geo);
    expect(targets.map(t => t.name)).toEqual(['Card', 'HpBar', 'Corners']);
    expect(targets[0]!.target).toEqual([0x1a, 0x1f, 0x2e]);
    expect(targets[0]!.borderRadius).toBe(8);
    expect(targets[0]!.borderWidth).toBe(2);
    expect(targets[1]!.borderWidth).toBe(0);
    expect(skipped).toEqual([{ name: 'Ghost', reason: expect.stringContaining('alpha') }]);
  });

  it('per-corner borderRadius 取四角 max(保守内缩)', () => {
    const { targets } = collectBgTargets(geo);
    expect(targets.find(t => t.name === 'Corners')!.borderRadius).toBe(10);
  });

  it('数组色 [r,g,b] 0-255 与 [r,g,b,a] 0-1 两种 ProtoColor 格式都归一', () => {
    const g2: PrototypeGeometry = {
      viewport: { w: 100, h: 100 },
      nodes: [
        { name: 'A', rect: { x: 0, y: 0, w: 10, h: 10 }, bg: [26, 31, 46] },
        { name: 'B', rect: { x: 0, y: 20, w: 10, h: 10 }, bg: [0.1, 0.2, 1.0, 1.0] },
      ],
    };
    const { targets } = collectBgTargets(g2);
    expect(targets[0]!.target).toEqual([26, 31, 46]);
    expect(targets[1]!.target).toEqual([26, 51, 255]);
  });

  it('F2:ProgressBar 系 bg(type/value/fill 任一命中)→ skipped 不进 targets', () => {
    // css-card HpBar 形态:bg 渲染面被 fill 与百分比文字覆盖,无可采样纯色区域
    const g3: PrototypeGeometry = {
      viewport: { w: 800, h: 600 },
      nodes: [
        { name: 'HpBar', rect: { x: 56, y: 290, w: 280, h: 27 }, type: 'ProgressBar', value: 0.72, bg: '#223022', fill: '#3ddc84' },
        { name: 'ValueOnly', rect: { x: 0, y: 0, w: 100, h: 10 }, value: 0.5, bg: '#222222' },        // 仅 value
        { name: 'FillOnly', rect: { x: 0, y: 20, w: 100, h: 10 }, fill: '#3ddc84', bg: '#222222' },   // 仅 fill
        { name: 'TypeOnly', rect: { x: 0, y: 40, w: 100, h: 10 }, type: 'ProgressBar', bg: '#222222' }, // 仅 type
        { name: 'Plain', rect: { x: 0, y: 60, w: 100, h: 10 }, bg: '#223022' },                        // 无特征 → 仍采样
      ],
    };
    const { targets, skipped } = collectBgTargets(g3);
    expect(targets.map(t => t.name)).toEqual(['Plain']);
    expect(skipped.map(s => s.name)).toEqual(['HpBar', 'ValueOnly', 'FillOnly', 'TypeOnly']);
    expect(skipped[0]!.reason).toContain('ProgressBar');
    expect(skipped[0]!.reason).toContain('style_verify');
  });

  it('F3:带 text 节点 skipCenter=true(文字居中排版中心点踩文字像素),无 text false', () => {
    const g4: PrototypeGeometry = {
      viewport: { w: 800, h: 600 },
      nodes: [
        { name: 'Title', rect: { x: 56, y: 56, w: 200, h: 28 }, text: '卡片标题', bg: '#2a3040' },
        { name: 'EmptyText', rect: { x: 0, y: 100, w: 100, h: 20 }, text: '', bg: '#2a3040' },  // 空串 ≠ 带 text
        { name: 'NoText', rect: { x: 0, y: 130, w: 100, h: 20 }, bg: '#2a3040' },
      ],
    };
    const { targets } = collectBgTargets(g4);
    const by = Object.fromEntries(targets.map(t => [t.name, t]));
    expect(by.Title!.skipCenter).toBe(true);
    expect(by.EmptyText!.skipCenter).toBe(false);
    expect(by.NoText!.skipCenter).toBe(false);
  });
});

describe('容差常量(Task 4 集成校准锚点)', () => {
  it('中心严格、角点宽松(spec §5)', () => {
    expect(CENTER_TOL).toBeLessThan(CORNER_TOL);
  });
});

describe('toResPath', () => {
  it('项目内绝对路径 → res:// 相对形式(正斜杠,平台无关)', () => {
    expect(toResPath('D:/proj', 'D:/proj/scenes/main.tscn')).toBe('res://scenes/main.tscn');
  });
  // 反斜杠是 win32 路径分隔符;Linux 的 path.relative 把 'D:\proj' 当单个文件名
  // (反斜杠非分隔符,产出 res://../… 逃逸形态),该断言仅 win32 有语义——
  // CI Linux 跑同一文件,skipIf 防(2026-08-18 PR#35 CI 首跑红根因)
  it.skipIf(process.platform !== 'win32')('Windows 反斜杠路径转正斜杠', () => {
    expect(toResPath('D:\\proj', 'D:\\proj\\scenes\\main.tscn')).toBe('res://scenes/main.tscn');
  });
});

describe('judgeNode 契约与路径(Task 2 衔接补充)', () => {
  const rect: Rect = { x: 0, y: 0, w: 100, h: 100 };
  // computeSamplePoints(rect,0,0) → center(50,50)/tl(0,0)/tr(99,0)/br(99,99)/bl(0,99)(F4 半开区间)
  const points = computeSamplePoints(rect, 0, 0);

  it('samples 与 points 不成对(短数组)→ 抛错(锁「编排层必须成对给」契约)', () => {
    // 现实现 samples[i]! 非空断言在运行时为 undefined → 读属性抛 TypeError
    expect(() => judgeNode('N', rect, [0, 0, 0], points, [])).toThrow();
  });

  it('rgb null(越界采样)→ ok:false + distance:null,节点整体红', () => {
    const samples = points.map(p => ({ x: p.x, y: p.y, rgb: null }));
    const r = judgeNode('N', rect, [0, 0, 0], points, samples);
    expect(r.ok).toBe(false);
    expect(r.samples.every(s => s.ok === false)).toBe(true);
    expect(r.samples.every(s => s.distance === null)).toBe(true);
  });

  it('容差分流:CENTER_TOL 边界过(<=20)/ CORNER_TOL 边界过(<=60)两路径', () => {
    // target [0,0,0]:rgb [20,0,0] → distance 20 == CENTER_TOL,中心点边界过(<=)
    const rCenter = judgeNode('N', rect, [0, 0, 0], points, points.map(p => ({
      x: p.x, y: p.y,
      rgb: (p.id === 'center' ? [20, 0, 0] : [0, 0, 0]) as [number, number, number],
    })));
    expect(rCenter.samples.find(s => s.id === 'center')!.ok).toBe(true);
    expect(rCenter.ok).toBe(true);

    // rgb [60,0,0] → distance 60 == CORNER_TOL,角点边界过(<=);同值放中心则红(60 > 20)
    const rCorner = judgeNode('N', rect, [0, 0, 0], points, points.map(p => ({
      x: p.x, y: p.y,
      rgb: (p.id === 'tl' ? [60, 0, 0] : [0, 0, 0]) as [number, number, number],
    })));
    expect(rCorner.samples.find(s => s.id === 'tl')!.ok).toBe(true);
    const rCenter60 = judgeNode('N', rect, [0, 0, 0], points, points.map(p => ({
      x: p.x, y: p.y,
      rgb: (p.id === 'center' ? [60, 0, 0] : [0, 0, 0]) as [number, number, number],
    })));
    expect(rCenter60.samples.find(s => s.id === 'center')!.ok).toBe(false);
    expect(rCenter60.ok).toBe(false);
  });
});

describe('runPixelVerify 编排(mock capture)', () => {
  let dir: string;

  /** 构造整图纯色 PNG 落盘,并让 mock captureScreenshot 返回成功(产出该文件)。 */
  function stubCaptureWithSolidPng(rgb: [number, number, number], w = 800, h = 600): void {
    captureMock.mockImplementation(async (opts) => {
      // 模拟真实 captureScreenshot 的建目录行为(产物落 .godot/ 子目录)
      mkdirSync(dirname(opts.outputPath), { recursive: true });
      const png = new PNG({ width: w, height: h });
      for (let i = 0; i < w * h; i++) {
        png.data[i * 4] = rgb[0]; png.data[i * 4 + 1] = rgb[1];
        png.data[i * 4 + 2] = rgb[2]; png.data[i * 4 + 3] = 255;
      }
      writeFileSync(opts.outputPath, PNG.sync.write(png));
      return { success: true, imagePath: opts.outputPath, width: w, height: h };
    });
  }

  const geo: PrototypeGeometry = {
    viewport: { w: 800, h: 600 },
    nodes: [
      { name: 'Card', rect: { x: 100, y: 100, w: 200, h: 80 }, bg: '#1a1f2e' },
      { name: 'Accent', rect: { x: 100, y: 200, w: 200, h: 40 }, bg: '#3ddc84' },
    ],
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pixel-verify-ut-'));
    captureMock.mockReset();
    blankHintMock.mockReturnValue('');
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('同图全绿:PNG 与目标同色 → 全节点 ok + PNG 已清理(cleaned_up)', async () => {
    // 两节点同目标色 #1a1f2e,整图渲染该色 → 采样全绿路径
    const g2: PrototypeGeometry = {
      viewport: { w: 800, h: 600 },
      nodes: [
        { name: 'Card', rect: { x: 100, y: 100, w: 200, h: 80 }, bg: '#1a1f2e' },
        { name: 'Accent', rect: { x: 100, y: 200, w: 200, h: 40 }, bg: '#1a1f2e' },
      ],
    };
    stubCaptureWithSolidPng([0x1a, 0x1f, 0x2e]);
    const r = await runPixelVerify({ godotPath: 'godot', projectPath: dir, scenePath: join(dir, 'main.tscn'), geo: g2 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.summary.pass).toBe(2);
    expect(r.summary.fail).toBe(0);
    expect(r.summary.nodes.every(n => n.ok)).toBe(true);
    expect(r.summary.image.cleaned_up).toBe(true);
    expect(existsSync(join(dir, '.godot', 'mcp_pixel_verify.png'))).toBe(false);
  });

  it('构造差异精确计数:整图 Accent 色 → Card 红(5 采样点)/Accent 绿,pass=1 fail=1', async () => {
    stubCaptureWithSolidPng([0x3d, 0xdc, 0x84]);
    const r = await runPixelVerify({ godotPath: 'godot', projectPath: dir, scenePath: join(dir, 'main.tscn'), geo });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.summary.pass).toBe(1);
    expect(r.summary.fail).toBe(1);
    const card = r.summary.nodes.find(n => n.name === 'Card')!;
    expect(card.ok).toBe(false);
    expect(card.samples).toHaveLength(5);
    expect(card.samples.every(s => !s.ok)).toBe(true);
    expect(card.samples.every(s => s.distance !== null && s.distance > 60)).toBe(true);
  });

  it('capture 失败 → ok:false 透传错误', async () => {
    captureMock.mockResolvedValue({ success: false, error: 'Screenshot failed (windowed mode). Godot exited with code 1.' });
    const r = await runPixelVerify({ godotPath: 'godot', projectPath: dir, scenePath: join(dir, 'main.tscn'), geo });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('Screenshot failed');
    // 失败路径也不留 PNG
    expect(existsSync(join(dir, '.godot', 'mcp_pixel_verify.png'))).toBe(false);
  });

  it('F1 双条件:stdout BLANK_DETECTED + 全黑 PNG → ok:false 且附 hint(Linux headless 空白防线)', async () => {
    // 两证据独立一致才拦:stdout 报 BLANK + 图像 8x8 网格全同色(真空白)
    blankHintMock.mockReturnValue('2D CanvasItem content cannot render in headless mode.');
    try {
      stubCaptureWithSolidPng([0, 0, 0]);
      const r = await runPixelVerify({ godotPath: 'godot', projectPath: dir, scenePath: join(dir, 'main.tscn'), geo });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error).toContain('blank');
      expect(r.hint).toContain('headless');
    } finally {
      blankHintMock.mockReturnValue('');
    }
  });

  it('F1 双条件:stdout BLANK_DETECTED + 彩色 PNG(两种色)→ 放行采样(win32 误报防线)', async () => {
    // capture 层步进采样退化(800x600 视口 step=6×w → x=0 单列)误报 BLANK,但窗口模式
    // 真渲染图内容丰富——图像侧证据不均匀,放行采样(左半 #1a1f2e / 右半 #3ddc84)
    blankHintMock.mockReturnValue('2D CanvasItem content cannot render in headless mode.');
    try {
      captureMock.mockImplementation(async (opts) => {
        mkdirSync(dirname(opts.outputPath), { recursive: true });
        const w = 800, h = 600;
        const png = new PNG({ width: w, height: h });
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            const c: [number, number, number] = x < w / 2 ? [0x1a, 0x1f, 0x2e] : [0x3d, 0xdc, 0x84];
            png.data[i] = c[0]; png.data[i + 1] = c[1]; png.data[i + 2] = c[2]; png.data[i + 3] = 255;
          }
        }
        writeFileSync(opts.outputPath, PNG.sync.write(png));
        return { success: true, imagePath: opts.outputPath, width: w, height: h };
      });
      // 两节点分别在左/右半区,与所在区域同色 → 放行采样且全绿(证明走到了采样判定)
      const g2: PrototypeGeometry = {
        viewport: { w: 800, h: 600 },
        nodes: [
          { name: 'Left', rect: { x: 100, y: 100, w: 200, h: 80 }, bg: '#1a1f2e' },
          { name: 'Right', rect: { x: 500, y: 100, w: 200, h: 80 }, bg: '#3ddc84' },
        ],
      };
      const r = await runPixelVerify({ godotPath: 'godot', projectPath: dir, scenePath: join(dir, 'main.tscn'), geo: g2 });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.summary.pass).toBe(2);
      expect(r.summary.fail).toBe(0);
      expect(r.summary.nodes.every(n => n.ok)).toBe(true);
    } finally {
      blankHintMock.mockReturnValue('');
    }
  });

  it('F3:带 text 节点 samples 4 点且无 center(文字居中排版中心点踩文字像素)', async () => {
    // 整图渲染 bg 色:若 center 未过滤且踩到「文字色」会红——此处验证 center 点被移除
    stubCaptureWithSolidPng([0x2a, 0x30, 0x40]);
    const r = await runPixelVerify({ godotPath: 'godot', projectPath: dir, scenePath: join(dir, 'main.tscn'), geo: {
      viewport: { w: 800, h: 600 },
      nodes: [
        { name: 'Title', rect: { x: 56, y: 56, w: 200, h: 28 }, text: '卡片标题', bg: '#2a3040' },
        { name: 'Plain', rect: { x: 56, y: 100, w: 200, h: 28 }, bg: '#2a3040' },
      ],
    } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const title = r.summary.nodes.find(n => n.name === 'Title')!;
    const plain = r.summary.nodes.find(n => n.name === 'Plain')!;
    expect(title.samples).toHaveLength(4);
    expect(title.samples.map(s => s.id)).toEqual(['tl', 'tr', 'br', 'bl']);
    expect(title.ok).toBe(true);
    expect(plain.samples).toHaveLength(5);  // 无 text 节点不受影响
    expect(plain.samples.map(s => s.id)).toContain('center');
  });

  it('PNG 尺寸≠viewport → 线性缩放采样坐标 + image.scaled=true', async () => {
    // viewport 800x600,PNG 实际 400x300(半分辨率)→ 采样点同比例缩放,同色仍全绿
    stubCaptureWithSolidPng([0x1a, 0x1f, 0x2e], 400, 300);
    const r = await runPixelVerify({ godotPath: 'godot', projectPath: dir, scenePath: join(dir, 'main.tscn'), geo: {
      viewport: { w: 800, h: 600 },
      nodes: [{ name: 'Card', rect: { x: 100, y: 100, w: 200, h: 80 }, bg: '#1a1f2e' }],
    } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.summary.image.scaled).toBe(true);
    expect(r.summary.image.width).toBe(400);
    expect(r.summary.nodes[0]!.ok).toBe(true);
    expect(r.summary.nodes[0]!.samples.find(s => s.id === 'tl')).toMatchObject({ x: 50, y: 50 });
  });

  it('无 bg 节点 → 空结果 + note 声明(不是错误)', async () => {
    stubCaptureWithSolidPng([0, 0, 0]);
    const r = await runPixelVerify({ godotPath: 'godot', projectPath: dir, scenePath: join(dir, 'main.tscn'), geo: {
      viewport: { w: 800, h: 600 }, nodes: [{ name: 'Plain', rect: { x: 0, y: 0, w: 10, h: 10 } }],
    } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.summary.nodes).toHaveLength(0);
    expect(r.summary.note).toContain('no bg nodes');
  });
});

describe('ui_pixel_verify handler 接线', () => {
  function createCtx(): ToolContext {
    return {
      opsScript: '/fake/ops.gd',
      findGodot: async () => 'C:/godot/godot.exe',
      runningProcess: null, setRunningProcess: () => {},
      outputBuffer: [], setOutputBuffer: () => {},
      processStartTime: 0, setProcessStartTime: () => {},
      projectDir: process.cwd(), setProjectDir: () => {},
      parseGodotConfig: () => ({}),
    } as unknown as ToolContext;
  }

  it('geometry 与 geometry_path 都缺 → INVALID_PARAMS', async () => {
    const r = await handleTool('ui', { action: 'ui_pixel_verify', project_path: process.cwd(), scene_path: 'main.tscn' }, createCtx());
    const text = (r?.content?.[0] as { text: string }).text;
    expect(text).toContain('INVALID_PARAMS');
    expect(text).toContain('One of geometry or geometry_path is required');
  });

  it('geometry_path 越界逃逸(../) → INVALID_PARAMS(路径白名单负向)', async () => {
    const r = await handleTool('ui', { action: 'ui_pixel_verify', project_path: process.cwd(), scene_path: 'main.tscn', geometry_path: '../outside.json' }, createCtx());
    const text = (r?.content?.[0] as { text: string }).text;
    expect(text).toContain('INVALID_PARAMS');
    expect(text).toContain('geometry_path');
  });

  it('scene_path 缺失 → INVALID_PARAMS(pixel_verify 必须指向已构建场景)', async () => {
    const r = await handleTool('ui', { action: 'ui_pixel_verify', project_path: process.cwd(), geometry: { viewport: { w: 10, h: 10 }, nodes: [] } }, createCtx());
    const text = (r?.content?.[0] as { text: string }).text;
    expect(text).toContain('INVALID_PARAMS');
    expect(text).toContain('scene_path');
  });

  it('ACTIONS/TOOL_META 登记一致(spec §5 actionRisks write)', () => {
    expect(ACTIONS).toContain('ui_pixel_verify');
    expect(TOOL_META['ui']!.actionRisks!['ui_pixel_verify']).toBe('write');
  });
});
