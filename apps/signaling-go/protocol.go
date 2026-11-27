package main

// Protocol v2 wire types and validation, ported from
// packages/core/src/protocol.ts and packages/signaling/src/server.ts.
//
// The Node implementation validates every client frame with a zod
// discriminated union. Zod objects strip unknown keys, so every value that is
// forwarded to another client (caps, signal payload) is re-serialised from the
// parsed shape: this file reproduces the same field sets and the same
// validation outcomes (BAD_MESSAGE vs VERSION_MISMATCH).

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"unicode/utf16"
)

// roomId is 16 random bytes in lowercase base32 (docs/02 §1).
var roomIDPattern = regexp.MustCompile(`^[a-z2-7]{26}$`)

const (
	protocolVersion = 2

	// docs/02 §3.1: messages larger than 64 KiB are rejected.
	maxMessageBytes = 64 * 1024
	// impl-note: consecutive malformed frames tolerated before the connection is dropped.
	maxConsecutiveBadMessages = 5

	roomTTL           = 30 * 60 * 1_000_000_000 // 30 min in ns
	heartbeat         = 20 * 1_000_000_000      // 20 s
	reconnectWindow   = 60 * 1_000_000_000      // 60 s
	turnTTLSeconds    = 3_600
	defaultMaxMembers = 4

	// docs/02 §3.1: answer for v1 pages; the client shows this text and asks for a refresh.
	versionOutdatedMsg = "版本过旧，请刷新页面"
)

// Error codes (docs/02 §3.7). denyOutcome passes a known code through as the
// join_rejected code; everything else becomes ROOM_CLOSED with the text as reason.
var errorCodes = map[string]bool{
	"ROOM_NOT_FOUND":           true,
	"ROOM_CLOSED":              true,
	"ROOM_FULL":                true,
	"PROOF_INVALID":            true,
	"SAS_MISMATCH":             true,
	"TOO_LARGE":                true,
	"CAPABILITY_RISK_DECLINED": true,
	"HASH_MISMATCH":            true,
	"TIMEOUT":                  true,
	"PEER_GONE":                true,
	"RATE_LIMITED":             true,
	"BAD_MESSAGE":              true,
	"VERSION_MISMATCH":         true,
	"NOT_ADMIN":                true,
	"BUSY":                     true,
}

// --- capabilities (docs/02 §5) ---------------------------------------------

var (
	platforms      = map[string]bool{"win": true, "mac": true, "linux": true, "ios": true, "android": true, "harmony": true, "unknown": true}
	uaFamilies     = map[string]bool{"chrome": true, "edge": true, "safari": true, "firefox": true, "arkweb": true, "unknown": true}
	saveStrategies = map[string]bool{"native": true, "fs": true, "sw": true, "blob": true}
	screens        = map[string]bool{"phone": true, "tablet": true, "desktop": true}
)

// Caps is the capability bundle every member reports (docs/02 §5). Field order
// matches the Node object so the JSON we emit reads the same.
type Caps struct {
	Platform       string   `json:"platform"`
	UAFamily       string   `json:"uaFamily"`
	NativeShell    bool     `json:"nativeShell"`
	SecureContext  bool     `json:"secureContext"`
	FSAccess       bool     `json:"fsAccess"`
	SW             bool     `json:"sw"`
	SWDownload     bool     `json:"swDownload"`
	SaveStrategies []string `json:"saveStrategies"`
	DeviceMemoryGB *float64 `json:"deviceMemoryGB,omitempty"`
	StorageQuotaMB *float64 `json:"storageQuotaMB,omitempty"`
	Screen         string   `json:"screen"`
	// Mesh marks a phase-2 client that can elect the offerer per pair
	// (docs/02 §5). Optional: older clients omit it, and the field is forwarded
	// verbatim so every member sees the same capability bundle.
	Mesh *bool `json:"mesh,omitempty"`
}

// --- room membership (ADR 0010) --------------------------------------------

// MemberInfo is one entry of the room member list. Pending members never appear.
type MemberInfo struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Caps    Caps   `json:"caps"`
	IsAdmin bool   `json:"isAdmin"`
	State   string `json:"state"` // "joined" | "offline"
}

