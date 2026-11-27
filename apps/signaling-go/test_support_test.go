package main

// Test harness: a real gorilla WebSocket client plus protocol fixtures and a
// fake clock. Mirrors packages/signaling/src/test-support.ts.

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// --- fixtures ---------------------------------------------------------------

// adminCaps is the room creator (desktop Chrome).
func adminCaps() Caps {
	deviceMemory := 16.0
	storageQuota := 51_200.0
	return Caps{
		Platform:       "linux",
		UAFamily:       "chrome",
		NativeShell:    false,
		SecureContext:  true,
		FSAccess:       true,
		SW:             true,
		SWDownload:     false,
		SaveStrategies: []string{"fs", "blob"},
		DeviceMemoryGB: &deviceMemory,
		StorageQuotaMB: &storageQuota,
		Screen:         "desktop",
	}
}

// memberCaps is the joiner (iPhone Safari).
func memberCaps() Caps {
	deviceMemory := 6.0
	storageQuota := 10_240.0
	return Caps{
		Platform:       "ios",
		UAFamily:       "safari",
		NativeShell:    false,
		SecureContext:  true,
		FSAccess:       false,
		SW:             true,
		SWDownload:     true,
		SaveStrategies: []string{"sw", "blob"},
		DeviceMemoryGB: &deviceMemory,
		StorageQuotaMB: &storageQuota,
		Screen:         "phone",
	}
}

// newRoomID builds a 26 character lowercase base32 room id (16 random bytes).
func newRoomID(t *testing.T) string {
	t.Helper()
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		t.Fatalf("random room id: %v", err)
	}
	const alphabet = "abcdefghijklmnopqrstuvwxyz234567"
	var builder []byte
	bits := 0
	value := 0
	for _, b := range bytes {
		value = value<<8 | int(b)
		bits += 8
		for bits >= 5 {
			builder = append(builder, alphabet[(value>>(bits-5))&31])
			bits -= 5
		}
	}
	if bits > 0 {
		builder = append(builder, alphabet[(value<<(5-bits))&31])
	}
	return string(builder[:26])
}

// --- fake clock -------------------------------------------------------------

type fakeTimer struct {
	clock   *fakeClock
	at      time.Time
	fn      func()
	stopped bool
	fired   bool
}

func (t *fakeTimer) Stop() bool {
	t.clock.mu.Lock()
	defer t.clock.mu.Unlock()
	if t.stopped || t.fired {
		return false
	}
	t.stopped = true
	return true
}

type fakeClock struct {
	mu     sync.Mutex
	now    time.Time
	timers []*fakeTimer
}

func newFakeClock() *fakeClock {
	return newFakeClockAt(time.UnixMilli(1_700_000_000_000))
}

func newFakeClockAt(now time.Time) *fakeClock {
	return &fakeClock{now: now}
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) AfterFunc(d time.Duration, fn func()) Timer {
	c.mu.Lock()
	defer c.mu.Unlock()
	timer := &fakeTimer{clock: c, at: c.now.Add(d), fn: fn}
	c.timers = append(c.timers, timer)
	return timer
}

// Advance moves time forward and fires every timer that became due.
func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	c.now = c.now.Add(d)
	due := make([]*fakeTimer, 0, len(c.timers))
	for _, timer := range c.timers {
		if !timer.stopped && !timer.fired && !timer.at.After(c.now) {
			timer.fired = true
			due = append(due, timer)
		}
	}
	c.mu.Unlock()
	for _, timer := range due {
		timer.fn()
	}
}

// --- test client ------------------------------------------------------------

type closeInfo struct {
	code   int
	reason string
}

type testClient struct {
	t    *testing.T
	ws   *websocket.Conn
	cond *sync.Cond
	mu   sync.Mutex

	queue        []map[string]any
	closedFlag   bool
	closeDetails closeInfo
	timedOut     bool
}

