/**
 * Optional static hosting for the built web app (production single-origin deploy).
 *
 * docs/02 §7: the signaling process may serve the frontend, but it must never log
 * requests, never write to disk, never set cookies. Everything below is read-only:
 * index.html is cached in memory and every file comes from a {@link StaticSource}.
 *
 * Two sources exist:
 *  - {@link createDirectorySource}: the tarball/container deploy reads `apps/web/dist`
 *    from disk (`STATIC_DIR`, unchanged behaviour);
 *  - {@link createMemorySource}: the Node SEA single binary embeds those files through
 *    `node:sea` assets at build time and serves them from memory (`staticAssets`).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { extname, isAbsolute, resolve, sep } from "node:path";

export interface StaticHandler {
  (request: IncomingMessage, response: ServerResponse): boolean;
  /** false when index.html could not be read (static hosting disabled) */
  readonly ready: boolean;
}

/**
 * Read-only view of the built web app.
 *
 * `read` takes a URL path relative to the dist root (`""` -> index.html,
 * `assets/app.js` -> that file) and returns the bytes, or `undefined` when absent.
 */
export interface StaticSource {
  /** false when index.html is missing (static hosting disabled) */
  readonly ready: boolean;
  read(relativePath: string): Buffer | undefined;
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

/** Directory-backed source: the tarball/container deploy (STATIC_DIR). */
export function createDirectorySource(rootDir: string): StaticSource {
  const root = resolve(rootDir);
  let index: Buffer | undefined;
  try {
    index = readFileSync(resolve(root, "index.html"));
  } catch {
    index = undefined;
  }
  return {
    ready: index !== undefined,
    read(relativePath: string): Buffer | undefined {
      // Defence in depth: the handler already rejects traversal, but a source may be
      // called with a path from elsewhere in the future.
      if (
        isAbsolute(relativePath) ||
        relativePath.split(/[/\\]/).includes("..")
      )
        return undefined;
      const target = resolve(root, relativePath);
      if (target !== root && !target.startsWith(root + sep)) return undefined;
      try {
        return readFileSync(target);
      } catch {
        return undefined;
      }
    },
  };
}

/** In-memory source: the SEA single binary embeds the web app at build time. */
export function createMemorySource(
  files: ReadonlyMap<string, Uint8Array>,
): StaticSource {
  const index = files.get("index.html");
  return {
    ready: index !== undefined,
    read(relativePath: string): Buffer | undefined {
      const value = files.get(relativePath);
      return value === undefined ? undefined : Buffer.from(value);
    },
  };
}

/** Build the HTTP handler from a source. Read-only by construction. */
export function createStaticHandlerFromSource(
  source: StaticSource,
): StaticHandler {
  const cachedIndex = source.read("index.html");
  if (!cachedIndex) {
    return Object.assign(
      (_request: IncomingMessage, _response: ServerResponse): boolean => false,
      { ready: false as const },
    );
  }
  const indexHtml: Buffer = cachedIndex;

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

    const safeRelative = normalizeRelativePath(decoded);
    if (safeRelative === null) {
      // Path traversal: never fall through to a file outside dist.
      response.writeHead(404, {
        ...SECURITY_HEADERS,
        "content-type": "text/plain; charset=utf-8",
      });
      response.end("not found");
      return true;
    }

    const isAsset = safeRelative.startsWith("assets/");
    const content = safeRelative === "" ? undefined : source.read(safeRelative);

    if (content) {
      const type =
        CONTENT_TYPES[extname(safeRelative).toLowerCase()] ??
        "application/octet-stream";
      response.writeHead(200, {
        ...SECURITY_HEADERS,
        "content-type": type,
        "content-length": String(content.length),
        "cache-control": isAsset
          ? "public, max-age=31536000, immutable"
          : "no-cache",
      });
      if (method === "HEAD") {
        response.end();
        return true;
      }
      response.end(content);
      return true;
    }

    // SPA fallback: /r/:id, /j/:code, /code, /privacy all render from index.html.
    response.writeHead(200, {
      ...SECURITY_HEADERS,
      "content-type": "text/html; charset=utf-8",
      "content-length": String(indexHtml.length),
      "cache-control": "no-cache",
    });
    if (method === "HEAD") {
      response.end();
      return true;
    }
    response.end(indexHtml);
    return true;
  }

  return Object.assign(handler, { ready: true as const });
}

/**
 * Directory source, async signature kept for callers (`createSignalingServer`
 * awaits it). Behaviour is identical to the pre-SEA handler.
 */
export async function createStaticHandler(
  rootDir: string,
): Promise<StaticHandler> {
  return createStaticHandlerFromSource(createDirectorySource(rootDir));
}

/**
 * Normalize a decoded URL path to a source-relative POSIX path. Returns `null`
 * when the path escapes the dist root (`..` segment after resolution).
 */
function normalizeRelativePath(decoded: string): string | null {
  const withoutRoot = decoded.replace(/\\/g, "/").replace(/^\/+/, "");
  const segments: string[] = [];
  for (const segment of withoutRoot.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}
