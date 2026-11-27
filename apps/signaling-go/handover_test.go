package main

// Phase 2 (ADR 0010 D24): admin handover. When the admin socket stays gone for
// the whole reconnect window, the earliest-joined member that is still joined
// and reachable is promoted to admin; the room keeps its six digit code and the
// old admin identity (including its rejoinToken) is dropped.

import (
	"testing"
	"time"
)

type handoverFixture struct {
	server           *Server
	port             int
	clock            *fakeClock
	admin            *testClient
	first            *testClient // earliest joined member: the first handover target
	second           *testClient
	roomID           string
	code             string
	adminID          string
	firstID          string
	secondID         string
	token            string // the old admin's rejoinToken
	firstMemberToken string // the first member's rejoinToken before promotion
}

func newHandoverFixture(t *testing.T) *handoverFixture {
	t.Helper()
	clock := newFakeClock()
	server, port := startTestServer(t, Options{Port: 0, Clock: clock, ReconnectWindow: 60 * time.Second})
	room := createTestRoom(t, port, "MacBook · 7K2F")
	first := connectClient(t, port)
	firstRequest := requestJoin(t, room.admin, first, room.roomID, nil)
	firstJoinOk := approveMember(t, room.admin, first, firstRequest)
	second := connectClient(t, port)
	secondRequest := requestJoin(t, room.admin, second, room.roomID, nil)
	approveMember(t, room.admin, second, secondRequest)
	fixture := &handoverFixture{
		server:           server,
		port:             port,
		clock:            clock,
		admin:            room.admin,
		first:            first,
		second:           second,
		roomID:           room.roomID,
		code:             str(t, room.created, "code"),
		adminID:          str(t, room.created, "selfId"),
		firstID:          firstRequest["memberId"].(string),
		secondID:         secondRequest["memberId"].(string),
		token:            str(t, room.created, "rejoinToken"),
		firstMemberToken: str(t, firstJoinOk, "rejoinToken"),
	}
	fixture.drain()
	return fixture
}

func (f *handoverFixture) drain() {
	f.admin.drain()
	f.first.drain()
	f.second.drain()
}

// handOver drops the admin socket and advances the reconnect window past the
// handover timer, returning the `members` snapshot the new admin received.
func (f *handoverFixture) handOver(t *testing.T) map[string]any {
	t.Helper()
	f.drain()
	f.admin.close()
	waitForMemberState(t, f.first, f.adminID, "offline")
	f.second.drain()
	f.clock.Advance(60*time.Second + time.Millisecond)
	// The promoted client first receives `created` (code + fresh rejoinToken),
	// then the members broadcast.
	f.first.mustNext("created", testTimeout)
	return f.first.mustNext("members", testTimeout)
}

// expectNoHandover reads members broadcasts for a window and fails only if one
// of them shows the first member promoted (earlier snapshots may still be in
// flight, so plain "no message" would be flaky).
func expectNoHandover(t *testing.T, client *testClient, firstID string, window time.Duration) {
	t.Helper()
	deadline := time.Now().Add(window)
	for {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return
		}
		message, err := client.next("members", remaining)
		if err != nil {
			return
		}
		if member, ok := findMember(membersOf(t, message), firstID); ok && member["isAdmin"] == true {
			t.Fatalf("unexpected handover: %v", message)
		}
	}
}

func assertNoMember(t *testing.T, members []any, id string) {
	t.Helper()
	for _, entry := range members {
		if entry.(map[string]any)["id"] == id {
			t.Fatalf("member %s is still in the snapshot: %v", id, members)
		}
	}
}