// TurnCredential is a coturn static-auth-secret credential (docs/02 §6.8).
type TurnCredential struct {
	URIs       []string `json:"uris"`
	Username   string   `json:"username"`
	Credential string   `json:"credential"`
	TTL        int      `json:"ttl"`
}

// --- server -> client messages (docs/02 §3.2) -------------------------------

type createdMessage struct {
	V           int             `json:"v"`
	Type        string          `json:"type"`
	RoomID      string          `json:"roomId"`
	Code        string          `json:"code"`
	SelfID      string          `json:"selfId"`
	Name        string          `json:"name"`
	Members     []MemberInfo    `json:"members"`
	RejoinToken string          `json:"rejoinToken"`
	Turn        *TurnCredential `json:"turn,omitempty"`
}

type joinRequestMessage struct {
	V        int    `json:"v"`
	Type     string `json:"type"`
	MemberID string `json:"memberId"`
	Caps     Caps   `json:"caps"`
	Nonce    string `json:"nonce"`
	Proof    string `json:"proof,omitempty"`
	Name     string `json:"name"`
}

type joinOkMessage struct {
	V           int             `json:"v"`
	Type        string          `json:"type"`
	RoomID      string          `json:"roomId"`
	SelfID      string          `json:"selfId"`
	Name        string          `json:"name"`
	Members     []MemberInfo    `json:"members"`
	RejoinToken string          `json:"rejoinToken"`
	Turn        *TurnCredential `json:"turn,omitempty"`
}

type joinRejectedMessage struct {
	V      int    `json:"v"`
	Type   string `json:"type"`
	Code   string `json:"code"`
	Reason string `json:"reason"`
}

type membersMessage struct {
	V       int          `json:"v"`
	Type    string       `json:"type"`
	Members []MemberInfo `json:"members"`
}

type memberLeftMessage struct {
	V        int    `json:"v"`
	Type     string `json:"type"`
	MemberID string `json:"memberId"`
}

type roomClosedMessage struct {
	V      int    `json:"v"`
	Type   string `json:"type"`
	Reason string `json:"reason"`
}

type turnMessage struct {
	V          int      `json:"v"`
	Type       string   `json:"type"`
	URIs       []string `json:"uris"`
	Username   string   `json:"username"`
	Credential string   `json:"credential"`
	TTL        int      `json:"ttl"`
}

type errorMessage struct {
	V    int    `json:"v"`
	Type string `json:"type"`
	Code string `json:"code"`
	Msg  string `json:"msg"`
}

// OptString marshals as JSON null when Value is nil; the surrounding field is a
// pointer so an absent key stays absent (zod nullable().optional()).
type OptString struct {
	Value *string
}

func (o OptString) MarshalJSON() ([]byte, error) {
	if o.Value == nil {
		return []byte("null"), nil
	}
	return json.Marshal(*o.Value)
}

// OptNumber is the nullable-number counterpart of OptString.
type OptNumber struct {
	Value *float64
}

func (o OptNumber) MarshalJSON() ([]byte, error) {
	if o.Value == nil {
		return []byte("null"), nil
	}
	return json.Marshal(*o.Value)
}

// ICEPayload is RTCIceCandidateInitLike (only the whitelisted fields).
type ICEPayload struct {
	Candidate        string     `json:"candidate"`
	SDPMid           *OptString `json:"sdpMid,omitempty"`
	SDPMLineIndex    *OptNumber `json:"sdpMLineIndex,omitempty"`
	UsernameFragment *OptString `json:"usernameFragment,omitempty"`
}

// SignalPayload is the only client-controlled value the server forwards
// (docs/02 §3.2: offer.sdp / answer.sdp / candidate). Unknown fields are dropped.
type SignalPayload struct {
	K         string      `json:"k"`
	SDP       string      `json:"sdp,omitempty"`
	Candidate *ICEPayload `json:"candidate,omitempty"`
}

type signalMessage struct {
	V       int           `json:"v"`
	Type    string        `json:"type"`
	From    string        `json:"from"`
	Payload SignalPayload `json:"payload"`
}

// --- client -> server messages ---------------------------------------------

