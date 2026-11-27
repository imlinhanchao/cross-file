package main

// Single static binary: WebSocket signaling (protocol v2), same-origin static
// hosting of the embedded web app, and an in-process TURN relay.
//
// docs/02 §7 (zero storage): the process writes nothing to disk and prints
// exactly one startup line on stdout. TURN diagnostics are discarded and
// startup errors go to stderr.

import (
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"
)

// shutdownTimeout matches the Playwright webServer gracefulShutdown budget.
const shutdownTimeout = 5 * time.Second

func main() {
	config, err := loadProcessConfig()
	if err != nil {
		fmt.Fprintf(os.Stderr, "[crossfile-signaling] config: %v\n", err)
		os.Exit(1)
	}
	server := NewServer(Options{
		Host:            config.Host,
		Port:            config.Port,
		MaxMembers:      config.MaxMembers,
		ReconnectWindow: config.ReconnectWindow,
		RateLimit:       config.RateLimit,
		TURN:            config.TURN,
		TURNServer:      config.TURNServer,
		StaticDir:       config.StaticDir,
	})
	result, err := server.Start()
	if err != nil {
		fmt.Fprintf(os.Stderr, "[crossfile-signaling] startup: %v\n", err)
		os.Exit(1)
	}
	turnStatus := "off"
	if result.TURN {
		turnStatus = "on"
	}
	fmt.Printf("[crossfile-signaling] listening on ws://%s:%d/v1/ws turn=%s\n", config.Host, result.Port, turnStatus)

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	<-signals

	done := make(chan struct{})
	go func() {
		_ = server.Stop()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(shutdownTimeout):
	}
	os.Exit(0)
}
