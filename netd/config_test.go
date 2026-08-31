package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeConfig(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "netd.json")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestLoadConfigAppliesDefaults(t *testing.T) {
	cfg, err := loadConfig(writeConfig(t, `{"hostname": "thicket-hearth", "tag": "tag:thicket-hearth"}`))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.UpstreamSocket != socketPath("agentd") {
		t.Errorf("UpstreamSocket = %q, want %q", cfg.UpstreamSocket, socketPath("agentd"))
	}
	if cfg.EgressSocket != socketPath("netd-egress") {
		t.Errorf("EgressSocket = %q, want %q", cfg.EgressSocket, socketPath("netd-egress"))
	}
	if cfg.StateDir != filepath.Join(stateDir(), "tsnet") {
		t.Errorf("StateDir = %q, want %q", cfg.StateDir, filepath.Join(stateDir(), "tsnet"))
	}
}

func TestLoadConfigRejectsBadInput(t *testing.T) {
	cases := map[string]string{
		"missing hostname":   `{"tag": "tag:thicket-hearth"}`,
		"tag without prefix": `{"hostname": "h", "tag": "thicket-hearth"}`,
		"unknown field":      `{"hostname": "h", "tag": "tag:thicket-h", "bogus": true}`,
	}
	for name, content := range cases {
		if _, err := loadConfig(writeConfig(t, content)); err == nil {
			t.Errorf("%s: config accepted, want error", name)
		}
	}
}

func TestAuthKeyPrecedence(t *testing.T) {
	keyFile := filepath.Join(t.TempDir(), "key")
	if err := os.WriteFile(keyFile, []byte("tskey-from-file\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg := &Config{AuthKeyFile: keyFile}

	t.Setenv("TS_AUTHKEY", "tskey-from-env")
	if key, err := cfg.authKey(); err != nil || key != "tskey-from-env" {
		t.Errorf("authKey with env = %q, %v; want tskey-from-env", key, err)
	}

	t.Setenv("TS_AUTHKEY", "")
	if key, err := cfg.authKey(); err != nil || key != "tskey-from-file" {
		t.Errorf("authKey from file = %q, %v; want tskey-from-file (trimmed)", key, err)
	}

	none := &Config{}
	if _, err := none.authKey(); err == nil || !strings.Contains(err.Error(), "TS_AUTHKEY") {
		t.Errorf("authKey with no source = %v; want error mentioning TS_AUTHKEY", err)
	}
}

func TestFunnelSectionIsValidated(t *testing.T) {
	write := func(body string) string {
		path := filepath.Join(t.TempDir(), "netd.json")
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		return path
	}
	base := `"hostname": "thicket-phone", "tag": "tag:thicket-phone", "upstream_socket": "/run/agentd.sock"`

	cfg, err := loadConfig(write(`{` + base + `, "funnel": {"path_prefix": "/", "upstream_socket": "/run/phone.sock"}}`))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Funnel == nil || cfg.Funnel.PathPrefix != "/" || cfg.Funnel.UpstreamSocket != "/run/phone.sock" {
		t.Errorf("funnel section not loaded: %+v", cfg.Funnel)
	}

	cfg, err = loadConfig(write(`{` + base + `}`))
	if err != nil || cfg.Funnel != nil {
		t.Errorf("without a section Funnel must be nil: %+v, %v", cfg.Funnel, err)
	}

	for body, want := range map[string]string{
		`{` + base + `, "funnel": {"path_prefix": "voice", "upstream_socket": "/run/phone.sock"}}`:     `path_prefix must start with "/"`,
		`{` + base + `, "funnel": {"path_prefix": "/", "upstream_socket": "/run/agentd.sock"}}`:        "must not be agentd's socket",
		`{` + base + `, "funnel": {"path_prefix": "/", "upstream_socket": "/run/phone.sock", "x": 1}}`: "unknown field",
	} {
		_, err := loadConfig(write(body))
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%s: err = %v, want %q", body, err, want)
		}
	}
}

func TestSocketGroupIsOptional(t *testing.T) {
	cfg, err := loadConfig(writeConfig(t, `{"hostname": "h", "tag": "tag:thicket-h"}`))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.SocketGroup != "" {
		t.Errorf("SocketGroup = %q, want empty by default", cfg.SocketGroup)
	}

	cfg, err = loadConfig(writeConfig(t, `{"hostname": "h", "tag": "tag:thicket-h", "socket_group": "thicket"}`))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.SocketGroup != "thicket" {
		t.Errorf("SocketGroup = %q, want thicket", cfg.SocketGroup)
	}
}
