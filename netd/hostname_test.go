package main

import (
	"strings"
	"testing"

	"tailscale.com/ipn/ipnstate"
)

func statusNamed(dnsName string) *ipnstate.Status {
	return &ipnstate.Status{Self: &ipnstate.PeerStatus{DNSName: dnsName}}
}

// A node given a different name than it asked for is the failure that hides
// itself: everything dialing the configured name reaches the node that
// already holds it, and nothing about that looks like a naming problem.
func TestHostnameMustBeTheOneAskedFor(t *testing.T) {
	if err := verifyHostname(statusNamed("thicket-bridge.tail42.ts.net."), "thicket-bridge"); err != nil {
		t.Errorf("the name it asked for was refused: %v", err)
	}

	err := verifyHostname(statusNamed("thicket-bridge-1.tail42.ts.net."), "thicket-bridge")
	if err == nil {
		t.Fatal("a suffixed registration was accepted")
	}
	// The message has to carry both names: the one in every config file, and
	// the one this node actually answers to.
	for _, want := range []string{"thicket-bridge-1", "thicket-bridge", "already holds that name"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("message does not mention %q: %v", want, err)
		}
	}

	// A tailnet that publishes no name for the node says nothing either way,
	// and is not a reason to refuse to run.
	if err := verifyHostname(statusNamed(""), "thicket-bridge"); err != nil {
		t.Errorf("an absent MagicDNS name was treated as a mismatch: %v", err)
	}
	if err := verifyHostname(&ipnstate.Status{}, "thicket-bridge"); err != nil {
		t.Errorf("a status with no self was treated as a mismatch: %v", err)
	}
}

func TestNodeNameIsTheFirstLabel(t *testing.T) {
	for dnsName, want := range map[string]string{
		"thicket-phone-1.tail42.ts.net.": "thicket-phone-1",
		"thicket-ivy.tail42.ts.net":      "thicket-ivy",
		"":                               "",
	} {
		if got := nodeName(statusNamed(dnsName)); got != want {
			t.Errorf("nodeName(%q) = %q, want %q", dnsName, got, want)
		}
	}
}
