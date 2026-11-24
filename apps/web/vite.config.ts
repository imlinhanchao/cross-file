import { defineConfig, searchForWorkspaceRoot } from "vite";
import react from "@vitejs/plugin-react";

const SIGNALING_TARGET =
  process.env.CROSSFILE_SIGNALING_URL ?? "ws://127.0.0.1:8788";

/**
 * Dev-only reporter endpoint used by cross-machine acceptance tests: the receiving
 * browser POSTs its computed SHA-256 to `/__report?...` (same origin, so an https
 * page can report without mixed-content blocking). No effect on production builds.
 */
function devReportPlugin() {
  return {
    name: "crossfile-dev-report",
    apply: "serve" as const,
    configureServer(server: {
      middlewares: {
        use: (
          path: string,
          fn: (
            req: { url?: string },
            res: { statusCode: number; end: () => void },
          ) => void,
        ) => void;
      };
    }) {
      server.middlewares.use("/__report", (req, res) => {
        console.log("[cf-report]", req.url ?? "");
        res.statusCode = 204;
        res.end();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), devReportPlugin()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    // Dev HTTPS is terminated by the existing reverse proxy
    // (https://room.net.time-pack.com -> 127.0.0.1:5173).
    allowedHosts: true,
    fs: {
      allow: [searchForWorkspaceRoot(process.cwd())],
    },
    proxy: {
      // Same-origin in dev: the browser only ever talks to https://room.../v1/ws.
      "/v1/ws": {
        target: SIGNALING_TARGET,
        ws: true,
        changeOrigin: true,
      },
    },
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
});
