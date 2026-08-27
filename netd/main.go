// Command netd holds one agent's tailnet identity and moves bytes:
// inbound tailnet TLS traffic is proxied to agentd's unix socket with a
// WhoIs-verified peer-tag header; outbound requests leave through an HTTP
// forward proxy on a second unix socket, dialed via the tailnet so they
// carry this node's identity. It parses no A2A and makes no authorization
// decisions.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"slices"
	"syscall"
	"time"

	"tailscale.com/client/local"
	"tailscale.com/ipn/ipnstate"
	"tailscale.com/tsnet"
)

const shutdownTimeout = 30 * time.Second

func main() {
	configPath := flag.String("config", defaultConfigPath(), "path to netd config")
	flag.Parse()

	logf := log.New(os.Stderr, "netd: ", log.LstdFlags|log.Lmsgprefix)
	if err := run(context.Background(), *configPath, logf); err != nil {
		logf.Fatal(err)
	}
}

// whoisIdentifier adapts tsnet's LocalClient WhoIs to peerIdentifier.
type whoisIdentifier struct {
	lc *local.Client
}

func (w *whoisIdentifier) PeerTags(ctx context.Context, remoteAddr string) ([]string, error) {
	who, err := w.lc.WhoIs(ctx, remoteAddr)
	if err != nil {
		return nil, err
	}
	return who.Node.Tags, nil
}

// verifyTag confirms the node came up owning the configured tag; a key that
// cannot advertise it would leave the node reachable under the wrong ACLs.
func verifyTag(status *ipnstate.Status, tag string) error {
	var tags []string
	if status.Self != nil && status.Self.Tags != nil {
		tags = status.Self.Tags.AsSlice()
	}
	if !slices.Contains(tags, tag) {
		return fmt.Errorf("auth key does not own tag %s: node came up with tags %v; use a key whose tag owners include it", tag, tags)
	}
	return nil
}

func run(ctx context.Context, configPath string, logf *log.Logger) error {
	cfg, err := loadConfig(configPath)
	if err != nil {
		return err
	}
	authKey, err := cfg.authKey()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(cfg.StateDir, 0o700); err != nil {
		return fmt.Errorf("create state dir: %w", err)
	}

	ts := &tsnet.Server{
		Dir:           cfg.StateDir,
		Hostname:      cfg.Hostname,
		AuthKey:       authKey,
		AdvertiseTags: []string{cfg.Tag},
		ControlURL:    cfg.ControlURL,
		UserLogf:      logf.Printf,
	}
	defer ts.Close()

	ctx, stop := signal.NotifyContext(ctx, syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	status, err := ts.Up(ctx)
	if err != nil {
		return fmt.Errorf("joining tailnet: %w", err)
	}
	if err := verifyTag(status, cfg.Tag); err != nil {
		return err
	}
	logf.Printf("joined tailnet as %s (%v) with tag %s", cfg.Hostname, status.TailscaleIPs, cfg.Tag)

	lc, err := ts.LocalClient()
	if err != nil {
		return fmt.Errorf("local client: %w", err)
	}

	tlsLn, err := ts.ListenTLS("tcp", ":443")
	if err != nil {
		return fmt.Errorf("tailnet listener: %w", err)
	}

	egressLn, err := listenUnix(cfg.EgressSocket)
	if err != nil {
		return err
	}

	inbound := &http.Server{
		Handler:  newInboundProxy(cfg.UpstreamSocket, &whoisIdentifier{lc}, logf),
		ErrorLog: logf,
	}
	egress := &http.Server{
		Handler:  newEgressProxy(ts.Dial, logf),
		ErrorLog: logf,
	}

	return serveUntilSignaled(ctx, logf, []serverListener{
		{inbound, tlsLn, "inbound"},
		{egress, egressLn, "egress"},
	})
}

// listenUnix listens on path, replacing a stale socket and restricting the
// socket to the owning account: netd exists so that only tailnet peers, not
// other local users, can reach agentd.
func listenUnix(path string) (net.Listener, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, fmt.Errorf("create runtime dir: %w", err)
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("remove stale socket %s: %w", path, err)
	}
	ln, err := net.Listen("unix", path)
	if err != nil {
		return nil, fmt.Errorf("listen on %s: %w", path, err)
	}
	if err := os.Chmod(path, 0o600); err != nil {
		ln.Close()
		return nil, fmt.Errorf("chmod %s: %w", path, err)
	}
	return ln, nil
}

type serverListener struct {
	srv  *http.Server
	ln   net.Listener
	name string
}

// serveUntilSignaled serves each server on its listener until ctx is
// canceled (SIGTERM/SIGINT), then shuts down gracefully, draining
// in-flight requests up to shutdownTimeout.
func serveUntilSignaled(ctx context.Context, logf *log.Logger, servers []serverListener) error {
	errc := make(chan error, len(servers))
	for _, sl := range servers {
		go func() {
			if err := sl.srv.Serve(sl.ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
				errc <- fmt.Errorf("%s: %w", sl.name, err)
				return
			}
			errc <- nil
		}()
	}

	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
	}

	logf.Printf("shutting down: draining in-flight requests")
	drainCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	var firstErr error
	for _, sl := range servers {
		if err := sl.srv.Shutdown(drainCtx); err != nil && firstErr == nil {
			firstErr = fmt.Errorf("%s shutdown: %w", sl.name, err)
		}
	}
	return firstErr
}
