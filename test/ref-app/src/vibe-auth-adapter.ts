/** CLI adapter for `npx vibe-auth breakglass …` (package.json → vibeAuth.adapter). */
import type { VibeAuthCliAdapter } from "@kisaesdevlab/vibe-auth";
import { audit, users, ROLES } from "./adapters.js";
import { migrate, pool } from "./db.js";

const adapter = async (): Promise<VibeAuthCliAdapter> => {
  await migrate();
  return {
    users,
    audit,
    adminRole: ROLES.adminRole,
    breakglassEmail: "breakglass@ref.local",
    close: () => pool.end(),
  };
};
export default adapter;
