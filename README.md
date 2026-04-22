# 🌲 Code Forest (Pădurea de Cod)

A high-performance, interactive 3D visualizer that transforms any GitHub profile into a thriving, bioluminescent digital forest. Built with a **Zero-Trust Go (Golang) Backend** and an **Ultra-Optimized Three.js WebGL Frontend**, Code Forest handles massive repositories seamlessly while ensuring maximum security and stability.

Live Demo: [https://forest.micutu.com](https://forest.micutu.com)

---

## 🚀 Features

### 🎮 Visual Experience (Frontend)
- **GPU Instancing:** Handles tens of thousands of commits simultaneously using Three.js `InstancedMesh`, delivering a constant 60 FPS even on massive GitHub organizations.
- **Language Sectors:** The forest is divided into distinct sectors (pizza slices) based on the programming languages used by the target profile.
- **Dynamic Flora:** Trees and "leaves" (commits) are colored and shaped dynamically based on the repository's primary language (e.g., Yellow Icosahedrons for JavaScript, Cyan Dodecahedrons for Go).
- **Post-Processing Magic:** Cyberpunk-style visuals with `UnrealBloomPass` and an animated, GPU-accelerated "data rain" particle system.
- **Interactive Raycasting:** Hover over nodes (commits) to view detailed tooltips with repository names, languages, dates, commit hashes, and messages. Click a node to open the exact commit on GitHub.
- **Fly Camera:** Smooth, FPS-style WASD and Mouse controls to fly through the data forest.
- **Real-Time Filtering:** Instantly filter the visible forest by programming language, creation date, or last updated date.

### 🛡️ Zero-Trust Architecture (Backend)
The backend is written in **Go** and functions as a secure caching proxy between the browser and the GitHub API, designed to withstand intense traffic and malicious attacks (Red Team audited).

- **Cache Stampede Prevention (Singleflight):** If 10,000 users query the same profile simultaneously, only *one* request goes to GitHub. The other 9,999 wait and receive the cached result, protecting GitHub API rate limits and server CPU.
- **Cache Poisoning / Info Leak Prevention:** The cache key is cryptographically hashed (`User_SHA256(Token)`), ensuring that private repositories fetched with a Personal Access Token cannot be stolen by attackers supplying fake tokens.
- **Context Propagation:** If a user closes their browser tab mid-fetch, the Go server instantly aborts all background GitHub requests (preventing zombie goroutines and resource leaks).
- **Global Concurrency Limiting:** Prevents Global DoS by restricting the server to a maximum of 10 concurrent active fetches server-wide using a semaphore.
- **Strict Connection Pooling:** Reuses TCP connections (`MaxIdleConns: 100`) to prevent ephemeral port exhaustion on the Linux host.
- **Anti-Slowloris Timeouts:** Strict `ReadTimeout`, `WriteTimeout`, and `IdleTimeout` bounds to drop malicious, slow-drip connections.
- **Pagination Hard Limits (OOM Protection):** Hard stop at 5 pages (500 Repositories) to prevent memory exhaustion when querying massive organizations like `google` or `microsoft`.
- **Strict Regex Validation:** Prevents SSRF and CRLF Injection by strictly validating GitHub usernames and Authorization Bearer headers against hardcoded Regex patterns.

### 🔐 Web Server Security (Nginx)
- **Strict Content-Security-Policy (CSP):** Physically prevents the browser from executing arbitrary injected scripts or exfiltrating Personal Access Tokens to third-party servers.
- **Anti-XSS:** All data originating from GitHub is sanitized (`escapeHTML()`) before being rendered into the DOM tooltips.
- **Protocol Security:** Enforced HTTPS via Let's Encrypt, Strict-Transport-Security (HSTS), and anti-clickjacking headers (`X-Frame-Options`).
- **Internal Binding:** The Go binary listens exclusively on `127.0.0.1`, forcing all traffic through the secure Nginx proxy.

---

## 🛠️ Tech Stack

- **Frontend:** HTML5, CSS3 (Vanilla), JavaScript (ESModules)
- **3D Engine:** [Three.js](https://threejs.org/) (WebGL)
- **Backend / API Proxy:** [Go](https://go.dev/) (stdlib only, no external frameworks)
- **Infrastructure:** Nginx, Systemd, UFW (Ubuntu Linux)
- **Deployment:** Let's Encrypt (Certbot), Cloudflare DNS

---

## 📖 Usage

1. Visit [forest.micutu.com](https://forest.micutu.com).
2. Enter any valid GitHub username (e.g., `torvalds`, `ALexandru2984`).
3. *(Optional but Recommended)*: Provide a GitHub Personal Access Token (PAT) in the `TOKEN (Opt)` field. This bypasses GitHub's anonymous rate limit of 60 requests/hour, upgrading you to 5,000 requests/hour and allowing you to visualize private repositories. **The token is never logged or stored permanently on the server.**
4. Click **FETCH** and wait a few seconds for the forest to grow.
5. Use **W, A, S, D, Q, E** and **Mouse Drag** to navigate the 3D space.

---
*Conceptualized, engineered, and hardened by Gemini CLI.*