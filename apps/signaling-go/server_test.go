package main

import (
	"encoding/json"
	"net/http"
	"reflect"
	"testing"
	"time"
)

const testTimeout = 2 * time.Second

func assertCapsEqual(t *testing.T, actual any, expected Caps) {
	t.Helper()
	encoded, err := json.Marshal(expected)
	if err != nil {
		t.Fatalf("marshal expected caps: %v", err)
	}
	var expectedMap map[string]any
	if err := json.Unmarshal(encoded, &expectedMap); err != nil {
		t.Fatalf("unmarshal expected caps: %v", err)
	}
	actualMap, ok := actual.(map[string]any)
	if !ok {
		t.Fatalf("caps is not an object: %T", actual)
	}
	if !reflect.DeepEqual(actualMap, expectedMap) {
		t.Fatalf("caps = %v, want %v", actualMap, expectedMap)
	}
}

// --- create -----------------------------------------------------------------

func TestCreateRoomMakesCreatorAdmin(t *testing.T) {
	_, port := startTestServer(t, Options{Port: 0})
	admin := connectClient(t, port)
	roomID := newRoomID(t)
	caps := adminCaps()
	admin.send(map[string]any{"v": 2, "type": "hello", "clientCaps": caps})
	admin.send(map[string]any{"v": 2, "type": "create", "roomId": roomID, "caps": caps, "name": "MacBook · 7K2F"})
	created := admin.mustNext("created", testTimeout)

	if got := str(t, created, "roomId"); got != roomID {
		t.Fatalf("roomId = %q", got)
	}
	if code := str(t, created, "code"); len(code) != 6 {
		t.Fatalf("code = %q", code)
	}
	selfID := str(t, created, "selfId")
	if len(selfID) != 11 {
		t.Fatalf("selfId = %q (want 11 base64url chars)", selfID)
	}
	if got := str(t, created, "name"); got != "MacBook · 7K2F" {
		t.Fatalf("name = %q", got)
	}
	if token := str(t, created, "rejoinToken"); len(token) != 22 {
		t.Fatalf("rejoinToken = %q (want 22 base64url chars)", token)
	}
	members := membersOf(t, created)
	if len(members) != 1 {
		t.Fatalf("created.members = %v", members)
	}
	adminEntry := members[0].(map[string]any)
	if adminEntry["id"] != selfID || adminEntry["name"] != "MacBook · 7K2F" ||
		adminEntry["isAdmin"] != true || adminEntry["state"] != "joined" {
		t.Fatalf("admin member = %v", adminEntry)
	}
	assertCapsEqual(t, adminEntry["caps"], caps)
	if _, present := created["turn"]; present {
		t.Fatalf("TURN credentials were handed out without TURN: %v", created["turn"])
	}
}

func TestCreateNormalisesAdminName(t *testing.T) {
	_, port := startTestServer(t, Options{Port: 0})
	room := createTestRoom(t, port, "  客厅 的电脑  ")
	if got := str(t, room.created, "name"); got != "客厅 的电脑" {
		t.Fatalf("name = %q", got)
	}
	if got := membersOf(t, room.created)[0].(map[string]any)["name"]; got != "客厅 的电脑" {
		t.Fatalf("member name = %q", got)
	}
}

func TestCreateRejectsInvalidName(t *testing.T) {
	_, port := startTestServer(t, Options{Port: 0})
	admin := connectClient(t, port)
	caps := adminCaps()
	for _, name := range []string{"   ", "一二三四五六七八九十一二三四五六七"} {
		admin.send(map[string]any{"v": 2, "type": "create", "roomId": newRoomID(t), "caps": caps, "name": name})
		message := admin.mustNext("error", testTimeout)
		if message["code"] != "BAD_MESSAGE" {
			t.Fatalf("name %q: error = %v", name, message)
		}
	}
}

func TestCreateRefusesSecondAdminWhileConnected(t *testing.T) {
	_, port := startTestServer(t, Options{Port: 0})
	room := createTestRoom(t, port, "MacBook · 7K2F")
	rival := connectClient(t, port)
	rival.send(map[string]any{"v": 2, "type": "create", "roomId": room.roomID, "caps": adminCaps(), "name": "rival"})
	message := rival.mustNext("error", testTimeout)
	if message["code"] != "ROOM_CLOSED" {
		t.Fatalf("error = %v", message)
	}
}

func TestCreateAfterAdminLossIsReconnect(t *testing.T) {
	_, port := startTestServer(t, Options{Port: 0})
	room := createTestRoom(t, port, "MacBook · 7K2F")
	member := connectClient(t, port)
	request := requestJoin(t, room.admin, member, room.roomID, nil)
	approveMember(t, room.admin, member, request)

	room.admin.close()
	offlineView := member.mustNext("members", testTimeout)
	adminID := str(t, room.created, "selfId")
	if state := memberByID(t, membersOf(t, offlineView), adminID)["state"]; state != "offline" {
		t.Fatalf("admin state = %v", state)
	}
	member.expectNoMessage("room_closed", 100*time.Millisecond)

	host2 := connectClient(t, port)
	host2.send(map[string]any{"v": 2, "type": "create", "roomId": room.roomID, "caps": adminCaps(), "name": "MacBook · 7K2F"})
	created2 := host2.mustNext("created", testTimeout)
	if str(t, created2, "roomId") != room.roomID {
		t.Fatalf("roomId = %v", created2["roomId"])
	}
	if str(t, created2, "code") != str(t, room.created, "code") {
		t.Fatalf("code was not reused")
	}
	if str(t, created2, "selfId") != adminID {
		t.Fatalf("admin identity changed")
	}
	ids := make([]string, 0, len(membersOf(t, created2)))
	for _, entry := range membersOf(t, created2) {
		ids = append(ids, entry.(map[string]any)["id"].(string))
	}
	if !reflect.DeepEqual(ids, []string{adminID, request["memberId"].(string)}) {
		t.Fatalf("members after reconnect = %v", ids)
	}
	adminView := host2.mustNext("members", testTimeout)
	if state := memberByID(t, membersOf(t, adminView), request["memberId"].(string))["state"]; state != "joined" {
		t.Fatalf("member state = %v", state)
	}
	memberView := member.mustNext("members", testTimeout)
	if state := memberByID(t, membersOf(t, memberView), adminID)["state"]; state != "joined" {
		t.Fatalf("admin state = %v", state)
	}
	member.send(map[string]any{"v": 2, "type": "signal", "to": adminID, "payload": map[string]any{"k": "offer", "sdp": "v=0\r\n"}})
	signal := host2.mustNext("signal", testTimeout)
	if signal["from"] != request["memberId"] {
		t.Fatalf("signal.from = %v", signal["from"])
	}
}

