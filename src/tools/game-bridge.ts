/**
 * game_bridge MCP 工具 —— Bridge 安装/查询/输入/写入/等待/监控/信号/UI 发现/确定性 playtest。
 *
 * 2026-08-21 架构审查 MAJOR-3:客户端核心(TCP 连接/认证/NDJSON 协议/keepalive/订阅重发/
 * 端口 registry 解析)下沉到 src/core/bridge-client.ts——CLI 子命令(gif 等)复用 bridge
 * 不再需要 import tools 层;本文件保留 MCP 工具定义,并 re-export 客户端符号使既有消费方
 * (GodotServer/CLI/测试)import 路径零改动。
 */
import { writeFileSync, readFileSync, existsSync, copyFileSync, unlinkSync, renameSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import type { Tool } from "@modelcontextprotocol/server";
import type { ToolContext, ToolResult } from '../types.js';
import { textResult, errorResult, getErrorMessage } from '../types.js';
import { opsErrorResult } from './shared.js';
import { requireProjectPath } from '../helpers.js';
import { launchDashboardOnce } from '../dashboard/launcher.js';
import type { RiskLevel } from '../core/tool-registry.js';
import { getLogger } from '../core/logger.js';
import {
  BRIDGE_PORT,
  BRIDGE_HOST,
  BRIDGE_SCRIPT_NAME,
  AUTOLOAD_KEY,
  ERROR_CODES,
  BridgeNotConnectedError,
  BridgeTimeoutError,
  clampTimeoutMs,
  resolveBridgePort,
  bridgeSecretPathFor,
  getBridgeProjectDir,
  invalidateBridgeSecret,
  invalidateBridgeConnection,
  registerBridgePushHandler,
  type BridgeResponse,
  setBridgeProjectDir,
  sendToBridge,
  setOnBridgeConnected,
  _registerSubscription,
  _removeSubscription,
} from '../core/bridge-client.js';

// Re-export(消费方兼容:GodotServer import registerBridgePushHandler/setBridgeProjectDir;
// 测试 import clampTimeoutMs/BridgeNotConnectedError 等——签名与迁移前逐一相同)
export {
  BRIDGE_PORT,
  BRIDGE_HOST,
  BRIDGE_SCRIPT_NAME,
  AUTOLOAD_KEY,
  ERROR_CODES,
  BridgeNotConnectedError,
  BridgeTimeoutError,
  clampTimeoutMs,
  resolveBridgePort,
  bridgeSecretPathFor,
  getBridgeProjectDir,
  invalidateBridgeSecret,
  invalidateBridgeConnection,
  registerBridgePushHandler,
  setBridgeProjectDir,
  sendToBridge,
  type BridgeResponse,
};
export { machineRegistryInstancesDir, normalizeProjectKey, setOnBridgeConnected } from '../core/bridge-client.js';

// 首次连接成功自动拉起 Dashboard —— 经回调注入(core/bridge-client 不依赖 dashboard,
// 防 core→dashboard→helpers→core 环;等价迁移原 _doConnect 内联调用点)
setOnBridgeConnected(() => launchDashboardOnce());

// G-5: 识别/迁移旧版(≤0.23.x)误写的带前缀 autoload 键(仅工具层 install/uninstall 用)
const AUTOLOAD_KEY_LEGACY = 'autoload/MCPBridge';

// ─── Tool definitions ──────────────────────────────────────────────────────

const ACTIONS = [
  'game_bridge_install',
  'game_bridge_uninstall',
  'install_override',
  'uninstall_override',
  'game_query',
  'game_write',
  'game_input',
  'game_wait',
  'game_playtest',
  'monitor_start',
  'monitor_stop',
  'monitor_poll',
  'watch_start',
  'watch_stop',
  'watch_poll',
  'find_ui_elements',
  'click_button',
] as const;

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'game',
      description: 'Game bridge. Install/remove: game_bridge_install, game_bridge_uninstall. P2-1 override injection: install_override/uninstall_override (inject any debug script into the project\'s autoloads before launching the game, e.g. log hooks / state snapshots). Query: game_query (ping, get_tree, find_nodes, get_node_properties, get_performance, get_viewport_info, take_screenshot). Write: game_write (set_node_property, call_method). Input: game_input (send_key, send_mouse_click, send_mouse_move, send_text, send_touch, send_drag, send_input_sequence — frame-timed input timeline). Wait: game_wait (wait_for_node, wait_for_property). P2-4 deterministic playtest: game_playtest (playtest.seed locks RNG, playtest.fixed_delta locks the step, playtest.step advances frames, playtest.snapshot/restore state snapshots). G1 control layer: playtest.freeze (freezes the game loop, the bridge still answers), playtest.unfreeze, playtest.step_until (stops when conditions hold / frames run out / wall timeout; structured conditions {path,property,op,value}[] ANDed). Monitoring: monitor_start/stop/poll (property timeline sampling). Signals: watch_start/stop/poll (signal event log). UI: find_ui_elements/click_button (UI element discovery + button clicks).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot project directory (optional; defaults to the GODOT_PROJECT_PATH env var or the current directory)' },
          action: {
            type: 'string',
            enum: [...ACTIONS],
            description: 'Operation',
          },
          port: { type: 'number', description: 'game_bridge_install: desired starting listen port (the actual port starts at the game-side env GODOT_MCP_BRIDGE_PORT and increments when taken; this parameter changes nothing and is kept for compatibility). The actual port is in the ping response and the instance registry', default: 9081 },
          source_script_path: { type: 'string', description: 'install_override/uninstall_override: absolute path of the debug script (must be inside the ALLOWED_PROJECT_PATHS whitelist; copied to the project root and registered as the MCPOVERRIDE_<basename> autoload, appended at the end of [autoload] = loads after the game\'s autoloads, so its _ready can use game singletons directly without await <Singleton>.ready)' },
          method: {
            type: 'string',
            description: 'Method for game_query/game_write/game_input/game_wait/game_playtest. game_query: ping, get_tree, find_nodes (a root param limits the search to a subtree, absolute paths like /root/Main recommended; a missing node is an error, not a silent whole-tree search), get_node_properties, get_node_layout, get_performance, get_viewport_info, take_screenshot, get_errors (game runtime errors; since_seq for increments + clear to read-and-clear), clear_errors (empty the error buffer). game_write: set_node_property, call_method (coroutine methods are fire-and-forget by default and return a {coroutine:true} marker + note; pass params.await_completion=true to wait for the return value via a deferred response, raise timeout for long coroutines). game_input: send_key, send_mouse_click (button: int 1-9/left/right/middle), send_mouse_move, send_text, send_touch, send_drag, send_input_sequence (frame-timed timeline, deferred response). game_wait: wait_for_node, wait_for_property. game_playtest: playtest.seed (locks the global RNG, covers randi/randf only), playtest.fixed_delta (locks the physics step, delta=1/hz), playtest.step (advance N frames, deferred coroutine response), playtest.snapshot (snapshot scene tree properties; signals/physics/freed nodes are not kept), playtest.restore (restore properties from the snapshot). G1 control layer: playtest.freeze (sets tree.paused), playtest.unfreeze, playtest.step_until (advance until conditions hold / frames run out / wall timeout; structured conditions {path,property,op,value}[] ANDed, no Expression)',
          },
          params: {
            type: 'object',
            description: 'Method arguments. game_query: depends on the method. get_errors {since_seq?:int (default 0, only seq>since_seq), clear?:bool (default false, empty the buffer after reading)}. game_write: set_node_property {path, property, value}, call_method {path, method, args}. call_method defaults to a read-only whitelist (get/has_*/get_meta etc.); env GODOT_MCP_BRIDGE_EXTRA_METHODS=method1,method2 extends it (including write methods like take_damage); EXTRA_METHODS_BLOCKLIST (free/queue_free/set_script/call/emit_signal etc.) is a hard floor that cannot be overridden. args are coerced to the declared parameter types ([1,2,3] becomes a Vector3). Unknown methods get did-you-mean suggestions. The response carries undoable=false (calls cannot be undone). game_input: send_key {key, pressed}, send_mouse_click {x, y, button, pressed}, send_mouse_move {x, y}, send_text {text}, send_touch {x, y, pressed, index}, send_drag {x, y, index, relative, speed}, send_input_sequence {timeline:[{at_frame:1-600 (Nth frame after the window opens),type:action|key|mouse_click|mouse_move|touch|drag,...event params}], settle_frames?:int(0-600), wall_budget_ms?:int(1000-50000), ≤256 events} (action fields name/pressed/strength?, other types use the same fields as their send_*; when frozen it opens a window to play and refreezes after). game_wait: wait_for_node {path}, wait_for_property {path, property, value}. game_playtest: playtest.seed {seed:int}, playtest.fixed_delta {hz:int}, playtest.step {frames:int(1-60)}, playtest.snapshot/restore take no params. G1 control: playtest.freeze/unfreeze take no params, playtest.step_until {conditions:[{path:String,property:String,op:String(==/!=/</>/<=/>=),value:scalar/geometry}], max_frames?:int(1-600, default 600), wall_budget_ms?:int(1000-50000, default 30000)}',
          },
          timeout: { type: 'number', description: 'game_query/game_write/game_input/game_wait: timeout in ms (default 10000). For game_wait it is the budget of the whole polling window (probes repeatedly until the condition holds). send_input_sequence responds late; its timeout widens to wall_budget+10s automatically (max 65000)' },
          interval_ms: { type: 'number', description: 'game_wait only: polling interval in ms (default 200, range 50-2000). Applies to wait_for_node/wait_for_property only', default: 200 },
          node_path: { type: 'string', description: 'monitor_start: node path to monitor (e.g. /root/Player)' },
          properties: { type: 'array', items: { type: 'string' }, description: 'monitor_start: property names to monitor (e.g. ["position", "health"])' },
          interval_frames: { type: 'number', description: 'monitor_start: sampling interval in frames (default 10, min 1, max 300)' },
          signal_name: { type: 'string', description: 'watch_start: signal name to listen for (e.g. "pressed", "health_changed")' },
          max_events: { type: 'number', description: 'watch_start: max events to record (default 1000, max 5000)' },
          push: { type: 'boolean', description: 'P3-6 watch_start/monitor_start: push mode (sends an MCP notification on each event/sample, no polling). The client must subscribe via resources/subscribe to receive them' },
          pattern: { type: 'string', description: 'find_ui_elements: name/text match pattern (Godot match syntax)' },
          type: { type: 'string', description: 'find_ui_elements: filter by type (e.g. "Button", "Label")' },
          visible_only: { type: 'boolean', description: 'find_ui_elements: visible elements only (default true)' },
          limit: { type: 'number', description: 'find_ui_elements: max results (default 200, max 500)' },
          text: { type: 'string', description: 'click_button: button text (or path)' },
          path: { type: 'string', description: 'click_button: button node path (or text)' },
          godot_path: { type: 'string', description: 'Override the Godot binary path (optional; takes precedence over project config and env vars)' },
        },
        required: ['action'],
      },
    },
  ];
}

