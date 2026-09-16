import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Served by the broker at {VIBE_AUTH_BASE_PATH}/admin/ — assets must be relative.
export default defineConfig({
  plugins: [react()],
  base: "./",
  server: { port: 5176, proxy: { "/vibe-auth/api": "http://localhost:8080", "/vibe-auth/auth": "http://localhost:8080" } },
});
