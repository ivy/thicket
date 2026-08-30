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
func newPublicProxy(upstreamSocket, pathPrefix string, logf *log.Logger) http.Handler {
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

// newEgressProxy is an HTTP forward proxy (absolute-form requests and
// CONNECT tunnels) whose upstream connections are made through dial —
// in production, tsnet's Dial, so outbound traffic carries this node's
// tailnet identity.
func newEgressProxy(dial func(ctx context.Context, network, addr string) (net.Conn, error), logf *log.Logger) http.Handler {
	transport := &http.Transport{DialContext: dial}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodConnect {
			handleConnect(w, r, dial, logf)
			return
		}
		if !r.URL.IsAbs() {
			http.Error(w, "egress proxy requires absolute-form request URIs or CONNECT", http.StatusBadRequest)
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
