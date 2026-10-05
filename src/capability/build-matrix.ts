// src/capability/build-matrix.ts
import { writeFileSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { registerAllModules } from '../module-loader.js';
import { extractCapabilities } from './extract.js';
import type { ToolCapability } from './schema.js';

export function buildMarkdown(caps: ToolCapability[]): string {
  const total = caps.length;
  const byLevel = { 'danger-api': 0, 'guarded': 0, 'safe': 0 };
  const byL2 = { covered: 0, partial: 0, none: 0 };
  for (const c of caps) { byLevel[c.securityLevel]++; byL2[c.verification.l2]++; }
  // risk 四级聚合（全工具 actionRisks 计数汇总）
  const riskTotals = { read: 0, write: 0, destructive: 0, process: 0 };
  for (const c of caps) for (const [k, v] of Object.entries(c.riskDistribution ?? {})) {
    riskTotals[k as keyof typeof riskTotals] += v;
  }
  // trusted-nonread：标 read 但实际启进程/有副作用（项目有意信任不确认）
  const trustedList = caps.flatMap(c => (c.trustedNonRead ?? []).map(a => `\`${c.name}.${a}\``));
  const dangerTools = caps.filter(c => c.securityLevel === 'danger-api').map(c => `- \`${c.name}\` (${c.group})`).join('\n');
  // token 预算（E 组 size 聚合）
  const totalBytes = caps.reduce((s, c) => s + c.size.totalBytes, 0);
  const schemaBytesAll = caps.reduce((s, c) => s + c.size.schemaBytes, 0);
  const descBytesAll = caps.reduce((s, c) => s + c.size.descBytes, 0);
  const schemaPct = totalBytes > 0 ? Math.round((schemaBytesAll / totalBytes) * 100) : 0;
  const top5 = [...caps].sort((a, b) => b.size.totalBytes - a.size.totalBytes).slice(0, 5);
  const top5Lines = top5.map(c =>
    `- \`${c.name}\` (${c.group}): desc ${c.size.descBytes}B / schema ${c.size.schemaBytes}B / total ${c.size.totalBytes}B`
  );
  // P1-2: annotations hint 计数（readOnly / destructive / idempotent）
  const annCount = caps.reduce((acc, c) => {
    if (c.annotations) {
      if (c.annotations.readOnlyHint) acc.readOnly++;
      if (c.annotations.destructiveHint) acc.destructive++;
      if (c.annotations.idempotentHint) acc.idempotent++;
    }
    return acc;
  }, { readOnly: 0, destructive: 0, idempotent: 0 });
  const lines = [
    `# Capability Matrix`,
    ``,
    `> Auto-generated, do not edit. Produced by \`npm run build-matrix\`; drift detection via \`npm run diff-matrix\`.`,
    ``,
    `## Overview`,
    `- Total tools: ${total}`,
    `- securityLevel: danger-api ${byLevel['danger-api']} / guarded ${byLevel['guarded']} / safe ${byLevel['safe']}`,
    `- risk: read ${riskTotals.read} / write ${riskTotals.write} / destructive ${riskTotals.destructive} / process ${riskTotals.process}`,
    `- L2 coverage: covered ${byL2.covered} / partial ${byL2.partial} / none ${byL2.none}`,
    `- Token budget: tools/list ≈ ${totalBytes}B / ~${Math.round(totalBytes / 4)} tokens (description ${descBytesAll}B / schema ${schemaBytesAll}B, schema is ${schemaPct}%)`,
    `- annotations: readOnly ${annCount.readOnly} / destructive ${annCount.destructive} / idempotent ${annCount.idempotent}`,
    ...(trustedList.length > 0 ? [`> Note: marked read but actually spawn processes / have side effects (deliberately trusted, no confirmation): ${trustedList.join(', ')}`] : []),
    ``,
    `## danger-api tools (L2 security regression first)`,
    dangerTools || '(none)',
    ``,
    `## Coverage gaps (L2=none)`,
    ...caps.filter(c => c.verification.l2 === 'none').slice(0, 50).map(c => `- \`${c.name}\` (${c.group})`),
    ``,
    `## Scope decisions (explicitly out of scope)`,
    `The following categories were evaluated (competitor sweep, 2026-08-19) and are deliberately **not done**, not overlooked:`,
    `- **VisualShader graph editing** (yanhuifair: 8 tools / 40+ node types): the VisualShader node graph is a heavily interactive editor domain; text property paths (editing \`VisualShaderNode*\` properties) + the material/shader tools already cover most procedural material needs; maintaining graph-level orchestration (node type matrix × Godot versions) costs far more than it gives. Alternative: the \`material\` tool (shader_read/write/load/save_file) + dynamic construction via \`execute_gdscript\`.`,
    ``,
    `## gdScriptImpl notes`,
    `- editor side: addons/godot_mcp_server/commands/*_commands.gd matched by group`,
    `- headless side: always exists=false (GDScript is generated at runtime by gdscript-executor, no static 1:1 file)`,
    `- editor side: exact routing by tool command (EDITOR_COMMAND_ROUTING, from the command_handler.gd handle() routing table)`,
    ``,
    `## Token budget TOP 5`,
    ...top5Lines,
  ];
  return lines.join('\n');
}

function main(): void {
  const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
  registerAllModules();
  const caps = extractCapabilities(projectRoot);
  caps.sort((a, b) => a.name.localeCompare(b.name));

  const docsDir = join(projectRoot, 'docs');
  mkdirSync(docsDir, { recursive: true });
  // 2026-08-07 审查 P2: 加 version 字段（从 package.json 读），供 CI 校验与 package.json 同步。
  // generatedAt 字段已移除：每次构建写 new Date() 产生无意义 git diff，diff-matrix 不读此字段。
  const pkgVersion = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf-8')).version;
  writeFileSync(join(docsDir, 'capability-matrix.json'), JSON.stringify({ version: pkgVersion, tools: caps }, null, 2));
  writeFileSync(join(docsDir, 'capability-matrix.md'), buildMarkdown(caps));
  console.log(`[build-matrix] ${caps.length} tools (v${pkgVersion}) → docs/capability-matrix.{json,md}`);
}

main();