func TestHandoverPromotesEarliestOnlineMember(t *testing.T) {
	fixture := newHandoverFixture(t)
	pending := connectClient(t, fixture.port)
	pendingRequest := requestJoin(t, fixture.admin, pending, fixture.roomID, nil)
	fixture.drain()

	view := fixture.handOver(t)
	members := membersOf(t, view)
	if len(members) != 2 {
		t.Fatalf("members after handover = %v, want new admin + one member (pending excluded)", members)
	}
	if memberByID(t, members, fixture.firstID)["isAdmin"] != true {
		t.Fatalf("earliest member was not promoted: %v", members)
	}
	if memberByID(t, members, fixture.secondID)["isAdmin"] != false {
		t.Fatalf("second member should stay a member: %v", members)
	}
	assertNoMember(t, members, fixture.adminID)
	// New admin first, then the remaining members in join order.
	if members[0].(map[string]any)["id"] != fixture.firstID {
		t.Fatalf("admin is not first in the snapshot: %v", members)
	}

	// The pending join_request is replayed to the new admin.
	replay := fixture.first.mustNext("join_request", testTimeout)
	if replay["memberId"] != pendingRequest["memberId"] {
		t.Fatalf("replayed join_request = %v", replay)
	}
	// New admin has full admin powers: approve.
	approveMember(t, fixture.first, pending, replay)

	// ... deny.
	pending2 := connectClient(t, fixture.port)
	pending2Request := requestJoin(t, fixture.first, pending2, fixture.roomID, nil)
	fixture.first.send(map[string]any{"v": 2, "type": "deny", "memberId": pending2Request["memberId"]})
	if rejected := pending2.mustNext("join_rejected", testTimeout); rejected["code"] != "ROOM_CLOSED" {
		t.Fatalf("join_rejected = %v", rejected)
	}

	// ... remove.
	fixture.first.send(map[string]any{"v": 2, "type": "remove", "memberId": pendingRequest["memberId"]})
	if closed := pending.mustNext("room_closed", testTimeout); closed["reason"] != "error" {
		t.Fatalf("room_closed = %v", closed)
	}
	if left := fixture.first.mustNext("member_left", testTimeout); left["memberId"] != pendingRequest["memberId"] {
		t.Fatalf("member_left = %v", left)
	}

	// The six digit code is reused: a code join reaches the new admin.
	late := connectClient(t, fixture.port)
	lateRequest := requestJoin(t, fixture.first, late, fixture.code, map[string]any{"proof": nil})
	approveMember(t, fixture.first, late, lateRequest)

	room := roomSnapshot(t, fixture.server, fixture.roomID)
	if room.AdminID != fixture.firstID {
		t.Fatalf("room admin = %q, want %q", room.AdminID, fixture.firstID)
	}
	if room.Code != fixture.code {
		t.Fatalf("room code changed on handover: %q", room.Code)
	}
	if room.AdminOffline {
		t.Fatalf("room still marked adminOffline after handover")
	}
}

