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
	"os/user"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"time"

	"tailscale.com/client/local"
	"tailscale.com/ipn"
	"tailscale.com/ipn/ipnstate"
	"tailscale.com/tailcfg"
	"tailscale.com/tsnet"
)

const shutdownTimeout = 30 * time.Second

// version is stamped by the release build with -ldflags. A binary from a
// working tree keeps the default and says so, rather than claiming a release
// it is not.
var version = "0.0.0-dev"

func main() {
	configPath := flag.String("config", defaultConfigPath(), "path to netd config")
	showVersion := flag.Bool("version", false, "print the release this binary was built from")
	flag.Parse()
	// Answered before the config is read: a binary should be identifiable
	// even when its configuration is missing, which is when the question is
	// usually asked.
	if *showVersion {
		fmt.Println(version)
		return
	}

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

// nodeName is the name the tailnet actually gave this node: the first label
// of its MagicDNS name. Empty when the tailnet publishes none.
func nodeName(status *ipnstate.Status) string {
	if status.Self == nil {
		return ""
	}
	name, _, _ := strings.Cut(status.Self.DNSName, ".")
	return name
}

// verifyHostname confirms the node came up under the name it was configured
// with. When one of that name already exists, the coordination server assigns
// a suffixed one — thicket-bridge-1 — and everything that dials this node by
// name goes to the other one instead: every account's egress_allow, the
// bridge's base URL, the endpoint an agent is reached on, the public hostname
// the phone bridge validates its callers against. None of that fails in a way
// that points here; it fails as a 502 from a node with nothing behind it, or
// as a hostname that does not resolve.
//
// So this refuses to start, for the same reason verifyTag does: a node
// reachable under the wrong identity is worse than one that did not come up.
func verifyHostname(status *ipnstate.Status, want string) error {
	got := nodeName(status)
	if got == "" || got == want {
		return nil
	}
	return fmt.Errorf("this node registered as %q, not %q: another node already holds that name, "+
		"so everything that dials %q — egress_allow entries, base URLs, the public hostname — reaches "+
		"that one and not this. Remove the node holding the name and start again", got, want, want)
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
	if err := verifyHostname(status, cfg.Hostname); err != nil {
		return err
	}
	// The name the tailnet gave, not the one that was asked for: they differ
	// exactly when something is wrong, and this line is where anyone looks.
	logf.Printf("joined tailnet as %s (%v) with tag %s", nodeName(status), status.TailscaleIPs, cfg.Tag)

	lc, err := ts.LocalClient()
	if err != nil {
		return fmt.Errorf("local client: %w", err)
	}

	tlsLn, err := ts.ListenTLS("tcp", ":443")
	if err != nil {
		return fmt.Errorf("tailnet listener: %w", err)
	}

	egressLn, err := listenUnix(cfg.EgressSocket, cfg.SocketGroup)
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
			Handler:  newPublicProxy(cfg.Funnel.UpstreamSocket, cfg.Funnel.PathPrefix, cfg.Funnel.RateLimit, logf),
			ErrorLog: logf,
		}
		servers = append(servers, serverListener{public, funnelLn, "public"})
		logf.Printf("funnel: serving %s to %s on the public internet, at most %.3g request(s)/s (burst %d)",
			cfg.Funnel.PathPrefix, cfg.Funnel.UpstreamSocket,
			cfg.Funnel.RateLimit.RequestsPerSecond, cfg.Funnel.RateLimit.Burst)
	}

	return serveUntilSignaled(ctx, logf, servers)
}

// listenUnix listens on path, replacing a stale socket and keeping other
// local users out: netd exists so that only tailnet peers reach agentd.
//
// With a group, the socket is 0660 and owned by it instead — one step wider,
// and deliberately: it is what lets netd and the process it fronts be
// different users, which is what lets a rule that works on uids tell them
// apart. Without one, nothing is shared and the mode stays 0600.
func listenUnix(path, group string) (net.Listener, error) {
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
	mode := os.FileMode(0o600)
	if group != "" {
		gid, err := lookupGroup(group)
		if err != nil {
			ln.Close()
			return nil, err
		}
		if err := os.Chown(path, -1, gid); err != nil {
			ln.Close()
			return nil, fmt.Errorf("chgrp %s to %s: %w", path, group, err)
		}
		mode = 0o660
	}
	if err := os.Chmod(path, mode); err != nil {
		ln.Close()
		return nil, fmt.Errorf("chmod %s: %w", path, err)
	}
	return ln, nil
}

// lookupGroup resolves a group name or numeric id. A group that does not
// exist is a startup failure rather than a socket nobody can reach.
func lookupGroup(group string) (int, error) {
	g, err := user.LookupGroup(group)
	if err != nil {
		var unknown user.UnknownGroupError
		if errors.As(err, &unknown) {
			if gid, convErr := strconv.Atoi(group); convErr == nil {
				return gid, nil
			}
		}
		return 0, fmt.Errorf("socket_group %q: %w", group, err)
	}
	gid, err := strconv.Atoi(g.Gid)
	if err != nil {
		return 0, fmt.Errorf("socket_group %q: gid %q is not a number: %w", group, g.Gid, err)
	}
	return gid, nil
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
