package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"regexp"
	"sync"
	"time"
)

// SECURITY: Strict GitHub username validation (Max 39 chars, alphanumeric, single hyphens inside)
var validUserRegex = regexp.MustCompile(`^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$`)

// SECURITY: Strict Token validation (Bearer format + safe characters only to prevent CRLF injection)
var validTokenRegex = regexp.MustCompile(`^Bearer [a-zA-Z0-9_.-]+$`)

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
	Commits   []CommitInfo `json:"commits"`
}

type CacheItem struct {
	Data      []RepoInfo
	ExpiresAt time.Time
}

var (
	cache      = make(map[string]CacheItem)
	cacheMutex sync.RWMutex
	maxCache   = 100 // Prevent OOM by limiting cache entries

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

func main() {
	log.SetFlags(log.LstdFlags | log.Lshortfile)

	mux := http.NewServeMux()
	mux.HandleFunc("/", handleStatus)
	mux.HandleFunc("/api/", handleStatus)
	mux.HandleFunc("/api/github", handleGitHub)
	mux.HandleFunc("/github", handleGitHub)
	mux.HandleFunc("//github", handleGitHub)

	// SECURITY: Mitigate Slowloris and connection exhaustion by setting strict server timeouts
	srv := &http.Server{
		Addr:         "127.0.0.1:8085",
		Handler:      mux,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 60 * time.Second,
		IdleTimeout:  120 * time.Second,
	}

	log.Printf("🌲 Code Forest Backend (v7.0 - Bulletproof) is growing on %s...", srv.Addr)
	if err := srv.ListenAndServe(); err != nil {
		log.Fatalf("Failed to start server: %v", err)
	}
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
		Version: "7.0.0",
	})
}