// ClientMessage is the parsed form of one client frame. Only the fields for the
// concrete Type are populated.
type ClientMessage struct {
	Type string

	RoomID      string
	Caps        *Caps
	Name        string
	Nonce       string
	Proof       *string
	RejoinToken *string

	MemberID string
	Reason   *string

	To      string
	Payload *SignalPayload

	ClientCaps *Caps
}

// VersionMismatchError is returned when a frame carries a `v` other than 2.
type VersionMismatchError struct {
	Received any
}

func (e *VersionMismatchError) Error() string {
	return fmt.Sprintf("unsupported protocol version: %v (expected %d)", e.Received, protocolVersion)
}

// BadMessageError is any other schema violation. NotJSON marks a frame that
// failed JSON.parse so the server can answer with the same BAD_MESSAGE text as
// the Node implementation.
type BadMessageError struct {
	Detail  string
	NotJSON bool
}

func (e *BadMessageError) Error() string { return e.Detail }

func badMessage(format string, args ...any) error {
	return &BadMessageError{Detail: fmt.Sprintf(format, args...)}
}

func isNull(raw json.RawMessage) bool {
	return len(raw) == 0 || bytes.Equal(bytes.TrimSpace(raw), []byte("null"))
}

// jsLen mirrors JavaScript's String#length (UTF-16 code units), which is what
// the zod string min/max checks count.
func jsLen(s string) int {
	return len(utf16.Encode([]rune(s)))
}

// parseClientMessage mirrors parseClientMessage() in protocol.ts: the version
// gate runs first (any object with a non-2 `v`), then the discriminated union.
func parseClientMessage(raw []byte) (*ClientMessage, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var value any
	if err := dec.Decode(&value); err != nil {
		return nil, &BadMessageError{Detail: "message is not valid JSON", NotJSON: true}
	}
	// Reject trailing garbage the way JSON.parse does.
	var trailing any
	if err := dec.Decode(&trailing); !errors.Is(err, io.EOF) {
		return nil, &BadMessageError{Detail: "message is not valid JSON", NotJSON: true}
	}
	obj, ok := value.(map[string]any)
	if !ok {
		return nil, badMessage("message does not match the protocol")
	}
	if v, present := obj["v"]; present {
		num, isNum := v.(json.Number)
		matches := false
		if isNum {
			if parsed, err := num.Float64(); err == nil && parsed == protocolVersion {
				matches = true
			}
		}
		if !matches {
			return nil, &VersionMismatchError{Received: v}
		}
	}
	typeValue, ok := obj["type"].(string)
	if !ok {
		return nil, badMessage("message does not match the protocol")
	}
	switch typeValue {
	case "hello":
		return parseHello(obj)
	case "create":
		return parseCreate(obj)
	case "join":
		return parseJoin(obj)
	case "approve":
		return parseApprove(obj)
	case "deny":
		return parseDeny(obj)
	case "remove":
		return parseRemove(obj)
	case "signal":
		return parseSignal(obj)
	case "profile":
		return parseProfile(obj)
	case "heartbeat":
		return parseHeartbeat(obj)
	case "close":
		return parseClose(obj)
	default:
		return nil, badMessage("message does not match the protocol")
	}
}

// requireV validates the literal `v: 2` in a message body. The version gate
// already rejected anything else, but an absent `v` still fails here.
func requireV(obj map[string]any) error {
	if _, present := obj["v"]; !present {
		return badMessage("v is required")
	}
	return nil
}

func rawMap(m map[string]any, key string) (json.RawMessage, bool) {
	value, ok := m[key]
	if !ok {
		return nil, false
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, false
	}
	return encoded, true
}

func parseHello(obj map[string]any) (*ClientMessage, error) {
	if err := requireV(obj); err != nil {
		return nil, err
	}
	message := &ClientMessage{Type: "hello"}
	if raw, present := rawMap(obj, "clientCaps"); present {
		caps, err := parseCaps(raw)
		if err != nil {
			return nil, err
		}
		message.ClientCaps = &caps
	}
	return message, nil
}