// ─── Tool handler ───────────────────────────────────────────────────────────

export const QUERY_METHODS = new Set([
  'ping', 'get_tree', 'find_nodes', 'get_node_properties', 'get_node_layout',
  'get_performance', 'get_viewport_info', 'take_screenshot',
  // CMP-2 (2026-08-08): runtime error 捕获——查询/清除游戏运行时错误
  'get_errors', 'clear_errors',
]);

/** Read-only query methods excluding take_screenshot (handled separately via bridge.screenshot). */
export const BRIDGE_READ_ONLY_METHODS = new Set([
  'ping', 'get_tree', 'find_nodes', 'get_node_properties', 'get_node_layout',
  'get_performance', 'get_viewport_info',
  // CMP-2: get_errors/clear_errors 只操作 bridge 内部 buffer 不影响游戏,归只读集合
  'get_errors', 'clear_errors',
]);

const WRITE_METHODS = new Set([
  'set_node_property', 'call_method',
]);

export const INPUT_METHODS = new Set([
  'send_key', 'send_mouse_click', 'send_mouse_move', 'send_text',
  'send_touch', 'send_drag',
  // H1 (2026-08-20) 帧定时输入时间线:开窗+逐帧 at_frame 注入,延迟响应(同 step_until)
  'send_input_sequence',
]);

