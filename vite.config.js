import { defineConfig } from "vite";

// Forward backend calls to the FastAPI server (backend/server.py, port 8000)
// so every browser reaches it through the dashboard's own origin.
export default defineConfig({
  // Relative asset paths so the static build also works under a sub-path
  // (GitHub Pages serves it at https://<user>.github.io/<repo>/).
  base: "./",
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8000",
      "/ws": { target: "ws://127.0.0.1:8000", ws: true }
    }
  }
});
