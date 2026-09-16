import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_BASE_PATH ?? "/",
  server: { port: 5175, proxy: { "/api": "http://localhost:3005", "/auth": "http://localhost:3005" } },
});
