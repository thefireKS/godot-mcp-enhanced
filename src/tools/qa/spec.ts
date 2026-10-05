// src/tools/qa/spec.ts — QA 测试套件规范（zod schema + 解析器）
//
// B 批（v0.30）：结构化测试规范是 qa 工具的输入契约。
// - 三种输入形态：inline JSON 对象（MCP args.spec）/ .json 文件 / markdown ```qa-spec 围栏
// - 全部经 QaSuiteSchema 严格校验（zod v4，仓库既有依赖，无新增）
// - spec 校验错误以人类可读消息返回（LLM 可直接修 spec），不抛异常

import { z } from 'zod';

// ─── 步骤 schema（discriminated union on `type`）─────────────────────────────

const labelField = z.string().min(1).max(120).optional();

/** input：模拟玩家输入（bridge INPUT_METHODS 直转） */
const inputStep = z.object({
  type: z.literal('input'),
  method: z.enum(['send_key', 'send_mouse_click', 'send_mouse_move', 'send_text', 'send_touch', 'send_drag',
    // H1 (2026-08-20) 帧定时输入时间线（延迟响应,qa 步骤超时需覆盖 wall_budget）
    'send_input_sequence']),
  /** bridge 原生参数，如 {key,pressed} / {x,y,button} / {text} / {timeline,settle_frames} */
  params: z.record(z.string(), z.unknown()),
  label: labelField,
});

/** wait：轮询等待节点出现/属性匹配（pollWaitCondition 语义） */
const waitStep = z.object({
  type: z.literal('wait'),
  method: z.enum(['wait_for_node', 'wait_for_property']),
  /** wait_for_node 需 path（/root/ 前缀）；wait_for_property 需 path+property+value */
  params: z.record(z.string(), z.unknown()),
  timeout_ms: z.number().int().min(500).max(60000).optional(),
  interval_ms: z.number().int().min(100).max(2000).optional(),
  label: labelField,
});

/** wait_frames：确定性推进 N 帧（playtest.step，游戏须已 freeze 或配合 freeze 使用） */
const waitFramesStep = z.object({
  type: z.literal('wait_frames'),
  frames: z.number().int().min(1).max(60),
  label: labelField,
});

const freezeStep = z.object({ type: z.literal('freeze'), label: labelField });
const unfreezeStep = z.object({ type: z.literal('unfreeze'), label: labelField });

/** step_until：确定性推进至结构化条件满足（规避 Expression RCE，与 game 工具同语义） */
const stepUntilStep = z.object({
  type: z.literal('step_until'),
  conditions: z.array(z.object({
    path: z.string().min(1),
    property: z.string().min(1),
    op: z.enum(['==', '!=', '<', '>', '<=', '>=']),
    value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  })).min(1).max(10),
  max_frames: z.number().int().min(1).max(600).optional(),
  wall_budget_ms: z.number().int().min(1000).max(50000).optional(),
  label: labelField,
});

const snapshotStep = z.object({ type: z.literal('snapshot'), label: labelField });
const restoreStep = z.object({ type: z.literal('restore'), label: labelField });

/** set：写节点属性（set_node_property） */
const setStep = z.object({
  type: z.literal('set'),
  path: z.string().min(1),
  property: z.string().min(1),
  value: z.unknown(),
  label: labelField,
});

/** call：调节点方法（call_method，受 bridge 只读白名单 + EXTRA_METHODS 逃生口约束） */
const callStep = z.object({
  type: z.literal('call'),
  path: z.string().min(1),
  method: z.string().min(1),
  args: z.array(z.unknown()).optional(),
  label: labelField,
});

