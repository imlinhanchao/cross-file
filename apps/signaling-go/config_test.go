package main

import (
	"strings"
	"testing"
)

func TestLoadConfigDefaults(t *testing.T) {
	config, err := loadConfig(map[string]string{})
	if err != nil {
		t.Fatalf("loadConfig: %v", err)
	}
	if config.Host != "127.0.0.1" || config.Port != 8788 {
		t.Fatalf("unexpected listen address: %+v", config)
	}
	if config.MaxMembers != 4 {
		t.Fatalf("MaxMembers = %d, want 4", config.MaxMembers)
	}
	if config.RateLimit.WindowMs != 60_000 || config.RateLimit.Max != 120 {
		t.Fatalf("unexpected rate limit: %+v", config.RateLimit)
	}
	if config.TURN != nil || config.TURNServer != nil {
		t.Fatalf("TURN should be off by default: %+v", config)
	}
}

func TestLoadConfigPortAndHost(t *testing.T) {
	cases := []struct {
		raw  string
		want int
	}{
		{"8790", 8790},
		{" 42 ", 42},
		{"12.5", 12}, // parseInt stops at the dot
		{"abc", 8788},
		{"", 8788},
		{"1e3", 1},
	}
	for _, testCase := range cases {
		config, err := loadConfig(map[string]string{"PORT": testCase.raw})
		if err != nil {
			t.Fatalf("PORT=%q: %v", testCase.raw, err)
		}
		if config.Port != testCase.want {
			t.Fatalf("PORT=%q -> %d, want %d", testCase.raw, config.Port, testCase.want)
		}
	}
	config, err := loadConfig(map[string]string{"HOST": " 0.0.0.0 "})
	if err != nil || config.Host != "0.0.0.0" {
		t.Fatalf("HOST override: %+v, %v", config, err)
	}
}

func TestLoadConfigMaxMembers(t *testing.T) {
	cases := []struct {
		env  map[string]string
		want int
	}{
		{map[string]string{}, 4},
		{map[string]string{"MAX_MEMBERS": "2"}, 2},
		{map[string]string{"MAX_MEMBERS": " 4 "}, 4},
		{map[string]string{"MAX_GUESTS": "3"}, 3},
		{map[string]string{"MAX_MEMBERS": "2", "MAX_GUESTS": "4"}, 2},
		{map[string]string{"MAX_MEMBERS": "  ", "MAX_GUESTS": "5"}, 5},
	}
	for _, testCase := range cases {
		config, err := loadConfig(testCase.env)
		if err != nil {
			t.Fatalf("%v: %v", testCase.env, err)
		}
		if config.MaxMembers != testCase.want {
			t.Fatalf("%v -> MaxMembers %d, want %d", testCase.env, config.MaxMembers, testCase.want)
		}
	}
	for _, raw := range []string{"0", "-1", "abc", "2.5", "2x", "1e3"} {
		for _, key := range []string{"MAX_MEMBERS", "MAX_GUESTS"} {
			_, err := loadConfig(map[string]string{key: raw})
			if err == nil || !strings.Contains(err.Error(), "must be a positive integer") {
				t.Fatalf("%s=%q: want a positive-integer error, got %v", key, raw, err)
			}
		}
	}
}

func TestLoadConfigRateLimit(t *testing.T) {
	config, err := loadConfig(map[string]string{"RATE_LIMIT_MAX": "100000"})
	if err != nil {
		t.Fatalf("loadConfig: %v", err)
	}
	if config.RateLimit.Max != 100_000 || config.RateLimit.WindowMs != 60_000 {
		t.Fatalf("unexpected rate limit: %+v", config.RateLimit)
	}
	config, err = loadConfig(map[string]string{"RATE_LIMIT_MAX": "5", "RATE_LIMIT_WINDOW_MS": "1000"})
	if err != nil {
		t.Fatalf("loadConfig: %v", err)
	}
	if config.RateLimit.Max != 5 || config.RateLimit.WindowMs != 1000 {
		t.Fatalf("unexpected rate limit: %+v", config.RateLimit)
	}
	// Invalid or zero max keeps the production policy untouched.
	for _, env := range []map[string]string{
		{"RATE_LIMIT_MAX": "0"},
		{"RATE_LIMIT_MAX": "abc"},
		{"RATE_LIMIT_MAX": "-3"},
	} {
		config, err := loadConfig(env)
		if err != nil {
			t.Fatalf("%v: %v", env, err)
		}
		if config.RateLimit.Max != 120 {
			t.Fatalf("%v -> Max %d, want 120", env, config.RateLimit.Max)
		}
	}
}

