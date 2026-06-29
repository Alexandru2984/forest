# 🌲 Code Forest

[![Go](https://img.shields.io/badge/Go-1.22-00ADD8?logo=go&logoColor=white)](https://go.dev)
[![Three.js](https://img.shields.io/badge/Three.js-r150-000000?logo=threedotjs&logoColor=white)](https://threejs.org)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Live Demo](https://img.shields.io/badge/Live-forest.micutu.com-00ff80)](https://forest.micutu.com)

**Transform any GitHub profile into a living, bioluminescent 3D forest.** Each tree is a repository, each glowing leaf a commit, and language sectors paint the forest floor — rendered in real-time WebGL.

<p align="center">
  <a href="https://forest.micutu.com">🌐 Live Demo</a> •
  <a href="#features">Features</a> •
  <a href="#architecture">Architecture</a> •
  <a href="#getting-started">Getting Started</a> •
  <a href="#configuration">Configuration</a> •
  <a href="#api-reference">API Reference</a>
</p>

---

## Features

### 🎮 Visualization
| Feature | Details |
|---|---|
| **GPU Instancing** | Thousands of commit nodes via `InstancedMesh` at interactive frame rates |
| **Language Sectors** | The forest is divided into pizza-slice sectors per programming language |
| **Dynamic Flora** | Tree shape & colour mapped to language (yellow icosahedrons for JS, cyan for Go…) |
| **Post-Processing** | Cyberpunk bloom (`UnrealBloomPass`) + a 6000-particle data-rain system |
| **Interactive Raycasting** | Hover a leaf for commit details; click to open the commit on GitHub |
| **Fly Camera** | Smooth WASD + QE + mouse, plus an on-screen joystick on touch devices |
| **Real-Time Filtering** | Filter by language, creation or last-updated date — instant rebuild |

### 🧰 Tools
| Tool | Details |
|---|---|
| **Shareable Deep-Links** | `?user=&lang=&created=&updated=` auto-loads a view; 🔗 copies the link |
| **Session Memory** | Opt-in *Remember* keeps the username/token in `sessionStorage` (this tab only) |
| **Language Legend** | 🎨 colour swatches with per-language repo counts |
| **Repo Search** | 🔎 find a repository by name — the camera focuses and its leaves pulse |
| **PNG Export** | 📷 one-click snapshot of the current forest |
| **Random Dev** | 🎲 visualise a random famous developer |
| **Auto-Orbit & Help** | ⏯ idle camera orbit, ❓ in-app help modal |
| **Live Stats** | Repos · commits · languages · FPS · remaining GitHub API budget |

### 🛡️ Hardened Backend (Go, stdlib only)
| Defense | Implementation |
|---|---|
| **Cache Stampede Prevention** | Singleflight: many concurrent requests for one user = one GitHub call |
| **Cache-Key Token Binding** | Key = `user_SHA256(token)` — a forged/empty token can't read a cached private response |
| **Server-Token Fallback** | Optional `GITHUB_TOKEN` raises anonymous rate limits; private repos are always stripped |
| **Per-IP Rate Limiter** | In-process token bucket (honours `X-Real-IP`/`X-Forwarded-For`) |
| **CORS Middleware** | Origin allow-list with preflight handling |
| **Security Headers** | `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, `CORP` |
| **SSRF Hardening** | Regex-validated usernames + `url.PathEscape` on every upstream path segment |
| **CRLF Prevention** | Strict `Bearer` token format validation |
| **Resource Bounds** | Global concurrency semaphore, pagination cap, `io.LimitReader` on all upstreams |
| **Anti-Slowloris** | Strict `Read`/`Write`/`Idle` timeouts + capped header size |
| **Graceful Shutdown** | SIGINT/SIGTERM with a 30s drain |
| **Configurable** | Port, cache, rate limit, commit budget, origins & token via env vars |

### 🔐 Infrastructure (`deploy/`)
| Layer | Details |
|---|---|
| **Nginx** | Rate limiting, strict CSP (self-hosted three.js, hashed import map), HSTS, gzip — `deploy/nginx.conf` |
| **Systemd** | Hardened unit (`DynamicUser`, `ProtectSystem=strict`, `MemoryDenyWriteExecute`, syscall filter) — `deploy/code-forest.service` |
| **TLS** | Let's Encrypt + Cloudflare proxy |
| **Self-hosted libs** | three.js r150 vendored under `public/vendor/` — no third-party CDN at runtime |

---

## Architecture

```
┌──────────────────────────── BROWSER ───────────────────────────┐
│  index.html  ·  css/style.css  ·  js/app.js  ·  vendor/three/   │
│                         │ fetch(/api/github?user=X)             │
└─────────────────────────┼───────────────────────────────────────┘
                          │ HTTPS
┌─────────── CLOUDFLARE ──┼──  DDoS / DNS / CDN  ──────────────────┐
└─────────────────────────┼───────────────────────────────────────┘
                          │
┌─────────── NGINX ───────┼───────────────────────────────────────┐
│  CSP · HSTS · rate limit · static files · reverse proxy /api/   │
└─────────────────────────┼───────────────────────────────────────┘
                          │  127.0.0.1:8089
┌─────────── GO BACKEND ──┼───────────────────────────────────────┐
│ security headers → CORS → per-IP rate limit → handler           │
│ input validation · singleflight cache · global semaphore        │
│ context propagation · connection pool ──► api.github.com        │
└─────────────────────────────────────────────────────────────────┘
```

---

## Tech Stack
| Component | Technology |
|---|---|
| **Frontend** | HTML5, CSS3, vanilla JS (ES modules) |
| **3D Engine** | [Three.js](https://threejs.org/) r150 — **self-hosted**, loaded via a native import map |
| **Backend** | [Go](https://go.dev/) 1.22, standard library only (zero dependencies) |
| **Infra** | Nginx, systemd, Cloudflare, Let's Encrypt |
| **Analytics** | [Umami](https://umami.is/) (self-hosted) |

---

## Getting Started

### Prerequisites
- Go 1.22+
- A static file server for `public/` (nginx in prod; `python3 -m http.server` for local dev)

### Development
```bash
git clone https://github.com/Alexandru2984/forest.git
cd forest

make run            # build & start the API on 127.0.0.1:8089
# in another shell, serve the frontend:
cd public && python3 -m http.server 8080
# open http://localhost:8080  (the page proxies /api to the Go backend in prod;
# for pure local dev, run nginx from deploy/nginx.conf or a small proxy)

make check          # gofmt + vet + tests (same as CI)
```

### Production Deployment
```bash
make build                       # stripped binary
# copy binary to /opt/code-forest, public/ to /var/www/code-forest/public
# install deploy/nginx.conf, deploy/code-forest.service, deploy/code-forest.env.example
make deploy                      # rebuild + systemctl restart code-forest
```

---

## Configuration

All backend settings are environment variables (see `deploy/code-forest.env.example`):

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8089` | Listen port (always bound to `127.0.0.1`) |
| `CACHE_TTL` | `10m` | Cache expiration (Go duration) |
| `MAX_CACHE_SIZE` | `100` | Max cached user entries (evicts earliest-expiry) |
| `MAX_COMMIT_REPOS` | `60` | Fetch commits for at most N most-recently-pushed repos |
| `RATE_LIMIT_RPS` | `5` | Per-IP token-bucket rate (burst = 2×) |
| `ALLOWED_ORIGINS` | `https://forest.micutu.com` | Comma-separated CORS allow-list |
| `GITHUB_TOKEN` | *(empty)* | Optional server-side token; anonymous, public-only, raises rate limits |

> Editing the inline `<script type="importmap">` block? Recompute its CSP hash with `make csp-hash` and update `deploy/nginx.conf`.

---

## API Reference

### `GET /health`
Health probe. → `200 {"status":"ok"}`

### `GET /` or `GET /api/`
Service status. → `200 {"status":"success","message":"…","version":"9.0.0"}`

### `GET /api/github?user={username}`
Fetch repositories (and commits for the most recently pushed repos) for a GitHub user.

**Query:** `user` *(required)* — GitHub username (≤39 chars, alphanumeric + single hyphens).

**Headers:** `Authorization: Bearer <PAT>` *(optional)* — raises the rate limit (60→5000/hr) and enables private repos for **that** user.

**Response:** `200` — array of repos:
```json
[
  {
    "name": "my-repo",
    "full_name": "user/my-repo",
    "language": "Go",
    "created_at": "2024-01-15T…",
    "updated_at": "2026-06-18T…",
    "stars": 42,
    "fork": false,
    "commits": [
      { "hash": "abc1234", "message": "feat: add dark mode", "url": "https://github.com/user/my-repo/commit/abc1234…" }
    ]
  }
]
```
Response header `X-GitHub-RateLimit-Remaining` carries the remaining GitHub budget.

**Errors:** `400` invalid `user`/`Authorization` · `405` non-GET · `429` rate limited · `502` upstream error · `503` overloaded.

---

## Project Structure
```
code-forest/
├── main.go                  # Go backend (API proxy, caching, security, middleware)
├── main_test.go             # Unit tests
├── go.mod
├── Makefile                 # build / run / check / csp-hash / deploy
├── LICENSE                  # MIT
├── .editorconfig
├── .github/workflows/ci.yml # gofmt + vet + test + build
├── deploy/
│   ├── nginx.conf           # sample site config (CSP, rate limit, proxy)
│   ├── code-forest.service  # hardened systemd unit
│   └── code-forest.env.example
└── public/                  # served by nginx
    ├── index.html           # structure only
    ├── css/style.css        # design system + responsive layout
    ├── js/app.js            # Three.js app + features
    └── vendor/three/        # self-hosted three.js r150
```

---

## License
MIT — see [LICENSE](LICENSE).

*Built with Go, Three.js, and a lot of caffeine.* 🌲