func openTestClient(t *testing.T, port int) *testClient {
	t.Helper()
	ws, _, err := websocket.DefaultDialer.Dial(fmt.Sprintf("ws://127.0.0.1:%d/v1/ws", port), nil)
	if err != nil {
		t.Fatalf("dial signaling: %v", err)
	}
	client := &testClient{t: t, ws: ws}
	client.cond = sync.NewCond(&client.mu)
	go client.readLoop()
	t.Cleanup(func() { client.close() })
	return client
}

func (c *testClient) readLoop() {
	for {
		_, data, err := c.ws.ReadMessage()
		if err != nil {
			info := closeInfo{code: websocket.CloseAbnormalClosure}
			var closeErr *websocket.CloseError
			if errors.As(err, &closeErr) {
				info = closeInfo{code: closeErr.Code, reason: closeErr.Text}
			}
			c.mu.Lock()
			c.closedFlag = true
			c.closeDetails = info
			c.cond.Broadcast()
			c.mu.Unlock()
			return
		}
		var message map[string]any
		if err := json.Unmarshal(data, &message); err != nil {
			continue
		}
		c.mu.Lock()
		c.queue = append(c.queue, message)
		c.cond.Broadcast()
		c.mu.Unlock()
	}
}

func (c *testClient) send(message any) {
	c.t.Helper()
	data, err := json.Marshal(message)
	if err != nil {
		c.t.Fatalf("marshal message: %v", err)
	}
	if err := c.ws.WriteMessage(websocket.TextMessage, data); err != nil {
		c.t.Fatalf("send message: %v", err)
	}
}

func (c *testClient) sendText(text string) {
	c.t.Helper()
	if err := c.ws.WriteMessage(websocket.TextMessage, []byte(text)); err != nil {
		c.t.Fatalf("send text: %v", err)
	}
}

// next waits for one message of the given type, buffering other types.
func (c *testClient) next(messageType string, timeout time.Duration) (map[string]any, error) {
	timer := time.AfterFunc(timeout, func() {
		c.mu.Lock()
		c.timedOut = true
		c.cond.Broadcast()
		c.mu.Unlock()
	})
	defer timer.Stop()

	c.mu.Lock()
	defer c.mu.Unlock()
	for {
		for index, message := range c.queue {
			if message["type"] == messageType {
				c.queue = append(c.queue[:index], c.queue[index+1:]...)
				return message, nil
			}
		}
		if c.closedFlag {
			return nil, fmt.Errorf("socket closed while waiting for %s", messageType)
		}
		if c.timedOut {
			c.timedOut = false
			return nil, fmt.Errorf("timed out waiting for %s", messageType)
		}
		c.cond.Wait()
	}
}

func (c *testClient) mustNext(messageType string, timeout time.Duration) map[string]any {
	c.t.Helper()
	message, err := c.next(messageType, timeout)
	if err != nil {
		c.t.Fatalf("%v", err)
	}
	return message
}

// nextAny returns the oldest queued message regardless of type (ordering tests).
func (c *testClient) nextAny(timeout time.Duration) (map[string]any, error) {
	timer := time.AfterFunc(timeout, func() {
		c.mu.Lock()
		c.timedOut = true
		c.cond.Broadcast()
		c.mu.Unlock()
	})
	defer timer.Stop()

	c.mu.Lock()
	defer c.mu.Unlock()
	for {
		if len(c.queue) > 0 {
			message := c.queue[0]
			c.queue = c.queue[1:]
			return message, nil
		}
		if c.closedFlag {
			return nil, fmt.Errorf("socket closed while waiting for any message")
		}
		if c.timedOut {
			c.timedOut = false
			return nil, fmt.Errorf("timed out waiting for any message")
		}
		c.cond.Wait()
	}
}

func (c *testClient) expectNoMessage(messageType string, wait time.Duration) {
	c.t.Helper()
	if message, err := c.next(messageType, wait); err == nil {
		c.t.Fatalf("unexpected %s message: %v", messageType, message)
	}
}

