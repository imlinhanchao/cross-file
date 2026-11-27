package main

// In-memory room state (docs/02 §3.3, ADR 0010), ported from
// packages/signaling/src/rooms.ts. Nothing here is persisted: a room is a plain
// struct in a map, deleted on close/expiry, and gone when the process exits.
//
// A room is an admin plus its members. A member is pending while its join
// request waits for the admin, joined once approved, and offline while its 60 s
// reconnect window is open. The room keeps only: roomId, admin identity/socket,
// members, code, timers. No IP, no user agent, no message history, no disk.

// roomState is the docs/02 §3.3 state machine: created → awaiting_approval → joined.
type roomState string

const (
	roomStateCreated          roomState = "created"
	roomStateAwaitingApproval roomState = "awaiting_approval"
	roomStateJoined           roomState = "joined"
)

type memberState string

const (
	memberPending memberState = "pending"
	memberJoined  memberState = "joined"
	memberOffline memberState = "offline"
)

// Member is one join request / approved member (the admin is not in the array).
type Member struct {
	// ID is assigned by the server; also the id used by signal.to / member_left.
	ID string
	// Name is the base name; the effective (de-duplicated) name is computed on broadcast.
	Name string
	// Caps is reported on join, forwarded to the room; never copied elsewhere.
	Caps Caps
	// Nonce is the join nonce the admin validates the QR proof against.
	Nonce string
	// Proof is the opaque QR proof; forwarded verbatim.
	Proof *string
	State memberState
	// conn is nil while the member is offline.
	conn *conn
	// RejoinToken lets this member re-attach inside the reconnect window.
	RejoinToken string

	offlineTimer Timer
}

// Room is one signaling room (admin + members), all in memory.
type Room struct {
	RoomID string
	// AdminID is the creator; phase 1 keeps the admin flag fixed.
	AdminID          string
	AdminName        string
	AdminCaps        Caps
	AdminRejoinToken string
	adminConn        *conn
	// AdminOffline is set when the admin socket drops; the room survives the
	// reconnect window and the TTL.
	AdminOffline bool
	// Members holds join requests and approved members, in join order.
	Members []*Member
	// CreatedAt / LastActivity are unix milliseconds.
	CreatedAt    int64
	LastActivity int64
	// Code is the six digit join code shown by the admin; reused on admin reconnect.
	Code  string
	State roomState
}

// visibleMembers returns the members that appear in `members` broadcasts:
// approved, inside or outside their reconnect window.
func visibleMembers(room *Room) []*Member {
	visible := make([]*Member, 0, len(room.Members))
	for _, member := range room.Members {
		if member.State == memberJoined || member.State == memberOffline {
			visible = append(visible, member)
		}
	}
	return visible
}

// effectiveNames returns the whole room's names in join order: admin first,
// then members, with -2, -3, … appended on duplicates.
func effectiveNames(room *Room) []string {
	names := make([]string, 0, len(room.Members)+1)
	names = append(names, room.AdminName)
	for _, member := range visibleMembers(room) {
		names = append(names, member.Name)
	}
	return dedupeNames(names)
}

func effectiveAdminName(room *Room) string {
	names := effectiveNames(room)
	if len(names) == 0 {
		return room.AdminName
	}
	return names[0]
}

// memberInfos is the full `members` snapshot: admin first, then members.
func memberInfos(room *Room) []MemberInfo {
	names := effectiveNames(room)
	adminName := room.AdminName
	if len(names) > 0 {
		adminName = names[0]
	}
	adminState := "joined"
	if room.AdminOffline {
		adminState = "offline"
	}
	infos := make([]MemberInfo, 0, len(room.Members)+1)
	infos = append(infos, MemberInfo{
		ID:      room.AdminID,
		Name:    adminName,
		Caps:    room.AdminCaps,
		IsAdmin: true,
		State:   adminState,
	})
	for index, member := range visibleMembers(room) {
		name := member.Name
		if index+1 < len(names) {
			name = names[index+1]
		}
		state := "offline"
		if member.State == memberJoined {
			state = "joined"
		}
		infos = append(infos, MemberInfo{
			ID:      member.ID,
			Name:    name,
			Caps:    member.Caps,
			IsAdmin: false,
			State:   state,
		})
	}
	return infos
}

