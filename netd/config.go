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
	// UpstreamSocket is agentd's unix socket. Default: socketPath("agentd").
	UpstreamSocket string `json:"upstream_socket,omitempty"`
	// EgressSocket is the unix socket the outbound HTTP proxy listens on.
	// Default: socketPath("netd-egress").
	EgressSocket string `json:"egress_socket,omitempty"`
	// StateDir holds tsnet state. Default: stateDir()/tsnet.
	StateDir string `json:"state_dir,omitempty"`
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
	if cfg.UpstreamSocket == "" {
		cfg.UpstreamSocket = socketPath("agentd")
	}
	if cfg.EgressSocket == "" {
		cfg.EgressSocket = socketPath("netd-egress")
	}
	if cfg.StateDir == "" {
		cfg.StateDir = filepath.Join(stateDir(), "tsnet")
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
