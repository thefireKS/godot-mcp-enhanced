// PR-1a:screenshot_diff 真实现(像素差异容忍,复用 screenshot-detail diffPngBuffers)。
// 真契约 mock:take_screenshot → {success:true, path:'user://…', size:{x,y}}(无 base64)。
// 占位时代(2026-08-06 NOT_IMPLEMENTED)行为测试全部废弃,本文件锁定真实现。
//
// 相对 brief 原文的修正(详见 .superpowers/sdd/task-6-assert-batch-report.md):
// 1. vi.mock hoisting:brief 原文 mock factory 闭包引用 factory 外的 gameDir(const,TDZ)→
//    ReferenceError。改为 mock 空 vi.fn() + 模块级 mockImplementation(test/qa-runner.test.ts 同款范式)。
// 2. brief 原文未 mkdirSync projDir/gameDir → 模块级 writeFileSync 直接 ENOENT,补 recursive mkdir。
// 3. 白名单用例 reference 由 'Z:/elsewhere/x.png' 改为 tmpdir() 下白名单外路径:
//    Linux CI 上 isAbsolute('Z:/…') === false 会走相对分支假白名单内;Windows 无 Z: 盘时
//    safeRealPath 抛 PathError → ASSERT_ERROR。tmpdir() 祖先必存在,双平台确定性拒绝。
// 4. 断言 error_code 为 INVALID_PATH(非 INVALID_PARAMS):brief 自身测试与实现矛盾,
//    实现侧 INVALID_PATH 与仓库路径拒绝惯例一致(qa/index.ts、scene/index.ts 等十余处)。
// 5. I-1 修复:evidence_path 必须位于 qaReportsDir() 内(本文件把 GODOT_MCP_QA_REPORTS_DIR
//    重定向到 tmp 内子目录),越界(哪怕在项目白名单 ALLOWED_PROJECT_PATHS 内)→ INVALID_PATH。
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { PNG } from 'pngjs';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('../src/tools/game-bridge.js', () => ({
  sendToBridge: vi.fn(),
  setBridgeProjectDir: vi.fn(),
}));
vi.mock('../src/tools/game-fs.js', () => ({
  resolveGameDataPath: vi.fn(),
}));

import { sendToBridge } from '../src/tools/game-bridge.js';
import { resolveGameDataPath } from '../src/tools/game-fs.js';
import { handleTool } from '../src/tools/runtime-assert.js';

const tmp = mkdtempSync(join(tmpdir(), 'radiff-'));
const projDir = join(tmp, 'proj');
const gameDir = join(tmp, 'gamedata');
mkdirSync(projDir, { recursive: true });
mkdirSync(gameDir, { recursive: true });
const refPath = join(projDir, 'ref.png');
// 白名单外路径(祖先 tmpdir() 必存在,双平台 isAbsolute 均真)
const outsidePath = join(tmpdir(), 'radiff-outside', 'x.png');

// I-1:qa-reports 目录重定向到 tmp 内子目录(evidence_path 落盘白名单)
const qaReports = join(tmp, 'qa-reports');
const prevQaReportsDir = process.env.GODOT_MCP_QA_REPORTS_DIR;
process.env.GODOT_MCP_QA_REPORTS_DIR = qaReports;

// 白名单:让 tmp 进 ALLOWED_PROJECT_PATHS(brief 注记;isPathInAllowedRoots 运行时读 env)。
// 同时清掉 GODOT_MCP_UNRESTRICTED 防环境泄漏放行一切(旧版本文件同款护栏)。
const prevAllowed = process.env.ALLOWED_PROJECT_PATHS;
const prevUnrestricted = process.env.GODOT_MCP_UNRESTRICTED;
process.env.ALLOWED_PROJECT_PATHS = tmp;
delete process.env.GODOT_MCP_UNRESTRICTED;

// user:// → 测试临时目录内的实际 PNG(绕开 APPDATA 布局)
vi.mocked(resolveGameDataPath).mockImplementation((_proj: string, uri: string): string | null =>
  uri.startsWith('user://') ? join(gameDir, uri.slice('user://'.length)) : null);

function makePng(width: number, height: number, fill: [number, number, number]): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    const idx = i << 2;
    png.data[idx] = fill[0]; png.data[idx + 1] = fill[1]; png.data[idx + 2] = fill[2]; png.data[idx + 3] = 255;
  }
  return PNG.sync.write(png);
}

