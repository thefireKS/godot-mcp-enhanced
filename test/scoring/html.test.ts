import { describe, it, expect } from 'vitest';
import { renderScoreHtml, escapeHtml } from '../../src/scoring/html.js';
import type { ScoreJson } from '../../src/scoring/types.js';

function makeScore(over: Partial<ScoreJson> = {}): ScoreJson {
  return {
    total: 85.8, pass: true, partial: true,
    generatedAt: '2026-06-22T03:00:00.000Z',
    dimensions: {
      integration: { score: 100, weight: 0.3, status: 'pass', raw: { passed: 44, ran: 45 } },
      coverage: { score: 70.2, weight: 0.2, status: 'pass', raw: { hit: 7945, found: 11325, pct: 70.154 } },
      security: { score: 80, weight: 0.2, status: 'pass', raw: { high: 2, critical: 0, deduction: 20 } },
      flaky: { score: -1, weight: 0.1, status: 'na' },
      performance: { score: -1, weight: 0.1, status: 'na' },
      gdscript: { score: 90, weight: 0.1, status: 'pass', raw: { errors: 0, warnings: 5 } },
    },
    unverified: ['flaky', 'performance'],
    hardFails: [],
    ...over,
  };
}

describe('escapeHtml', () => {
  it('五字符各转', () => {
    expect(escapeHtml('&')).toBe('&amp;');
    expect(escapeHtml('<')).toBe('&lt;');
    expect(escapeHtml('>')).toBe('&gt;');
    expect(escapeHtml('"')).toBe('&quot;');
    expect(escapeHtml("'")).toBe('&#39;');
  });

  it('& 先转(防 &lt; 二次转义 &amp;lt;)', () => {
    expect(escapeHtml('<')).toBe('&lt;');           // 非 &amp;lt;
    expect(escapeHtml('&')).toBe('&amp;');          // 单独 & → &amp;
  });

  it('混合串全转义无二次', () => {
    expect(escapeHtml('a < b & c > d "e" \'f\'')).toBe('a &lt; b &amp; c &gt; d &quot;e&quot; &#39;f&#39;');
  });

  it('空字符串', () => {
    expect(escapeHtml('')).toBe('');
  });
});

describe('renderScoreHtml', () => {
  it('自包含:DOCTYPE 开头 + 内联 <style>', () => {
    const html = renderScoreHtml(makeScore());
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<style>');
    expect(html).toContain('</style>');
  });

  it('头部含总分 + PASS 徽章 + generatedAt', () => {
    const html = renderScoreHtml(makeScore());
    expect(html).toContain('85.8');
    expect(html).toContain('PASS');
    expect(html).toContain('2026-06-22T03:00:00.000Z');
  });

  it('fail 时 FAIL 徽章', () => {
    const html = renderScoreHtml(makeScore({ total: 50, pass: false }));
    expect(html).toContain('FAIL');
  });

  it('维度表含 6 维 + gdscript 关键指标', () => {
    const html = renderScoreHtml(makeScore());
    for (const name of ['integration', 'coverage', 'security', 'flaky', 'performance', 'gdscript']) {
      expect(html).toContain(name);
    }
    expect(html).toContain('0 err / 5 warn');
  });

  it('status 白名单映射 class(pass/warn/fail/na)', () => {
    const html = renderScoreHtml(makeScore());
    expect(html).toContain('status-pass');
    expect(html).toContain('status-na');
  });

  it('HTML 转义(XSS 防护):detail 含 <script> → &lt;script&gt;', () => {
    const html = renderScoreHtml(makeScore({
      dimensions: { ...makeScore().dimensions,
        gdscript: { score: 0, weight: 0.1, status: 'fail', raw: { errors: 1, warnings: 0, detailsTotal: 1, details: ['cmd.gd:1 <script>alert(1)</script>'] } } },
      hardFails: [{ dimension: 'gdscript', reason: 'errors>0', threshold: 60, actual: 0 }],
    }));
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>alert');   // 不含原始未转义
  });

  it('status 异常值(属性注入防护)→ status-unknown,不含原 " </ <', () => {
    const html = renderScoreHtml(makeScore({
      dimensions: { ...makeScore().dimensions,
        gdscript: { score: 90, weight: 0.1, status: 'fail"><img src=x onerror=alert(1)>' as never, raw: { errors: 0, warnings: 0 } } },
    }));
    expect(html).toContain('status-unknown');      // 白名单 fallback
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('<img');
  });

  it('& 顺序锁:generatedAt 含 & → &amp;(不二次)', () => {
    const html = renderScoreHtml(makeScore({ generatedAt: 'a&b' }));
    expect(html).toContain('a&amp;b');
    expect(html).not.toContain('a&amp;amp;');
  });

  it('硬否决/未验证渲染', () => {
    const html = renderScoreHtml(makeScore());
    expect(html).toContain('Hard vetoes');
    expect(html).toContain('Unverified');
    expect(html).toContain('flaky, performance');
  });
});
