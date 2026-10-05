import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, rmSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { collectCoverage } from '../../src/scoring/collectors/coverage.js';

const TMP = resolve(process.cwd(), 'test', 'scoring', '__tmp_lcov__');
const LCOV = resolve(TMP, 'lcov.info');

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
});
afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('collectCoverage', () => {
  it('解析 lcov DA 行:命中/总数 → 百分比', () => {
    // 4 行,2 行命中 → 50%
    writeFileSync(LCOV, [
      'TN:',
      'SF:src/foo.ts',
      'DA:1,3',
      'DA:2,0',
      'DA:3,5',
      'DA:4,0',
      'LF:4',
      'LH:2',
      'end_of_record',
    ].join('\n'));
    const r = collectCoverage(LCOV);
    expect(r.score).toBe(50);
    expect(r.status).toBe('warn');   // 50 ∈ [40,60) → warn
    expect(r.raw).toMatchObject({ hit: 2, found: 4 });
  });

  it('100% 覆盖 → score=100, status=pass', () => {
    writeFileSync(LCOV, ['SF:src/bar.ts', 'DA:1,1', 'DA:2,2', 'end_of_record'].join('\n'));
    const r = collectCoverage(LCOV);
    expect(r.score).toBe(100);
    expect(r.status).toBe('pass');
  });

  it('低覆盖(< 40)→ status=fail', () => {
    writeFileSync(LCOV, ['SF:x', 'DA:1,0', 'DA:2,0', 'DA:3,1', 'DA:4,0', 'DA:5,0', 'end_of_record'].join('\n'));
    const r = collectCoverage(LCOV);
    expect(r.score).toBe(20);
    expect(r.status).toBe('fail');
  });

  it('文件不存在 → status=na, score=-1', () => {
    const r = collectCoverage(resolve(TMP, 'nope.info'));
    expect(r.score).toBe(-1);
    expect(r.status).toBe('na');
  });

  it('无 DA 行 → na', () => {
    writeFileSync(LCOV, ['SF:empty.ts', 'end_of_record'].join('\n'));
    const r = collectCoverage(LCOV);
    expect(r.status).toBe('na');
  });

  it('超大文件(>10MB)→ na(A1:防撑爆内存)', () => {
    writeFileSync(LCOV, Buffer.alloc(10 * 1024 * 1024 + 1));
    const r = collectCoverage(LCOV);
    expect(r.status).toBe('na');
    expect(r.detail).toContain('too large');
  });
});
