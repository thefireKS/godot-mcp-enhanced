// src/core/addon-version.ts
// 复刻 scripts/version-sync.mjs:57（读版本正则）+ scripts/install-plugin.js:17-65（cp+verify）。
// 改进：MCP 场景加 deny-by-default 白名单门（CLI 是用户主动信任，MCP 是 AI 调用）。
import { readFileSync, existsSync, cpSync, rmSync, renameSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { validateProjectRoot, isPathInAllowedRoots, safeRealPath } from './path-utils.js';
import { PathError, InternalError } from './tool-errors.js';

const ADDON_REL = ['addons', 'godot_mcp_server'] as const;
// build/core/addon-version.js → 上两级包根 → addons/godot_mcp_server
// tsconfig outDir=build/rootDir=src；开发时同理指仓库根/addons
const addonSource = join(dirname(fileURLToPath(import.meta.url)), '..', '..', ...ADDON_REL);

/** 读目标项目 addon 版本。正则复刻 version-sync.mjs:57。 */
export function readAddonVersion(projectPath: string): { version: string | null; installed: boolean } {
  if (!isPathInAllowedRoots(projectPath)) {
    throw new PathError('projectPath is not in ALLOWED_PROJECT_PATHS (deny-by-default)');
  }
  const cfg = join(projectPath, ...ADDON_REL, 'plugin.cfg');
  // S1: 校验 cfg 真实路径在 allowlist 内——堵 addons/ 子段符号链接越界读（信息泄漏）。
  const realCfg = safeRealPath(cfg);
  if (!isPathInAllowedRoots(realCfg)) {
    throw new PathError('readAddonVersion path escapes allowed roots');
  }
  if (!existsSync(realCfg)) return { version: null, installed: false };
  const m = readFileSync(realCfg, 'utf-8').match(/^version="([^"\r]*)"/m);
  return { version: m?.[1] ?? null, installed: true };
}

/** 包内 addon 源 cp 到目标项目。复刻 install-plugin.js:17-65 + 加门。 */
export function updateAddon(projectPath: string): { dest: string; verifyOk: boolean } {
  if (!isPathInAllowedRoots(projectPath)) {
    throw new PathError('projectPath is not in ALLOWED_PROJECT_PATHS (deny-by-default)');
  }
  const real = safeRealPath(validateProjectRoot(projectPath));  // project.godot 检查 + symlink 归一
  const dest = join(real, ...ADDON_REL);
  // S1: 校验 dest 真实路径在 allowlist 内——堵 addons/ 子段符号链接越界写。
  // safeRealPath 对不存在路径 walk-up 找存在祖先再 realpath（首装 dest 不存在安全）。
  const realDest = safeRealPath(dest);
  if (!isPathInAllowedRoots(realDest)) {
    throw new PathError('updateAddon dest escapes allowed roots');
  }
  // S3: 原子替换——staging 完整 cp + 校验 + 备份 + 平台 rename + 回滚。
  // 目标：cpSync 中途失败（断电/磁盘满/权限）不留下破损 addon（旧 dest 完整保留 + 无 staging 残留）。
  // 平台行为：POSIX renameSync 原子覆盖；Windows 不能覆盖非空目录，先 rmSync(dest) 再 rename
  // （非纯原子——但 staging 已校验完整 + dest.bak 备份可回滚，best-effort 接受）。
  const staging = join(real, '.addon-staging-' + process.pid);
  rmSync(staging, { recursive: true, force: true });
  try {
    cpSync(addonSource, staging, { recursive: true });
  } catch (err) {
    // staging cp 失败：清理残留再抛（dest 未被触及）
    rmSync(staging, { recursive: true, force: true });
    throw err;
  }
  // 校验 staging 完整（plugin.cfg 关键字段）——staging 不完整则清理并抛
  const stagingCfg = readFileSync(join(staging, 'plugin.cfg'), 'utf-8');
  if (!stagingCfg.includes('[plugin]') || !stagingCfg.includes('script="plugin.gd"')) {
    rmSync(staging, { recursive: true, force: true });
    throw new InternalError('updateAddon staging verify failed (plugin.cfg missing/invalid)');
  }
  // 备份旧 dest（若存在）——dest.bak 用于 rename 失败时回滚
  let backup: string | null = null;
  if (existsSync(dest)) {
    backup = dest + '.bak';
    rmSync(backup, { recursive: true, force: true });
    renameSync(dest, backup);  // 移走 dest，为 rename(staging→dest) 让路
  }
  try {
    // 确保 dest 父目录存在（首装场景 addons/ 可能不存在——renameSync 不自动建父目录）。
    // mkdir recursive 对已存在目录是 no-op，不影响原子性（不影响 dest 内容）。
    mkdirSync(dirname(dest), { recursive: true });
    if (process.platform === 'win32') {
      // Windows: renameSync 不能覆盖非空目录。dest 已被 backup 移走（force 对 no-op 兜底）。
      // 若 rm 与 rename 间中断：dest 丢失但 staging 完整 + 备份 dest.bak 可手动恢复（best-effort）。
      rmSync(dest, { recursive: true, force: true });
      renameSync(staging, dest);
    } else {
      // POSIX: rename 原子覆盖（dest 不存在/已被 backup 移走）
      renameSync(staging, dest);
    }
    if (backup) rmSync(backup, { recursive: true, force: true });  // 成功后清备份
  } catch (err) {
    // 回滚：恢复备份（若有），清理 staging，重抛原始错误
    if (backup) {
      try { renameSync(backup, dest); } catch { /* best-effort，原始错误优先 */ }
    }
    rmSync(staging, { recursive: true, force: true });
    throw err;
  }
  const content = readFileSync(join(dest, 'plugin.cfg'), 'utf-8');
  const verifyOk = content.includes('[plugin]') && content.includes('script="plugin.gd"');
  return { dest, verifyOk: verifyOk && isPathInAllowedRoots(safeRealPath(join(dest, 'plugin.cfg'))) };
}