const WAIT_METHODS = new Set([
  'wait_for_node', 'wait_for_property',
]);

// P2-4 确定性 playtest 四原语(snapshot/restore 同步;step 走 coroutine 延迟响应)
export const PLAYTEST_METHODS = new Set([
  'playtest.seed', 'playtest.fixed_delta', 'playtest.snapshot', 'playtest.restore', 'playtest.step',
]);

// G1 (2026-08-13) control-first satellite 层(附录 F.1):freeze/unfreeze/step_until
// 与 determinism-first(PLAYTEST_METHODS)正交叠加。step_until 走同款 coroutine 延迟响应(条件多帧满足)。
export const CONTROL_METHODS = new Set([
  'playtest.freeze', 'playtest.unfreeze', 'playtest.step_until',
]);

/**
 * G-3 (:942② + 批D移交): 计算 game_playtest 各 method 的 TS 侧请求 timeout(纯函数,无 IO)。
 *
 * step_until 的竞态根因: 原 `min(max(raw,30000),60000)` 与 GD 侧 idle 60s(mcp_bridge.gd
 * INACTIVITY_TIMEOUT)同界 — wall_budget_ms=60000 时 TS 先到期销毁常驻 socket(响应丢失 +
 * 订阅断线)。批 D 已把 GD 侧 wall_budget clamp 到 50s,TS 侧对齐:
 * `wall_budget + 5s 余量`(默认 30000 → 35000;wall=60000 超界入参 → 65000 不再先到期),
 * 并与用户显式 timeout 取 max(用户显式更长时尊重显式意图,不被 wall 公式压短)。
 *
 * 其余 method 保持原行为: step 走 max(raw,30000) cap 60000;非长跑 method 原样。
 */
export function computePlaytestTimeoutMs(method: string, wallBudgetMs: unknown, rawTimeoutMs: number): number {
  // 延迟响应族(playtest.step/step_until/send_input_sequence):基础下限 30s,
  // 默认 10s 会先于 GD 侧 wall(默认 30s)超时致响应丢失
  const isDelayed = method === 'playtest.step' || method === 'playtest.step_until' || method === 'send_input_sequence';
  const base = isDelayed
    ? Math.min(Math.max(rawTimeoutMs, 30000), 60000)
    : Math.min(rawTimeoutMs, 60000);
  if (method !== 'playtest.step_until' && method !== 'send_input_sequence') return base;
  const n = Number(wallBudgetMs);
  const wall = (wallBudgetMs === undefined || wallBudgetMs === null || !Number.isFinite(n))
    ? 30000
    : Math.max(0, Math.round(n));
  // wall + 余量,clamp 到 [1000,65000]。
  // step_until 余量 5s(65000 容纳 GD 超界入参 60000+5000);
  // send_input_sequence 余量 10s(GD clamp 50000+10000=60000,与 base 上界一致)
  const margin = method === 'send_input_sequence' ? 10000 : 5000;
  const byBudget = clampTimeoutMs(wall + margin, 1000, 65000, 35000);
  return Math.max(byBudget, base);
}

