import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, rmSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { collectSecurity } from '../../src/scoring/collectors/security.js';

const TMP = resolve(process.cwd(), 'test', 'scoring', '__tmp_audit__');
const AUDIT = resolve(TMP, 'audit.json');

beforeEach(() => mkdirSync(TMP, { recursive: true }));
afterEach(() => rmSync(TMP, { recursive: true, force: true }));

/** 写 audit.json,metadata.vulnerabilities 用给定 severity 计数 */
function writeAudit(sev: Record<string, number>): void {
  writeFileSync(AUDIT, JSON.stringify({
    auditReportVersion: 2,
    vulnerabilities: {},
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0, ...sev } },
  }));
}

describe('collectSecurity', () => {
  it('0 漏洞 → score=100, status=pass', () => {
    writeAudit({ total: 0 });
    const r = collectSecurity(AUDIT);
    expect(r.score).toBe(100);
    expect(r.status).toBe('pass');
  });

  it('2 high(enhanced 现状)→ 100-20=80, status=pass', () => {
    writeAudit({ high: 2, total: 2 });
    const r = collectSecurity(AUDIT);
    expect(r.score).toBe(80);
    expect(r.status).toBe('pass');
    expect(r.raw).toMatchObject({ high: 2, total: 2 });
  });

  it('1 critical → 100-30=70, status=warn', () => {
    writeAudit({ critical: 1, total: 1 });
    const r = collectSecurity(AUDIT);
    expect(r.score).toBe(70);
    expect(r.status).toBe('warn');
  });

  it('2 critical → 100-60=40, status=fail(< 60 硬否决线)', () => {
    writeAudit({ critical: 2, total: 2 });
    const r = collectSecurity(AUDIT);
    expect(r.score).toBe(40);
    expect(r.status).toBe('fail');
  });

  it('1 critical + 3 high → 100-30-30=40, fail', () => {
    writeAudit({ critical: 1, high: 3, total: 4 });
    const r = collectSecurity(AUDIT);
    expect(r.score).toBe(40);
    expect(r.status).toBe('fail');
  });

  it('混合 severity 扣分:1 critical+1 high+2 moderate+1 low → 100-30-10-10-2=48', () => {
    writeAudit({ critical: 1, high: 1, moderate: 2, low: 1, total: 5 });
    const r = collectSecurity(AUDIT);
    expect(r.score).toBe(48);
  });

  it('扣分不低于 0(极端:5 critical → 100-150 → clamp 0)', () => {
    writeAudit({ critical: 5, total: 5 });
    const r = collectSecurity(AUDIT);
    expect(r.score).toBe(0);
    expect(r.status).toBe('fail');
  });

  it('文件不存在 → na', () => {
    const r = collectSecurity(resolve(TMP, 'nope.json'));
    expect(r.score).toBe(-1);
    expect(r.status).toBe('na');
  });

  it('json 解析失败 → na', () => {
    writeFileSync(AUDIT, '{不是合法 json');
    const r = collectSecurity(AUDIT);
    expect(r.score).toBe(-1);
    expect(r.status).toBe('na');
  });

  it('超大文件(>10MB)→ na(A1:防撑爆内存)', () => {
    writeFileSync(AUDIT, Buffer.alloc(10 * 1024 * 1024 + 1));
    const r = collectSecurity(AUDIT);
    expect(r.status).toBe('na');
    expect(r.detail).toContain('too large');
  });

  it('severity 字段非数字类型 → na(A3:防污染致扣分 NaN)', () => {
    writeFileSync(AUDIT, JSON.stringify({
      auditReportVersion: 2, vulnerabilities: {},
      metadata: { vulnerabilities: { high: 'corrupt', total: 2 } },
    }));
    const r = collectSecurity(AUDIT);
    expect(r.status).toBe('na');
    expect(r.detail).toContain('wrong type');
  });
});