func TestVersionMismatch(t *testing.T) {
	_, port := startTestServer(t, Options{Port: 0})
	// v1 hello.
	stale := connectClient(t, port)
	stale.send(map[string]any{"v": 1, "type": "hello"})
	message := stale.mustNext("error", testTimeout)
	if message["code"] != "VERSION_MISMATCH" || !contains(message["msg"], "刷新") {
		t.Fatalf("error = %v", message)
	}
	info, err := stale.closed(testTimeout)
	if err != nil || info.code != 1008 {
		t.Fatalf("close = %+v, %v", info, err)
	}

	// The gate applies to every type, not just hello/create/join.
	stale = connectClient(t, port)
	stale.send(map[string]any{"v": 1, "type": "heartbeat", "roomId": "x"})
	message = stale.mustNext("error", testTimeout)
	if message["code"] != "VERSION_MISMATCH" {
		t.Fatalf("heartbeat error = %v", message)
	}

	// A malformed v2 message is BAD_MESSAGE, not a version error.
	fresh := connectClient(t, port)
	fresh.send(map[string]any{"v": 2, "type": "heartbeat"})
	message = fresh.mustNext("error", testTimeout)
	if message["code"] != "BAD_MESSAGE" || message["msg"] != "message does not match the protocol" {
		t.Fatalf("error = %v", message)
	}
}

func contains(value any, fragment string) bool {
	text, ok := value.(string)
	return ok && len(text) >= len(fragment) && (text == fragment || indexOf(text, fragment) >= 0)
}

func indexOf(haystack, needle string) int {
	for index := 0; index+len(needle) <= len(haystack); index++ {
		if haystack[index:index+len(needle)] == needle {
			return index
		}
	}
	return -1
}

// --- join / approve / deny --------------------------------------------------

func TestJoinRequestShape(t *testing.T) {
	_, port := startTestServer(t, Options{Port: 0})
	room := createTestRoom(t, port, "MacBook · 7K2F")
	member := connectClient(t, port)
	request := requestJoin(t, room.admin, member, room.roomID, map[string]any{"proof": "proof-value-0123456789"})

	if len(request["memberId"].(string)) != 11 {
		t.Fatalf("memberId = %v", request["memberId"])
	}
	assertCapsEqual(t, request["caps"], memberCaps())
	if request["nonce"] != "member-nonce-0123456789" {
		t.Fatalf("nonce = %v", request["nonce"])
	}
	if request["proof"] != "proof-value-0123456789" {
		t.Fatalf("proof = %v", request["proof"])
	}
	// `join` carries no name: the server seeds one from the caps (iPhone · XXXX).
	name, _ := request["name"].(string)
	if len(name) < len("iPhone · ") || name[:len("iPhone · ")] != "iPhone · " || len([]rune(name)) != len([]rune("iPhone · AB12")) {
		t.Fatalf("default name = %q", name)
	}
	// A pending request is not a member yet: no members broadcast before approval.
	room.admin.expectNoMessage("members", 100*time.Millisecond)
}

func TestApproveSendsJoinOkWithFullMembers(t *testing.T) {
	_, port := startTestServer(t, Options{Port: 0})
	room := createTestRoom(t, port, "MacBook · 7K2F")
	member := connectClient(t, port)
	request := requestJoin(t, room.admin, member, room.roomID, nil)
	joinOk := approveMember(t, room.admin, member, request)

	adminID := str(t, room.created, "selfId")
	if str(t, joinOk, "roomId") != room.roomID || str(t, joinOk, "selfId") != request["memberId"] {
		t.Fatalf("join_ok = %v", joinOk)
	}
	if joinOk["name"] != request["name"] {
		t.Fatalf("join_ok.name = %v, request.name = %v", joinOk["name"], request["name"])
	}
	if token := str(t, joinOk, "rejoinToken"); len(token) != 22 {
		t.Fatalf("rejoinToken = %q", token)
	}
	members := membersOf(t, joinOk)
	if len(members) != 2 {
		t.Fatalf("join_ok.members = %v", members)
	}
	if memberByID(t, members, adminID)["isAdmin"] != true {
		t.Fatalf("admin flag missing")
	}
	entry := memberByID(t, members, request["memberId"].(string))
	if entry["name"] != request["name"] || entry["isAdmin"] != false || entry["state"] != "joined" {
		t.Fatalf("member entry = %v", entry)
	}
	assertCapsEqual(t, entry["caps"], memberCaps())
	room.admin.expectNoMessage("join_ok", 50*time.Millisecond)
}

