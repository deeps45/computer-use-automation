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
    const requests = interventionManager.list();
    const rows = requests
      .map((r) => {
        const img = r.screenshotPath
          ? `<br><img src="/evidence/${encodeURIComponent(r.runId)}/${encodeURIComponent(r.screenshotPath)}" style="max-width:220px;border:1px solid #999">`
          : "";
        return `
        <tr>
          <td>${r.id}</td>
          <td>${r.status}</td>
          <td>${r.runType}</td>
          <td>${escapeHtml(r.capabilityOrGoal)}</td>
          <td>${escapeHtml(r.stepDescription)}</td>
          <td>${escapeHtml(r.reason)}${img}</td>
          <td>${escapeHtml(r.urlAtPause)}</td>
          <td>${r.status === "resolved" ? `resolved: ${r.decision}` : `
            <form method="post" action="/intervention/${r.id}/take-control"><button>Take control</button></form>
            <form method="post" action="/intervention/${r.id}/resume">
              <select name="decision">
                <option value="approve_and_continue">Approve &amp; let automation do it</option>
                <option value="manual_completed">I already did it manually</option>
                <option value="abort">Abort run</option>
              </select>
              <input name="humanNotes" placeholder="notes (optional)">
              <button>Resume</button>
            </form>`}
          </td>
        </tr>`;
      })
      .join("");

    res.send(`<!doctype html><html><head><title>Operator Console</title>
      <style>body{font-family:sans-serif;font-size:13px;padding:16px} table{border-collapse:collapse;width:100%} td,th{border:1px solid #ccc;padding:6px;vertical-align:top} form{margin:2px 0}</style>
      </head><body>
      <h2>Operator Console</h2>
      <p>Pending/handled intervention requests raised by the automation process. This is a bare, mocked operator UI (per assignment scope note); the handoff mechanism it drives (pause / take control / resume the same live session) is real.</p>
      <table><tr><th>id</th><th>status</th><th>run</th><th>capability/goal</th><th>step</th><th>reason</th><th>url at pause</th><th>action</th></tr>
      ${rows || '<tr><td colspan="8">No intervention requests yet.</td></tr>'}
      </table>
      <p><a href="javascript:location.reload()">refresh</a></p>
      </body></html>`);
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

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

if (process.argv[1] && process.argv[1].endsWith("operator-server.ts")) {
  startOperatorServer();
}
