package main

// In-memory signaling server for CrossFile v2 (docs/02 §3, ADR 0010), ported
// from packages/signaling/src/server.ts.
//
// A room is an admin plus its members. Everything lives in process memory:
// rooms, member ids, rejoin tokens, join codes, rate-limit counters. No
// database, no disk writes, no cookies, no access logs, and no IP/UA stored on
// a room.
//
// Concurrency: one mutex serialises every state transition, exactly like the
// Node single-threaded event loop. Socket writes are queued per connection and
// flushed by a writer goroutine, so a slow peer can never block the state
// machine (it is terminated instead).

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pion/turn/v4"
)

const (
	wsPath = "/v1/ws"

	defaultPort              = 8788
	defaultHost              = "127.0.0.1"
	defaultRateLimitWindowMs = 60_000
	defaultRateLimitMax      = 120
	// docs/02 §7: periodic sweep; never later than a quarter of the room TTL.
	sweepMinMs = 10
	sweepMaxMs = 5_000
	// ADR 0010 risk note: `profile` is rate limited per connection, not only per IP.
	profileRateWindowMs = 60_000
	profileRateMax      = 10

	// writeTimeout bounds one socket write; a slow peer is dropped, not waited on.
	writeTimeout = 10 * time.Second
	// outboundQueue is the per-connection send buffer.
	outboundQueue = 64
)

var shortCodePattern = regexp.MustCompile(`^\d{6}$`)

// Options configures one server instance. Zero values fall back to the
// production defaults documented in docs/02.
type Options struct {
	Host            string
	Port            int
	MaxMembers      int
	RoomTTL         time.Duration
	Heartbeat       time.Duration
	ReconnectWindow time.Duration
	RateLimit       RateLimitPolicy
	// TURN issues coturn static-auth credentials on created/join_ok.
	TURN *TurnOptions
	// TURNServer starts the in-process relay (nil keeps the process signaling-only).
	TURNServer *TURNServerOptions
	// StaticDir overrides the embedded web app (development).
	StaticDir string
	// StaticSource overrides both (tests).
	StaticSource StaticSource
	Clock        Clock
}

// StartResult reports what came up.
type StartResult struct {
	Port int
	TURN bool
}

type profileWindow struct {
	start int64
	count int
}

type outboundKind int

const (
	outText outboundKind = iota
	outPing
	outClose
	outTerminate
)

type outbound struct {
	kind   outboundKind
	data   []byte
	code   int
	reason string
}

// conn is one WebSocket connection plus the connection-scoped state the
// protocol needs (docs/02 §7: the IP is only an in-memory rate-limit key).
type conn struct {
	ws   *websocket.Conn
	ip   string
	out  chan outbound
	done chan struct{}

	closed atomic.Bool
	alive  atomic.Bool

	// Guarded by server.mu:
	violations   int
	role         string // "", "admin" or "member"
	roomID       string
	memberID     string
	profileStart int64
	profileCount int
	profileSet   bool
}

// Server is the signaling server.
type Server struct {
	options Options
	clock   Clock
	rooms   *RoomStore
	codes   *ShortCodeStore
	limiter *RateLimiter
	static  *StaticHandler

	mu          sync.Mutex
	connections map[*conn]struct{}

	httpServer *http.Server
	listener   net.Listener
	turnServer *turn.Server

	sweepTicker     *time.Ticker
	keepAliveTicker *time.Ticker
	stopCh          chan struct{}
	wg              sync.WaitGroup

	stopOnce sync.Once
	stopErr  error
	stopped  bool

	activePort  int
	turnStarted bool
}

// NewServer builds a server; construction is side-effect free.
func NewServer(options Options) *Server {
	if options.Host == "" {
		options.Host = defaultHost
	}
	if options.MaxMembers <= 0 {
		options.MaxMembers = defaultMaxMembers
	}
	if options.RoomTTL <= 0 {
		options.RoomTTL = roomTTL
	}
	if options.Heartbeat <= 0 {
		options.Heartbeat = heartbeat
	}
	if options.ReconnectWindow <= 0 {
		options.ReconnectWindow = reconnectWindow
	}
	if options.RateLimit.WindowMs <= 0 {
		options.RateLimit.WindowMs = defaultRateLimitWindowMs
	}
	if options.RateLimit.Max <= 0 {
		options.RateLimit.Max = defaultRateLimitMax
	}
	if options.Clock == nil {
		options.Clock = realClock{}
	}
	source := options.StaticSource
	if source == nil {
		if options.StaticDir != "" {
			source = NewDirectorySource(options.StaticDir)
		} else {
			source = EmbeddedWebDist()
		}
	}
	server := &Server{
		options:     options,
		clock:       options.Clock,
		rooms:       newRoomStore(),
		codes:       newShortCodeStore(options.Clock),
		limiter:     newRateLimiter(options.RateLimit, options.Clock),
		static:      newStaticHandler(source),
		connections: make(map[*conn]struct{}),
	}
	return server
}

