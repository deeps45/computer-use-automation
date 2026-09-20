import "dotenv/config";
import path from "node:path";
import { loadScenario } from "../agent/scenario.js";
import { runDiscovery } from "../agent/discovery-loop.js";
import { runDiscoveryOpenAICompat } from "../agent/discovery-loop-openai-compat.js";
import { saveCapability } from "../artifact/store.js";
import { startOperatorServer } from "../handoff/operator-server.js";

async function main() {
  const scenarioPath = process.argv[2];
  if (!scenarioPath) {
    console.error("Usage: npm run discover -- scenarios/<name>.json");
    process.exit(1);
  }
  const scenario = loadScenario(path.resolve(scenarioPath));

  startOperatorServer();
  console.log(`Operator console: http://localhost:${process.env.OPERATOR_PORT || 4200}`);
  console.log(`Running discovery for capability "${scenario.capabilityId}"...`);

  // Provider is picked by which credentials are present -- ANTHROPIC_API_KEY drives the
  // Anthropic Messages API loop directly; OPENAI_COMPAT_API_KEY drives the identical
  // DiscoverySession through any OpenAI-compatible chat-completions gateway instead. Both
  // are "real" automated paths -- see discovery-loop-openai-compat.ts and REPORT.md.
  const useOpenAICompat = !process.env.ANTHROPIC_API_KEY && !!process.env.OPENAI_COMPAT_API_KEY;
  if (useOpenAICompat) {
    console.log(`Provider: OpenAI-compatible gateway (${process.env.OPENAI_COMPAT_MODEL || "protected.Claude Sonnet 4.5"} @ ${process.env.OPENAI_COMPAT_BASE_URL})`);
  } else {
    console.log(`Provider: Anthropic Messages API (${process.env.MODEL_ID || "claude-sonnet-5"})`);
  }

  const outcome = useOpenAICompat ? await runDiscoveryOpenAICompat(scenario) : await runDiscovery(scenario);

  if (outcome.status === "success" && outcome.capability) {
    const filePath = saveCapability(outcome.capability);
    console.log(`\nDiscovery succeeded.`);
    console.log(`Capability artifact saved: ${filePath}`);
    console.log(`Evidence: ${outcome.logDir}`);
  } else {
    console.log(`\nDiscovery ended with status: ${outcome.status}`);
    console.log(`Evidence: ${outcome.logDir}`);
    process.exitCode = 1;
  }
  process.exit(process.exitCode || 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
