package main

import (
	"encoding/json"
	"log"
	"net/http"
)

type StatusResponse struct {
	Status  string `json:"status"`
	Message string `json:"message"`
	Version string `json:"version"`
}

func main() {
	// Configure logging
	log.SetFlags(log.LstdFlags | log.Lshortfile)

	// API routes
	http.HandleFunc("/", handleStatus)

	port := ":8085"
	log.Printf("🌲 Code Forest Backend is growing on %s...", port)
	
	// Start server
	if err := http.ListenAndServe(port, nil); err != nil {
		log.Fatalf("Failed to start server: %v", err)
	}
}

func handleStatus(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	
	response := StatusResponse{
		Status:  "success",
		Message: "The roots of the Code Forest are active.",
		Version: "0.1.0",
	}

	if err := json.NewEncoder(w).Encode(response); err != nil {
		http.Error(w, "Failed to encode response", http.StatusInternalServerError)
		log.Printf("Encoding error: %v", err)
	}
}