func parseCreate(obj map[string]any) (*ClientMessage, error) {
	if err := requireV(obj); err != nil {
		return nil, err
	}
	roomID, err := requiredString(obj, "roomId", 0, 0)
	if err != nil || !roomIDPattern.MatchString(roomID) {
		return nil, badMessage("roomId must be a 26 character room id")
	}
	capsRaw, present := rawMap(obj, "caps")
	if !present {
		return nil, badMessage("caps is required")
	}
	caps, err := parseCaps(capsRaw)
	if err != nil {
		return nil, err
	}
	name, err := requiredString(obj, "name", 1, 64)
	if err != nil {
		return nil, err
	}
	return &ClientMessage{Type: "create", RoomID: roomID, Caps: &caps, Name: name}, nil
}

func parseJoin(obj map[string]any) (*ClientMessage, error) {
	if err := requireV(obj); err != nil {
		return nil, err
	}
	roomID, err := requiredString(obj, "roomId", 0, 0)
	if err != nil || !roomIDPattern.MatchString(roomID) {
		return nil, badMessage("roomId must be a 26 character room id")
	}
	capsRaw, present := rawMap(obj, "caps")
	if !present {
		return nil, badMessage("caps is required")
	}
	caps, err := parseCaps(capsRaw)
	if err != nil {
		return nil, err
	}
	nonce, err := requiredString(obj, "nonce", 8, 64)
	if err != nil {
		return nil, err
	}
	message := &ClientMessage{Type: "join", RoomID: roomID, Caps: &caps, Nonce: nonce}
	if proof, present, err := optionalString(obj, "proof", 1, 128); err != nil {
		return nil, err
	} else if present {
		message.Proof = &proof
	}
	if token, present, err := optionalString(obj, "rejoinToken", 1, 128); err != nil {
		return nil, err
	} else if present {
		message.RejoinToken = &token
	}
	return message, nil
}

func parseApprove(obj map[string]any) (*ClientMessage, error) {
	if err := requireV(obj); err != nil {
		return nil, err
	}
	memberID, err := requiredString(obj, "memberId", 1, 0)
	if err != nil {
		return nil, err
	}
	return &ClientMessage{Type: "approve", MemberID: memberID}, nil
}

func parseDeny(obj map[string]any) (*ClientMessage, error) {
	if err := requireV(obj); err != nil {
		return nil, err
	}
	memberID, err := requiredString(obj, "memberId", 1, 0)
	if err != nil {
		return nil, err
	}
	message := &ClientMessage{Type: "deny", MemberID: memberID}
	if reason, present, err := optionalString(obj, "reason", 0, 200); err != nil {
		return nil, err
	} else if present {
		message.Reason = &reason
	}
	return message, nil
}

func parseRemove(obj map[string]any) (*ClientMessage, error) {
	if err := requireV(obj); err != nil {
		return nil, err
	}
	memberID, err := requiredString(obj, "memberId", 1, 0)
	if err != nil {
		return nil, err
	}
	return &ClientMessage{Type: "remove", MemberID: memberID}, nil
}

func parseProfile(obj map[string]any) (*ClientMessage, error) {
	if err := requireV(obj); err != nil {
		return nil, err
	}
	name, err := requiredString(obj, "name", 1, 64)
	if err != nil {
		return nil, err
	}
	return &ClientMessage{Type: "profile", Name: name}, nil
}

func parseHeartbeat(obj map[string]any) (*ClientMessage, error) {
	if err := requireV(obj); err != nil {
		return nil, err
	}
	roomID, err := requiredString(obj, "roomId", 1, 0)
	if err != nil {
		return nil, err
	}
	return &ClientMessage{Type: "heartbeat", RoomID: roomID}, nil
}

func parseClose(obj map[string]any) (*ClientMessage, error) {
	if err := requireV(obj); err != nil {
		return nil, err
	}
	roomID, err := requiredString(obj, "roomId", 1, 0)
	if err != nil {
		return nil, err
	}
	message := &ClientMessage{Type: "close", RoomID: roomID}
	if reason, present, err := optionalString(obj, "reason", 0, 200); err != nil {
		return nil, err
	} else if present {
		message.Reason = &reason
	}
	return message, nil
}

