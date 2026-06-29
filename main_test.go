package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestIsValidGitHubUser(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  bool
	}{
		{"valid simple", "octocat", true},
		{"valid with numbers", "user123", true},
		{"valid single char", "a", true},
		{"valid with hyphen", "my-user", true},
		{"valid max length 39", strings.Repeat("a", 39), true},
		{"empty string", "", false},
		{"too long 40 chars", strings.Repeat("a", 40), false},
		{"starts with hyphen", "-user", false},
		{"trailing hyphen", "user-", false},
		{"double hyphens", "user--name", false},
		{"contains dot", "user.name", false},
		{"contains underscore", "user_name", false},
		{"contains space", "user name", false},
		{"xss attempt", "<script>alert(1)</script>", false},
		{"sql injection", "'; DROP TABLE users;--", false},
		{"path traversal", "../../../etc/passwd", false},
		{"newline injection", "user\nname", false},
		{"null byte", "user\x00name", false},
		{"unicode", "ユーザー", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := isValidGitHubUser(tt.input)
			if got != tt.want {
				t.Errorf("isValidGitHubUser(%q) = %v, want %v", tt.input, got, tt.want)
			}
		})
	}
}

func TestHandleStatus(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()

	handleStatus(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", rec.Code)
	}

	ct := rec.Header().Get("Content-Type")
	if ct != "application/json" {
		t.Fatalf("expected Content-Type application/json, got %q", ct)
	}

	var resp StatusResponse
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if resp.Status != "success" {
		t.Errorf("expected status 'success', got %q", resp.Status)
	}
	if resp.Version == "" {
		t.Error("expected non-empty version")
	}
	if resp.Version != version {
		t.Errorf("expected version %q, got %q", version, resp.Version)
	}
}

func TestHandleStatus_NotFound(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/unknown-path", nil)
	rec := httptest.NewRecorder()

	handleStatus(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected status 404, got %d", rec.Code)
	}
}

func TestHandleHealth(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()

	handleHealth(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", rec.Code)
	}

	var resp map[string]string
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if resp["status"] != "ok" {
		t.Errorf("expected status 'ok', got %q", resp["status"])
	}
}

func TestHandleGitHub_MissingUser(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/github", nil)
	rec := httptest.NewRecorder()

	handleGitHub(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected status 400, got %d", rec.Code)
	}

	body := rec.Body.String()
	if !strings.Contains(body, "Missing 'user' parameter") {
		t.Errorf("unexpected error body: %q", body)
	}
}

func TestHandleGitHub_InvalidUser(t *testing.T) {
	tests := []struct {
		name string
		user string
	}{
		{"xss script tag", "<script>alert(1)</script>"},
		{"sql injection", "'; DROP TABLE users;--"},
		{"path traversal", "../../../etc/passwd"},
		{"double hyphens", "user--name"},
		{"trailing hyphen", "user-"},
		{"starts with hyphen", "-user"},
		{"too long", strings.Repeat("x", 40)},
		{"empty via whitespace", " "},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/api/github?user="+url.QueryEscape(tt.user), nil)
			rec := httptest.NewRecorder()

			handleGitHub(rec, req)

			if rec.Code != http.StatusBadRequest {
				t.Errorf("expected status 400 for user %q, got %d", tt.user, rec.Code)
			}
		})
	}
}

func TestHandleGitHub_InvalidToken(t *testing.T) {
	tests := []struct {
		name  string
		token string
	}{
		{"CRLF injection", "Bearer token\r\nInjected-Header: evil"},
		{"newline injection", "Bearer token\nInjected: evil"},
		{"missing Bearer prefix", "ghp_abc123"},
		{"spaces in token", "Bearer tok en"},
		{"empty Bearer value", "Bearer "},
		{"too long token", "Bearer " + strings.Repeat("a", 300)},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/api/github?user=octocat", nil)
			req.Header.Set("Authorization", tt.token)
			rec := httptest.NewRecorder()

			handleGitHub(rec, req)

			if rec.Code != http.StatusBadRequest {
				t.Errorf("expected status 400 for token %q, got %d", tt.name, rec.Code)
			}
		})
	}
}

func TestValidTokenRegex(t *testing.T) {
	tests := []struct {
		name  string
		token string
		want  bool
	}{
		{"valid classic PAT", "Bearer ghp_abc123DEF456", true},
		{"valid fine-grained PAT", "Bearer github_pat_abcDEF123", true},
		{"valid with dots", "Bearer token.value.here", true},
		{"valid with underscores", "Bearer my_token_123", true},
		{"valid with hyphens", "Bearer my-token-123", true},
		{"missing Bearer prefix", "ghp_abc123", false},
		{"lowercase bearer", "bearer ghp_abc123", false},
		{"empty", "", false},
		{"Bearer only", "Bearer ", false},
		{"contains space in value", "Bearer tok en", false},
		{"contains CRLF", "Bearer tok\r\nen", false},
		{"contains semicolon", "Bearer tok;en", false},
		{"contains slash", "Bearer tok/en", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := validTokenRegex.MatchString(tt.token)
			if got != tt.want {
				t.Errorf("validTokenRegex.MatchString(%q) = %v, want %v", tt.token, got, tt.want)
			}
		})
	}
}

