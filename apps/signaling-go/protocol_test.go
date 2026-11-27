package main

import (
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
)

func parse(t *testing.T, raw string) (*ClientMessage, error) {
	t.Helper()
	return parseClientMessage([]byte(raw))
}

func mustParse(t *testing.T, raw string) *ClientMessage {
	t.Helper()
	message, err := parse(t, raw)
	if err != nil {
		t.Fatalf("parseClientMessage(%s): %v", raw, err)
	}
	return message
}

func TestParseHelloAndVersionGate(t *testing.T) {
	message := mustParse(t, `{"v":2,"type":"hello","clientCaps":`+capsJSON(t, adminCaps())+`}`)
	if message.Type != "hello" || message.ClientCaps == nil || message.ClientCaps.Platform != "linux" {
		t.Fatalf("unexpected hello: %+v", message)
	}
	mustParse(t, `{"v":2,"type":"hello"}`)

	// The version gate applies to every message type, not only hello/create/join.
	for _, raw := range []string{
		`{"v":1,"type":"hello"}`,
		`{"v":1,"type":"heartbeat","roomId":"x"}`,
		`{"v":3,"type":"close","roomId":"x"}`,
		`{"v":"2","type":"hello"}`,
		`{"v":null,"type":"hello"}`,
		`{"v":2.5,"type":"hello"}`,
	} {
		_, err := parse(t, raw)
		if !errVersionMismatch(err) {
			t.Fatalf("%s: want VersionMismatchError, got %v", raw, err)
		}
	}
	// `v:2.0` parses to the number 2 in JavaScript, so it is accepted.
	mustParse(t, `{"v":2.0,"type":"hello"}`)

	// A missing v is a schema error, not a version mismatch.
	for _, raw := range []string{
		`{"type":"hello"}`,
		`[]`,
		`null`,
		`"hello"`,
		`not json`,
		`{"v":2,"type":"nope"}`,
		`{"v":2}`,
	} {
		_, err := parse(t, raw)
		if err == nil || errVersionMismatch(err) {
			t.Fatalf("%s: want BadMessageError, got %v", raw, err)
		}
	}
}

func TestParseCreateValidation(t *testing.T) {
	roomID := "abcdefghijklmnopqrstuvwxyz"
	message := mustParse(t, `{"v":2,"type":"create","roomId":"`+roomID+`","caps":`+capsJSON(t, adminCaps())+`,"name":"MacBook"}`)
	if message.RoomID != roomID || message.Name != "MacBook" || message.Caps == nil {
		t.Fatalf("unexpected create: %+v", message)
	}

	bad := []string{
		// roomId must be 26 lowercase base32 characters.
		`{"v":2,"type":"create","roomId":"ABCDEFGHIJKLMNOPQRSTUVWXYZ","caps":` + capsJSON(t, adminCaps()) + `,"name":"x"}`,
		`{"v":2,"type":"create","roomId":"short","caps":` + capsJSON(t, adminCaps()) + `,"name":"x"}`,
		// caps is required and fully validated.
		`{"v":2,"type":"create","roomId":"` + roomID + `","name":"x"}`,
		`{"v":2,"type":"create","roomId":"` + roomID + `","caps":{},"name":"x"}`,
		`{"v":2,"type":"create","roomId":"` + roomID + `","caps":` + strings.Replace(capsJSON(t, adminCaps()), `"platform":"linux"`, `"platform":"beos"`, 1) + `,"name":"x"}`,
		`{"v":2,"type":"create","roomId":"` + roomID + `","caps":` + strings.Replace(capsJSON(t, adminCaps()), `"secureContext":true`, `"secureContext":"yes"`, 1) + `,"name":"x"}`,
		`{"v":2,"type":"create","roomId":"` + roomID + `","caps":` + strings.Replace(capsJSON(t, adminCaps()), `"saveStrategies":["fs","blob"]`, `"saveStrategies":[]`, 1) + `,"name":"x"}`,
		`{"v":2,"type":"create","roomId":"` + roomID + `","caps":` + strings.Replace(capsJSON(t, adminCaps()), `"deviceMemoryGB":16`, `"deviceMemoryGB":0`, 1) + `,"name":"x"}`,
		// name is required (1-64 UTF-16 units; normalisation happens in the server).
		`{"v":2,"type":"create","roomId":"` + roomID + `","caps":` + capsJSON(t, adminCaps()) + `}`,
		`{"v":2,"type":"create","roomId":"` + roomID + `","caps":` + capsJSON(t, adminCaps()) + `,"name":""}`,
		`{"v":2,"type":"create","roomId":"` + roomID + `","caps":` + capsJSON(t, adminCaps()) + `,"name":null}`,
	}
	for _, raw := range bad {
		if _, err := parse(t, raw); err == nil {
			t.Fatalf("expected a schema error for %s", raw)
		} else if errVersionMismatch(err) {
			t.Fatalf("unexpected version error for %s: %v", raw, err)
		}
	}
}

