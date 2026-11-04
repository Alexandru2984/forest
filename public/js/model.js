export const languageColors = Object.freeze({
    TypeScript: "#80b6ff",
    JavaScript: "#efd778",
    Python: "#8ec2d0",
    Go: "#77d9bd",
    Rust: "#eeb38c",
    "C++": "#e79db7",
    "C#": "#b0d287",
    Java: "#dda67a",
    HTML: "#e7a083",
    CSS: "#ba9cdb",
    Shell: "#c1d58a",
    Swift: "#edaa94",
    Ruby: "#d08c9d",
    PHP: "#a6acd9",
    C: "#b8c6b1",
    Vue: "#86d8a9",
    Unknown: "#a5b1a1",
});
export const defaultFilters = () => ({
    q: "",
    language: "",
    sort: "updated",
    stars: 0,
    updated: "",
    created: "",
    hideForks: false,
    hideArchived: false,
    favoritesOnly: false,
});
export function validUser(value) {
    return (
        typeof value === "string" &&
        /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(value) &&
        !value.includes("--")
    );
}
export function validFullName(value) {
    const parts = typeof value === "string" ? value.split("/") : [];
    return (
        parts.length === 2 &&
        validUser(parts[0]) &&
        /^[a-z\d_.-]{1,100}$/i.test(parts[1]) &&
        ![".", ".."].includes(parts[1])
    );
}
export function repoURL(fullName) {
    return validFullName(fullName) ? `https://github.com/${fullName}` : null;
}
export function commitURL(fullName, href) {
    try {
        const url = new URL(href);
        const base = repoURL(fullName);
        return base &&
            url.origin === "https://github.com" &&
            !url.username &&
            !url.password &&
            url.href.startsWith(base + "/commit/") &&
            /^[a-f\d]{7,64}$/i.test(
                url.pathname.slice(`/${fullName}/commit/`.length),
            ) &&
            !url.search &&
            !url.hash
            ? url.href
            : null;
    } catch {
        return null;
    }
}
const text = (value, max = 500) =>
    typeof value === "string" ? value.slice(0, max) : "";
const number = (value) =>
    Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
