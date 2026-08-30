package main

import (
	"bufio"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"tailscale.com/ipn/ipnstate"
	"tailscale.com/tailcfg"
)

// upgradeEchoServer serves on a unix socket: a plain request is echoed as
// JSON like echoServer; an Upgrade request is answered 101 and every line
// written afterwards comes back prefixed, for as long as the caller stays.
func upgradeEchoServer(t *testing.T, socket string) {
	t.Helper()
	ln, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
			w.Header().Set("X-Upstream", "echo")
			w.Write([]byte(`{"path":"` + r.URL.Path + `","tags":"` + r.Header.Get(PeerTagsHeader) + `","forged":"` + r.Header.Get("X-Thicket-Anything") + `"}`))
			return
		}
		hj, ok := w.(http.Hijacker)
		if !ok {
			t.Error("upstream cannot hijack")
			return
		}
		conn, brw, err := hj.Hijack()
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.Close()
		brw.WriteString("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n")
		brw.Flush()
		for {
			line, err := brw.ReadString('\n')
			if err != nil {
				return
			}
			brw.WriteString("echo:" + line)
			brw.Flush()
		}
	})}
	go srv.Serve(ln)
	t.Cleanup(func() { srv.Close() })
}

func TestPublicProxyStripsThicketHeadersAndStampsNothing(t *testing.T) {
	socket := shortSocketPath(t, "phone.sock")
	upgradeEchoServer(t, socket)
	front := httptest.NewServer(newPublicProxy(socket, "/", testLogger(t)))
	defer front.Close()

	req, _ := http.NewRequest("POST", front.URL+"/voice", nil)
	req.Header.Set(PeerTagsHeader, "tag:thicket-admin") // forged from the internet
	req.Header.Set("X-Thicket-Anything", "spoofed")
	resp, err := front.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var body [512]byte
	n, _ := resp.Body.Read(body[:])
	got := string(body[:n])
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if !strings.Contains(got, `"tags":""`) {
		t.Errorf("a forged peer-tag header reached the upstream: %s", got)
	}
	if !strings.Contains(got, `"forged":""`) {
		t.Errorf("a forged X-Thicket-* header reached the upstream: %s", got)
	}
	if !strings.Contains(got, `"path":"/voice"`) {
		t.Errorf("path not forwarded: %s", got)
	}
}

func TestPublicProxyRefusesPathsOutsideThePrefix(t *testing.T) {
	socket := shortSocketPath(t, "phone.sock")
	upgradeEchoServer(t, socket)
	front := httptest.NewServer(newPublicProxy(socket, "/phone/", testLogger(t)))
	defer front.Close()

	for path, want := range map[string]int{"/phone/voice": 200, "/phone/relay/abc": 200, "/": 404, "/a2a/v1": 404, "/phonebook": 404} {
		resp, err := front.Client().Get(front.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != want {
			t.Errorf("%s: status = %d, want %d", path, resp.StatusCode, want)
		}
	}
}

func TestPublicProxyKeepsAnUpgradedConnectionOpen(t *testing.T) {
	socket := shortSocketPath(t, "phone.sock")
	upgradeEchoServer(t, socket)
	front := httptest.NewServer(newPublicProxy(socket, "/", testLogger(t)))
	defer front.Close()

	conn, err := net.Dial("tcp", strings.TrimPrefix(front.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	brw := bufio.NewReadWriter(bufio.NewReader(conn), bufio.NewWriter(conn))
	brw.WriteString("GET /relay/secret HTTP/1.1\r\nHost: phone.example.net\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: x\r\nSec-WebSocket-Version: 13\r\nX-Thicket-Peer-Tags: tag:forged\r\n\r\n")
	brw.Flush()
	resp, err := http.ReadResponse(brw.Reader, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("status = %d, want 101", resp.StatusCode)
	}
	// A "call": frames both ways across a quiet stretch, well past any
	// default idle timeout a server might have — none is configured.
	for i, pause := range []time.Duration{0, 1200 * time.Millisecond, 0} {
		time.Sleep(pause)
		brw.WriteString("frame\n")
		brw.Flush()
		conn.SetReadDeadline(time.Now().Add(5 * time.Second))
		line, err := brw.ReadString('\n')
		if err != nil {
			t.Fatalf("frame %d: %v", i, err)
		}
		if line != "echo:frame\n" {
			t.Fatalf("frame %d: got %q", i, line)
		}
	}
}

func funnelStatus(caps ...tailcfg.NodeCapability) *ipnstate.Status {
	capMap := tailcfg.NodeCapMap{}
	for _, c := range caps {
		capMap[c] = nil
	}
	return &ipnstate.Status{Self: &ipnstate.PeerStatus{CapMap: capMap}}
}

func TestVerifyFunnelNamesTheMissingAttribute(t *testing.T) {
	err := verifyFunnel(funnelStatus(tailcfg.CapabilityHTTPS), "tag:thicket-phone")
	if err == nil {
		t.Fatal("expected an error without the funnel attribute")
	}
	for _, want := range []string{`"funnel" node attribute`, `"target": ["tag:thicket-phone"]`, `"attr": ["funnel"]`, "nodeAttrs"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not say %q", err, want)
		}
	}
	if err := verifyFunnel(funnelStatus(tailcfg.NodeAttrFunnel), "tag:thicket-phone"); err == nil || !strings.Contains(err.Error(), "HTTPS") {
		t.Errorf("without HTTPS certificates: %v", err)
	}
	if err := verifyFunnel(&ipnstate.Status{}, "tag:thicket-phone"); err == nil {
		t.Error("no self status must fail")
	}
	// A real tailnet also says which ports Funnel may use; 443 must be among them.
	ports := tailcfg.NodeCapability(string(tailcfg.CapabilityFunnelPorts) + "?ports=443,8443,10000")
	if err := verifyFunnel(funnelStatus(tailcfg.CapabilityHTTPS, tailcfg.NodeAttrFunnel, ports), "tag:thicket-phone"); err != nil {
		t.Errorf("with every capability: %v", err)
	}
	if err := verifyFunnel(funnelStatus(tailcfg.CapabilityHTTPS, tailcfg.NodeAttrFunnel), "tag:thicket-phone"); err == nil || !strings.Contains(err.Error(), "port 443") {
		t.Errorf("without the ports attribute: %v", err)
	}
}
