// Command netd holds one agent's tailnet identity and moves bytes:
// inbound tailnet TLS traffic is proxied to agentd's unix socket with a
// WhoIs-verified peer-tag header; outbound requests leave through an HTTP
// forward proxy on a second unix socket, which admits only the destinations
// egress_allow names and dials tailnet ones via the tailnet, so they carry
// this node's identity. It parses no A2A and makes no authorization
// decisions about the agent's callers.
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
	"tailscale.com/ipn"
	"tailscale.com/ipn/ipnstate"
	"tailscale.com/tailcfg"
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

// verifyFunnel confirms the node may host Funnel before anything is exposed,
// naming the tailnet policy that grants it: a node that cannot Funnel would
// otherwise fail at the first public connection, long after the operator
// stopped watching.
func verifyFunnel(status *ipnstate.Status, tag string) error {
	if status.Self == nil {
		return fmt.Errorf("funnel: node status has no self; cannot confirm Funnel permission")
	}
	if !status.Self.HasCap(tailcfg.NodeAttrFunnel) {
		return fmt.Errorf("funnel: node lacks the %q node attribute: grant it in the tailnet policy with "+
			`{"nodeAttrs": [{"target": ["%s"], "attr": ["funnel"]}]} (https://tailscale.com/kb/1223/funnel)`,
			tailcfg.NodeAttrFunnel, tag)
	}
	if err := ipn.CheckFunnelAccess(443, status.Self); err != nil {
		return fmt.Errorf("funnel: %w", err)
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
	suffix := tailnetSuffix(status)
	if suffix == "" {
		logf.Printf("egress: this tailnet reports no MagicDNS suffix; only short names take the tailnet route")
	}
	policy := newEgressPolicy(cfg.egressRules, suffix, ts.Dial)
	logf.Printf("egress: %s", policy.summary())
	egress := &http.Server{
		Handler:  newEgressProxy(policy, logf),
		ErrorLog: logf,
	}
	servers := []serverListener{
		{inbound, tlsLn, "inbound"},
		{egress, egressLn, "egress"},
	}

	if cfg.Funnel != nil {
		if err := verifyFunnel(status, cfg.Tag); err != nil {
			return err
		}
		// FunnelOnly: the tailnet side of :443 stays the inbound proxy above,
		// with its WhoIs; only connections Tailscale relays in from the
		// internet reach the public handler.
		funnelLn, err := ts.ListenFunnel("tcp", ":443", tsnet.FunnelOnly())
		if err != nil {
			return fmt.Errorf("funnel listener: %w", err)
		}
		public := &http.Server{
			Handler:  newPublicProxy(cfg.Funnel.UpstreamSocket, cfg.Funnel.PathPrefix, logf),
			ErrorLog: logf,
		}
		servers = append(servers, serverListener{public, funnelLn, "public"})
		logf.Printf("funnel: serving %s to %s on the public internet", cfg.Funnel.PathPrefix, cfg.Funnel.UpstreamSocket)
	}

	return serveUntilSignaled(ctx, logf, servers)
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
