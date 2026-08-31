package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Config is netd's per-account configuration, rendered by the provisioning
// CLI into $XDG_CONFIG_HOME/thicket/netd.json.
type Config struct {
	// Hostname is the tailnet node name, e.g. "thicket-hearth".
	Hostname string `json:"hostname"`
	// Tag is the ACL tag this node advertises, e.g. "tag:thicket-hearth".
	Tag string `json:"tag"`
	// AuthKeyFile is a file holding the tailnet auth key. The TS_AUTHKEY
	// environment variable takes precedence when set.
	AuthKeyFile string `json:"auth_key_file,omitempty"`
	// ControlURL overrides the coordination server (tests, headscale).
	ControlURL string `json:"control_url,omitempty"`
	// UpstreamSocket is the unix socket netd proxies inbound tailnet traffic
	// to — an agentd's, or the Slack bridge's in the account that runs it.
	// A bare name is resolved under the runtime directory, so a rendered
	// config is the same file whether the account runs as a user unit or a
	// system one; an absolute path is taken as written. Default: "agentd".
	UpstreamSocket string `json:"upstream_socket,omitempty"`
	// EgressSocket is the unix socket the outbound HTTP proxy listens on,
	// resolved the same way. Default: "netd-egress".
	EgressSocket string `json:"egress_socket,omitempty"`
	// StateDir holds tsnet state. Default: stateDir()/tsnet.
	StateDir string `json:"state_dir,omitempty"`
	// EgressAllow lists the destinations the egress proxy may reach: an
	// exact hostname, or "*.example.com" for the names under it. Nothing
	// is reachable until a rule names it, so an absent list is no egress.
	EgressAllow []string `json:"egress_allow,omitempty"`
	// SocketGroup, when set, owns netd's sockets at mode 0660 instead of
	// the default 0600. That is what lets netd and the process it fronts
	// run as different users — which is what lets a firewall rule tell
	// them apart, since they are otherwise one uid.
	SocketGroup string `json:"socket_group,omitempty"`
	// Funnel, when set, exposes one path prefix of one upstream to the
	// public internet on port 443 through Tailscale Funnel. The public
	// handler stamps no tags: an internet caller has none, and whatever
	// stands behind it authenticates its callers itself.
	Funnel *FunnelConfig `json:"funnel,omitempty"`

	// egressRules is EgressAllow, parsed and validated at load.
	egressRules []egressRule
}

// FunnelConfig is the public edge: which paths, and which socket they reach.
type FunnelConfig struct {
	// PathPrefix is the only prefix the public listener forwards, e.g. "/".
	// Anything else is refused before it is read.
	PathPrefix string `json:"path_prefix"`
	// UpstreamSocket is the unix socket the prefix is proxied to — the
	// phone bridge's, never agentd's. A bare name is resolved under the
	// runtime directory. Default: "phone".
	UpstreamSocket string `json:"upstream_socket,omitempty"`
	// RateLimit bounds what this listener will spend before anything is
	// proxied. Optional: the defaults hold without configuration.
	RateLimit *FunnelRateLimit `json:"rate_limit,omitempty"`
}

// FunnelRateLimit is the budget the public handler spends per second.
//
// It is one bucket for the whole listener rather than one per caller,
// because there are no callers to tell apart: Tailscale relays a Funnel
// connection in from its own fabric, so every request on this listener
// arrives from the same address whoever sent it. A per-source limit would
// be one bucket wearing a disguise.
type FunnelRateLimit struct {
	// RequestsPerSecond sustained. Default defaultFunnelRate.
	RequestsPerSecond float64 `json:"requests_per_second,omitempty"`
	// Burst absorbed above that rate. Default defaultFunnelBurst.
	Burst int `json:"burst,omitempty"`
}

// A phone call is a handful of requests and then one long-lived websocket,
// so these are generous for anything real and mean for anything sweeping.
const (
	defaultFunnelRate  = 5
	defaultFunnelBurst = 20
)

// resolveSocket turns a configured socket into a path. A bare name — no
// separator — is a component under the runtime directory, the same shape the
// defaults take, so a rendered config is portable between a user-unit account
// whose runtime directory is /run/user/<uid>/thicket and a system unit whose
// is /run/thicket. Anything with a separator is a path and is taken as
// written; empty means the default.
func resolveSocket(configured, fallback string) string {
	name := configured
	if name == "" {
		name = fallback
	}
	if strings.ContainsRune(name, filepath.Separator) {
		return name
	}
	return socketPath(name)
}

func defaultConfigPath() string {
	return filepath.Join(configDir(), "netd.json")
}

func loadConfig(path string) (*Config, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read config: %w", err)
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	var cfg Config
	if err := dec.Decode(&cfg); err != nil {
		return nil, fmt.Errorf("parse config %s: %w", path, err)
	}
	if cfg.Hostname == "" {
		return nil, fmt.Errorf("config %s: hostname is required", path)
	}
	if !strings.HasPrefix(cfg.Tag, "tag:") {
		return nil, fmt.Errorf("config %s: tag must start with \"tag:\", got %q", path, cfg.Tag)
	}
	cfg.UpstreamSocket = resolveSocket(cfg.UpstreamSocket, "agentd")
	cfg.EgressSocket = resolveSocket(cfg.EgressSocket, "netd-egress")
	if cfg.StateDir == "" {
		cfg.StateDir = filepath.Join(stateDir(), "tsnet")
	}
	rules, err := parseEgressAllow(cfg.EgressAllow)
	if err != nil {
		return nil, fmt.Errorf("config %s: %w", path, err)
	}
	cfg.egressRules = rules
	if cfg.Funnel != nil {
		if !strings.HasPrefix(cfg.Funnel.PathPrefix, "/") {
			return nil, fmt.Errorf("config %s: funnel.path_prefix must start with \"/\", got %q", path, cfg.Funnel.PathPrefix)
		}
		cfg.Funnel.UpstreamSocket = resolveSocket(cfg.Funnel.UpstreamSocket, "phone")
		if cfg.Funnel.UpstreamSocket == cfg.UpstreamSocket {
			return nil, fmt.Errorf("config %s: funnel.upstream_socket must not be agentd's socket; the internet never reaches an agent", path)
		}
		if cfg.Funnel.RateLimit == nil {
			cfg.Funnel.RateLimit = &FunnelRateLimit{}
		}
		if cfg.Funnel.RateLimit.RequestsPerSecond == 0 {
			cfg.Funnel.RateLimit.RequestsPerSecond = defaultFunnelRate
		}
		if cfg.Funnel.RateLimit.Burst == 0 {
			cfg.Funnel.RateLimit.Burst = defaultFunnelBurst
		}
		if cfg.Funnel.RateLimit.RequestsPerSecond < 0 || cfg.Funnel.RateLimit.Burst < 0 {
			return nil, fmt.Errorf("config %s: funnel.rate_limit values cannot be negative", path)
		}
	}
	return &cfg, nil
}

// authKey returns the tailnet auth key: TS_AUTHKEY wins, then AuthKeyFile.
func (c *Config) authKey() (string, error) {
	if k := os.Getenv("TS_AUTHKEY"); k != "" {
		return k, nil
	}
	if c.AuthKeyFile == "" {
		return "", fmt.Errorf("no auth key: set TS_AUTHKEY or auth_key_file")
	}
	raw, err := os.ReadFile(c.AuthKeyFile)
	if err != nil {
		return "", fmt.Errorf("read auth key: %w", err)
	}
	key := strings.TrimSpace(string(raw))
	if key == "" {
		return "", fmt.Errorf("auth key file %s is empty", c.AuthKeyFile)
	}
	return key, nil
}