// 参考图:32x32 纯红;同款截图 → diffRatio 0
writeFileSync(refPath, makePng(32, 32, [200, 30, 30]));
// 截图(游戏侧):同尺寸纯红
writeFileSync(join(gameDir, 'shot-identical.png'), makePng(32, 32, [200, 30, 30]));
// 截图(游戏侧):右半纯蓝(一半像素差异)
const halfDiff = new PNG({ width: 32, height: 32 });
for (let i = 0; i < 32 * 32; i++) {
  const idx = i << 2;
  const blue = (i % 32) >= 16;
  halfDiff.data[idx] = blue ? 30 : 200; halfDiff.data[idx + 1] = 30; halfDiff.data[idx + 2] = blue ? 200 : 30; halfDiff.data[idx + 3] = 255;
}
writeFileSync(join(gameDir, 'shot-halfblue.png'), PNG.sync.write(halfDiff));
// 截图(游戏侧):尺寸不一致
writeFileSync(join(gameDir, 'shot-16x16.png'), makePng(16, 16, [200, 30, 30]));
// 参考(非 PNG 文本文件):白名单内但解码必失败(审查 Minor⑤ 用例)
writeFileSync(join(projDir, 'ref-not-png.txt'), 'this is not a png file at all');

const shotResult = (file: string) => ({ result: { success: true, path: `user://${file}`, size: { x: 32, y: 32 } } });

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  if (prevAllowed === undefined) delete process.env.ALLOWED_PROJECT_PATHS;
  else process.env.ALLOWED_PROJECT_PATHS = prevAllowed;
  if (prevUnrestricted !== undefined) process.env.GODOT_MCP_UNRESTRICTED = prevUnrestricted;
  if (prevQaReportsDir === undefined) delete process.env.GODOT_MCP_QA_REPORTS_DIR;
  else process.env.GODOT_MCP_QA_REPORTS_DIR = prevQaReportsDir;
});

