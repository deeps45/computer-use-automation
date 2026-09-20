import "dotenv/config";
import { loadCapability } from "../artifact/store.js";
import { runReplay } from "../replay/executor.js";
import { startOperatorServer } from "../handoff/operator-server.js";

function parseArgs(argv: string[]) {
  const capabilityRef = argv[0];
  const params: Record<string, string> = {};
  let allowIrreversible = false;
  let simulate: "timeout" | "slow" | "error500" | undefined;

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--param") {
      const [k, ...rest] = argv[++i].split("=");
      params[k] = rest.join("=");
    } else if (arg === "--allow-irreversible") {
      allowIrreversible = true;
    } else if (arg === "--simulate") {
      simulate = argv[++i] as any;
    }
  }
  return { capabilityRef, params, allowIrreversible, simulate };
}

async function main() {
  const { capabilityRef, params, allowIrreversible, simulate } = parseArgs(process.argv.slice(2));
  if (!capabilityRef) {
    console.error(
      'Usage: npm run replay -- <capabilityId|path> [--param key=value ...] [--allow-irreversible] [--simulate timeout|slow|error500]'
    );
    process.exit(1);
  }
  const capability = loadCapability(capabilityRef);

  startOperatorServer();
  console.log(`Operator console: http://localhost:${process.env.OPERATOR_PORT || 4200}`);
  console.log(`Replaying capability "${capability.id}" v${capability.version} with params:`, params);

  const result = await runReplay(capability, params, { allowIrreversible, simulate });

  console.log("\n=== Replay result ===");
  console.log(JSON.stringify(result, null, 2));

  process.exit(result.status === "failure" ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