func TestDenyWithKnownCodeAndFreeText(t *testing.T) {
	_, port := startTestServer(t, Options{Port: 0})
	room := createTestRoom(t, port, "MacBook · 7K2F")

	member := connectClient(t, port)
	request := requestJoin(t, room.admin, member, room.roomID, nil)
	room.admin.send(map[string]any{"v": 2, "type": "deny", "memberId": request["memberId"], "reason": "ROOM_NOT_FOUND"})
	rejected := member.mustNext("join_rejected", testTimeout)
	if rejected["code"] != "ROOM_NOT_FOUND" || rejected["reason"] != "ROOM_NOT_FOUND" {
		t.Fatalf("join_rejected = %v", rejected)
	}
	// The denied member is gone.
	room.admin.send(map[string]any{"v": 2, "type": "signal", "to": request["memberId"], "payload": map[string]any{"k": "offer", "sdp": "v=0"}})
	if errorMessage := room.admin.mustNext("error", testTimeout); errorMessage["code"] != "PEER_GONE" {
		t.Fatalf("error = %v", errorMessage)
	}

	second := connectClient(t, port)
	request2 := requestJoin(t, room.admin, second, room.roomID, nil)
	room.admin.send(map[string]any{"v": 2, "type": "deny", "memberId": request2["memberId"], "reason": "not right now"})
	rejected = second.mustNext("join_rejected", testTimeout)
	if rejected["code"] != "ROOM_CLOSED" || rejected["reason"] != "not right now" {
		t.Fatalf("join_rejected = %v", rejected)
	}
}

func TestJoinUnknownRoom(t *testing.T) {
	_, port := startTestServer(t, Options{Port: 0})
	member := connectClient(t, port)
	member.send(map[string]any{"v": 2, "type": "join", "roomId": newRoomID(t), "caps": memberCaps(), "nonce": "member-nonce-0123456789"})
	if message := member.mustNext("error", testTimeout); message["code"] != "ROOM_NOT_FOUND" {
		t.Fatalf("error = %v", message)
	}
}

func TestRoomFullCountsPendingAndOffline(t *testing.T) {
	_, port := startTestServer(t, Options{Port: 0, MaxMembers: 1})
	room := createTestRoom(t, port, "MacBook · 7K2F")
	first := connectClient(t, port)
	request := requestJoin(t, room.admin, first, room.roomID, nil)

	second := connectClient(t, port)
	second.send(map[string]any{"v": 2, "type": "join", "roomId": room.roomID, "caps": memberCaps(), "nonce": "member-nonce-0123456789"})
	if message := second.mustNext("error", testTimeout); message["code"] != "ROOM_FULL" {
		t.Fatalf("error = %v", message)
	}

	// Denying the pending slot lets someone else in.
	room.admin.send(map[string]any{"v": 2, "type": "deny", "memberId": request["memberId"]})
	first.mustNext("join_rejected", testTimeout)
	third := connectClient(t, port)
	requestJoin(t, room.admin, third, room.roomID, nil)
}

func TestMaxMembersDefaultIsFour(t *testing.T) {
	_, port := startTestServer(t, Options{Port: 0})
	room := createTestRoom(t, port, "MacBook · 7K2F")
	members := make([]*testClient, 0, 4)
	for index := 0; index < 4; index++ {
		member := connectClient(t, port)
		request := requestJoin(t, room.admin, member, room.roomID, nil)
		approveMember(t, room.admin, member, request)
		members = append(members, member)
	}
	fifth := connectClient(t, port)
	fifth.send(map[string]any{"v": 2, "type": "join", "roomId": room.roomID, "caps": memberCaps(), "nonce": "member-nonce-0123456789"})
	if message := fifth.mustNext("error", testTimeout); message["code"] != "ROOM_FULL" {
		t.Fatalf("fifth join error = %v", message)
	}
}

func TestConnectionAlreadyBound(t *testing.T) {
	_, port := startTestServer(t, Options{Port: 0})
	room := createTestRoom(t, port, "MacBook · 7K2F")
	room.admin.send(map[string]any{"v": 2, "type": "create", "roomId": newRoomID(t), "caps": adminCaps(), "name": "again"})
	if message := room.admin.mustNext("error", testTimeout); message["code"] != "BAD_MESSAGE" {
		t.Fatalf("create error = %v", message)
	}
	room.admin.send(map[string]any{"v": 2, "type": "join", "roomId": room.roomID, "caps": memberCaps(), "nonce": "member-nonce-0123456789"})
	if message := room.admin.mustNext("error", testTimeout); message["code"] != "BAD_MESSAGE" {
		t.Fatalf("join error = %v", message)
	}
}

// --- signal -----------------------------------------------------------------

func TestSignalRelaysBothWaysAndStripsFields(t *testing.T) {
	_, port := startTestServer(t, Options{Port: 0})
	pair := joinedPair(t, port)
	adminID := str(t, pair.created, "selfId")
	memberID := pair.request["memberId"].(string)

	pair.admin.send(map[string]any{"v": 2, "type": "signal", "to": memberID, "payload": map[string]any{"k": "offer", "sdp": "v=0", "junk": "must not be relayed"}})
	offer := pair.member.mustNext("signal", testTimeout)
	if offer["from"] != adminID {
		t.Fatalf("signal.from = %v", offer["from"])
	}
	if !reflect.DeepEqual(offer["payload"], map[string]any{"k": "offer", "sdp": "v=0"}) {
		t.Fatalf("payload = %v", offer["payload"])
	}

	pair.member.send(map[string]any{"v": 2, "type": "signal", "to": adminID, "payload": map[string]any{"k": "answer", "sdp": "v=0\r\n"}})
	answer := pair.admin.mustNext("signal", testTimeout)
	if answer["from"] != memberID || !reflect.DeepEqual(answer["payload"], map[string]any{"k": "answer", "sdp": "v=0\r\n"}) {
		t.Fatalf("answer = %v", answer)
	}

	pair.member.send(map[string]any{"v": 2, "type": "signal", "to": adminID, "payload": map[string]any{"k": "candidate", "candidate": map[string]any{"candidate": "candidate:1 1 udp 1 127.0.0.1 5000 typ host", "sdpMid": "0"}}})
	candidate := pair.admin.mustNext("signal", testTimeout)
	want := map[string]any{"k": "candidate", "candidate": map[string]any{"candidate": "candidate:1 1 udp 1 127.0.0.1 5000 typ host", "sdpMid": "0"}}
	if !reflect.DeepEqual(candidate["payload"], want) {
		t.Fatalf("candidate payload = %v", candidate["payload"])
	}
}

