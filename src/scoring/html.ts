import type { ScoreJson } from './types.js';
import { NA_SCORE, DIM_ORDER } from './dimensions.js';
import { dimMetric } from './metric.js';

/** status → class 白名单(防 class 属性逃逸注入:不把 d.status 原值拼进属性) */
const STATUS_CLASS: Record<string, string> = {
  pass: 'status-pass', warn: 'status-warn', fail: 'status-fail', na: 'status-na',
};

/**
 * HTML 转义:全字符集 & < > " ',& 必须先转(防 &lt; 二次转义 &amp;lt;)。
 * 只接 string——数字(total/score)直接插值不传此函数。
 * 历史依据:项目踩过 gdscript-template-injection(模板插值未转义)+ escapeTscnValue 漏 [(escape 漏字符)。
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')   // 必须先
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const CSS = `
body { font-family: system-ui, sans-serif; margin: 2rem; color: #1a1a1a; max-width: 60rem; }
.total { font-size: 2rem; font-weight: bold; }
.badge { padding: 0.2rem 0.6rem; border-radius: 4px; color: #fff; font-size: 1rem; }
.status-pass { background: #16a34a; }
.status-warn { background: #ca8a04; }
.status-fail { background: #dc2626; }
.status-na, .status-unknown { background: #71717a; }
table { border-collapse: collapse; margin: 1rem 0; }
th, td { border: 1px solid #d4d4d4; padding: 0.4rem 0.8rem; text-align: left; }
.status-cell { font-weight: bold; color: #fff; }
h2 { margin-top: 1.5rem; }
`;

/** status 文本节点:白名单内原值,异常值固定 'unknown'(防 d.status 原字符串字母 payload 出现在文本节点) */
function statusText(status: string): string {
  return STATUS_CLASS[status] ? status : 'unknown';
}

/** 渲染 score.json → 自包含 HTML(静态 + 内联 CSS,无外部依赖)。所有字符串插值过 escapeHtml;status 白名单映射 class。 */
export function renderScoreHtml(score: ScoreJson): string {
  const overall = score.pass ? 'PASS' : 'FAIL';
  const overallClass = score.pass ? 'status-pass' : 'status-fail';
  const total = Object.keys(score.dimensions).length;
  const verified = total - score.unverified.length;
  const partialTag = score.partial ? ` (partial: ${verified}/${total} dimensions verified)` : '';

  const rows = DIM_ORDER.map(name => {
    const d = score.dimensions[name];
    const scoreCell = d.score === NA_SCORE ? '—' : String(d.score);
    const cls = STATUS_CLASS[d.status] ?? 'status-unknown';   // 白名单,不拼原 status
    const metric = escapeHtml(dimMetric(name, d));
    // gdscript raw.details 明细(若存在),全量过 escapeHtml 防 XSS
    let detailsHtml = '';
    const raw = d.raw as { details?: string[] } | undefined;
    if (raw?.details && raw.details.length > 0) {
      detailsHtml = '<ul class="details">' +
        raw.details.map(det => `<li>${escapeHtml(det)}</li>`).join('') +
        '</ul>';
    }
    return `      <tr><td>${escapeHtml(name)}</td><td>${scoreCell}</td><td>${d.weight}</td>` +
           `<td class="status-cell ${cls}">${escapeHtml(statusText(d.status))}</td><td>${metric}${detailsHtml}</td></tr>`;
  }).join('\n');

  const hardFailsHtml = score.hardFails.length === 0
    ? '    <p>(none)</p>'
    : '    <ul>\n' + score.hardFails.map(hf =>
        `      <li>${escapeHtml(hf.dimension)}: ${escapeHtml(hf.reason)} (${hf.actual} &lt; ${hf.threshold})</li>`
      ).join('\n') + '\n    </ul>';

  const unverifiedHtml = score.unverified.length === 0
    ? '    <p>(none)</p>'
    : `    <p>${escapeHtml(score.unverified.join(', '))} — wired in M3c-e</p>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Quality score report</title>
  <style>${CSS}</style>
</head>
<body>
  <h1>Quality score report</h1>
  <div class="total">${score.total} / 100 <span class="badge ${overallClass}">${overall}</span></div>
  <p>${escapeHtml(score.generatedAt)}${partialTag}</p>
  <h2>Dimensions</h2>
  <table>
    <thead><tr><th>Dimension</th><th>Score</th><th>Weight</th><th>Status</th><th>Key metrics</th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>
  <h2>Hard vetoes</h2>
${hardFailsHtml}
  <h2>Unverified dimensions</h2>
${unverifiedHtml}
</body>
</html>`;
}
