package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const version = "9.0.0"

// SECURITY: Strict GitHub username validation (Max 39 chars, alphanumeric, single hyphens inside)
var validUserRegex = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$`)

// SECURITY: Strict Token validation (Bearer format + safe characters only to prevent CRLF injection)
var validTokenRegex = regexp.MustCompile(`^Bearer [a-zA-Z0-9_.-]+$`)

// ---------------------------------------------------------------------------
// Configuration (env-driven, with safe defaults matching the previous build)
// ---------------------------------------------------------------------------

type Config struct {
	Port           string
	CacheTTL       time.Duration
	MaxCacheSize   int
	MaxCommitRepos int
	RateLimitRPS   float64
	GitHubToken    string          // optional server-side fallback (public-only)
	AllowedOrigins map[string]bool // CORS allow-list
}

func loadConfig() Config {
	c := Config{
		Port:           getenvStr("PORT", "8089"),
		CacheTTL:       getenvDuration("CACHE_TTL", 10*time.Minute),
		MaxCacheSize:   getenvInt("MAX_CACHE_SIZE", 100),
		MaxCommitRepos: getenvInt("MAX_COMMIT_REPOS", 60),
		RateLimitRPS:   getenvFloat("RATE_LIMIT_RPS", 5),
		GitHubToken:    strings.TrimSpace(os.Getenv("GITHUB_TOKEN")),
		AllowedOrigins: parseOrigins(getenvStr("ALLOWED_ORIGINS", "https://forest.micutu.com")),
	}
	return c
}

func getenvStr(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

func getenvInt(key string, def int) int {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return def
}

func getenvFloat(key string, def float64) float64 {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil && f > 0 {
			return f
		}
	}
	return def
}

func getenvDuration(key string, def time.Duration) time.Duration {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		if d, err := time.ParseDuration(v); err == nil && d > 0 {
			return d
		}
	}
	return def
}

func parseOrigins(raw string) map[string]bool {
	m := make(map[string]bool)
	for _, o := range strings.Split(raw, ",") {
		if o = strings.TrimSpace(o); o != "" {
			m[o] = true
		}
	}
	return m
}

// cfg is initialised at package init so handlers/middleware (and tests) can use
// the defaults without booting the full server.
var cfg = loadConfig()

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type StatusResponse struct {
	Status  string `json:"status"`
	Message string `json:"message"`
	Version string `json:"version"`
}

type CommitInfo struct {
	Hash    string `json:"hash"`
	Message string `json:"message"`
	URL     string `json:"url"`
}

type RepoInfo struct {
	Name      string       `json:"name"`
	FullName  string       `json:"full_name"`
	Language  string       `json:"language"`
	CreatedAt string       `json:"created_at"`
	UpdatedAt string       `json:"updated_at"`
	Stars     int          `json:"stars"`
	Fork      bool         `json:"fork"`
	Commits   []CommitInfo `json:"commits"`
}

type CacheItem struct {
	Data      []RepoInfo
	ExpiresAt time.Time
}

var (
	cache      = make(map[string]CacheItem)
	cacheMutex sync.RWMutex

	// SECURITY: Cache Stampede (Thundering Herd) prevention
	flightGroup      = make(map[string]*sync.WaitGroup)
	flightGroupMutex sync.Mutex

	// SECURITY: Global Resource Exhaustion Limit (Max 10 concurrent user fetches server-wide)
	globalSem = make(chan struct{}, 10)

	// SECURITY & PERFORMANCE: Reusable connection pool to prevent ephemeral port exhaustion
	globalClient = &http.Client{
		Timeout: 45 * time.Second,
		Transport: &http.Transport{
			MaxIdleConns:        100,
			MaxIdleConnsPerHost: 100,
			IdleConnTimeout:     90 * time.Second,
		},
	}
)

// ---------------------------------------------------------------------------
// Server bootstrap
// ---------------------------------------------------------------------------

func main() {
	log.SetFlags(log.LstdFlags | log.Lshortfile)

	mux := http.NewServeMux()
	mux.HandleFunc("/", handleStatus)
	mux.HandleFunc("/api/", handleStatus)
	mux.HandleFunc("/api/github", handleGitHub)
	mux.HandleFunc("/github", handleGitHub)
	mux.HandleFunc("/health", handleHealth)

	limiter := newRateLimiter(cfg.RateLimitRPS)

	// Middleware chain: security headers -> CORS -> per-IP rate limit -> mux
	handler := securityHeadersMiddleware(corsMiddleware(limiter.middleware(mux)))

	// SECURITY: Mitigate Slowloris and connection exhaustion via strict timeouts.
	srv := &http.Server{
		Addr:           "127.0.0.1:" + cfg.Port,
		Handler:        handler,
		ReadTimeout:    10 * time.Second,
		WriteTimeout:   60 * time.Second,
		IdleTimeout:    120 * time.Second,
		MaxHeaderBytes: 1 << 14, // 16KB max header size
	}

	// Graceful shutdown on SIGINT/SIGTERM
	go func() {
		sigChan := make(chan os.Signal, 1)
		signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
		sig := <-sigChan
		log.Printf("Received signal %v, shutting down gracefully...", sig)

		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()

		if err := srv.Shutdown(ctx); err != nil {
			log.Fatalf("Graceful shutdown failed: %v", err)
		}
		log.Println("Server stopped cleanly.")
	}()

	tokenMode := "per-user only"
	if cfg.GitHubToken != "" {
		tokenMode = "server fallback enabled (public-only)"
	}
	log.Printf("🌲 Code Forest Backend (v%s - Hardened) growing on %s | cache=%s/%d | token=%s",
		version, srv.Addr, cfg.CacheTTL, cfg.MaxCacheSize, tokenMode)

	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("Failed to start server: %v", err)
	}
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

// securityHeadersMiddleware sets baseline hardening headers on every response.
// These are defence-in-depth; the edge (nginx) sets the full CSP/HSTS suite.
func securityHeadersMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Cross-Origin-Resource-Policy", "same-origin")
		next.ServeHTTP(w, r)
	})
}

// corsMiddleware applies an Origin allow-list and answers CORS preflight.
func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		allowed := origin != "" && cfg.AllowedOrigins[origin]

		if allowed {
			h := w.Header()
			h.Set("Access-Control-Allow-Origin", origin)
			h.Set("Access-Control-Expose-Headers", "X-GitHub-RateLimit-Remaining")
			h.Add("Vary", "Origin")
		}

		if r.Method == http.MethodOptions {
			if allowed {
				w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
				w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
			}
			w.WriteHeader(http.StatusNoContent)
			return
		}

		next.ServeHTTP(w, r)
	})
}

// ---------------------------------------------------------------------------
// Per-IP token-bucket rate limiter (stdlib only, zero deps)
// ---------------------------------------------------------------------------

type ipBucket struct {
	tokens float64
	last   time.Time
}

type rateLimiter struct {
	mu    sync.Mutex
	ips   map[string]*ipBucket
	rps   float64
	burst float64
}

func newRateLimiter(rps float64) *rateLimiter {
	rl := &rateLimiter{ips: make(map[string]*ipBucket), rps: rps, burst: rps * 2}
	go rl.cleanupLoop()
	return rl
}

func (rl *rateLimiter) allow(ip string) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	now := time.Now()
	b, ok := rl.ips[ip]
	if !ok {
		rl.ips[ip] = &ipBucket{tokens: rl.burst - 1, last: now}
		return true
	}
	b.tokens += now.Sub(b.last).Seconds() * rl.rps
	if b.tokens > rl.burst {
		b.tokens = rl.burst
	}
	b.last = now
	if b.tokens >= 1 {
		b.tokens--
		return true
	}
	return false
}

func (rl *rateLimiter) cleanupLoop() {
	ticker := time.NewTicker(10 * time.Minute)
	defer ticker.Stop()
	for range ticker.C {
		rl.mu.Lock()
		now := time.Now()
		for ip, b := range rl.ips {
			if now.Sub(b.last) > 10*time.Minute {
				delete(rl.ips, ip)
			}
		}
		rl.mu.Unlock()
	}
}

func (rl *rateLimiter) middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" { // never throttle health checks
			next.ServeHTTP(w, r)
			return
		}
		if !rl.allow(clientIP(r)) {
			w.Header().Set("Retry-After", "1")
			http.Error(w, "Too Many Requests", http.StatusTooManyRequests)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// clientIP resolves the real client address. The service binds to 127.0.0.1
// only, so X-Real-IP / X-Forwarded-For are set by the trusted local proxy.
func clientIP(r *http.Request) string {
	if ip := strings.TrimSpace(r.Header.Get("X-Real-IP")); ip != "" {
		return ip
	}
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		if i := strings.IndexByte(xff, ','); i >= 0 {
			return strings.TrimSpace(xff[:i])
		}
		return strings.TrimSpace(xff)
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

func handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

func handleStatus(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" && r.URL.Path != "/api/" {
		log.Printf("404 for path: %s", r.URL.Path)
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(StatusResponse{
		Status:  "success",
		Message: "The roots of the Code Forest are active, concurrent, extremely secured (Zero Trust), stampede-proof and caching.",
		Version: version,
	})
}

func handleGitHub(w http.ResponseWriter, r *http.Request) {
	// SECURITY: Only GET is allowed (OPTIONS is short-circuited by corsMiddleware).
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET, OPTIONS")
		http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
		return
	}

	user := r.URL.Query().Get("user")
	if user == "" {
		http.Error(w, "Missing 'user' parameter", http.StatusBadRequest)
		return
	}

	// SECURITY: Strict validation for GitHub usernames.
	if !isValidGitHubUser(user) {
		http.Error(w, "Invalid 'user' parameter format", http.StatusBadRequest)
		return
	}

	clientToken := r.Header.Get("Authorization")
	if clientToken != "" {
		// SECURITY: Prevent CRLF Injection and format violations.
		if len(clientToken) > 255 || !validTokenRegex.MatchString(clientToken) {
			http.Error(w, "Invalid 'Authorization' header format", http.StatusBadRequest)
			return
		}
		log.Printf("Received authenticated request for user: %s (Token length: %d)", user, len(clientToken))
	} else {
		log.Printf("Received UNAUTHENTICATED request for user: %s", user)
	}

	// Determine the upstream token and whether we must enforce public-only.
	// publicOnly is true for every anonymous request; when GITHUB_TOKEN is set
	// we use it solely to raise GitHub's rate limit, never to expose private repos.
	upstreamToken := clientToken
	publicOnly := clientToken == ""
	if publicOnly && cfg.GitHubToken != "" {
		upstreamToken = "Bearer " + cfg.GitHubToken
	}

	// SECURITY: Cache key binds the token so a forged/empty token can never read
	// a previously cached authenticated (private) response. Anonymous requests
	// (public-only data) all share the plain `user` key — safe & shareable.
	cacheKey := user
	if clientToken != "" {
		tokenHash := fmt.Sprintf("%x", sha256.Sum256([]byte(clientToken)))
		cacheKey = user + "_" + tokenHash
	}

	const maxRetries = 3
	retryCount := 0

retry:
	// 1. Check cache.
	cacheMutex.RLock()
	item, found := cache[cacheKey]
	cacheMutex.RUnlock()

	if found && time.Now().Before(item.ExpiresAt) {
		log.Printf("Cache HIT for user: %s", user)
		writeJSON(w, item.Data, "")
		return
	}

	// 2. SECURITY: Cache Stampede prevention (singleflight).
	flightGroupMutex.Lock()
	if wg, exists := flightGroup[cacheKey]; exists {
		flightGroupMutex.Unlock()
		log.Printf("Request deduplication active for user: %s. Waiting...", user)
		wg.Wait()

		cacheMutex.RLock()
		item, found = cache[cacheKey]
		cacheMutex.RUnlock()

		if found && time.Now().Before(item.ExpiresAt) {
			log.Printf("Cache HIT (Post-Wait) for user: %s", user)
			writeJSON(w, item.Data, "")
			return
		}

		retryCount++
		if retryCount >= maxRetries {
			log.Printf("Max retries (%d) exceeded for user: %s", maxRetries, user)
			http.Error(w, "Service temporarily unavailable, please retry", http.StatusServiceUnavailable)
			return
		}
		goto retry
	}

	wg := &sync.WaitGroup{}
	wg.Add(1)
	flightGroup[cacheKey] = wg
	flightGroupMutex.Unlock()

	defer func() {
		flightGroupMutex.Lock()
		delete(flightGroup, cacheKey)
		flightGroupMutex.Unlock()
		wg.Done()
	}()

	// SECURITY: Protect against global resource exhaustion.
	select {
	case globalSem <- struct{}{}:
	case <-r.Context().Done():
		log.Printf("Client disconnected before acquiring global slot for user: %s", user)
		return
	}
	defer func() { <-globalSem }()

	// 3. Leader fetches from GitHub.
	log.Printf("Cache MISS for user: %s, fetching repos from GitHub concurrently...", user)

	repos, rateRemaining, err := fetchGitHubData(r.Context(), user, upstreamToken, publicOnly)
	if err != nil {
		log.Printf("Error fetching GitHub data for %s: %v", user, err)
		// SECURITY: Never expose raw upstream errors to the client.
		http.Error(w, "Failed to fetch data from GitHub. Please try again later.", http.StatusBadGateway)
		return
	}

	// 4. Update cache safely.
	cacheMutex.Lock()
	now := time.Now()
	for k, v := range cache { // purge expired
		if now.After(v.ExpiresAt) {
			delete(cache, k)
		}
	}
	if len(cache) >= cfg.MaxCacheSize { // evict the entry closest to expiry
		evictEarliest()
	}
	cache[cacheKey] = CacheItem{Data: repos, ExpiresAt: time.Now().Add(cfg.CacheTTL)}
	cacheMutex.Unlock()

	writeJSON(w, repos, rateRemaining)
}

// evictEarliest removes the cache entry with the soonest expiry.
// Caller must hold cacheMutex.
func evictEarliest() {
	var oldestKey string
	var oldest time.Time
	first := true
	for k, v := range cache {
		if first || v.ExpiresAt.Before(oldest) {
			oldest = v.ExpiresAt
			oldestKey = k
			first = false
		}
	}
	if oldestKey != "" {
		delete(cache, oldestKey)
	}
}

func writeJSON(w http.ResponseWriter, data interface{}, rateRemaining string) {
	if rateRemaining != "" {
		w.Header().Set("X-GitHub-RateLimit-Remaining", rateRemaining)
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(data)
}

func isValidGitHubUser(user string) bool {
	return len(user) <= 39 &&
		validUserRegex.MatchString(user) &&
		!strings.HasSuffix(user, "-") &&
		!strings.Contains(user, "--")
}

// ---------------------------------------------------------------------------
// GitHub fetching
// ---------------------------------------------------------------------------

type RawRepo struct {
	Name            string `json:"name"`
	FullName        string `json:"full_name"`
	Language        string `json:"language"`
	CreatedAt       string `json:"created_at"`
	UpdatedAt       string `json:"updated_at"`
	StargazersCount int    `json:"stargazers_count"`
	Fork            bool   `json:"fork"`
	Private         bool   `json:"private"`
}

// fetchGitHubData returns the user's repos (with commits for the most recently
// pushed MaxCommitRepos) and the remaining GitHub rate-limit budget.
func fetchGitHubData(ctx context.Context, username, token string, publicOnly bool) ([]RepoInfo, string, error) {
	var rawRepos []RawRepo
	var rateRemaining string
	page := 1

	for {
		reqURL := fmt.Sprintf("https://api.github.com/users/%s/repos?per_page=100&page=%d&sort=pushed",
			url.PathEscape(username), page)
		req, err := http.NewRequestWithContext(ctx, "GET", reqURL, nil)
		if err != nil {
			return nil, "", err
		}
		req.Header.Set("User-Agent", "CodeForest-Backend")
		req.Header.Set("Accept", "application/vnd.github+json")
		if token != "" {
			req.Header.Set("Authorization", token)
		}

		resp, err := globalClient.Do(req)
		if err != nil {
			return nil, "", err
		}
		if rl := resp.Header.Get("X-RateLimit-Remaining"); rl != "" {
			rateRemaining = rl
		}

		if resp.StatusCode != http.StatusOK {
			// SECURITY: bound the error body read to avoid OOM on hostile responses.
			bodyBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
			resp.Body.Close()
			return nil, rateRemaining, fmt.Errorf("github api returned status %d: %s", resp.StatusCode, string(bodyBytes))
		}

		var pageRepos []RawRepo
		// SECURITY: cap JSON body at 10MB to avoid OOM on malformed responses.
		if err := json.NewDecoder(io.LimitReader(resp.Body, 10<<20)).Decode(&pageRepos); err != nil {
			resp.Body.Close()
			return nil, rateRemaining, err
		}
		resp.Body.Close()

		rawRepos = append(rawRepos, pageRepos...)

		// SECURITY: hard stop at 5 pages (500 repos) to bound RAM and API usage.
		if len(pageRepos) < 100 || page >= 5 {
			break
		}
		page++
	}

	var result []RepoInfo
	var wg sync.WaitGroup
	var mu sync.Mutex

	// Higher concurrency when authenticated (5000 req/hr) vs anonymous (60 req/hr).
	concurrency := 2
	if token != "" {
		concurrency = 4
	}
	sem := make(chan struct{}, concurrency)

	commitBudget := 0
	for _, rr := range rawRepos {
		// SECURITY/PRIVACY: never emit a private repo on a public-only request.
		if publicOnly && rr.Private {
			continue
		}

		repo := toRepoInfo(rr)

		// Only fetch commits for the most-recently-pushed MaxCommitRepos repos
		// (the list is already sorted by `pushed`) to bound GitHub API calls.
		if commitBudget >= cfg.MaxCommitRepos {
			mu.Lock()
			result = append(result, repo)
			mu.Unlock()
			continue
		}
		commitBudget++

		wg.Add(1)
		go func(repo RepoInfo, fullName string) {
			defer wg.Done()

			select {
			case sem <- struct{}{}:
			case <-ctx.Done():
				return
			}
			defer func() { <-sem }()

			commits, err := fetchCommits(ctx, fullName, token)
			if err != nil {
				log.Printf("Warning: Failed to fetch commits for %s: %v", fullName, err)
			} else {
				repo.Commits = commits
			}

			mu.Lock()
			result = append(result, repo)
			mu.Unlock()
		}(repo, rr.FullName)
	}

	wg.Wait()

	if ctx.Err() != nil {
		return nil, rateRemaining, ctx.Err()
	}
	return result, rateRemaining, nil
}

func toRepoInfo(rr RawRepo) RepoInfo {
	lang := rr.Language
	if lang == "" {
		lang = "Unknown"
	}
	return RepoInfo{
		Name:      rr.Name,
		FullName:  rr.FullName,
		Language:  lang,
		CreatedAt: rr.CreatedAt,
		UpdatedAt: rr.UpdatedAt,
		Stars:     rr.StargazersCount,
		Fork:      rr.Fork,
	}
}

// commitsURL builds the GitHub commits endpoint for "owner/repo", escaping each
// path segment to prevent request-splitting / SSRF via a hostile full_name.
func commitsURL(fullName string) string {
	parts := strings.SplitN(fullName, "/", 2)
	for i, p := range parts {
		parts[i] = url.PathEscape(p)
	}
	return "https://api.github.com/repos/" + strings.Join(parts, "/") + "/commits?per_page=20"
}

func fetchCommits(ctx context.Context, fullName, token string) ([]CommitInfo, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", commitsURL(fullName), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "CodeForest-Backend")
	req.Header.Set("Accept", "application/vnd.github+json")
	if token != "" {
		req.Header.Set("Authorization", token)
	}

	resp, err := globalClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("status %d", resp.StatusCode)
	}

	var rawCommits []struct {
		Sha    string `json:"sha"`
		Commit struct {
			Message string `json:"message"`
		} `json:"commit"`
		HtmlUrl string `json:"html_url"`
	}
	// SECURITY: bound commit payload too.
	if err := json.NewDecoder(io.LimitReader(resp.Body, 5<<20)).Decode(&rawCommits); err != nil {
		return nil, err
	}

	var commits []CommitInfo
	for _, rc := range rawCommits {
		msg := rc.Commit.Message
		// First line only, for a cleaner UI.
		for i, c := range msg {
			if c == '\n' || c == '\r' {
				msg = msg[:i]
				break
			}
		}
		if len(msg) > 100 {
			msg = msg[:97] + "..."
		}

		hash := rc.Sha
		if len(hash) > 7 {
			hash = hash[:7]
		}

		commits = append(commits, CommitInfo{
			Hash:    hash,
			Message: msg,
			URL:     rc.HtmlUrl,
		})
	}
	return commits, nil
}
