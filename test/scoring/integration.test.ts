import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, rmSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { collectIntegration } from '../../src/scoring/collectors/integration.js';

const TMP = resolve(process.cwd(), 'test', 'scoring', '__tmp_e2e__');
const JSON_PATH = resolve(TMP, 'e2e-report.json');

beforeEach(() => mkdirSync(TMP, { recursive: true }));
afterEach(() => rmSync(TMP, { recursive: true, force: true }));

/** 写一个最小合法 vitest json(reporter=json)结构,覆盖指定计数字段 */
function writeReport(fields: Record<string, number>): void {
  writeFileSync(JSON_PATH, JSON.stringify({
    numTotalTestSuites: 1, numPassedTestSuites: 0, numFailedTestSuites: 0,
    numPendingTestSuites: 0, startTime: 0, success: true, testResults: [],
    numTotalTests: 0, numPassedTests: 0, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0,
    ...fields,
  }));
}

describe('collectIntegration', () => {
  it('全通过 → score=100, status=pass', () => {
    writeReport({ numTotalTests: 40, numPassedTests: 40, numFailedTests: 0, numPendingTests: 0 });
    const r = collectIntegration(JSON_PATH);
    expect(r.score).toBe(100);
    expect(r.status).toBe('pass');
    expect(r.raw).toMatchObject({ passed: 40, failed: 0, ran: 40 });
  });

  it('部分失败 → 通过率 = passed/(passed+failed),排除 pending', () => {
    // 40 passed, 10 failed, 5 skip → 40/50 = 80
    writeReport({ numTotalTests: 55, numPassedTests: 40, numFailedTests: 10, numPendingTests: 5 });
    const r = collectIntegration(JSON_PATH);
    expect(r.score).toBe(80);
    expect(r.status).toBe('pass');
    expect(r.raw).toMatchObject({ passed: 40, failed: 10, pending: 5, ran: 50 });
  });

  it('[60,80) → status=warn', () => {
    // 35 passed, 15 failed → 70
    writeReport({ numTotalTests: 50, numPassedTests: 35, numFailedTests: 15, numPendingTests: 0 });
    const r = collectIntegration(JSON_PATH);
    expect(r.score).toBe(70);
    expect(r.status).toBe('warn');
  });

  it('低通过率(<60)→ status=fail', () => {
    // 20 passed, 30 failed → 40
    writeReport({ numTotalTests: 50, numPassedTests: 20, numFailedTests: 30, numPendingTests: 0 });
    const r = collectIntegration(JSON_PATH);
    expect(r.score).toBe(40);
    expect(r.status).toBe('fail');
  });

  it('全 skip(passed+failed==0,如本地无 Godot)→ na,不虚高分', () => {
    writeReport({ numTotalTests: 46, numPassedTests: 0, numFailedTests: 0, numPendingTests: 46 });
    const r = collectIntegration(JSON_PATH);
    expect(r.score).toBe(-1);
    expect(r.status).toBe('na');
  });

  it('文件不存在 → na', () => {
    const r = collectIntegration(resolve(TMP, 'nope.json'));
    expect(r.score).toBe(-1);
    expect(r.status).toBe('na');
  });

  it('json 解析失败 → na', () => {
    writeFileSync(JSON_PATH, '{不是合法 json');
    const r = collectIntegration(JSON_PATH);
    expect(r.score).toBe(-1);
    expect(r.status).toBe('na');
  });

  it('超大文件(>10MB)→ na(A1:防撑爆内存)', () => {
    writeFileSync(JSON_PATH, Buffer.alloc(10 * 1024 * 1024 + 1));
    const r = collectIntegration(JSON_PATH);
    expect(r.status).toBe('na');
    expect(r.detail).toContain('too large');
  });

  it('计数字段非数字类型 → na(A3:防污染致通过率 NaN)', () => {
    writeFileSync(JSON_PATH, JSON.stringify({
      numTotalTests: 40, numPassedTests: 'corrupt', numFailedTests: 0, numPendingTests: 0,
    }));
    const r = collectIntegration(JSON_PATH);
    expect(r.status).toBe('na');
    expect(r.detail).toContain('wrong type');
  });
});
