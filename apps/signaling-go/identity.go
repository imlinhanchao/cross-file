package main

// Display-name helpers (ADR 0010 §names), ported from
// packages/core/src/identity.ts. A display name is a device-local label the
// signaling server only relays; it is never stored.

import (
	"crypto/rand"
	"fmt"
	"strings"
	"unicode"
)

const (
	codeAlphabet      = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
	codeLength        = 4
	maxNameCodePoints = 16
	fallbackName      = "设备"
)

var platformLabels = map[string]string{
	"win":     "Windows",
	"mac":     "MacBook",
	"linux":   "电脑",
	"ios":     "iPhone",
	"android": "手机",
	"harmony": "鸿蒙",
	"unknown": "设备",
}

// platformLabel is the human label for a platform, e.g. mac -> MacBook.
func platformLabel(platform string) string {
	if label, ok := platformLabels[platform]; ok {
		return label
	}
	return platformLabels["unknown"]
}

// defaultDisplayName seeds a name from the capabilities, e.g. "MacBook · 7K2F".
func defaultDisplayName(caps Caps) string {
	bytes := make([]byte, codeLength)
	if _, err := rand.Read(bytes); err != nil {
		// A display code is not a secret; fall back to zeros only if the OS RNG fails.
		bytes = make([]byte, codeLength)
	}
	var builder strings.Builder
	for _, b := range bytes {
		builder.WriteByte(codeAlphabet[int(b)&31])
	}
	return fmt.Sprintf("%s · %s", platformLabel(caps.Platform), builder.String())
}

// normalizeDisplayName trims, drops control characters and enforces 1-16
// Unicode code points. The second result is false when the name is unusable.
func normalizeDisplayName(raw string) (string, bool) {
	cleaned := strings.Map(func(r rune) rune {
		if unicode.Is(unicode.Cc, r) {
			return -1
		}
		return r
	}, raw)
	cleaned = jsTrim(cleaned)
	if cleaned == "" {
		return "", false
	}
	if len([]rune(cleaned)) > maxNameCodePoints {
		return "", false
	}
	return cleaned, true
}

// isJSSpace reports whether r is stripped by JavaScript's String#trim: the
// ECMAScript WhiteSpace and LineTerminator sets (which differ slightly from
// Go's unicode.IsSpace: U+FEFF is included, U+0085 is not).
func isJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0x00A0, 0xFEFF:
		return true
	}
	return unicode.Is(unicode.Zs, r) || unicode.Is(unicode.Zl, r) || unicode.Is(unicode.Zp, r)
}

func jsTrim(s string) string {
	return strings.TrimFunc(s, isJSSpace)
}

func jsTrimEnd(s string) string {
	return strings.TrimRightFunc(s, isJSSpace)
}

// dedupeNames makes a list of candidate names unique in join order, appending
// -2, -3, … on collision (docs/02 §1).
func dedupeNames(baseNames []string) []string {
	used := make(map[string]bool, len(baseNames))
	result := make([]string, 0, len(baseNames))
	for _, raw := range baseNames {
		base, ok := normalizeDisplayName(raw)
		if !ok {
			base = fallbackName
		}
		candidate := base
		suffix := 2
		for used[candidate] {
			candidate = withSuffix(base, fmt.Sprintf("-%d", suffix))
			suffix++
		}
		used[candidate] = true
		result = append(result, candidate)
	}
	return result
}

func withSuffix(base, suffix string) string {
	room := maxNameCodePoints - len([]rune(suffix))
	if room < 1 {
		room = 1
	}
	runes := []rune(base)
	if len(runes) > room {
		runes = runes[:room]
	}
	truncated := jsTrimEnd(string(runes))
	if truncated == "" {
		truncated = fallbackName
	}
	return truncated + suffix
}
