package main

// Same-origin static hosting for the built web app (production single-origin
// deploy), ported from packages/signaling/src/static.ts.
//
// docs/02 §7: the signaling process may serve the frontend, but it must never
// log requests, never write to disk, never set cookies. Everything below is
// read-only: index.html is cached in memory and every file comes from a
// StaticSource. In the single binary the files are embedded with //go:embed;
// STATIC_DIR overrides that for development.

import (
	"embed"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// webDistFS embeds the built web app. build.sh replaces webdist/ with the
// contents of apps/web/dist; webdist/.gitkeep keeps the pattern compiling on a
// clean checkout.
//
//go:embed all:webdist
var webDistFS embed.FS

// StaticSource is a read-only view of the built web app. Read takes a path
// relative to the dist root ("" is not requested; index.html is cached by the
// handler) and reports whether the file exists.
type StaticSource interface {
	Read(relativePath string) ([]byte, bool)
}

// embeddedSource serves the files compiled into the binary.
type embeddedSource struct{}

func (embeddedSource) Read(relativePath string) ([]byte, bool) {
	if relativePath == "" || strings.HasPrefix(relativePath, "../") || filepath.IsAbs(relativePath) {
		return nil, false
	}
	// The placeholder that keeps //go:embed compiling on a clean checkout is not
	// part of the web app (a missing file falls back to index.html).
	if relativePath == ".gitkeep" {
		return nil, false
	}
	data, err := fs.ReadFile(webDistFS, "webdist/"+relativePath)
	if err != nil {
		return nil, false
	}
	return data, true
}

// EmbeddedWebDist is the default static source of the single binary.
func EmbeddedWebDist() StaticSource { return embeddedSource{} }

// directorySource serves apps/web/dist from disk (STATIC_DIR).
type directorySource struct {
	root string
}

// NewDirectorySource opens a dist directory; the handler decides readiness by
// looking for index.html.
func NewDirectorySource(rootDir string) StaticSource {
	root, err := filepath.Abs(rootDir)
	if err != nil {
		root = rootDir
	}
	return &directorySource{root: root}
}

func (s *directorySource) Read(relativePath string) ([]byte, bool) {
	// Defence in depth: the handler already rejects traversal. A file name may
	// legitimately contain ".." (e.g. "a..b"), so only whole ".." segments are
	// refused, exactly like static.ts.
	if relativePath == "" || filepath.IsAbs(relativePath) {
		return nil, false
	}
	for _, segment := range strings.Split(strings.ReplaceAll(relativePath, "\\", "/"), "/") {
		if segment == ".." {
			return nil, false
		}
	}
	target := filepath.Join(s.root, filepath.FromSlash(relativePath))
	if target != s.root && !strings.HasPrefix(target, s.root+string(filepath.Separator)) {
		return nil, false
	}
	data, err := os.ReadFile(target)
	if err != nil {
		return nil, false
	}
	return data, true
}

var contentTypes = map[string]string{
	".html":  "text/html; charset=utf-8",
	".js":    "text/javascript; charset=utf-8",
	".mjs":   "text/javascript; charset=utf-8",
	".css":   "text/css; charset=utf-8",
	".json":  "application/json; charset=utf-8",
	".svg":   "image/svg+xml",
	".png":   "image/png",
	".jpg":   "image/jpeg",
	".jpeg":  "image/jpeg",
	".webp":  "image/webp",
	".ico":   "image/x-icon",
	".woff2": "font/woff2",
	".woff":  "font/woff",
	".txt":   "text/plain; charset=utf-8",
	".map":   "application/json; charset=utf-8",
}

// docs/01 §5 / docs/02 §2.2: fragment keys must never leak via referer, no
// third-party origins.
var securityHeaders = [][2]string{
	{"referrer-policy", "no-referrer"},
	{"x-content-type-options", "nosniff"},
	{"permissions-policy", "camera=(), microphone=(), geolocation=(), interest-cohort=()"},
	{"content-security-policy", strings.Join([]string{
		"default-src 'self'",
		"script-src 'self'",
		"style-src 'self' 'unsafe-inline'",
		"img-src 'self' data:",
		"font-src 'self' data:",
		"connect-src 'self' ws: wss:",
		"frame-ancestors 'none'",
		"base-uri 'none'",
		"form-action 'self'",
	}, "; ")},
}

// StaticHandler serves the built web app. ServeHTTP returns false when the
// request belongs to another part of the server (the /v1/ namespace) or when
// static hosting is not ready, in which case the caller answers 404.
type StaticHandler struct {
	source StaticSource
	index  []byte
	ready  bool
}

func newStaticHandler(source StaticSource) *StaticHandler {
	handler := &StaticHandler{source: source}
	if index, ok := source.Read("index.html"); ok {
		handler.index = index
		handler.ready = true
	}
	return handler
}

func (h *StaticHandler) Ready() bool { return h.ready }

func (h *StaticHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) bool {
	if !h.ready {
		return false
	}
	method := r.Method
	if method != http.MethodGet && method != http.MethodHead {
		writeSecurityHeaders(w.Header())
		w.Header().Set("allow", "GET, HEAD")
		w.WriteHeader(http.StatusMethodNotAllowed)
		return true
	}
	// static.ts inspects the raw request target: "/v1%2Fws" is not the /v1/
	// namespace, so it is decoded and served like any other SPA route.
	rawPath := r.URL.EscapedPath()
	if rawPath == "" {
		rawPath = "/"
	}
	// The signaling endpoint is WebSocket-only; plain HTTP requests stay 404.
	if strings.HasPrefix(rawPath, "/v1/") {
		return false
	}
	decoded, err := url.PathUnescape(rawPath)
	if err != nil {
		// Malformed percent-encoding (static.ts answers 400 with the security headers).
		writeSecurityHeaders(w.Header())
		w.WriteHeader(http.StatusBadRequest)
		return true
	}
	safeRelative, ok := normalizeRelativePath(decoded)
	if !ok {
		// Path traversal: never fall through to a file outside dist.
		writeSecurityHeaders(w.Header())
		w.Header().Set("content-type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusNotFound)
		_, _ = io.WriteString(w, "not found")
		return true
	}
	isAsset := strings.HasPrefix(safeRelative, "assets/")
	var content []byte
	if safeRelative != "" {
		content, _ = h.source.Read(safeRelative)
	}
	if content != nil {
		contentType, ok := contentTypes[strings.ToLower(filepath.Ext(safeRelative))]
		if !ok {
			contentType = "application/octet-stream"
		}
		writeSecurityHeaders(w.Header())
		w.Header().Set("content-type", contentType)
		w.Header().Set("content-length", strconv.Itoa(len(content)))
		if isAsset {
			w.Header().Set("cache-control", "public, max-age=31536000, immutable")
		} else {
			w.Header().Set("cache-control", "no-cache")
		}
		w.WriteHeader(http.StatusOK)
		if method != http.MethodHead {
			_, _ = w.Write(content)
		}
		return true
	}
	// SPA fallback: /r/:id, /j/:code, /code, /privacy all render from index.html.
	writeSecurityHeaders(w.Header())
	w.Header().Set("content-type", "text/html; charset=utf-8")
	w.Header().Set("content-length", strconv.Itoa(len(h.index)))
	w.Header().Set("cache-control", "no-cache")
	w.WriteHeader(http.StatusOK)
	if method != http.MethodHead {
		_, _ = w.Write(h.index)
	}
	return true
}

func writeSecurityHeaders(header http.Header) {
	for _, pair := range securityHeaders {
		header.Set(pair[0], pair[1])
	}
}

// normalizeRelativePath normalises a decoded URL path to a source-relative
// POSIX path. ok is false when the path escapes the dist root.
func normalizeRelativePath(decoded string) (string, bool) {
	withoutRoot := strings.ReplaceAll(decoded, "\\", "/")
	withoutRoot = strings.TrimLeft(withoutRoot, "/")
	segments := make([]string, 0, 4)
	for _, segment := range strings.Split(withoutRoot, "/") {
		if segment == "" || segment == "." {
			continue
		}
		if segment == ".." {
			if len(segments) == 0 {
				return "", false
			}
			segments = segments[:len(segments)-1]
			continue
		}
		segments = append(segments, segment)
	}
	return strings.Join(segments, "/"), true
}
