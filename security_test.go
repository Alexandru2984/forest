package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf8"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func githubResponse(status int, body string) *http.Response {
	return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}
}
func isolateAPI(t *testing.T, transport roundTripFunc) {
	t.Helper()
	oldConfig, oldClient := cfg, globalClient
	cfg = loadConfig()
	cfg.MaxCommitRepos = 0
	globalClient = &http.Client{Transport: transport}
	cache = make(map[string]CacheItem)
	flightGroup = make(map[string]*flightCall)
	t.Cleanup(func() {
		cfg = oldConfig
		globalClient = oldClient
		cache = make(map[string]CacheItem)
		flightGroup = make(map[string]*flightCall)
	})
}

const oneRepo = `[{"name":"forest","full_name":"octocat/forest","language":"Go","description":"A forest"}]`

func TestCredentialCacheIsolationAndHeaders(t *testing.T) {
	var calls atomic.Int32
	isolateAPI(t, func(r *http.Request) (*http.Response, error) { calls.Add(1); return githubResponse(200, oneRepo), nil })
	handler := securityHeadersMiddleware(corsMiddleware(http.HandlerFunc(handleGitHub)))
	request := func(user, token string) *httptest.ResponseRecorder {
		req := httptest.NewRequest("GET", "/api/github?user="+user, nil)
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != 200 {
			t.Fatalf("unexpected response: %d %s", rec.Code, rec.Body.String())
		}
		if rec.Header().Get("Cache-Control") != "private, no-store" {
			t.Fatal("API must not be stored in HTTP caches")
		}
		if !strings.Contains(strings.Join(rec.Header().Values("Vary"), ","), "Authorization") {
			t.Fatal("missing credential cache separation")
		}
		return rec
	}
	request("octocat", "first")
	cached := request("OCTOCAT", "first")
	request("octocat", "second")
	request("octocat", "")
	if calls.Load() != 3 || cached.Header().Get("X-Forest-Cache") != "hit" {
		t.Fatalf("cache isolation failed: %d calls", calls.Load())
	}
}
func TestFollowerCancellation(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	isolateAPI(t, func(r *http.Request) (*http.Response, error) {
		close(started)
		<-release
		return githubResponse(200, oneRepo), nil
	})
	done := make(chan struct{})
	go func() {
		defer close(done)
		handleGitHub(httptest.NewRecorder(), httptest.NewRequest("GET", "/api/github?user=octocat", nil))
	}()
	<-started
	ctx, cancel := context.WithCancel(context.Background())
	follower := make(chan struct{})
	go func() {
		defer close(follower)
		handleGitHub(httptest.NewRecorder(), httptest.NewRequest("GET", "/api/github?user=octocat", nil).WithContext(ctx))
	}()
	cancel()
	select {
	case <-follower:
	case <-time.After(time.Second):
		t.Error("cancelled follower did not return")
	}
	close(release)
	<-done
}
func TestAdmissionHasNoUnboundedQueue(t *testing.T) {
	isolateAPI(t, func(r *http.Request) (*http.Response, error) {
		t.Error("overloaded request reached upstream")
		return nil, fmt.Errorf("unexpected")
	})
	for i := 0; i < cap(globalSem); i++ {
		globalSem <- struct{}{}
	}
	defer func() {
		for len(globalSem) > 0 {
			<-globalSem
		}
	}()
	rec := httptest.NewRecorder()
	handleGitHub(rec, httptest.NewRequest("GET", "/api/github?user=octocat", nil))
	if rec.Code != 503 || len(flightGroup) != 0 {
		t.Fatalf("admission not bounded: status=%d flights=%d", rec.Code, len(flightGroup))
	}
}
func TestTotalFetchDeadline(t *testing.T) {
	isolateAPI(t, func(r *http.Request) (*http.Response, error) { <-r.Context().Done(); return nil, r.Context().Err() })
	cfg.FetchTimeout = 15 * time.Millisecond
	rec := httptest.NewRecorder()
	handleGitHub(rec, httptest.NewRequest("GET", "/api/github?user=octocat", nil))
	if rec.Code != 504 || len(flightGroup) != 0 || len(globalSem) != 0 {
		t.Fatalf("deadline leaked work: %d %s", rec.Code, rec.Body.String())
	}
}
func TestUpstreamErrorsAreActionableAndDoNotLeakBody(t *testing.T) {
	for _, test := range []struct{ upstream, want int }{{401, 401}, {404, 404}, {403, 429}, {500, 502}, {302, 502}} {
		t.Run(fmt.Sprint(test.upstream), func(t *testing.T) {
			isolateAPI(t, func(r *http.Request) (*http.Response, error) {
				resp := githubResponse(test.upstream, "sensitive upstream text")
				resp.Header.Set("X-RateLimit-Remaining", "0")
				return resp, nil
			})
			rec := httptest.NewRecorder()
			handleGitHub(rec, httptest.NewRequest("GET", "/api/github?user=octocat", nil))
			if rec.Code != test.want || strings.Contains(rec.Body.String(), "sensitive") {
				t.Fatalf("unsafe error: %d %s", rec.Code, rec.Body.String())
			}
		})
	}
}
func TestRepoOrderPrivacyAndCoverage(t *testing.T) {
	isolateAPI(t, func(r *http.Request) (*http.Response, error) {
		if strings.Contains(r.URL.Path, "/users/") {
			return githubResponse(200, `[{"name":"slow","full_name":"octocat/slow"},{"name":"fast","full_name":"octocat/fast"},{"name":"secret","full_name":"octocat/secret","private":true},{"name":"metadata","full_name":"octocat/metadata"}]`), nil
		}
		if strings.Contains(r.URL.Path, "/slow/") {
			time.Sleep(5 * time.Millisecond)
		}
		return githubResponse(200, `[{"sha":"abcdef0123456789","html_url":"https://evil.example/","commit":{"message":"Hello\nBody","author":{"date":"2026-01-01T00:00:00Z"}}}]`), nil
	})
	cfg.MaxCommitRepos = 2
	snapshot, err := fetchGitHubSnapshot(context.Background(), "octocat", "Bearer public")
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Repos) != 3 || snapshot.Repos[0].Name != "slow" || snapshot.Repos[1].Name != "fast" || snapshot.Sampled != 2 || snapshot.Repos[2].CommitStatus != "not_sampled" {
		t.Fatalf("invalid snapshot: %+v", snapshot)
	}
	if snapshot.Repos[0].Commits[0].URL != "https://github.com/octocat/slow/commit/abcdef0123456789" {
		t.Fatal("commit link not canonical")
	}
}
func TestProxyHeaderSpoofing(t *testing.T) {
	for _, test := range []struct{ remote, header, want string }{{"198.51.100.1:42", "203.0.113.1", "198.51.100.1"}, {"127.0.0.1:42", "anything", "127.0.0.1"}, {"127.0.0.1:42", "1.2.3.4, 5.6.7.8", "127.0.0.1"}, {"[::1]:42", "::ffff:192.0.2.1", "192.0.2.1"}} {
		req := httptest.NewRequest("GET", "/", nil)
		req.RemoteAddr = test.remote
		req.Header.Set("X-Real-IP", test.header)
		if got := clientIP(req); got != test.want {
			t.Errorf("clientIP(%q,%q)=%q want %q", test.remote, test.header, got, test.want)
		}
	}
}
func TestRateLimiterMemoryBound(t *testing.T) {
	limiter := newRateLimiter(5)
	for i := 0; i < maxIPBuckets; i++ {
		if !limiter.allow(fmt.Sprint(i)) {
			t.Fatal("premature admission denial")
		}
	}
	if limiter.allow("overflow") || len(limiter.ips) != maxIPBuckets {
		t.Fatal("bucket map exceeded limit")
	}
}
func TestPayloadBoundAndUnicode(t *testing.T) {
	var value any
	if decodeBounded(strings.NewReader(`{"x":"1234567890"}`), 5, &value) == nil {
		t.Fatal("oversized payload accepted")
	}
	if decodeBounded(strings.NewReader(`{} {}`), 100, &value) == nil {
		t.Fatal("multiple JSON documents accepted")
	}
	if text := truncateText(strings.Repeat("🌲", 110), 100); !utf8.ValidString(text) || len([]rune(text)) != 100 {
		t.Fatal("unicode truncated incorrectly")
	}
}
func TestInvalidNumericConfiguration(t *testing.T) {
	t.Setenv("RATE_LIMIT_RPS", "+Inf")
	t.Setenv("MAX_COMMIT_REPOS", "100000")
	t.Setenv("MAX_CACHE_SIZE", "100000")
	t.Setenv("FETCH_TIMEOUT", "100h")
	config := loadConfig()
	if config.RateLimitRPS != 5 || config.MaxCommitRepos != 60 || config.MaxCacheSize != 100 || config.FetchTimeout != 45*time.Second {
		t.Fatalf("unsafe configuration: %+v", config)
	}
}
func TestEmbeddedAppAndSecurityHeaders(t *testing.T) {
	handler := newHandler()
	for _, path := range []string{"/", "/vendor/three/build/three.module.js", "/css/style.css"} {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest("GET", path, nil))
		if rec.Code != 200 || rec.Header().Get("Content-Security-Policy") == "" {
			t.Fatalf("missing embedded asset or headers at %s: %d", path, rec.Code)
		}
		if strings.Contains(rec.Header().Get("Content-Security-Policy"), "script-src 'self' 'unsafe-inline'") {
			t.Fatal("inline executable scripts allowed")
		}
	}
	for _, path := range []string{"/vendor/", "/.git/config", "/go.mod"} {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest("GET", path, nil))
		if rec.Code != 404 {
			t.Fatalf("exposed path %s: %d", path, rec.Code)
		}
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest("GET", "/api/", nil))
	var status StatusResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &status); err != nil || status.Version != version {
		t.Fatal("missing API status")
	}
}
func TestGitHubRedirectsDisabled(t *testing.T) {
	// Assert the real production client's redirect policy without sending a request.
	if globalClient.CheckRedirect == nil || globalClient.CheckRedirect(nil, nil) != http.ErrUseLastResponse {
		t.Fatal("upstream redirects must be disabled")
	}
}

func TestCORSSameOriginModulesAndCrossOriginDenial(t *testing.T) {
	handler := corsMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) }))
	for _, test := range []struct {
		origin string
		want   int
	}{{"http://127.0.0.1:18089", 200}, {"https://untrusted.example", 403}} {
		req := httptest.NewRequest("GET", "http://127.0.0.1:18089/js/app.js", nil)
		req.Header.Set("Origin", test.origin)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != test.want {
			t.Errorf("origin %s: status %d want %d", test.origin, rec.Code, test.want)
		}
	}
}