// Start binds the HTTP/WebSocket listener (and the TURN relay when configured).
func (s *Server) Start() (StartResult, error) {
	if s.options.TURNServer != nil {
		turnServer, err := startTURNServer(*s.options.TURNServer)
		if err != nil {
			return StartResult{}, err
		}
		s.turnServer = turnServer
		s.turnStarted = true
	}

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if isWebSocketUpgrade(r) {
			// server.ts compares the raw request path, so "/v1%2Fws" is not the
			// signaling endpoint; an upgrade attempt elsewhere is destroyed.
			if r.URL.EscapedPath() == wsPath {
				s.handleUpgrade(w, r)
				return
			}
			destroyConnection(w)
			return
		}
		s.handleRequest(w, r)
	})
	address := net.JoinHostPort(s.options.Host, strconv.Itoa(s.options.Port))
	listener, err := net.Listen("tcp", address)
	if err != nil {
		if s.turnServer != nil {
			_ = s.turnServer.Close()
			s.turnServer = nil
			s.turnStarted = false
		}
		return StartResult{}, err
	}
	s.listener = listener
	s.activePort = listener.Addr().(*net.TCPAddr).Port
	s.httpServer = &http.Server{Handler: handler, ReadHeaderTimeout: 10 * time.Second}
	s.stopCh = make(chan struct{})

	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		_ = s.httpServer.Serve(listener)
	}()

	s.startLoops()
	return StartResult{Port: s.activePort, TURN: s.turnStarted}, nil
}

func (s *Server) startLoops() {
	sweepMs := s.options.RoomTTL.Milliseconds() / 4
	if sweepMs < sweepMinMs {
		sweepMs = sweepMinMs
	}
	if sweepMs > sweepMaxMs {
		sweepMs = sweepMaxMs
	}
	s.sweepTicker = time.NewTicker(time.Duration(sweepMs) * time.Millisecond)
	s.keepAliveTicker = time.NewTicker(s.options.Heartbeat)
	s.wg.Add(2)
	go func() {
		defer s.wg.Done()
		for {
			select {
			case <-s.sweepTicker.C:
				s.sweep()
			case <-s.stopCh:
				return
			}
		}
	}()
	go func() {
		defer s.wg.Done()
		for {
			select {
			case <-s.keepAliveTicker.C:
				s.keepAlive()
			case <-s.stopCh:
				return
			}
		}
	}()
}

// Stop releases every room, counter, timer and socket (docs/02 §7.4).
func (s *Server) Stop() error {
	s.stopOnce.Do(func() {
		s.mu.Lock()
		if s.stopped {
			s.mu.Unlock()
			return
		}
		s.stopped = true
		if s.sweepTicker != nil {
			s.sweepTicker.Stop()
		}
		if s.keepAliveTicker != nil {
			s.keepAliveTicker.Stop()
		}
		if s.stopCh != nil {
			close(s.stopCh)
		}
		conns := make([]*conn, 0, len(s.connections))
		for c := range s.connections {
			conns = append(conns, c)
		}
		s.connections = make(map[*conn]struct{})
		s.rooms.clear()
		s.codes.clear()
		s.limiter.clear()
		s.mu.Unlock()

		if s.httpServer != nil {
			_ = s.httpServer.Close()
		}
		for _, c := range conns {
			c.closed.Store(true)
			_ = c.ws.UnderlyingConn().Close()
		}
		s.wg.Wait()
		if s.turnServer != nil {
			if err := s.turnServer.Close(); err != nil {
				s.stopErr = err
			}
			s.turnServer = nil
		}
	})
	return s.stopErr
}

// --- HTTP / WebSocket -------------------------------------------------------

func (s *Server) handleRequest(w http.ResponseWriter, r *http.Request) {
	// No access logging (docs/02 §7). With a static source the same origin
	// serves the app; otherwise only /v1/ws exists and everything else is a
	// quiet 404.
	if s.static != nil && s.static.ServeHTTP(w, r) {
		return
	}
	w.Header().Set("content-type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusNotFound)
	_, _ = io.WriteString(w, "not found")
}

func isWebSocketUpgrade(r *http.Request) bool {
	return strings.EqualFold(r.Header.Get("Upgrade"), "websocket")
}

// destroyConnection drops a socket without an HTTP response, like
// socket.destroy() in server.ts handleUpgrade.
func destroyConnection(w http.ResponseWriter) {
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	connection, _, err := hijacker.Hijack()
	if err != nil {
		return
	}
	_ = connection.Close()
}

var upgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	// Node's ws server accepts every origin; the app is served same-origin.
	CheckOrigin: func(*http.Request) bool { return true },
}

