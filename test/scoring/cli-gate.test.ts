import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { resolve } from 'path';
import { writeFileSync, mkdirSync, rmSync } from 'fs';

// spawn 跑编译产物 build/scoring/cli.js(测试前须先 npm run build)
const CLI = resolve(process.cwd(), 'build', 'scoring', 'cli.js');
const TMP = resolve(process.cwd(), 'test', 'scoring', '__tmp_gate__');

function runGate(cwd: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, 'gate'], { encoding: 'utf8', cwd });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe('cli gate (exit code)', () => {
  it('score.json 不存在 → exit 1 + stderr 提示', () => {
    const dir = resolve(TMP, 'no_score');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const r = runGate(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('does not exist');
  });

  it('score.json 损坏 → exit 1 + stderr 解析失败', () => {
    const dir = resolve(TMP, 'broken');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(resolve(dir, 'coverage'), { recursive: true });
    writeFileSync(resolve(dir, 'coverage/score.json'), '{不是合法 json');
    const r = runGate(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Failed to parse');
  });

  it('score.json pass → exit 0 + stdout 通过', () => {
    const dir = resolve(TMP, 'ok');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(resolve(dir, 'coverage'), { recursive: true });
    writeFileSync(
      resolve(dir, 'coverage/score.json'),
      JSON.stringify({
        total: 85.8, pass: true, partial: true, generatedAt: 't',
        dimensions: {}, unverified: [], hardFails: [],
      }),
    );
    const r = runGate(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('passed');
  });
});