func TestHandoverSendsCreatedToNewAdmin(t *testing.T) {
	fixture := newHandoverFixture(t)
	pending := connectClient(t, fixture.port)
	pendingRequest := requestJoin(t, fixture.admin, pending, fixture.roomID, nil)
	fixture.drain()

	fixture.admin.close()
	waitForMemberState(t, fixture.first, fixture.adminID, "offline")
	fixture.second.drain()
	fixture.clock.Advance(60*time.Second + time.Millisecond)

	// Ordering: created (admin attach) -> members -> replayed join_request.
	firstMessage, err := fixture.first.nextAny(testTimeout)
	if err != nil {
		t.Fatalf("first handover message: %v", err)
	}
	if firstMessage["type"] != "created" {
		t.Fatalf("first handover message = %v, want created", firstMessage)
	}
	if str(t, firstMessage, "roomId") != fixture.roomID {
		t.Fatalf("created.roomId = %v", firstMessage["roomId"])
	}
	if str(t, firstMessage, "code") != fixture.code {
		t.Fatalf("created.code = %v, want unchanged %q", firstMessage["code"], fixture.code)
	}
	if str(t, firstMessage, "selfId") != fixture.firstID {
		t.Fatalf("created.selfId = %v", firstMessage["selfId"])
	}
	token := str(t, firstMessage, "rejoinToken")
	if len(token) != 22 {
		t.Fatalf("created.rejoinToken = %q", token)
	}
	if token == fixture.token || token == fixture.firstMemberToken {
		t.Fatalf("rejoinToken was not rotated on handover")
	}
	members := membersOf(t, firstMessage)
	if memberByID(t, members, fixture.firstID)["isAdmin"] != true {
		t.Fatalf("created.members missing the promoted admin: %v", members)
	}
	assertNoMember(t, members, fixture.adminID)

	secondMessage, err := fixture.first.nextAny(testTimeout)
	if err != nil || secondMessage["type"] != "members" {
		t.Fatalf("second handover message = %v, %v; want members", secondMessage, err)
	}
	thirdMessage, err := fixture.first.nextAny(testTimeout)
	if err != nil || thirdMessage["type"] != "join_request" || thirdMessage["memberId"] != pendingRequest["memberId"] {
		t.Fatalf("third handover message = %v, %v; want replayed join_request", thirdMessage, err)
	}
	approveMember(t, fixture.first, pending, thirdMessage)

	// The fresh admin rejoinToken works: after the new admin's socket drops, a
	// join with it re-attaches as admin instead of triggering another handover.
	fixture.first.close()
	waitForMemberState(t, fixture.second, fixture.firstID, "offline")
	admin2 := connectClient(t, fixture.port)
	admin2.send(map[string]any{
		"v": 2, "type": "join", "roomId": fixture.roomID, "caps": adminCaps(),
		"nonce": "admin-rejoin-nonce-0123456789", "rejoinToken": token,
	})
	joinOk := admin2.mustNext("join_ok", testTimeout)
	if str(t, joinOk, "selfId") != fixture.firstID {
		t.Fatalf("rejoined admin selfId = %v", joinOk["selfId"])
	}
	newMember := connectClient(t, fixture.port)
	requestJoin(t, admin2, newMember, fixture.roomID, nil)
}

func TestHandoverNewAdminHeartbeatRenewsRoom(t *testing.T) {
	fixture := newHandoverFixture(t)
	fixture.handOver(t)
	fixture.drain()

	fixture.first.send(map[string]any{"v": 2, "type": "heartbeat", "roomId": fixture.roomID})
	expected := nowMillis(fixture.clock)
	waitForRoom(t, fixture.server, fixture.roomID, testTimeout, func(room *Room) bool {
		return room.LastActivity == expected
	})

	// 29 minutes after the heartbeat the room is still alive (TTL is 30 min).
	fixture.clock.Advance(28 * time.Minute)
	fixture.server.sweep()
	fixture.second.expectNoMessage("room_closed", 100*time.Millisecond)

	// Past the TTL it expires for everyone.
	fixture.clock.Advance(3 * time.Minute)
	fixture.server.sweep()
	closed := fixture.second.mustNext("room_closed", testTimeout)
	if closed["reason"] != "ttl" {
		t.Fatalf("room_closed = %v", closed)
	}
	late := connectClient(t, fixture.port)
	late.send(map[string]any{"v": 2, "type": "join", "roomId": fixture.roomID, "caps": memberCaps(), "nonce": "member-nonce-0123456789"})
	if message := late.mustNext("error", testTimeout); message["code"] != "ROOM_NOT_FOUND" {
		t.Fatalf("late join error = %v", message)
	}
}

func TestHandoverNewAdminCanCloseRoom(t *testing.T) {
	fixture := newHandoverFixture(t)
	fixture.handOver(t)
	fixture.drain()

	fixture.first.send(map[string]any{"v": 2, "type": "close", "roomId": fixture.roomID})
	if closed := fixture.second.mustNext("room_closed", testTimeout); closed["reason"] != "admin_close" {
		t.Fatalf("room_closed = %v", closed)
	}
	late := connectClient(t, fixture.port)
	late.send(map[string]any{"v": 2, "type": "join", "roomId": fixture.roomID, "caps": memberCaps(), "nonce": "member-nonce-0123456789"})
	if message := late.mustNext("error", testTimeout); message["code"] != "ROOM_NOT_FOUND" {
		t.Fatalf("late join error = %v", message)
	}
	// The new admin socket stays open and can create a fresh room.
	fixture.first.send(map[string]any{"v": 2, "type": "create", "roomId": newRoomID(t), "caps": adminCaps(), "name": "新房间"})
	fixture.first.mustNext("created", testTimeout)
}