func (s *Server) handleUpgrade(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	stopping := s.stopped
	s.mu.Unlock()
	if stopping {
		w.Header().Set("content-type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusNotFound)
		_, _ = io.WriteString(w, "not found")
		return
	}
	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	c := &conn{
		ws:   ws,
		ip:   remoteIP(r),
		out:  make(chan outbound, outboundQueue),
		done: make(chan struct{}),
	}
	c.alive.Store(true)
	s.mu.Lock()
	if s.stopped {
		s.mu.Unlock()
		_ = ws.Close()
		return
	}
	s.connections[c] = struct{}{}
	s.wg.Add(2)
	s.mu.Unlock()
	go s.writeLoop(c)
	go s.readLoop(c)
}

func remoteIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func (s *Server) readLoop(c *conn) {
	defer s.wg.Done()
	defer close(c.done)
	defer s.handleDisconnect(c)
	defer s.recoverConn(c, "read")
	c.ws.SetReadLimit(maxMessageBytes)
	c.ws.SetPongHandler(func(string) error {
		c.alive.Store(true)
		return nil
	})
	for {
		messageType, data, err := c.ws.ReadMessage()
		if err != nil {
			return
		}
		s.handleFrame(c, messageType, data)
	}
}

func (s *Server) writeLoop(c *conn) {
	defer s.wg.Done()
	defer s.recoverConn(c, "write")
	defer func() {
		c.closed.Store(true)
		_ = c.ws.UnderlyingConn().Close()
	}()
	for {
		select {
		case item := <-c.out:
			switch item.kind {
			case outTerminate:
				return
			case outPing:
				_ = c.ws.SetWriteDeadline(time.Now().Add(writeTimeout))
				if err := c.ws.WriteControl(websocket.PingMessage, nil, time.Now().Add(writeTimeout)); err != nil {
					return
				}
			case outClose:
				_ = c.ws.WriteControl(websocket.CloseMessage,
					websocket.FormatCloseMessage(item.code, item.reason), time.Now().Add(writeTimeout))
				return
			case outText:
				_ = c.ws.SetWriteDeadline(time.Now().Add(writeTimeout))
				if err := c.ws.WriteMessage(websocket.TextMessage, item.data); err != nil {
					return
				}
			}
		case <-c.done:
			return
		case <-s.stopCh:
			return
		}
	}
}

// recoverConn turns an unexpected panic in a connection goroutine into a
// technical error line on stderr plus a dropped connection. It never logs user
// data (docs/02 §7).
func (s *Server) recoverConn(c *conn, scope string) {
	if recovered := recover(); recovered != nil {
		fmt.Fprintf(os.Stderr, "[crossfile-signaling] %s: recovered panic: %v\n", scope, recovered)
		c.closed.Store(true)
		if c.ws != nil {
			_ = c.ws.UnderlyingConn().Close()
		}
	}
}

// enqueue appends one outbound frame; a full queue terminates the peer instead
// of growing memory without bound.
func (s *Server) enqueue(c *conn, item outbound) {
	if c == nil || c.closed.Load() {
		return
	}
	select {
	case c.out <- item:
	default:
		c.terminate()
	}
}

func (c *conn) closeWith(code int, reason string) {
	if !c.closed.CompareAndSwap(false, true) {
		return
	}
	select {
	case c.out <- outbound{kind: outClose, code: code, reason: reason}:
	default:
		_ = c.ws.UnderlyingConn().Close()
	}
}

func (c *conn) terminate() {
	if !c.closed.CompareAndSwap(false, true) {
		return
	}
	select {
	case c.out <- outbound{kind: outTerminate}:
	default:
		_ = c.ws.UnderlyingConn().Close()
	}
}

// --- sending helpers --------------------------------------------------------

func (s *Server) send(c *conn, message any) {
	if c == nil {
		return
	}
	data, err := json.Marshal(message)
	if err != nil {
		return
	}
	s.enqueue(c, outbound{kind: outText, data: data})
}

func (s *Server) sendError(c *conn, code, msg string) {
	s.send(c, errorMessage{V: protocolVersion, Type: "error", Code: code, Msg: msg})
}

func (s *Server) sendRoomClosed(c *conn, reason string) {
	s.send(c, roomClosedMessage{V: protocolVersion, Type: "room_closed", Reason: reason})
}

// turnFor issues one credential per member per connection; nothing when TURN is
// unconfigured (docs/02 §6.8).
func (s *Server) turnFor(memberID string) *TurnCredential {
	if s.options.TURN == nil {
		return nil
	}
	credential := issueTurnCredential(s.options.TURN, memberID, nowMillis(s.clock))
	return &credential
}

func (s *Server) createdMessage(room *Room) createdMessage {
	return createdMessage{
		V:           protocolVersion,
		Type:        "created",
		RoomID:      room.RoomID,
		Code:        room.Code,
		SelfID:      room.AdminID,
		Name:        effectiveAdminName(room),
		Members:     memberInfos(room),
		RejoinToken: room.AdminRejoinToken,
		Turn:        s.turnFor(room.AdminID),
	}
}

func (s *Server) joinOkMessage(room *Room, selfID, name, rejoinToken string) joinOkMessage {
	return joinOkMessage{
		V:           protocolVersion,
		Type:        "join_ok",
		RoomID:      room.RoomID,
		SelfID:      selfID,
		Name:        name,
		Members:     memberInfos(room),
		RejoinToken: rejoinToken,
		Turn:        s.turnFor(selfID),
	}
}

func joinRequestFor(room *Room, member *Member) joinRequestMessage {
	message := joinRequestMessage{
		V:        protocolVersion,
		Type:     "join_request",
		MemberID: member.ID,
		Caps:     member.Caps,
		Nonce:    member.Nonce,
		Name:     pendingName(room, member),
	}
	if member.Proof != nil {
		message.Proof = *member.Proof
	}
	return message
}

// broadcastMembers sends the full snapshot to the admin and every visible
// member (docs/02 §3.2: members is always a full snapshot, never an increment).
func (s *Server) broadcastMembers(room *Room) {
	message := membersMessage{V: protocolVersion, Type: "members", Members: memberInfos(room)}
	s.send(room.adminConn, message)
	for _, member := range room.Members {
		if member.State == memberPending {
			continue
		}
		s.send(member.conn, message)
	}
}

// replayPendingRequests replays join requests to an admin that just re-attached.
func (s *Server) replayPendingRequests(room *Room) {
	for _, member := range room.Members {
		if member.State == memberPending {
			s.send(room.adminConn, joinRequestFor(room, member))
		}
	}
}

// --- connection helpers -----------------------------------------------------

func (s *Server) bind(c *conn, role, roomID, memberID string) {
	c.role = role
	c.roomID = roomID
	c.memberID = memberID
}

func (s *Server) unbind(c *conn) {
	if c == nil {
		return
	}
	c.role = ""
	c.roomID = ""
	c.memberID = ""
}

func (s *Server) adminRoom(c *conn) *Room {
	if c.role != "admin" || c.roomID == "" {
		s.sendError(c, "NOT_ADMIN", "only the admin can do that")
		return nil
	}
	room, ok := s.rooms.get(c.roomID)
	if !ok || room.adminConn != c {
		s.sendError(c, "ROOM_NOT_FOUND", "admin room is gone")
		return nil
	}
	return room
}

func (s *Server) recomputeRoomState(room *Room) {
	switch {
	case s.rooms.hasJoinedMember(room):
		room.State = roomStateJoined
	case len(room.Members) > 0:
		room.State = roomStateAwaitingApproval
	default:
		room.State = roomStateCreated
	}
}

// participant reports who this socket is inside the room, if it is still bound.
func (s *Server) participant(room *Room, c *conn) (string, bool) {
	if c.role == "admin" && room.adminConn == c {
		return room.AdminID, !room.AdminOffline
	}
	if c.role == "member" && c.memberID != "" {
		member := s.rooms.findMember(room, c.memberID)
		if member != nil && member.conn == c {
			return member.ID, member.State == memberJoined
		}
	}
	return "", false
}

// retireSocket closes and unbinds a socket superseded by a rejoin.
func (s *Server) retireSocket(c *conn) {
	if c == nil {
		return
	}
	s.unbind(c)
	c.closeWith(websocket.CloseNormalClosure, "superseded by a reconnect")
}

// detachMember cancels its timer, forgets it and unbinds its socket.
func (s *Server) detachMember(room *Room, member *Member) {
	socket := member.conn
	s.rooms.removeMember(room, member)
	member.conn = nil
	if socket != nil {
		s.unbind(socket)
	}
}

// --- message preparation ----------------------------------------------------

// prepareShortCode maps a six digit code in join.roomId to the real roomId
// before schema validation (docs/02 §3.5 / impl-note). ok=false means the code
// is unknown or expired, which is answered like an unknown room.
func (s *Server) prepareShortCode(raw []byte) ([]byte, *string, bool) {
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(raw, &obj); err != nil || obj == nil {
		return raw, nil, true
	}
	var messageType string
	if err := json.Unmarshal(obj["type"], &messageType); err != nil || messageType != "join" {
		return raw, nil, true
	}
	var roomID string
	if err := json.Unmarshal(obj["roomId"], &roomID); err != nil || !shortCodePattern.MatchString(roomID) {
		return raw, nil, true
	}
	resolved, ok := s.codes.resolve(roomID)
	if !ok {
		return raw, nil, false
	}
	obj["roomId"], _ = json.Marshal(resolved)
	patched, err := json.Marshal(obj)
	if err != nil {
		return raw, nil, true
	}
	code := roomID
	return patched, &code, true
}

func (s *Server) rejectMessage(c *conn, reason string) {
	c.violations++
	s.sendError(c, "BAD_MESSAGE", reason)
	if c.violations >= maxConsecutiveBadMessages {
		c.violations = 0
		c.closeWith(websocket.ClosePolicyViolation, "too many malformed messages")
	}
}

func (s *Server) takeProfileBudget(c *conn) bool {
	at := nowMillis(s.clock)
	if !c.profileSet || at >= c.profileStart+profileRateWindowMs {
		c.profileStart = at
		c.profileCount = 1
		c.profileSet = true
		return true
	}
	if c.profileCount >= profileRateMax {
		return false
	}
	c.profileCount++
	return true
}

func (s *Server) handleFrame(c *conn, messageType int, data []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if len(data) > maxMessageBytes {
		c.closeWith(websocket.CloseMessageTooBig, "message too large")
		return
	}
	if !s.limiter.take(c.ip) {
		s.sendError(c, "RATE_LIMITED", "too many signaling messages")
		c.closeWith(websocket.ClosePolicyViolation, "rate limited")
		return
	}
	if messageType == websocket.BinaryMessage {
		s.rejectMessage(c, "binary frames are not accepted, signaling is JSON text")
		return
	}
	prepared, code, ok := s.prepareShortCode(data)
	if !ok {
		// A wrong/expired code is not a malformed frame; answer like an unknown room.
		s.sendError(c, "ROOM_NOT_FOUND", "join code is invalid or expired")
		c.violations = 0
		return
	}
	message, err := parseClientMessage(prepared)
	if err != nil {
		// ADR 0010 version gate: a v1 page must be told to refresh.
		if errVersionMismatch(err) {
			s.sendError(c, "VERSION_MISMATCH", versionOutdatedMsg)
			c.closeWith(websocket.ClosePolicyViolation, "protocol version mismatch")
			return
		}
		reason := "message does not match the protocol"
		var bad *BadMessageError
		if errors.As(err, &bad) && bad.NotJSON {
			reason = "message is not valid JSON"
		}
		s.rejectMessage(c, reason)
		return
	}
	c.violations = 0
	s.dispatch(c, message, code)
}

func (s *Server) dispatch(c *conn, message *ClientMessage, code *string) {
	switch message.Type {
	case "hello":
		// docs/02 §3.2: capabilities arrive per join/create; the server keeps nothing.
		return
	case "create":
		s.handleCreate(c, message)
	case "join":
		s.handleJoin(c, message, code)
	case "approve":
		s.handleApprove(c, message)
	case "deny":
		s.handleDeny(c, message)
	case "remove":
		s.handleRemove(c, message)
	case "signal":
		s.handleSignal(c, message)
	case "profile":
		s.handleProfile(c, message)
	case "heartbeat":
		s.handleHeartbeat(c, message)
	case "close":
		s.handleClose(c, message)
	}
}

// --- client message handlers ------------------------------------------------

func (s *Server) handleCreate(c *conn, message *ClientMessage) {
	if c.role != "" {
		s.sendError(c, "BAD_MESSAGE", "connection is already bound to a room")
		return
	}
	name, ok := normalizeDisplayName(message.Name)
	if !ok {
		s.sendError(c, "BAD_MESSAGE", "display name must be 1-16 characters")
		return
	}
	if existing, found := s.rooms.get(message.RoomID); found {
		adminOnline := existing.adminConn != nil && existing.adminConn != c && !existing.adminConn.closed.Load()
		if adminOnline {
			s.sendError(c, "ROOM_CLOSED", "room already has a connected admin")
			return
		}
		// impl-note: admin reconnect — the room, its code and its members survive
		// admin socket loss, so a repeated create with the same roomId re-attaches.
		if existing.adminConn != nil && existing.adminConn != c {
			s.retireSocket(existing.adminConn)
		}
		existing.adminConn = c
		existing.AdminOffline = false
		clearAdminHandover(existing)
		existing.AdminCaps = *message.Caps
		existing.AdminName = name
		existing.LastActivity = nowMillis(s.clock)
		s.bind(c, "admin", existing.RoomID, existing.AdminID)
		s.send(c, s.createdMessage(existing))
		s.broadcastMembers(existing)
		s.replayPendingRequests(existing)
		return
	}
	at := nowMillis(s.clock)
	room := &Room{
		RoomID:           message.RoomID,
		AdminID:          createPeerID(),
		AdminName:        name,
		AdminCaps:        *message.Caps,
		AdminRejoinToken: createRejoinToken(),
		adminConn:        c,
		Members:          []*Member{},
		CreatedAt:        at,
		LastActivity:     at,
		Code:             s.codes.issue(message.RoomID),
		State:            roomStateCreated,
	}
	s.rooms.set(room)
	s.bind(c, "admin", room.RoomID, room.AdminID)
	s.send(c, s.createdMessage(room))
}

func (s *Server) handleJoin(c *conn, message *ClientMessage, code *string) {
	if c.role != "" {
		s.sendError(c, "BAD_MESSAGE", "connection is already bound to a room")
		return
	}
	room, found := s.rooms.get(message.RoomID)
	if !found {
		s.sendError(c, "ROOM_NOT_FOUND", "room not found")
		return
	}
	if message.RejoinToken != nil {
		s.rejoin(c, room, message, *message.RejoinToken)
		return
	}
	if room.adminConn == nil || room.adminConn.closed.Load() {
		s.sendError(c, "ROOM_CLOSED", "admin is offline")
		return
	}
	if len(room.Members) >= s.options.MaxMembers {
		s.sendError(c, "ROOM_FULL", "room is full")
		return
	}
	if code != nil {
		if _, ok := s.codes.consume(*code); !ok {
			s.sendError(c, "ROOM_NOT_FOUND", "join code is invalid or expired")
			return
		}
	}
	defaultName, ok := normalizeDisplayName(defaultDisplayName(*message.Caps))
	if !ok {
		defaultName = fallbackName
	}
	member := &Member{
		ID:          createPeerID(),
		Name:        defaultName,
		Caps:        *message.Caps,
		Nonce:       message.Nonce,
		Proof:       message.Proof,
		State:       memberPending,
		conn:        c,
		RejoinToken: createRejoinToken(),
	}
	room.Members = append(room.Members, member)
	room.LastActivity = nowMillis(s.clock)
	s.recomputeRoomState(room)
	s.bind(c, "member", room.RoomID, member.ID)
	// docs/02 §3.4: the proof is opaque to S — no roomKey exists server side — so
	// it is forwarded verbatim and the admin validates it.
	s.send(room.adminConn, joinRequestFor(room, member))
}

// rejoin re-attaches a member — or the admin — presenting its rejoinToken
// inside the 60 s window without a new approval.
func (s *Server) rejoin(c *conn, room *Room, message *ClientMessage, rejoinToken string) {
	if rejoinToken == room.AdminRejoinToken {
		// `create` is the documented admin reconnect (docs/02 §3.3); accept the token path too.
		if room.adminConn != nil && room.adminConn != c {
			s.retireSocket(room.adminConn)
		}
		room.adminConn = c
		room.AdminOffline = false
		clearAdminHandover(room)
		room.AdminCaps = *message.Caps
		room.LastActivity = nowMillis(s.clock)
		s.bind(c, "admin", room.RoomID, room.AdminID)
		s.send(c, s.joinOkMessage(room, room.AdminID, effectiveAdminName(room), room.AdminRejoinToken))
		s.broadcastMembers(room)
		s.replayPendingRequests(room)
		return
	}
	member := s.rooms.findRejoinMember(room, rejoinToken)
	if member == nil {
		s.sendError(c, "ROOM_NOT_FOUND", "rejoin token is invalid or expired")
		return
	}
	if member.conn != nil && member.conn != c {
		s.retireSocket(member.conn)
	}
	clearMemberTimer(member)
	member.conn = c
	member.State = memberJoined
	member.Caps = *message.Caps
	room.LastActivity = nowMillis(s.clock)
	s.bind(c, "member", room.RoomID, member.ID)
	s.recomputeRoomState(room)
	s.send(c, s.joinOkMessage(room, member.ID, effectiveMemberName(room, member), member.RejoinToken))
	s.broadcastMembers(room)
}

func (s *Server) handleApprove(c *conn, message *ClientMessage) {
	room := s.adminRoom(c)
	if room == nil {
		return
	}
	member := s.rooms.findMember(room, message.MemberID)
	if member == nil || member.State != memberPending {
		s.sendError(c, "PEER_GONE", "member is no longer waiting")
		return
	}
	member.State = memberJoined
	room.LastActivity = nowMillis(s.clock)
	s.recomputeRoomState(room)
	s.send(member.conn, s.joinOkMessage(room, member.ID, effectiveMemberName(room, member), member.RejoinToken))
	s.broadcastMembers(room)
}

// denyOutcome: a known error code passes through, otherwise ROOM_CLOSED with
// the free text as reason.
func denyOutcome(reason *string) (string, string) {
	if reason != nil && errorCodes[*reason] {
		return *reason, *reason
	}
	if reason != nil {
		return "ROOM_CLOSED", *reason
	}
	return "ROOM_CLOSED", "denied by admin"
}

func (s *Server) handleDeny(c *conn, message *ClientMessage) {
	room := s.adminRoom(c)
	if room == nil {
		return
	}
	member := s.rooms.findMember(room, message.MemberID)
	if member == nil || member.State != memberPending {
		s.sendError(c, "PEER_GONE", "member is no longer waiting")
		return
	}
	code, reason := denyOutcome(message.Reason)
	s.send(member.conn, joinRejectedMessage{V: protocolVersion, Type: "join_rejected", Code: code, Reason: reason})
	s.detachMember(room, member)
	s.recomputeRoomState(room)
	room.LastActivity = nowMillis(s.clock)
}

func (s *Server) handleRemove(c *conn, message *ClientMessage) {
	room := s.adminRoom(c)
	if room == nil {
		return
	}
	member := s.rooms.findMember(room, message.MemberID)
	if member == nil {
		s.sendError(c, "PEER_GONE", "member is not in the room")
		return
	}
	socket := member.conn
	s.detachMember(room, member)
	if socket != nil {
		s.sendRoomClosed(socket, "error")
		socket.closeWith(websocket.CloseNormalClosure, "removed")
	}
	s.broadcastMembers(room)
	s.send(room.adminConn, memberLeftMessage{V: protocolVersion, Type: "member_left", MemberID: member.ID})
	s.recomputeRoomState(room)
	room.LastActivity = nowMillis(s.clock)
}

func (s *Server) handleSignal(c *conn, message *ClientMessage) {
	if c.roomID == "" || c.role == "" {
		s.sendError(c, "ROOM_NOT_FOUND", "connection is not in a room")
		return
	}
	room, found := s.rooms.get(c.roomID)
	if !found {
		s.sendError(c, "ROOM_NOT_FOUND", "room is gone")
		return
	}
	me, joined := s.participant(room, c)
	if me == "" || !joined {
		s.sendError(c, "PEER_GONE", "sender is not joined yet")
		return
	}
	// docs/02 §3.2/§3.6 (v2): `to` is any member id — the admin is a member too.
	var target *conn
	if message.To == room.AdminID {
		if !room.AdminOffline && room.adminConn != nil {
			target = room.adminConn
		}
	} else {
		member := s.rooms.findMember(room, message.To)
		if member != nil && member.State == memberJoined && member.conn != nil {
			target = member.conn
		}
	}
	if target == nil || target.closed.Load() {
		s.sendError(c, "PEER_GONE", "no such peer in the room")
		return
	}
	room.LastActivity = nowMillis(s.clock)
	s.send(target, signalMessage{V: protocolVersion, Type: "signal", From: me, Payload: *message.Payload})
}

func (s *Server) handleProfile(c *conn, message *ClientMessage) {
	if c.roomID == "" || c.memberID == "" || c.role == "" {
		s.sendError(c, "ROOM_NOT_FOUND", "connection is not in a room")
		return
	}
	room, found := s.rooms.get(c.roomID)
	if !found {
		s.sendError(c, "ROOM_NOT_FOUND", "room is gone")
		return
	}
	if _, joined := s.participant(room, c); !joined {
		s.sendError(c, "PEER_GONE", "member is not joined yet")
		return
	}
	name, ok := normalizeDisplayName(message.Name)
	if !ok {
		s.sendError(c, "BAD_MESSAGE", "display name must be 1-16 characters")
		return
	}
	if !s.takeProfileBudget(c) {
		s.sendError(c, "RATE_LIMITED", "too many display name changes")
		return
	}
	if c.role == "admin" {
		room.AdminName = name
	} else {
		member := s.rooms.findMember(room, c.memberID)
		if member == nil {
			s.sendError(c, "PEER_GONE", "member is not in the room")
			return
		}
		member.Name = name
	}
	room.LastActivity = nowMillis(s.clock)
	s.broadcastMembers(room)
}

func (s *Server) handleHeartbeat(c *conn, message *ClientMessage) {
	// impl-note (phase 1): the room TTL is renewed by the admin's heartbeat, as in v1.
	room, found := s.rooms.get(message.RoomID)
	if found && room.adminConn == c {
		room.LastActivity = nowMillis(s.clock)
	}
}

func (s *Server) handleClose(c *conn, message *ClientMessage) {
	if c.role != "admin" {
		s.sendError(c, "NOT_ADMIN", "only the admin can close the room")
		return
	}
	room, found := s.rooms.get(message.RoomID)
	if !found {
		s.sendError(c, "ROOM_NOT_FOUND", "room not found")
		return
	}
	if room.adminConn != c {
		s.sendError(c, "ROOM_NOT_FOUND", "admin room is gone")
		return
	}
	// docs/01 AC7 / docs/02 §3.3: close destroys the room immediately.
	for _, member := range room.Members {
		socket := member.conn
		s.sendRoomClosed(socket, "admin_close")
		if socket != nil {
			s.unbind(socket)
			socket.closeWith(websocket.CloseNormalClosure, "admin closed the room")
		}
	}
	s.rooms.delete(room.RoomID)
	s.codes.revokeRoom(room.RoomID)
	s.unbind(c)
}

// --- socket lifecycle -------------------------------------------------------

func (s *Server) handleDisconnect(c *conn) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.connections, c)
	if s.stopped {
		return
	}
	if c.roomID == "" {
		return
	}
	room, found := s.rooms.get(c.roomID)
	if !found {
		return
	}
	if c.role == "admin" {
		if room.adminConn == c {
			// impl-note: admin socket loss never destroys the room — the 60 s
			// reconnect window and the ≤30 min idle TTL decide when it disappears.
			room.adminConn = nil
			room.AdminOffline = true
			// Phase 2 (ADR 0010 D24): if the admin does not come back inside the
			// reconnect window, the earliest-joined online member takes over.
			clearAdminHandover(room)
			roomID := room.RoomID
			room.adminHandoverTimer = s.clock.AfterFunc(s.options.ReconnectWindow, func() {
				s.handoverAdmin(roomID)
			})
			s.broadcastMembers(room)
		}
		return
	}
	if c.role != "member" || c.memberID == "" {
		return
	}
	member := s.rooms.findMember(room, c.memberID)
	if member == nil || member.conn != c {
		return
	}
	if member.State == memberPending {
		// A join request that never got approved leaves no trace in the member list.
		s.detachMember(room, member)
		s.recomputeRoomState(room)
		return
	}
	// docs/02 §6.6 (v2, symmetric): members get the same 60 s window as the admin.
	member.conn = nil
	member.State = memberOffline
	clearMemberTimer(member)
	roomID := room.RoomID
	memberID := member.ID
	member.offlineTimer = s.clock.AfterFunc(s.options.ReconnectWindow, func() {
		s.expireMember(roomID, memberID)
	})
	s.broadcastMembers(room)
}

