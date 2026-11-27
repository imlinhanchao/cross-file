package main

import (
	"testing"
	"time"
)

func TestRateLimiterFixedWindow(t *testing.T) {
	clock := newFakeClock()
	limiter := newRateLimiter(RateLimitPolicy{WindowMs: 60_000, Max: 3}, clock)
	for index := 0; index < 3; index++ {
		if !limiter.take("ip") {
			t.Fatalf("message %d should be allowed", index+1)
		}
	}
	if limiter.take("ip") {
		t.Fatalf("the fourth message should be rate limited")
	}
	// A different key has its own bucket.
	if !limiter.take("other-ip") {
		t.Fatalf("a different key should be allowed")
	}
	// The window resets after 60 s.
	clock.Advance(60 * time.Second)
	if !limiter.take("ip") {
		t.Fatalf("the bucket should reset after the window")
	}
}

func TestRateLimiterSweepAndClear(t *testing.T) {
	clock := newFakeClock()
	limiter := newRateLimiter(RateLimitPolicy{WindowMs: 1_000, Max: 1}, clock)
	if !limiter.take("ip") || limiter.take("ip") {
		t.Fatalf("unexpected budget behaviour")
	}
	clock.Advance(time.Second)
	limiter.sweep()
	if len(limiter.buckets) != 0 {
		t.Fatalf("sweep left %d buckets", len(limiter.buckets))
	}
	if !limiter.take("ip") {
		t.Fatalf("sweep should reset the window")
	}
	limiter.clear()
	if len(limiter.buckets) != 0 {
		t.Fatalf("clear left %d buckets", len(limiter.buckets))
	}
}
