/**
 * Bridge 会话编排(2026-08-21 架构审查 C-3):CLI 子命令复用"装 bridge → 起游戏 →
 * bridge 调用 → 停游戏"链路的单一入口。
 *
 * ⚠️ 分层声明:本文件是 CLI 子系统对 tools 层 MCP 工具编排调用(runtime.handleTool 的
 * run_project/stop_project)的**有意例外集中点**——未来新增需要起游戏的 CLI 命令应复用
 * 此会话,不得在命令文件里散布 `import '../tools/...'`(阻断 cli→tools 耦合增长,见
 * docs/reviews 架构审查 MAJOR-3)。底层 bridge 客户端(sendToBridge/setBridgeProjectDir)
 * 已下沉 core/bridge-client,本文件直接转发 core 版。
 */
import type { ToolContext } from '../types.js';
import { setBridgeProjectDir } from '../core/bridge-client.js';
import * as gameBridge from '../tools/game-bridge.js';
import * as runtime from '../tools/runtime.js';

export { sendToBridge, setBridgeProjectDir } from '../core/bridge-client.js';
export { resolveGameDataPath } from '../tools/game-fs.js';

export interface BridgeSessionOptions {
  /** run_project 的 wait_for_bridge 超时(秒,默认 20) */
  bridgeTimeout?: number;
  /** run_project 的总超时(秒,默认 120) */
  runTimeout?: number;
}

/**
 * 起 bridge 会话:装 autoload + 起游戏(等 bridge 就绪)。
 * 失败直接 process.exit(1)(CLI 语义,与原 gif/qa 链一致)。
 */
export async function startBridgeSession(
  projectAbs: string,
  ctx: ToolContext,
  opts: BridgeSessionOptions = {},
): Promise<void> {
  const { bridgeTimeout = 20, runTimeout = 120 } = opts;
  const install = await gameBridge.handleTool('game', { action: 'game_bridge_install', project_path: projectAbs }, ctx);
  const installText = install?.content[0]?.type === 'text' ? install.content[0].text : '';
  if (!installText.includes('already registered') && !installText.includes('success')) {
    console.error(`game_bridge_install failed: ${installText.slice(0, 200)}`);
    process.exit(1);
  }
  setBridgeProjectDir(projectAbs);
  const run = await runtime.handleTool('runtime', {
    action: 'run_project', project_path: projectAbs, wait_for_bridge: true, bridge_timeout: bridgeTimeout, timeout: runTimeout,
  }, ctx);
  const runText = run?.content[0]?.type === 'text' ? run.content[0].text : '';
  if (!runText.includes('Bridge ready')) {
    console.error(`run_project failed: ${runText.slice(0, 200)}`);
    process.exit(1);
  }
}

/** 停 bridge 会话:停游戏防进程残留(best-effort,失败静默)。 */
export async function stopBridgeSession(ctx: ToolContext): Promise<void> {
  await runtime.handleTool('runtime', { action: 'stop_project' }, ctx).catch(() => {});
}
