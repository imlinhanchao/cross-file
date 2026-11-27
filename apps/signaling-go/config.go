package main

// Deployment configuration parsed from the environment, ported from
// packages/signaling/src/config.ts and dev.ts.
//
// MAX_MEMBERS is the room capacity **excluding the admin** (docs/01 D6): the
// official instance uses 2, self-hosted deployments default to 4. Invalid
// values fail fast instead of silently falling back.

import (
	"fmt"
	"math"
	"net"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	defaultListenPort = 3478
	defaultMinPort    = 49160
	defaultMaxPort    = 49200
	// defaultReconnectWindowMs is the member offline window and, in phase 2, the
	// admin handover window (ADR 0010 D24).
	defaultReconnectWindowMs int64 = 60_000
)

var positiveIntegerPattern = regexp.MustCompile(`^[0-9]+$`)

// Config is the fully validated runtime configuration.
type Config struct {
	Host       string
	Port       int
	MaxMembers int
	// ReconnectWindow is both the member offline window and the admin handover
	// window; RECONNECT_WINDOW_MS overrides it (test-only escape hatch).
	ReconnectWindow time.Duration
	RateLimit       RateLimitPolicy
	TURN            *TurnOptions
	TURNServer      *TURNServerOptions
	StaticDir       string
}

// loadConfig validates the environment. Every error is a startup failure: a
// wrong room capacity or TURN address is an operational surprise, not something
// to hide.
func loadConfig(env map[string]string) (Config, error) {
	config := Config{
		Host:            defaultHost,
		Port:            defaultPort,
		MaxMembers:      defaultMaxMembers,
		ReconnectWindow: time.Duration(defaultReconnectWindowMs) * time.Millisecond,
		RateLimit:       RateLimitPolicy{WindowMs: defaultRateLimitWindowMs, Max: defaultRateLimitMax},
	}
	if host := jsTrim(env["HOST"]); host != "" {
		config.Host = host
	}
	config.Port = parseIntJS(env["PORT"], defaultPort)

	maxMembers, err := parseMaxMembers(env)
	if err != nil {
		return Config{}, err
	}
	if maxMembers > 0 {
		config.MaxMembers = maxMembers
	}

	reconnectWindowMs, err := parseReconnectWindowMs(env)
	if err != nil {
		return Config{}, err
	}
	config.ReconnectWindow = time.Duration(reconnectWindowMs) * time.Millisecond

	// Test/dev escape hatch: the e2e suite sends far more than the production
	// per-IP budget from one address. Unset keeps the production policy.
	if max, ok := parseIntJSPresent(env["RATE_LIMIT_MAX"]); ok && max > 0 {
		windowMs := int64(defaultRateLimitWindowMs)
		if window, ok := parseIntJSPresent(env["RATE_LIMIT_WINDOW_MS"]); ok && window > 0 {
			windowMs = int64(window)
		}
		config.RateLimit = RateLimitPolicy{WindowMs: windowMs, Max: max}
	}

	uris := make([]string, 0)
	for _, uri := range strings.Split(env["TURN_URIS"], ",") {
		if trimmed := jsTrim(uri); trimmed != "" {
			uris = append(uris, trimmed)
		}
	}
	secret := env["TURN_SECRET"]
	// Node enables TURN credential signing only when TURN_URIS is non-empty AND
	// TURN_SECRET is set (dev.ts). The in-process relay is gated the same way, so
	// a deployment that keeps TURN_SECRET for another service still starts.
	if secret != "" && len(uris) > 0 {
		external := jsTrim(env["TURN_EXTERNAL_IP"])
		if external == "" {
			return Config{}, fmt.Errorf("TURN_EXTERNAL_IP is required when TURN_SECRET is set (the address clients reach the relay on)")
		}
		externalIP := net.ParseIP(external)
		if externalIP == nil {
			return Config{}, fmt.Errorf("TURN_EXTERNAL_IP must be an IP address (got %q)", external)
		}
		listenPort := defaultListenPort
		if raw := jsTrim(env["TURN_LISTEN_PORT"]); raw != "" {
			value, err := parsePort(raw, "TURN_LISTEN_PORT", false)
			if err != nil {
				return Config{}, err
			}
			listenPort = value
		}
		minPort := defaultMinPort
		if raw := jsTrim(env["TURN_MIN_PORT"]); raw != "" {
			value, err := parsePort(raw, "TURN_MIN_PORT", false)
			if err != nil {
				return Config{}, err
			}
			minPort = value
		}
		maxPort := defaultMaxPort
		if raw := jsTrim(env["TURN_MAX_PORT"]); raw != "" {
			value, err := parsePort(raw, "TURN_MAX_PORT", false)
			if err != nil {
				return Config{}, err
			}
			maxPort = value
		}
		if minPort > maxPort {
			return Config{}, fmt.Errorf("TURN_MIN_PORT (%d) must not exceed TURN_MAX_PORT (%d)", minPort, maxPort)
		}
		config.TURNServer = &TURNServerOptions{
			Secret:     secret,
			ExternalIP: externalIP,
			ListenPort: listenPort,
			MinPort:    minPort,
			MaxPort:    maxPort,
		}
		config.TURN = &TurnOptions{URIs: uris, Secret: secret, TTL: turnTTLSeconds}
	}
	config.StaticDir = jsTrim(env["STATIC_DIR"])
	return config, nil
}

