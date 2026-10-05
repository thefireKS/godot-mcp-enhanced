/**
 * 批 3:可玩游戏模板库注册表。
 *
 * 资产为独立散文件(src/game-templates/<slug>/,构建拷贝到 build/game-templates/,
 * npm files 覆盖)——GDScript 保持原样可被语法校验/编辑器打开,内容运行时 fs 读取。
 * 四件套约定(每模板必备):main.tscn / scripts/game.gd(+config gd)/ design/gdd/<slug>.md /
 * qa/<slug>.qa.md / tuning-src/<slug>.csv(含 .gdignore,不进 Godot import)+ tuning/<slug>.tres(运行时 load)。
 */
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { InternalError } from '../core/tool-errors.js';

export interface GameTemplateMeta {
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  /** 模板目录内相对路径清单(全部四件套文件,落地时逐个写盘)。 */
  readonly files: readonly string[];
}

export const GAME_TEMPLATES: Record<string, GameTemplateMeta> = {
  '2048': {
    slug: '2048',
    title: '2048',
    summary: 'Number tiles merge: arrow keys move, equal numbers double on collision, reach 2048',
    files: [
      'main.tscn',
      'scripts/game.gd',
      'scripts/game_config_2048.gd',
      'design/gdd/2048.md',
      'qa/2048.qa.md',
      'tuning-src/2048.csv',
      'tuning-src/.gdignore',
      'tuning/2048.tres',
    ],
  },
  'snake': {
    slug: 'snake',
    title: 'Snake',
    summary: 'Grid snake: moves at a fixed beat, grows when eating, hitting a wall/itself loses',
    files: [
      'main.tscn',
      'scripts/game.gd',
      'scripts/game_config_snake.gd',
      'design/gdd/snake.md',
      'qa/snake.qa.md',
      'tuning-src/snake.csv',
      'tuning-src/.gdignore',
      'tuning/snake.tres',
    ],
  },
  'breakout': {
    slug: 'breakout',
    title: 'Breakout',
    summary: 'Breakout with hand-written AABB physics: the paddle bounces the ball to break bricks, deterministic and frame-reproducible',
    files: [
      'main.tscn',
      'scripts/game.gd',
      'scripts/game_config_breakout.gd',
      'design/gdd/breakout.md',
      'qa/breakout.qa.md',
      'tuning-src/breakout.csv',
      'tuning-src/.gdignore',
      'tuning/breakout.tres',
    ],
  },
};

const __cliDir = dirname(fileURLToPath(import.meta.url));

/** 模板资产根目录:开发态 src/game-templates,npm 态 build/game-templates(探测式,参照 cli/qa.ts opsScript 模式)。 */
export function getGameTemplateDir(): string {
  const devDir = join(__cliDir, '..', '..', 'src', 'game-templates');
  if (existsSync(devDir)) return devDir;
  const buildDir = join(__cliDir, '..', 'game-templates');
  if (existsSync(buildDir)) return buildDir;
  throw new InternalError('game templates directory not found (expected src/game-templates or build/game-templates)');
}

export function listGameTemplates(): { slug: string; title: string; summary: string }[] {
  return Object.values(GAME_TEMPLATES).map(({ slug, title, summary }) => ({ slug, title, summary }));
}

export interface GameTemplateFile {
  path: string;
  content: string;
}

/** 读取模板全部文件;meta 列出的文件缺失即 throw(资产打包不完整的硬失败)。 */
export function readGameTemplateFiles(slug: string): GameTemplateFile[] {
  const meta = GAME_TEMPLATES[slug];
  if (!meta) {
    throw new InternalError(`unknown game template "${slug}". Available: ${Object.keys(GAME_TEMPLATES).join(', ')}`);
  }
  const root = getGameTemplateDir();
  return meta.files.map((rel) => {
    const abs = join(root, slug, rel);
    if (!existsSync(abs)) {
      throw new InternalError(`game template "${slug}" incomplete: missing file ${rel}`);
    }
    return { path: rel, content: readFileSync(abs, 'utf-8') };
  });
}
