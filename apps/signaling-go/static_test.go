package main

import (
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const staticIndex = "<!doctype html><title>CrossFile</title><div id=root></div>"
const staticAsset = "console.log('app');"

type mapSource map[string][]byte

func (m mapSource) Read(relativePath string) ([]byte, bool) {
	data, ok := m[relativePath]
	return data, ok
}

func writeStaticTree(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte(staticIndex), 0o600); err != nil {
		t.Fatalf("write index: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "assets"), 0o700); err != nil {
		t.Fatalf("mkdir assets: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "assets", "app.js"), []byte(staticAsset), 0o600); err != nil {
		t.Fatalf("write asset: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "favicon.svg"), []byte("<svg/>"), 0o600); err != nil {
		t.Fatalf("write favicon: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "blob.bin"), []byte{0x01, 0x02}, 0o600); err != nil {
		t.Fatalf("write blob: %v", err)
	}
	return dir
}

func startStaticServer(t *testing.T, source StaticSource) string {
	t.Helper()
	server := NewServer(Options{Port: 0, StaticSource: source})
	result, err := server.Start()
	if err != nil {
		t.Fatalf("start server: %v", err)
	}
	t.Cleanup(func() { _ = server.Stop() })
	return "http://127.0.0.1:" + itoa(result.Port)
}

func httpGet(t *testing.T, url string, method string) (*http.Response, []byte) {
	t.Helper()
	request, err := http.NewRequest(method, url, nil)
	if err != nil {
		t.Fatalf("new request %s: %v", url, err)
	}
	client := &http.Client{Timeout: 5 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		t.Fatalf("GET %s: %v", url, err)
	}
	body, err := io.ReadAll(response.Body)
	_ = response.Body.Close()
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	return response, body
}

func TestStaticServesIndexWithPrivacyHeaders(t *testing.T) {
	base := startStaticServer(t, NewDirectorySource(writeStaticTree(t)))
	response, body := httpGet(t, base+"/", http.MethodGet)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", response.StatusCode)
	}
	if !strings.Contains(response.Header.Get("content-type"), "text/html") {
		t.Fatalf("content-type = %q", response.Header.Get("content-type"))
	}
	checks := map[string]string{
		"referrer-policy":        "no-referrer",
		"x-content-type-options": "nosniff",
		"permissions-policy":     "camera=(), microphone=(), geolocation=(), interest-cohort=()",
		"cache-control":          "no-cache",
	}
	for header, want := range checks {
		if got := response.Header.Get(header); got != want {
			t.Fatalf("%s = %q, want %q", header, got, want)
		}
	}
	csp := response.Header.Get("content-security-policy")
	for _, fragment := range []string{"default-src 'self'", "frame-ancestors 'none'", "connect-src 'self' ws: wss:"} {
		if !strings.Contains(csp, fragment) {
			t.Fatalf("CSP %q lacks %q", csp, fragment)
		}
	}
	if !strings.Contains(string(body), "CrossFile") {
		t.Fatalf("body = %q", body)
	}
}

func TestStaticSPAFallback(t *testing.T) {
	base := startStaticServer(t, NewDirectorySource(writeStaticTree(t)))
	for _, path := range []string{"/r/abcdefghijklmnopqrstuvwxyz", "/j/123456", "/code", "/privacy", "/missing.js", "/nested/deep/route"} {
		response, body := httpGet(t, base+path, http.MethodGet)
		if response.StatusCode != http.StatusOK {
			t.Fatalf("%s status = %d", path, response.StatusCode)
		}
		if !strings.Contains(string(body), "<title>CrossFile</title>") {
			t.Fatalf("%s did not fall back to index.html: %q", path, body)
		}
		if got := response.Header.Get("cache-control"); got != "no-cache" {
			t.Fatalf("%s cache-control = %q", path, got)
		}
	}
}

func TestStaticServesAssets(t *testing.T) {
	base := startStaticServer(t, NewDirectorySource(writeStaticTree(t)))
	response, body := httpGet(t, base+"/assets/app.js", http.MethodGet)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", response.StatusCode)
	}
	if !strings.Contains(response.Header.Get("content-type"), "text/javascript") {
		t.Fatalf("content-type = %q", response.Header.Get("content-type"))
	}
	if !strings.Contains(response.Header.Get("cache-control"), "immutable") {
		t.Fatalf("cache-control = %q", response.Header.Get("cache-control"))
	}
	if string(body) != staticAsset {
		t.Fatalf("body = %q", body)
	}
	if got := response.Header.Get("content-length"); got != itoa(len(staticAsset)) {
		t.Fatalf("content-length = %q", got)
	}

	// A known extension with no entry in the table falls back to octet-stream.
	response, _ = httpGet(t, base+"/blob.bin", http.MethodGet)
	if got := response.Header.Get("content-type"); got != "application/octet-stream" {
		t.Fatalf("content-type = %q", got)
	}
	if got := response.Header.Get("cache-control"); got != "no-cache" {
		t.Fatalf("non-asset cache-control = %q", got)
	}
}

func TestStaticRefusesTraversal(t *testing.T) {
	base := startStaticServer(t, NewDirectorySource(writeStaticTree(t)))
	for _, path := range []string{
		"/../../etc/passwd",
		"/..%2f..%2fetc%2fpasswd",
		"/%2e%2e/%2e%2e/etc/passwd",
		"/assets/../../etc/passwd",
	} {
		response, body := httpGet(t, base+path, http.MethodGet)
		if strings.Contains(string(body), "root:") {
			t.Fatalf("%s leaked /etc/passwd", path)
		}
		if response.StatusCode != http.StatusNotFound {
			t.Fatalf("%s status = %d, want 404", path, response.StatusCode)
		}
	}
}

func TestStaticRawV1PathIsSPA(t *testing.T) {
	base := startStaticServer(t, NewDirectorySource(writeStaticTree(t)))
	// static.ts checks the raw request target: "/v1%2Fws" is not the /v1/
	// namespace, so it decodes to a normal SPA route instead of a quiet 404.
	response, body := httpGet(t, base+"/v1%2Fws", http.MethodGet)
	if response.StatusCode != http.StatusOK || !strings.Contains(string(body), "CrossFile") {
		t.Fatalf("/v1%%2Fws = %d %q", response.StatusCode, body)
	}
}

func TestUpgradeOnWrongPathIsDestroyed(t *testing.T) {
	base := startStaticServer(t, NewDirectorySource(writeStaticTree(t)))
	address := strings.TrimPrefix(base, "http://")
	connection, err := net.DialTimeout("tcp", address, time.Second)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer connection.Close()
	_ = connection.SetDeadline(time.Now().Add(2 * time.Second))
	request := "GET /v1%2Fws HTTP/1.1\r\nHost: " + address +
		"\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"
	if _, err := connection.Write([]byte(request)); err != nil {
		t.Fatalf("write upgrade request: %v", err)
	}
	buffer := make([]byte, 256)
	n, err := connection.Read(buffer)
	if err == nil && n > 0 && strings.HasPrefix(string(buffer[:n]), "HTTP/") {
		t.Fatalf("wrong-path upgrade got an HTTP response: %q", buffer[:n])
	}
}

func TestStaticHTTPEdgeCases(t *testing.T) {
	base := startStaticServer(t, NewDirectorySource(writeStaticTree(t)))

	// /v1/ plain HTTP requests stay a quiet 404 from the outer handler.
	response, body := httpGet(t, base+"/v1/ws", http.MethodGet)
	if response.StatusCode != http.StatusNotFound || string(body) != "not found" {
		t.Fatalf("/v1/ws = %d %q", response.StatusCode, body)
	}
	if got := response.Header.Get("content-type"); !strings.Contains(got, "text/plain") {
		t.Fatalf("content-type = %q", got)
	}

	// Write methods are rejected with allow: GET, HEAD and the security headers.
	response, _ = httpGet(t, base+"/", http.MethodPost)
	if response.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("POST status = %d", response.StatusCode)
	}
	if got := response.Header.Get("allow"); got != "GET, HEAD" {
		t.Fatalf("allow = %q", got)
	}
	if got := response.Header.Get("referrer-policy"); got != "no-referrer" {
		t.Fatalf("POST missing security headers")
	}

	// HEAD sends headers but no body.
	response, body = httpGet(t, base+"/", http.MethodHead)
	if response.StatusCode != http.StatusOK || len(body) != 0 {
		t.Fatalf("HEAD = %d, body %q", response.StatusCode, body)
	}
	if got := response.Header.Get("content-length"); got != itoa(len(staticIndex)) {
		t.Fatalf("HEAD content-length = %q", got)
	}
}

func TestStaticIndexCachedAtStartup(t *testing.T) {
	dir := writeStaticTree(t)
	base := startStaticServer(t, NewDirectorySource(dir))
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte("<html>changed</html>"), 0o600); err != nil {
		t.Fatalf("rewrite index: %v", err)
	}
	_, body := httpGet(t, base+"/", http.MethodGet)
	if strings.Contains(string(body), "changed") {
		t.Fatalf("index.html was re-read per request: %q", body)
	}
}

