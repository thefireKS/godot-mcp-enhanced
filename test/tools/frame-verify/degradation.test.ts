import { describe, it, expect } from 'vitest';
import { classifyDegradation, DEGRADATION_THRESHOLDS } from '../../../src/tools/frame-verify/degradation.js';

describe('classifyDegradation', () => {
  // 帧数不足 → 退化
  it('flags degraded when frame count below MIN_FRAMES', () => {
    const r = classifyDegradation({ frameCount: 5, consecutiveSims: [0.9, 0.9, 0.9, 0.9], firstFrameSims: [0.9, 0.9, 0.9, 0.9] });
    expect(r.degraded).toBe(true);
    expect(r.reason).toContain('Not enough frames');
  });

  // 帧全等 → 退化（mean consecutive > 0.998）
  it('flags degraded when all frames identical (mean consecutive > IDENTICAL)', () => {
    const n = 9;
    const consecutive = Array(n - 1).fill(0.999);
    const firstFrame = Array(n - 1).fill(1.0);
    const r = classifyDegradation({ frameCount: n, consecutiveSims: consecutive, firstFrameSims: firstFrame });
    expect(r.degraded).toBe(true);
    expect(r.reason).toContain('Frames identical');
  });

  // 画面从未变化 → 退化（maxChange < 0.002，即 min firstFrameSim > 0.998）
  it('flags degraded when frame never changes (maxChange < NEVER_CHANGE)', () => {
    const n = 9;
    // consecutive 0.97（不全等），但首帧 vs 各帧都 0.999 → maxChange = 0.001 < 0.002
    const consecutive = Array(n - 1).fill(0.97);
    const firstFrame = Array(n - 1).fill(0.999);
    const r = classifyDegradation({ frameCount: n, consecutiveSims: consecutive, firstFrameSims: firstFrame });
    expect(r.degraded).toBe(true);
    expect(r.reason).toContain('never changed');
  });

  // 后半段卡死 → 退化（后 third 个 mean consecutive − 前 third 个 > 0.05）
  it('flags degraded when tail stalls (tail lag > TAIL_LAG)', () => {
    const n = 12;
    // 前 third 个 consecutive=0.80，后 third 个 consecutive=0.99 → tailLag=0.19 > 0.05
    const consecutive = [0.80,0.80,0.80, 0.90,0.90,0.90,0.90, 0.99,0.99,0.99,0.99];
    const firstFrame = [0.5,0.4,0.3,0.25,0.2,0.18,0.16,0.15,0.15,0.15,0.15];
    const r = classifyDegradation({ frameCount: n, consecutiveSims: consecutive, firstFrameSims: firstFrame });
    expect(r.degraded).toBe(true);
    expect(r.reason).toContain('Second half froze');
  });

  // 判据4：超过半数窗口停滞（stallWindowRatio > STALL_RATIO）
  // 规避判据2（meanConsecutive≈0.85<0.998）和判据3（maxChange=0.64>0.002），
  // 让 5 个 7帧窗口中 3 个均值>0.95（ratio=0.6>0.5），判据4 在判据5 前先触发
  it('flags degraded when majority of windows stall (stallWindowRatio > STALL_RATIO)', () => {
    const n = 12;
    const consecutive = [0.30, 0.40, 0.96, 0.97, 0.96, 0.97, 0.96, 0.97, 0.96, 0.97, 0.96];
    const firstFrame = [0.70, 0.50, 0.45, 0.43, 0.42, 0.41, 0.40, 0.39, 0.38, 0.37, 0.36];
    const r = classifyDegradation({ frameCount: n, consecutiveSims: consecutive, firstFrameSims: firstFrame });
    expect(r.degraded).toBe(true);
    expect(r.reason).toContain('windows stalled');
  });

  // 正常运动 → 未退化
  it('passes when frames show healthy motion', () => {
    const n = 12;
    // consecutive 0.6~0.8（适度变化），firstFrame 递减（持续远离首帧）
    const consecutive = [0.75,0.70,0.68,0.72,0.65,0.60,0.58,0.62,0.70,0.66,0.64];
    const firstFrame = [0.75,0.55,0.40,0.30,0.22,0.18,0.15,0.20,0.28,0.25,0.22];
    const r = classifyDegradation({ frameCount: n, consecutiveSims: consecutive, firstFrameSims: firstFrame });
    expect(r.degraded).toBe(false);
    expect(r.reason).toBe('ok');
  });

  // 阈值常量导出可引用
  it('exports threshold constants', () => {
    expect(DEGRADATION_THRESHOLDS.IDENTICAL).toBe(0.998);
    expect(DEGRADATION_THRESHOLDS.WINDOW).toBe(7);
    expect(DEGRADATION_THRESHOLDS.MIN_FRAMES).toBe(9);
  });
});
