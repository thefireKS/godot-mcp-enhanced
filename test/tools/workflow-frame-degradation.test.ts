import { describe, it, expect } from 'vitest';
import { extractFrameMetricsScript } from '../../src/tools/frame-verify/gdscripts.js';
import { classifyDegradation } from '../../src/tools/frame-verify/degradation.js';
import { createProofRun } from '../../src/tools/frame-verify/proof-bundle.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('frame_degradation 端到端契约（脚本生成 + 判据）', () => {
  it('生成的 GDScript 输出 consecutive_sims/first_frame_sims，classifyDegradation 能消费', () => {
    const script = extractFrameMetricsScript('user://proof/run_x');
    // 脚本必须输出这三个 key（后两个为 JSON 字符串）
    expect(script).toContain('"consecutive_sims"');
    expect(script).toContain('"first_frame_sims"');
    expect(script).toContain('"frame_count"');
  });

  it('GDScript 返回的 metrics 喂给 classifyDegradation 能正确判定退化', () => {
    // 模拟 GDScript 对 9 张全等帧返回的 metrics
    const consecutive = Array(8).fill(0.999);
    const firstFrame = Array(8).fill(1.0);
    const r = classifyDegradation({ frameCount: 9, consecutiveSims: consecutive, firstFrameSims: firstFrame });
    expect(r.degraded).toBe(true);
  });

  it('正常运动帧的 metrics 判定为不退化', () => {
    const consecutive = [0.75, 0.70, 0.68, 0.72, 0.65, 0.60, 0.58, 0.62];
    const firstFrame = [0.75, 0.55, 0.40, 0.30, 0.22, 0.18, 0.15, 0.20];
    const r = classifyDegradation({ frameCount: 9, consecutiveSims: consecutive, firstFrameSims: firstFrame });
    expect(r.degraded).toBe(false);
  });

  // ── 三条辅助判据的独立触发测试（行动项2:补测试缺口）──
  // classifyDegradation 有 4 条判据,此前的测试只覆盖了第 1 条(IDENTICAL/全等帧)的正例。
  // 下面 3 个 case 各自只触发目标判据(其余判据指标落在安全区),证明判据逻辑与阈值正确,
  // 防止重构悄悄破坏某条判据而 CI 仍绿。数据为合成的边界值(隔离测单条规则),非真实帧序列。

  it('NEVER_CHANGE: 画面从未变化(maxChange<0.002) → 退化', () => {
    // firstFrame 全 0.999 → maxChange=0.001<0.002 触发;
    // consecutive 全 0.90 → mean 0.90 避 IDENTICAL(0.998)、窗口 mean 0.90 避 STALL(0.95)、tailLag=0 避 TAIL_LAG
    const consecutive = Array(8).fill(0.90);
    const firstFrame = Array(8).fill(0.999);
    const r = classifyDegradation({ frameCount: 9, consecutiveSims: consecutive, firstFrameSims: firstFrame });
    expect(r.degraded).toBe(true);
    expect(r.reason).toContain('never changed');
  });

  it('STALL_RATIO: 中段大面积停滞(超半数窗口) → 退化', () => {
    // frameCount=16, consecutive 长 15, 窗口(win=7)共 9 个, 中段 i=2..6 共 5 窗口停滞 → ratio 5/9≈0.56>0.5 触发;
    // 头尾各置 0.3 运动段 → tailLag≈0 避 TAIL_LAG; 整体 mean≈0.79 避 IDENTICAL; firstFrame 全 0.3 → maxChange=0.7 避 NEVER_CHANGE
    const consecutive = [0.3, 0.3, 0.97, 0.97, 0.97, 0.97, 0.97, 0.97, 0.97, 0.97, 0.97, 0.97, 0.97, 0.3, 0.3];
    const firstFrame = Array(15).fill(0.3);
    const r = classifyDegradation({ frameCount: 16, consecutiveSims: consecutive, firstFrameSims: firstFrame });
    expect(r.degraded).toBe(true);
    expect(r.reason).toContain('stalled');
  });

  it('TAIL_LAG: 后段冻结(后1/3 consecutive 远高于前1/3) → 退化', () => {
    // frameCount=16, 前 5 帧 consecutive 0.3(运动), 后 10 帧 0.97(冻结);
    // 停滞窗口仅 4/9≈0.44 避 STALL_RATIO; tailLag=0.97-0.3=0.67>0.05 触发; mean≈0.75 避 IDENTICAL; maxChange=0.7 避 NEVER_CHANGE
    const consecutive = [0.3, 0.3, 0.3, 0.3, 0.3, 0.97, 0.97, 0.97, 0.97, 0.97, 0.97, 0.97, 0.97, 0.97, 0.97];
    const firstFrame = Array(15).fill(0.3);
    const r = classifyDegradation({ frameCount: 16, consecutiveSims: consecutive, firstFrameSims: firstFrame });
    expect(r.degraded).toBe(true);
    expect(r.reason).toContain('Second half');
  });
});

describe('proof-bundle createProofRun 集成（frame_sequence 归档目标）', () => {
  it('createProofRun 在项目内创建 proof/<runId>/ 目录', () => {
    const tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-proof-'));
    try {
      const run = createProofRun(tmpProject);
      expect(run.runId).toMatch(/^run_\d+_[0-9a-f-]{36}$/);
      expect(run.dir).toContain('proof');
      expect(fs.existsSync(run.dir)).toBe(true);
      expect(run.dir.startsWith(tmpProject)).toBe(true);
    } finally {
      fs.rmSync(tmpProject, { recursive: true, force: true });
    }
  });
});