func TestParseJoinValidation(t *testing.T) {
	roomID := "abcdefghijklmnopqrstuvwxyz"
	base := `{"v":2,"type":"join","roomId":"` + roomID + `","caps":` + capsJSON(t, memberCaps()) + `,"nonce":"member-nonce-0123456789"`
	message := mustParse(t, base+`,"proof":"p","rejoinToken":"t"}`)
	if message.Proof == nil || *message.Proof != "p" || message.RejoinToken == nil || *message.RejoinToken != "t" {
		t.Fatalf("unexpected join: %+v", message)
	}
	message = mustParse(t, base+`}`)
	if message.Proof != nil || message.RejoinToken != nil {
		t.Fatalf("optional fields should be absent: %+v", message)
	}
	// nonce is 8-64 UTF-16 units.
	for _, raw := range []string{
		base + `,"nonce":"short"}`,
		`{"v":2,"type":"join","roomId":"` + roomID + `","caps":` + capsJSON(t, memberCaps()) + `}`,
		base + `,"proof":""}`,
		base + `,"proof":null}`,
	} {
		if _, err := parse(t, raw); err == nil {
			t.Fatalf("expected a schema error for %s", raw)
		}
	}
}

func TestParseSignalPayloadWhitelist(t *testing.T) {
	base := `{"v":2,"type":"signal","to":"peer"`
	offer := mustParse(t, base+`,"payload":{"k":"offer","sdp":"v=0","junk":"dropped"}}`)
	if offer.Payload.K != "offer" || offer.Payload.SDP != "v=0" {
		t.Fatalf("unexpected offer: %+v", offer.Payload)
	}
	encoded, _ := json.Marshal(offer.Payload)
	if string(encoded) != `{"k":"offer","sdp":"v=0"}` {
		t.Fatalf("forwarded payload = %s", encoded)
	}

	answer := mustParse(t, base+`,"payload":{"k":"answer","sdp":"v=0\r\n"}}`)
	encoded, _ = json.Marshal(answer.Payload)
	if string(encoded) != `{"k":"answer","sdp":"v=0\r\n"}` {
		t.Fatalf("forwarded answer = %s", encoded)
	}

	// Candidate: unknown fields dropped, absent optionals stay absent, null stays null.
	candidate := mustParse(t, base+`,"payload":{"k":"candidate","candidate":{"candidate":"candidate:1","sdpMid":"0","junk":1},"extra":true}}`)
	encoded, _ = json.Marshal(candidate.Payload)
	want := `{"k":"candidate","candidate":{"candidate":"candidate:1","sdpMid":"0"}}`
	if string(encoded) != want {
		t.Fatalf("forwarded candidate = %s, want %s", encoded, want)
	}
	candidate = mustParse(t, base+`,"payload":{"k":"candidate","candidate":{"candidate":"c","sdpMid":null,"sdpMLineIndex":null,"usernameFragment":null}}}`)
	encoded, _ = json.Marshal(candidate.Payload)
	want = `{"k":"candidate","candidate":{"candidate":"c","sdpMid":null,"sdpMLineIndex":null,"usernameFragment":null}}`
	if string(encoded) != want {
		t.Fatalf("forwarded nullable candidate = %s, want %s", encoded, want)
	}

	bad := []string{
		base + `,"payload":{"k":"offer"}}`,
		base + `,"payload":{"k":"offer","sdp":""}}`,
		base + `,"payload":{"k":"bye"}}`,
		base + `,"payload":{"k":"candidate"}}`,
		base + `,"payload":{"k":"candidate","candidate":null}}`,
		base + `,"payload":{"k":"candidate","candidate":{"sdpMid":"0"}}}`,
		base + `,"payload":{"k":"candidate","candidate":{"candidate":"c","sdpMid":3}}}`,
	}
	for _, raw := range bad {
		if _, err := parse(t, raw); err == nil {
			t.Fatalf("expected a schema error for %s", raw)
		}
	}
}

func TestParseMiscMessages(t *testing.T) {
	approve := mustParse(t, `{"v":2,"type":"approve","memberId":"m"}`)
	if approve.MemberID != "m" {
		t.Fatalf("unexpected approve: %+v", approve)
	}
	deny := mustParse(t, `{"v":2,"type":"deny","memberId":"m","reason":"not right now"}`)
	if deny.Reason == nil || *deny.Reason != "not right now" {
		t.Fatalf("unexpected deny: %+v", deny)
	}
	profile := mustParse(t, `{"v":2,"type":"profile","name":"客厅"}`)
	if profile.Name != "客厅" {
		t.Fatalf("unexpected profile: %+v", profile)
	}
	heartbeat := mustParse(t, `{"v":2,"type":"heartbeat","roomId":"r"}`)
	if heartbeat.RoomID != "r" {
		t.Fatalf("unexpected heartbeat: %+v", heartbeat)
	}
	closeMessage := mustParse(t, `{"v":2,"type":"close","roomId":"r"}`)
	if closeMessage.RoomID != "r" {
		t.Fatalf("unexpected close: %+v", closeMessage)
	}
	// Extra top-level keys are ignored (zod strips unknown keys).
	mustParse(t, `{"v":2,"type":"hello","extra":1}`)

	for _, raw := range []string{
		`{"v":2,"type":"approve","memberId":""}`,
		`{"v":2,"type":"deny","memberId":""}`,
		`{"v":2,"type":"remove"}`,
		`{"v":2,"type":"profile","name":""}`,
		`{"v":2,"type":"heartbeat","roomId":""}`,
		`{"v":2,"type":"close"}`,
	} {
		if _, err := parse(t, raw); err == nil {
			t.Fatalf("expected a schema error for %s", raw)
		}
	}
}

