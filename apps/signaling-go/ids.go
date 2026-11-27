package main

// Random identifiers, ported from packages/core/src/bytes.ts. memberId is 8
// random bytes and rejoinToken 16, both base64url without padding.

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
)

func randomBytes(length int) []byte {
	out := make([]byte, length)
	if _, err := rand.Read(out); err != nil {
		panic(fmt.Sprintf("crypto/rand failed: %v", err))
	}
	return out
}

func base64urlEncode(bytes []byte) string {
	return base64.RawURLEncoding.EncodeToString(bytes)
}
