/** One-shot entrypoint: create the vibe_auth database/role if absent (D7), then exit. */
import { loadConfig } from "./config.js";
import { Db } from "./db.js";

const cfg = loadConfig({ ...process.env, VIBE_AUTH_HOST: process.env.VIBE_AUTH_HOST ?? "localhost" });
const db = new Db(cfg);
db.ensureDatabase()
  .then(() => {
    console.log(JSON.stringify({ msg: "db-init complete", adminUrl: !!cfg.VIBE_AUTH_PG_ADMIN_URL }));
    process.exit(0);
  })
  .catch((err) => {
    console.error(JSON.stringify({ msg: "db-init failed", error: (err as Error).message }));
    process.exit(1);
  });