func handleGitHub(w http.ResponseWriter, r *http.Request) {
	user := r.URL.Query().Get("user")
	if user == "" {
		http.Error(w, "Missing 'user' parameter", http.StatusBadRequest)
		return
	}
	
	// SECURITY: Strict Regex Validation for GitHub usernames
	if len(user) > 39 || !validUserRegex.MatchString(user) {
		http.Error(w, "Invalid 'user' parameter format", http.StatusBadRequest)
		return
	}
	
	token := r.Header.Get("Authorization")

	if token != "" {
		// SECURITY: Prevent CRLF Injection and format violations
		if len(token) > 255 || !validTokenRegex.MatchString(token) {
			http.Error(w, "Invalid 'Authorization' header format", http.StatusBadRequest)
			return
		}
		log.Printf("Received authenticated request for user: %s (Token length: %d)", user, len(token))
	} else {
		log.Printf("Received UNAUTHENTICATED request for user: %s", user)
	}

	// SECURITY: CRITICAL VULNERABILITY FIX - Cache Key Information Disclosure
	// We MUST hash the token into the cache key so users cannot steal private repos 
	// by providing an invalid token for a cached authenticated response.
	cacheKey := user
	if token != "" {
		tokenHash := fmt.Sprintf("%x", sha256.Sum256([]byte(token)))
		cacheKey = user + "_" + tokenHash
	}

retry:
	// 1. Check Cache initially
	cacheMutex.RLock()
	item, found := cache[cacheKey]
	cacheMutex.RUnlock()

	if found && time.Now().Before(item.ExpiresAt) {
		log.Printf("Cache HIT for user: %s", user)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(item.Data)
		return
	}

	// 2. SECURITY: Cache Stampede Prevention (Singleflight logic)
	flightGroupMutex.Lock()
	if wg, exists := flightGroup[cacheKey]; exists {
		flightGroupMutex.Unlock()
		log.Printf("Request deduplication active for user: %s. Waiting...", user)
		wg.Wait()
		
		// SECURITY: Singleflight Cancellation DoS Prevention
		// If the leader failed or was canceled, we retry becoming the leader.
		cacheMutex.RLock()
		item, found = cache[cacheKey]
		cacheMutex.RUnlock()

		if found && time.Now().Before(item.ExpiresAt) {
			log.Printf("Cache HIT (Post-Wait) for user: %s", user)
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(item.Data)
			return
		}
		goto retry // The leader failed. We will try to lead!
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

	// SECURITY: Protect against Global Resource Exhaustion
	select {
	case globalSem <- struct{}{}:
		// Acquired global slot
	case <-r.Context().Done():
		log.Printf("Client disconnected before acquiring global slot for user: %s", user)
		return
	}
	defer func() { <-globalSem }()

	// 3. Leader actually fetches from GitHub
	log.Printf("Cache MISS for user: %s, fetching ALL repos from GitHub concurrently...", user)
	
	// Pass the context down!
	repos, err := fetchGitHubData(r.Context(), user, token)
	if err != nil {
		log.Printf("Error fetching GitHub data for %s: %v", user, err)
		http.Error(w, fmt.Sprintf("%v", err), http.StatusBadGateway)
		return
	}

	// 4. Update Cache Safely (Prevent Cache Thrashing DOS)
	cacheMutex.Lock()
	
	// First, purge any expired items
	now := time.Now()
	for k, v := range cache {
		if now.After(v.ExpiresAt) {
			delete(cache, k)
		}
	}
	
	// If still full, evict a single random item instead of the whole cache
	if len(cache) >= maxCache {
		log.Println("Cache is at maximum capacity. Evicting a single entry to prevent DOS.")
		for k := range cache {
			delete(cache, k)
			break // Only delete one
		}
	}
	
	cache[cacheKey] = CacheItem{
		Data:      repos,
		ExpiresAt: time.Now().Add(10 * time.Minute),
	}
	cacheMutex.Unlock()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(repos)
}

type RawRepo struct {
	Name      string `json:"name"`
	FullName  string `json:"full_name"`
	Language  string `json:"language"`
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
}

func fetchGitHubData(ctx context.Context, username, token string) ([]RepoInfo, error) {
	var rawRepos []RawRepo
	page := 1

	for {
		// Use RequestWithContext to abort immediately if the user disconnects!
		req, err := http.NewRequestWithContext(ctx, "GET", fmt.Sprintf("https://api.github.com/users/%s/repos?per_page=100&page=%d&sort=pushed", username, page), nil)
		if err != nil {
			return nil, err
		}
		req.Header.Set("User-Agent", "CodeForest-Backend")
		if token != "" {
			req.Header.Set("Authorization", token)
		}

		resp, err := globalClient.Do(req)
		if err != nil {
			return nil, err
		}
		
		if resp.StatusCode != http.StatusOK {
			bodyBytes, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			return nil, fmt.Errorf("github api returned status %d: %s", resp.StatusCode, string(bodyBytes))
		}

		var pageRepos []RawRepo
		if err := json.NewDecoder(resp.Body).Decode(&pageRepos); err != nil {
			resp.Body.Close()
			return nil, err
		}
		resp.Body.Close()

		rawRepos = append(rawRepos, pageRepos...)

		// SECURITY: Prevent Infinite Pagination DOS (Resource Exhaustion)
		// Hard stop at 5 pages (500 Repos) to protect server RAM and GitHub limits.
		if len(pageRepos) < 100 || page >= 5 {
			break
		}
		page++
	}

	var result []RepoInfo
	var wg sync.WaitGroup
	var mu sync.Mutex

	// Limit concurrency to 2 to prevent GitHub Abuse Rate Limiting
	sem := make(chan struct{}, 2)

	for _, rr := range rawRepos {
		wg.Add(1)
		go func(r RawRepo) {
			defer wg.Done()
			
			// Respect context when waiting for semaphore
			select {
			case sem <- struct{}{}:
			case <-ctx.Done():
				return // Abort early!
			}
			
			// Optional: slight delay to keep GitHub completely happy
			select {
			case <-time.After(150 * time.Millisecond):
			case <-ctx.Done():
				<-sem
				return
			}

			repo := RepoInfo{
				Name:      r.Name,
				FullName:  r.FullName,
				Language:  r.Language,
				CreatedAt: r.CreatedAt,
				UpdatedAt: r.UpdatedAt,
			}
			if repo.Language == "" {
				repo.Language = "Unknown"
			}

			commits, err := fetchCommits(ctx, r.FullName, token)
			if err != nil {
				log.Printf("Warning: Failed to fetch commits for %s: %v", r.FullName, err)
			} else {
				repo.Commits = commits
			}
			
			<-sem // Release token
			
			mu.Lock()
			result = append(result, repo)
			mu.Unlock()
		}(rr)
	}

	wg.Wait()

	// Ensure we didn't return half-baked data because of a cancellation
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}

	return result, nil
}

func fetchCommits(ctx context.Context, fullName, token string) ([]CommitInfo, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", fmt.Sprintf("https://api.github.com/repos/%s/commits?per_page=20", fullName), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "CodeForest-Backend")
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
	if err := json.NewDecoder(resp.Body).Decode(&rawCommits); err != nil {
		return nil, err
	}

	var commits []CommitInfo
	for _, rc := range rawCommits {
		msg := rc.Commit.Message
		if len(msg) > 100 {
			msg = msg[:97] + "..."
		}
		// Get first line only for cleaner UI
		for i, c := range msg {
			if c == '\n' || c == '\r' {
				msg = msg[:i]
				break
			}
		}

		commits = append(commits, CommitInfo{
			Hash:    rc.Sha[:7], // Short hash
			Message: msg,
			URL:     rc.HtmlUrl,
		})
	}
	return commits, nil
}