/**
 * CRITICAL-3 fix: poll a Bridge wait condition until it holds or the budget
 * runs out. Bridge (`mcp_bridge.gd` `_cmd_wait_for_node`/`_cmd_wait_for_property`)
 * is a single synchronous snapshot, so "waiting" must be implemented by the
 * caller polling within a time window.
 *
 * `probe` is parameterized so tests can inject a mock without touching the
 * real socket. Each probe call should return the BridgeResponse from a single
 * `wait_for_node`/`wait_for_property` snapshot.
 *
 * Condition resolution:
 *   - `wait_for_node`   → holds when result.exists === true
 *   - `wait_for_property` → holds when result.match === true
 *   - any result.error  → abort immediately, surface the error
 *
 * The returned object spreads the last Bridge result and augments it with
 * `wait_completed` / `elapsed_ms` / `timed_out`, so existing fields stay
 * backward compatible.
 */
export async function pollWaitCondition(
  method: 'wait_for_node' | 'wait_for_property',
  probe: () => Promise<BridgeResponse>,
  totalMs: number,
  intervalMs: number,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  const isNode = method === 'wait_for_node';

  let last: BridgeResponse;
  for (;;) {
    last = await probe();

    // Hard errors abort immediately — never swallow a real failure as "not yet".
    if (last.error) {
      return {
        ...(last.result as Record<string, unknown> | undefined),
        error: last.error,
        wait_completed: false,
        elapsed_ms: Date.now() - startedAt,
      };
    }

    const result = (last.result ?? {}) as Record<string, unknown>;
    const satisfied = isNode ? result.exists === true : result.match === true;
    if (satisfied) {
      return { ...result, wait_completed: true, elapsed_ms: Date.now() - startedAt };
    }

    const elapsed = Date.now() - startedAt;
    if (elapsed >= totalMs) {
      return { ...result, wait_completed: false, timed_out: true, elapsed_ms: elapsed };
    }

    // Sleep the interval, but never past the remaining budget.
    const remaining = totalMs - elapsed;
    await sleep(Math.min(intervalMs, remaining));
  }
}

const defaultSleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** 确保项目目录已设置：优先用 ctx.projectDir，回退到 args.project_path */
function ensureProjectDir(ctx: ToolContext, args: Record<string, unknown>): void {
  if (ctx.projectDir) {
    setBridgeProjectDir(ctx.projectDir);
  } else if (!getBridgeProjectDir()) {
    try { if (args.project_path) setBridgeProjectDir(requireProjectPath({ project_path: args.project_path })); } catch (e) { getLogger().debug('bridge', `project_path fallback failed: ${e instanceof Error ? e.message : e}`); }
  }
}

/** T-1 (2026-06-24 审查): game_write/wait/query 的 path 参数须 /root/ 绝对路径(文档 godot-mcp-bridge.md
 *  声称必须,原 TS 端下放 GDScript 端)。无 path 的 method(ping/get_tree/get_performance 等)不校验。
 *  返回错误消息或 null(校验通过)。纯函数,无 IO/socket,测试见 game-bridge-validation.test.ts。 */
export function validateBridgePath(params: Record<string, unknown>): string | null {
  // I-1 (审查反馈): 节点路径字段名混用——game_write/wait/query 用 path,monitor/watch 用 node_path,
  // click_button 用 path。统一检查两者。无节点路径的方法(ping/get_tree/find_ui_elements 的 pattern)不校验。
  for (const key of ['path', 'node_path'] as const) {
    const p = params[key];
    if (typeof p === 'string' && p.length > 0 && p !== '/root' && !p.startsWith('/root/')) {
      return `${key} must be an absolute path starting with "/root/" (got "${p}"). game tools require /root/-prefixed node paths; see godot-mcp-bridge.md.`;
    }
  }
  return null;
}

/** I-2 (审查 follow-up): wait_for_property 需 property + value;wait_for_node 只需 path 不校验。
 *  返回错误消息或 null(校验通过)。纯函数,无 IO/socket,测试见 game-bridge-validation.test.ts。
 *  抽自 handleTool case 'game_wait' 内联逻辑(2026-08-09 待办 #3,恢复 Linux CI 覆盖)。 */
export function validateWaitPropertyParams(method: string, params: Record<string, unknown>): string | null {
  if (method === 'wait_for_property') {
    if (typeof params.property !== 'string' || !params.property) {
      return 'wait_for_property requires a non-empty "property" string in params';
    }
    if (params.value === undefined) {
      return 'wait_for_property requires a "value" in params';
    }
  }
  return null;
}

