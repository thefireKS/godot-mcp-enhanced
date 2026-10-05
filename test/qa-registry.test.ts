// test/qa-registry.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  registerRun, getRun, listRuns, activeWorkingRun, requestCancel,
  finishRun, updateProgress, clearRegistry, QaBusyError, cancelAndAwaitWorkingRun,
  setTerminalNotifier,
} from '../src/tools/qa/registry.js';

beforeEach(() => clearRegistry());

describe('qa run registry', () => {
  it('registerRun 创建 working 记录,progress 初始化', () => {
    const r = registerRun('run-1', 'suiteA', 'D:/proj', 5);
    expect(r.status).toBe('working');
    expect(r.taskId).toBe('run-1');
    expect(r.progress).toEqual({ step: 0, total: 5 });
    expect(r.cancelRequested).toBe(false);
    expect(r.ttl).toBeGreaterThan(0);
  });

  it('并发约束:已有 working 再注册 → QaBusyError 带当前 run_id', () => {
    registerRun('run-1', 'a', 'D:/p', 3);
    expect(() => registerRun('run-2', 'b', 'D:/p', 3)).toThrow(QaBusyError);
    try { registerRun('run-3', 'c', 'D:/p', 3); } catch (e) {
      expect((e as QaBusyError).currentRunId).toBe('run-1');
    }
  });

  it('终态后可再注册(working 互斥仅对 working)', () => {
    registerRun('run-1', 'a', 'D:/p', 1);
    finishRun('run-1', 'completed');
    const r2 = registerRun('run-2', 'a', 'D:/p', 1);
    expect(r2.status).toBe('working');
  });

  it('requestCancel:working → ok 且置位;终态 → ok:false 带原因', () => {
    registerRun('run-1', 'a', 'D:/p', 1);
    expect(requestCancel('run-1')).toEqual({ ok: true });
    expect(getRun('run-1')!.cancelRequested).toBe(true);
    finishRun('run-1', 'completed');
    const r = requestCancel('run-1');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('completed');
  });

  it('requestCancel 未知 run_id → ok:false', () => {
    const r = requestCancel('nope');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('not in the run registry');
  });

  it('updateProgress 更新 step/total/current 与 lastUpdatedAt', () => {
    registerRun('run-1', 'a', 'D:/p', 4);
    updateProgress('run-1', 2, 4, 'input(send_key)');
    const r = getRun('run-1')!;
    expect(r.progress).toEqual({ step: 2, total: 4, current: 'input(send_key)' });
  });

  it('TTL 惰性清扫:终态超 ttl 后 getRun/listRuns 不再返回', () => {
    const r = registerRun('run-1', 'a', 'D:/p', 1);
    finishRun('run-1', 'failed');
    // 手动把 lastUpdatedAt 回拨到 ttl 之外
    (r as { lastUpdatedAt: string }).lastUpdatedAt = new Date(Date.now() - r.ttl - 1000).toISOString();
    expect(getRun('run-1')).toBeUndefined();
    expect(listRuns()).toHaveLength(0);
  });

  it('activeWorkingRun 返回 working 记录,终态后 undefined', () => {
    registerRun('run-1', 'a', 'D:/p', 1);
    expect(activeWorkingRun()?.taskId).toBe('run-1');
    finishRun('run-1', 'cancelled');
    expect(activeWorkingRun()).toBeUndefined();
  });

  it('finishRun 回填 report 与 reportPaths', () => {
    registerRun('run-1', 'a', 'D:/p', 1);
    finishRun('run-1', 'completed', { version: 1, run_id: 'run-1' } as never, { json_path: 'x.json', md_path: 'x.md' });
    const r = getRun('run-1')!;
    expect(r.report?.run_id).toBe('run-1');
    expect(r.reportPaths?.json_path).toBe('x.json');
  });
});

describe('cancelAndAwaitWorkingRun(close 优雅收尾)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('无 working run → { cancelled: null, settled: true },不触发等待', async () => {
    const r = await cancelAndAwaitWorkingRun();
    expect(r).toEqual({ cancelled: null, settled: true });
  });

  it('settle 路径:置取消 + done resolve 且状态转终态 → settled: true', async () => {
    const rec = registerRun('run-1', 'a', 'D:/p', 2);
    let resolveDone!: () => void;
    rec.done = new Promise<void>(res => { resolveDone = res; });
    const p = cancelAndAwaitWorkingRun(5_000);
    // 函数同步段已执行 requestCancel(进入 race 挂起前)
    expect(rec.cancelRequested).toBe(true);
    // run loop 语义近似:finishRun 置终态后 done resolve(finishRun 先于 done resolve,
    // 同一微任务链,故 await 返回后 status 判定可靠)
    finishRun('run-1', 'cancelled');
    resolveDone();
    const r = await p;
    expect(r).toEqual({ cancelled: 'run-1', settled: true });
  });

  it('超时路径:done 挂起 + maxWait 耗尽 → settled: false(放弃等,进程级兜底接手)', async () => {
    const rec = registerRun('run-1', 'a', 'D:/p', 2);
    rec.done = new Promise<void>(() => {}); // 永挂
    const p = cancelAndAwaitWorkingRun(50);
    const r = await vi.advanceTimersByTimeAsync(50).then(() => p);
    expect(r).toEqual({ cancelled: 'run-1', settled: false });
    expect(rec.cancelRequested).toBe(true);
  });

  it('等待上限取 min(maxWaitMs, ttl):ttl 更小时按 ttl 截断(spec §2.4 suite_budget_ms 近似)', async () => {
    const rec = registerRun('run-1', 'a', 'D:/p', 1);
    rec.ttl = 100; // 手动压小(默认 1h 不会截断)
    rec.done = new Promise<void>(() => {});
    const p = cancelAndAwaitWorkingRun(60_000);
    // 若实现误用 60s,advance 100 后 p 仍挂起,断言会超时失败
    const r = await vi.advanceTimersByTimeAsync(100).then(() => p);
    expect(r).toEqual({ cancelled: 'run-1', settled: false });
  });
});

// ═══ PR-2 Task 1:registry 终态通知钩子 + error 字段 ═══

describe('registry 终态通知与 error 字段(PR-2)', () => {
  afterEach(() => setTerminalNotifier(null));

  it('finishRun 终态时调用 notifier(runId+status);updateProgress 不触发', () => {
    clearRegistry();
    const fired: Array<[string, string]> = [];
    setTerminalNotifier((id, st) => fired.push([id, st]));
    registerRun('run-1', 'a', 'D:/p', 2);
    updateProgress('run-1', 1, 2, 'x');
    expect(fired).toHaveLength(0);
    finishRun('run-1', 'completed');
    expect(fired).toEqual([['run-1', 'completed']]);
  });

  it('notifier 抛异常不影响 finishRun 状态写入(best-effort)', () => {
    clearRegistry();
    setTerminalNotifier(() => { throw new Error('boom'); });
    registerRun('run-2', 'a', 'D:/p', 1);
    expect(() => finishRun('run-2', 'failed')).not.toThrow();
    expect(getRun('run-2')!.status).toBe('failed');
  });

  it('finishRun error 参数写入 RunRecord.error', () => {
    clearRegistry();
    registerRun('run-3', 'a', 'D:/p', 1);
    finishRun('run-3', 'failed', undefined, undefined, 'writeReport failed: EACCES');
    expect(getRun('run-3')!.error).toBe('writeReport failed: EACCES');
  });
});
