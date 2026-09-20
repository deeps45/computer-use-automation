import express from "express";
import path from "node:path";
import { interventionManager } from "./intervention-manager.js";

const OPERATOR_PORT = Number(process.env.OPERATOR_PORT || 4200);
const EVIDENCE_ROOT = path.join(process.cwd(), "evidence");

/** Minimal, real operator console: lists pending intervention requests for the CURRENT
 * process's live automation session(s), lets a human "take control" (the automation is
 * already paused -- the visible, headed browser window IS the live session), optionally
 * perform one manual action via API (stand-in for literal mouse/keyboard input -- see
 * REPORT.md #5 for what a production remote-control seam would use instead), and signal
 * resume. This file is intentionally a bare surface, not a polished console -- explicitly
 * allowed to be mocked per the assignment brief (section 3.6 scope note). */
export function startOperatorServer() {
  const app = express();
  app.use(express.json());
  app.use("/evidence", express.static(EVIDENCE_ROOT));

  app.get("/", (_req, res) => {
    res.send(OPERATOR_PAGE_HTML);
  });

  app.post("/intervention/:id/take-control", (req, res) => {
    interventionManager.takeControl(req.params.id);
    res.redirect("/");
  });

  // Executes ONE action directly on the live page for this request -- represents a
  // human operator's input (mouse/keyboard on the visible browser, or a remote-control
  // channel in production) being applied to the same automation session.
  app.post("/intervention/:id/manual-action", express.json(), async (req, res) => {
    const request = interventionManager.get(req.params.id);
    if (!request) return res.status(404).json({ error: "not found" });
    const { type, role, name, value } = req.body as { type: string; role?: string; name?: string; value?: string };
    try {
      if (type === "click" && role && name) {
        await request.page.getByRole(role as any, { name, exact: true }).first().click();
      } else if (type === "fill" && role && name && value !== undefined) {
        await request.page.getByRole(role as any, { name, exact: true }).first().fill(value);
      } else {
        return res.status(400).json({ error: "unsupported manual action" });
      }
      interventionManager.recordManualAction(req.params.id, `${type} ${role} "${name}"${value ? ` = ${value}` : ""}`);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  app.post("/intervention/:id/resume", (req, res) => {
    const decision = (req.body?.decision || "approve_and_continue") as any;
    const humanNotes = req.body?.humanNotes;
    interventionManager.resolve(req.params.id, decision, humanNotes || undefined);
    res.redirect("/");
  });

  // JSON API variant, used by the scripted evidence-capture flow (see /evidence/README.md)
  app.post("/api/intervention/:id/resume", (req, res) => {
    const { decision, humanNotes } = req.body as { decision: string; humanNotes?: string };
    interventionManager.resolve(req.params.id, decision as any, humanNotes);
    res.json({ ok: true });
  });
  app.get("/api/intervention", (_req, res) => {
    res.json(
      interventionManager.list().map((r) => ({ ...r, page: undefined }))
    );
  });

  const server = app.listen(OPERATOR_PORT, () => {
    console.log(`[operator] console listening on http://localhost:${OPERATOR_PORT}`);
  });
  return server;
}

if (process.argv[1] && process.argv[1].endsWith("operator-server.ts")) {
  startOperatorServer();
}

// Single static shell; all data comes from GET /api/intervention (polled) so the page
// never goes stale mid-escalation. No build step, no external assets -- a local operator
// tool has no business depending on a CDN. Bare by design per the assignment's scope note
// (a full co-browsing console is explicitly out of scope); this is the presentable version
// of that same bare surface.
const OPERATOR_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Operator Console</title>
<style>
  :root {
    --bg: #f4f5f7; --card: #ffffff; --ink: #1a1d23; --muted: #6b7280; --border: #e5e7eb;
    --accent: #2563eb; --accent-ink: #ffffff;
    --pending: #b45309; --pending-bg: #fef3c7;
    --progress: #1d4ed8; --progress-bg: #dbeafe;
    --resolved: #15803d; --resolved-bg: #dcfce7;
    --aborted: #b91c1c; --aborted-bg: #fee2e2;
    --danger: #dc2626;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif;
  }
  header {
    background: #111827; color: #fff; padding: 18px 28px;
    display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 8px;
  }
  header h1 { font-size: 17px; margin: 0; font-weight: 650; letter-spacing: -0.01em; }
  header p { margin: 2px 0 0; font-size: 12.5px; color: #9ca3af; max-width: 62ch; }
  .status-bar { display: flex; align-items: center; gap: 8px; font-size: 12px; color: #9ca3af; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: #34d399; box-shadow: 0 0 0 3px rgba(52,211,153,.18); }
  main { max-width: 1080px; margin: 0 auto; padding: 22px 24px 60px; }
  .toolbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; }
  .toolbar h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 0; font-weight: 650; }
  .counts { display: flex; gap: 6px; }
  .count-pill { font-size: 11.5px; padding: 3px 9px; border-radius: 999px; background: #fff; border: 1px solid var(--border); color: var(--muted); }
  .empty { background: var(--card); border: 1px dashed var(--border); border-radius: 12px; padding: 40px 20px; text-align: center; color: var(--muted); }
  .empty strong { display: block; color: var(--ink); font-size: 15px; margin-bottom: 4px; }
  .grid { display: grid; gap: 14px; }
  .card {
    background: var(--card); border: 1px solid var(--border); border-radius: 12px;
    padding: 16px 18px; box-shadow: 0 1px 2px rgba(0,0,0,.03);
  }
  .card.is-pending { border-left: 3px solid var(--pending); }
  .card.is-in_progress { border-left: 3px solid var(--progress); }
  .card.is-resolved { border-left: 3px solid var(--resolved); opacity: .8; }
  .card-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
  .id { font: 600 11.5px/1 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--muted); }
  .pill { font-size: 11px; font-weight: 650; padding: 3px 9px; border-radius: 999px; text-transform: capitalize; white-space: nowrap; }
  .pill.pending { color: var(--pending); background: var(--pending-bg); }
  .pill.in_progress { color: var(--progress); background: var(--progress-bg); }
  .pill.resolved { color: var(--resolved); background: var(--resolved-bg); }
  .pill.decision-abort { color: var(--aborted); background: var(--aborted-bg); }
  .goal { font-size: 15px; font-weight: 650; margin: 8px 0 2px; }
  .reason { color: #374151; font-size: 13px; margin: 2px 0 10px; }
  .meta { display: grid; grid-template-columns: 96px 1fr; gap: 3px 10px; font-size: 12.5px; color: var(--muted); margin-bottom: 10px; }
  .meta code { font: 12px ui-monospace, monospace; color: #374151; word-break: break-all; }
  .body-row { display: flex; gap: 14px; align-items: flex-start; }
  .thumb { flex: none; width: 168px; }
  .thumb img { width: 100%; border-radius: 8px; border: 1px solid var(--border); cursor: zoom-in; display: block; }
  .thumb .cap { font-size: 11px; color: var(--muted); margin-top: 4px; text-align: center; }
  .actions { flex: 1; min-width: 240px; }
  .action-row { display: flex; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
  button, select, input[type=text] {
    font: inherit; font-size: 13px; border-radius: 7px; border: 1px solid var(--border);
    padding: 7px 10px; background: #fff; color: var(--ink);
  }
  button { cursor: pointer; }
  button.primary { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); font-weight: 600; }
  button.primary:hover { background: #1d4ed8; }
  button.ghost { background: #fff; }
  button.ghost:hover { background: #f9fafb; }
  button:disabled { opacity: .5; cursor: default; }
  input[type=text] { width: 100%; }
  .notes { width: 100%; margin-top: 6px; }
  details { margin-top: 8px; }
  details summary { font-size: 12px; color: var(--muted); cursor: pointer; user-select: none; }
  .manual-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-top: 8px; }
  .manual-grid .full { grid-column: 1 / -1; }
  .log { margin-top: 10px; border-top: 1px solid var(--border); padding-top: 8px; }
  .log-item { font-size: 12px; color: var(--muted); display: flex; gap: 6px; padding: 2px 0; }
  .log-item .who { font-weight: 650; color: var(--ink); }
  .resolved-summary { font-size: 12.5px; color: var(--muted); margin-top: 4px; }
  .toast { position: fixed; bottom: 18px; right: 18px; background: #111827; color: #fff; padding: 10px 16px; border-radius: 8px; font-size: 13px; opacity: 0; transform: translateY(6px); transition: .18s; pointer-events: none; }
  .toast.show { opacity: 1; transform: translateY(0); }
  .lightbox { position: fixed; inset: 0; background: rgba(0,0,0,.78); display: none; align-items: center; justify-content: center; z-index: 50; padding: 30px; }
  .lightbox.show { display: flex; }
  .lightbox img { max-width: 100%; max-height: 100%; border-radius: 6px; box-shadow: 0 10px 40px rgba(0,0,0,.4); }
</style>
</head>
<body>
<header>
  <div>
    <h1>Operator Console</h1>
    <p>Live intervention requests from the automation process -- take control of the exact same paused browser session, or approve/abort and hand it back. A bare, mocked operator surface per the assignment's own scope note; the pause/resume mechanism it drives is real.</p>
  </div>
  <div class="status-bar"><span class="dot"></span><span id="last-updated">connecting&hellip;</span></div>
</header>
<main>
  <div class="toolbar">
    <h2>Requests</h2>
    <div class="counts" id="counts"></div>
  </div>
  <div id="content"><div class="empty"><strong>Loading&hellip;</strong></div></div>
</main>
<div class="toast" id="toast"></div>
<div class="lightbox" id="lightbox"><img id="lightbox-img" alt="screenshot"></div>
<script>
const content = document.getElementById('content');
const counts = document.getElementById('counts');
const lastUpdated = document.getElementById('last-updated');
const toast = document.getElementById('toast');
const lightbox = document.getElementById('lightbox');
const lightboxImg = document.getElementById('lightbox-img');

lightbox.addEventListener('click', () => lightbox.classList.remove('show'));

function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2200);
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}

function timeAgo(iso) {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  return Math.round(s / 3600) + 'h ago';
}

async function api(path, opts) {
  const res = await fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts));
  if (!res.ok) { const t = await res.text(); throw new Error(t || res.statusText); }
  return res.status === 204 ? null : res.json();
}

function screenshotUrl(r) {
  if (!r.screenshotPath) return null;
  return '/evidence/' + encodeURIComponent(r.runId) + '/' + r.screenshotPath.split('/').map(encodeURIComponent).join('/');
}

function renderCard(r) {
  const img = screenshotUrl(r);
  const decisionPill = r.decision === 'abort' ? '<span class="pill decision-abort">aborted</span>' : '';
  const statusPill = '<span class="pill ' + r.status + '">' + r.status.replace('_', ' ') + '</span>';

  const manualLog = (r.manualActions || []).map(function (a) {
    return '<div class="log-item"><span class="who">human</span><span>' + esc(a.description) + '</span><span style="margin-left:auto;color:#9ca3af">' + timeAgo(a.at) + '</span></div>';
  }).join('');

  let actionsHtml;
  if (r.status === 'resolved') {
    actionsHtml = '<div class="resolved-summary">Resolved <strong>' + esc(r.decision) + '</strong> ' + timeAgo(r.resolvedAt) + (r.humanNotes ? ' &mdash; &ldquo;' + esc(r.humanNotes) + '&rdquo;' : '') + '</div>';
  } else {
    actionsHtml =
      '<div class="action-row">' +
        '<button class="ghost" data-action="take-control" data-id="' + r.id + '">Take control</button>' +
      '</div>' +
      '<div class="action-row">' +
        '<select data-role="decision" data-id="' + r.id + '">' +
          '<option value="approve_and_continue">Approve &mdash; let the agent do it</option>' +
          '<option value="manual_completed">I already did it manually</option>' +
          '<option value="abort">Abort run</option>' +
        '</select>' +
      '</div>' +
      '<input type="text" class="notes" placeholder="notes (optional)" data-role="notes" data-id="' + r.id + '">' +
      '<div class="action-row" style="margin-top:8px">' +
        '<button class="primary" data-action="resume" data-id="' + r.id + '">Resume</button>' +
      '</div>' +
      '<details>' +
        '<summary>Perform one action directly on the live session&hellip;</summary>' +
        '<div class="manual-grid">' +
          '<select data-role="manual-type" data-id="' + r.id + '"><option value="click">click</option><option value="fill">fill</option></select>' +
          '<input type="text" placeholder="role (e.g. button)" data-role="manual-role" data-id="' + r.id + '">' +
          '<input type="text" class="full" placeholder="accessible name (e.g. Confirm & Open Account)" data-role="manual-name" data-id="' + r.id + '">' +
          '<input type="text" class="full" placeholder="value (fill only)" data-role="manual-value" data-id="' + r.id + '">' +
          '<button class="ghost full" data-action="manual" data-id="' + r.id + '">Run on live session</button>' +
        '</div>' +
      '</details>';
  }

  return (
    '<div class="card is-' + r.status + '" data-card="' + r.id + '">' +
      '<div class="card-top">' +
        '<span class="id">#' + r.id + ' &middot; ' + esc(r.runType) + '</span>' +
        '<div>' + statusPill + decisionPill + '</div>' +
      '</div>' +
      '<div class="goal">' + esc(r.capabilityOrGoal) + '</div>' +
      '<div class="reason">' + esc(r.reason) + '</div>' +
      '<div class="meta">' +
        '<span>step</span><span>' + esc(r.stepDescription) + '</span>' +
        '<span>paused at</span><code>' + esc(r.urlAtPause) + '</code>' +
        '<span>raised</span><span>' + timeAgo(r.createdAt) + '</span>' +
      '</div>' +
      '<div class="body-row">' +
        (img ? '<div class="thumb"><img src="' + img + '" data-lightbox alt="paused screen"><div class="cap">live session at pause</div></div>' : '') +
        '<div class="actions">' + actionsHtml + '</div>' +
      '</div>' +
      (manualLog ? '<div class="log">' + manualLog + '</div>' : '') +
    '</div>'
  );
}

function render(list) {
  const pending = list.filter(function (r) { return r.status !== 'resolved'; }).length;
  const resolved = list.length - pending;
  counts.innerHTML =
    '<span class="count-pill">' + pending + ' open</span>' +
    '<span class="count-pill">' + resolved + ' resolved</span>';

  if (list.length === 0) {
    content.innerHTML = '<div class="empty"><strong>No intervention requests yet</strong>Waiting for a discovery or replay run to raise one -- an irreversible action, an agent-requested escalation, or an unrecoverable error will show up here.</div>';
    return;
  }
  content.innerHTML = '<div class="grid">' + list.map(renderCard).join('') + '</div>';
}

async function refresh() {
  try {
    const list = await api('/api/intervention');
    render(list);
    lastUpdated.textContent = 'updated ' + timeAgo(new Date().toISOString());
  } catch (e) {
    lastUpdated.textContent = 'connection lost -- retrying';
  }
}

content.addEventListener('click', async function (ev) {
  const img = ev.target.closest('[data-lightbox]');
  if (img) { lightboxImg.src = img.src; lightbox.classList.add('show'); return; }

  const btn = ev.target.closest('button[data-action]');
  if (!btn) return;
  const id = btn.dataset.id;
  const action = btn.dataset.action;
  btn.disabled = true;
  try {
    if (action === 'take-control') {
      await api('/intervention/' + id + '/take-control', { method: 'POST', headers: {} });
      showToast('Marked as in progress');
    } else if (action === 'resume') {
      const decision = document.querySelector('[data-role="decision"][data-id="' + id + '"]').value;
      const humanNotes = document.querySelector('[data-role="notes"][data-id="' + id + '"]').value;
      await api('/api/intervention/' + id + '/resume', { method: 'POST', body: JSON.stringify({ decision: decision, humanNotes: humanNotes }) });
      showToast('Resumed: ' + decision.replace(/_/g, ' '));
    } else if (action === 'manual') {
      const type = document.querySelector('[data-role="manual-type"][data-id="' + id + '"]').value;
      const role = document.querySelector('[data-role="manual-role"][data-id="' + id + '"]').value;
      const name = document.querySelector('[data-role="manual-name"][data-id="' + id + '"]').value;
      const value = document.querySelector('[data-role="manual-value"][data-id="' + id + '"]').value;
      await api('/intervention/' + id + '/manual-action', { method: 'POST', body: JSON.stringify({ type: type, role: role, name: name, value: value || undefined }) });
      showToast('Performed on the live session');
    }
    await refresh();
  } catch (e) {
    showToast('Failed: ' + e.message);
  } finally {
    btn.disabled = false;
  }
});

refresh();
setInterval(refresh, 3000);
</script>
</body>
</html>`;