func TestCORSMiddleware_Preflight(t *testing.T) {
	handler := corsMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodOptions, "/api/github", nil)
	req.Header.Set("Origin", "https://forest.micutu.com")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("expected 204 for preflight, got %d", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "https://forest.micutu.com" {
		t.Errorf("expected allowed origin, got %q", got)
	}
	if got := rec.Header().Get("Access-Control-Allow-Methods"); got != "GET, OPTIONS" {
		t.Errorf("expected 'GET, OPTIONS', got %q", got)
	}
	if got := rec.Header().Get("Access-Control-Allow-Headers"); got != "Authorization, Content-Type" {
		t.Errorf("expected 'Authorization, Content-Type', got %q", got)
	}
}

func TestCORSMiddleware_DisallowedOrigin(t *testing.T) {
	handler := corsMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Origin", "https://evil.example.com")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("expected no CORS header for disallowed origin, got %q", got)
	}
}

func TestCORSMiddleware_AllowedOriginNonPreflight(t *testing.T) {
	handler := corsMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Origin", "https://forest.micutu.com")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "https://forest.micutu.com" {
		t.Errorf("expected allowed origin, got %q", got)
	}
}

func TestSecurityHeadersMiddleware(t *testing.T) {
	handler := securityHeadersMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	want := map[string]string{
		"X-Content-Type-Options":       "nosniff",
		"X-Frame-Options":              "DENY",
		"Referrer-Policy":              "no-referrer",
		"Cross-Origin-Resource-Policy": "same-origin",
	}
	for h, v := range want {
		if got := rec.Header().Get(h); got != v {
			t.Errorf("header %s = %q, want %q", h, got, v)
		}
	}
}

func TestHandleGitHub_MethodNotAllowed(t *testing.T) {
	for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodDelete} {
		req := httptest.NewRequest(method, "/api/github?user=octocat", nil)
		rec := httptest.NewRecorder()

		handleGitHub(rec, req)

		if rec.Code != http.StatusMethodNotAllowed {
			t.Errorf("method %s: expected 405, got %d", method, rec.Code)
		}
		if got := rec.Header().Get("Allow"); got != "GET, OPTIONS" {
			t.Errorf("method %s: expected Allow 'GET, OPTIONS', got %q", method, got)
		}
	}
}

func TestCommitsURL(t *testing.T) {
	tests := []struct {
		fullName string
		want     string
	}{
		{"octocat/Hello-World", "https://api.github.com/repos/octocat/Hello-World/commits?per_page=20"},
		{"a/b c", "https://api.github.com/repos/a/b%20c/commits?per_page=20"},
		{"evil/../../secret", "https://api.github.com/repos/evil/..%2F..%2Fsecret/commits?per_page=20"},
	}
	for _, tt := range tests {
		if got := commitsURL(tt.fullName); got != tt.want {
			t.Errorf("commitsURL(%q) = %q, want %q", tt.fullName, got, tt.want)
		}
	}
}

func TestClientIP(t *testing.T) {
	tests := []struct {
		name       string
		remoteAddr string
		realIP     string
		xff        string
		want       string
	}{
		{"x-real-ip wins", "127.0.0.1:5000", "203.0.113.7", "10.0.0.1", "203.0.113.7"},
		{"first xff entry", "127.0.0.1:5000", "", "198.51.100.2, 10.0.0.1", "198.51.100.2"},
		{"falls back to remote", "192.0.2.5:443", "", "", "192.0.2.5"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/", nil)
			req.RemoteAddr = tt.remoteAddr
			if tt.realIP != "" {
				req.Header.Set("X-Real-IP", tt.realIP)
			}
			if tt.xff != "" {
				req.Header.Set("X-Forwarded-For", tt.xff)
			}
			if got := clientIP(req); got != tt.want {
				t.Errorf("clientIP() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestRateLimiterAllow(t *testing.T) {
	rl := &rateLimiter{ips: make(map[string]*ipBucket), rps: 5, burst: 2}
	ip := "203.0.113.99"
	// burst is 2, so first two are allowed, third is throttled.
	if !rl.allow(ip) || !rl.allow(ip) {
		t.Fatal("expected first two requests within burst to be allowed")
	}
	if rl.allow(ip) {
		t.Error("expected third immediate request to be throttled")
	}
}

func TestLoadConfigDefaults(t *testing.T) {
	c := loadConfig()
	if c.Port != "8089" {
		t.Errorf("default port = %q, want 8089", c.Port)
	}
	if c.CacheTTL != 10*time.Minute {
		t.Errorf("default cache TTL = %v, want 10m", c.CacheTTL)
	}
	if !c.AllowedOrigins["https://forest.micutu.com"] {
		t.Error("expected default allowed origin to include forest.micutu.com")
	}
}
