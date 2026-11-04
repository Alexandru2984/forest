# Security and reliability audit

Date: 2026-11-04. Scope: this repository, its running Go process, relevant readable host configuration and passive HTTP checks of `forest.micutu.com`. No brute force, load tests, credential extraction or changes to unrelated applications.

## Baseline findings

| ID  | Priority | Evidence and impact                                                                                                                                                                                               | Remediation                                                                                                                                                                    |
| --- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| S01 | High     | Running binary reports Go 1.22.2 (`go version -m`), outside Go's supported security release window. CI also selects 1.22.                                                                                         | Scan existing binary, rebuild using the installed supported toolchain, update CI and document update policy.                                                                   |
| S02 | High     | API has no `Cache-Control`/`Vary: Authorization`. Credential-bound in-memory keys do not protect responses stored by an external HTTP cache.                                                                      | `private, no-store` on all API responses and `Vary: Authorization, Origin`.                                                                                                    |
| S03 | High     | Singleflight uses uncancellable `WaitGroup.Wait`; unique requests accumulate in the flight map while waiting for the global semaphore. Upstream's 45-second timeout applies to each call, not the entire fan-out. | Bounded admission, context-aware result sharing and a total fetch deadline.                                                                                                    |
| S04 | Medium   | `clientIP` accepts arbitrary `X-Real-IP`/first XFF and stores unbounded keys. Header trust is justified only if every reachable proxy sanitizes them; the repo template copies raw CF headers.                    | Accept one canonical IP only from loopback; do not trust arbitrary XFF; bound buckets and configure the trusted edge explicitly.                                               |
| S05 | Medium   | Default HTTP redirect handling allows a trusted GitHub response to change the upstream destination.                                                                                                               | Deny redirects, bound transport connections and timeouts, construct canonical commit links. This is defense in depth, not a demonstrated attacker-controlled redirect exploit. |
| S06 | Medium   | Browser stores a PAT in sessionStorage and restores it even when a link changes the username. Third-party analytics executes in the same origin's page context.                                                   | Keep PATs in memory only, clear legacy storage and remove third-party JavaScript from the credential-bearing application.                                                      |
| S07 | Medium   | Nginx template uses child `add_header` directives that discard inherited security headers. Public response uses `unsafe-inline` scripts and HTML has a one-hour cache lifetime.                                   | Centralize security headers, hash import map, disable HTML/API shared caching; validate the actual serving layer before applying.                                              |
| R01 | High     | `.gitignore` excludes every `build/` folder, including required `public/vendor/three/build/three.module.js`, which is present locally but untracked.                                                              | Explicitly track the exact vendored runtime plus license/integrity manifest; verify from clean Git files.                                                                      |
| R02 | Medium   | Concurrent fetch completion determines repo order; UI drops all trees without commits; empty API results leave old forest visible. Repeated scans can overwrite the latest profile with an older response.        | Stable ordering, draw metadata-only trees, clear stale state, abort obsolete scans.                                                                                            |
| R03 | Medium   | API converts upstream 404/401/rate-limit failures to 502, ignores commit failures and presents incomplete data as success.                                                                                        | Stable error codes and explicit sample/partial/truncation metadata.                                                                                                            |
| R04 | Medium   | README/UI promise full history and private repositories. `/users/{username}/repos` lists public repositories; commits endpoint requests only 20 per repository.                                                   | Public-profile scope and accurate sample labels. Do not request broad credential permissions.                                                                                  |
| R05 | Medium   | Shared leaf geometries are disposed on every filter rebuild; render loop never pauses in background; no WebGL/import failure recovery; mobile form can cover the viewport.                                        | Correct lifecycle, adaptive quality, background pause and independent accessible repository list.                                                                              |

## Deployment observations

- Running unit: `code-forest-canary.service`, loopback listener `127.0.0.1:8089`, non-root account, read-only system protection, no capabilities, memory/task limits. These existing protections are useful.
- Repository files are in the running service's working directory; public assets must be prepared and validated before activation.
- The enabled `forest.micutu.com` vhost serves this checkout’s `public/` and proxies `/api/` to loopback port 8089. Initial recursive searches skipped symlinks; direct vhost inspection corrected that observation. SHA-256 of the public HTML, local HTTPS HTML and checkout HTML matched. Public headers differ from the repository template.
- Host-wide Cloudflare real-IP configuration already restricts CF headers to known edge peers and local tunnel connections. This host-wide trust still assumes local processes are trusted; the application cannot authenticate a local proxy based on its IP alone.
- No real credential was printed or copied into this report. No authenticated/private GitHub data was queried.

