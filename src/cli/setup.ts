/** setup 命令 — 一键配置 AI 客户端 */
import { join } from 'path';
import { findGodot } from '../core/godot-finder.js';
import { ALL_ADAPTERS } from './clients/index.js';
import { getErrorMessage } from '../types.js';

/** I-08: 检测 MCP command/args — 改进安装方式判断(setup/configure 共用) */
export function detectMcpCommand(): { command: string; args: string[] } {
  const entryPath = process.argv[1] ?? '';

  // 优先检查 npm_lifecycle_event 判断运行上下文
  const lifecycle = process.env.npm_lifecycle_event;
  if (lifecycle === 'postinstall' || lifecycle === 'preinstall') {
    return { command: 'npx', args: ['godot-mcp-enhanced'] };
  }

  // IMPORTANT-7: 原路径段启发式(npm pack 解压临时目录、CI 本地 node_modules)会误判为全局安装。
  // 改进:优先 npm_config_global 强信号;路径段匹配时排除 npm pack 的隐藏临时段(.package/.staging 等)。
  const pathSegments = entryPath.replace(/\\/g, '/').split('/');
  const hasTempSegment = pathSegments.some(seg => seg.startsWith('.') && seg !== '.');
  const inGlobalNodeModules = (process.env.npm_config_global === 'true' ||
      (pathSegments.includes('node_modules') && pathSegments.includes('godot-mcp-enhanced'))) &&
    !hasTempSegment;

  if (inGlobalNodeModules) {
    return { command: 'npx', args: ['godot-mcp-enhanced'] };
  }

  // 本地开发：用 node + 绝对路径
  const devEntry = join(import.meta.dirname ?? '.', '..', 'index.js');
  return { command: 'node', args: [devEntry] };
}

export async function runSetup(_args: string[]): Promise<void> {
  console.log('🔍 Detecting environment...\n');

  // 1. 发现 Godot
  let godotPath: string;
  try {
    godotPath = await findGodot();
    console.log(`✓ Godot found: ${godotPath}`);
  } catch (err) {
    console.error(`✗ Godot not found: ${getErrorMessage(err)}`);
    // 批 2:TTY 环境引导官方 releases 自动安装;非交互(管道/CI)保持 exit 1 指引
    const { confirmYesNo } = await import('./confirm.js');
    if (await confirmYesNo('\nGodot not found. Download and install the latest stable from official GitHub releases?')) {
      const { installGodot } = await import('./godot-installer.js');
      const { godotPath: installed, versionTag } = await installGodot({
        confirm: async () => true,  // 外层已确认
        onProgress: (msg) => console.log(`  ${msg}`),
      });
      console.log(`✓ Godot ${versionTag} installed: ${installed}`);
      godotPath = installed;
    } else {
      console.error('  Run `npx godot-mcp-enhanced install` to install automatically, or set GODOT_PATH to an existing Godot.');
      process.exit(1);
    }
  }

  // 2. 检测 MCP 命令
  const { command, args: mcpArgs } = detectMcpCommand();

  // 3. 检测 + 配置各客户端
  const projectDir = process.cwd();
  console.log(`\n📁 Project: ${projectDir}\n`);

  let configured = 0;
  for (const adapter of ALL_ADAPTERS) {
    const installed = await adapter.detect();
    if (!installed) {
      console.log(`  ⊘ ${adapter.name} (${adapter.scope}): not installed, skipping`);
      continue;
    }

    const already = await adapter.isConfigured(projectDir);
    if (already) {
      console.log(`  ✓ ${adapter.name} (${adapter.scope}): already configured`);
      continue;
    }

    try {
      await adapter.configure(projectDir, godotPath, command, mcpArgs);
      console.log(`  ✓ ${adapter.name} (${adapter.scope}): configured`);
      configured++;
    } catch (err) {
      console.error(`  ✗ ${adapter.name} (${adapter.scope}): ${getErrorMessage(err)}`);
    }
  }

  console.log(`\n${configured > 0 ? `✓ ${configured} client(s) configured.` : 'No new clients to configure.'}`);
}
