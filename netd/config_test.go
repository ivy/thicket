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
