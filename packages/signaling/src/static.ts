/**
 * Optional static hosting for the built web app (production single-origin deploy).
 *
 * docs/02 §7: the signaling process may serve the frontend, but it must never log
 * requests, never write to disk, never set cookies. Everything below is read-only:
 * index.html is cached in memory, assets are streamed from the dist directory.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createReadStream, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";

export interface StaticHandler {
  (request: IncomingMessage, response: ServerResponse): boolean;
  /** false when index.html could not be read (static hosting disabled) */
  readonly ready: boolean;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

/** docs/01 §5 / docs/02 §2.2: fragment keys must never leak via referer, no third-party origins. */
const SECURITY_HEADERS: Record<string, string> = {
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "permissions-policy":
    "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  "content-security-policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self' ws: wss:",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join("; "),
};

export async function createStaticHandler(
  rootDir: string,
): Promise<StaticHandler> {
  const root = resolve(rootDir);
  let indexHtml: Buffer | null = null;
  try {
    indexHtml = await readFile(join(root, "index.html"));
  } catch {
    return Object.assign(
      (_request: IncomingMessage, _response: ServerResponse): boolean => false,
      { ready: false as const },
    );
  }
  const cachedIndex = indexHtml;

  function handler(
    request: IncomingMessage,
    response: ServerResponse,
  ): boolean {
    const method = request.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      response.writeHead(405, { ...SECURITY_HEADERS, allow: "GET, HEAD" });
      response.end();
      return true;
    }

    const rawPath = (request.url ?? "/").split("?")[0] ?? "/";
    // The signaling endpoint is WebSocket-only; plain HTTP requests stay 404.
    if (rawPath.startsWith("/v1/")) return false;

    let decoded: string;
    try {
      decoded = decodeURIComponent(rawPath);
    } catch {
      response.writeHead(400, SECURITY_HEADERS);
      response.end();
      return true;
    }

    const safeRelative = normalize(decoded).replace(/^([/\\])+/, "");
    const candidate = resolve(root, safeRelative);
    if (candidate !== root && !candidate.startsWith(root + sep)) {
      // Path traversal: never fall through to a file outside dist.
      response.writeHead(404, {
        ...SECURITY_HEADERS,
        "content-type": "text/plain; charset=utf-8",
      });
      response.end("not found");
      return true;
    }

    const isAsset =
      safeRelative.startsWith(`assets${sep}`) ||
      safeRelative.startsWith("assets/");
    const filePath = findFile(candidate) ? candidate : null;

    if (filePath) {
      const type =
        CONTENT_TYPES[extname(filePath).toLowerCase()] ??
        "application/octet-stream";
      const size = statSync(filePath).size;
      response.writeHead(200, {
        ...SECURITY_HEADERS,
        "content-type": type,
        "content-length": String(size),
        "cache-control": isAsset
          ? "public, max-age=31536000, immutable"
          : "no-cache",
      });
      if (method === "HEAD") {
        response.end();
        return true;
      }
      createReadStream(filePath).pipe(response);
      return true;
    }

    // SPA fallback: /r/:id, /j/:code, /code, /privacy all render from index.html.
    response.writeHead(200, {
      ...SECURITY_HEADERS,
      "content-type": "text/html; charset=utf-8",
      "content-length": String(cachedIndex.length),
      "cache-control": "no-cache",
    });
    if (method === "HEAD") response.end();
    else response.end(cachedIndex);
    return true;
  }

  return Object.assign(handler, { ready: true as const });
}

function findFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
