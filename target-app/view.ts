// Deliberately "legacy enterprise" HTML: nested tables for layout, no id/data-testid
// attributes, inconsistent class names, inline styles. Real <table>/<input>/<button>
// elements still produce a usable accessibility tree -- that's the point (see REPORT.md).

export function layout(title: string, bannerHtml: string, bodyHtml: string): string {
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>CreditVantage Servicing Console - ${escape(title)}</title>
<style>
  body { font-family: Tahoma, Geneva, sans-serif; font-size: 13px; background:#d9d9d9; margin:0; }
  table.chrome { width:100%; border-collapse:collapse; }
  td.hdr { background:#1b3a6b; color:#fff; padding:8px 12px; font-size:16px; font-weight:bold; }
  td.crumb { background:#c9d6e8; padding:4px 12px; font-size:11px; color:#333; }
  td.content { padding:16px; background:#fff; vertical-align:top; }
  table.data { border-collapse:collapse; margin:8px 0; }
  table.data td, table.data th { border:1px solid #999; padding:4px 10px; font-size:12px; }
  table.data th { background:#e4e4e4; text-align:left; }
  .banner-err { background:#f8d7da; border:1px solid #c0392b; color:#7a1f1f; padding:8px; margin-bottom:10px; }
  .banner-warn { background:#fff3cd; border:1px solid #b58900; color:#5c4a00; padding:8px; margin-bottom:10px; }
  .banner-ok { background:#d4edda; border:1px solid #2e7d32; color:#1b4620; padding:8px; margin-bottom:10px; }
  label { display:inline-block; width:150px; }
  input, select { font-size:13px; padding:2px 4px; }
  button { padding:5px 14px; font-size:12px; }
</style>
</head>
<body>
<table class="chrome"><tr><td class="hdr">CreditVantage &mdash; Member Servicing</td></tr>
<tr><td class="crumb">${escape(title)}</td></tr>
<tr><td class="content">
${bannerHtml}
${bodyHtml}
</td></tr></table>
</body></html>`;
}

export function escape(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

export function money(n: number): string {
  return `$${n.toFixed(2)}`;
}
