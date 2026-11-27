package main

// The six digit join code (docs/02 §3.5): valid for 10 minutes, single use,
// memory only. `join.roomId` may carry the code; the server maps it to a roomId
// before schema validation (see server.prepareShortCode).

import (
	"crypto/rand"
	"fmt"
	"math/big"
)

const shortCodeTTLMs int64 = 10 * 60 * 1_000

type shortCodeEntry struct {
	roomID    string
	expiresAt int64
}

// ShortCodeStore is the in-memory code <-> room mapping.
type ShortCodeStore struct {
	byCode map[string]shortCodeEntry
	byRoom map[string]string
	clock  Clock
}

func newShortCodeStore(clock Clock) *ShortCodeStore {
	return &ShortCodeStore{
		byCode: make(map[string]shortCodeEntry),
		byRoom: make(map[string]string),
		clock:  clock,
	}
}

// issue returns an unused code for the room, or the still-valid code it has.
func (s *ShortCodeStore) issue(roomID string) string {
	now := nowMillis(s.clock)
	if existing, ok := s.byRoom[roomID]; ok {
		entry, found := s.byCode[existing]
		if found && entry.expiresAt > now {
			return existing
		}
		delete(s.byCode, existing)
		delete(s.byRoom, roomID)
	}
	for attempt := 0; attempt < 1_000; attempt++ {
		value, err := rand.Int(rand.Reader, big.NewInt(1_000_000))
		if err != nil {
			panic(fmt.Sprintf("six digit code space exhausted: %v", err))
		}
		code := fmt.Sprintf("%06d", value.Int64())
		if _, exists := s.byCode[code]; exists {
			continue
		}
		s.byCode[code] = shortCodeEntry{roomID: roomID, expiresAt: now + shortCodeTTLMs}
		s.byRoom[roomID] = code
		return code
	}
	panic("six digit code space exhausted")
}

// resolve looks the code up without consuming it.
func (s *ShortCodeStore) resolve(code string) (string, bool) {
	entry, ok := s.byCode[code]
	if !ok {
		return "", false
	}
	if entry.expiresAt <= nowMillis(s.clock) {
		s.forget(code, entry)
		return "", false
	}
	return entry.roomID, true
}

// consume resolves the code and invalidates it (single use).
func (s *ShortCodeStore) consume(code string) (string, bool) {
	entry, ok := s.byCode[code]
	if !ok {
		return "", false
	}
	if entry.expiresAt <= nowMillis(s.clock) {
		s.forget(code, entry)
		return "", false
	}
	s.forget(code, entry)
	return entry.roomID, true
}

func (s *ShortCodeStore) revokeRoom(roomID string) {
	if code, ok := s.byRoom[roomID]; ok {
		delete(s.byCode, code)
	}
	delete(s.byRoom, roomID)
}

func (s *ShortCodeStore) sweep() {
	at := nowMillis(s.clock)
	for code, entry := range s.byCode {
		if entry.expiresAt <= at {
			s.forget(code, entry)
		}
	}
}

func (s *ShortCodeStore) clear() {
	s.byCode = make(map[string]shortCodeEntry)
	s.byRoom = make(map[string]string)
}

func (s *ShortCodeStore) forget(code string, entry shortCodeEntry) {
	delete(s.byCode, code)
	if current, ok := s.byRoom[entry.roomID]; ok && current == code {
		delete(s.byRoom, entry.roomID)
	}
}
