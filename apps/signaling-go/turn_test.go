package main

import (
	"fmt"
	"io"
	"net"
	"testing"
	"time"

	"github.com/pion/logging"
	"github.com/pion/turn/v4"
)

func TestIssueTurnCredentialKnownVectors(t *testing.T) {
	// Vectors computed with the Node implementation (turn.ts):
	//   credential = base64(HMAC-SHA1(secret, "<expiry>:<memberId>"))
	cases := []struct {
		name     string
		secret   string
		memberID string
		nowMs    int64
		ttl      int
		wantUser string
		wantCred string
	}{
		{
			name:     "default ttl",
			secret:   "crossfile-turn-test-secret",
			memberID: "abcdefghijk",
			nowMs:    1_700_000_000_000,
			ttl:      3_600,
			wantUser: "1700003600:abcdefghijk",
			wantCred: "IzlR0uHb8eQhT70n3V2MQRIf95o=",
		},
		{
			name:     "custom ttl",
			secret:   "static-auth-secret-for-tests",
			memberID: "F7wWdcsi8wI",
			nowMs:    1_700_000_000_000,
			ttl:      600,
			wantUser: "1700000600:F7wWdcsi8wI",
			wantCred: "wGWztE+i74dgHzdrLjDJc5zPza8=",
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			credential := issueTurnCredential(&TurnOptions{
				URIs:   []string{"turn:turn.example.org:3478?transport=udp"},
				Secret: testCase.secret,
				TTL:    testCase.ttl,
			}, testCase.memberID, testCase.nowMs)
			if credential.Username != testCase.wantUser {
				t.Fatalf("username = %q, want %q", credential.Username, testCase.wantUser)
			}
			if credential.Credential != testCase.wantCred {
				t.Fatalf("credential = %q, want %q", credential.Credential, testCase.wantCred)
			}
			if credential.TTL != testCase.ttl {
				t.Fatalf("ttl = %d, want %d", credential.TTL, testCase.ttl)
			}
		})
	}
}

func TestIssueTurnCredentialDefaults(t *testing.T) {
	uris := []string{"turn:example.org:3478"}
	credential := issueTurnCredential(&TurnOptions{URIs: uris, Secret: "s"}, "member", 1_000)
	if credential.TTL != 3_600 {
		t.Fatalf("default ttl = %d, want 3600", credential.TTL)
	}
	// The URIs are copied, not aliased.
	uris[0] = "mutated"
	if credential.URIs[0] != "turn:example.org:3478" {
		t.Fatalf("URIs were aliased: %v", credential.URIs)
	}
}

func TestStartTURNServer(t *testing.T) {
	if _, err := startTURNServer(TURNServerOptions{Secret: "s", ListenPort: 0}); err == nil {
		t.Fatalf("missing external IP should fail")
	}
	server, err := startTURNServer(TURNServerOptions{
		Secret:     "static-auth-secret",
		ExternalIP: net.ParseIP("127.0.0.1"),
		ListenPort: 0,
		MinPort:    49160,
		MaxPort:    49200,
	})
	if err != nil {
		t.Fatalf("startTURNServer: %v", err)
	}
	if err := server.Close(); err != nil {
		t.Fatalf("close TURN server: %v", err)
	}
}

func TestStartTURNServerPortConflict(t *testing.T) {
	listener, err := net.Listen("tcp4", "0.0.0.0:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer listener.Close()
	port := listener.Addr().(*net.TCPAddr).Port
	if _, err := startTURNServer(TURNServerOptions{
		Secret:     "s",
		ExternalIP: net.ParseIP("127.0.0.1"),
		ListenPort: port,
		MinPort:    49160,
		MaxPort:    49200,
	}); err == nil {
		t.Fatalf("a busy TURN port should fail startup")
	}
}

// startTURNServerOnFreePort picks a port that was free for both protocols and
// retries on the (rare) bind race, so the integration test is not flaky.
func startTURNServerOnFreePort(t *testing.T, options TURNServerOptions) (*turn.Server, int) {
	t.Helper()
	var lastErr error
	for attempt := 0; attempt < 10; attempt++ {
		probe, err := net.ListenPacket("udp4", "127.0.0.1:0")
		if err != nil {
			lastErr = err
			continue
		}
		port := probe.LocalAddr().(*net.UDPAddr).Port
		_ = probe.Close()
		options.ListenPort = port
		server, err := startTURNServer(options)
		if err == nil {
			return server, port
		}
		lastErr = err
	}
	t.Fatalf("startTURNServer: %v", lastErr)
	return nil, 0
}

// TestEmbeddedTURNAllocatesAndRelaysUDP proves the in-process TURN listener
// accepts coturn static-auth REST credentials and relays a UDP datagram through
// the configured relay port range. This is the same path the browser uses for
// AC2, without needing a browser.
func TestEmbeddedTURNAllocatesAndRelaysUDP(t *testing.T) {
	secret := "turn-integration-secret"
	server, listenPort := startTURNServerOnFreePort(t, TURNServerOptions{
		Secret:     secret,
		ExternalIP: net.ParseIP("127.0.0.1"),
		MinPort:    49300,
		MaxPort:    49310,
	})
	defer func() { _ = server.Close() }()

	echo, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("echo listener: %v", err)
	}
	defer func() { _ = echo.Close() }()
	go func() {
		buffer := make([]byte, 1500)
		for {
			n, from, err := echo.ReadFrom(buffer)
			if err != nil {
				return
			}
			_, _ = echo.WriteTo(buffer[:n], from)
		}
	}()

	clientConn, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("client listener: %v", err)
	}
	defer func() { _ = clientConn.Close() }()

	username := fmt.Sprintf("%d:turn-test-member", time.Now().Unix()+120)
	client, err := turn.NewClient(&turn.ClientConfig{
		STUNServerAddr: fmt.Sprintf("127.0.0.1:%d", listenPort),
		TURNServerAddr: fmt.Sprintf("127.0.0.1:%d", listenPort),
		Username:       username,
		Password:       hmacSHA1Base64(secret, username),
		Realm:          "crossfile",
		Conn:           clientConn,
		LoggerFactory: &logging.DefaultLoggerFactory{
			Writer:          io.Discard,
			DefaultLogLevel: logging.LogLevelDisabled,
			ScopeLevels:     map[string]logging.LogLevel{},
		},
	})
	if err != nil {
		t.Fatalf("turn.NewClient: %v", err)
	}
	client.Listen()
	defer client.Close()

	relayConn, err := client.Allocate()
	if err != nil {
		t.Fatalf("allocate relay: %v", err)
	}
	defer func() { _ = relayConn.Close() }()

	_ = relayConn.SetDeadline(time.Now().Add(5 * time.Second))
	if _, err := relayConn.WriteTo([]byte("ping"), echo.LocalAddr()); err != nil {
		t.Fatalf("write through relay: %v", err)
	}
	buffer := make([]byte, 64)
	n, _, err := relayConn.ReadFrom(buffer)
	if err != nil {
		t.Fatalf("read through relay: %v", err)
	}
	if string(buffer[:n]) != "ping" {
		t.Fatalf("relayed payload = %q", buffer[:n])
	}
}
