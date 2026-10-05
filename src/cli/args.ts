/**
 * CLI 参数解析共享原语(2026-08-21 架构审查 C-2:消灭 gif/web/qa/init 四处重复的 opt/num;
 * 2026-08-21 七维度审核 P2-7/8/9/10 扩为完整版:补 hasFlag/num range,五命令接线)。
 *
 * 约定:支持 `--name=value` 与 `--name value` 双形式(B-1 审查约定:单形式解析会让
 * 另一形式静默回落默认值——init --template 空格形式曾静默落空骨架、skills --target
 * 等号形式曾静默装错目录)。
 */

/** 取字符串选项;两种形式都认。未指定返回 undefined。 */
export function opt(args: string[], name: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === `--${name}`) return args[i + 1];           // 空格形式(相邻消费)
    if (a.startsWith(`--${name}=`)) return a.split('=').slice(1).join('=');
  }
  return undefined;
}

/** flag 存在性(`--name` 或 `--name=...` 任一形态),用于无值开关与「传了但缺值」判定。 */
export function hasFlag(args: string[], name: string): boolean {
  return args.some(a => a === `--${name}` || a.startsWith(`--${name}=`));
}

/** 取数字选项;未指定用 fallback,非数字报错退出(exit 2)。range 给定时钳制到闭区间。 */
export function num(args: string[], name: string, fallback: number, range?: [number, number]): number {
  const v = opt(args, name);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    console.error(`--${name} needs a number, got "${v}"`);
    process.exit(2);
  }
  return range ? Math.max(range[0], Math.min(range[1], n)) : n;
}