func parseSignal(obj map[string]any) (*ClientMessage, error) {
	if err := requireV(obj); err != nil {
		return nil, err
	}
	to, err := requiredString(obj, "to", 1, 0)
	if err != nil {
		return nil, err
	}
	payloadRaw, present := rawMap(obj, "payload")
	if !present {
		return nil, badMessage("payload is required")
	}
	payload, err := parseSignalPayload(payloadRaw)
	if err != nil {
		return nil, err
	}
	return &ClientMessage{Type: "signal", To: to, Payload: payload}, nil
}

func parseSignalPayload(raw json.RawMessage) (*SignalPayload, error) {
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(raw, &obj); err != nil || obj == nil {
		return nil, badMessage("payload does not match the protocol")
	}
	kind, err := rawRequiredString(obj, "k", 0, 0)
	if err != nil {
		return nil, err
	}
	switch kind {
	case "offer", "answer":
		sdp, err := rawRequiredString(obj, "sdp", 1, 0)
		if err != nil {
			return nil, err
		}
		return &SignalPayload{K: kind, SDP: sdp}, nil
	case "candidate":
		candidateRaw, present := obj["candidate"]
		if !present || isNull(candidateRaw) {
			return nil, badMessage("candidate is required")
		}
		var candidateObj map[string]json.RawMessage
		if err := json.Unmarshal(candidateRaw, &candidateObj); err != nil || candidateObj == nil {
			return nil, badMessage("candidate does not match the protocol")
		}
		candidate, err := rawRequiredString(candidateObj, "candidate", 0, 0)
		if err != nil {
			return nil, err
		}
		payload := &SignalPayload{K: "candidate", Candidate: &ICEPayload{Candidate: candidate}}
		if raw, present := candidateObj["sdpMid"]; present {
			value, err := rawNullableString(raw)
			if err != nil {
				return nil, err
			}
			payload.Candidate.SDPMid = &OptString{Value: value}
		}
		if raw, present := candidateObj["sdpMLineIndex"]; present {
			value, err := rawNullableNumber(raw)
			if err != nil {
				return nil, err
			}
			payload.Candidate.SDPMLineIndex = &OptNumber{Value: value}
		}
		if raw, present := candidateObj["usernameFragment"]; present {
			value, err := rawNullableString(raw)
			if err != nil {
				return nil, err
			}
			payload.Candidate.UsernameFragment = &OptString{Value: value}
		}
		return payload, nil
	default:
		return nil, badMessage("signal payload kind is not supported")
	}
}

// --- helpers ---------------------------------------------------------------

func requiredString(obj map[string]any, key string, minLen, maxLen int) (string, error) {
	raw, present := rawMap(obj, key)
	if !present || isNull(raw) {
		return "", badMessage("%s is required", key)
	}
	return rawRequiredString(map[string]json.RawMessage{key: raw}, key, minLen, maxLen)
}

func optionalString(obj map[string]any, key string, minLen, maxLen int) (string, bool, error) {
	raw, present := rawMap(obj, key)
	if !present {
		return "", false, nil
	}
	if isNull(raw) {
		return "", false, badMessage("%s must be a string", key)
	}
	value, err := rawRequiredString(map[string]json.RawMessage{key: raw}, key, minLen, maxLen)
	if err != nil {
		return "", false, err
	}
	return value, true, nil
}

func rawRequiredString(obj map[string]json.RawMessage, key string, minLen, maxLen int) (string, error) {
	raw, present := obj[key]
	if !present || isNull(raw) {
		return "", badMessage("%s is required", key)
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", badMessage("%s must be a string", key)
	}
	length := jsLen(value)
	if length < minLen || (maxLen > 0 && length > maxLen) {
		return "", badMessage("%s has an invalid length", key)
	}
	return value, nil
}

func rawNullableString(raw json.RawMessage) (*string, error) {
	if isNull(raw) {
		return nil, nil
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, badMessage("expected a string or null")
	}
	return &value, nil
}

func rawNullableNumber(raw json.RawMessage) (*float64, error) {
	if isNull(raw) {
		return nil, nil
	}
	var value float64
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, badMessage("expected a number or null")
	}
	return &value, nil
}