/** Shared helper: set project dir, send to bridge, format response. */
async function bridgeAction(method: string, params: Record<string, unknown>, ctx: ToolContext, timeout: number): Promise<ToolResult> {
  ensureProjectDir(ctx, params);
  const pathErr = validateBridgePath(params);  // I-1(审查): 覆盖 monitor/watch/click_button 的 node_path/path
  if (pathErr) return opsErrorResult('INVALID_PATH', pathErr);
  const resp = await sendToBridge(method, params, timeout);
  // T-2 (2026-06-24 审查): bridge 返回 error 时(密钥失效 -32001/-32002/方法不存在等)用 errorResult
  // (isError=true),否则 MCP 客户端误判成功吞掉错误。原 textResult 默认 isError=false。
  if (resp.error) {
    return errorResult(`Bridge error (${resp.error.code}): ${resp.error.message}`);
  }
  // G-1: 订阅登记表维护 — start 成功登记(重连后重发),stop 成功移除(不再重发)
  if (method === 'watch.start' || method === 'monitor.start') {
    _registerSubscription(method, params);
  } else if (method === 'watch.stop' || method === 'monitor.stop') {
    _removeSubscription(method === 'watch.stop' ? 'watch.start' : 'monitor.start');
  }
  return textResult(JSON.stringify(resp.result, null, 2));
}