/** assert：8 种断言（4 种走 runtime_assert，4 种为 PR-1a 新增：screenshot_diff/signal/errors/monitor） */
const assertStep = z.object({
  type: z.literal('assert'),
  assert: z.enum(['node_state', 'scene_structure', 'screen_text', 'perf', 'screenshot_diff', 'signal', 'errors', 'monitor']),
  // node_state
  path: z.string().optional(),
  expect: z.record(z.string(), z.unknown()).optional(),
  tolerance: z.number().optional(),
  // scene_structure
  nodes: z.array(z.object({
    path: z.string(),
    type: z.string().optional(),
    absent: z.boolean().optional(),
  })).optional(),
  // screen_text
  text: z.string().optional(),
  present: z.boolean().optional(),
  // perf
  baseline: z.record(z.string(), z.number()).optional(),
  // screenshot_diff（像素差异容忍语义，与 screenshot 工具 action=diff 同引擎）
  reference: z.string().optional(),
  threshold: z.number().min(0).max(1).optional(),
  max_diff_ratio: z.number().min(0).max(1).optional(),
  // signal（事件计数区间；args_match 按 GD _jsonify 后形态深比较：Vector2→{x,y}、Color→{r,g,b,a}）
  min_count: z.number().int().min(0).optional(),
  max_count: z.number().int().min(0).optional(),
  args_match: z.unknown().optional(),
  // errors（测试期间游戏侧新增错误计数）
  kinds: z.array(z.enum(['error', 'script', 'shader', 'warning'])).optional(),
  // monitor（属性时间线区间/单调性；min/max 为区间断言，Task 4 补——zod 默认 strip 未知键，
  // 缺 schema 时 parse 后 step.min/max 为 undefined，区间断言静默失效）
  property: z.string().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  monotonic: z.enum(['increasing', 'non_decreasing', 'decreasing', 'non_increasing']).optional(),
  label: labelField,
});

/** screenshot：截图存为报告证据（PNG 落 qa-reports 目录） */
const screenshotStep = z.object({ type: z.literal('screenshot'), label: labelField });

/** sleep：TS 侧等待（帧无关的墙钟等待，优先用 wait/wait_frames） */
const sleepStep = z.object({
  type: z.literal('sleep'),
  ms: z.number().int().min(100).max(10000),
  label: labelField,
});

/** watch_start：开始监听节点信号（bridge watch.start；每套件同时仅 1 个活跃 watch，重复→执行期 ERROR） */
const watchStartStep = z.object({
  type: z.literal('watch_start'),
  node_path: z.string().min(1),
  signal_name: z.string().min(1),
  max_events: z.number().int().min(1).max(5000).optional(),
  label: labelField,
});

const watchStopStep = z.object({ type: z.literal('watch_stop'), label: labelField });

/** monitor_start：开始属性时间线采样（bridge monitor.start；每套件同时仅 1 个活跃 monitor） */
const monitorStartStep = z.object({
  type: z.literal('monitor_start'),
  node_path: z.string().min(1),
  properties: z.array(z.string().min(1)).min(1).max(10),
  interval_frames: z.number().int().min(1).max(300).optional(),
  label: labelField,
});

const monitorStopStep = z.object({ type: z.literal('monitor_stop'), label: labelField });

export const QA_STEP_TYPES = [
  'input', 'wait', 'wait_frames', 'freeze', 'unfreeze', 'step_until',
  'snapshot', 'restore', 'set', 'call', 'assert', 'screenshot', 'sleep',
  'watch_start', 'watch_stop', 'monitor_start', 'monitor_stop',
] as const;

export const QaStepSchema = z.discriminatedUnion('type', [
  inputStep, waitStep, waitFramesStep, freezeStep, unfreezeStep, stepUntilStep,
  snapshotStep, restoreStep, setStep, callStep, assertStep, screenshotStep, sleepStep,
  watchStartStep, watchStopStep, monitorStartStep, monitorStopStep,
]);

// ─── 套件选项 ────────────────────────────────────────────────────────────────

