# Code Forest product roadmap

Updated: 2026-11-05. Work is delivered in separate commits under the repository owner's existing Git identity, with no generated attribution or coauthor trailers.

## Delivery sequence

1. **Audit and baseline** — inspect tracked files, production process, proxy configuration and public headers; record evidence and limits in `SECURITY-AUDIT.md`. Keep secrets out of output and the repository.
2. **API security and reliability** — bound total fetch time and queue size; cancel waiting requests; stop redirect-based upstream requests; validate proxy addresses; bound rate-limit memory; prevent HTTP caching of token-bearing responses; preserve deterministic repository order; expose useful upstream errors and data coverage. Restore reproducible vendored assets.
3. **A complete explorer** — responsive workspace, repository cards, real search and sorting, language/date/fork/archive/star filters, repository details and commit links, language breakdown, reset controls and honest sample-history labels. Every repository remains visible even when commit samples are unavailable.
4. **Interactive forest** — deterministic layouts, selectable trees, focus/reset camera, configurable rendering quality, pause/resume, mobile-friendly controls, WebGL failure fallback, safe exports, shareable filtered views, bookmarks stored only on this device and a bundled demo that uses no GitHub quota.
5. **Product verification** — regression tests for abuse boundaries, caching, cancellations and upstream failures; browser checks at desktop and mobile widths, keyboard navigation, failures, empty states and no-WebGL behavior. Run tests as each behavior lands; CI wiring follows product work.
6. **SEO and CI last** — meaningful static content, metadata and share image, robots/sitemap, repeatable local startup, pinned build/test tooling and a CI pipeline covering Go, frontend logic, browser flows, vendored integrity and vulnerability scanning.
7. **Release verification** — build to a separate path; preserve the previous binary/configuration; apply only project-specific service/proxy changes after validation; check the actual public response before claiming a live deployment. No push or unrelated host changes.

## Next product iterations

- Compare two public profiles with clear, quota-aware summaries.
- Timeline playback from real commit timestamps, with transparent sampling limits.
- Import/export a local public snapshot for presentations and classrooms.
- Multiple visual themes, camera tours and share cards with selected repository highlights.
- Optional GitHub OAuth using short-lived credentials; only after designing credential storage and deletion. Do not make persistent browser PAT storage the default.
- Self-hosted operational dashboard: latency, cache efficiency and upstream budget, without tokens or visitor identifiers in metrics.
- Accessibility and performance budgets on representative low-end devices.
- Localization, onboarding experiments and opt-in product analytics after the core experience is reliable.

## Acceptance criteria

No credentials in URLs, exports, source control or persistent browser storage. Resource bounds and error states have regression coverage. The explorer works without WebGL. Mobile controls remain reachable at 320px width and in landscape. Commits and repository totals are described accurately: the API returns at most 500 repositories and samples recent commits for a bounded subset, not full Git history. Report both completed work and remaining risks; an audit is not a guarantee of absence of vulnerabilities.

## Delivered release

The first delivery sequence is complete in v10.0.0, verified on the public domain on 2026-11-05. See [release evidence](RELEASE-2026-11-05.md) for the source/binary identity, security scans, 82.0% backend coverage, 7 model tests, 19 browser scenarios and actual edge/runtime checks. SEO assets and the validated CI workflow are committed; remote CI will run after a push. Future product iterations above remain planned work rather than shipped features.
