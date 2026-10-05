import { describe, it, expect } from 'vitest';
import { renderScoreReport } from '../../src/scoring/report.js';
import type { ScoreJson } from '../../src/scoring/types.js';

/** 构造完整 3 维有值 + 3 维 na 的 fixture(对齐 score.json 实测结构) */
function makeScore(over: Partial<ScoreJson> = {}): ScoreJson {
  return {
    total: 85.8,
    pass: true,
    partial: true,
    generatedAt: '2026-06-21T02:06:03.000Z',
    dimensions: {
      integration: { score: 100, weight: 0.3, status: 'pass', raw: { passed: 44, failed: 1, pending: 2, total: 47, ran: 45 } },
      coverage: { score: 70.2, weight: 0.2, status: 'pass', raw: { hit: 7945, found: 11325, pct: 70.15452538631347 } },
      security: { score: 80, weight: 0.2, status: 'pass', raw: { info: 0, low: 0, moderate: 0, high: 2, critical: 0, total: 2, deduction: 20 } },
      flaky: { score: -1, weight: 0.1, status: 'na' },
      performance: { score: -1, weight: 0.1, status: 'na' },
      gdscript: { score: -1, weight: 0.1, status: 'na' },
    },
    unverified: ['flaky', 'performance', 'gdscript'],
    hardFails: [],
    ...over,
  };
}

describe('renderScoreReport', () => {
  it('头部含总分 + PASS 徽章 + generatedAt', () => {
    const md = renderScoreReport(makeScore());
    expect(md).toContain('85.8');
    expect(md).toContain('PASS');
    expect(md).toContain('2026-06-21T02:06:03.000Z');
  });

  it('fail 时显示 FAIL 徽章', () => {
    const md = renderScoreReport(makeScore({ total: 50, pass: false }));
    expect(md).toContain('FAIL');
  });

  it('integration 关键指标用 ran(44/45 passed, 非 total;区分 ran=45 与 total=47)', () => {
    const md = renderScoreReport(makeScore());
    expect(md).toContain('44/45 passed');
  });

  it('coverage 指标含 pct(round1) + hit/found', () => {
    const md = renderScoreReport(makeScore());
    expect(md).toContain('70.2%');
    expect(md).toContain('7945/11325');
  });

  it('security 指标含 high 计数 + deduction', () => {
    const md = renderScoreReport(makeScore());
    expect(md).toContain('2 high/critical');
    expect(md).toContain('-20');
  });

  it('na 维显示"未接入"', () => {
    const md = renderScoreReport(makeScore());
    expect(md).toContain('Not wired');
  });

  it('hardFails 非空时列出', () => {
    const md = renderScoreReport(makeScore({
      pass: false,
      hardFails: [{ dimension: 'security', reason: '低于硬否决线', threshold: 60, actual: 40 }],
    }));
    expect(md).toContain('Hard vetoes');
    expect(md).toContain('security');
    expect(md).toContain('40 < 60');
  });

  it('未验证维度列出 + 标注 M3c-e', () => {
    const md = renderScoreReport(makeScore());
    expect(md).toContain('flaky, performance, gdscript — wired in M3c-e');
  });

  it('gdscript 有值时关键指标显示 err/warn 计数', () => {
    const md = renderScoreReport(makeScore({
      dimensions: {
        ...makeScore().dimensions,
        gdscript: { score: 90, weight: 0.1, status: 'pass',
                    raw: { errors: 0, warnings: 5, files: 19, details: [], detailsTotal: 5 } },
      },
      unverified: ['flaky', 'performance'],
    }));
    expect(md).toContain('0 err / 5 warn');
  });

  it('gdscript incomplete(score=0)仍显示 0 err / 0 warn', () => {
    const md = renderScoreReport(makeScore({
      dimensions: {
        ...makeScore().dimensions,
        gdscript: { score: 0, weight: 0.1, status: 'fail',
                    raw: { errors: 0, warnings: 0, files: 5, details: [], detailsTotal: 0, incomplete: true } },
      },
      unverified: ['flaky', 'performance'],
    }));
    expect(md).toContain('0 err / 0 warn');
  });

  it('hardFails reason 含表格分隔符 | 被转义(A2:防破坏表格结构)', () => {
    const BS = String.fromCharCode(92);
    const md = renderScoreReport(makeScore({
      pass: false,
      hardFails: [{ dimension: 'security', reason: 'a|b', threshold: 60, actual: 40 }],
    }));
    // | 被转义为反斜杠+管道;原样 a|b 不出现(否则增加表格列数)
    expect(md).toContain('a' + BS + '|b');
    expect(md).not.toContain('a|b');
  });
});