func TestSignalBetweenMembers(t *testing.T) {
	_, port := startTestServer(t, Options{Port: 0})
	room := createTestRoom(t, port, "MacBook · 7K2F")
	first := connectClient(t, port)
	firstRequest := requestJoin(t, room.admin, first, room.roomID, nil)
	approveMember(t, room.admin, first, firstRequest)
	second := connectClient(t, port)
	secondRequest := requestJoin(t, room.admin, second, room.roomID, nil)
	approveMember(t, room.admin, second, secondRequest)

	first.send(map[string]any{"v": 2, "type": "signal", "to": secondRequest["memberId"], "payload": map[string]any{"k": "offer", "sdp": "v=0 member-to-member"}})
	relayed := second.mustNext("signal", testTimeout)
	if relayed["from"] != firstRequest["memberId"] {
		t.Fatalf("signal.from = %v", relayed["from"])
	}
	if !reflect.DeepEqual(relayed["payload"], map[string]any{"k": "offer", "sdp": "v=0 member-to-member"}) {
		t.Fatalf("payload = %v", relayed["payload"])
	}

	second.send(map[string]any{"v": 2, "type": "signal", "to": str(t, room.created, "selfId"), "payload": map[string]any{"k": "answer", "sdp": "v=0 to-admin"}})
	if signal := room.admin.mustNext("signal", testTimeout); signal["from"] != secondRequest["memberId"] {
		t.Fatalf("signal.from = %v", signal["from"])
	}
}

func TestSignalUnknownTarget(t *testing.T) {
	_, port := startTestServer(t, Options{Port: 0})
	pair := joinedPair(t, port)
	pair.admin.send(map[string]any{"v": 2, "type": "signal", "to": "no-such-member", "payload": map[string]any{"k": "offer", "sdp": "v=0"}})
	if message := pair.admin.mustNext("error", testTimeout); message["code"] != "PEER_GONE" {
		t.Fatalf("error = %v", message)
	}
}

func TestSignalBeforeApprovalIsRejected(t *testing.T) {
	_, port := startTestServer(t, Options{Port: 0})
	room := createTestRoom(t, port, "MacBook · 7K2F")
	member := connectClient(t, port)
	request := requestJoin(t, room.admin, member, room.roomID, nil)
	member.send(map[string]any{"v": 2, "type": "signal", "to": str(t, room.created, "selfId"), "payload": map[string]any{"k": "answer", "sdp": "v=0"}})
	if message := member.mustNext("error", testTimeout); message["code"] != "PEER_GONE" {
		t.Fatalf("error = %v", message)
	}
	approveMember(t, room.admin, member, request)
}

func TestSignalToOfflineMember(t *testing.T) {
	_, port := startTestServer(t, Options{Port: 0})
	pair := joinedPair(t, port)
	pair.member.close()
	pair.admin.mustNext("members", testTimeout)
	// An offline member cannot be reached.
	pair.admin.send(map[string]any{"v": 2, "type": "signal", "to": pair.request["memberId"], "payload": map[string]any{"k": "offer", "sdp": "v=0"}})
	if message := pair.admin.mustNext("error", testTimeout); message["code"] != "PEER_GONE" {
		t.Fatalf("error = %v", message)
	}
}

func TestSignalToOfflineAdmin(t *testing.T) {
	_, port := startTestServer(t, Options{Port: 0})
	pair := joinedPair(t, port)
	pair.admin.close()
	pair.member.mustNext("members", testTimeout)
	pair.member.send(map[string]any{"v": 2, "type": "signal", "to": str(t, pair.created, "selfId"), "payload": map[string]any{"k": "offer", "sdp": "v=0"}})
	if message := pair.member.mustNext("error", testTimeout); message["code"] != "PEER_GONE" {
		t.Fatalf("error = %v", message)
	}
}

// --- rejoin -----------------------------------------------------------------

func TestMemberRejoinInsideWindow(t *testing.T) {
	_, port := startTestServer(t, Options{Port: 0})
	pair := joinedPair(t, port)
	memberID := pair.request["memberId"].(string)
	token := str(t, pair.joinOk, "rejoinToken")

	pair.member.close()
	offlineView := pair.admin.mustNext("members", testTimeout)
	if state := memberByID(t, membersOf(t, offlineView), memberID)["state"]; state != "offline" {
		t.Fatalf("state = %v", state)
	}
	pair.admin.expectNoMessage("member_left", 80*time.Millisecond)

	back := connectClient(t, port)
	back.send(map[string]any{"v": 2, "type": "join", "roomId": pair.roomID, "caps": memberCaps(), "nonce": "rejoin-nonce-0123456789", "rejoinToken": token})
	joinOk := back.mustNext("join_ok", testTimeout)
	if str(t, joinOk, "selfId") != memberID {
		t.Fatalf("selfId = %v", joinOk["selfId"])
	}
	if joinOk["name"] != pair.joinOk["name"] {
		t.Fatalf("name = %v", joinOk["name"])
	}
	backView := pair.admin.mustNext("members", testTimeout)
	if state := memberByID(t, membersOf(t, backView), memberID)["state"]; state != "joined" {
		t.Fatalf("state = %v", state)
	}
	pair.admin.send(map[string]any{"v": 2, "type": "signal", "to": memberID, "payload": map[string]any{"k": "offer", "sdp": "v=0 after-rejoin"}})
	if signal := back.mustNext("signal", testTimeout); !reflect.DeepEqual(signal["payload"], map[string]any{"k": "offer", "sdp": "v=0 after-rejoin"}) {
		t.Fatalf("payload = %v", signal["payload"])
	}
}