export function normalizeRepos(data) {
    if (!Array.isArray(data) || data.length > 500)
        throw new Error("GitHub returned an unexpected repository list.");
    const names = new Set();
    return data.map((repo) => {
        if (
            !repo ||
            !validFullName(repo.full_name) ||
            names.has(repo.full_name.toLowerCase())
        )
            throw new Error("GitHub returned an invalid repository.");
        names.add(repo.full_name.toLowerCase());
        return {
            name: repo.full_name.split("/")[1],
            full_name: repo.full_name,
            language: text(repo.language, 80) || "Unknown",
            description: text(repo.description),
            url: repoURL(repo.full_name),
            stars: number(repo.stars),
            forks: number(repo.forks),
            open_issues: number(repo.open_issues),
            fork: repo.fork === true,
            archived: repo.archived === true,
            created_at: text(repo.created_at, 40),
            updated_at: text(repo.updated_at, 40),
            pushed_at: text(repo.pushed_at, 40),
            topics: Array.isArray(repo.topics)
                ? repo.topics
                      .slice(0, 20)
                      .filter((t) => typeof t === "string")
                      .map((t) => t.slice(0, 80))
                : [],
            commit_status: [
                "sampled",
                "empty",
                "unavailable",
                "not_sampled",
            ].includes(repo.commit_status)
                ? repo.commit_status
                : "not_sampled",
            commits: (Array.isArray(repo.commits) ? repo.commits : [])
                .slice(0, 20)
                .filter((c) => c && commitURL(repo.full_name, c.url))
                .map((c) => ({
                    hash: text(c.hash, 7),
                    message: text(c.message, 150),
                    url: commitURL(repo.full_name, c.url),
                    date: text(c.date, 40),
                })),
        };
    });
}
const timestamp = (value) => Date.parse(value) || 0;
export function filterRepos(repos, filters, favorites = new Set()) {
    const query = filters.q.trim().toLowerCase();
    return repos
        .filter(
            (r) =>
                (!query ||
                    [r.full_name, r.description, ...r.topics].some((v) =>
                        v.toLowerCase().includes(query),
                    )) &&
                (!filters.language || r.language === filters.language) &&
                r.stars >= filters.stars &&
                (!filters.updated ||
                    timestamp(r.pushed_at || r.updated_at) >=
                        timestamp(filters.updated)) &&
                (!filters.created ||
                    timestamp(r.created_at) >= timestamp(filters.created)) &&
                (!filters.hideForks || !r.fork) &&
                (!filters.hideArchived || !r.archived) &&
                (!filters.favoritesOnly || favorites.has(r.full_name)),
        )
        .sort((a, b) => {
            let delta = 0;
            if (filters.sort === "stars") delta = b.stars - a.stars;
            else if (filters.sort === "commits")
                delta = b.commits.length - a.commits.length;
            else if (filters.sort === "created")
                delta = timestamp(b.created_at) - timestamp(a.created_at);
            else if (filters.sort !== "name")
                delta =
                    timestamp(b.pushed_at || b.updated_at) -
                    timestamp(a.pushed_at || a.updated_at);
            return delta || a.full_name.localeCompare(b.full_name, "en");
        });
}
export function summarize(repos) {
    const languages = new Map();
    let stars = 0,
        commits = 0;
    for (const r of repos) {
        languages.set(r.language, (languages.get(r.language) || 0) + 1);
        stars += r.stars;
        commits += r.commits.length;
    }
    return { repos: repos.length, stars, commits, languages };
}
export function filtersFromURL(search) {
    const p = new URLSearchParams(search),
        filters = defaultFilters();
    filters.q = (p.get("q") || "").slice(0, 120);
    filters.language = (p.get("lang") || "").slice(0, 80);
    if (
        ["updated", "stars", "name", "created", "commits"].includes(
            p.get("sort"),
        )
    )
        filters.sort = p.get("sort");
    filters.stars = Math.min(
        10000000,
        Math.max(0, Number(p.get("stars")) || 0),
    );
    for (const key of ["created", "updated"]) {
        const value = p.get(key) || "";
        if (
            /^\d{4}-\d{2}-\d{2}$/.test(value) &&
            Number.isFinite(Date.parse(value))
        )
            filters[key] = value;
    }
    filters.hideForks = p.get("forks") === "hide";
    filters.hideArchived = p.get("archived") === "hide";
    return filters;
}
export function shareURL(origin, user, filters) {
    const url = new URL("/", origin);
    if (validUser(user)) url.searchParams.set("user", user);
    for (const [key, value] of [
        ["q", filters.q],
        ["lang", filters.language],
        ["sort", filters.sort === "updated" ? "" : filters.sort],
        ["stars", filters.stars || ""],
        ["updated", filters.updated],
        ["created", filters.created],
        ["forks", filters.hideForks ? "hide" : ""],
        ["archived", filters.hideArchived ? "hide" : ""],
    ])
        if (value) url.searchParams.set(key, String(value));
    return url.href;
}
export function csvCell(value) {
    let s = String(value ?? "");
    if (/^[\s]*[=+\-@]/.test(s) || /^[\t\r\n]/.test(s)) s = "'" + s;
    return '"' + s.replaceAll('"', '""') + '"';
}
export function exportCSV(repos) {
    return [
        [
            "repository",
            "language",
            "stars",
            "forks",
            "archived",
            "pushed_at",
            "description",
            "url",
            "sampled_commits",
        ],
        ...repos.map((r) => [
            r.full_name,
            r.language,
            r.stars,
            r.forks,
            r.archived,
            r.pushed_at,
            r.description,
            repoURL(r.full_name),
            r.commits.length,
        ]),
    ]
        .map((row) => row.map(csvCell).join(","))
        .join("\r\n");
}
