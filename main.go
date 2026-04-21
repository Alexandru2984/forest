package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"sync"
	"time"
)

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
)

func main() {
	log.SetFlags(log.LstdFlags | log.Lshortfile)

	http.HandleFunc("/", handleStatus)
	http.HandleFunc("/api/", handleStatus)
	http.HandleFunc("/api/github", handleGitHub)
	http.HandleFunc("/github", handleGitHub)
	http.HandleFunc("//github", handleGitHub)

	port := ":8085"
	log.Printf("🌲 Code Forest Backend (v3 - Concurrent) is growing on %s...", port)
	if err := http.ListenAndServe(port, nil); err != nil {
		log.Fatalf("Failed to start server: %v", err)
	}
}

func handleStatus(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" && r.URL.Path != "/api/" {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(StatusResponse{
		Status:  "success",
		Message: "The roots of the Code Forest are active, concurrent and caching.",
		Version: "3.0.0",
	})
}

func handleGitHub(w http.ResponseWriter, r *http.Request) {
	user := r.URL.Query().Get("user")
	if user == "" {
		http.Error(w, "Missing 'user' parameter", http.StatusBadRequest)
		return
	}
	
	token := r.Header.Get("Authorization")

	if token != "" {
		log.Printf("Received authenticated request for user: %s (Token length: %d)", user, len(token))
	} else {
		log.Printf("Received UNAUTHENTICATED request for user: %s", user)
	}

	cacheKey := user
	if token != "" {
		cacheKey = user + "_auth" // Separate cache for authenticated requests
	}

	// Check Cache
	cacheMutex.RLock()
	item, found := cache[cacheKey]
	cacheMutex.RUnlock()

	if found && time.Now().Before(item.ExpiresAt) {
		log.Printf("Cache HIT for user: %s", user)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(item.Data)
		return
	}

	log.Printf("Cache MISS for user: %s, fetching ALL repos from GitHub concurrently...", user)
	repos, err := fetchGitHubData(user, token)
	if err != nil {
		log.Printf("Error fetching GitHub data for %s: %v", user, err)
		http.Error(w, fmt.Sprintf("%v", err), http.StatusBadGateway)
		return
	}

	// Save to Cache (10 minutes)
	cacheMutex.Lock()
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

func fetchGitHubData(username, token string) ([]RepoInfo, error) {
	client := &http.Client{Timeout: 45 * time.Second}
	var rawRepos []RawRepo
	page := 1

	for {
		req, err := http.NewRequest("GET", fmt.Sprintf("https://api.github.com/users/%s/repos?per_page=100&page=%d&sort=pushed", username, page), nil)
		if err != nil {
			return nil, err
		}
		req.Header.Set("User-Agent", "CodeForest-Backend")
		if token != "" {
			req.Header.Set("Authorization", token)
		}

		resp, err := client.Do(req)
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

		if len(pageRepos) < 100 {
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
			
			sem <- struct{}{}        // Acquire token
			
			// Optional: slight delay to keep GitHub completely happy
			time.Sleep(150 * time.Millisecond)

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

			commits, err := fetchCommits(client, r.FullName, token)
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

	return result, nil
}

func fetchCommits(client *http.Client, fullName, token string) ([]CommitInfo, error) {
	req, err := http.NewRequest("GET", fmt.Sprintf("https://api.github.com/repos/%s/commits?per_page=20", fullName), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "CodeForest-Backend")
	if token != "" {
		req.Header.Set("Authorization", token)
	}

	resp, err := client.Do(req)
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
