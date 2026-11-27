package main

import (
	"regexp"
	"testing"
	"time"
)

func TestShortCodeIssueResolveConsume(t *testing.T) {
	clock := newFakeClock()
	store := newShortCodeStore(clock)
	roomID := "abcdefghijklmnopqrstuvwxyz"

	code := store.issue(roomID)
	if !regexp.MustCompile(`^\d{6}$`).MatchString(code) {
		t.Fatalf("code = %q, want six digits", code)
	}
	if again := store.issue(roomID); again != code {
		t.Fatalf("issue returned a new code %q, want the valid one %q", again, code)
	}
	resolved, ok := store.resolve(code)
	if !ok || resolved != roomID {
		t.Fatalf("resolve(%q) = (%q, %v)", code, resolved, ok)
	}
	consumed, ok := store.consume(code)
	if !ok || consumed != roomID {
		t.Fatalf("consume(%q) = (%q, %v)", code, consumed, ok)
	}
	if _, ok := store.resolve(code); ok {
		t.Fatalf("code should be single use")
	}
	if _, ok := store.consume(code); ok {
		t.Fatalf("code should stay consumed")
	}
}

func TestShortCodeExpiry(t *testing.T) {
	clock := newFakeClock()
	store := newShortCodeStore(clock)
	roomID := "abcdefghijklmnopqrstuvwxyz"
	code := store.issue(roomID)

	clock.Advance(10*time.Minute - time.Millisecond)
	if _, ok := store.resolve(code); !ok {
		t.Fatalf("code should still be valid just before the TTL")
	}
	clock.Advance(2 * time.Millisecond)
	if _, ok := store.resolve(code); ok {
		t.Fatalf("code should be expired after ten minutes")
	}
	// The room can get a fresh code after expiry.
	fresh := store.issue(roomID)
	if fresh == code {
		t.Fatalf("expected a fresh code, got the expired one")
	}
}

func TestShortCodeRevokeAndSweep(t *testing.T) {
	clock := newFakeClock()
	store := newShortCodeStore(clock)
	first := "aaaaaaaaaaaaaaaaaaaaaaaaaa"
	second := "bbbbbbbbbbbbbbbbbbbbbbbbbb"
	code := store.issue(first)
	other := store.issue(second)
	if code == other {
		t.Fatalf("two rooms share the code %q", code)
	}
	store.revokeRoom(first)
	if _, ok := store.resolve(code); ok {
		t.Fatalf("revoked code still resolves")
	}
	clock.Advance(10*time.Minute + time.Millisecond)
	store.sweep()
	if _, ok := store.resolve(other); ok {
		t.Fatalf("expired code survived the sweep")
	}
	store.clear()
	if store.issue(first) == "" {
		t.Fatalf("store should work after clear")
	}
}
