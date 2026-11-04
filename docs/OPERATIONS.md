# Operations and rollback

This VPS serves `forest.micutu.com` through Cloudflare and the nginx vhost `/etc/nginx/sites-available/forest.micutu.com`, enabled by a symlink. The backend unit is **code-forest-canary.service** on `127.0.0.1:8089`. Do not confuse it with the generic `code-forest.service` template. The active checkout is `/srv/canary/forest.micutu.com/project`.

## Release procedure

1. Run `npm ci --ignore-scripts`, `make check`, `make security`, browser tests and `make build`. Build artifacts go under ignored `build/`.
2. Preview the candidate on a separate loopback port, for example `PORT=18089 ./build/code-forest`. Verify `/health`, `/`, static assets and `/api/`. The binary embeds the HTML, CSS, JavaScript, demo and vendor files, so release files cannot drift during repository edits.
3. Back up the actual service binary and nginx vhost outside the web root. On this host, restricted backups are under `/var/backups/code-forest/`. Preserve file permissions and existing service environment; never copy tokens into the checkout or logs.
4. Install the tested candidate by writing a new file next to the production binary and atomically renaming it. Never truncate a running executable. Stop the preview before the final checks if a fresh test server is needed.
5. Apply only this project's nginx vhost. The repository template proxies the frontend and API to the same binary and retains the existing Cloudflare origin guard. Run `sudo nginx -t` before a reload. If validation fails, restore the previous vhost immediately; do not reload a failed configuration.
6. Restart `code-forest-canary.service`, reload nginx and verify localhost health, local HTTPS with the correct Host/SNI, and the public HTTPS domain. Confirm the version, expected HTML, CSS/module assets, CSP without inline executable scripts, no-cache HTML, no-store API and safe error handling.
7. Inspect this service's recent journal for startup errors. Do not dump environment files or unrestricted logs into reports. Only declare a public release after verifying the public response.

A restart has a short interruption; this is not a zero-downtime deployment scheme. The application drains requests on shutdown, bounded by the service stop timeout. To add zero downtime later, use two candidate ports and switch only this vhost after a successful health check.

## Rollback

Restore the saved binary by an atomic rename, restore the saved vhost, run `nginx -t`, restart **code-forest-canary.service**, then reload nginx. Verify `/health` and the public page. Restoring the previous nginx configuration alone can restore the old static page but does not restore the old API binary.

The pre-release static snapshot `releases/1655adf/public` was used to isolate development from the live page. The final embedded release does not depend on that directory. Keep it until the new release has been observed, then remove old releases under a deliberate retention policy.

## Ongoing checks

- Repeat source and binary vulnerability scans after compiler upgrades and before releases. `go.mod` chooses the reviewed compiler; verify `go version` and `go version -m build/code-forest`.
- Review Dependabot updates and rerun browser checks, especially for renderer/controls upgrades.
- GitHub API budget is shared for a server fallback token. Never use a broadly scoped private-data token as a public service fallback. Prefer a dedicated public-read token and use edge limits for distributed abuse.
- The IP limiter and cache reset at process restart and do not coordinate across multiple backend processes.
- Cloudflare dashboard cache rules can override origin intent. Ensure HTML is revalidated and API responses are never cached. Test actual edge behavior; changing origin headers cannot purge a pre-existing forced cache entry.
- The current service runs as the existing `micu` account with systemd sandboxing. A separate service identity would further isolate it from other applications using the same Unix account; plan that migration with filesystem and proxy permissions rather than changing the host's shared account blindly.