// closed waits for the socket to close and reports its code.
func (c *testClient) closed(timeout time.Duration) (closeInfo, error) {
	deadline := time.Now().Add(timeout)
	c.mu.Lock()
	defer c.mu.Unlock()
	for !c.closedFlag {
		if time.Now().After(deadline) {
			return closeInfo{}, fmt.Errorf("timed out waiting for close")
		}
		c.mu.Unlock()
		time.Sleep(5 * time.Millisecond)
		c.mu.Lock()
	}
	return c.closeDetails, nil
}

func (c *testClient) close() {
	c.mu.Lock()
	alreadyClosed := c.closedFlag
	c.mu.Unlock()
	if alreadyClosed {
		return
	}
	_ = c.ws.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""), time.Now().Add(time.Second))
	_ = c.ws.Close()
	_, _ = c.closed(2 * time.Second)
}

// --- server helpers ---------------------------------------------------------

func startTestServer(t *testing.T, options Options) (*Server, int) {
	t.Helper()
	options.Host = "127.0.0.1"
	if options.Clock == nil {
		options.Clock = realClock{}
	}
	server := NewServer(options)
	result, err := server.Start()
	if err != nil {
		t.Fatalf("start server: %v", err)
	}
	t.Cleanup(func() { _ = server.Stop() })
	return server, result.Port
}

func connectClient(t *testing.T, port int) *testClient {
	t.Helper()
	return openTestClient(t, port)
}

type roomFixture struct {
	admin   *testClient
	roomID  string
	created map[string]any
}

func createTestRoom(t *testing.T, port int, name string) roomFixture {
	t.Helper()
	admin := connectClient(t, port)
	roomID := newRoomID(t)
	caps := adminCaps()
	admin.send(map[string]any{"v": 2, "type": "hello", "clientCaps": caps})
	admin.send(map[string]any{"v": 2, "type": "create", "roomId": roomID, "caps": caps, "name": name})
	created := admin.mustNext("created", 2*time.Second)
	return roomFixture{admin: admin, roomID: roomID, created: created}
}

func requestJoin(t *testing.T, admin *testClient, member *testClient, roomIDOrCode string, options map[string]any) map[string]any {
	t.Helper()
	caps := memberCaps()
	member.send(map[string]any{"v": 2, "type": "hello", "clientCaps": caps})
	join := map[string]any{
		"v":      2,
		"type":   "join",
		"roomId": roomIDOrCode,
		"caps":   caps,
		"nonce":  "member-nonce-0123456789",
	}
	for key, value := range options {
		if value == nil {
			// A nil option means "omit the field" (e.g. no QR proof on the code path).
			delete(join, key)
			continue
		}
		join[key] = value
	}
	member.send(join)
	return admin.mustNext("join_request", 2*time.Second)
}

func approveMember(t *testing.T, admin *testClient, member *testClient, request map[string]any) map[string]any {
	t.Helper()
	admin.send(map[string]any{"v": 2, "type": "approve", "memberId": request["memberId"]})
	joinOk := member.mustNext("join_ok", 2*time.Second)
	member.mustNext("members", 2*time.Second)
	admin.mustNext("members", 2*time.Second)
	return joinOk
}

type joinedPairFixture struct {
	admin   *testClient
	member  *testClient
	roomID  string
	created map[string]any
	request map[string]any
	joinOk  map[string]any
}

func joinedPair(t *testing.T, port int) joinedPairFixture {
	t.Helper()
	room := createTestRoom(t, port, "MacBook · 7K2F")
	member := connectClient(t, port)
	request := requestJoin(t, room.admin, member, room.roomID, nil)
	joinOk := approveMember(t, room.admin, member, request)
	return joinedPairFixture{
		admin:   room.admin,
		member:  member,
		roomID:  room.roomID,
		created: room.created,
		request: request,
		joinOk:  joinOk,
	}
}

