import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, rmSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { collectGdscript } from '../../src/scoring/collectors/gdscript.js';

const TMP = resolve(process.cwd(), 'test', 'scoring', '__tmp_gdscript__');
const REPORT = resolve(TMP, 'gdscript-report.json');

beforeEach(() => mkdirSync(TMP, { recursive: true }));
afterEach(() => rmSync(TMP, { recursive: true, force: true }));

function writeReport(data: object): void {
  writeFileSync(REPORT, JSON.stringify(data));
}

describe('collectGdscript', () => {
  it('0 errors 0 warnings → 100, pass', () => {
    writeReport({ errors: 0, warnings: 0, files: 19, details: [], detailsTotal: 0 });
    const r = collectGdscript(REPORT);
    expect(r.score).toBe(100);
    expect(r.status).toBe('pass');
  });

  it('0 errors 10 warnings(×2) → 100-20=80, pass', () => {
    writeReport({ errors: 0, warnings: 10, files: 19, details: [], detailsTotal: 10 });
    expect(collectGdscript(REPORT).score).toBe(80);
  });

  it('0 errors 20 warnings → 60, warn(边界)', () => {
    writeReport({ errors: 0, warnings: 20, files: 19, details: [], detailsTotal: 20 });
    const r = collectGdscript(REPORT);
    expect(r.score).toBe(60);
    expect(r.status).toBe('warn');
  });

  it('0 errors 21 warnings → 58, fail(<60 硬否决)', () => {
    writeReport({ errors: 0, warnings: 21, files: 19, details: [], detailsTotal: 21 });
    const r = collectGdscript(REPORT);
    expect(r.score).toBe(58);
    expect(r.status).toBe('fail');
  });

  it('1 error → score=0(归零硬否决), fail', () => {
    writeReport({ errors: 1, warnings: 0, files: 19, details: ['cmd.gd:1 Parse Error'], detailsTotal: 1 });
    const r = collectGdscript(REPORT);
    expect(r.score).toBe(0);
    expect(r.status).toBe('fail');
  });

  it('3 errors + 5 warnings → score=0(errors 归零优先于 warnings 渐进)', () => {
    writeReport({ errors: 3, warnings: 5, files: 19, details: [], detailsTotal: 8 });
    expect(collectGdscript(REPORT).score).toBe(0);
  });

  it('incomplete:true 优先于 errors → score=0 fail(检查不完整则 errors 不可信)', () => {
    writeReport({ errors: 3, warnings: 0, files: 5, details: [], detailsTotal: 3, incomplete: true, reason: 'files 不足' });
    const r = collectGdscript(REPORT);
    expect(r.score).toBe(0);
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('Check incomplete');
    expect((r.raw as { incomplete: boolean }).incomplete).toBe(true);
  });

  it('扣分 clamp 0(60 warnings ×2=120)', () => {
    writeReport({ errors: 0, warnings: 60, files: 19, details: [], detailsTotal: 60 });
    const r = collectGdscript(REPORT);
    expect(r.score).toBe(0);
    expect(r.status).toBe('fail');
  });

  it('raw.detailsTotal = errors + warnings(非 details.length)', () => {
    writeReport({ errors: 2, warnings: 3, files: 19, details: ['a', 'b'], detailsTotal: 5 });
    expect(collectGdscript(REPORT).raw).toMatchObject({ errors: 2, warnings: 3, files: 19, detailsTotal: 5 });
  });

  it('文件不存在 → na', () => {
    const r = collectGdscript(resolve(TMP, 'nope.json'));
    expect(r.score).toBe(-1);
    expect(r.status).toBe('na');
  });

  it('json 解析失败 → na', () => {
    writeFileSync(REPORT, '{不是合法 json');
    const r = collectGdscript(REPORT);
    expect(r.score).toBe(-1);
    expect(r.status).toBe('na');
  });

  it('缺 errors/warnings 字段 → na', () => {
    writeReport({ files: 19, details: [] });
    const r = collectGdscript(REPORT);
    expect(r.score).toBe(-1);
    expect(r.status).toBe('na');
  });

  it('超大文件(>10MB)→ na(A1:防撑爆内存)', () => {
    writeFileSync(REPORT, Buffer.alloc(10 * 1024 * 1024 + 1));
    const r = collectGdscript(REPORT);
    expect(r.status).toBe('na');
    expect(r.detail).toContain('too large');
  });
});
