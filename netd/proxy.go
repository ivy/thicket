package main

import (
	"context"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/textproto"
	"strings"
	"sync"
	"time"

	"golang.org/x/time/rate"
)

// PeerTagsHeader carries the caller's WhoIs-verified ACL tags to agentd.
// netd is the only writer: any inbound X-Thicket-* header is discarded.
const PeerTagsHeader = "X-Thicket-Peer-Tags"

const thicketHeaderPrefix = "X-Thicket-"

// peerIdentifier reports the verified ACL tags of the peer behind a
// remote address. Production wires this to tsnet's LocalClient WhoIs.
type peerIdentifier interface {
	PeerTags(ctx context.Context, remoteAddr string) ([]string, error)
}

func stripThicketHeaders(h http.Header) {
	for k := range h {
		if strings.HasPrefix(textproto.CanonicalMIMEHeaderKey(k), thicketHeaderPrefix) {
			h.Del(k)
		}
	}
}

// newInboundProxy proxies tailnet requests to agentd's unix socket,
// stamping each with the caller's verified peer tags.
func newInboundProxy(upstreamSocket string, ident peerIdentifier, logf *log.Logger) http.Handler {
	transport := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "unix", upstreamSocket)
		},
	}
	rp := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			u := *pr.In.URL
			u.Scheme = "http"
			// The transport dials the unix socket regardless; this host is
			// only a placeholder for URL formatting.
			u.Host = "agentd"
			pr.Out.URL = &u
			pr.Out.Host = pr.In.Host
		},
		Transport:     transport,
		ErrorLog:      logf,
		FlushInterval: -1, // flush immediately: A2A streams over SSE
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tags, err := ident.PeerTags(r.Context(), r.RemoteAddr)
		if err != nil {
			logf.Printf("inbound: whois %s failed: %v", r.RemoteAddr, err)
			http.Error(w, "peer identity unavailable", http.StatusBadGateway)
			return
		}
		r2 := r.Clone(r.Context())
		stripThicketHeaders(r2.Header)
		r2.Header.Set(PeerTagsHeader, strings.Join(tags, ","))
		rp.ServeHTTP(w, r2)
	})
}

// newPublicProxy fronts the Funnel listener: requests under pathPrefix are
// proxied to the upstream socket with every X-Thicket-* header removed and
// nothing stamped in their place — an internet caller has no tags, and a
// bridge behind this handler authenticates its callers by other means.
// Anything outside the prefix is refused without touching the upstream.
// WebSocket upgrades ride through the reverse proxy unchanged.
func newPublicProxy(upstreamSocket, pathPrefix string, limit *FunnelRateLimit, logf *log.Logger) http.Handler {
	budget := newPublicBudget(limit, logf)
	transport := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "unix", upstreamSocket)
		},
	}
	rp := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			u := *pr.In.URL
			u.Scheme = "http"
			u.Host = "phone"
			pr.Out.URL = &u
			pr.Out.Host = pr.In.Host
		},
		Transport:     transport,
		ErrorLog:      logf,
		FlushInterval: -1,
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Before the path is even looked at: a request outside the prefix
		// still costs something to refuse, and a scanner sends nothing else.
		if !budget.allow() {
			w.Header().Set("Retry-After", "1")
			http.Error(w, "too many requests", http.StatusTooManyRequests)
			return
		}
		if !strings.HasPrefix(r.URL.Path, pathPrefix) {
			logf.Printf("public: refused %s %s from %s", r.Method, r.URL.Path, r.RemoteAddr)
			http.NotFound(w, r)
			return
		}
		r2 := r.Clone(r.Context())
		stripThicketHeaders(r2.Header)
		rp.ServeHTTP(w, r2)
	})
}

// howOftenBurstsAreSummarised bounds what a scan can write to the journal:
// one line per interval however many requests arrive in it.
const howOftenBurstsAreSummarised = time.Minute

// publicBudget is what the Funnel listener will spend before anything is
// proxied. The point is where the cost lands: a refusal here is a token and
// a status code in Go, and the JavaScript upstream never learns the request
// happened.
//
// One bucket for the listener, not one per caller. Tailscale relays a Funnel
// connection in from its own fabric, so every request arrives from the same
// address whoever sent it — there is nobody to tell apart, and a per-source
// limit would be this same bucket wearing a disguise.
type publicBudget struct {
	limiter *rate.Limiter
	logf    *log.Logger

	mu       sync.Mutex
	refused  int
	reported time.Time
}

func newPublicBudget(limit *FunnelRateLimit, logf *log.Logger) *publicBudget {
	if limit == nil {
		limit = &FunnelRateLimit{RequestsPerSecond: defaultFunnelRate, Burst: defaultFunnelBurst}
	}
	return &publicBudget{
		limiter: rate.NewLimiter(rate.Limit(limit.RequestsPerSecond), limit.Burst),
		logf:    logf,
	}
}

func (b *publicBudget) allow() bool {
	if b.limiter.Allow() {
		return true
	}
	b.noteRefusal()
	return false
}

