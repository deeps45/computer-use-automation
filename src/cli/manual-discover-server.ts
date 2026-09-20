import "dotenv/config";
import express from "express";
import path from "node:path";
import { loadScenario } from "../agent/scenario.js";
import { DiscoverySession } from "../agent/session-controller.js";
import { saveCapability } from "../artifact/store.js";
import { startOperatorServer } from "../handoff/operator-server.js";

/**
 * Thin HTTP control surface around DiscoverySession, for the case where no
 * ANTHROPIC_API_KEY is available to run agent/discovery-loop.ts's automated loop.
 * An LLM (in this project's case, the assistant driving this repo's development
 * itself) plays the observe -> decide -> act policy turn by turn over this API:
 * POST /start, then repeated POST /act, exactly as the automated loop would --
 * same DiscoverySession, same guardrails, same artifact/evidence output. This is
 * a real discovery run against a real live app; only *which* LLM process is
 * choosing the next tool call differs from the production path. See REPORT.md.
 */
const PORT = Number(process.env.DISCOVER_PORT || 4300);
let session: DiscoverySession | null = null;

async function main() {
  startOperatorServer();
  console.log(`Operator console: http://localhost:${process.env.OPERATOR_PORT || 4200}`);

  const app = express();
  app.use(express.json());

  app.post("/start", async (req, res) => {
    if (session) return res.status(400).json({ error: "A session is already active. POST /close first." });
    try {
      const scenario = loadScenario(path.resolve(req.body.scenarioPath));
      session = new DiscoverySession(scenario, Number(process.env.AGENT_MAX_STEPS || 25), Number(process.env.AGENT_MAX_RUNTIME_MS || 6 * 60 * 1000));
      const headless = process.env.HEADLESS === "true";
      const obs = await session.start(headless);
      res.json({ goal: scenario.goal, runId: session.runId, logDir: session.logger.runDir, ...obs });
    } catch (e: any) {
      session = null;
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  app.post("/act", async (req, res) => {
    if (!session) return res.status(400).json({ error: "No active session. POST /start first." });
    try {
      const { tool, ...input } = req.body;
      const result = await session.act(tool, input);
      const payload: any = { resultText: result.resultText, observation: result.observation };
      if (result.outcome) {
        payload.outcome = result.outcome;
        if (result.outcome.status === "success" && result.outcome.capability) {
          const filePath = saveCapability(result.outcome.capability);
          payload.savedArtifactPath = filePath;
        }
        const finishedSession = session;
        session = null;
        await finishedSession.close();
      }
      res.json(payload);
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e), stack: e?.stack });
    }
  });

  app.get("/status", (_req, res) => {
    if (!session) return res.json({ active: false });
    res.json({ active: true, runId: session.runId, steps: session.stepsSoFar(), done: session.isDone() });
  });

  app.post("/close", async (_req, res) => {
    if (session) {
      await session.close();
      session = null;
    }
    res.json({ ok: true });
  });

  app.listen(PORT, () => {
    console.log(`[manual-discover] control server listening on http://localhost:${PORT}`);
    console.log(`  POST /start   { "scenarioPath": "scenarios/<name>.json" }`);
    console.log(`  POST /act     { "tool": "click"|"fill"|"select_option"|"navigate"|"wait"|"extract"|"escalate"|"finish", ...args, "reasoning": "..." }`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