export const QaOptionsSchema = z.object({
  /** 自动 game_bridge_install（幂等，旧键自动迁移） */
  auto_install_bridge: z.boolean().default(true),
  /** 自动 run_project（false = 连接已运行中的游戏，需游戏已装 bridge 且在跑） */
  auto_run: z.boolean().default(true),
  /** 结束后 stop_project（仅 auto_run=true 起的游戏会被收尾；auto_run=false 时游戏非本套件启动，此开关不生效，需自行 stop_project） */
  stop_after: z.boolean().default(true),
  /** 断言失败/步骤错误后是否继续执行剩余步骤（默认 false：首个非 PASSED 即中止） */
  continue_on_failure: z.boolean().default(false),
  /** playtest.seed：锁全局 RNG（确定性回放） */
  seed: z.number().int().optional(),
  /** playtest.fixed_delta：锁 physics 步长（hz） */
  fixed_delta_hz: z.number().int().min(1).max(240).optional(),
  /** 单步 bridge 请求超时（step/step_until 类延迟响应按 computePlaytestTimeoutMs 公式） */
  step_timeout_ms: z.number().int().min(1000).max(60000).default(30000),
  /** wait 步骤默认轮询窗口 */
  wait_timeout_ms: z.number().int().min(500).max(60000).default(10000),
  /** run_project 的 bridge 就绪等待（秒） */
  bridge_timeout_s: z.number().min(1).max(120).default(15),
  /** run_project 自动停止计时（秒，套件须在此内完成；stop_after 正常收尾会更早停） */
  run_timeout_s: z.number().int().min(30).max(3600).default(600),
  /** 套件总墙钟预算（ms），超预算剩余步骤标记 SKIPPED */
  suite_budget_ms: z.number().int().min(10000).max(600000).default(300000),
  /**
   * 失败自动留录制（QA 收尾批①）：setup 就绪后开始录制输入事件，teardown 前 stop；
   * 结果非 PASSED 时 events 落盘 qa-reports/<run_id>-recording.json（成功丢弃）。
   * recording.start 不可用（旧 bridge）仅记 teardown_warning 降级，不阻断套件。
   */
  record_on_failure: z.boolean().default(false),
});

// ─── 套件 ────────────────────────────────────────────────────────────────────

export const QaSuiteSchema = z.object({
  name: z.string().min(1).max(80),
  /** 可省略，由工具参数 project_path / CLI --project 提供 */
  project_path: z.string().optional(),
  options: QaOptionsSchema.prefault({}),
  steps: z.array(QaStepSchema).min(1).max(200),
});

export type QaStep = z.infer<typeof QaStepSchema>;
export type QaOptions = z.infer<typeof QaOptionsSchema>;
export type QaSuite = z.infer<typeof QaSuiteSchema>;

// ─── 解析器 ──────────────────────────────────────────────────────────────────

/** 从原始文本提取 spec JSON：裸 JSON 或 markdown ```qa-spec 围栏 */
export function extractSpecJson(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    return JSON.parse(trimmed);
  }
  // markdown 围栏：```qa-spec ... ```（容忍围栏信息字符串后缀，如 ```qa-spec json）
  const m = trimmed.match(/```qa-spec[^\n]*\n([\s\S]*?)```/i);
  if (m?.[1]) {
    const body = m[1].trim();
    if (body.startsWith('{')) return JSON.parse(body);
  }
  throw new Error(
    'The spec source is neither bare JSON nor a ```qa-spec fence. Expected: JSON starting with "{", or a JSON block inside a ```qa-spec fence in markdown.',
  );
}

export interface ParsedSpec {
  ok: boolean;
  suite?: QaSuite;
  error?: string;
}

/** 校验 + 解析套件 spec。失败返回 ok:false + 人类可读错误（含 zod issue 路径），绝不抛异常 */
export function parseQaSuite(input: unknown): ParsedSpec {
  let raw: unknown;
  if (typeof input === 'string') {
    try {
      raw = extractSpecJson(input);
    } catch (err) {
      // 源格式错误（非 JSON/无围栏/JSON.parse 语法错）直接返回干净消息，不进 zod
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  } else {
    raw = input;
  }
  if (raw === undefined || raw === null) {
    return { ok: false, error: 'spec is empty. Provide an inline spec object, .json file content or a markdown ```qa-spec fence.' };
  }
  const result = QaSuiteSchema.safeParse(raw);
  if (result.success) {
    return { ok: true, suite: result.data };
  }
  const issues = result.error.issues.slice(0, 5).map(i => `  - ${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`);
  const more = result.error.issues.length > 5 ? `\n  (${result.error.issues.length - 5} more issues)` : '';
  return {
    ok: false,
    error: `QA spec validation failed (${result.error.issues.length} issues):\n${issues.join('\n')}${more}`,
  };
}
