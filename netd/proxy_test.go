package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func testLogger(t *testing.T) *log.Logger {
	return log.New(testWriter{t}, "", 0)
}

type testWriter struct{ t *testing.T }

func (w testWriter) Write(p []byte) (int, error) {
	w.t.Log(strings.TrimSuffix(string(p), "\n"))
	return len(p), nil
}

type fakeIdentifier struct {
	tags []string
	err  error
}

func (f *fakeIdentifier) PeerTags(context.Context, string) ([]string, error) {
	return f.tags, f.err
}

// shortSocketPath returns a unix socket path short enough for macOS's
// 104-byte sun_path limit; t.TempDir can exceed it.
func shortSocketPath(t *testing.T, name string) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "netd")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	return filepath.Join(dir, name)
}

// echoServer serves on a unix socket, reporting received headers as JSON.
func echoServer(t *testing.T, socket string) {
	t.Helper()
	ln, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Upstream", "echo")
		json.NewEncoder(w).Encode(map[string]any{
			"host":    r.Host,
			"path":    r.URL.Path,
			"headers": r.Header,
		})
	})}
	go srv.Serve(ln)
	t.Cleanup(func() { srv.Close() })
}

func getJSON(t *testing.T, client *http.Client, req *http.Request) (status int, hdr http.Header, body map[string]any) {
	t.Helper()
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode == http.StatusOK {
		if err := json.Unmarshal(raw, &body); err != nil {
			t.Fatalf("unmarshal %q: %v", raw, err)
		}
	}
	return resp.StatusCode, resp.Header, body
}

func upstreamHeaders(t *testing.T, body map[string]any) map[string][]string {
	t.Helper()
	raw, err := json.Marshal(body["headers"])
	if err != nil {
		t.Fatal(err)
	}
	var hdr map[string][]string
	if err := json.Unmarshal(raw, &hdr); err != nil {
		t.Fatal(err)
	}
	return hdr
}

func TestInboundProxyStampsVerifiedPeerTags(t *testing.T) {
	socket := shortSocketPath(t, "agentd.sock")
	echoServer(t, socket)

	ident := &fakeIdentifier{tags: []string{"tag:thicket-caller", "tag:extra"}}
	front := httptest.NewServer(newInboundProxy(socket, ident, testLogger(t)))
	defer front.Close()

	req, _ := http.NewRequest("GET", front.URL+"/a2a/v1", nil)
	status, hdr, body := getJSON(t, front.Client(), req)
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200", status)
	}
	if got := hdr.Get("X-Upstream"); got != "echo" {
		t.Errorf("upstream response header not returned; X-Upstream = %q", got)
	}
	up := upstreamHeaders(t, body)
	if got := up[PeerTagsHeader]; len(got) != 1 || got[0] != "tag:thicket-caller,tag:extra" {
		t.Errorf("%s = %v, want [tag:thicket-caller,tag:extra]", PeerTagsHeader, got)
	}
	if body["path"] != "/a2a/v1" {
		t.Errorf("path = %v, want /a2a/v1", body["path"])
	}
}

func TestInboundProxyDiscardsForgedThicketHeaders(t *testing.T) {
	socket := shortSocketPath(t, "agentd.sock")
	echoServer(t, socket)

	ident := &fakeIdentifier{tags: []string{"tag:thicket-caller"}}
	front := httptest.NewServer(newInboundProxy(socket, ident, testLogger(t)))
	defer front.Close()

	req, _ := http.NewRequest("GET", front.URL+"/", nil)
	req.Header.Set("X-Thicket-Peer-Tags", "tag:thicket-admin")
	req.Header.Set("x-thicket-anything", "spoofed")
	req.Header.Set("X-Innocent", "kept")

	_, _, body := getJSON(t, front.Client(), req)
	up := upstreamHeaders(t, body)
	if got := up[PeerTagsHeader]; len(got) != 1 || got[0] != "tag:thicket-caller" {
		t.Errorf("%s = %v, want only the WhoIs result [tag:thicket-caller]", PeerTagsHeader, got)
	}
	for k := range up {
		if strings.HasPrefix(k, thicketHeaderPrefix) && k != PeerTagsHeader {
			t.Errorf("forged header %s reached upstream", k)
		}
	}
	if got := up["X-Innocent"]; len(got) != 1 || got[0] != "kept" {
		t.Errorf("X-Innocent = %v, want [kept]", got)
	}
}

func TestInboundProxyRejectsWhenIdentityUnavailable(t *testing.T) {
	socket := shortSocketPath(t, "agentd.sock")
	echoServer(t, socket)

	ident := &fakeIdentifier{err: fmt.Errorf("no such peer")}
	front := httptest.NewServer(newInboundProxy(socket, ident, testLogger(t)))
	defer front.Close()

	resp, err := front.Client().Get(front.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", resp.StatusCode)
	}
}

