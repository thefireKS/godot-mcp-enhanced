import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, rmSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { collectPerformance } from '../../src/scoring/collectors/performance.js';
import { T_PASS_MS, T_WARN_MS } from '../../src/scoring/dimensions.js';

const TMP = resolve(process.cwd(), 'test', 'scoring', '__tmp_perf__');
const REPORT = resolve(TMP, 'test-report.json');

beforeEach(() => mkdirSync(TMP, { recursive: true }));
afterEach(() => rmSync(TMP, { recursive: true, force: true }));

/** 造 vitest json:files 数组每个含 startTime/endTime(ms 时间戳) */
function writeVitestJson(files: { start: number; end: number }[]): void {
  writeFileSync(REPORT, JSON.stringify({
    numTotalTests: 100, numPassedTests: 100, startTime: 0,
    testResults: files.map(f => ({ name: 'a.test.ts', startTime: f.start, endTime: f.end, status: 'passed', assertionResults: [] })),
  }));
}

describe('collectPerformance', () => {
  it('wall-clock = max(endTime) - min(startTime)(串行)', () => {
    writeVitestJson([{ start: 1000, end: 5000 }, { start: 5000, end: 9000 }]); // 串行:9000-1000=8000
    const r = collectPerformance(REPORT);
    expect((r.raw as { wallclockMs: number }).wallclockMs).toBe(8000);
  });

  it('wall-clock 并行取最早开始到最晚结束(非 Σ per-file diff)——ADVISORY 3 锚定算法意图', () => {
    // 两文件并行重叠:start 都 1000,end 都 5000(并行 4s)。Σ per-file diff = 4000+4000=8000(错),max-min = 4000(对)
    writeVitestJson([{ start: 1000, end: 5000 }, { start: 1000, end: 5000 }]);
    const r = collectPerformance(REPORT);
    expect((r.raw as { wallclockMs: number }).wallclockMs).toBe(4000); // max(5000)-min(1000),非 8000
  });

  it(`曲线 ≤T_PASS_MS(${T_PASS_MS}ms)→ 100 pass`, () => {
    writeVitestJson([{ start: 0, end: 60000 }]);
    const r = collectPerformance(REPORT);
    expect(r.score).toBe(100);
    expect(r.status).toBe('pass');
  });

  it('曲线 =T_PASS_MS 边界 → 100 pass(≤闭区间)', () => {
    writeVitestJson([{ start: 0, end: T_PASS_MS }]);
    expect(collectPerformance(REPORT).score).toBe(100);
  });

  it(`曲线 T_PASS+0.5×间距(${T_PASS_MS + 0.5 * (T_WARN_MS - T_PASS_MS)}ms)→ 80 pass 边界`, () => {
    const ms = T_PASS_MS + 0.5 * (T_WARN_MS - T_PASS_MS);
    writeVitestJson([{ start: 0, end: ms }]);
    const r = collectPerformance(REPORT);
    expect(r.score).toBe(80);
    expect(r.status).toBe('pass');
  });

  it('曲线 =T_WARN_MS 边界 → 60 warn', () => {
    writeVitestJson([{ start: 0, end: T_WARN_MS }]);
    const r = collectPerformance(REPORT);
    expect(r.score).toBe(60);
    expect(r.status).toBe('warn');
  });

  it('曲线 >T_WARN_MS → <60 fail(线性 60→0)', () => {
    writeVitestJson([{ start: 0, end: T_WARN_MS + 0.75 * T_WARN_MS }]); // 60 - 0.75×60 = 15
    const r = collectPerformance(REPORT);
    expect(r.score).toBe(15);
    expect(r.status).toBe('fail');
  });

  it('曲线 极端超时 → 0 fail clamp', () => {
    writeVitestJson([{ start: 0, end: T_WARN_MS * 10 }]);
    const r = collectPerformance(REPORT);
    expect(r.score).toBe(0);
    expect(r.status).toBe('fail');
  });

  it('raw 回填 wallclockMs + testResults', () => {
    writeVitestJson([{ start: 0, end: 5000 }, { start: 1000, end: 6000 }]);
    expect(collectPerformance(REPORT).raw).toMatchObject({ wallclockMs: 6000, testResults: 2 });
  });

  it('文件不存在 → na', () => {
    const r = collectPerformance(resolve(TMP, 'nope.json'));
    expect(r.score).toBe(-1);
    expect(r.status).toBe('na');
  });

  it('json 解析失败 → na', () => {
    writeFileSync(REPORT, '{不是合法 json');
    expect(collectPerformance(REPORT).status).toBe('na');
  });

  it('无 testResults → na', () => {
    writeFileSync(REPORT, JSON.stringify({ numTotalTests: 0 }));
    expect(collectPerformance(REPORT).status).toBe('na');
  });

  it('testResults 缺 startTime/endTime → na', () => {
    writeFileSync(REPORT, JSON.stringify({ testResults: [{ name: 'a' }] }));
    expect(collectPerformance(REPORT).status).toBe('na');
  });

  it('wall-clock 负值(endTime<startTime)→ na', () => {
    writeVitestJson([{ start: 5000, end: 1000 }]);
    expect(collectPerformance(REPORT).status).toBe('na');
  });

  it('超大文件(>10MB)→ na(A1:防撑爆内存)', () => {
    writeFileSync(REPORT, Buffer.alloc(10 * 1024 * 1024 + 1));
    const r = collectPerformance(REPORT);
    expect(r.status).toBe('na');
    expect(r.detail).toContain('too large');
  });
});
