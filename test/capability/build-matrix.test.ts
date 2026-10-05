import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'url';
import { registerAllModules } from '../../src/module-loader.js';
import { extractCapabilities } from '../../src/capability/extract.js';
import { buildMarkdown } from '../../src/capability/build-matrix.js';

const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));

describe('buildMarkdown token budget', () => {
  it('includes token budget summary line and TOP 5 section', () => {
    registerAllModules();
    const caps = extractCapabilities(PROJECT_ROOT);
    const md = buildMarkdown(caps);
    expect(md).toContain('Token budget: tools/list');
    expect(md).toContain('## Token budget TOP 5');
    // TOP5 必含体积最大的工具
    const top = [...caps].sort((a, b) => b.size.totalBytes - a.size.totalBytes)[0]!;
    expect(md).toContain(`\`${top.name}\``);
    // schema 占比百分比存在
    expect(md).toMatch(/schema is \d+%/);
  });
});

// P1-2: annotations 进 matrix —— 派生 hint 落到每条 cap 记录
describe('P1-2 annotations in capability matrix', () => {
  it('every cap record has annotations with three boolean hints', () => {
    registerAllModules();
    const caps = extractCapabilities(PROJECT_ROOT);
    const missing = caps.filter(
      c =>
        !c.annotations ||
        typeof c.annotations.readOnlyHint !== 'boolean' ||
        typeof c.annotations.destructiveHint !== 'boolean' ||
        typeof c.annotations.idempotentHint !== 'boolean',
    );
    expect(
      missing.map(c => c.name),
      `caps missing annotations: ${missing.map(c => c.name).join(', ')}`,
    ).toEqual([]);
  });

  it('pure-write tool (particles) is flagged idempotentHint=true (P1-1 rule)', () => {
    registerAllModules();
    const caps = extractCapabilities(PROJECT_ROOT);
    const particles = caps.find(c => c.name === 'particles');
    expect(particles, 'particles tool should exist').toBeDefined();
    // P1-1: 纯写工具（全部 write,无 destructive/process）判幂等
    expect(particles!.annotations!.idempotentHint).toBe(true);
    expect(particles!.annotations!.readOnlyHint).toBe(false);
    expect(particles!.annotations!.destructiveHint).toBe(false);
  });

  it('buildMarkdown includes annotations summary line', () => {
    registerAllModules();
    const caps = extractCapabilities(PROJECT_ROOT);
    const md = buildMarkdown(caps);
    expect(md).toMatch(/annotations: readOnly \d+ \/ destructive \d+ \/ idempotent \d+/);
  });
});