// expireMember is the reconnect-window callback: forget the member and tell the
// admin (docs/02 §3.3).
func (s *Server) expireMember(roomID, memberID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stopped {
		return
	}
	room, found := s.rooms.get(roomID)
	if !found {
		return
	}
	member := s.rooms.findMember(room, memberID)
	if member == nil || member.State != memberOffline {
		return
	}
	clearMemberTimer(member)
	s.rooms.removeMember(room, member)
	s.broadcastMembers(room)
	s.send(room.adminConn, memberLeftMessage{V: protocolVersion, Type: "member_left", MemberID: memberID})
	s.recomputeRoomState(room)
}

// handoverAdmin is the phase-2 timer callback (ADR 0010 D24): the admin stayed
// offline for the whole reconnect window, so the earliest-joined member that is
// joined and reachable is promoted to admin. With no such member the room is
// left alone (no retry) and lives until the TTL. The promoted member keeps the
// room's six digit code; the old admin identity (and its rejoinToken) is dropped.
func (s *Server) handoverAdmin(roomID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stopped {
		return
	}
	room, found := s.rooms.get(roomID)
	if !found {
		return
	}
	// A reconnect that raced the timer wins: do nothing.
	if !room.AdminOffline || room.adminConn != nil {
		return
	}
	room.adminHandoverTimer = nil
	var candidate *Member
	for _, member := range room.Members {
		if member.State == memberJoined && member.conn != nil && !member.conn.closed.Load() {
			candidate = member
			break
		}
	}
	if candidate == nil {
		// No online member to hand over to; the room survives to the TTL.
		return
	}
	s.rooms.removeMember(room, candidate)
	room.AdminID = candidate.ID
	room.AdminName = candidate.Name
	room.AdminCaps = candidate.Caps
	room.adminConn = candidate.conn
	room.AdminOffline = false
	// The old admin token dies with the old admin; the new admin reconnects with
	// `create` (documented admin reconnect) if its socket drops later.
	room.AdminRejoinToken = createRejoinToken()
	// room.Code is intentionally unchanged: the six digit code is reused.
	s.bind(room.adminConn, "admin", room.RoomID, room.AdminID)
	s.recomputeRoomState(room)
	// The promoted client learns it is now the admin from `created`: it is the
	// only existing message that carries the room's six digit code and the fresh
	// admin rejoinToken (docs/02 §11.2). No new message type is introduced.
	s.send(room.adminConn, s.createdMessage(room))
	s.broadcastMembers(room)
	s.replayPendingRequests(room)
}

