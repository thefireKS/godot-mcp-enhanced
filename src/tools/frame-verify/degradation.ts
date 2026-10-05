// 帧退化判据引擎 —— 纯函数，无 GDScript / 无文件系统依赖。
// 阈值来源：D:\GitHub\godogen（capture.md:229, find_loop_frame.py:40-86）

export const DEGRADATION_THRESHOLDS = {
  IDENTICAL: 0.998,      // 逐帧相似度均值 > 此值 = 帧全等
  NEVER_CHANGE: 0.002,   // maxChange = 1 - min(firstFrameSim) < 此值 = 从未变化
  STALL: 0.95,           // 窗口均值 > 此值 = 局部停滞
  STALL_RATIO: 0.5,      // 停滞窗口占比 > 此值 = 退化
  TAIL_LAG: 0.05,        // 后1/3 - 前1/3 的 consecutive 均值差 > 此值 = 后半段卡死
  WINDOW: 7,             // 滑动窗口大小（与 find_loop_frame 一致）
  MIN_FRAMES: 9,         // 最小帧数（WINDOW + 2 边界）
} as const;

export interface FrameMetrics {
  frameCount: number;
  consecutiveSims: number[];   // 长度 = frameCount - 1
  firstFrameSims: number[];    // 长度 = frameCount - 1
}

export interface DegradationResult {
  degraded: boolean;
  reason: string;
  metrics: {
    meanConsecutive: number;
    maxChange: number;
    stallWindowRatio: number;
    tailLag: number;
  };
}

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

export function classifyDegradation(m: FrameMetrics): DegradationResult {
  const T = DEGRADATION_THRESHOLDS;
  const empty: DegradationResult['metrics'] = { meanConsecutive: 0, maxChange: 0, stallWindowRatio: 0, tailLag: 0 };

  if (m.frameCount < T.MIN_FRAMES) {
    return { degraded: true, reason: `Not enough frames (${m.frameCount} < ${T.MIN_FRAMES})`, metrics: empty };
  }

  const meanConsecutive = mean(m.consecutiveSims);
  const minFirstSim = m.firstFrameSims.length > 0 ? Math.min(...m.firstFrameSims) : 1;
  const maxChange = 1 - minFirstSim;

  // 滑动窗口停滞占比
  const win = T.WINDOW;
  let stallWindows = 0;
  let totalWindows = 0;
  for (let i = 0; i + win <= m.consecutiveSims.length; i++) {
    const chunk = m.consecutiveSims.slice(i, i + win);
    if (mean(chunk) > T.STALL) stallWindows++;
    totalWindows++;
  }
  const stallWindowRatio = totalWindows > 0 ? stallWindows / totalWindows : 0;

  // 后半段卡死：前1/3 vs 后1/3 的 consecutive 均值差
  const third = Math.max(1, Math.floor(m.consecutiveSims.length / 3));
  const head = m.consecutiveSims.slice(0, third);
  const tail = m.consecutiveSims.slice(-third);
  const tailLag = mean(tail) - mean(head);

  const metrics = { meanConsecutive, maxChange, stallWindowRatio, tailLag };

  if (meanConsecutive > T.IDENTICAL) {
    return { degraded: true, reason: `Frames identical (mean consecutive ${meanConsecutive.toFixed(4)} > ${T.IDENTICAL}; camera/timing/input probably not wired)`, metrics };
  }
  if (maxChange < T.NEVER_CHANGE) {
    return { degraded: true, reason: `Picture never changed (maxChange ${maxChange.toFixed(4)} < ${T.NEVER_CHANGE})`, metrics };
  }
  if (stallWindowRatio > T.STALL_RATIO) {
    return { degraded: true, reason: `More than half the windows stalled (${(stallWindowRatio * 100).toFixed(0)}% of windows consecutive > ${T.STALL})`, metrics };
  }
  if (tailLag > T.TAIL_LAG) {
    return { degraded: true, reason: `Second half froze (tailLag ${tailLag.toFixed(4)} > ${T.TAIL_LAG}: smooth start, frozen tail)`, metrics };
  }
  return { degraded: false, reason: 'ok', metrics };
}
