import { describe, it, expect } from 'vitest';
import { renderPrComment } from '../../src/scoring/pr-comment.js';
import { PASS_LINE } from '../../src/scoring/dimensions.js';
import type { ScoreJson } from '../../src/scoring/types.js';

function makeScore(over: Partial<ScoreJson> = {}): ScoreJson {
  return {
    total: 85.8, pass: true, partial: true,
    generatedAt: '2026-06-21T02:06:03.000Z',
    dimensions: {
      integration: { score: 100, weight: 0.3, status: 'pass', raw: {} },
      coverage: { score: 70.2, weight: 0.2, status: 'pass', raw: {} },
      security: { score: 80, weight: 0.2, status: 'pass', raw: {} },
      flaky: { score: -1, weight: 0.1, status: 'na' },
      performance: { score: -1, weight: 0.1, status: 'na' },
      gdscript: { score: -1, weight: 0.1, status: 'na' },
    },
    unverified: ['flaky', 'performance', 'gdscript'],
    hardFails: [],
    ...over,
  };
}

describe('renderPrComment', () => {
  it('pass: 头部 PASS + partial 标注 + 维度表', () => {
    const md = renderPrComment(makeScore());
    expect(md).toContain('85.8');
    expect(md).toContain('✅ PASS');
    expect(md).toContain('3/6 dimensions verified');
    expect(md).toContain('integration');
  });

  it('fail 总分不足:头部 FAIL + reason 含 pass 线', () => {
    const md = renderPrComment(makeScore({ total: 60, pass: false }));
    expect(md).toContain('❌ FAIL');
    expect(md).toContain(`Total score 60 < ${PASS_LINE} (pass line)`);
  });

  it('fail hardFails:硬否决列出', () => {
    const md = renderPrComment(makeScore({
      total: 90, pass: false,
      hardFails: [{ dimension: 'security', reason: '低于硬否决线', threshold: 60, actual: 40 }],
    }));
    expect(md).toContain('Hard veto security');
    expect(md).toContain('40 < 60');
  });

  it('partial(85.8 + 3 维 na)→ 仍 PASS(partial 不阻断)', () => {
    const md = renderPrComment(makeScore());
    expect(md).toContain('✅ PASS');
  });

  it('na 维显示 ⊘ na', () => {
    const md = renderPrComment(makeScore());
    expect(md).toContain('⊘ na');
  });

  it('unknown status fallback(STATUS_ICON 缺 → 原值 pending)', () => {
    // 'pending' 非 DimensionStatus,用 as never 绕过类型测 fallback(测试专用)
    const score = makeScore({
      dimensions: {
        ...makeScore().dimensions,
        integration: { score: 100, weight: 0.3, status: 'pending' as never, raw: {} },
      },
    });
    const md = renderPrComment(score);
    expect(md).toContain('pending');
  });
});
