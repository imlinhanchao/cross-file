package main

// Injectable time source. Production uses the real clock; tests swap in a fake
// so the 60 s reconnect window, the 10 min join code TTL and the per-IP rate
// limit can be exercised deterministically.

import "time"

// Timer is a cancellable one-shot timer.
type Timer interface {
	Stop() bool
}

// Clock provides the current time and one-shot timers.
type Clock interface {
	Now() time.Time
	AfterFunc(d time.Duration, f func()) Timer
}

type realClock struct{}

func (realClock) Now() time.Time { return time.Now() }

func (realClock) AfterFunc(d time.Duration, f func()) Timer {
	return realTimer{time.AfterFunc(d, f)}
}

type realTimer struct {
	timer *time.Timer
}

func (t realTimer) Stop() bool { return t.timer.Stop() }

// nowMillis is the unix-millisecond reading used by the protocol timers.
func nowMillis(clock Clock) int64 {
	return clock.Now().UnixMilli()
}