func (s *Server) sweep() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stopped {
		return
	}
	at := nowMillis(s.clock)
	for _, room := range s.rooms.expire(at, s.options.RoomTTL.Milliseconds()) {
		for _, member := range room.Members {
			socket := member.conn
			s.sendRoomClosed(socket, "ttl")
			if socket != nil {
				s.unbind(socket)
				socket.closeWith(websocket.CloseNormalClosure, "room expired")
			}
		}
		if room.adminConn != nil {
			// impl-note: the admin is notified that the room expired, but its socket
			// stays open so it can create a fresh room without reconnecting.
			s.sendRoomClosed(room.adminConn, "ttl")
			s.unbind(room.adminConn)
		}
		s.codes.revokeRoom(room.RoomID)
	}
	s.codes.sweep()
	s.limiter.sweep()
}

func (s *Server) keepAlive() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stopped {
		return
	}
	for c := range s.connections {
		if c.closed.Load() {
			continue
		}
		if !c.alive.Swap(false) {
			c.terminate()
			continue
		}
		s.enqueue(c, outbound{kind: outPing})
	}
}

// --- ids --------------------------------------------------------------------

// createPeerID returns 8 random bytes, base64url (docs/02 §1 memberId).
func createPeerID() string {
	return base64urlEncode(randomBytes(8))
}

// createRejoinToken returns an opaque 16 byte rejoin secret (docs/02 §3.2).
func createRejoinToken() string {
	return base64urlEncode(randomBytes(16))
}
