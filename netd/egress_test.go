package main

import (
	"context"
	"log"
	"net"
	"strings"
	"sync"
	"testing"
)

// namedPolicy builds a policy over allow whose dials all land on addr,
// whatever name was asked for, and records the route each one took. It is
// how a test addresses a local server by name and still asserts which way
// out the policy chose.
func namedPolicy(t *testing.T, allow []string, suffix, addr string) (*egressPolicy, func() []string) {
	t.Helper()
	rules, err := parseEgressAllow(allow)
	if err != nil {
		t.Fatalf("parseEgressAllow(%v): %v", allow, err)
	}
	var mu sync.Mutex
	var routes []string
	dialer := func(route string) dialFunc {
		return func(ctx context.Context, network, _ string) (net.Conn, error) {
			mu.Lock()
			routes = append(routes, route)
			mu.Unlock()
			var d net.Dialer
			return d.DialContext(ctx, network, addr)
		}
	}
	policy := newEgressPolicy(rules, suffix, dialer(routeTailnet))
	policy.hostDial = dialer(routeHost)
	return policy, func() []string {
		mu.Lock()
		defer mu.Unlock()
		return append([]string(nil), routes...)
	}
}

// bufferLogger captures what netd logged, because the audit trail is part of
// the contract: a refusal nobody can read is not one anybody can act on.
func bufferLogger() (*log.Logger, func() string) {
	w := &lockedWriter{}
	return log.New(w, "netd: ", 0), w.String
}

type lockedWriter struct {
	mu sync.Mutex
	sb strings.Builder
}

func (l *lockedWriter) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.sb.Write(p)
}

func (l *lockedWriter) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.sb.String()
}

func TestParseEgressAllowRejectsRulesThatCouldNeverMatch(t *testing.T) {
	for _, tc := range []struct{ entry, want string }{
		{"", "empty entry"},
		{"   ", "empty entry"},
		{"https://api.example.com", "no scheme, port or path"},
		{"api.example.com:443", "no scheme, port or path"},
		{"api.example.com/files", "no scheme, port or path"},
		{"*", "wildcard needs a domain"},
		{"*.", "wildcard needs a domain"},
		{"example.*", "no scheme, port or path"},
		{"93.184.216.34", "never addresses"},
		{"2001:db8::1", "never addresses"},
	} {
		_, err := parseEgressAllow([]string{tc.entry})
		if err == nil {
			t.Errorf("parseEgressAllow(%q) accepted the entry, want an error", tc.entry)
			continue
		}
		if !strings.Contains(err.Error(), tc.want) {
			t.Errorf("parseEgressAllow(%q) = %v, want an error mentioning %q", tc.entry, err, tc.want)
		}
	}
}

func TestParseEgressAllowNormalizes(t *testing.T) {
	rules, err := parseEgressAllow([]string{"API.Example.COM.", "*.Slack.com"})
	if err != nil {
		t.Fatal(err)
	}
	if len(rules) != 2 {
		t.Fatalf("rules = %v, want 2", rules)
	}
	if got := rules[0].String(); got != "api.example.com" {
		t.Errorf("rule 0 = %q, want api.example.com", got)
	}
	if got := rules[1].String(); got != "*.slack.com" {
		t.Errorf("rule 1 = %q, want *.slack.com", got)
	}
}

func TestEgressPolicyAdmitsOnlyWhatARuleNames(t *testing.T) {
	policy, _ := namedPolicy(t, []string{"api.example.com", "*.slack.com"}, "example-tailnet.ts.net", "")

	for _, host := range []string{"api.example.com", "API.example.com", "api.example.com.", "wss-primary.slack.com", "a.b.slack.com"} {
		if _, _, err := policy.decide(host); err != nil {
			t.Errorf("decide(%q) = %v, want admitted", host, err)
		}
	}

	for _, tc := range []struct{ host, want string }{
		{"example.com", "no egress_allow rule admits"},
		{"slack.com", "no egress_allow rule admits"},
		{"evilslack.com", "no egress_allow rule admits"},
		{"api.example.com.evil.test", "no egress_allow rule admits"},
		{"93.184.216.34", "is an address, not a name"},
		{"2001:db8::1", "is an address, not a name"},
		{"[2001:db8::1]", "is an address, not a name"},
		{"", "names no destination host"},
	} {
		_, _, err := policy.decide(tc.host)
		if err == nil {
			t.Errorf("decide(%q) admitted the destination, want refusal", tc.host)
			continue
		}
		if !strings.Contains(err.Error(), tc.want) {
			t.Errorf("decide(%q) = %v, want an error mentioning %q", tc.host, err, tc.want)
		}
	}
}

func TestEgressPolicyWithNoRulesRefusesEverything(t *testing.T) {
	policy, _ := namedPolicy(t, nil, "example-tailnet.ts.net", "")
	_, _, err := policy.decide("api.example.com")
	if err == nil || !strings.Contains(err.Error(), "egress_allow is empty") {
		t.Fatalf("decide with no rules = %v, want an error naming the empty allowlist", err)
	}
	if got := policy.summary(); !strings.Contains(got, "no destination allowed") {
		t.Errorf("summary() = %q, want it to say nothing is allowed", got)
	}
}

func TestEgressPolicyRoutesTailnetNamesThroughTsnet(t *testing.T) {
	policy, _ := namedPolicy(t, nil, "example-tailnet.ts.net", "")
	for host, want := range map[string]string{
		"thicket-bridge":                          routeTailnet,
		"thicket-bridge.example-tailnet.ts.net":   routeTailnet,
		"api.example.com":                         routeHost,
		"thicket-bridge.other-tailnet.ts.net":     routeHost,
		"thicket-bridge.example-tailnet.ts.net.x": routeHost,
	} {
		if got := policy.route(host); got != want {
			t.Errorf("route(%q) = %q, want %q", host, got, want)
		}
	}
}

// Without a MagicDNS suffix netd cannot tell a tailnet FQDN from a public
// one, so only short names take the tailnet route. netd says so at startup.
func TestEgressPolicyWithoutASuffixRoutesOnlyShortNamesToTheTailnet(t *testing.T) {
	policy, _ := namedPolicy(t, nil, "", "")
	if got := policy.route("thicket-bridge"); got != routeTailnet {
		t.Errorf("route(short name) = %q, want %q", got, routeTailnet)
	}
	if got := policy.route("thicket-bridge.example-tailnet.ts.net"); got != routeHost {
		t.Errorf("route(fqdn) = %q, want %q", got, routeHost)
	}
}

// The dialer enforces the policy on its own: whatever reaches it — a pooled
// connection, a future caller — cannot leave for a destination no rule names.
func TestEgressPolicyDialRefusesWhatNoRuleAdmits(t *testing.T) {
	policy, routes := namedPolicy(t, []string{"api.example.com"}, "example-tailnet.ts.net", "127.0.0.1:1")
	if _, err := policy.dial(context.Background(), "tcp", "evil.test:443"); err == nil {
		t.Fatal("dial to an unlisted destination succeeded, want refusal")
	}
	if _, err := policy.dial(context.Background(), "tcp", "93.184.216.34:443"); err == nil {
		t.Fatal("dial to an address literal succeeded, want refusal")
	}
	if got := routes(); len(got) != 0 {
		t.Fatalf("refused dials still chose a route: %v", got)
	}
}