func TestParseJSONErrorsAreMarked(t *testing.T) {
	for _, raw := range []string{`not json`, `{"v":2,"type":"hello"} trailing`, `{"v":2,}`} {
		_, err := parse(t, raw)
		var bad *BadMessageError
		if !errors.As(err, &bad) || !bad.NotJSON {
			t.Fatalf("%s: want NotJSON BadMessageError, got %v", raw, err)
		}
	}
	_, err := parse(t, `{"v":2,"type":"hello","clientCaps":null}`)
	var bad *BadMessageError
	if !errors.As(err, &bad) || bad.NotJSON {
		t.Fatalf("clientCaps:null should be a schema error, got %v", err)
	}
}

func TestCapsRoundTrip(t *testing.T) {
	// Every known field survives; unknown fields are dropped.
	raw := `{"platform":"mac","uaFamily":"safari","nativeShell":true,"secureContext":true,"fsAccess":false,"sw":true,"swDownload":true,"saveStrategies":["sw","blob"],"deviceMemoryGB":8,"storageQuotaMB":2048,"screen":"tablet","junk":"dropped"}`
	caps, err := parseCaps([]byte(raw))
	if err != nil {
		t.Fatalf("parseCaps: %v", err)
	}
	if caps.Platform != "mac" || caps.DeviceMemoryGB == nil || *caps.DeviceMemoryGB != 8 || caps.StorageQuotaMB == nil || *caps.StorageQuotaMB != 2048 {
		t.Fatalf("unexpected caps: %+v", caps)
	}
	encoded, _ := json.Marshal(caps)
	var roundTrip map[string]any
	_ = json.Unmarshal(encoded, &roundTrip)
	if _, present := roundTrip["junk"]; present {
		t.Fatalf("unknown caps field was forwarded: %s", encoded)
	}
	expected := map[string]any{
		"platform": "mac", "uaFamily": "safari", "nativeShell": true, "secureContext": true,
		"fsAccess": false, "sw": true, "swDownload": true, "saveStrategies": []any{"sw", "blob"},
		"deviceMemoryGB": 8.0, "storageQuotaMB": 2048.0, "screen": "tablet",
	}
	if !reflect.DeepEqual(roundTrip, expected) {
		t.Fatalf("caps round trip = %v", roundTrip)
	}
}

func TestParseCapsMesh(t *testing.T) {
	base := `"platform":"linux","uaFamily":"chrome","nativeShell":false,"secureContext":true,"fsAccess":true,"sw":true,"swDownload":false,"saveStrategies":["blob"],"screen":"desktop"`

	// true and false are both preserved (pointer field, not omitempty).
	for _, want := range []bool{true, false} {
		caps, err := parseCaps([]byte(`{` + base + `,"mesh":` + map[bool]string{true: "true", false: "false"}[want] + `}`))
		if err != nil {
			t.Fatalf("parseCaps(mesh=%v): %v", want, err)
		}
		if caps.Mesh == nil || *caps.Mesh != want {
			t.Fatalf("mesh = %v, want %v", caps.Mesh, want)
		}
		encoded, _ := json.Marshal(caps)
		if !strings.Contains(string(encoded), `"mesh":`+map[bool]string{true: "true", false: "false"}[want]) {
			t.Fatalf("forwarded caps dropped mesh: %s", encoded)
		}
	}

	// Absent stays absent: no "mesh":false is emitted for older clients.
	caps, err := parseCaps([]byte(`{` + base + `}`))
	if err != nil {
		t.Fatalf("parseCaps(no mesh): %v", err)
	}
	if caps.Mesh != nil {
		t.Fatalf("absent mesh became %v", *caps.Mesh)
	}
	encoded, _ := json.Marshal(caps)
	if strings.Contains(string(encoded), `"mesh"`) {
		t.Fatalf("absent mesh was emitted: %s", encoded)
	}

	// Non-boolean values are schema errors.
	for _, value := range []string{`"yes"`, `null`, `1`, `{}`} {
		if _, err := parseCaps([]byte(`{` + base + `,"mesh":` + value + `}`)); err == nil {
			t.Fatalf("mesh=%s should be rejected", value)
		} else if errVersionMismatch(err) {
			t.Fatalf("mesh=%s should be a schema error, got %v", value, err)
		}
	}
}

func capsJSON(t *testing.T, caps Caps) string {
	t.Helper()
	encoded, err := json.Marshal(caps)
	if err != nil {
		t.Fatalf("marshal caps: %v", err)
	}
	return string(encoded)
}