func TestAdminRejoinWithTokenViaJoin(t *testing.T) {
	_, port := startTestServer(t, Options{Port: 0})
	room := createTestRoom(t, port, "MacBook · 7K2F")
	member := connectClient(t, port)
	request := requestJoin(t, room.admin, member, room.roomID, nil)
	token := str(t, room.created, "rejoinToken")
	adminID := str(t, room.created, "selfId")
	room.admin.close()

	admin2 := connectClient(t, port)
	admin2.send(map[string]any{"v": 2, "type": "join", "roomId": room.roomID, "caps": adminCaps(), "nonce": "admin-rejoin-nonce-0123456789", "rejoinToken": token})
	joinOk := admin2.mustNext("join_ok", testTimeout)
	if str(t, joinOk, "selfId") != adminID {
		t.Fatalf("selfId = %v", joinOk["selfId"])
	}
	if memberByID(t, membersOf(t, joinOk), adminID)["isAdmin"] != true {
		t.Fatalf("re-attached admin lost isAdmin")
	}
	// The pending join request is replayed to the re-attached admin.
	replay := admin2.mustNext("join_request", testTimeout)
	if replay["memberId"] != request["memberId"] {
		t.Fatalf("replay = %v", replay)
	}
	admin2.send(map[string]any{"v": 2, "type": "approve", "memberId": request["memberId"]})
	if joinOk := member.mustNext("join_ok", testTimeout); str(t, joinOk, "selfId") != request["memberId"] {
		t.Fatalf("member join_ok = %v", joinOk)
	}
}

func TestUnknownRejoinToken(t *testing.T) {
	_, port := startTestServer(t, Options{Port: 0})
	room := createTestRoom(t, port, "MacBook · 7K2F")
	stale := connectClient(t, port)
	stale.send(map[string]any{"v": 2, "type": "join", "roomId": room.roomID, "caps": memberCaps(), "nonce": "member-nonce-0123456789", "rejoinToken": "not-a-real-token"})
	message := stale.mustNext("error", testTimeout)
	if message["code"] != "ROOM_NOT_FOUND" || message["msg"] != "rejoin token is invalid or expired" {
		t.Fatalf("error = %v", message)
	}
}

func TestOfflineMemberExpiresAfterWindow(t *testing.T) {
	clock := newFakeClock()
	_, port := startTestServer(t, Options{Port: 0, Clock: clock, ReconnectWindow: 60 * time.Second})
	pair := joinedPair(t, port)
	memberID := pair.request["memberId"].(string)

	pair.member.close()
	pair.admin.mustNext("members", testTimeout)
	clock.Advance(60*time.Second + time.Millisecond)

	left := pair.admin.mustNext("member_left", testTimeout)
	if left["memberId"] != memberID {
		t.Fatalf("member_left = %v", left)
	}
	afterExpiry := pair.admin.mustNext("members", testTimeout)
	for _, entry := range membersOf(t, afterExpiry) {
		if entry.(map[string]any)["id"] == memberID {
			t.Fatalf("expired member is still listed")
		}
	}
	// The freed slot accepts a new join request.
	late := connectClient(t, port)
	lateRequest := requestJoin(t, pair.admin, late, pair.roomID, nil)
	if lateRequest["memberId"] == memberID {
		t.Fatalf("member id was reused")
	}
}

// --- profile ----------------------------------------------------------------

func TestProfileBroadcastsRename(t *testing.T) {
	_, port := startTestServer(t, Options{Port: 0})
	pair := joinedPair(t, port)
	memberID := pair.request["memberId"].(string)

	pair.member.send(map[string]any{"v": 2, "type": "profile", "name": "客厅的电脑"})
	adminView := pair.admin.mustNext("members", testTimeout)
	memberView := pair.member.mustNext("members", testTimeout)
	if name := memberByID(t, membersOf(t, adminView), memberID)["name"]; name != "客厅的电脑" {
		t.Fatalf("admin view name = %v", name)
	}
	if name := memberByID(t, membersOf(t, memberView), memberID)["name"]; name != "客厅的电脑" {
		t.Fatalf("member view name = %v", name)
	}

	pair.admin.send(map[string]any{"v": 2, "type": "profile", "name": "书房电脑"})
	renamed := pair.member.mustNext("members", testTimeout)
	first := membersOf(t, renamed)[0].(map[string]any)
	if first["isAdmin"] != true || first["name"] != "书房电脑" {
		t.Fatalf("admin entry = %v", first)
	}
}

func TestProfileRejectsInvalidName(t *testing.T) {
	_, port := startTestServer(t, Options{Port: 0})
	pair := joinedPair(t, port)
	pair.member.send(map[string]any{"v": 2, "type": "profile", "name": "   "})
	if message := pair.member.mustNext("error", testTimeout); message["code"] != "BAD_MESSAGE" {
		t.Fatalf("error = %v", message)
	}
}

func TestProfileRateLimitPerConnection(t *testing.T) {
	clock := newFakeClock()
	_, port := startTestServer(t, Options{Port: 0, Clock: clock})
	pair := joinedPair(t, port)
	for index := 0; index < 10; index++ {
		pair.member.send(map[string]any{"v": 2, "type": "profile", "name": "名称" + itoa(index)})
		pair.member.mustNext("members", testTimeout)
	}
	pair.member.send(map[string]any{"v": 2, "type": "profile", "name": "太快了"})
	if message := pair.member.mustNext("error", testTimeout); message["code"] != "RATE_LIMITED" {
		t.Fatalf("error = %v", message)
	}
	// A fresh window resets the per-connection budget.
	clock.Advance(60*time.Second + time.Millisecond)
	pair.member.send(map[string]any{"v": 2, "type": "profile", "name": "又行了"})
	pair.member.mustNext("members", testTimeout)
}

