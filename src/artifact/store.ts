import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { CapabilitySchema, type Capability } from "./schema.js";

const ARTIFACT_ROOT = path.join(process.cwd(), "artifacts");

export function saveCapability(capability: Capability): string {
  const parsed = CapabilitySchema.parse(capability); // fail loudly if the shape is wrong
  const dir = path.join(ARTIFACT_ROOT, parsed.id);
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `v${parsed.version}.json`);
  writeFileSync(filePath, JSON.stringify(parsed, null, 2));
  writeFileSync(path.join(dir, "latest.json"), JSON.stringify(parsed, null, 2));
  return filePath;
}

export function loadCapability(idOrPath: string, version?: number): Capability {
  let filePath: string;
  if (idOrPath.endsWith(".json") && existsSync(idOrPath)) {
    filePath = idOrPath;
  } else {
    const dir = path.join(ARTIFACT_ROOT, idOrPath);
    filePath = version ? path.join(dir, `v${version}.json`) : path.join(dir, "latest.json");
  }
  if (!existsSync(filePath)) {
    throw new Error(`Capability artifact not found: ${filePath}`);
  }
  const raw = JSON.parse(readFileSync(filePath, "utf-8"));
  return CapabilitySchema.parse(raw);
}

export function listCapabilities(): string[] {
  if (!existsSync(ARTIFACT_ROOT)) return [];
  return readdirSync(ARTIFACT_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}