func TestStaticDisabledWithoutIndex(t *testing.T) {
	dir := t.TempDir()
	base := startStaticServer(t, NewDirectorySource(dir))
	response, body := httpGet(t, base+"/", http.MethodGet)
	if response.StatusCode != http.StatusNotFound || string(body) != "not found" {
		t.Fatalf("missing index = %d %q", response.StatusCode, body)
	}
}

func TestStaticFromMemorySource(t *testing.T) {
	source := mapSource{
		"index.html":    []byte(staticIndex),
		"assets/app.js": []byte(staticAsset),
	}
	base := startStaticServer(t, source)
	if _, body := httpGet(t, base+"/", http.MethodGet); !strings.Contains(string(body), "CrossFile") {
		t.Fatalf("index body = %q", body)
	}
	if _, body := httpGet(t, base+"/assets/app.js", http.MethodGet); string(body) != staticAsset {
		t.Fatalf("asset body = %q", body)
	}
	if _, body := httpGet(t, base+"/r/route", http.MethodGet); !strings.Contains(string(body), "CrossFile") {
		t.Fatalf("SPA body = %q", body)
	}
}

func TestNormalizeRelativePath(t *testing.T) {
	cases := []struct {
		in   string
		want string
		ok   bool
	}{
		{"/", "", true},
		{"/index.html", "index.html", true},
		{"/assets/app.js", "assets/app.js", true},
		{"/a//b/./c", "a/b/c", true},
		{"/a/b/../c", "a/c", true},
		{"/..", "", false},
		{"/../etc/passwd", "", false},
		{"/a/../../b", "", false},
		{"\\a\\b", "a/b", true},
	}
	for _, testCase := range cases {
		got, ok := normalizeRelativePath(testCase.in)
		if got != testCase.want || ok != testCase.ok {
			t.Fatalf("normalizeRelativePath(%q) = (%q, %v), want (%q, %v)", testCase.in, got, ok, testCase.want, testCase.ok)
		}
	}
}

func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	digits := make([]byte, 0, 8)
	for value > 0 {
		digits = append([]byte{byte('0' + value%10)}, digits...)
		value /= 10
	}
	return string(digits)
}