## Verification and remaining scope

Baseline Go race tests and binary vulnerability scan are recorded as they complete. Remediation results and release checks are appended below. Source review and automated tests do not prove that all vulnerabilities have been found. Cloudflare dashboard settings, remote tunnel routing, account security and external analytics service administration require separate access/evidence.

## Primary references

- Go security support and vulnerability tooling: https://go.dev/doc/security/ and https://go.dev/doc/security/vuln/
- GitHub repository endpoint contract: https://docs.github.com/en/rest/repos/repos#list-repositories-for-a-user

## Baseline test and vulnerability results

- Existing `go test -race -count=1 -cover ./...`: passed, 27.1% statement coverage.
- `govulncheck` binary scan of the running Go 1.22.2 build: **73 standard-library vulnerability reports with affected symbols**. This establishes an outdated vulnerable build, not proof that each issue is exploitable through this application. No additional Go modules were present.
- The runtime identifies as r150; comparison against the r150 Git tag exposed patch differences. All runtime/addon files were verified and normalized against the official npm three@0.150.1 archive. License and a SHA-256 inventory are now included.

## API remediation verification

- Context-aware singleflight and immediate bounded admission replace the unbounded waiting queue. Upstream operations have a 25-second total deadline, strict transport timeouts and no redirects.
- All HTTP API responses prohibit storage; token cache keys remain isolated. The explorer always strips private repositories, including token-bearing requests.
- Canonical client IP parsing, a 10,000-bucket cap, capped configuration values, bounded JSON decoding, canonical GitHub commit URLs, stable repository ordering and explicit data-coverage headers have regression coverage.
- `go test -race -count=1 -cover ./...`: passed, **81.9% statement coverage** after API changes. `go vet ./...`: passed. Baseline tests plus new abuse/cancellation/upstream tests run without external GitHub access.

## Toolchain follow-up

The preinstalled Go 1.26.8 compiler also produced 11 reachable standard-library vulnerability findings in a source scan. The project now requires at least Go 1.26.10 and selects **Go 1.27.3** with its `toolchain` directive; automatic Go toolchain download verifies the upstream distribution. This change is project-local and does not replace the host's global Go installation. Source scan with `golang.org/x/vuln/cmd/govulncheck@v1.9.0` using Go 1.27.3: **No vulnerabilities found**. Race tests and vet pass. Future releases must repeat the scan because this is a point-in-time result.

Same-origin module requests are accepted for the current request origin, including local development. Explicitly disallowed cross-origin requests still return 403. This has regression coverage.

## Product privacy and browser verification

The new explorer removes third-party executable scripts and external fonts, deletes legacy browser token entries and keeps optional PATs only in memory. GitHub-sourced strings render as text; repository and commit links are constrained to canonical GitHub URLs. CSV exports neutralize spreadsheet formulas, and JSON exports use an explicit public-data schema.

Browser verification covers demo isolation, search/filter/sort, device-local favorites, public deep links, token storage/export boundaries, empty profiles, upstream failures, XSS payloads, dialog focus, no-WebGL fallback, reduced motion, collection pagination and layouts at 320, 375, 768, 844 and 1440 pixels. All 16 functional/responsive scenarios passed. Axe then caught visible-label/accessibility-name mismatches, which were corrected; the WCAG 2.1 AA automated accessibility scenario passed on recheck. Final release checks repeat the suite against the built release. Automated axe checks are not a full manual accessibility conformance assessment.

## Build, SEO and CI protections

The final app entry and stylesheet use new URLs, with a minimal legacy module that clears old session credentials and refreshes a cached v9 shell. New HTML and static modules require revalidation. API storage remains prohibited. The single embedded release keeps HTML and its CSP hashes consistent, including non-executable structured application metadata.

CI uses read-only GitHub permissions, full action commit pins, locked development packages, no npm lifecycle scripts, race tests, model/browser/accessibility checks, renderer integrity/import verification and source/npm/vendor-advisory scans. Remote GitHub Actions execution is not claimed until these local commits are pushed and a workflow actually runs.

A shared runtime Unix identity was also identified. The project-specific systemd drop-in selects a dedicated dynamic account; it must pass a sandboxed preview before activation. Host-wide tunnel/account controls and mutually untrusted deployment-owner processes remain outside this app-level isolation.
