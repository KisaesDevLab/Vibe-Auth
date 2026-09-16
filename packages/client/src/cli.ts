#!/usr/bin/env node
/**
 * vibe-auth CLI — runs inside a product container.
 *
 *   npx vibe-auth breakglass ensure|rotate|status [--json]
 *
 * The product tells the CLI how to reach its users by exporting an adapter
 * module. Resolution order:
 *   1. VIBE_AUTH_ADAPTER (path to a module)
 *   2. package.json → "vibeAuth": { "adapter": "./dist/vibe-auth-adapter.js" }
 *
 * The module's default export is either a VibeAuthCliAdapter or an async
 * factory returning one:
 *   { users: UserAdapter; audit?: AuditSink; adminRole: string; close?(): Promise<void> }
 */
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AuditSink, UserAdapter } from "./adapters/types.js";
import { consoleAuditSink, makeAudit } from "./audit.js";
import { breakglassEnsure, breakglassRotate, breakglassStatus } from "./breakglass.js";
import { loadEnvConfig } from "./config.js";

export interface VibeAuthCliAdapter {
  users: UserAdapter;
  audit?: AuditSink;
  adminRole: string;
  breakglassEmail?: string;
  close?(): Promise<void>;
}

async function loadAdapter(): Promise<VibeAuthCliAdapter> {
  let modPath = process.env.VIBE_AUTH_ADAPTER;
  if (!modPath) {
    try {
      const pkg = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8")) as { vibeAuth?: { adapter?: string } };
      modPath = pkg.vibeAuth?.adapter;
    } catch {
      // ignore
    }
  }
  if (!modPath) {
    throw new Error('No adapter configured. Set VIBE_AUTH_ADAPTER=<path> or add "vibeAuth": { "adapter": "<path>" } to package.json.');
  }
  const mod = (await import(pathToFileURL(resolve(process.cwd(), modPath)).href)) as { default?: unknown };
  let adapter = mod.default;
  if (typeof adapter === "function") adapter = await (adapter as () => Promise<VibeAuthCliAdapter> | VibeAuthCliAdapter)();
  const a = adapter as VibeAuthCliAdapter | undefined;
  if (!a || !a.users || !a.adminRole) throw new Error(`Adapter module ${modPath} must default-export { users, adminRole }`);
  return a;
}

function usage(): never {
  process.stderr.write("usage: vibe-auth breakglass <ensure|rotate|status> [--json]\n");
  process.exit(2);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const [group, cmd, ...rest] = argv;
  const asJson = rest.includes("--json") || !process.stdout.isTTY;
  if (group !== "breakglass" || !cmd) usage();

  const env = loadEnvConfig();
  const adapter = await loadAdapter();
  const audit = makeAudit(adapter.audit ?? consoleAuditSink);
  const common = {
    users: adapter.users,
    audit,
    username: env.VIBE_BREAKGLASS_USERNAME,
    adminRole: adapter.adminRole,
    email: adapter.breakglassEmail,
    password: env.VIBE_BREAKGLASS_PASSWORD,
    actor: process.env.VIBE_AUTH_ACTOR ?? "cli",
  };

  try {
    let out: Record<string, unknown>;
    if (cmd === "ensure") out = { ...(await breakglassEnsure(common)) };
    else if (cmd === "rotate") out = { ...(await breakglassRotate(common)) };
    else if (cmd === "status") out = { username: env.VIBE_BREAKGLASS_USERNAME, ...(await breakglassStatus(common)) };
    else usage();

    if (asJson) process.stdout.write(JSON.stringify(out) + "\n");
    else {
      for (const [k, v] of Object.entries(out)) process.stdout.write(`${k}: ${String(v)}\n`);
      if (out.password) process.stdout.write("\nThis password is shown ONCE. Store it in the Appliance secret store now.\n");
    }
  } finally {
    await adapter.close?.();
  }
}

const isDirect = (() => {
  try {
    const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
    return entry === import.meta.url || /vibe-auth(\/dist\/cli\.[cm]?js)?$/.test(process.argv[1] ?? "");
  } catch {
    return false;
  }
})();
if (isDirect) {
  main().catch((err) => {
    process.stderr.write(`vibe-auth: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