// A request that arrives before agentd exists is refused, and the next one
// after it comes up is served — by the same proxy, with nothing restarted in
// between. The systemd units order nothing against agentd because of this, so
// it is a deployment contract rather than an implementation detail: the dial
// has to stay inside DialContext, once per request.
func TestInboundProxyServesOnceTheUpstreamAppears(t *testing.T) {
	socket := shortSocketPath(t, "agentd.sock")
	ident := &fakeIdentifier{tags: []string{"tag:thicket-bridge"}}
	front := httptest.NewServer(newInboundProxy(socket, ident, testLogger(t)))
	defer front.Close()

	req, _ := http.NewRequest("GET", front.URL+"/a2a/v1", nil)
	if status, _, _ := getJSON(t, front.Client(), req); status != http.StatusBadGateway {
		t.Fatalf("status with no upstream = %d, want 502", status)
	}

	echoServer(t, socket)

	req2, _ := http.NewRequest("GET", front.URL+"/a2a/v1", nil)
	status, _, body := getJSON(t, front.Client(), req2)
	if status != http.StatusOK {
		t.Fatalf("status once the upstream appeared = %d, want 200", status)
	}
	if body["path"] != "/a2a/v1" {
		t.Errorf("path = %v, want /a2a/v1", body["path"])
	}
}

func TestEgressProxyAbsoluteForm(t *testing.T) {
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, "hello from %s", r.Host)
	}))
	defer target.Close()

	var dialed []string
	dial := func(ctx context.Context, network, addr string) (net.Conn, error) {
		dialed = append(dialed, addr)
		var d net.Dialer
		return d.DialContext(ctx, network, addr)
	}
	front := httptest.NewServer(newEgressProxy(dial, testLogger(t)))
	defer front.Close()

	// A client configured with an HTTP proxy sends absolute-form requests.
	proxyURL, err := url.Parse(front.URL)
	if err != nil {
		t.Fatal(err)
	}
	client := &http.Client{Transport: &http.Transport{Proxy: http.ProxyURL(proxyURL)}}
	resp, err := client.Get(target.URL + "/x")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if !strings.HasPrefix(string(raw), "hello from") {
		t.Fatalf("body = %q", raw)
	}
	if len(dialed) == 0 {
		t.Fatal("egress proxy did not use the provided dial function")
	}
}

func TestEgressProxyConnectTunnel(t *testing.T) {
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, "tunneled")
	}))
	defer target.Close()

	dial := func(ctx context.Context, network, addr string) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, network, addr)
	}
	socket := shortSocketPath(t, "egress.sock")
	ln, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: newEgressProxy(dial, testLogger(t))}
	go srv.Serve(ln)
	defer srv.Close()

	conn, err := net.Dial("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	targetHost := strings.TrimPrefix(target.URL, "http://")
	fmt.Fprintf(conn, "CONNECT %s HTTP/1.1\r\nHost: %s\r\n\r\n", targetHost, targetHost)
	br := bufio.NewReader(conn)
	resp, err := http.ReadResponse(br, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("CONNECT status = %d, want 200", resp.StatusCode)
	}

	fmt.Fprintf(conn, "GET / HTTP/1.1\r\nHost: %s\r\n\r\n", targetHost)
	resp2, err := http.ReadResponse(br, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer resp2.Body.Close()
	raw, _ := io.ReadAll(resp2.Body)
	if string(raw) != "tunneled" {
		t.Fatalf("tunneled body = %q, want %q", raw, "tunneled")
	}
}

func TestServeUntilSignaledDrainsInFlightRequests(t *testing.T) {
	release := make(chan struct{})
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-release
		fmt.Fprint(w, "drained")
	})
	socket := shortSocketPath(t, "in.sock")
	ln, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: handler}

	ctx, cancel := context.WithCancel(context.Background())
	served := make(chan error, 1)
	go func() {
		served <- serveUntilSignaled(ctx, testLogger(t), []serverListener{{srv, ln, "test"}})
	}()

	client := &http.Client{Transport: &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "unix", socket)
		},
	}}

	got := make(chan string, 1)
	go func() {
		resp, err := client.Get("http://netd/slow")
		if err != nil {
			got <- "error: " + err.Error()
			return
		}
		defer resp.Body.Close()
		raw, _ := io.ReadAll(resp.Body)
		got <- string(raw)
	}()

	// Let the request reach the handler, then signal shutdown mid-flight.
	time.Sleep(200 * time.Millisecond)
	cancel()
	// Shutdown must wait for the handler; release it and expect completion.
	time.Sleep(200 * time.Millisecond)
	close(release)

	select {
	case body := <-got:
		if body != "drained" {
			t.Fatalf("in-flight request got %q, want %q", body, "drained")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("in-flight request never completed")
	}
	select {
	case err := <-served:
		if err != nil {
			t.Fatalf("serveUntilSignaled returned %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("serveUntilSignaled did not return after drain")
	}
}
