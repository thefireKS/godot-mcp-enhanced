/**
 * 批 4a:demo GIF CLI——`npx godot-mcp-enhanced gif <project> [options]`。
 * 链路:装 bridge → 起游戏(wait_for_bridge)→ freeze 锁起播 → 循环 N 窗:
 * 按键时间线(每窗开头注入一对 press/release)+ playtest.step 推帧 + take_screenshot →
 * resolveGameDataPath 取本机 PNG → pngjs 解码 → GIF89a 编码落盘。
 * 输入:--keys 显式序列(逗号分隔,小写);默认方向键循环(2048/snake);
 * --keys 或 --seed 未指定 keys 时按 seed 派生取样顺序(Node 侧 LCG,不依赖游戏 RNG)。
 */
import { join, resolve, sep, dirname } from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { PNG } from 'pngjs';
import { makeCtx } from './ctx.js';
import { opt, num } from './args.js';
import {
  sendToBridge,
  resolveGameDataPath,
  startBridgeSession,
  stopBridgeSession,
} from './bridge-session.js';
import { encodeGif, type RgbaFrame } from './gif-encoder.js';
import { confirmYesNo } from './confirm.js';

/** Node 侧 LCG(seed 派生按键取样顺序;不依赖游戏 RNG,冻结策略与游戏随机解耦)。 */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 0x100000000;
}

export async function runGif(args: string[]): Promise<void> {
  const projectPath = args[0];
  if (!projectPath || !existsSync(join(projectPath, 'project.godot'))) {
    console.error('Usage: gif <project-path> [--out <path>] [--fps 1-10] [--seconds N] [--keys up,left,…] [--seed N]');
    process.exit(2);
  }
  // B-1(审查)/F-2(2026-08-20):参数解析统一走 args.ts 共享双形式 helper + range 钳制
  const outArg = opt(args, 'out');
  const fps = num(args, 'fps', 4, [1, 10]);
  const seconds = num(args, 'seconds', 8, [1, 30]);
  const seed = num(args, 'seed', 42);
  const defaultKeys = ['up', 'right', 'down', 'left'];
  const keys = opt(args, 'keys')?.split(',').map(k => k.trim().toLowerCase()).filter(Boolean) ?? defaultKeys;

  const projectAbs = resolve(projectPath);
  const outPath = outArg
    ? resolve(process.cwd(), outArg)
    : join(projectAbs, 'dist', 'demo.gif');
  if (!outPath.startsWith(projectAbs + sep) && outPath !== projectAbs) {
    if (!(await confirmYesNo(`Output is outside the project: ${outPath}\nWrite it?`))) {
      console.error('Cancelled (paths inside the project need no confirmation, or use the default dist/demo.gif)');
      process.exit(1);
    }
  }

  const ctx = makeCtx();
  console.log(`🎬 Recording demo GIF: ${fps}fps × ${seconds}s = ${fps * seconds} frames, seed=${seed}`);

  // ── setup(bridge-session 共享链;原与 qa runner 同款,2026-08-21 收敛到单一入口)──
  await startBridgeSession(projectAbs, ctx);

  const frames: RgbaFrame[] = [];
  const capturedPngPaths: string[] = [];

  try {
    const delayCs = Math.round(100 / fps);
    const rnd = lcg(seed);

    const total = fps * seconds;
    const windowMs = 1000 / fps;
    for (let i = 0; i < total; i++) {
      const windowStart = Date.now();
      const key = keys[Math.floor(rnd() * keys.length)]!;
      // 直播模式注入(非 frozen:send_input_sequence 直接播放)——帧间隔由 wall 定时
      // 近似 fps(demo GIF 无帧级确定性诉求,spec B-1 只要求低频截图循环);
      // frozen+playtest.step 通道会被「game is frozen; unfreeze before stepping」拒
      const seq = await sendToBridge('send_input_sequence', {
        timeline: [
          { at_frame: 1, type: 'key', key, pressed: true },
          { at_frame: 3, type: 'key', key, pressed: false },
        ],
        settle_frames: 0,
      }, 20_000);
      if (seq.error) console.warn(`  ⚠ Key injection failed (${seq.error.message})`);
      // 注:截图/注入耗时未计入窗口预算,实际帧率略低于 --fps(demo 场景可接受)
      const elapsed = Date.now() - windowStart;
      if (elapsed < windowMs) await new Promise(r => setTimeout(r, windowMs - elapsed));
      const shotUri = `user://mcp_gif_${i}.png`;
      const shot = await sendToBridge('take_screenshot', { path: shotUri }, 15_000);
      const sr = (shot.result ?? {}) as { success?: boolean; path?: string; size?: { x: number; y: number } };
      if (shot.error || sr.success !== true || typeof sr.path !== 'string') {
        console.warn(`  ⚠ Screenshot of frame ${i + 1} failed, skipped`);
        continue;
      }
      const local = resolveGameDataPath(projectAbs, sr.path);
      if (!local) {
        console.warn(`  ⚠ Cannot resolve user:// path: ${sr.path} (left on the game side)`);
        continue;
      }
      capturedPngPaths.push(local);
      const png = PNG.sync.read(readFileSync(local));
      frames.push({ width: png.width, height: png.height, data: new Uint8Array(png.data) });
      if ((i + 1) % (fps * 2) === 0) console.log(`  Captured ${frames.length}/${total} frames`);
    }
    if (frames.length < 2) {
      // 不用 process.exit:try 内 exit 旁路 finally 的 stop_project → 游戏进程残留(审查 I-1)
      throw new Error(`Not enough valid frames (${frames.length})`);
    }
    console.log(`  Encoding ${frames.length} frames → ${outPath}`);
    const gif = encodeGif(frames, delayCs);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, gif);
    console.log(`✓ Demo GIF done: ${outPath} (${(gif.length / 1024).toFixed(0)} KB, ${frames[0]!.width}×${frames[0]!.height}, ${frames.length} frames @${fps}fps)`);
  } finally {
    // teardown:停游戏(与 qa 同款,防进程残留)+ 清理 user:// 侧截图残留(审查 N-2)
    for (const f of capturedPngPaths) {
      try { if (existsSync(f)) unlinkSync(f); } catch { /* best-effort */ }
    }
    await stopBridgeSession(ctx);
  }
}
