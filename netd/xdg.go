package main

import (
	"os"
	"path/filepath"
	"strconv"
)

const app = "thicket"

// xdgDir returns the value of envVar if it is set, non-empty, and absolute;
// per the XDG base directory spec anything else must be ignored.
func xdgDir(envVar string) (string, bool) {
	v := os.Getenv(envVar)
	if v != "" && filepath.IsAbs(v) {
		return v, true
	}
	return "", false
}

func configDir() string {
	if d, ok := xdgDir("XDG_CONFIG_HOME"); ok {
		return filepath.Join(d, app)
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".config", app)
}

func stateDir() string {
	if d, ok := xdgDir("XDG_STATE_HOME"); ok {
		return filepath.Join(d, app)
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".local", "state", app)
}

func runtimeDir() string {
	if d, ok := xdgDir("XDG_RUNTIME_DIR"); ok {
		return filepath.Join(d, app)
	}
	return filepath.Join(os.TempDir(), app+"-"+strconv.Itoa(os.Getuid()))
}

func socketPath(component string) string {
	return filepath.Join(runtimeDir(), component+".sock")
}