// --- assertions -------------------------------------------------------------

// findMember is the non-fatal lookup used while polling broadcasts.
func findMember(members []any, id string) (map[string]any, bool) {
	for _, entry := range members {
		member, ok := entry.(map[string]any)
		if ok && member["id"] == id {
			return member, true
		}
	}
	return nil, false
}

// waitForMemberState polls `members` broadcasts until the member reaches a state
// (handover broadcasts can overtake earlier queued snapshots in the test client).
func waitForMemberState(t *testing.T, client *testClient, memberID, want string) map[string]any {
	t.Helper()
	deadline := time.Now().Add(testTimeout)
	for time.Now().Before(deadline) {
		message, err := client.next("members", time.Until(deadline))
		if err != nil {
			t.Fatalf("waiting for %s state %q: %v", memberID, want, err)
		}
		if member, ok := findMember(membersOf(t, message), memberID); ok && member["state"] == want {
			return message
		}
	}
	t.Fatalf("member %s never reached state %q", memberID, want)
	return nil
}

func memberByID(t *testing.T, members []any, id string) map[string]any {
	t.Helper()
	for _, entry := range members {
		member, ok := entry.(map[string]any)
		if ok && member["id"] == id {
			return member
		}
	}
	t.Fatalf("member %s is not in the room", id)
	return nil
}

func membersOf(t *testing.T, message map[string]any) []any {
	t.Helper()
	members, ok := message["members"].([]any)
	if !ok {
		t.Fatalf("message has no members array: %v", message)
	}
	return members
}

func str(t *testing.T, message map[string]any, key string) string {
	t.Helper()
	value, ok := message[key].(string)
	if !ok {
		t.Fatalf("%s is not a string in %v", key, message)
	}
	return value
}

func base64url(bytes []byte) string {
	return base64.RawURLEncoding.EncodeToString(bytes)
}

// trySend writes a frame best-effort; used by tests that expect the server to
// close the connection mid-stream.
func (c *testClient) trySend(message any) {
	data, err := json.Marshal(message)
	if err != nil {
		return
	}
	_ = c.ws.WriteMessage(websocket.TextMessage, data)
}

// drain drops buffered messages; handover tests assert on the next broadcast.
func (c *testClient) drain() {
	c.mu.Lock()
	c.queue = nil
	c.timedOut = false
	c.mu.Unlock()
}

// waitForRoom polls the server's in-memory room under its lock.
func waitForRoom(t *testing.T, server *Server, roomID string, timeout time.Duration, check func(*Room) bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		server.mu.Lock()
		room, ok := server.rooms.get(roomID)
		matched := ok && check(room)
		server.mu.Unlock()
		if matched {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("room %s condition not met within %v", roomID, timeout)
}

// roomInfo is a lock-safe copy of the room fields the handover tests assert on.
type roomInfo struct {
	AdminID        string
	AdminName      string
	AdminOffline   bool
	AdminConnected bool
	Code           string
	Members        int
}

// roomSnapshot copies the in-memory room state (test-only; no pointer escapes
// the server lock, so -race stays clean while the sweep ticker runs).
func roomSnapshot(t *testing.T, server *Server, roomID string) roomInfo {
	t.Helper()
	server.mu.Lock()
	defer server.mu.Unlock()
	room, ok := server.rooms.get(roomID)
	if !ok {
		t.Fatalf("room %s is gone", roomID)
	}
	return roomInfo{
		AdminID:        room.AdminID,
		AdminName:      room.AdminName,
		AdminOffline:   room.AdminOffline,
		AdminConnected: room.adminConn != nil,
		Code:           room.Code,
		Members:        len(room.Members),
	}
}

// withMesh returns a caps bundle with the optional phase-2 mesh flag set.
func withMesh(caps Caps, mesh bool) Caps {
	caps.Mesh = &mesh
	return caps
}
