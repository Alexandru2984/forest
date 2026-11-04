# Code Forest

Explore public GitHub repositories as an interactive forest, with a complete searchable collection alongside the 3D view. The frontend and its verified three.js runtime are embedded in a single Go binary. No CDN, third-party scripts, account or database is required.

Live: [forest.micutu.com](https://forest.micutu.com). [Product roadmap](docs/ROADMAP.md) · [Security audit](docs/SECURITY-AUDIT.md) · [Operations](docs/OPERATIONS.md).

## Explore

- A bundled, clearly labeled fictional demo that uses no GitHub quota.
- Selectable repository trees, deterministic layouts, camera focus/reset, orbit, pause, PNG export and fullscreen where supported.
- Rendering quality controls, low-power mode on mobile, reduced-motion support and background suspension. The collection remains usable without WebGL.
- Search repository names, descriptions and topics. Combine language, star, creation/push date, fork and archive filters.
- Sort by recent push, stars, name, creation date or number of sampled commits. Switch grid/list layouts and load more projects.
- Repository details, topics, canonical GitHub links and recent commit samples. Metadata-only repositories remain visible.
- Favorites stored only on this device, public share links and filtered JSON/CSV exports with spreadsheet formula neutralization.
- Optional public-read tokens stay in memory. Tokens are never persisted, shared or exported. Old session token entries are removed.

This is a snapshot explorer, not a full contribution-history service. It returns **up to 500 public repositories** and **up to 20 recent commits per sampled repository**. The default sample budget is 20 repositories, capped by quota and configuration. Private repositories are excluded even when a token is supplied. The UI explains sample coverage and partial failures.

## Run locally

Use Node 24+ for checks and a current Go toolchain. `go.mod` requires Go 1.26.10 or later and selects Go 1.27.3; standard Go toolchain auto-download handles the selection without replacing your global installation.

```sh
npm ci --ignore-scripts
PORT=18089 make run
# Open http://127.0.0.1:18089 — frontend and API share the same origin.
```

Production already uses port 8089 on this VPS, so local preview examples use 18089. The binary always binds to loopback. Running `make build` writes `build/code-forest`, never overwrites the running production binary and needs no Node runtime afterward. Always build the entire package (`go build .`), including embedded assets.

## Verify

```sh
make check             # formatting, vet, Go race tests, model tests, asset integrity
make security          # pinned govulncheck + npm audit
npx playwright install --with-deps chromium --only-shell
npm run test:browser   # desktop/mobile, errors, storage/export privacy, XSS and axe
make build
```

Browser tests mock GitHub and do not use real credentials or GitHub quota. CI starts its own local server; development reuses an existing preview on port 18089 if available. Traces and screenshots are written to ignored `test-results/`. CI is read-only, uses pinned action commits, installs locked dependencies without lifecycle scripts and uploads diagnostics only on failure. GitHub Actions execution requires pushing these commits; a local run does not prove a remote workflow has executed.

The vendored runtime is three.js **0.150.1**, with its MIT license and SHA-256 manifest under `public/vendor/three/`. `npm run check:assets` validates the manifest and local import graph. Keep runtime and addons on the same version when upgrading. There are no production npm or external Go module dependencies.

## Configuration

See [deploy/code-forest.env.example](deploy/code-forest.env.example). Environment files may contain secrets: keep them outside Git and readable only by the service administrator.

| Variable           | Default                     | Limit / behavior                                                                  |
| ------------------ | --------------------------- | --------------------------------------------------------------------------------- |
| `PORT`             | `8089`                      | Loopback listener; valid TCP port                                                 |
| `CACHE_TTL`        | `10m`                       | Maximum 1 hour                                                                    |
| `MAX_CACHE_SIZE`   | `100`                       | Maximum 100 credential-bound in-memory entries                                    |
| `MAX_COMMIT_REPOS` | `20`                        | Maximum 60; samples can be lower when quota is low                                |
| `FETCH_TIMEOUT`    | `25s`                       | Deadline for the entire GitHub operation; maximum 45s                             |
| `RATE_LIMIT_RPS`   | `5`                         | Per-IP token bucket; maximum 100; burst at least 1                                |
| `ALLOWED_ORIGINS`  | `https://forest.micutu.com` | Comma-separated CORS allow-list; actual same-origin requests also work            |
| `GITHUB_TOKEN`     | empty                       | Optional server public-read token used to raise quota; never enables private data |

## API

- `GET /health`: liveness, `{ "status": "ok" }`.
- `GET /api/`: service description and version. `/` serves the application.
- `GET /api/github?user=octocat`: array of public repository metadata and recent commit samples. `/github` is a compatibility alias.
- Optional `Authorization: Bearer <public-read-token>` raises the available GitHub budget.

Each repository includes name, full name, canonical URL, language, description, topics, stars, forks, open issues, fork/archive flags, timestamps, `commits`, and `commit_status` (`sampled`, `empty`, `not_sampled` or `unavailable`). Arrays are never `null`. Results retain upstream push order before client sorting.

Coverage headers: `X-Forest-Sampled`, `X-Forest-Failed`, `X-Forest-Truncated`, `X-Forest-Fetched-At`, `X-Forest-Cache`. `X-GitHub-RateLimit-Remaining` is an estimate after scheduling commit requests, not a reservation against other users of the same GitHub quota. At a five-page boundary `Truncated` is conservative: there may be exactly 500 repositories.

Errors have `{ "error": { "code": "…", "message": "…" } }`: 400 invalid input, 401 rejected token, 403 denied origin/upstream access, 404 user missing, 405 method, 429 quota/rate limit, 502 upstream error, 503 admission full, 504 total deadline. Retryable overload/quota errors include `Retry-After` where available. A proxy can also return its own error response.

All API responses are `private, no-store`. In-memory cache keys include a token digest. Singleflight waiters can cancel; there are at most ten concurrent profile fetches and no unbounded admission queue. GitHub pagination, payloads, connections, commit samples and IP buckets are bounded. Requests never follow upstream redirects.

## Deployment and boundaries

Read [docs/OPERATIONS.md](docs/OPERATIONS.md) before applying [deploy/nginx.conf](deploy/nginx.conf) or the systemd template. The nginx template intentionally uses this VPS's existing Cloudflare trust variables and certificate paths. Preserve authenticated edge IP handling and the origin guard; never trust an arbitrary forwarded header.

The API trusts a validated `X-Real-IP` only from a loopback peer. Local processes still share that trust boundary. For hostile multi-tenant hosting, isolate services and proxy communication rather than assuming loopback identifies a particular process. Rate limits are process-local; distributed abuse and GitHub quota governance also need edge controls.

Security scans are point-in-time evidence, not a guarantee that all vulnerabilities have been found. Keep the Go compiler, vendored browser runtime and development tooling updated. The reviewed code does not establish Cloudflare account security or dashboard cache rules.

MIT licensed. See [LICENSE](LICENSE).