describe('runtime-assert screenshot_diff 真实现(PR-1a)', () => {
  beforeEach(() => { vi.mocked(sendToBridge).mockReset(); });

  it('reference 缺失 → INVALID_PARAMS', async () => {
    const r = await handleTool('runtime_assert', { action: 'screenshot_diff', project_path: projDir }, {} as never);
    const p = JSON.parse((r!.content[0] as { text: string }).text);
    expect(p.success).toBe(false); expect(p.error_code).toBe('INVALID_PARAMS');
  });

  it('project_path 缺失 → INVALID_PARAMS(I-1:解析 user:// 必需)', async () => {
    const r = await handleTool('runtime_assert', { action: 'screenshot_diff', reference: refPath }, {} as never);
    const p = JSON.parse((r!.content[0] as { text: string }).text);
    expect(p.success).toBe(false); expect(p.error_code).toBe('INVALID_PARAMS');
    expect(p.error).toContain('project_path');
  });

  it('reference 越出白名单 → INVALID_PATH(不读文件)', async () => {
    const r = await handleTool('runtime_assert', { action: 'screenshot_diff', reference: outsidePath, project_path: projDir }, {} as never);
    const p = JSON.parse((r!.content[0] as { text: string }).text);
    expect(p.success).toBe(false); expect(p.error_code).toBe('INVALID_PATH');
    expect(p.error).toContain('ALLOWED_PROJECT_PATHS');
    // Minor⑥:锁"先校验后截图"顺序——白名单拒绝时不得触碰 bridge(防未来重排产生副作用)
    expect(sendToBridge).not.toHaveBeenCalled();
  });

  it('同图 → passed:true,diff_ratio=0(B-1:threshold 语义=差异容忍,默认 0.12)', async () => {
    vi.mocked(sendToBridge).mockResolvedValue(shotResult('shot-identical.png') as never);
    const r = await handleTool('runtime_assert', { action: 'screenshot_diff', reference: refPath, project_path: projDir }, {} as never);
    const p = JSON.parse((r!.content[0] as { text: string }).text);
    expect(p.success).toBe(true); expect(p.passed).toBe(true);
    expect(p.details.diff_ratio).toBe(0);
  });

  it('半图差异(≈0.5)> max_diff_ratio 默认 0.05 → FAILED,mismatch 带实际 ratio', async () => {
    vi.mocked(sendToBridge).mockResolvedValue(shotResult('shot-halfblue.png') as never);
    const r = await handleTool('runtime_assert', { action: 'screenshot_diff', reference: refPath, project_path: projDir }, {} as never);
    const p = JSON.parse((r!.content[0] as { text: string }).text);
    expect(p.success).toBe(true); expect(p.passed).toBe(false);
    expect(p.mismatch.diff_ratio.actual).toBeGreaterThan(0.4);
    expect(p.mismatch.diff_ratio.expected).toContain('≤ 0.05');
  });

  it('max_diff_ratio=0.6 时半图差异 → passed(阈值校准语义,I-3)', async () => {
    vi.mocked(sendToBridge).mockResolvedValue(shotResult('shot-halfblue.png') as never);
    const r = await handleTool('runtime_assert', { action: 'screenshot_diff', reference: refPath, project_path: projDir, max_diff_ratio: 0.6 }, {} as never);
    const p = JSON.parse((r!.content[0] as { text: string }).text);
    expect(p.passed).toBe(true);
  });

  it('尺寸不一致 → FAILED(非 success:false),detail 带双方尺寸', async () => {
    vi.mocked(sendToBridge).mockResolvedValue(shotResult('shot-16x16.png') as never);
    const r = await handleTool('runtime_assert', { action: 'screenshot_diff', reference: refPath, project_path: projDir }, {} as never);
    const p = JSON.parse((r!.content[0] as { text: string }).text);
    expect(p.success).toBe(true); expect(p.passed).toBe(false);
    expect(JSON.stringify(p.mismatch)).toContain('dimensions');
  });

  it('evidence_path 内部参数 → diff 染红图落盘', async () => {
    vi.mocked(sendToBridge).mockResolvedValue(shotResult('shot-halfblue.png') as never);
    const ev = join(qaReports, 'ev-diff.png');
    const r = await handleTool('runtime_assert', { action: 'screenshot_diff', reference: refPath, project_path: projDir, evidence_path: ev }, {} as never);
    const p = JSON.parse((r!.content[0] as { text: string }).text);
    expect(p.details.evidence_path).toBe(ev);
    const buf = readFileSync(ev);
    expect(buf.length).toBeGreaterThan(0);
  });

  it('I-1:evidence_path 位于 qa-reports 外(哪怕在项目白名单内)→ INVALID_PATH 且不写文件', async () => {
    vi.mocked(sendToBridge).mockResolvedValue(shotResult('shot-identical.png') as never);
    // projDir 在 ALLOWED_PROJECT_PATHS(=tmp)内——证明"项目白名单内"不足以放行,必须在 qa-reports 内
    const evil = join(projDir, 'escape-diff.png');
    const r = await handleTool('runtime_assert', { action: 'screenshot_diff', reference: refPath, project_path: projDir, evidence_path: evil }, {} as never);
    const p = JSON.parse((r!.content[0] as { text: string }).text);
    expect(p.success).toBe(false); expect(p.error_code).toBe('INVALID_PATH');
    expect(p.error).toContain('qa-reports');
    expect(existsSync(evil)).toBe(false); // 未写盘
    expect(existsSync(join(projDir, 'escape-diff'))).toBe(false);
  });

  it('I-1:相对路径前缀伪装(qa-reports 开头但实为兄弟目录)→ INVALID_PATH', async () => {
    vi.mocked(sendToBridge).mockResolvedValue(shotResult('shot-identical.png') as never);
    // resolve 后 = tmp/qa-reports-evil/x.png,不以 qaReports + sep 开头 → 拒
    const evil = join(tmp, 'qa-reports-evil', 'x.png');
    const r = await handleTool('runtime_assert', { action: 'screenshot_diff', reference: refPath, project_path: projDir, evidence_path: evil }, {} as never);
    const p = JSON.parse((r!.content[0] as { text: string }).text);
    expect(p.success).toBe(false); expect(p.error_code).toBe('INVALID_PATH');
    expect(existsSync(evil)).toBe(false);
  });

  it('Minor⑤:reference 为白名单内非 PNG 文本文件 → ASSERT_ERROR(读图/解码失败),非 dimensions FAILED', async () => {
    vi.mocked(sendToBridge).mockResolvedValue(shotResult('shot-identical.png') as never);
    const r = await handleTool('runtime_assert', { action: 'screenshot_diff', reference: join(projDir, 'ref-not-png.txt'), project_path: projDir }, {} as never);
    const p = JSON.parse((r!.content[0] as { text: string }).text);
    expect(p.success).toBe(false); expect(p.error_code).toBe('ASSERT_ERROR');
    expect(p.error).toContain('Failed to read/decode images');
    expect(p.mismatch).toBeUndefined(); // 不再误报尺寸不一致(dimensions FAILED)
  });
});
