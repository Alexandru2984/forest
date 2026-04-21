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
	Name     string       `json:"name"`
	FullName string       `json:"full_name"`
	Language string       `json:"language"`
	Commits  []CommitInfo `json:"commits"`
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
	log.Printf("🌲 Code Forest Backend (v2) is growing on %s...", port)
	if err := http.ListenAndServe(port, nil); err != nil {
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
		Message: "The roots of the Code Forest are active and caching.",
		Version: "1.1.0",
	})
}

func handleGitHub(w http.ResponseWriter, r *http.Request) {
	user := r.URL.Query().Get("user")
	if user == "" {
		http.Error(w, "Missing 'user' parameter", http.StatusBadRequest)
		return
	}

	// Check Cache
	cacheMutex.RLock()
	item, found := cache[user]
	cacheMutex.RUnlock()

	if found && time.Now().Before(item.ExpiresAt) {
		log.Printf("Cache HIT for user: %s", user)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(item.Data)
		return
	}

	log.Printf("Cache MISS for user: %s, fetching from GitHub...", user)
	repos, err := fetchGitHubData(user)
	if err != nil {
		log.Printf("Error fetching GitHub data for %s: %v", user, err)
		http.Error(w, fmt.Sprintf("Failed to fetch data: %v", err), http.StatusInternalServerError)
		return
	}

	// Save to Cache (5 minutes)
	cacheMutex.Lock()
	cache[user] = CacheItem{
		Data:      repos,
		ExpiresAt: time.Now().Add(5 * time.Minute),
	}
	cacheMutex.Unlock()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(repos)
}

func fetchGitHubData(username string) ([]RepoInfo, error) {
	client := &http.Client{Timeout: 15 * time.Second}
	
	req, err := http.NewRequest("GET", fmt.Sprintf("https://api.github.com/users/%s/repos?per_page=15&sort=pushed", username), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "CodeForest-Backend")

	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		bodyBytes, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("github api returned status %d: %s", resp.StatusCode, string(bodyBytes))
	}

	var rawRepos []struct {
		Name     string `json:"name"`
		FullName string `json:"full_name"`
		Language string `json:"language"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&rawRepos); err != nil {
		return nil, err
	}

	var result []RepoInfo
	for _, rr := range rawRepos {
		repo := RepoInfo{
			Name:     rr.Name,
			FullName: rr.FullName,
			Language: rr.Language,
		}
		if repo.Language == "" {
			repo.Language = "Unknown"
		}

		// Fetch commits
		commits, _ := fetchCommits(client, rr.FullName)
		repo.Commits = commits
		result = append(result, repo)
	}

	return result, nil
}

func fetchCommits(client *http.Client, fullName string) ([]CommitInfo, error) {
	req, err := http.NewRequest("GET", fmt.Sprintf("https://api.github.com/repos/%s/commits?per_page=20", fullName), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "CodeForest-Backend")

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