func TestProfileRateLimitWithEpochZeroClock(t *testing.T) {
	// Regression: an injected clock reading 0 must still start the 10/60 s window
	// (a zero-value sentinel used to disable the budget forever).
	clock := newFakeClockAt(time.Unix(0, 0))
	_, port := startTestServer(t, Options{Port: 0, Clock: clock})
	pair := joinedPair(t, port)
	for index := 0; index < 10; index++ {
		pair.member.send(map[string]any{"v": 2, "type": "profile", "name": "名称" + itoa(index)})
		pair.member.mustNext("members", testTimeout)
	}
	pair.member.send(map[string]any{"v": 2, "type": "profile", "name": "太快了"})
	if message := pair.member.mustNext("error", testTimeout); message["code"] != "RATE_LIMITED" {
		t.Fatalf("error = %v", message)
	}
}

func TestProfileBeforeApproval(t *testing.T) {
	_, port := startTestServer(t, Options{Port: 0})
	room := createTestRoom(t, port, "MacBook · 7K2F")
	member := connectClient(t, port)
	requestJoin(t, room.admin, member, room.roomID, nil)
	member.send(map[string]any{"v": 2, "type": "profile", "name": "太早了"})
	if message := member.mustNext("error", testTimeout); message["code"] != "PEER_GONE" {
		t.Fatalf("error = %v", message)
	}
}

func TestProfileDedupeAndRenumber(t *testing.T) {
	_, port := startTestServer(t, Options{Port: 0})
	room := createTestRoom(t, port, "同名")
	first := connectClient(t, port)
	firstRequest := requestJoin(t, room.admin, first, room.roomID, nil)
	approveMember(t, room.admin, first, firstRequest)
	first.send(map[string]any{"v": 2, "type": "profile", "name": "同名"})
	firstView := room.admin.mustNext("members", testTimeout)
	if name := memberByID(t, membersOf(t, firstView), firstRequest["memberId"].(string))["name"]; name != "同名-2" {
		t.Fatalf("first member name = %v", name)
	}

	second := connectClient(t, port)
	secondRequest := requestJoin(t, room.admin, second, room.roomID, nil)
	approveMember(t, room.admin, second, secondRequest)
	second.send(map[string]any{"v": 2, "type": "profile", "name": "同名"})
	secondView := room.admin.mustNext("members", testTimeout)
	if name := memberByID(t, membersOf(t, secondView), secondRequest["memberId"].(string))["name"]; name != "同名-3" {
		t.Fatalf("second member name = %v", name)
	}
	if name := membersOf(t, secondView)[0].(map[string]any)["name"]; name != "同名" {
		t.Fatalf("admin name = %v", name)
	}

	room.admin.send(map[string]any{"v": 2, "type": "remove", "memberId": firstRequest["memberId"]})
	afterRemoval := room.admin.mustNext("members", testTimeout)
	if name := memberByID(t, membersOf(t, afterRemoval), secondRequest["memberId"].(string))["name"]; name != "同名-2" {
		t.Fatalf("renumbered name = %v", name)
	}
}

// --- remove / close ---------------------------------------------------------

func TestRemoveMember(t *testing.T) {
	_, port := startTestServer(t, Options{Port: 0})
	pair := joinedPair(t, port)
	memberID := pair.request["memberId"].(string)

	pair.admin.send(map[string]any{"v": 2, "type": "remove", "memberId": memberID})
	closed := pair.member.mustNext("room_closed", testTimeout)
	if closed["reason"] != "error" {
		t.Fatalf("room_closed = %v", closed)
	}
	info, err := pair.member.closed(testTimeout)
	if err != nil || info.code != 1000 {
		t.Fatalf("close = %+v, %v", info, err)
	}
	left := pair.admin.mustNext("member_left", testTimeout)
	if left["memberId"] != memberID {
		t.Fatalf("member_left = %v", left)
	}
	view := pair.admin.mustNext("members", testTimeout)
	for _, entry := range membersOf(t, view) {
		if entry.(map[string]any)["id"] == memberID {
			t.Fatalf("removed member is still listed")
		}
	}
	// The room itself is still alive.
	nextMember := connectClient(t, port)
	requestJoin(t, pair.admin, nextMember, pair.roomID, nil)
}

func TestAdminOnlyOperations(t *testing.T) {
	_, port := startTestServer(t, Options{Port: 0})
	pair := joinedPair(t, port)
	operations := []map[string]any{
		{"v": 2, "type": "approve", "memberId": "someone"},
		{"v": 2, "type": "deny", "memberId": "someone"},
		{"v": 2, "type": "remove", "memberId": "someone"},
		{"v": 2, "type": "close", "roomId": pair.roomID},
	}
	for _, operation := range operations {
		pair.member.send(operation)
		if message := pair.member.mustNext("error", testTimeout); message["code"] != "NOT_ADMIN" {
			t.Fatalf("%v: error = %v", operation["type"], message)
		}
	}
	// The room is untouched.
	pair.member.send(map[string]any{"v": 2, "type": "signal", "to": str(t, pair.created, "selfId"), "payload": map[string]any{"k": "offer", "sdp": "v=0"}})
	if signal := pair.admin.mustNext("signal", testTimeout); signal["from"] != pair.request["memberId"] {
		t.Fatalf("signal.from = %v", signal["from"])
	}
}

func TestCloseRoomDestroysIt(t *testing.T) {
	_, port := startTestServer(t, Options{Port: 0})
	pair := joinedPair(t, port)
	pair.admin.send(map[string]any{"v": 2, "type": "close", "roomId": pair.roomID})
	closed := pair.member.mustNext("room_closed", testTimeout)
	if closed["reason"] != "admin_close" {
		t.Fatalf("room_closed = %v", closed)
	}
	if _, err := pair.member.closed(testTimeout); err != nil {
		t.Fatalf("member close: %v", err)
	}
	// The admin socket stays open and can create a new room.
	pair.admin.send(map[string]any{"v": 2, "type": "create", "roomId": newRoomID(t), "caps": adminCaps(), "name": "新房间"})
	pair.admin.mustNext("created", testTimeout)

	late := connectClient(t, port)
	late.send(map[string]any{"v": 2, "type": "join", "roomId": pair.roomID, "caps": memberCaps(), "nonce": "member-nonce-0123456789"})
	if message := late.mustNext("error", testTimeout); message["code"] != "ROOM_NOT_FOUND" {
		t.Fatalf("late join error = %v", message)
	}
}

