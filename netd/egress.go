package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strings"
	"time"

	"tailscale.com/ipn/ipnstate"
)

// The routes an admitted destination can take out of the account.
const (
	// routeTailnet leaves through tsnet, so the connection carries this
	// node's tailnet identity and the far end's WhoIs sees this tag.
	routeTailnet = "tailnet"
	// routeHost leaves through the host's network stack, for destinations
	// no tailnet node serves.
	routeHost = "host"
)

// hostDialTimeout bounds a dial on the host route: a destination that
// blackholes should fail the request rather than hold the caller open.
const hostDialTimeout = 30 * time.Second

// dialFunc is the shape shared by net.Dialer.DialContext and tsnet.Server.Dial.
type dialFunc func(ctx context.Context, network, addr string) (net.Conn, error)

// egressRule admits one destination: an exact hostname, or — with wildcard
// set — any subdomain of host, never host itself.
type egressRule struct {
	host     string
	wildcard bool
}

func (r egressRule) matches(host string) bool {
	if r.wildcard {
		return strings.HasSuffix(host, "."+r.host)
	}
	return host == r.host
}

func (r egressRule) String() string {
	if r.wildcard {
		return "*." + r.host
	}
	return r.host
}

// normalizeHost canonicalizes a hostname for comparison: names are
// case-insensitive, a trailing dot names the same host, and an IPv6 literal
// arrives bracketed inside an authority.
func normalizeHost(host string) string {
	h := strings.ToLower(strings.TrimSpace(host))
	h = strings.TrimSuffix(h, ".")
	h = strings.TrimPrefix(h, "[")
	return strings.TrimSuffix(h, "]")
}

// parseEgressAllow turns configured entries into rules, refusing the ones an
// operator could believe in but that could never admit anything: a URL, a
// port, an address, a wildcard with no domain under it. The allowlist is
// rendered, so a rule that cannot match is a generator bug and says so early.
func parseEgressAllow(entries []string) ([]egressRule, error) {
	rules := make([]egressRule, 0, len(entries))
	for _, entry := range entries {
		normalized := normalizeHost(entry)
		if normalized == "" {
			return nil, errors.New("egress_allow: empty entry")
		}
		rule := egressRule{host: normalized}
		if under, ok := strings.CutPrefix(normalized, "*."); ok {
			rule = egressRule{host: under, wildcard: true}
		}
		switch {
		case normalized == "*", rule.host == "":
			return nil, fmt.Errorf("egress_allow %q: a wildcard needs a domain under it, e.g. \"*.example.com\"", entry)
		case net.ParseIP(rule.host) != nil:
			return nil, fmt.Errorf("egress_allow %q: egress destinations are names, never addresses", entry)
		case strings.ContainsAny(rule.host, "/:*"):
			return nil, fmt.Errorf("egress_allow %q: expected a hostname with an optional leading \"*.\" — no scheme, port or path", entry)
		}
		rules = append(rules, rule)
	}
	return rules, nil
}

// egressPolicy is an account's entire outbound network permission: which
// destinations may be reached, and which route carries each. Nothing is
// reachable until a rule names it, so an account whose config lists no
// egress_allow has no egress at all — which is the point, for a process
// whose only way out is this proxy.
type egressPolicy struct {
	rules []egressRule
	// magicDNSSuffix is this tailnet's MagicDNS suffix, e.g.
	// "example-tailnet.ts.net". Names under it, and short MagicDNS names,
	// take the tailnet route.
	magicDNSSuffix string
	tailnetDial    dialFunc
	hostDial       dialFunc
}

func newEgressPolicy(rules []egressRule, magicDNSSuffix string, tailnetDial dialFunc) *egressPolicy {
	return &egressPolicy{
		rules:          rules,
		magicDNSSuffix: normalizeHost(magicDNSSuffix),
		tailnetDial:    tailnetDial,
		hostDial:       (&net.Dialer{Timeout: hostDialTimeout}).DialContext,
	}
}

// decide reports the rule that admits hostname and the route that will carry
// it, or an error saying why the destination is refused. The error is the
// audit record: it names what was asked for and the rule outcome that
// refused it.
func (p *egressPolicy) decide(hostname string) (rule, route string, err error) {
	host := normalizeHost(hostname)
	switch {
	case host == "":
		return "", "", errors.New("request names no destination host")
	case net.ParseIP(host) != nil:
		// A name is what a rule can be written about, and netd resolves it
		// itself so the calling process never handles DNS.
		return "", "", fmt.Errorf("%s is an address, not a name: egress destinations are named and resolved by netd", host)
	case len(p.rules) == 0:
		return "", "", errors.New("egress_allow is empty: this account has no egress")
	}
	for _, r := range p.rules {
		if r.matches(host) {
			return r.String(), p.route(host), nil
		}
	}
	return "", "", fmt.Errorf("no egress_allow rule admits %s", host)
}

// route picks how an admitted host is reached. A short MagicDNS name, or one
// under this tailnet's suffix, is a tailnet node: dialing it through tsnet is
// what makes the connection carry this account's tag rather than the host's.
func (p *egressPolicy) route(host string) string {
	if !strings.Contains(host, ".") {
		return routeTailnet
	}
	if p.magicDNSSuffix != "" && strings.HasSuffix(host, "."+p.magicDNSSuffix) {
		return routeTailnet
	}
	return routeHost
}

// dial applies the policy again at the dial itself, so no path reaches the
// network without passing the allowlist and the route cannot drift from the
// one the handler logged.
func (p *egressPolicy) dial(ctx context.Context, network, addr string) (net.Conn, error) {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, fmt.Errorf("egress dial %q: %w", addr, err)
	}
	_, route, err := p.decide(host)
	if err != nil {
		return nil, err
	}
	if route == routeTailnet {
		return p.tailnetDial(ctx, network, addr)
	}
	return p.hostDial(ctx, network, addr)
}

// summary is the startup line: everything this account may reach, in one
// place, so a later refusal can be read against what was configured.
func (p *egressPolicy) summary() string {
	if len(p.rules) == 0 {
		return "no destination allowed (egress_allow is empty)"
	}
	names := make([]string, 0, len(p.rules))
	for _, r := range p.rules {
		names = append(names, r.String())
	}
	return "allowing " + strings.Join(names, ", ")
}

// tailnetSuffix reports the MagicDNS suffix of the tailnet this node joined,
// which is what tells a tailnet destination from a public one.
func tailnetSuffix(status *ipnstate.Status) string {
	if status == nil || status.CurrentTailnet == nil {
		return ""
	}
	return status.CurrentTailnet.MagicDNSSuffix
}
