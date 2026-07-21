import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [react(), tailwindcss()],

  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },

  server: {
    port: 5173,
    /**
     * Proxying /api to the backend in development means the browser sees a
     * single origin.
     *
     * That matters more than convenience: auth uses httpOnly cookies, and
     * same-origin requests carry them with no CORS preflight and no
     * SameSite complications. Developing against a cross-origin setup and
     * deploying same-origin (or the reverse) is how cookie bugs reach
     * production — the local setup here mirrors what a reverse proxy would
     * do in front of both services.
     */
    proxy: {
      "/api": {
        target: "http://localhost:8080",
        changeOrigin: true,
      },
      "/health": {
        target: "http://localhost:8080",
        changeOrigin: true,
      },
    },
  },

  build: {
    // Source maps so a production stack trace in Sentry points at real code
    // rather than a single minified line.
    sourcemap: true,
  },
});