func TestPendingJoinDroppedSilently(t *testing.T) {
	_, port := startTestServer(t, Options{Port: 0})
	room := createTestRoom(t, port, "MacBook · 7K2F")
	member := connectClient(t, port)
	requestJoin(t, room.admin, member, room.roomID, nil)
	member.close()
	time.Sleep(50 * time.Millisecond)
	room.admin.expectNoMessage("members", 100*time.Millisecond)
	late := connectClient(t, port)
	requestJoin(t, room.admin, late, room.roomID, nil)
}

// --- six digit code ---------------------------------------------------------

func TestShortCodeMapsAndIsSingleUse(t *testing.T) {
	_, port := startTestServer(t, Options{Port: 0})
	room := createTestRoom(t, port, "MacBook · 7K2F")
	code := str(t, room.created, "code")

	first := connectClient(t, port)
	request := requestJoin(t, room.admin, first, code, map[string]any{"proof": nil})
	if _, present := request["proof"]; present {
		t.Fatalf("join_request should not carry a proof: %v", request)
	}
	approveMember(t, room.admin, first, request)

	second := connectClient(t, port)
	second.send(map[string]any{"v": 2, "type": "join", "roomId": code, "caps": memberCaps(), "nonce": "member-nonce-0123456789"})
	message := second.mustNext("error", testTimeout)
	if message["code"] != "ROOM_NOT_FOUND" || message["msg"] != "join code is invalid or expired" {
		t.Fatalf("error = %v", message)
	}
}

func TestShortCodeExpiresAfterTenMinutes(t *testing.T) {
	clock := newFakeClock()
	_, port := startTestServer(t, Options{Port: 0, Clock: clock})
	room := createTestRoom(t, port, "MacBook · 7K2F")
	code := str(t, room.created, "code")
	clock.Advance(10*time.Minute + time.Millisecond)

	member := connectClient(t, port)
	member.send(map[string]any{"v": 2, "type": "join", "roomId": code, "caps": memberCaps(), "nonce": "member-nonce-0123456789"})
	if message := member.mustNext("error", testTimeout); message["code"] != "ROOM_NOT_FOUND" {
		t.Fatalf("error = %v", message)
	}
}

// --- heartbeat / TTL --------------------------------------------------------

func TestIdleRoomExpires(t *testing.T) {
	_, port := startTestServer(t, Options{Port: 0, RoomTTL: 100 * time.Millisecond})
	pair := joinedPair(t, port)

	memberClosed := pair.member.mustNext("room_closed", testTimeout)
	if memberClosed["reason"] != "ttl" {
		t.Fatalf("member room_closed = %v", memberClosed)
	}
	adminClosed := pair.admin.mustNext("room_closed", testTimeout)
	if adminClosed["reason"] != "ttl" {
		t.Fatalf("admin room_closed = %v", adminClosed)
	}
	late := connectClient(t, port)
	late.send(map[string]any{"v": 2, "type": "join", "roomId": pair.roomID, "caps": memberCaps(), "nonce": "member-nonce-0123456789"})
	if message := late.mustNext("error", testTimeout); message["code"] != "ROOM_NOT_FOUND" {
		t.Fatalf("late join error = %v", message)
	}
}

func TestAdminHeartbeatExtendsRoom(t *testing.T) {
	_, port := startTestServer(t, Options{Port: 0, RoomTTL: 150 * time.Millisecond})
	room := createTestRoom(t, port, "MacBook · 7K2F")
	for index := 0; index < 5; index++ {
		room.admin.send(map[string]any{"v": 2, "type": "heartbeat", "roomId": room.roomID})
		time.Sleep(40 * time.Millisecond)
	}
	// 200 ms elapsed with a 150 ms TTL: the heartbeats kept the room alive.
	room.admin.expectNoMessage("room_closed", 100*time.Millisecond)
}

func TestMemberHeartbeatIgnored(t *testing.T) {
	_, port := startTestServer(t, Options{Port: 0, RoomTTL: 120 * time.Millisecond})
	pair := joinedPair(t, port)
	for index := 0; index < 5; index++ {
		pair.member.trySend(map[string]any{"v": 2, "type": "heartbeat", "roomId": pair.roomID})
		time.Sleep(40 * time.Millisecond)
	}
	adminClosed := pair.admin.mustNext("room_closed", testTimeout)
	if adminClosed["reason"] != "ttl" {
		t.Fatalf("admin room_closed = %v", adminClosed)
	}
	pair.member.mustNext("room_closed", testTimeout)
}

// --- robustness -------------------------------------------------------------

func TestBadMessageKeepsConnectionUsable(t *testing.T) {
	_, port := startTestServer(t, Options{Port: 0})
	client := connectClient(t, port)
	client.send(map[string]any{"v": 2, "type": "hello"})
	client.send(map[string]any{"v": 2, "type": "not-a-message"})
	message := client.mustNext("error", testTimeout)
	if message["code"] != "BAD_MESSAGE" || message["msg"] != "message does not match the protocol" {
		t.Fatalf("error = %v", message)
	}
	client.send(map[string]any{"v": 2, "type": "hello"})
	client.expectNoMessage("error", 80*time.Millisecond)
}

