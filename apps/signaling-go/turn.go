package main

// Ephemeral TURN credentials plus the embedded pion/turn server.
//
// docs/02 §6.8: the signaling server issues coturn `static-auth-secret`
// credentials so existing clients keep working unchanged:
//
//	username   = "<expiryEpoch>:<memberId>"
//	credential = base64(HMAC-SHA1(secret, username))
//
// In the Go rewrite the TURN server runs in-process (pion/turn v4, UDP + TCP)
// instead of as a separate coturn container, using the same shared secret.

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"fmt"
	"io"
	"net"
	"strconv"

	"github.com/pion/logging"
	"github.com/pion/turn/v4"
)

// TurnOptions is the credential-issuing half (mirrors TurnOptions in index.ts).
type TurnOptions struct {
	URIs   []string
	Secret string
	// TTL is the credential lifetime in seconds; 0 means the protocol default.
	TTL int
}

// issueTurnCredential derives one credential on demand; nothing is stored.
func issueTurnCredential(options *TurnOptions, memberID string, nowMs int64) TurnCredential {
	ttl := options.TTL
	if ttl == 0 {
		ttl = turnTTLSeconds
	}
	expiry := nowMs/1_000 + int64(ttl)
	username := fmt.Sprintf("%d:%s", expiry, memberID)
	credential := hmacSHA1Base64(options.Secret, username)
	uris := make([]string, len(options.URIs))
	copy(uris, options.URIs)
	return TurnCredential{URIs: uris, Username: username, Credential: credential, TTL: ttl}
}

// hmacSHA1Base64 is the coturn static-auth-secret credential derivation:
// base64(HMAC-SHA1(secret, username)).
func hmacSHA1Base64(secret, username string) string {
	mac := hmac.New(sha1.New, []byte(secret))
	_, _ = mac.Write([]byte(username))
	return base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

// TURNServerOptions configures the in-process TURN listener.
type TURNServerOptions struct {
	Secret     string
	ExternalIP net.IP
	ListenPort int
	MinPort    int
	MaxPort    int
}

// startTURNServer binds UDP and TCP on ListenPort and relays through the
// configured port range. Realm is fixed to "crossfile".
//
// Logging: the TURN server is given a discarding logger factory. docs/02 §7
// allows only error-level output and no request logging; pion logs per
// allocation at info/debug and per failed auth at error, so silence is the only
// output that respects the zero-storage rule.
func startTURNServer(options TURNServerOptions) (*turn.Server, error) {
	if options.ExternalIP == nil {
		return nil, fmt.Errorf("TURN_EXTERNAL_IP is required when TURN_SECRET is set")
	}
	// Bind the wildcard address of the same family as the advertised relay IP.
	udpNetwork, tcpNetwork, listenAddress, relayBind := "udp4", "tcp4", "0.0.0.0", "0.0.0.0"
	if options.ExternalIP.To4() == nil {
		udpNetwork, tcpNetwork, listenAddress, relayBind = "udp6", "tcp6", "::", "::"
	}
	address := net.JoinHostPort(listenAddress, strconv.Itoa(options.ListenPort))
	udpConn, err := net.ListenPacket(udpNetwork, address)
	if err != nil {
		return nil, fmt.Errorf("TURN UDP listener on %s: %w", address, err)
	}
	tcpListener, err := net.Listen(tcpNetwork, address)
	if err != nil {
		_ = udpConn.Close()
		return nil, fmt.Errorf("TURN TCP listener on %s: %w", address, err)
	}

	loggerFactory := &logging.DefaultLoggerFactory{
		Writer:          io.Discard,
		DefaultLogLevel: logging.LogLevelDisabled,
		ScopeLevels:     map[string]logging.LogLevel{},
	}
	authLogger := loggerFactory.NewLogger("turn-auth")

	relayGenerator := func() *turn.RelayAddressGeneratorPortRange {
		return &turn.RelayAddressGeneratorPortRange{
			RelayAddress: options.ExternalIP,
			Address:      relayBind,
			MinPort:      uint16(options.MinPort),
			MaxPort:      uint16(options.MaxPort),
		}
	}

	server, err := turn.NewServer(turn.ServerConfig{
		Realm:       "crossfile",
		AuthHandler: turn.LongTermTURNRESTAuthHandler(options.Secret, authLogger),
		PacketConnConfigs: []turn.PacketConnConfig{
			{PacketConn: udpConn, RelayAddressGenerator: relayGenerator()},
		},
		ListenerConfigs: []turn.ListenerConfig{
			{Listener: tcpListener, RelayAddressGenerator: relayGenerator()},
		},
		LoggerFactory: loggerFactory,
	})
	if err != nil {
		_ = udpConn.Close()
		_ = tcpListener.Close()
		return nil, fmt.Errorf("TURN server: %w", err)
	}
	return server, nil
}

// parsePort parses a TCP/UDP port number, allowing 0 (ephemeral) when allowed.
func parsePort(raw string, name string, allowZero bool) (int, error) {
	value, err := strconv.Atoi(raw)
	if err != nil || value < 0 || value > 65535 || (!allowZero && value == 0) {
		return 0, fmt.Errorf("%s must be a port number (got %q)", name, raw)
	}
	return value, nil
}
