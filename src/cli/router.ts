import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __cliDir = dirname(fileURLToPath(import.meta.url));
const __rootDir = join(__cliDir, '..', '..');

/** CLI 子命令清单(export 供 test/cli/router.test.ts 单一真相源引用,防硬编码漂移) */
export const SUBCOMMANDS = ['setup', 'configure', 'skills', 'doctor', 'init', 'dashboard', 'qa', 'install', 'gif', 'web'] as const;
export type Subcommand = typeof SUBCOMMANDS[number];

export function parseSubcommand(args: string[]): { subcommand: Subcommand; rest: string[] } | null {
  if (args.length === 0) return null;
  const first = args[0]!;
  if ((SUBCOMMANDS as readonly string[]).includes(first)) {
    return { subcommand: first as Subcommand, rest: args.slice(1) };
  }
  return null;
}

export async function routeCommand(args: string[]): Promise<void> {
  const parsed = parseSubcommand(args);
  if (!parsed) {
    console.error(`Unknown command: ${args[0]!}`);
    console.error('Run "godot-mcp-enhanced --help" for usage.');
    process.exit(1);
  }

  switch (parsed.subcommand) {
    case 'setup': {
      const { runSetup } = await import('./setup.js');
      await runSetup(parsed.rest);
      break;
    }
    case 'configure': {
      const { runConfigure } = await import('./configure.js');
      await runConfigure(parsed.rest);
      break;
    }
    case 'skills': {
      const { runSkills } = await import('./skills.js');
      await runSkills(parsed.rest);
      break;
    }
    case 'doctor': {
      const { runDoctor } = await import('./doctor.js');
      await runDoctor(parsed.rest);
      break;
    }
    case 'init': {
      const { runInit } = await import('./init.js');
      await runInit(parsed.rest);
      break;
    }
    case 'dashboard': {
      const { launchDashboardOnce } = await import('../dashboard/launcher.js');
      launchDashboardOnce();
      console.log('Dashboard starting... (use the separate terminal window)');
      process.exit(0);
      break; // unreachable — no-fallthrough 需要显式终止语句（process.exit 不被识别）
    }
    case 'qa': {
      const { runQa } = await import('./qa.js');
      await runQa(parsed.rest);
      break;
    }
    case 'web': {
      const { runWeb } = await import('./web.js');
      await runWeb(parsed.rest);
      break;
    }
    case 'gif': {
      const { runGif } = await import('./gif.js');
      await runGif(parsed.rest);
      break;
    }
    case 'install': {
      const { runInstall } = await import('./godot-installer.js');
      await runInstall(parsed.rest);
      break;
    }
  }
}

export function isCliInvocation(args: string[]): boolean {
  if (args.length === 0) return false;
  const first = args[0]!;
  if (first.startsWith('-')) {
    // --help / --version 走 CLI
    if (first === '--help' || first === '-h' || first === '--version' || first === '-v') return true;
    // --profile=xxx 等 MCP flags 不走 CLI
    return false;
  }
  // 子命令走 CLI
  return (SUBCOMMANDS as readonly string[]).includes(first);
}

/**
 * 未知子命令检测:首参非 flag 且不在子命令表内。
 * 2026-08-21 架构审查 MAJOR-1:此前这种输入静默落入 stdio MCP server(终端表现为
 * 挂起等 stdin,零提示);router 的 Unknown command 分支对此不可达。分流处
 * (index.ts)先调本函数,报错退出而非启动 server。
 */
export function isUnknownCommand(args: string[]): boolean {
  if (args.length === 0) return false;
  const first = args[0]!;
  if (first.startsWith('-')) return false;
  return !(SUBCOMMANDS as readonly string[]).includes(first);
}

export function showHelp(): void {
  console.log(`
godot-mcp-enhanced — AI development environment for Godot

Usage:
  godot-mcp-enhanced                  start the MCP server (stdio mode)
  godot-mcp-enhanced setup            configure AI clients in one go
  godot-mcp-enhanced configure <client>  configure a single client (--list lists all, --force forces)
  godot-mcp-enhanced skills [install]   list/install the bundled Claude Code skills (install supports --target <dir> --force)
  godot-mcp-enhanced doctor           environment diagnostics
  godot-mcp-enhanced init <name>      create a Godot project
  godot-mcp-enhanced dashboard        start the monitoring dashboard
  godot-mcp-enhanced qa run <spec>    run a QA test suite (nightly batch)
  godot-mcp-enhanced install [tag]   install Godot from official releases (default latest stable; zero-preinstall start)
  godot-mcp-enhanced gif <project>  record a demo GIF (bridge fixed-rate screenshots; --fps/--seconds/--keys/--out)
  godot-mcp-enhanced web <project>  web playtest loop (export + 127.0.0.1 server; --port/--serve-only)

MCP arguments:
  --profile=<name>  tool profile (full/minimal/lite)
  --minimal         minimal tool set
  --lite            lightweight tool set
  --help, -h        show help
  --version, -v     show version
`);
}

export async function showVersion(): Promise<void> {
  try {
    const pkg = JSON.parse(readFileSync(join(__rootDir, 'package.json'), 'utf-8'));
    console.log(`godot-mcp-enhanced v${pkg.version}`);
  } catch {
    console.log('godot-mcp-enhanced (version unknown)');
  }
}
