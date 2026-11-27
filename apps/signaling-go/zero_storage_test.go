package main

// Zero-storage source audit (docs/02 §7, docs/01 AC8). The Go rewrite must not
// grow filesystem writes, a database, or request logging: only the read-only
// static hosting (STATIC_DIR) may touch disk, and only the startup line may go
// to stdout.

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func goSources(t *testing.T) map[string]string {
	t.Helper()
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("read dir: %v", err)
	}
	sources := make(map[string]string)
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(".", name))
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		sources[name] = string(data)
	}
	return sources
}

func TestNoStorageOrDatabaseDependencies(t *testing.T) {
	sources := goSources(t)
	if len(sources) == 0 {
		t.Fatalf("no Go sources found")
	}
	banned := []string{
		`"database/sql"`,
		`"database/sql/driver"`,
		`"github.com/redis`,
		`"go.etcd.io/bbolt"`,
		`"os.Create(`,
		`os.WriteFile(`,
		`os.OpenFile(`,
		`ioutil.WriteFile(`,
		`"log"`,
	}
	for name, source := range sources {
		for _, fragment := range banned {
			if strings.Contains(source, fragment) {
				t.Fatalf("%s contains banned storage/logging fragment %q", name, fragment)
			}
		}
	}
}

func TestOnlyTheStartupLineGoesToStdout(t *testing.T) {
	sources := goSources(t)
	// Exactly one stdout write in the whole program: the startup line in main.go.
	stdoutWrites := 0
	printPattern := regexp.MustCompile(`fmt\.Print(?:ln)?\(`)
	for name, source := range sources {
		if strings.Contains(source, "os.Stdout") {
			t.Fatalf("%s writes to stdout via os.Stdout", name)
		}
		if name != "main.go" && printPattern.MatchString(source) {
			t.Fatalf("%s writes to stdout via fmt.Print", name)
		}
		if name == "main.go" {
			stdoutWrites += strings.Count(source, "fmt.Printf(")
		}
	}
	if stdoutWrites != 1 {
		t.Fatalf("main.go has %d fmt.Printf calls, want exactly 1 startup line", stdoutWrites)
	}
	// Error output is stderr only.
	if !strings.Contains(sources["main.go"], "os.Stderr") {
		t.Fatalf("main.go should report startup errors on stderr")
	}
}

func TestNoAccessLogging(t *testing.T) {
	sources := goSources(t)
	for name, source := range sources {
		for _, fragment := range []string{
			"access-log", "accesslog", "AccessLog",
			"userAgent", "UserAgent", "User-Agent", "user-agent",
			"log.Printf", "log.Println", "log.Fatal",
		} {
			if strings.Contains(source, fragment) {
				t.Fatalf("%s contains banned logging fragment %q", name, fragment)
			}
		}
	}
	// The only place an IP is read is the in-memory rate-limit key and the
	// WebSocket peer address; rooms never hold it.
	if strings.Contains(sources["rooms.go"], "ip") {
		t.Fatalf("rooms.go appears to store an IP address")
	}
}

func TestEmbeddedSourceRejectsTraversal(t *testing.T) {
	source := EmbeddedWebDist()
	// The .gitkeep placeholder that keeps //go:embed compiling must not be served.
	if _, ok := source.Read(".gitkeep"); ok {
		t.Fatalf("embedded source served the .gitkeep placeholder")
	}
	for _, path := range []string{"", "../etc/passwd", "/etc/passwd", "assets/../../etc/passwd"} {
		if _, ok := source.Read(path); ok {
			t.Fatalf("embedded source served %q", path)
		}
	}
}
