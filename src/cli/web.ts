/**
 * 批 4b:Web 试玩闭环 CLI——`npx godot-mcp-enhanced web <project> [--port N]`。
 * 链路:findGodot → detectGodotVersion → export templates 检测/安装(确认+复用批 2
 * 信任链)→ ensureWebPreset → headless --export-release → 确认起服(127.0.0.1)→
 * 打印 URL,Ctrl+C 退出。`--serve-only <dir>` 跳过导出直接 serve(已导出重玩)。
 */
import { join, resolve } from 'path';
import { existsSync } from 'fs';
import { findGodot, detectGodotVersion } from '../core/godot-finder.js';
import { installExportTemplates, ensureWebPreset, exportWeb } from './web-exporter.js';
import { startWebServer } from './web-server.js';
import { confirmYesNo } from './confirm.js';
import { opt } from './args.js';

export async function runWeb(args: string[]): Promise<void> {
  const serveOnly = opt(args, 'serve-only');
  const portArg = opt(args, 'port');
  const port = portArg !== undefined && /^\d+$/.test(portArg) ? Number(portArg) : 0;

  if (serveOnly) {
    const dir = resolve(serveOnly);
    if (!existsSync(join(dir, 'index.html'))) {
      console.error(`--serve-only directory has no index.html: ${dir}`);
      process.exit(2);
    }
    if (!(await confirmYesNo(`Start a static server on 127.0.0.1 serving ${dir}?`))) {
      console.error('Cancelled');
      process.exit(1);
    }
    await serveForever(dir, port);
    return;
  }

  const projectPath = resolve(args[0] ?? '.');
  if (!existsSync(join(projectPath, 'project.godot'))) {
    console.error('Usage: web <project-path> [--port N] or web --serve-only <exported-dir> [--port N]');
    process.exit(2);
  }

  console.log('🌐 Web playtest loop (export → local server → playable in the browser)');
  const godotPath = await findGodot();
  const version = await detectGodotVersion(godotPath);  // 如 "4.7.2.stable"
  console.log(`  Godot: ${godotPath}(${version})`);

  await installExportTemplates({
    version,
    confirm: () => confirmYesNo(`The first web export needs export templates ${version} (~1GB, official releases, SHA512-checked, installed machine-wide). Continue?`),
    onProgress: (msg) => console.log(`  ${msg}`),
  });

  if (ensureWebPreset(projectPath)) {
    console.log('  Generated export_presets.cfg (Web preset)');
  }
  const webDir = await exportWeb(projectPath, godotPath, (msg) => console.log(`  ${msg}`));
  console.log(`✓ Web export done: ${webDir}`);

  if (!(await confirmYesNo(`Start a local server to play (127.0.0.1${port ? ':' + port : ' random port'})?`))) {
    console.log(`Skipped. You can do it later: npx godot-mcp-enhanced web --serve-only "${webDir}"`);
    return;
  }
  await serveForever(webDir, port);
}

async function serveForever(dir: string, port: number): Promise<never> {
  const running = await startWebServer(dir, port);
  console.log(`\n✓ Play at: ${running.url}`);
  console.log('  (Ctrl+C stops the server and exits)');
  // 用一个不占 CPU 的常驻 promise 保活;SIGINT 里优雅关服
  await new Promise<never>((_resolve, reject) => {
    process.on('SIGINT', () => {
      running.close().finally(() => process.exit(0));
    });
    process.on('SIGTERM', () => {
      running.close().finally(() => process.exit(0));
    });
    // 未监听信号的异常退出兜底
    process.on('exit', () => { running.server.close(); });
    void reject; // 保持 promise pending(常驻)
  });
  process.exit(0);
}
