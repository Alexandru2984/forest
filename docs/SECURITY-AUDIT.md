# Security and reliability audit

Date: 2026-11-04. Scope: this repository, its running Go process, relevant readable host configuration and passive HTTP checks of `forest.micutu.com`. No brute force, load tests, credential extraction or changes to unrelated applications.

## Baseline findings

| ID | Priority | Evidence and impact | Remediation |
| --- | --- | --- | --- |
| S01 | High | Running binary reports Go 1.22.2 (`go version -m`), outside Go's supported security release window. CI also selects 1.22. | Scan existing binary, rebuild using the installed supported toolchain, update CI and document update policy. |
| S02 | High | API has no `Cache-Control`/`Vary: Authorization`. Credential-bound in-memory keys do not protect responses stored by an external HTTP cache. | `private, no-store` on all API responses and `Vary: Authorization, Origin`. |
| S03 | High | Singleflight uses uncancellable `WaitGroup.Wait`; unique requests accumulate in the flight map while waiting for the global semaphore. Upstream's 45-second timeout applies to each call, not the entire fan-out. | Bounded admission, context-aware result sharing and a total fetch deadline. |
| S04 | Medium | `clientIP` accepts arbitrary `X-Real-IP`/first XFF and stores unbounded keys. Header trust is justified only if every reachable proxy sanitizes them; the repo template copies raw CF headers. | Accept one canonical IP only from loopback; do not trust arbitrary XFF; bound buckets and configure the trusted edge explicitly. |
| S05 | Medium | Default HTTP redirect handling allows a trusted GitHub response to change the upstream destination. | Deny redirects, bound transport connections and timeouts, construct canonical commit links. This is defense in depth, not a demonstrated attacker-controlled redirect exploit. |
| S06 | Medium | Browser stores a PAT in sessionStorage and restores it even when a link changes the username. Third-party analytics executes in the same origin's page context. | Keep PATs in memory only, clear legacy storage and remove third-party JavaScript from the credential-bearing application. |
| S07 | Medium | Nginx template uses child `add_header` directives that discard inherited security headers. Public response uses `unsafe-inline` scripts and HTML has a one-hour cache lifetime. | Centralize security headers, hash import map, disable HTML/API shared caching; validate the actual serving layer before applying. |
| R01 | High | `.gitignore` excludes every `build/` folder, including required `public/vendor/three/build/three.module.js`, which is present locally but untracked. | Explicitly track the exact vendored runtime plus license/integrity manifest; verify from clean Git files. |
| R02 | Medium | Concurrent fetch completion determines repo order; UI drops all trees without commits; empty API results leave old forest visible. Repeated scans can overwrite the latest profile with an older response. | Stable ordering, draw metadata-only trees, clear stale state, abort obsolete scans. |
| R03 | Medium | API converts upstream 404/401/rate-limit failures to 502, ignores commit failures and presents incomplete data as success. | Stable error codes and explicit sample/partial/truncation metadata. |
| R04 | Medium | README/UI promise full history and private repositories. `/users/{username}/repos` lists public repositories; commits endpoint requests only 20 per repository. | Public-profile scope and accurate sample labels. Do not request broad credential permissions. |
| R05 | Medium | Shared leaf geometries are disposed on every filter rebuild; render loop never pauses in background; no WebGL/import failure recovery; mobile form can cover the viewport. | Correct lifecycle, adaptive quality, background pause and independent accessible repository list. |

## Deployment observations

- Running unit: `code-forest-canary.service`, loopback listener `127.0.0.1:8089`, non-root account, read-only system protection, no capabilities, memory/task limits. These existing protections are useful.
- Repository files are in the running service's working directory; public assets must be prepared and validated before activation.
- A `forest.micutu.com` configuration exists under `sites-available`, but no matching enabled vhost was found during baseline inspection. The public domain responds with this HTML's last-modified date and headers differing from the repository template. The exact public ingress must be verified before changing routing or claiming production delivery.
- Host-wide Cloudflare real-IP configuration already restricts CF headers to known edge peers and local tunnel connections. This host-wide trust still assumes local processes are trusted; the application cannot authenticate a local proxy based on its IP alone.
- No real credential was printed or copied into this report. No authenticated/private GitHub data was queried.

## Verification and remaining scope

Baseline Go race tests and binary vulnerability scan are recorded as they complete. Remediation results and release checks are appended below. Source review and automated tests do not prove that all vulnerabilities have been found. Cloudflare dashboard settings, remote tunnel routing, account security and external analytics service administration require separate access/evidence.

## Primary references

- Go security support and vulnerability tooling: https://go.dev/doc/security/ and https://go.dev/doc/security/vuln/
- GitHub repository endpoint contract: https://docs.github.com/en/rest/repos/repos#list-repositories-for-a-user