export async function handleTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult | null> {
  if (name !== 'game') return null;

  const action = args.action as string;
  if (!action) return opsErrorResult('INVALID_PARAMS', 'action is required');

  try {
    switch (action) {
      case 'game_bridge_install': {
        const projectPath = requireProjectPath(args);
        const scriptsDir = dirname(ctx.opsScript);
        const bridgeSrc = join(scriptsDir, BRIDGE_SCRIPT_NAME);

        if (!existsSync(bridgeSrc)) {
          return textResult(`Error: Bridge script not found at ${bridgeSrc}`);
        }

        const configPath = join(projectPath, 'project.godot');
        if (!existsSync(configPath)) {
          return textResult(`Error: project.godot not found at ${configPath}`);
        }

        let config = readFileSync(configPath, 'utf-8');
        // G-5: 幂等/迁移检查用行首精确匹配(键名短,裸 includes 会误命中注释等文本)。
        // 新键存在 → 已注册跳过;仅旧带前缀键存在 → 迁移(删旧行写新行,旧项目自愈)。
        const hasNewKey = new RegExp(`^${AUTOLOAD_KEY}\\s*=`,'m').test(config);
        const hasLegacyKey = new RegExp(`^${AUTOLOAD_KEY_LEGACY}\\s*=`,'m').test(config);

        // A2 (2026-08-18 反馈): mcp_bridge.gd 托管语义 —— 目标已存在且内容与工具自带版本不同
        // (项目自管/git tracked + 本地修改)时**不覆盖**,保留现有文件并明确告知;内容一致
        // (工具拷贝的原样)才覆盖刷新(升级场景)。拷贝放在幂等检查前只做一次,已注册同样遵守。
        const destScript = join(projectPath, BRIDGE_SCRIPT_NAME);
        let scriptNote = '';
        if (existsSync(destScript)) {
          if (readFileSync(bridgeSrc, 'utf-8') !== readFileSync(destScript, 'utf-8')) {
            scriptNote = `existing ${BRIDGE_SCRIPT_NAME} differs from bundled version — kept as-is (not overwritten); delete it manually to force refresh.`;
          } else {
            copyFileSync(bridgeSrc, destScript);
          }
        } else {
          copyFileSync(bridgeSrc, destScript);
        }

        if (hasNewKey) {
          return textResult(`MCP Bridge autoload already registered. ${scriptNote || `Script copied to ${destScript}.`}`);
        }
        if (hasLegacyKey) {
          config = config.split('\n').filter(line => !line.startsWith(AUTOLOAD_KEY_LEGACY + '=')).join('\n');
        }

        const autoloadEntry = `${AUTOLOAD_KEY}="*res://${BRIDGE_SCRIPT_NAME}"`;
        const autoloadRegex = /^\[autoload\]/m;
        if (autoloadRegex.test(config)) {
          config = config.replace(autoloadRegex, `[autoload]\n${autoloadEntry}`);
        } else {
          config += `\n[autoload]\n${autoloadEntry}\n`;
        }

        // Atomic write: write to temp file then rename
        const tmpPath = configPath + '.mcp-tmp';
        writeFileSync(tmpPath, config, 'utf-8');
        renameSync(tmpPath, configPath);
        return textResult(JSON.stringify({
          success: true,
          // A1: 端口自动避让(默认起始候选在 9081-9090 内 crypto 随机——竞态缓解,env GODOT_MCP_BRIDGE_PORT 可固定起点;实际端口见 instance registry + ping 响应 pid/project 指纹)
          message: `MCP Bridge installed. Listens in the 9081-9090 range (randomized start candidate, auto-increments when occupied; ping response carries pid/project to verify target instance).${scriptNote ? ' ' + scriptNote : ''}`,
          script_path: `res://${BRIDGE_SCRIPT_NAME}`,
          autoload_key: AUTOLOAD_KEY,
        }));
      }

      case 'game_bridge_uninstall': {
        const projectPath = requireProjectPath(args);
        const configPath = join(projectPath, 'project.godot');

        if (!existsSync(configPath)) {
          return textResult(`Error: project.godot not found at ${configPath}`);
        }

        const config = readFileSync(configPath, 'utf-8');
        // G-5: 新键与旧带前缀键任一存在即可卸载(双键兼容,旧行为只认旧长键)
        const hasNewKey = new RegExp(`^${AUTOLOAD_KEY}\\s*=`,'m').test(config);
        const hasLegacyKey = new RegExp(`^${AUTOLOAD_KEY_LEGACY}\\s*=`,'m').test(config);
        if (!hasNewKey && !hasLegacyKey) {
          return textResult('MCP Bridge autoload not found in project.godot.');
        }

        // 双键清理:新键行 + 旧带前缀键行都移除
        const lines = config.split('\n').filter(line =>
          !line.startsWith(AUTOLOAD_KEY + '=') && !line.startsWith(AUTOLOAD_KEY_LEGACY + '='));
        const tmpPath = configPath + '.mcp-tmp';
        writeFileSync(tmpPath, lines.join('\n'), 'utf-8');
        renameSync(tmpPath, configPath);

        // A2 (2026-08-18 反馈): 仅当脚本内容与工具自带版本一致(工具托管拷贝)才删除;
        // 内容不同(项目自管/git tracked + 用户修改)则保留并提示,防 uninstall 删掉 tracked 文件。
        // N-5(审查): bundled 脚本缺失(工具安装损坏)时无法证明是工具托管 → 保守不删。
        const scriptPath = join(projectPath, BRIDGE_SCRIPT_NAME);
        let uninstallNote = '';
        if (existsSync(scriptPath)) {
          const bundledScript = join(dirname(ctx.opsScript), BRIDGE_SCRIPT_NAME);
          const toolManaged = existsSync(bundledScript)
            && readFileSync(bundledScript, 'utf-8') === readFileSync(scriptPath, 'utf-8');
          if (toolManaged) {
            unlinkSync(scriptPath);
          } else {
            uninstallNote = ` ${BRIDGE_SCRIPT_NAME} differs from bundled version (or bundled copy missing) — kept (delete manually if unwanted).`;
          }
        }

        // A-07 + A1: 清理所有端口的 secret(端口避让后 9081..909x 均可能有残留)
        const godotDir = join(projectPath, '.godot');
        if (existsSync(godotDir)) {
          try {
            for (const name of readdirSync(godotDir)) {
              if (name.startsWith('mcp_bridge_') && name.endsWith('.secret')) {
                try { unlinkSync(join(godotDir, name)); } catch { /* best effort */ }
              }
            }
          } catch { /* best effort */ }
        }
        invalidateBridgeSecret();
        invalidateBridgeConnection();

        return textResult(JSON.stringify({ success: true, message: `MCP Bridge uninstalled.${uninstallNote}` }));
      }

      // P2-1: Autoload overrides —— 启动游戏前注入任意调试脚本(日志钩子/状态快照等)
      case 'install_override': {
        const projectPath = requireProjectPath(args);
        const sourceScriptPath = args.source_script_path as string | undefined;
        if (!sourceScriptPath) {
          return opsErrorResult('INVALID_PARAMS', 'install_override requires source_script_path (absolute path to .gd script)');
        }
        try {
          const { installOverride } = await import('../core/overrides.js');
          const entry = installOverride(sourceScriptPath, projectPath);
          if (entry === null) {
            return textResult(JSON.stringify({ success: true, message: 'Override already registered, skipped.', already_installed: true }));
          }
          return textResult(JSON.stringify({
            success: true,
            message: `Override installed: ${entry.autoloadKey} (end of the autoload section, loads after the game's autoloads, _ready can use game singletons directly)`,
            autoload_key: entry.autoloadKey,
            dest_script: `res://${entry.destScriptName}`,
            project_root: entry.projectRoot,
          }));
        } catch (err) {
          return opsErrorResult('OVERRIDE_INSTALL_FAILED', getErrorMessage(err));
        }
      }

      case 'uninstall_override': {
        const projectPath = requireProjectPath(args);
        const sourceScriptPath = args.source_script_path as string | undefined;
        if (!sourceScriptPath) {
          return opsErrorResult('INVALID_PARAMS', 'uninstall_override requires source_script_path (absolute path to .gd script)');
        }
        try {
          const { uninstallOverride, deriveOverrideEntry } = await import('../core/overrides.js');
          const removed = uninstallOverride(sourceScriptPath, projectPath);
          const entry = deriveOverrideEntry(sourceScriptPath, projectPath);
          return textResult(JSON.stringify({ success: true, removed, autoload_key: entry.autoloadKey }));
        } catch (err) {
          return opsErrorResult('OVERRIDE_UNINSTALL_FAILED', getErrorMessage(err));
        }
      }

      case 'game_query':
      case 'game_write':
      case 'game_input': {
        // Always update project dir so switching projects between calls works
        ensureProjectDir(ctx, args);
        const methodSets: Record<string, Set<string>> = {
          game_query: QUERY_METHODS,
          game_write: WRITE_METHODS,
          game_input: INPUT_METHODS,
        };
        const allowed = methodSets[action]!;
        const method = args.method as string;
        if (!allowed.has(method)) {
          return textResult(`Error: Unknown bridge method "${method}". Supported: ${[...allowed].join(', ')}. For game methods (e.g. take_damage/emit_signal) use game_write method=call_method params={method:"method_name", args:[...]} (checked against the bridge runtime whitelist, extendable via the GODOT_MCP_BRIDGE_EXTRA_METHODS env)`);
        }
        const rawParams = args.params;
        const params = (rawParams && typeof rawParams === 'object' && !Array.isArray(rawParams))
          ? rawParams as Record<string, unknown>
          : {};
        const rawTimeout = clampTimeoutMs(args.timeout);
        // H1 (2026-08-20): send_input_sequence 延迟响应,超时经 computePlaytestTimeoutMs
        // 统一放宽(wall+10s,审查 N-4 收敛——与 step_until 同一纯函数,不再内联公式)
        const timeout = computePlaytestTimeoutMs(method, params.wall_budget_ms, rawTimeout);
        const pathErr = validateBridgePath(params);
        if (pathErr) return opsErrorResult('INVALID_PATH', pathErr);  // T-1: path /root/ 前置校验
        const response = await sendToBridge(method, params, timeout);
        if (response.error) {
          // Clear cached secret on auth failure so next call re-reads from disk
          // Bridge error codes: -32001 (auth required), -32002 (locked out)
          if (response.error.code === -32001 || response.error.code === -32002) {
            invalidateBridgeSecret();
          }
          return errorResult(`Bridge error (${response.error.code}): ${response.error.message}`);  // T-2: textResult→errorResult(isError=true)
        }
        return textResult(JSON.stringify(response.result, null, 2));
      }

      case 'game_wait': {
        // CRITICAL-3 fix: Bridge wait_for_* is a single snapshot; poll within
        // the timeout window so "wait" actually waits for the condition.
        ensureProjectDir(ctx, args);
        const method = args.method as string;
        if (!WAIT_METHODS.has(method)) {
          return textResult(`Error: Unknown method "${method}". Supported: ${[...WAIT_METHODS].join(', ')}`);
        }
        const rawParams = args.params;
        const params = (rawParams && typeof rawParams === 'object' && !Array.isArray(rawParams))
          ? rawParams as Record<string, unknown>
          : {};
        const totalMs = clampTimeoutMs(args.timeout);
        const intervalMs = clampTimeoutMs(args.interval_ms, 50, 2000, 200);

        const pathErr = validateBridgePath(params);  // T-1: path /root/ 前置校验
        if (pathErr) return opsErrorResult('INVALID_PATH', pathErr);

        // I-2: wait_for_property 还需 property + value;wait_for_node 不校验(纯函数抽离,见模块顶)。
        const waitParamErr = validateWaitPropertyParams(method, params);
        if (waitParamErr) return opsErrorResult('INVALID_PARAMS', waitParamErr);

        const result = await pollWaitCondition(
          method as 'wait_for_node' | 'wait_for_property',
          () => sendToBridge(method, params, Math.min(intervalMs * 2, totalMs)),
          totalMs,
          intervalMs,
        );

        if (result.error) {
          const code = (result.error as { code?: number }).code;
          if (code === -32001 || code === -32002) {
            invalidateBridgeSecret();
          }
          return errorResult(`Bridge error (${code}): ${(result.error as { message?: string }).message ?? 'wait failed'}`);  // T-2: textResult→errorResult(isError=true)
        }
        return textResult(JSON.stringify(result, null, 2));
      }

      // P2-4 确定性 playtest 四原语:seed/fixed_delta/snapshot/restore 同步;step 走 coroutine 延迟响应
      case 'game_playtest': {
        ensureProjectDir(ctx, args);
        const method = args.method as string;
        if (!PLAYTEST_METHODS.has(method) && !CONTROL_METHODS.has(method)) {
          return textResult(`Error: Unknown playtest method "${method}". Supported: ${[...PLAYTEST_METHODS, ...CONTROL_METHODS].join(', ')}`);
        }
        const rawParams = args.params;
        const params = (rawParams && typeof rawParams === 'object' && !Array.isArray(rawParams))
          ? rawParams as Record<string, unknown>
          : {};
        // step/step_until 走 coroutine 延迟响应,需要更长 timeout(N 帧推进 / 条件多帧才满足)。
        // G-3: step_until 的 timeout 由 wall_budget + 5s 余量决定(防 TS 先于 GD idle 60s 到期销毁 socket)
        const timeout = computePlaytestTimeoutMs(method, params.wall_budget_ms, clampTimeoutMs(args.timeout));
        const response = await sendToBridge(method, params, timeout);
        if (response.error) {
          if (response.error.code === -32001 || response.error.code === -32002) {
            invalidateBridgeSecret();
          }
          return errorResult(`Bridge error (${response.error.code}): ${response.error.message}`);
        }
        return textResult(JSON.stringify(response.result, null, 2));
      }

      case 'monitor_start': {
        if (!args.node_path || typeof args.node_path !== 'string') {
          return opsErrorResult('INVALID_PARAMS', 'node_path is required for monitor_start');
        }
        if (!Array.isArray(args.properties) || (args.properties as string[]).length === 0) {
          return opsErrorResult('INVALID_PARAMS', 'properties must be a non-empty array');
        }
        return await bridgeAction('monitor.start', {
          node_path: args.node_path as string,
          properties: args.properties as string[],
          interval_frames: (args.interval_frames as number) ?? 10,
          push: args.push === true,  // P3-6: 传递 push 模式标志到 addon
        }, ctx, clampTimeoutMs(args.timeout));
      }
      case 'monitor_stop':
        return await bridgeAction('monitor.stop', {}, ctx, clampTimeoutMs(args.timeout));
      case 'monitor_poll':
        return await bridgeAction('monitor.poll', {}, ctx, clampTimeoutMs(args.timeout));
      case 'watch_start': {
        if (!args.node_path || typeof args.node_path !== 'string') {
          return opsErrorResult('INVALID_PARAMS', 'node_path is required for watch_start');
        }
        if (!args.signal_name || typeof args.signal_name !== 'string') {
          return opsErrorResult('INVALID_PARAMS', 'signal_name is required for watch_start');
        }
        return await bridgeAction('watch.start', {
          node_path: args.node_path as string,
          signal_name: args.signal_name as string,
          max_events: (args.max_events as number) ?? 1000,
          push: args.push === true,  // P3-6: 传递 push 模式标志到 addon
        }, ctx, clampTimeoutMs(args.timeout));
      }
      case 'watch_stop':
        return await bridgeAction('watch.stop', {}, ctx, clampTimeoutMs(args.timeout));
      case 'watch_poll':
        return await bridgeAction('watch.poll', {}, ctx, clampTimeoutMs(args.timeout));
      case 'find_ui_elements':
        return await bridgeAction('find_ui_elements', {
          pattern: (args.pattern as string) ?? '',
          type: (args.type as string) ?? '',
          visible_only: args.visible_only !== false,
          limit: (args.limit as number) ?? 200,
        }, ctx, clampTimeoutMs(args.timeout));
      case 'click_button': {
        const hasText = args.text && typeof args.text === 'string';
        const hasPath = args.path && typeof args.path === 'string';
        if (!hasText && !hasPath) {
          return opsErrorResult('INVALID_PARAMS', 'click_button requires "text" or "path" parameter');
        }
        return await bridgeAction('click_button', {
          text: (args.text as string) ?? '',
          path: (args.path as string) ?? '',
        }, ctx, clampTimeoutMs(args.timeout));
      }

      default:
        return opsErrorResult('UNKNOWN_ACTION', `Unknown action: ${action}`);
    }
  } catch (err) {
    const msg = getErrorMessage(err);
    if (err instanceof BridgeNotConnectedError) {
      return opsErrorResult(ERROR_CODES.BRIDGE_NOT_CONNECTED, msg, {
        suggestion: 'The game is not running or the bridge is not responding. Start the game with run_project first and make sure game_bridge_install has been run',
      });
    }
    if (err instanceof BridgeTimeoutError) {
      return opsErrorResult(ERROR_CODES.BRIDGE_TIMEOUT, msg, {
        suggestion: 'The game is running but not responding (possibly stuck on a runtime error) — this is not a connection problem. Check the game for errors, or retry with a larger timeout',
      });
    }
    return opsErrorResult(ERROR_CODES.BRIDGE_ERROR, msg);
  }
}

export const TOOL_META: Record<
  string,
  { readonly: boolean; long_running: boolean; actionRisks?: Record<string, RiskLevel> }
> = {
  game: {
    readonly: false,
    long_running: false,
    actionRisks: {
      game_query: 'read',
      game_input: 'read',
      game_wait: 'read',
      monitor_start: 'read',
      monitor_stop: 'read',
      monitor_poll: 'read',
      watch_start: 'read',
      watch_stop: 'read',
      watch_poll: 'read',
      find_ui_elements: 'read',
      click_button: 'read',
      game_bridge_install: 'write',
      game_bridge_uninstall: 'write',
      install_override: 'write',
      uninstall_override: 'write',
      game_write: 'process',
      game_playtest: 'process',  // P2-4: playtest 改引擎时间/帧推进/snapshot restore
    } satisfies Record<typeof ACTIONS[number], RiskLevel>,
  },
};
// 客户端状态重置/就绪探测(re-export,消费方兼容:runtime.ts 的 run_project
// wait_for_bridge 用 isBridgeReady;测试用 resetBridgeState/_testBridgeCacheState)
export { resetBridgeState, isBridgeReady, _testBridgeCacheState, type BridgeReadyResult } from '../core/bridge-client.js';