func TestLoadConfigTURN(t *testing.T) {
	// TURN is off when either half of the Node gate is missing: URIs only, secret only.
	for _, env := range []map[string]string{
		{"TURN_URIS": "turn:example.org:3478"},
		{"TURN_SECRET": "s"},
		{"TURN_SECRET": "s", "TURN_EXTERNAL_IP": "203.0.113.10"},
	} {
		config, err := loadConfig(env)
		if err != nil {
			t.Fatalf("%v: %v", env, err)
		}
		if config.TURN != nil || config.TURNServer != nil {
			t.Fatalf("%v: TURN should be off: %+v", env, config)
		}
	}

	// Secret + URIs but no external IP fails fast: the in-process relay needs the
	// address clients reach it on.
	if _, err := loadConfig(map[string]string{
		"TURN_SECRET": "s",
		"TURN_URIS":   "turn:example.org:3478",
	}); err == nil || !strings.Contains(err.Error(), "TURN_EXTERNAL_IP") {
		t.Fatalf("want TURN_EXTERNAL_IP error, got %v", err)
	}
	if _, err := loadConfig(map[string]string{
		"TURN_SECRET":      "s",
		"TURN_URIS":        "turn:example.org:3478",
		"TURN_EXTERNAL_IP": "not-an-ip",
	}); err == nil {
		t.Fatalf("want an invalid IP error")
	}

	// Full configuration: credentials are issued and the relay starts.
	config, err := loadConfig(map[string]string{
		"TURN_SECRET":      "static-auth-secret",
		"TURN_URIS":        " turn:example.org:3478?transport=udp , turns:example.org:5349 ",
		"TURN_EXTERNAL_IP": "203.0.113.10",
	})
	if err != nil {
		t.Fatalf("loadConfig: %v", err)
	}
	if config.TURN == nil || config.TURNServer == nil {
		t.Fatalf("TURN should be configured: %+v", config)
	}
	if len(config.TURN.URIs) != 2 || config.TURN.URIs[0] != "turn:example.org:3478?transport=udp" ||
		config.TURN.URIs[1] != "turns:example.org:5349" {
		t.Fatalf("unexpected URIs: %v", config.TURN.URIs)
	}
	if config.TURN.TTL != 3600 {
		t.Fatalf("TTL = %d, want 3600", config.TURN.TTL)
	}
	if config.TURNServer.ListenPort != 3478 || config.TURNServer.MinPort != 49160 || config.TURNServer.MaxPort != 49200 {
		t.Fatalf("unexpected relay ports: %+v", config.TURNServer)
	}

	// Port overrides and validation (only relevant once TURN is enabled).
	config, err = loadConfig(map[string]string{
		"TURN_SECRET": "s", "TURN_URIS": "turn:example.org:3478", "TURN_EXTERNAL_IP": "127.0.0.1",
		"TURN_LISTEN_PORT": "3479", "TURN_MIN_PORT": "50000", "TURN_MAX_PORT": "50010",
	})
	if err != nil {
		t.Fatalf("loadConfig: %v", err)
	}
	if config.TURNServer.ListenPort != 3479 || config.TURNServer.MinPort != 50000 || config.TURNServer.MaxPort != 50010 {
		t.Fatalf("unexpected relay ports: %+v", config.TURNServer)
	}
	for _, env := range []map[string]string{
		{"TURN_SECRET": "s", "TURN_URIS": "turn:x:3478", "TURN_EXTERNAL_IP": "127.0.0.1", "TURN_LISTEN_PORT": "70000"},
		{"TURN_SECRET": "s", "TURN_URIS": "turn:x:3478", "TURN_EXTERNAL_IP": "127.0.0.1", "TURN_MIN_PORT": "0"},
		{"TURN_SECRET": "s", "TURN_URIS": "turn:x:3478", "TURN_EXTERNAL_IP": "127.0.0.1", "TURN_MIN_PORT": "50010", "TURN_MAX_PORT": "50000"},
	} {
		if _, err := loadConfig(env); err == nil {
			t.Fatalf("%v: want a port validation error", env)
		}
	}
}

func TestLoadConfigStaticDir(t *testing.T) {
	config, err := loadConfig(map[string]string{"STATIC_DIR": "  apps/web/dist  "})
	if err != nil {
		t.Fatalf("loadConfig: %v", err)
	}
	if config.StaticDir != "apps/web/dist" {
		t.Fatalf("StaticDir = %q", config.StaticDir)
	}
}