// effectiveMemberName is the name an approved member carries in the snapshot.
func effectiveMemberName(room *Room, member *Member) string {
	visible := visibleMembers(room)
	index := -1
	for i, candidate := range visible {
		if candidate == member {
			index = i
			break
		}
	}
	if index < 0 {
		return member.Name
	}
	names := effectiveNames(room)
	if index+1 < len(names) {
		return names[index+1]
	}
	return member.Name
}

// pendingName is the effective name a still-pending member would get once approved.
func pendingName(room *Room, member *Member) string {
	names := make([]string, 0, len(room.Members)+2)
	names = append(names, room.AdminName)
	for _, visible := range visibleMembers(room) {
		names = append(names, visible.Name)
	}
	names = append(names, member.Name)
	deduped := dedupeNames(names)
	return deduped[len(deduped)-1]
}

// RoomStore is the in-memory room map plus the lookups the server needs.
type RoomStore struct {
	rooms map[string]*Room
}

func newRoomStore() *RoomStore {
	return &RoomStore{rooms: make(map[string]*Room)}
}

func (s *RoomStore) get(roomID string) (*Room, bool) {
	room, ok := s.rooms[roomID]
	return room, ok
}

func (s *RoomStore) set(room *Room) {
	s.rooms[room.RoomID] = room
}

func (s *RoomStore) delete(roomID string) *Room {
	room, ok := s.rooms[roomID]
	if !ok {
		return nil
	}
	clearMemberTimers(room)
	delete(s.rooms, roomID)
	return room
}

func (s *RoomStore) findMember(room *Room, memberID string) *Member {
	for _, member := range room.Members {
		if member.ID == memberID {
			return member
		}
	}
	return nil
}

// findRejoinMember finds a member holding a rejoin token, but only once it has
// been approved at least once.
func (s *RoomStore) findRejoinMember(room *Room, rejoinToken string) *Member {
	for _, member := range room.Members {
		if member.RejoinToken == rejoinToken && member.State != memberPending {
			return member
		}
	}
	return nil
}

func (s *RoomStore) removeMember(room *Room, member *Member) {
	clearMemberTimer(member)
	for index, candidate := range room.Members {
		if candidate == member {
			room.Members = append(room.Members[:index], room.Members[index+1:]...)
			return
		}
	}
}

func (s *RoomStore) hasJoinedMember(room *Room) bool {
	return len(visibleMembers(room)) > 0
}

// expire removes every room whose last activity is older than the TTL and hands
// them back so the caller can notify the peers.
func (s *RoomStore) expire(nowMs int64, ttlMs int64) []*Room {
	expired := make([]*Room, 0)
	for _, room := range s.rooms {
		if nowMs-room.LastActivity > ttlMs {
			expired = append(expired, room)
		}
	}
	for _, room := range expired {
		clearMemberTimers(room)
		delete(s.rooms, room.RoomID)
	}
	return expired
}

func (s *RoomStore) clear() {
	for _, room := range s.rooms {
		clearMemberTimers(room)
	}
	s.rooms = make(map[string]*Room)
}

func (s *RoomStore) size() int {
	return len(s.rooms)
}

// clearMemberTimer cancels one member's offline timer (rejoin, removal, shutdown).
func clearMemberTimer(member *Member) {
	if member.offlineTimer != nil {
		member.offlineTimer.Stop()
		member.offlineTimer = nil
	}
}

// clearMemberTimers cancels every offline timer of a room before it is deleted.
func clearMemberTimers(room *Room) {
	for _, member := range room.Members {
		clearMemberTimer(member)
	}
}