func TestHandoverCancelledByCreateBeforeExpiry(t *testing.T) {
	fixture := newHandoverFixture(t)
	fixture.drain()
	fixture.admin.close()
	fixture.first.mustNext("members", testTimeout) // admin offline broadcast
	fixture.second.drain()

	// Reconnect with `create` on the same roomId before the window elapses.
	admin2 := connectClient(t, fixture.port)
	admin2.send(map[string]any{"v": 2, "type": "create", "roomId": fixture.roomID, "caps": adminCaps(), "name": "MacBook · 7K2F"})
	created := admin2.mustNext("created", testTimeout)
	if str(t, created, "selfId") != fixture.adminID {
		t.Fatalf("reconnected admin selfId = %v", created["selfId"])
	}
	// The handover timer was cancelled: no promotion after the window.
	fixture.clock.Advance(60*time.Second + time.Millisecond)
	expectNoHandover(t, fixture.first, fixture.firstID, 150*time.Millisecond)

	// admin2 is still the admin: a new join request goes to it, not to first.
	newMember := connectClient(t, fixture.port)
	requestJoin(t, admin2, newMember, fixture.roomID, nil)
	fixture.first.expectNoMessage("join_request", 50*time.Millisecond)
}

func TestHandoverCancelledByTokenRejoinBeforeExpiry(t *testing.T) {
	fixture := newHandoverFixture(t)
	fixture.drain()
	fixture.admin.close()
	fixture.first.mustNext("members", testTimeout)
	fixture.second.drain()

	admin2 := connectClient(t, fixture.port)
	admin2.send(map[string]any{
		"v": 2, "type": "join", "roomId": fixture.roomID, "caps": adminCaps(),
		"nonce": "admin-rejoin-nonce-0123456789", "rejoinToken": fixture.token,
	})
	joinOk := admin2.mustNext("join_ok", testTimeout)
	if str(t, joinOk, "selfId") != fixture.adminID {
		t.Fatalf("rejoined admin selfId = %v", joinOk["selfId"])
	}
	fixture.clock.Advance(60*time.Second + time.Millisecond)
	expectNoHandover(t, fixture.first, fixture.firstID, 150*time.Millisecond)
	newMember := connectClient(t, fixture.port)
	requestJoin(t, admin2, newMember, fixture.roomID, nil)
}

func TestHandoverSkippedWithoutOnlineMember(t *testing.T) {
	clock := newFakeClock()
	server, port := startTestServer(t, Options{Port: 0, Clock: clock, ReconnectWindow: 60 * time.Second})
	room := createTestRoom(t, port, "MacBook · 7K2F")
	adminID := str(t, room.created, "selfId")
	member := connectClient(t, port)
	memberRequest := requestJoin(t, room.admin, member, room.roomID, nil)
	approveMember(t, room.admin, member, memberRequest)
	room.admin.drain()

	// The only member goes offline, then the admin does too: no online member.
	member.close()
	waitForMemberState(t, room.admin, memberRequest["memberId"].(string), "offline")
	room.admin.close()
	// Wait until the admin socket loss is processed (it starts the timer).
	waitForRoom(t, server, room.roomID, testTimeout, func(room *Room) bool {
		return room.adminConn == nil && room.AdminOffline
	})
	clock.Advance(60*time.Second + time.Millisecond)

	snapshot := roomSnapshot(t, server, room.roomID)
	if snapshot.AdminID != adminID || !snapshot.AdminOffline || snapshot.AdminConnected {
		t.Fatalf("room changed without an eligible member: %+v", snapshot)
	}
	if snapshot.Members != 0 {
		t.Fatalf("expired offline member still counted: %+v", snapshot)
	}

	// The room survives to the TTL: the old admin can re-attach with `create`.
	admin2 := connectClient(t, port)
	admin2.send(map[string]any{"v": 2, "type": "create", "roomId": room.roomID, "caps": adminCaps(), "name": "MacBook · 7K2F"})
	created := admin2.mustNext("created", testTimeout)
	if str(t, created, "selfId") != adminID {
		t.Fatalf("reattached admin selfId = %v", created["selfId"])
	}
}

