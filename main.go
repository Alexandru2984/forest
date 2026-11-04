package main

import (
	"context"
	"crypto/sha256"
	"embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"math"
	"net"
	"net/http"
	"net/netip"
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

const version = "10.0.0"
const maxIPBuckets = 10000

//go:embed public
var publicFiles embed.FS

var validUserRegex = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$`)
var validTokenRegex = regexp.MustCompile(`^Bearer [a-zA-Z0-9_.-]+$`)
var validRepoRegex = regexp.MustCompile(`^[a-zA-Z0-9_.-]{1,100}$`)
var validSHARegex = regexp.MustCompile(`^[a-fA-F0-9]{7,64}$`)

type Config struct {
	Port           string
	CacheTTL       time.Duration
	MaxCacheSize   int
	MaxCommitRepos int
	RateLimitRPS   float64
	FetchTimeout   time.Duration
	GitHubToken    string
	AllowedOrigins map[string]bool
}

func loadConfig() Config {
	return Config{
		Port:           strconv.Itoa(min(getenvInt("PORT", 8089), 65535)),
		CacheTTL:       min(getenvDuration("CACHE_TTL", 10*time.Minute), time.Hour),
		MaxCacheSize:   min(getenvInt("MAX_CACHE_SIZE", 100), 100),
		MaxCommitRepos: min(getenvInt("MAX_COMMIT_REPOS", 20), 60),
		RateLimitRPS:   min(getenvFloat("RATE_LIMIT_RPS", 5), 100),
		FetchTimeout:   min(getenvDuration("FETCH_TIMEOUT", 25*time.Second), 45*time.Second),
		GitHubToken:    strings.TrimSpace(os.Getenv("GITHUB_TOKEN")),
		AllowedOrigins: parseOrigins(getenvStr("ALLOWED_ORIGINS", "https://forest.micutu.com")),
	}
}
func getenvStr(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}
func getenvInt(key string, def int) int {
	n, e := strconv.Atoi(strings.TrimSpace(os.Getenv(key)))
	if e == nil && n > 0 {
		return n
	}
	return def
}
func getenvFloat(key string, def float64) float64 {
	n, e := strconv.ParseFloat(strings.TrimSpace(os.Getenv(key)), 64)
	if e == nil && n > 0 && !math.IsInf(n, 0) && !math.IsNaN(n) {
		return n
	}
	return def
}
func getenvDuration(key string, def time.Duration) time.Duration {
	n, e := time.ParseDuration(strings.TrimSpace(os.Getenv(key)))
	if e == nil && n > 0 {
		return n
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

var cfg = loadConfig()

type StatusResponse struct {
	Status  string `json:"status"`
	Message string `json:"message"`
	Version string `json:"version"`
}
type CommitInfo struct {
	Hash    string `json:"hash"`
	Message string `json:"message"`
	URL     string `json:"url"`
	Date    string `json:"date,omitempty"`
}
type RepoInfo struct {
	Name         string       `json:"name"`
	FullName     string       `json:"full_name"`
	Language     string       `json:"language"`
	Description  string       `json:"description"`
	URL          string       `json:"url"`
	CreatedAt    string       `json:"created_at"`
	UpdatedAt    string       `json:"updated_at"`
	PushedAt     string       `json:"pushed_at"`
	Stars        int          `json:"stars"`
	Forks        int          `json:"forks"`
	OpenIssues   int          `json:"open_issues"`
	Fork         bool         `json:"fork"`
	Archived     bool         `json:"archived"`
	Topics       []string     `json:"topics"`
	CommitStatus string       `json:"commit_status"`
	Commits      []CommitInfo `json:"commits"`
}
type Snapshot struct {
	Repos         []RepoInfo
	RateRemaining string
	Sampled       int
	Failed        int
	Truncated     bool
	FetchedAt     time.Time
}
type CacheItem struct {
	Data      []RepoInfo
	ExpiresAt time.Time
	Snapshot  Snapshot
}
type flightCall struct {
	done     chan struct{}
	snapshot Snapshot
	err      error
}

var (
	cache            = make(map[string]CacheItem)
	cacheMutex       sync.RWMutex
	flightGroup      = make(map[string]*flightCall)
	flightGroupMutex sync.Mutex
	globalSem        = make(chan struct{}, 10)
	globalClient     = &http.Client{
		Timeout:       15 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		Transport: &http.Transport{
			DialContext:         (&net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
			TLSHandshakeTimeout: 5 * time.Second, ResponseHeaderTimeout: 10 * time.Second,
			MaxConnsPerHost: 40, MaxIdleConns: 40, MaxIdleConnsPerHost: 40, IdleConnTimeout: 90 * time.Second,
		},
	}
)

func main() {
	log.SetFlags(log.LstdFlags | log.LUTC)
	srv := &http.Server{Addr: "127.0.0.1:" + cfg.Port, Handler: newHandler(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 55 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 1 << 14}
	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
		defer stop()
		<-ctx.Done()
		drain, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err := srv.Shutdown(drain); err != nil {
			log.Printf("Shutdown: %v", err)
			_ = srv.Close()
		}
	}()
	log.Printf("Code Forest %s listening on %s; fetch deadline=%s; commit sample budget=%d", version, srv.Addr, cfg.FetchTimeout, cfg.MaxCommitRepos)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
	<-stopped
}

func newHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/", handleStatus)
	mux.HandleFunc("/api/github", handleGitHub)
	mux.HandleFunc("/github", handleGitHub)
	mux.HandleFunc("/health", handleHealth)
	assets, _ := fs.Sub(publicFiles, "public")
	files := http.FileServer(http.FS(assets))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if !readMethod(w, r) {
			return
		}
		path := strings.TrimPrefix(r.URL.Path, "/")
		if path == "" {
			path = "index.html"
		}
		info, err := fs.Stat(assets, path)
		if err != nil || info.IsDir() {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Cache-Control", "no-cache")
		files.ServeHTTP(w, r)
	})
	return securityHeadersMiddleware(corsMiddleware(newRateLimiter(cfg.RateLimitRPS).middleware(mux)))
}

var contentSecurityPolicy = func() string {
	html, _ := publicFiles.ReadFile("public/index.html")
	match := regexp.MustCompile(`(?s)<script type="importmap">(.*?)</script>`).FindSubmatch(html)
	script := "'self'"
	if len(match) > 1 {
		hash := sha256.Sum256(match[1])
		script += " 'sha256-" + base64.StdEncoding.EncodeToString(hash[:]) + "'"
	}
	return "default-src 'self'; script-src " + script + "; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; worker-src 'none'"
}()

func securityHeadersMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Cross-Origin-Resource-Policy", "same-origin")
		h.Set("Content-Security-Policy", contentSecurityPolicy)
		h.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()")
		if strings.HasPrefix(r.URL.Path, "/api/") || r.URL.Path == "/github" || r.URL.Path == "/health" {
			h.Set("Cache-Control", "private, no-store")
			h.Add("Vary", "Authorization")
		}
		next.ServeHTTP(w, r)
	})
}
func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Add("Vary", "Origin")
		origin := r.Header.Get("Origin")
		sameOrigin := origin == "http://"+r.Host && r.TLS == nil || origin == "https://"+r.Host && r.TLS != nil
		allowed := origin != "" && (cfg.AllowedOrigins[origin] || sameOrigin)
		if origin != "" && !allowed {
			apiError(w, http.StatusForbidden, "origin_not_allowed", "Origin not allowed")
			return
		}
		if allowed {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Expose-Headers", "X-GitHub-RateLimit-Remaining, X-Forest-Cache, X-Forest-Sampled, X-Forest-Failed, X-Forest-Truncated, X-Forest-Fetched-At, Retry-After")
		}
		if r.Method == http.MethodOptions {
			w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

type ipBucket struct {
	tokens float64
	last   time.Time
}
type rateLimiter struct {
	mu         sync.Mutex
	ips        map[string]*ipBucket
	rps, burst float64
	cleaned    time.Time
}

func newRateLimiter(rps float64) *rateLimiter {
	return &rateLimiter{ips: make(map[string]*ipBucket), rps: rps, burst: math.Max(1, rps*2)}
}
func (rl *rateLimiter) allow(ip string) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	now := time.Now()
	if now.Sub(rl.cleaned) > time.Minute {
		for key, b := range rl.ips {
			if now.Sub(b.last) > 10*time.Minute {
				delete(rl.ips, key)
			}
		}
		rl.cleaned = now
	}
	b, ok := rl.ips[ip]
	if !ok {
		if len(rl.ips) >= maxIPBuckets {
			return false
		}
		rl.ips[ip] = &ipBucket{tokens: rl.burst - 1, last: now}
		return true
	}
	b.tokens = math.Min(rl.burst, b.tokens+now.Sub(b.last).Seconds()*rl.rps)
	b.last = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}
func (rl *rateLimiter) middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if (r.URL.Path == "/api/github" || r.URL.Path == "/github") && !rl.allow(clientIP(r)) {
			w.Header().Set("Retry-After", strconv.Itoa(max(1, int(math.Ceil(1/rl.rps)))))
			apiError(w, http.StatusTooManyRequests, "rate_limited", "Too many requests. Please wait and retry.")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// Only a local proxy can supply one validated X-Real-IP. It must overwrite it
// using its authenticated edge address. Arbitrary XFF chains are never trusted.
func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	peer, err := netip.ParseAddr(host)
	if err != nil {
		return "unknown"
	}
	if peer.IsLoopback() {
		if ip, err := netip.ParseAddr(strings.TrimSpace(r.Header.Get("X-Real-IP"))); err == nil && ip.Zone() == "" {
			return ip.Unmap().String()
		}
	}
	return peer.Unmap().String()
}
func readMethod(w http.ResponseWriter, r *http.Request) bool {
	if r.Method == http.MethodGet || r.Method == http.MethodHead {
		return true
	}
	w.Header().Set("Allow", "GET, HEAD, OPTIONS")
	apiError(w, 405, "method_not_allowed", "Method not allowed")
	return false
}
func handleHealth(w http.ResponseWriter, r *http.Request) {
	if readMethod(w, r) {
		writeJSON(w, map[string]string{"status": "ok"}, "")
	}
}
func handleStatus(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" && r.URL.Path != "/api/" {
		http.NotFound(w, r)
		return
	}
	if readMethod(w, r) {
		writeJSON(w, StatusResponse{Status: "success", Message: "Public GitHub repository explorer with bounded recent commit samples.", Version: version}, "")
	}
}
func apiError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"code": code, "message": message}})
}
func writeJSON(w http.ResponseWriter, data any, rateRemaining string) {
	if rateRemaining != "" {
		w.Header().Set("X-GitHub-RateLimit-Remaining", rateRemaining)
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(data)
}
func isValidGitHubUser(user string) bool {
	return len(user) <= 39 && validUserRegex.MatchString(user) && !strings.HasSuffix(user, "-") && !strings.Contains(user, "--")
}

func handleGitHub(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Add("Vary", "Authorization")
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET, OPTIONS")
		apiError(w, 405, "method_not_allowed", "Method Not Allowed")
		return
	}
	users, exists := r.URL.Query()["user"]
	if !exists || len(users) == 0 || users[0] == "" {
		apiError(w, 400, "invalid_user", "Missing 'user' parameter")
		return
	}
	if len(users) != 1 || !isValidGitHubUser(users[0]) {
		apiError(w, 400, "invalid_user", "Invalid 'user' parameter format")
		return
	}
	user := strings.ToLower(users[0])
	token := r.Header.Get("Authorization")
	if len(r.Header.Values("Authorization")) > 1 || (token != "" && (len(token) > 255 || !validTokenRegex.MatchString(token))) {
		apiError(w, 400, "invalid_token", "Invalid 'Authorization' header format")
		return
	}
	cacheKey := user
	if token != "" {
		cacheKey += fmt.Sprintf("_%x", sha256.Sum256([]byte(token)))
	}
	if token == "" && cfg.GitHubToken != "" {
		token = "Bearer " + cfg.GitHubToken
	}
	if s, ok := cachedSnapshot(cacheKey); ok {
		writeSnapshot(w, s, "hit")
		return
	}

	flightGroupMutex.Lock()
	// Close the race between an initial cache read and a completed leader.
	if s, ok := cachedSnapshot(cacheKey); ok {
		flightGroupMutex.Unlock()
		writeSnapshot(w, s, "hit")
		return
	}
	if call, ok := flightGroup[cacheKey]; ok {
		flightGroupMutex.Unlock()
		select {
		case <-r.Context().Done():
			return
		case <-call.done:
			writeFetchResult(w, call.snapshot, call.err, "shared")
			return
		}
	}
	select {
	case globalSem <- struct{}{}:
	default:
		flightGroupMutex.Unlock()
		w.Header().Set("Retry-After", "2")
		apiError(w, 503, "busy", "Service busy. Please retry shortly.")
		return
	}
	call := &flightCall{done: make(chan struct{})}
	flightGroup[cacheKey] = call
	flightGroupMutex.Unlock()
	defer func() {
		flightGroupMutex.Lock()
		delete(flightGroup, cacheKey)
		close(call.done)
		flightGroupMutex.Unlock()
		<-globalSem
	}()
	ctx, cancel := context.WithTimeout(r.Context(), cfg.FetchTimeout)
	defer cancel()
	call.snapshot, call.err = fetchGitHubSnapshot(ctx, user, token)
	if call.err == nil {
		cacheMutex.Lock()
		now := time.Now()
		for k, v := range cache {
			if !now.Before(v.ExpiresAt) {
				delete(cache, k)
			}
		}
		if len(cache) >= cfg.MaxCacheSize {
			evictEarliest()
		}
		cache[cacheKey] = CacheItem{Data: call.snapshot.Repos, Snapshot: call.snapshot, ExpiresAt: now.Add(cfg.CacheTTL)}
		cacheMutex.Unlock()
	}
	writeFetchResult(w, call.snapshot, call.err, "miss")
}
func cachedSnapshot(key string) (Snapshot, bool) {
	cacheMutex.RLock()
	defer cacheMutex.RUnlock()
	s, ok := cache[key]
	return s.Snapshot, ok && time.Now().Before(s.ExpiresAt)
}
func evictEarliest() {
	var key string
	var oldest time.Time
	for k, v := range cache {
		if key == "" || v.ExpiresAt.Before(oldest) {
			key = k
			oldest = v.ExpiresAt
		}
	}
	delete(cache, key)
}
func writeSnapshot(w http.ResponseWriter, s Snapshot, cacheStatus string) {
	h := w.Header()
	h.Set("X-Forest-Cache", cacheStatus)
	h.Set("X-Forest-Sampled", strconv.Itoa(s.Sampled))
	h.Set("X-Forest-Failed", strconv.Itoa(s.Failed))
	h.Set("X-Forest-Truncated", strconv.FormatBool(s.Truncated))
	h.Set("X-Forest-Fetched-At", s.FetchedAt.UTC().Format(time.RFC3339))
	writeJSON(w, s.Repos, s.RateRemaining)
}

type upstreamError struct {
	status int
	retry  string
}

func (e *upstreamError) Error() string { return fmt.Sprintf("GitHub status %d", e.status) }
func writeFetchResult(w http.ResponseWriter, s Snapshot, err error, source string) {
	if err == nil {
		writeSnapshot(w, s, source)
		return
	}
	status, code, message := 502, "upstream_error", "GitHub is temporarily unavailable. Please retry."
	var upstream *upstreamError
	if errors.As(err, &upstream) {
		switch upstream.status {
		case 404:
			status, code, message = 404, "user_not_found", "GitHub user not found. Check the username."
		case 401:
			status, code, message = 401, "invalid_token", "GitHub rejected the token. Remove or replace it."
		case 403:
			status, code, message = 403, "github_forbidden", "GitHub denied this request. Try again later."
		case 429:
			status, code, message = 429, "github_rate_limited", "GitHub API budget exhausted. Wait or use a public-read token."
		}
		if upstream.retry != "" {
			w.Header().Set("Retry-After", upstream.retry)
		}
	} else if errors.Is(err, context.DeadlineExceeded) {
		status, code, message = 504, "upstream_timeout", "GitHub took too long. Please retry."
	}
	apiError(w, status, code, message)
}

type RawRepo struct {
	Name            string   `json:"name"`
	FullName        string   `json:"full_name"`
	Language        string   `json:"language"`
	Description     string   `json:"description"`
	CreatedAt       string   `json:"created_at"`
	UpdatedAt       string   `json:"updated_at"`
	PushedAt        string   `json:"pushed_at"`
	StargazersCount int      `json:"stargazers_count"`
	ForksCount      int      `json:"forks_count"`
	OpenIssues      int      `json:"open_issues_count"`
	Fork            bool     `json:"fork"`
	Private         bool     `json:"private"`
	Archived        bool     `json:"archived"`
	Topics          []string `json:"topics"`
}

func githubRequest(ctx context.Context, endpoint, token string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "CodeForest/"+version)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	if token != "" {
		req.Header.Set("Authorization", token)
	}
	resp, err := globalClient.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != 200 {
		defer resp.Body.Close()
		status := resp.StatusCode
		if status == 403 && (resp.Header.Get("X-RateLimit-Remaining") == "0" || resp.Header.Get("Retry-After") != "") {
			status = 429
		}
		retry := ""
		if status == 429 {
			seconds := 60
			if reset, e := strconv.ParseInt(resp.Header.Get("X-RateLimit-Reset"), 10, 64); e == nil {
				seconds = int(time.Until(time.Unix(reset, 0)).Seconds()) + 1
			}
			if n, e := strconv.Atoi(resp.Header.Get("Retry-After")); e == nil {
				seconds = n
			}
			retry = strconv.Itoa(max(1, min(seconds, 3600)))
		}
		return nil, &upstreamError{status: status, retry: retry}
	}
	return resp, nil
}
func decodeBounded(body io.Reader, limit int64, target any) error {
	data, err := io.ReadAll(io.LimitReader(body, limit+1))
	if err != nil {
		return err
	}
	if int64(len(data)) > limit {
		return errors.New("GitHub payload too large")
	}
	return json.Unmarshal(data, target)
}
func fetchGitHubSnapshot(ctx context.Context, username, token string) (Snapshot, error) {
	snapshot := Snapshot{Repos: []RepoInfo{}, FetchedAt: time.Now()}
	for page := 1; page <= 5; page++ {
		endpoint := fmt.Sprintf("https://api.github.com/users/%s/repos?per_page=100&page=%d&sort=pushed&type=owner", url.PathEscape(username), page)
		resp, err := githubRequest(ctx, endpoint, token)
		if err != nil {
			return snapshot, err
		}
		snapshot.RateRemaining = resp.Header.Get("X-RateLimit-Remaining")
		var repos []RawRepo
		err = decodeBounded(resp.Body, 10<<20, &repos)
		resp.Body.Close()
		if err != nil {
			return snapshot, err
		}
		if len(repos) > 100 {
			return snapshot, errors.New("Unexpected GitHub page size")
		}
		for _, repo := range repos {
			// This is a public explorer, including when a token raises its API quota.
			if repo.Private {
				continue
			}
			parts := strings.Split(repo.FullName, "/")
			if len(parts) != 2 || !strings.EqualFold(parts[0], username) || !validRepoRegex.MatchString(parts[1]) || parts[1] == "." || parts[1] == ".." {
				return snapshot, errors.New("Invalid GitHub repository name")
			}
			snapshot.Repos = append(snapshot.Repos, toRepoInfo(repo))
		}
		if len(repos) < 100 {
			break
		}
		if page == 5 {
			snapshot.Truncated = true
		}
	}
	budget := min(cfg.MaxCommitRepos, len(snapshot.Repos))
	if remaining, err := strconv.Atoi(snapshot.RateRemaining); err == nil {
		budget = min(budget, max(0, remaining-2))
	}
	sem := make(chan struct{}, 2)
	var wg sync.WaitGroup
	var mu sync.Mutex
	for i := 0; i < budget; i++ {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
			case <-ctx.Done():
				return
			}
			defer func() { <-sem }()
			commits, err := fetchCommits(ctx, snapshot.Repos[index].FullName, token)
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				snapshot.Repos[index].CommitStatus = "unavailable"
				snapshot.Failed++
			} else {
				snapshot.Repos[index].Commits = commits
				snapshot.Repos[index].CommitStatus = "sampled"
				snapshot.Sampled++
				if len(commits) == 0 {
					snapshot.Repos[index].CommitStatus = "empty"
				}
			}
		}(i)
	}
	wg.Wait()
	if ctx.Err() != nil {
		return snapshot, ctx.Err()
	}
	// The list endpoint's quota predates the fan-out; subtract scheduled calls.
	if remaining, err := strconv.Atoi(snapshot.RateRemaining); err == nil {
		snapshot.RateRemaining = strconv.Itoa(max(0, remaining-budget))
	}
	return snapshot, nil
}
func toRepoInfo(rr RawRepo) RepoInfo {
	lang := rr.Language
	if lang == "" {
		lang = "Unknown"
	}
	topics := rr.Topics
	if topics == nil {
		topics = []string{}
	}
	return RepoInfo{Name: rr.Name, FullName: rr.FullName, Language: lang, Description: truncateText(rr.Description, 500), URL: "https://github.com/" + rr.FullName, CreatedAt: rr.CreatedAt, UpdatedAt: rr.UpdatedAt, PushedAt: rr.PushedAt, Stars: rr.StargazersCount, Forks: rr.ForksCount, OpenIssues: rr.OpenIssues, Fork: rr.Fork, Archived: rr.Archived, Topics: topics, CommitStatus: "not_sampled", Commits: []CommitInfo{}}
}
func commitsURL(fullName string) string {
	parts := strings.SplitN(fullName, "/", 2)
	for i, p := range parts {
		parts[i] = url.PathEscape(p)
	}
	return "https://api.github.com/repos/" + strings.Join(parts, "/") + "/commits?per_page=20"
}
func truncateText(text string, limit int) string {
	runes := []rune(text)
	if len(runes) > limit {
		return string(runes[:limit-1]) + "…"
	}
	return text
}
func fetchCommits(ctx context.Context, fullName, token string) ([]CommitInfo, error) {
	resp, err := githubRequest(ctx, commitsURL(fullName), token)
	var upstream *upstreamError
	if errors.As(err, &upstream) && upstream.status == 409 {
		return []CommitInfo{}, nil
	}
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var raw []struct {
		Sha    string `json:"sha"`
		Commit struct {
			Message string `json:"message"`
			Author  struct {
				Date string `json:"date"`
			} `json:"author"`
		} `json:"commit"`
	}
	if err := decodeBounded(resp.Body, 5<<20, &raw); err != nil {
		return nil, err
	}
	result := make([]CommitInfo, 0, min(20, len(raw)))
	for _, commit := range raw[:min(20, len(raw))] {
		if !validSHARegex.MatchString(commit.Sha) {
			continue
		}
		message := strings.FieldsFunc(commit.Commit.Message, func(r rune) bool { return r == '\n' || r == '\r' })
		title := ""
		if len(message) > 0 {
			title = truncateText(message[0], 100)
		}
		result = append(result, CommitInfo{Hash: commit.Sha[:7], Message: title, URL: "https://github.com/" + fullName + "/commit/" + commit.Sha, Date: commit.Commit.Author.Date})
	}
	return result, nil
}
