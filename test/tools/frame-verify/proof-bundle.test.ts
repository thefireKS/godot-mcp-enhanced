import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createProofRun, archiveFrame, writeMetrics, cleanupProofRun, recordFrameBytes, MAX_PROOF_BYTES } from '../../../src/tools/frame-verify/proof-bundle.js';

describe('proof-bundle', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('createProofRun creates proof/<runId>/ under project', () => {
    const run = createProofRun(tmp);
    expect(run.runId).toMatch(/^run_\d+_[0-9a-f-]{36}$/);
    expect(fs.existsSync(run.dir)).toBe(true);
    expect(run.dir.startsWith(path.join(tmp, 'proof'))).toBe(true);
  });

  it('archiveFrame writes frame_00.png with zero-padded index', () => {
    const run = createProofRun(tmp);
    const rel = archiveFrame(run, 0, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const abs = path.join(run.dir, 'frame_00.png');
    expect(fs.existsSync(abs)).toBe(true);
    expect(rel).toBe('frame_00.png');
  });

  it('archiveFrame pads to 2 digits', () => {
    const run = createProofRun(tmp);
    archiveFrame(run, 12, Buffer.from('x'));
    expect(fs.existsSync(path.join(run.dir, 'frame_12.png'))).toBe(true);
  });

  it('writeMetrics writes metrics.json', () => {
    const run = createProofRun(tmp);
    const rel = writeMetrics(run, { degraded: false, meanConsecutive: 0.7 });
    const abs = path.join(run.dir, 'metrics.json');
    expect(fs.existsSync(abs)).toBe(true);
    expect(JSON.parse(fs.readFileSync(abs, 'utf-8')).degraded).toBe(false);
    expect(rel).toBe('metrics.json');
  });

  it('two runs get distinct runIds', () => {
    const a = createProofRun(tmp);
    const b = createProofRun(tmp);
    expect(a.runId).not.toBe(b.runId);
  });

  it('同毫秒两次 run 仍得不同 runId(Date.now 碰撞防护)', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    const a = createProofRun(tmp);
    const b = createProofRun(tmp);
    expect(a.runId).not.toBe(b.runId);
    vi.restoreAllMocks();
  });

  it('archiveFrame 超 100MB 配额抛错(B3:防撑爆磁盘)', () => {
    const run = createProofRun(tmp);
    run.bytes = 100 * 1024 * 1024; // 已满配额
    expect(() => archiveFrame(run, 0, Buffer.from([1]))).toThrow(/quota exceeded/);
  });

  it('cleanupProofRun 删除 run 目录(B1:验证后回收)', () => {
    const run = createProofRun(tmp);
    archiveFrame(run, 0, Buffer.from('x'));
    expect(fs.existsSync(run.dir)).toBe(true);
    cleanupProofRun(run);
    expect(fs.existsSync(run.dir)).toBe(false);
  });

  it('recordFrameBytes 累计已写文件字节,超配额抛错(B3:frame_sequence GDScript 直写路径)', () => {
    const run = createProofRun(tmp);
    const f = path.join(run.dir, 'frame_00.png');
    fs.writeFileSync(f, Buffer.alloc(1024));
    recordFrameBytes(run, f);
    expect(run.bytes).toBe(1024);
    // 预填到配额边缘,再 record 一个超限文件 → 抛错
    run.bytes = MAX_PROOF_BYTES;
    expect(() => recordFrameBytes(run, f)).toThrow(/quota exceeded/);
  });
});