func TestHandoverSkippedForAdminAlone(t *testing.T) {
	clock := newFakeClock()
	server, port := startTestServer(t, Options{Port: 0, Clock: clock, ReconnectWindow: 60 * time.Second})
	room := createTestRoom(t, port, "MacBook · 7K2F")
	adminID := str(t, room.created, "selfId")
	room.admin.close()
	waitForRoom(t, server, room.roomID, testTimeout, func(room *Room) bool {
		return room.adminConn == nil && room.AdminOffline
	})
	clock.Advance(60*time.Second + time.Millisecond)

	snapshot := roomSnapshot(t, server, room.roomID)
	if snapshot.AdminID != adminID || !snapshot.AdminOffline {
		t.Fatalf("admin-alone room changed: %+v", snapshot)
	}
	admin2 := connectClient(t, port)
	admin2.send(map[string]any{"v": 2, "type": "create", "roomId": room.roomID, "caps": adminCaps(), "name": "MacBook · 7K2F"})
	admin2.mustNext("created", testTimeout)
}

func TestHandoverChainsToNextMember(t *testing.T) {
	fixture := newHandoverFixture(t)
	fixture.handOver(t)
	fixture.drain()

	// The new admin (first) goes offline too: after another window the next
	// earliest online member (second) takes over.
	fixture.first.close()
	waitForMemberState(t, fixture.second, fixture.firstID, "offline")
	fixture.second.drain()
	fixture.clock.Advance(60*time.Second + time.Millisecond)

	view := fixture.second.mustNext("members", testTimeout)
	members := membersOf(t, view)
	if len(members) != 1 {
		t.Fatalf("members after chained handover = %v, want only the new admin", members)
	}
	if members[0].(map[string]any)["id"] != fixture.secondID || members[0].(map[string]any)["isAdmin"] != true {
		t.Fatalf("second member was not promoted: %v", members)
	}
	assertNoMember(t, members, fixture.firstID)

	// The chained admin owns the room.
	fixture.second.send(map[string]any{"v": 2, "type": "close", "roomId": fixture.roomID})
	late := connectClient(t, fixture.port)
	late.send(map[string]any{"v": 2, "type": "join", "roomId": fixture.roomID, "caps": memberCaps(), "nonce": "member-nonce-0123456789"})
	if message := late.mustNext("error", testTimeout); message["code"] != "ROOM_NOT_FOUND" {
		t.Fatalf("late join error = %v", message)
	}
}

func TestOldAdminAfterHandover(t *testing.T) {
	fixture := newHandoverFixture(t)
	fixture.handOver(t)
	fixture.drain()

	// The old admin identity is gone: create on the same roomId is refused while
	// the new admin is connected.
	old := connectClient(t, fixture.port)
	old.send(map[string]any{"v": 2, "type": "create", "roomId": fixture.roomID, "caps": adminCaps(), "name": "旧管理员"})
	if message := old.mustNext("error", testTimeout); message["code"] != "ROOM_CLOSED" {
		t.Fatalf("old admin create error = %v", message)
	}

	// The old admin rejoinToken is invalid.
	stale := connectClient(t, fixture.port)
	stale.send(map[string]any{
		"v": 2, "type": "join", "roomId": fixture.roomID, "caps": adminCaps(),
		"nonce": "member-nonce-0123456789", "rejoinToken": fixture.token,
	})
	message := stale.mustNext("error", testTimeout)
	if message["code"] != "ROOM_NOT_FOUND" || message["msg"] != "rejoin token is invalid or expired" {
		t.Fatalf("old token error = %v", message)
	}

	// It can join again as a normal member, subject to the new admin's approval.
	fresh := connectClient(t, fixture.port)
	request := requestJoin(t, fixture.first, fresh, fixture.roomID, nil)
	approveMember(t, fixture.first, fresh, request)
}
