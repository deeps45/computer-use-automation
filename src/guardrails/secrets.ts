/** Resolves a secretRef by name to a live value at replay/discovery time. Never
 * written to disk by this module, never logged (RunLogger redacts by field name too,
 * as defense in depth). Backed by env vars for this project; a production deployment
 * would point this at a real secret manager (Vault, AWS Secrets Manager, etc.) --
 * this is the seam where that swap happens. */
export function resolveSecret(name: string): string {
  const envKey = `CVSS_${name.toUpperCase()}`;
  const value = process.env[envKey];
  if (!value) {
    throw new Error(`Secret "${name}" not available: set env var ${envKey} (see README.md).`);
  }
  return value;
}
