// proof bundle 目录管理 —— 借鉴 recording.ts:67-73 的 recording_<timestamp> 命名模式。
// 把一次验证运行的所有帧 + metrics 归档到 proof/<runId>/。

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

/** 单次 proof run 最大字节(B3:防帧捕获失控撑爆磁盘)。 */
export const MAX_PROOF_BYTES = 100 * 1024 * 1024; // 100MB

export interface ProofRun {
  runId: string;
  dir: string;   // 绝对路径
  bytes: number; // 已归档字节(B3 配额跟踪)
}

export function createProofRun(projectPath: string): ProofRun {
  // runId = 时间戳(可读时间序) + randomUUID(消同毫秒碰撞)。
  // 单纯 Date.now() 同毫秒并发会撞(实测见 proof-bundle.test.ts 同毫秒用例),uuid 后缀保证唯一。
  const runId = `run_${Date.now()}_${randomUUID()}`;
  const dir = path.join(projectPath, 'proof', runId);
  fs.mkdirSync(dir, { recursive: true });
  return { runId, dir, bytes: 0 };
}

export function archiveFrame(run: ProofRun, index: number, pngBuffer: Buffer): string {
  // B3:累计字节,超 100MB 配额拒绝(防失控帧捕获撑爆磁盘)
  run.bytes += pngBuffer.length;
  if (run.bytes > MAX_PROOF_BYTES) {
    throw new Error(`proof bundle quota exceeded: ${run.bytes} bytes > ${MAX_PROOF_BYTES}`);
  }
  const name = `frame_${String(index).padStart(2, '0')}.png`;
  fs.writeFileSync(path.join(run.dir, name), pngBuffer);
  return name;
}

/** 记录一个已写入 proof 目录的文件字节到 run 配额(B3:frame_sequence 用 GDScript 直写绕过 archiveFrame,
 *  需显式累计)。超配额抛错,调用方 catch 决定停止捕获。 */
export function recordFrameBytes(run: ProofRun, filePath: string): void {
  run.bytes += fs.statSync(filePath).size;
  if (run.bytes > MAX_PROOF_BYTES) {
    throw new Error(`proof bundle quota exceeded: ${run.bytes} bytes > ${MAX_PROOF_BYTES}`);
  }
}

export function writeMetrics(run: ProofRun, metrics: Record<string, unknown>): string {
  const name = 'metrics.json';
  fs.writeFileSync(path.join(run.dir, name), JSON.stringify(metrics, null, 2), 'utf-8');
  return name;
}

/** 清理 proof run 临时目录(B1:验证完成后回收,防 proof/ 无限堆积)。
 *  Windows 句柄占用等致 rmSync 失败时忽略(下次 cleanup 兜底)。 */
export function cleanupProofRun(run: ProofRun): void {
  try {
    fs.rmSync(run.dir, { recursive: true, force: true });
  } catch {
    // 忽略:EBUSY/EPERM(Windows 句柄占用)等,残留目录待后续手动/下次清理
  }
}
