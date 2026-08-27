package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"

	"tailscale.com/ipn/store/mem"
	"tailscale.com/net/netns"
	"tailscale.com/tailcfg"
	"tailscale.com/tsnet"
	"tailscale.com/tstest/integration"
	"tailscale.com/tstest/integration/testcontrol"
	"tailscale.com/types/logger"
)

const testAuthKey = "tskey-test-netd"

// startTestControl runs an in-process coordination server so the tailnet
// join, WhoIs, and cross-node data paths run for real, without external
// credentials.
func startTestControl(t *testing.T) string {
	t.Helper()
	netns.SetEnabled(false)
	t.Cleanup(func() { netns.SetEnabled(true) })

	derpMap := integration.RunDERPAndSTUN(t, logger.Discard, "127.0.0.1")
	control := &testcontrol.Server{
		DERPMap:        derpMap,
		DNSConfig:      &tailcfg.DNSConfig{Proxied: true},
		MagicDNSDomain: "test.ts.net",
		RequireAuthKey: testAuthKey,
		TagOwners: map[string][]string{
			"tag:thicket-hearth": nil,
			"tag:thicket-caller": nil,
		},
	}
	control.HTTPTestServer = httptest.NewUnstartedServer(control)
	control.HTTPTestServer.Start()
	t.Cleanup(control.HTTPTestServer.Close)
	return control.HTTPTestServer.URL
}

func startNode(t *testing.T, ctx context.Context, controlURL, hostname, tag string) (*tsnet.Server, string) {
	t.Helper()
	dir := filepath.Join(t.TempDir(), hostname)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	s := &tsnet.Server{
		Dir:           dir,
		ControlURL:    controlURL,
		Hostname:      hostname,
		AuthKey:       testAuthKey,
		AdvertiseTags: []string{tag},
		Store:         new(mem.Store),
		Ephemeral:     true,
		UserLogf:      logger.Discard,
		Logf:          logger.Discard,
	}
	t.Cleanup(func() { s.Close() })
	status, err := s.Up(ctx)
	if err != nil {
		t.Fatalf("%s did not join tailnet: %v", hostname, err)
	}
	if err := verifyTag(status, tag); err != nil {
		t.Fatalf("%s: %v", hostname, err)
	}
	return s, status.TailscaleIPs[0].String()
}

func TestEndToEndOverTailnet(t *testing.T) {
	if testing.Short() {
		t.Skip("tailnet e2e test in -short mode")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	controlURL := startTestControl(t)
	hearth, hearthIP := startNode(t, ctx, controlURL, "thicket-hearth", "tag:thicket-hearth")
	caller, callerIP := startNode(t, ctx, controlURL, "thicket-caller", "tag:thicket-caller")

	// agentd stand-in on a unix socket behind hearth's netd.
	upstream := shortSocketPath(t, "agentd.sock")
	echoServer(t, upstream)

	hearthLC, err := hearth.LocalClient()
	if err != nil {
		t.Fatal(err)
	}
	inboundLn, err := hearth.Listen("tcp", ":8080")
	if err != nil {
		t.Fatal(err)
	}
	inboundSrv := &http.Server{Handler: newInboundProxy(upstream, &whoisIdentifier{hearthLC}, testLogger(t))}
	go inboundSrv.Serve(inboundLn)
	t.Cleanup(func() { inboundSrv.Close() })

	// Caller-side service that reports the WhoIs identity it observes,
	// for the egress direction.
	callerLC, err := caller.LocalClient()
	if err != nil {
		t.Fatal(err)
	}
	peerLn, err := caller.Listen("tcp", ":9090")
	if err != nil {
		t.Fatal(err)
	}
	peerSrv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		who, err := callerLC.WhoIs(r.Context(), r.RemoteAddr)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		json.NewEncoder(w).Encode(who.Node.Tags)
	})}
	go peerSrv.Serve(peerLn)
	t.Cleanup(func() { peerSrv.Close() })

	t.Run("inbound proxies with WhoIs tags and discards forged headers", func(t *testing.T) {
		client := &http.Client{Transport: &http.Transport{
			DialContext: caller.Dial,
		}}
		var body map[string]any
		deadline := time.Now().Add(90 * time.Second)
		for {
			req, _ := http.NewRequestWithContext(ctx, "GET",
				fmt.Sprintf("http://%s:8080/a2a/v1", hearthIP), nil)
			req.Header.Set("X-Thicket-Peer-Tags", "tag:thicket-forged")
			resp, err := client.Do(req)
			if err == nil {
				func() {
					defer resp.Body.Close()
					raw, _ := io.ReadAll(resp.Body)
					if resp.StatusCode == http.StatusOK {
						if jerr := json.Unmarshal(raw, &body); jerr != nil {
							t.Fatalf("unmarshal %q: %v", raw, jerr)
						}
					} else {
						t.Logf("status %d: %s", resp.StatusCode, raw)
					}
				}()
				if body != nil {
					break
				}
			} else {
				t.Logf("dial not ready: %v", err)
			}
			if time.Now().After(deadline) {
				t.Fatal("tailnet data path never became ready")
			}
			time.Sleep(time.Second)
		}
		up := upstreamHeaders(t, body)
		if got := up[PeerTagsHeader]; len(got) != 1 || got[0] != "tag:thicket-caller" {
			t.Errorf("%s = %v, want [tag:thicket-caller] from WhoIs", PeerTagsHeader, got)
		}
		if body["path"] != "/a2a/v1" {
			t.Errorf("path = %v, want /a2a/v1", body["path"])
		}
	})

	t.Run("inbound listener is tailnet-only, not a host TCP port", func(t *testing.T) {
		// The whole point of netd: agentd must not be reachable from
		// localhost TCP, only over the tailnet.
		conn, err := net.DialTimeout("tcp", "127.0.0.1:8080", time.Second)
		if err == nil {
			conn.Close()
			t.Fatal("tsnet listener unexpectedly reachable on loopback TCP")
		}
	})

	t.Run("egress dials via tailnet and peer sees this node's tag", func(t *testing.T) {
		egressFront := httptest.NewServer(newEgressProxy(hearth.Dial, testLogger(t)))
		defer egressFront.Close()
		proxyURL, err := url.Parse(egressFront.URL)
		if err != nil {
			t.Fatal(err)
		}
		client := &http.Client{Transport: &http.Transport{Proxy: http.ProxyURL(proxyURL)}}

		var tags []string
		deadline := time.Now().Add(90 * time.Second)
		for {
			resp, err := client.Get(fmt.Sprintf("http://%s:9090/", callerIP))
			if err == nil {
				raw, _ := io.ReadAll(resp.Body)
				resp.Body.Close()
				if resp.StatusCode == http.StatusOK {
					if jerr := json.Unmarshal(raw, &tags); jerr != nil {
						t.Fatalf("unmarshal %q: %v", raw, jerr)
					}
					break
				}
				t.Logf("status %d: %s", resp.StatusCode, raw)
			} else {
				t.Logf("egress not ready: %v", err)
			}
			if time.Now().After(deadline) {
				t.Fatal("egress data path never became ready")
			}
			time.Sleep(time.Second)
		}
		if len(tags) != 1 || tags[0] != "tag:thicket-hearth" {
			t.Errorf("peer WhoIs tags = %v, want [tag:thicket-hearth]", tags)
		}
	})
}
