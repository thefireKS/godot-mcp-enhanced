import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { generateScore } from './generate-score.js';
import { evaluateGate } from './gate.js';
import { renderPrComment } from './pr-comment.js';
import { renderScoreHtml } from './html.js';
import type { ScoreJson } from './types.js';

/** 读 score.json + 结构守卫(失败 throw,cli 用 try/catch 接 → console.error + exit)。gate/pr-comment/html 3 处共用。 */
function loadScore(scorePath: string): ScoreJson {
  if (!existsSync(scorePath)) throw new Error('score.json does not exist, run npm run score first');
  let score: ScoreJson;
  try {
    score = JSON.parse(readFileSync(scorePath, 'utf8'));
  } catch {
    throw new Error('Failed to parse score.json, re-run npm run score');
  }
  if (!score || typeof score.total !== 'number' || !Array.isArray(score.hardFails)) {
    throw new Error('score.json is malformed (total/hardFails missing or wrong type), re-run npm run score');
  }
  return score;
}

// CLI 入口:node build/scoring/cli.js [gate]
const entry = fileURLToPath(import.meta.url);
const arg1 = process.argv[1];
const invoked = arg1 !== undefined && resolve(arg1) === entry;
if (invoked) {
  const cmd = process.argv[2];
  if (cmd === 'gate') {
    const scorePath = resolve(process.cwd(), 'coverage/score.json');
    let score: ScoreJson;
    try {
      score = loadScore(scorePath);
    } catch (e) {
      console.error((e as Error).message);
      process.exit(1);
    }
    const { passed, reasons } = evaluateGate(score);
    if (!passed) {
      console.error('Quality gate failed:\n' + reasons.join('\n'));
      process.exit(1);
    }
    process.stdout.write(`Quality gate passed: total=${score.total}\n`);
  } else if (cmd === 'pr-comment') {
    const scorePath = resolve(process.cwd(), 'coverage/score.json');
    let score: ScoreJson;
    try {
      score = loadScore(scorePath);
    } catch (e) {
      console.error((e as Error).message);
      process.exit(1);
    }
    const outPath = resolve(process.cwd(), 'coverage/pr-comment.md');
    writeFileSync(outPath, renderPrComment(score), 'utf8');
    process.stdout.write(`PR comment written: ${outPath}\n`);
  } else if (cmd === 'html') {
    const scorePath = resolve(process.cwd(), 'coverage/score.json');
    let score: ScoreJson;
    try {
      score = loadScore(scorePath);
    } catch (e) {
      console.error((e as Error).message);
      process.exit(1);
    }
    const outPath = resolve(process.cwd(), 'coverage/score-report.html');
    writeFileSync(outPath, renderScoreHtml(score), 'utf8');
    process.stdout.write(`HTML report written: ${outPath}\n`);
  } else {
    const lcovPath = resolve(process.cwd(), 'coverage/lcov.info');
    const outPath = resolve(process.cwd(), 'coverage/score.json');
    const e2eReportPath = resolve(process.cwd(), 'coverage/e2e-report.json');
    const auditJsonPath = resolve(process.cwd(), 'coverage/audit.json');
    const gdscriptReportPath = resolve(process.cwd(), 'coverage/gdscript-report.json');
    const performanceReportPath = resolve(process.cwd(), 'coverage/test-report.json');
    const score = generateScore({ lcovPath, outPath, e2eReportPath, auditJsonPath, gdscriptReportPath, performanceReportPath });
    process.stdout.write(
      `score: ${score.total} pass=${score.pass} partial=${score.partial} unverified=${score.unverified.length} → ${outPath}\n`,
    );
  }
}