// parseMaxMembers reads MAX_MEMBERS; 0 means "unset".
func parseMaxMembers(env map[string]string) (int, error) {
	raw := jsTrim(env["MAX_MEMBERS"])
	if raw == "" {
		return 0, nil
	}
	if !positiveIntegerPattern.MatchString(raw) {
		return 0, maxMembersError(raw)
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < 1 {
		return 0, maxMembersError(raw)
	}
	return value, nil
}

func maxMembersError(raw string) error {
	return fmt.Errorf("MAX_MEMBERS must be a positive integer (got %q); unset it for the default (%d)", raw, defaultMaxMembers)
}

// parseReconnectWindowMs reads the test-only RECONNECT_WINDOW_MS escape hatch
// (member offline window + phase-2 admin handover window). A malformed value is
// a deployment mistake, like MAX_MEMBERS: fail before listening.
func parseReconnectWindowMs(env map[string]string) (int64, error) {
	raw := jsTrim(env["RECONNECT_WINDOW_MS"])
	if raw == "" {
		return defaultReconnectWindowMs, nil
	}
	if !positiveIntegerPattern.MatchString(raw) {
		return 0, reconnectWindowError(raw)
	}
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || value < 1 || value > math.MaxInt64/int64(time.Millisecond) {
		return 0, reconnectWindowError(raw)
	}
	return value, nil
}

func reconnectWindowError(raw string) error {
	return fmt.Errorf("RECONNECT_WINDOW_MS must be a positive integer (got %q); unset it for the default (%d)", raw, defaultReconnectWindowMs)
}

// parseIntJS mirrors JavaScript's Number.parseInt(raw, 10) with a fallback for
// NaN: leading whitespace and sign are accepted, parsing stops at the first
// non-digit, and no digits means the fallback.
func parseIntJS(raw string, fallback int) int {
	if value, ok := parseIntJSPresent(raw); ok {
		return value
	}
	return fallback
}

func parseIntJSPresent(raw string) (int, bool) {
	text := jsTrim(raw)
	if text == "" {
		return 0, false
	}
	index := 0
	sign := 1
	if text[0] == '+' || text[0] == '-' {
		if text[0] == '-' {
			sign = -1
		}
		index++
	}
	start := index
	for index < len(text) && text[index] >= '0' && text[index] <= '9' {
		index++
	}
	if index == start {
		return 0, false
	}
	value, err := strconv.Atoi(text[start:index])
	if err != nil {
		return 0, false
	}
	return sign * value, true
}

// loadProcessConfig reads os.Environ into a map and validates it.
func loadProcessConfig() (Config, error) {
	env := make(map[string]string, len(os.Environ()))
	for _, entry := range os.Environ() {
		if index := strings.IndexByte(entry, '='); index >= 0 {
			env[entry[:index]] = entry[index+1:]
		}
	}
	return loadConfig(env)
}
