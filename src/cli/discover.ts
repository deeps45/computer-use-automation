import "dotenv/config";
import path from "node:path";
import { loadScenario } from "../agent/scenario.js";
import { runDiscovery } from "../agent/discovery-loop.js";
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

  const outcome = await runDiscovery(scenario);

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