// noteRefusal counts every refusal and reports at most one line per
// interval. A scan that can fill the journal has denied the operator the
// one place they would look to find out about it.
func (b *publicBudget) noteRefusal() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.refused++
	now := time.Now()
	if !b.reported.IsZero() && now.Sub(b.reported) < howOftenBurstsAreSummarised {
		return
	}
	b.logf.Printf("public: rate limit refused %d request(s) since %s",
		b.refused, b.sinceLocked(now))
	b.refused = 0
	b.reported = now
}

func (b *publicBudget) sinceLocked(now time.Time) string {
	if b.reported.IsZero() {
		return "this listener started"
	}
	return now.Sub(b.reported).Truncate(time.Second).String() + " ago"
}

// egressHost returns the destination hostname a request names — the
// authority for CONNECT, the URL's host otherwise — without its port.
func egressHost(r *http.Request) string {
	if r.Method != http.MethodConnect {
		return r.URL.Hostname()
	}
	if host, _, err := net.SplitHostPort(r.Host); err == nil {
		return host
	}
	return r.Host
}

// egressTarget is what the audit line records: the authority for CONNECT,
// the full URL otherwise.
func egressTarget(r *http.Request) string {
	if r.Method == http.MethodConnect {
		return r.Host
	}
	return r.URL.String()
}

// newEgressProxy is an HTTP forward proxy (absolute-form requests and
// CONNECT tunnels) for a process that has no network of its own. It is a
// policy point rather than a relay: the destination of every request is put
// to the account's egress policy, allowed and refused alike are logged, and
// the connection leaves by the route the policy chose — in production
// tsnet's Dial for tailnet names, so they carry this node's identity.
func newEgressProxy(policy *egressPolicy, logf *log.Logger) http.Handler {
	transport := &http.Transport{DialContext: policy.dial}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodConnect && !r.URL.IsAbs() {
			http.Error(w, "egress proxy requires absolute-form request URIs or CONNECT", http.StatusBadRequest)
			return
		}
		target := egressTarget(r)
		rule, route, err := policy.decide(egressHost(r))
		if err != nil {
			logf.Printf("egress: deny %s %s: %v", r.Method, target, err)
			http.Error(w, "egress destination not allowed", http.StatusForbidden)
			return
		}
		logf.Printf("egress: allow %s %s (rule %s, route %s)", r.Method, target, rule, route)
		if r.Method == http.MethodConnect {
			handleConnect(w, r, policy.dial, logf)
			return
		}
		out := r.Clone(r.Context())
		out.RequestURI = ""
		removeHopByHopHeaders(out.Header)
		resp, err := transport.RoundTrip(out)
		if err != nil {
			logf.Printf("egress: %s %s: %v", r.Method, r.URL, err)
			http.Error(w, "egress dial failed", http.StatusBadGateway)
			return
		}
		defer resp.Body.Close()
		removeHopByHopHeaders(resp.Header)
		copyHeader(w.Header(), resp.Header)
		w.WriteHeader(resp.StatusCode)
		if err := copyFlushing(w, resp.Body); err != nil {
			logf.Printf("egress: copying response for %s: %v", r.URL, err)
		}
	})
}

func handleConnect(w http.ResponseWriter, r *http.Request, dial func(ctx context.Context, network, addr string) (net.Conn, error), logf *log.Logger) {
	target, err := dial(r.Context(), "tcp", r.Host)
	if err != nil {
		logf.Printf("egress: CONNECT %s: %v", r.Host, err)
		http.Error(w, "egress dial failed", http.StatusBadGateway)
		return
	}
	defer target.Close()

	hj, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "hijacking unsupported", http.StatusInternalServerError)
		return
	}
	client, brw, err := hj.Hijack()
	if err != nil {
		logf.Printf("egress: CONNECT hijack: %v", err)
		return
	}
	defer client.Close()

	if _, err := brw.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n"); err != nil {
		return
	}
	if err := brw.Flush(); err != nil {
		return
	}

	done := make(chan struct{}, 2)
	go func() { io.Copy(target, brw); done <- struct{}{} }()
	go func() { io.Copy(client, target); done <- struct{}{} }()
	<-done
}

// copyFlushing streams body to w, flushing after every read so
// server-sent events reach the client as they are produced.
func copyFlushing(w http.ResponseWriter, body io.Reader) error {
	flusher, _ := w.(http.Flusher)
	buf := make([]byte, 32*1024)
	for {
		n, err := body.Read(buf)
		if n > 0 {
			if _, werr := w.Write(buf[:n]); werr != nil {
				return werr
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
		if err != nil {
			if err == io.EOF {
				return nil
			}
			return err
		}
	}
}

func copyHeader(dst, src http.Header) {
	for k, vv := range src {
		for _, v := range vv {
			dst.Add(k, v)
		}
	}
}

// removeHopByHopHeaders per RFC 9110 §7.6.1, including those nominated by
// the Connection header.
func removeHopByHopHeaders(h http.Header) {
	for _, f := range h.Values("Connection") {
		for _, sf := range strings.Split(f, ",") {
			if sf = textproto.TrimString(sf); sf != "" {
				h.Del(sf)
			}
		}
	}
	for _, k := range []string{
		"Connection", "Proxy-Connection", "Keep-Alive", "Proxy-Authenticate",
		"Proxy-Authorization", "Te", "Trailer", "Transfer-Encoding", "Upgrade",
	} {
		h.Del(k)
	}
}
