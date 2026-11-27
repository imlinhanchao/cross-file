package main

import (
	"reflect"
	"testing"
	"time"
)

func testRoom() *Room {
	proof := "proof-value"
	return &Room{
		RoomID:           "abcdefghijklmnopqrstuvwxyz",
		AdminID:          "admin000001",
		AdminName:        "同名",
		AdminCaps:        adminCaps(),
		AdminRejoinToken: "admin-token",
		Members: []*Member{
			{ID: "member00001", Name: "同名", Caps: memberCaps(), Nonce: "n1", Proof: &proof, State: memberPending, RejoinToken: "t1"},
			{ID: "member00002", Name: "同名", Caps: memberCaps(), Nonce: "n2", State: memberJoined, RejoinToken: "t2"},
			{ID: "member00003", Name: "客厅", Caps: memberCaps(), Nonce: "n3", State: memberOffline, RejoinToken: "t3"},
		},
		CreatedAt:    1_700_000_000_000,
		LastActivity: 1_700_000_000_000,
		Code:         "123456",
		State:        roomStateJoined,
	}
}

func TestMemberInfosSnapshot(t *testing.T) {
	room := testRoom()
	infos := memberInfos(room)
	if len(infos) != 3 {
		t.Fatalf("memberInfos returned %d entries, want 3 (admin + 2 visible; pending excluded)", len(infos))
	}
	// Admin first, marked as admin.
	if infos[0].ID != room.AdminID || !infos[0].IsAdmin || infos[0].State != "joined" {
		t.Fatalf("admin entry = %+v", infos[0])
	}
	// Duplicate names are de-duplicated in join order.
	if infos[1].Name != "同名-2" || infos[1].State != "joined" || infos[1].IsAdmin {
		t.Fatalf("member entry = %+v", infos[1])
	}
	if infos[2].Name != "客厅" || infos[2].State != "offline" {
		t.Fatalf("offline member entry = %+v", infos[2])
	}

	room.AdminOffline = true
	if state := memberInfos(room)[0].State; state != "offline" {
		t.Fatalf("admin state = %q, want offline", state)
	}
}

func TestMemberInfosRenumbersAfterRemoval(t *testing.T) {
	room := testRoom()
	// Drop the admin's duplicate: the remaining duplicate falls back to the base name.
	room.AdminName = "另一个"
	infos := memberInfos(room)
	if infos[1].Name != "同名" || infos[2].Name != "客厅" {
		t.Fatalf("names after rename = %q, %q", infos[1].Name, infos[2].Name)
	}
}

func TestPendingAndEffectiveNames(t *testing.T) {
	room := testRoom()
	pending := room.Members[0]
	// pendingName appends the pending member after the visible ones.
	if name := pendingName(room, pending); name != "同名-3" {
		t.Fatalf("pendingName = %q, want 同名-3", name)
	}
	if name := effectiveAdminName(room); name != "同名" {
		t.Fatalf("effectiveAdminName = %q", name)
	}
	if name := effectiveMemberName(room, room.Members[1]); name != "同名-2" {
		t.Fatalf("effectiveMemberName = %q", name)
	}
	// A pending member is not visible yet, so its effective name is its base name.
	if name := effectiveMemberName(room, pending); name != "同名" {
		t.Fatalf("effectiveMemberName(pending) = %q", name)
	}
}

func TestRoomStoreExpireAndDelete(t *testing.T) {
	store := newRoomStore()
	clock := newFakeClock()
	old := &Room{RoomID: "old", Members: []*Member{{ID: "m", State: memberOffline, offlineTimer: clock.AfterFunc(time.Minute, func() {})}}}
	fresh := &Room{RoomID: "fresh"}
	old.LastActivity = nowMillis(clock) - 1_000
	fresh.LastActivity = nowMillis(clock)
	store.set(old)
	store.set(fresh)

	expired := store.expire(nowMillis(clock), 500)
	if len(expired) != 1 || expired[0].RoomID != "old" {
		t.Fatalf("expire = %v", expired)
	}
	if _, ok := store.get("old"); ok {
		t.Fatalf("expired room was not deleted")
	}
	if store.size() != 1 {
		t.Fatalf("store size = %d", store.size())
	}
	// The offline timer was cancelled with the room.
	if old.Members[0].offlineTimer != nil {
		t.Fatalf("member timer was not cleared")
	}
	store.delete("fresh")
	if store.size() != 0 {
		t.Fatalf("delete left %d rooms", store.size())
	}
}

func TestRoomStoreLookups(t *testing.T) {
	store := newRoomStore()
	room := testRoom()
	store.set(room)
	if found := store.findMember(room, "member00002"); found == nil || found.ID != "member00002" {
		t.Fatalf("findMember failed")
	}
	if found := store.findMember(room, "nope"); found != nil {
		t.Fatalf("findMember found a ghost")
	}
	// Pending members cannot rejoin (never approved).
	if found := store.findRejoinMember(room, "t1"); found != nil {
		t.Fatalf("pending member rejoin should be rejected")
	}
	if found := store.findRejoinMember(room, "t2"); found == nil || found.ID != "member00002" {
		t.Fatalf("approved member rejoin failed")
	}
	if store.hasJoinedMember(room) != true {
		t.Fatalf("room should have a joined member")
	}
	store.removeMember(room, room.Members[1])
	if len(room.Members) != 2 {
		t.Fatalf("removeMember left %d members", len(room.Members))
	}
	// A room with only pending members is not "joined".
	pendingOnly := &Room{RoomID: "p", Members: []*Member{{ID: "x", State: memberPending}}}
	if store.hasJoinedMember(pendingOnly) {
		t.Fatalf("pending-only room reported as joined")
	}
}

func TestDedupeNamesJoinOrderIsStable(t *testing.T) {
	// Admin first then join order: the exact algorithm docs/02 §1 requires.
	got := dedupeNames([]string{"MacBook · 7K2F", "iPhone · AB12", "iPhone · AB12"})
	want := []string{"MacBook · 7K2F", "iPhone · AB12", "iPhone · AB12-2"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("dedupeNames = %v", got)
	}
}