// parseCaps reproduces capsSchema: every required field must be present with
// the right type, enum values are checked, optional numbers must be positive,
// and unknown keys are dropped.
func parseCaps(raw json.RawMessage) (Caps, error) {
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(raw, &obj); err != nil || obj == nil {
		return Caps{}, badMessage("caps must be an object")
	}
	caps := Caps{}
	platform, err := rawRequiredString(obj, "platform", 0, 0)
	if err != nil || !platforms[platform] {
		return Caps{}, badMessage("caps.platform is invalid")
	}
	caps.Platform = platform
	uaFamily, err := rawRequiredString(obj, "uaFamily", 0, 0)
	if err != nil || !uaFamilies[uaFamily] {
		return Caps{}, badMessage("caps.uaFamily is invalid")
	}
	caps.UAFamily = uaFamily
	for _, field := range []struct {
		key    string
		target *bool
	}{
		{"nativeShell", &caps.NativeShell},
		{"secureContext", &caps.SecureContext},
		{"fsAccess", &caps.FSAccess},
		{"sw", &caps.SW},
		{"swDownload", &caps.SWDownload},
	} {
		value, err := rawRequiredBool(obj, field.key)
		if err != nil {
			return Caps{}, err
		}
		*field.target = value
	}
	strategiesRaw, present := obj["saveStrategies"]
	if !present || isNull(strategiesRaw) {
		return Caps{}, badMessage("caps.saveStrategies is required")
	}
	var strategies []string
	if err := json.Unmarshal(strategiesRaw, &strategies); err != nil {
		return Caps{}, badMessage("caps.saveStrategies must be an array")
	}
	if len(strategies) < 1 {
		return Caps{}, badMessage("caps.saveStrategies must not be empty")
	}
	for _, strategy := range strategies {
		if !saveStrategies[strategy] {
			return Caps{}, badMessage("caps.saveStrategies contains an unknown strategy")
		}
	}
	caps.SaveStrategies = strategies
	if raw, present := obj["deviceMemoryGB"]; present {
		value, err := rawOptionalPositiveNumber(raw, "deviceMemoryGB")
		if err != nil {
			return Caps{}, err
		}
		caps.DeviceMemoryGB = value
	}
	if raw, present := obj["storageQuotaMB"]; present {
		value, err := rawOptionalPositiveNumber(raw, "storageQuotaMB")
		if err != nil {
			return Caps{}, err
		}
		caps.StorageQuotaMB = value
	}
	screen, err := rawRequiredString(obj, "screen", 0, 0)
	if err != nil || !screens[screen] {
		return Caps{}, badMessage("caps.screen is invalid")
	}
	caps.Screen = screen
	if raw, present := obj["mesh"]; present {
		value, err := rawOptionalBool(raw, "mesh")
		if err != nil {
			return Caps{}, err
		}
		caps.Mesh = value
	}
	return caps, nil
}

// rawOptionalBool parses an optional JSON boolean: absent is fine, null and any
// non-boolean value are schema errors (like z.boolean().optional()).
func rawOptionalBool(raw json.RawMessage, key string) (*bool, error) {
	if isNull(raw) {
		return nil, badMessage("caps.%s must be a boolean", key)
	}
	var value bool
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, badMessage("caps.%s must be a boolean", key)
	}
	return &value, nil
}

func rawRequiredBool(obj map[string]json.RawMessage, key string) (bool, error) {
	raw, present := obj[key]
	if !present || isNull(raw) {
		return false, badMessage("caps.%s is required", key)
	}
	var value bool
	if err := json.Unmarshal(raw, &value); err != nil {
		return false, badMessage("caps.%s must be a boolean", key)
	}
	return value, nil
}

func rawOptionalPositiveNumber(raw json.RawMessage, key string) (*float64, error) {
	if isNull(raw) {
		return nil, badMessage("caps.%s must be a positive number", key)
	}
	var value float64
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, badMessage("caps.%s must be a positive number", key)
	}
	if value <= 0 {
		return nil, badMessage("caps.%s must be a positive number", key)
	}
	return &value, nil
}

// errVersionMismatch reports whether the error is the version gate.
func errVersionMismatch(err error) bool {
	var mismatch *VersionMismatchError
	return errors.As(err, &mismatch)
}
