import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    cli: "src/cli.ts",
    tauri: "src/tauri.ts",
    "react/index": "src/react/index.ts",
    "sql/drizzle": "src/sql/drizzle.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  target: "node20",
  external: ["express", "react", "react/jsx-runtime", "drizzle-orm"],
  banner: ({ format }) => (format === "esm" ? { js: "" } : {}),
});