func TestRepeatedMalformedFramesCloseConnection(t *testing.T) {
	_, port := startTestServer(t, Options{Port: 0})
	client := connectClient(t, port)
	client.trySend("not json at all")
	for index := 0; index < 5; index++ {
		client.trySend(map[string]any{"v": 2, "type": "broken", "index": index})
	}
	info, err := client.closed(testTimeout)
	if err != nil || info.code != 1008 {
		t.Fatalf("close = %+v, %v", info, err)
	}
}

func TestOversizedFrameClosesWith1009(t *testing.T) {
	_, port := startTestServer(t, Options{Port: 0})
	client := connectClient(t, port)
	client.trySend(string(make([]byte, 70*1024)))
	info, err := client.closed(testTimeout)
	if err != nil || info.code != 1009 {
		t.Fatalf("close = %+v, %v", info, err)
	}
}

func TestPerIPRateLimit(t *testing.T) {
	_, port := startTestServer(t, Options{Port: 0, RateLimit: RateLimitPolicy{WindowMs: 60_000, Max: 3}})
	client := connectClient(t, port)
	for index := 0; index < 3; index++ {
		client.send(map[string]any{"v": 2, "type": "hello"})
	}
	client.send(map[string]any{"v": 2, "type": "hello"})
	message := client.mustNext("error", testTimeout)
	if message["code"] != "RATE_LIMITED" || message["msg"] != "too many signaling messages" {
		t.Fatalf("error = %v", message)
	}
	info, err := client.closed(testTimeout)
	if err != nil || info.code != 1008 {
		t.Fatalf("close = %+v, %v", info, err)
	}
}

// --- TURN credentials -------------------------------------------------------

func TestTurnCredentialsIssuedPerMember(t *testing.T) {
	secret := "static-auth-secret-for-tests"
	uris := []string{"turn:turn.example.org:3478?transport=udp", "turns:turn.example.org:5349"}
	ttl := 600
	_, port := startTestServer(t, Options{Port: 0, TURN: &TurnOptions{URIs: uris, Secret: secret, TTL: ttl}})
	room := createTestRoom(t, port, "MacBook · 7K2F")

	credential, ok := room.created["turn"].(map[string]any)
	if !ok {
		t.Fatalf("created.turn missing: %v", room.created)
	}
	assertTurnCredential(t, credential, secret, str(t, room.created, "selfId"), ttl, uris)

	member := connectClient(t, port)
	request := requestJoin(t, room.admin, member, room.roomID, nil)
	joinOk := approveMember(t, room.admin, member, request)
	memberCredential, ok := joinOk["turn"].(map[string]any)
	if !ok {
		t.Fatalf("join_ok.turn missing: %v", joinOk)
	}
	assertTurnCredential(t, memberCredential, secret, request["memberId"].(string), ttl, uris)
}

func assertTurnCredential(t *testing.T, credential map[string]any, secret, memberID string, ttl int, uris []string) {
	t.Helper()
	if credential["ttl"] != float64(ttl) {
		t.Fatalf("ttl = %v", credential["ttl"])
	}
	gotURIs, _ := credential["uris"].([]any)
	if len(gotURIs) != len(uris) {
		t.Fatalf("uris = %v", credential["uris"])
	}
	for index, uri := range uris {
		if gotURIs[index] != uri {
			t.Fatalf("uris[%d] = %v, want %v", index, gotURIs[index], uri)
		}
	}
	username := str(t, credential, "username")
	nowSeconds := time.Now().Unix()
	expiry, ok := parseExpiry(username)
	if !ok || expiry < nowSeconds+int64(ttl)-2 || expiry > nowSeconds+int64(ttl)+2 {
		t.Fatalf("username expiry = %v (now %d, ttl %d)", username, nowSeconds, ttl)
	}
	if !hasSuffix(username, ":"+memberID) {
		t.Fatalf("username = %q, want suffix :%s", username, memberID)
	}
	// Recompute from the same username so the HMAC comparison is exact.
	recomputed := hmacSHA1Base64(secret, username)
	if credential["credential"] != recomputed {
		t.Fatalf("credential = %v, want %v", credential["credential"], recomputed)
	}
}

func parseExpiry(username string) (int64, bool) {
	index := indexOf(username, ":")
	if index <= 0 {
		return 0, false
	}
	var value int64
	for _, char := range username[:index] {
		if char < '0' || char > '9' {
			return 0, false
		}
		value = value*10 + int64(char-'0')
	}
	return value, true
}

func hasSuffix(text, suffix string) bool {
	return len(text) >= len(suffix) && text[len(text)-len(suffix):] == suffix
}

func TestRecoverConnHandlesPanic(t *testing.T) {
	server := NewServer(Options{Port: 0})
	c := &conn{}
	func() {
		defer server.recoverConn(c, "test")
		panic("boom")
	}()
	if !c.closed.Load() {
		t.Fatalf("recovered panic did not close the connection")
	}
}

// --- lifecycle --------------------------------------------------------------

func TestGracefulShutdownReleasesEverything(t *testing.T) {
	server, port := startTestServer(t, Options{Port: 0})
	client := connectClient(t, port)
	client.send(map[string]any{"v": 2, "type": "hello"})

	start := time.Now()
	if err := server.Stop(); err != nil {
		t.Fatalf("stop: %v", err)
	}
	if elapsed := time.Since(start); elapsed > 3*time.Second {
		t.Fatalf("stop took %v", elapsed)
	}
	// The listener is gone.
	if _, err := httpGetRaw(port); err == nil {
		t.Fatalf("server still accepts connections after stop")
	}
	// Stop is idempotent.
	if err := server.Stop(); err != nil {
		t.Fatalf("second stop: %v", err)
	}
}

func httpGetRaw(port int) (int, error) {
	client := &http.Client{Timeout: 500 * time.Millisecond}
	response, err := client.Get("http://127.0.0.1:" + itoa(port) + "/")
	if err != nil {
		return 0, err
	}
	_ = response.Body.Close()
	return response.StatusCode, nil
}
