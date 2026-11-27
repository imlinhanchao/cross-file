package main

// Per-IP signaling rate limiter (docs/02 §6.8). In-memory only: the map is the
// single place an IP is ever kept, and it is dropped on stop or when the window
// expires (docs/02 §7 zero storage).

// RateLimitPolicy is one fixed window budget.
type RateLimitPolicy struct {
	WindowMs int64
	Max      int
}

type rateBucket struct {
	count   int
	resetAt int64
}

// RateLimiter counts messages per key inside a fixed window.
type RateLimiter struct {
	buckets map[string]rateBucket
	policy  RateLimitPolicy
	clock   Clock
}

func newRateLimiter(policy RateLimitPolicy, clock Clock) *RateLimiter {
	return &RateLimiter{buckets: make(map[string]rateBucket), policy: policy, clock: clock}
}

// take counts one message; false means the caller must answer RATE_LIMITED.
func (l *RateLimiter) take(key string) bool {
	at := nowMillis(l.clock)
	bucket, ok := l.buckets[key]
	if !ok || at >= bucket.resetAt {
		l.buckets[key] = rateBucket{count: 1, resetAt: at + l.policy.WindowMs}
		return true
	}
	if bucket.count >= l.policy.Max {
		return false
	}
	bucket.count++
	l.buckets[key] = bucket
	return true
}

// sweep drops buckets whose window has passed (called from the room sweep).
func (l *RateLimiter) sweep() {
	at := nowMillis(l.clock)
	for key, bucket := range l.buckets {
		if bucket.resetAt <= at {
			delete(l.buckets, key)
		}
	}
}

func (l *RateLimiter) clear() {
	l.buckets = make(map[string]rateBucket)
}
