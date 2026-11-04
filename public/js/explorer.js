import {
    languageColors,
    defaultFilters,
    validUser,
    validFullName,
    repoURL,
    normalizeRepos,
    filterRepos,
    summarize,
    filtersFromURL,
    shareURL,
    exportCSV,
} from "./model.js";

const $ = (id) => document.getElementById(id);
const compact = new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
});
const count = new Intl.NumberFormat("en");
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const state = {
    repos: [],
    visible: [],
    user: "demo",
    demo: true,
    filters: filtersFromURL(location.search),
    favorites: new Set(),
    limit: 24,
    list: false,
    meta: {},
    forest: null,
    forestPromise: null,
    request: null,
    generation: 0,
    paused: reducedMotion,
    orbit: false,
};
try {
    sessionStorage.removeItem("cf_token");
    sessionStorage.removeItem("cf_user");
    const stored = JSON.parse(localStorage.getItem("forest-favorites") || "[]");
    if (Array.isArray(stored))
        state.favorites = new Set(stored.filter(validFullName).slice(0, 200));
} catch {
    /* Storage is optional. */
}
function element(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
}
function status(message, type = "") {
    $("status").textContent = message;
    $("status").className = "status " + type;
}
function color(lang) {
    return languageColors[lang] || "#a5b1a1";
}
function formatDate(date) {
    const parsed = new Date(date);
    return Number.isFinite(parsed.getTime())
        ? parsed.toLocaleDateString("en", {
              month: "short",
              day: "numeric",
              year: "numeric",
          })
        : "Date unavailable";
}
function syncControls() {
    const f = state.filters;
    for (const [id, key] of [
        ["search", "q"],
        ["language", "language"],
        ["sort", "sort"],
        ["min-stars", "stars"],
        ["updated", "updated"],
        ["created", "created"],
    ])
        $(id).value = f[key];
    for (const [id, key] of [
        ["hide-forks", "hideForks"],
        ["hide-archived", "hideArchived"],
        ["favorites-only", "favoritesOnly"],
    ])
        $(id).checked = f[key];
}
function readControls() {
    state.filters = {
        q: $("search").value.trim().slice(0, 120),
        language: $("language").value,
        sort: $("sort").value,
        stars: Math.min(
            10000000,
            Math.max(0, Number($("min-stars").value) || 0),
        ),
        updated: $("updated").value,
        created: $("created").value,
        hideForks: $("hide-forks").checked,
        hideArchived: $("hide-archived").checked,
        favoritesOnly: $("favorites-only").checked,
    };
    state.limit = 24;
    render();
}
function resetFilters() {
    state.filters = defaultFilters();
    state.limit = 24;
    syncControls();
    render();
    status("Filters reset. The whole forest is yours.");
}
function render() {
    state.visible = filterRepos(state.repos, state.filters, state.favorites);
    const summary = summarize(state.visible);
    for (const [id, value] of [
        ["stat-repos", summary.repos],
        ["stat-stars", summary.stars],
        ["stat-languages", summary.languages.size],
        ["stat-commits", summary.commits],
    ]) {
        $(id).textContent = compact.format(value);
        $(id).title = count.format(value);
    }
    $("collection-count").textContent =
        `${count.format(summary.repos)} of ${count.format(state.repos.length)}`;
    $("favorite-count").textContent = state.favorites.size;
    const defaults = defaultFilters();
    const active = Object.keys(defaults).filter(
        (k) => k !== "sort" && state.filters[k] !== defaults[k],
    ).length;
    $("active-filters").textContent = `${active} active`;
    renderCollection();
    renderLanguages();
    renderCoverage();
    state.forest?.setRepos(state.visible);
    for (const id of ["json-export", "csv-export"])
        $(id).disabled = state.visible.length === 0;
}
function renderCollection() {
    const fragment = document.createDocumentFragment();
    for (const repo of state.visible.slice(0, state.limit)) {
        const card = element("article", "repo-card");
        card.dataset.repo = repo.full_name;
        const top = element("div", "card-top");
        const title = element("button", "text-button repo-name", repo.name);
        title.type = "button";
        title.addEventListener("click", () => openRepo(repo));
        const favorite = element(
            "button",
            "favorite-button",
            state.favorites.has(repo.full_name) ? "★" : "☆",
        );
        favorite.type = "button";
        favorite.dataset.favorite = repo.full_name;
        favorite.setAttribute(
            "aria-label",
            `${state.favorites.has(repo.full_name) ? "Remove" : "Add"} ${repo.name} ${state.favorites.has(repo.full_name) ? "from" : "to"} favorites`,
        );
        favorite.setAttribute(
            "aria-pressed",
            String(state.favorites.has(repo.full_name)),
        );
        favorite.addEventListener("click", () => {
            toggleFavorite(repo);
            const next = [
                ...$("repo-list").querySelectorAll("[data-favorite]"),
            ].find((el) => el.dataset.favorite === repo.full_name);
            next?.focus();
        });
        top.append(title, favorite);
        const description = element(
            "p",
            "repo-description",
            repo.description || "An idea taking root. No description provided.",
        );
        const meta = element("div", "card-meta"),
            lang = element("span"),
            dot = element("i", "language-dot");
        dot.style.background = color(repo.language);
        lang.append(dot, document.createTextNode(repo.language));
        meta.append(
            lang,
            element("span", "", `☆ ${compact.format(repo.stars)}`),
        );
        if (repo.fork) meta.append(element("span", "repo-badge", "FORK"));
        if (repo.archived)
            meta.append(element("span", "repo-badge", "ARCHIVED"));
        const bottom = element("div", "card-bottom");
        bottom.append(
            element(
                "span",
                "",
                `Pushed ${formatDate(repo.pushed_at || repo.updated_at)}`,
            ),
        );
        const inspect = element("button", "text-button", "Explore project");
        inspect.type = "button";
        inspect.setAttribute("aria-label", `Explore project: ${repo.name}`);
        inspect.addEventListener("click", () => openRepo(repo));
        bottom.append(inspect);
        card.append(top, description, meta, bottom);
        fragment.append(card);
    }
    $("repo-list").replaceChildren(fragment);
    $("repo-list").classList.toggle("list-layout", state.list);
    $("empty-state").hidden = state.visible.length !== 0;
    $("empty-message").textContent = state.repos.length
        ? "Try another search or reset your filters."
        : "This profile has no public repositories to explore.";
    $("load-more").hidden = state.limit >= state.visible.length;
    $("load-more").textContent =
        `Show ${Math.min(24, Math.max(0, state.visible.length - state.limit))} more repositories`;
}
function renderLanguages() {
    const entries = [...summarize(state.repos).languages.entries()].sort(
        (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    );
    const chart = document.createDocumentFragment(),
        legend = document.createDocumentFragment();
    for (const [language, total] of entries) {
        const selectLanguage = () => {
            state.filters.language =
                state.filters.language === language ? "" : language;
            state.limit = 24;
            syncControls();
            render();
            status(
                state.filters.language
                    ? `Exploring ${language} projects.`
                    : "All languages are in view.",
            );
        };
        const segment = element("button", "language-segment");
        segment.type = "button";
        segment.style.background = color(language);
        segment.style.flexGrow = String(total);
        segment.setAttribute(
            "aria-label",
            `Filter ${language}: ${total} repositories`,
        );
        segment.addEventListener("click", selectLanguage);
        chart.append(segment);
        const button = element("button", "language-choice");
        button.type = "button";
        button.setAttribute(
            "aria-pressed",
            String(state.filters.language === language),
        );
        const dot = element("i", "language-dot");
        dot.style.background = color(language);
        button.append(dot, document.createTextNode(`${language} ${total}`));
        button.addEventListener("click", selectLanguage);
        legend.append(button);
    }
    $("language-chart").replaceChildren(chart);
    $("language-legend").replaceChildren(legend);
}
function renderCoverage() {
    const sampled = state.repos.filter((r) =>
            ["sampled", "empty"].includes(r.commit_status),
        ).length,
        failed = state.repos.filter(
            (r) => r.commit_status === "unavailable",
        ).length;
    if (state.demo) {
        $("coverage").textContent =
            "A fictional collection of 16 projects. Each tree is a repo; glowing leaves are example commit samples. Explore freely.";
        $("freshness").textContent = "Bundled demo · no GitHub quota used";
        return;
    }
    $("coverage").textContent =
        `Recent commit samples loaded for ${sampled} of ${state.repos.length} repositories. Up to 20 commits per sampled repo.${failed ? ` ${failed} samples unavailable.` : ""}${state.meta.truncated ? " Repository list capped at 500." : ""} This is a snapshot, not full history.`;
    const fetched = state.meta.fetchedAt
        ? `Fetched ${formatDate(state.meta.fetchedAt)}`
        : "Public GitHub data";
    $("freshness").textContent =
        `${fetched} · ${state.meta.cache === "hit" ? "cached snapshot" : "recent snapshot"}${state.meta.remaining !== null && state.meta.remaining !== undefined ? ` · ~${state.meta.remaining} API requests left` : ""}`;
}
function toggleFavorite(repo) {
    if (state.favorites.has(repo.full_name))
        state.favorites.delete(repo.full_name);
    else {
        if (state.favorites.size >= 200) {
            status(
                "Your 200 favorite slots are full. Remove one before adding another.",
                "error",
            );
            return;
        }
        state.favorites.add(repo.full_name);
    }
    try {
        localStorage.setItem(
            "forest-favorites",
            JSON.stringify([...state.favorites]),
        );
    } catch {
        /* Favorites still work in memory. */
    }
    render();
}
function openRepo(repo) {
    const content = $("repo-details");
    content.replaceChildren();
    content.append(
        element("h2", "", repo.name),
        element("p", "", repo.description || "No description provided."),
    );
    const actions = element("div", "detail-actions");
    if (!state.demo) {
        const link = element("a", "button primary", "View on GitHub ↗");
        link.href = repoURL(repo.full_name);
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        actions.append(link);
    }
    const focus = element("button", "button outline", "Find in the forest");
    focus.type = "button";
    focus.disabled = !state.forest;
    focus.addEventListener("click", () => {
        $("repo-dialog").close();
        state.forest?.focus(repo.full_name);
        $("forest-stage").scrollIntoView({
            behavior: reducedMotion ? "instant" : "smooth",
            block: "center",
        });
    });
    actions.append(focus);
    const favorite = element(
        "button",
        "button outline",
        state.favorites.has(repo.full_name) ? "★ Saved" : "☆ Save favorite",
    );
    favorite.type = "button";
    favorite.setAttribute(
        "aria-pressed",
        String(state.favorites.has(repo.full_name)),
    );
    favorite.addEventListener("click", () => {
        toggleFavorite(repo);
        favorite.textContent = state.favorites.has(repo.full_name)
            ? "★ Saved"
            : "☆ Save favorite";
        favorite.setAttribute(
            "aria-pressed",
            String(state.favorites.has(repo.full_name)),
        );
    });
    actions.append(favorite);
    content.append(actions);
    const metadata = element("div", "detail-metadata");
    for (const [label, value] of [
        ["Language", repo.language],
        ["Stars", count.format(repo.stars)],
        ["Forks", count.format(repo.forks)],
        ["Open issues", count.format(repo.open_issues)],
        ["Created", formatDate(repo.created_at)],
        ["Last pushed", formatDate(repo.pushed_at || repo.updated_at)],
    ]) {
        const cell = element("div");
        cell.append(
            element("small", "", label),
            document.createTextNode(value),
        );
        metadata.append(cell);
    }
    content.append(metadata);
    const topics = element("div", "topic-list");
    for (const topic of repo.topics) topics.append(element("span", "", topic));
    content.append(
        topics,
        element("h3", "", `Recent commits · ${repo.commits.length} sampled`),
    );
    if (state.demo)
        content.append(
            element(
                "p",
                "",
                "These projects and commits are fictional demo data. Explore a real profile for GitHub links.",
            ),
        );
    if (!repo.commits.length)
        content.append(
            element(
                "p",
                "",
                repo.commit_status === "empty"
                    ? "This repository has no commits yet."
                    : repo.commit_status === "unavailable"
                      ? "GitHub could not provide a sample for this repository. Its metadata remains available."
                      : "This repository was outside the commit sampling budget. Its metadata remains available.",
            ),
        );
    const commits = element("ul", "commit-list");
    for (const commit of repo.commits) {
        const li = element("li");
        if (state.demo) li.append(element("span", "", commit.message));
        else {
            const a = element("a", "", commit.message || commit.hash);
            a.href = commit.url;
            a.target = "_blank";
            a.rel = "noopener noreferrer";
            li.append(a);
        }
        li.append(
            element("small", "", `${commit.hash} · ${formatDate(commit.date)}`),
        );
        commits.append(li);
    }
    content.append(commits);
    if (!$("repo-dialog").open) $("repo-dialog").showModal();
}
function setProfile() {
    $("profile-title").replaceChildren(
        document.createTextNode(
            state.demo ? "The demo forest" : `@${state.user}`,
        ),
        element("span", "heading-dot", "."),
    );
    $("source-label").textContent = state.demo
        ? "A LITTLE INSPIRATION"
        : "ROOTED IN OPEN SOURCE";
    $("profile-description").textContent = state.demo
        ? "A fictional landscape. Real possibilities."
        : `${count.format(state.repos.length)} public projects. A whole world to explore.`;
    document.title = state.demo
        ? "Code Forest — Grow a new perspective on your GitHub"
        : `${state.user}’s Code Forest — Public GitHub explorer`;
    const options = document.createDocumentFragment();
    const all = element("option", "", "All languages");
    all.value = "";
    options.append(all);
    for (const lang of [...summarize(state.repos).languages.keys()].sort()) {
        const option = element("option", "", lang);
        option.value = lang;
        options.append(option);
    }
    $("language").replaceChildren(options);
    if (
        ![...summarize(state.repos).languages.keys()].includes(
            state.filters.language,
        )
    )
        state.filters.language = "";
    syncControls();
    render();
}
async function loadProfile(user) {
    user = user.trim();
    if (!validUser(user)) {
        status(
            "Use a GitHub username: up to 39 letters, numbers or single hyphens.",
            "error",
        );
        $("username").focus();
        return;
    }
    const token = $("token").value.trim();
    if (token && !/^[a-z\d_.-]{1,248}$/i.test(token)) {
        status(
            "The token format looks invalid. Clear it or use a GitHub public-read token.",
            "error",
        );
        return;
    }
    state.request?.abort();
    const request = new AbortController();
    state.request = request;
    const generation = ++state.generation;
    const timeout = setTimeout(() => request.abort("timeout"), 35000);
    $("grow-button").disabled = true;
    $("profile-form").setAttribute("aria-busy", "true");
    status(
        `Growing @${user}’s forest. Larger profiles can take a moment…`,
        "loading",
    );
    try {
        const headers = token ? { Authorization: `Bearer ${token}` } : {};
        const response = await fetch(
            `/api/github?user=${encodeURIComponent(user)}`,
            {
                headers,
                signal: request.signal,
                cache: "no-store",
                credentials: "omit",
                redirect: "error",
                referrerPolicy: "no-referrer",
            },
        );
        if (!response.ok) {
            let message = "GitHub is temporarily unavailable. Please retry.";
            try {
                const body = await response.json();
                if (typeof body?.error?.message === "string")
                    message = body.error.message.slice(0, 250);
            } catch {
                /* Non-JSON proxy errors have a stable fallback. */
            }
            const retry = response.headers.get("Retry-After");
            if (response.status === 429 && retry && /^\d+$/.test(retry))
                message += ` Retry in about ${Math.ceil(Number(retry) / 60)} minute(s).`;
            throw new Error(message);
        }
        const repos = normalizeRepos(await response.json());
        if (generation !== state.generation) return;
        state.repos = repos;
        state.user = user;
        state.demo = false;
        state.limit = 24;
        state.meta = {
            cache: response.headers.get("X-Forest-Cache"),
            remaining: response.headers.get("X-GitHub-RateLimit-Remaining"),
            truncated: response.headers.get("X-Forest-Truncated") === "true",
            fetchedAt: response.headers.get("X-Forest-Fetched-At"),
        };
        setProfile();
        status(
            repos.length
                ? `@${user}’s forest is ready. Select a tree or explore the collection.`
                : `@${user} has no public repositories yet.`,
        );
        history.replaceState(
            null,
            "",
            shareURL(location.origin, user, state.filters),
        );
        ensureForest();
    } catch (error) {
        if (generation !== state.generation) return;
        status(
            request.signal.aborted
                ? "The request was interrupted. Try again when you’re ready."
                : error.message,
            "error",
        );
    } finally {
        clearTimeout(timeout);
        if (generation === state.generation) {
            $("grow-button").disabled = false;
            $("profile-form").removeAttribute("aria-busy");
            state.request = null;
        }
    }
}
async function loadDemo() {
    state.request?.abort();
    const generation = ++state.generation;
    $("grow-button").disabled = false;
    $("profile-form").removeAttribute("aria-busy");
    state.request = null;
    try {
        const response = await fetch("/data/demo.json", {
            cache: "no-cache",
            credentials: "omit",
        });
        if (!response.ok)
            throw new Error(
                "The demo could not be loaded. Try a GitHub profile instead.",
            );
        const repos = normalizeRepos(await response.json());
        if (generation !== state.generation) return;
        state.repos = repos;
        state.user = "demo";
        state.demo = true;
        state.meta = {};
        state.limit = 24;
        setProfile();
        status(
            "Demo mode. These projects are fictional; your GitHub API budget is untouched.",
        );
        ensureForest();
    } catch (error) {
        if (generation === state.generation) {
            status(error.message, "error");
            render();
        }
    }
}
function fallback(message) {
    $("scene-fallback").hidden = false;
    $("fallback-message").textContent = message;
    $("render-status").textContent = "Collection mode";
    $("snapshot-button").disabled = true;
}
async function ensureForest() {
    if (state.forest) {
        state.forest.setRepos(state.visible);
        return;
    }
    if (state.forestPromise) return state.forestPromise;
    $("render-status").textContent = "Preparing 3D";
    $("retry-3d").disabled = true;
    state.forestPromise = (async () => {
        try {
            const { createForest } = await import("./forest.js");
            state.forest = createForest($("forest-canvas"), {
                tooltip: $("scene-tooltip"),
                onSelect: openRepo,
                onStatus: (message) =>
                    ($("render-status").textContent = message),
                onFailure: (message) => {
                    state.forest?.dispose();
                    state.forest = null;
                    fallback(message);
                },
            });
            state.forest.setQuality($("quality").value);
            state.forest.setPaused(state.paused);
            state.forest.setOrbit(state.orbit);
            state.forest.setRepos(state.visible);
            $("scene-fallback").hidden = true;
            $("snapshot-button").disabled = false;
        } catch {
            fallback(
                "Your browser could not start the 3D view. All projects, filters and details are available in the collection below.",
            );
        } finally {
            state.forestPromise = null;
            $("retry-3d").disabled = false;
        }
    })();
    return state.forestPromise;
}
function download(content, type, filename) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const link = element("a");
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$("profile-form").addEventListener("submit", (event) => {
    event.preventDefault();
    loadProfile($("username").value);
});
$("clear-token").addEventListener("click", () => {
    $("token").value = "";
    status("Token cleared from this page.");
});
for (const button of document.querySelectorAll("[data-user]"))
    button.addEventListener("click", () => {
        $("username").value = button.dataset.user;
        $("token").value = "";
        loadProfile(button.dataset.user);
    });
const featured = [
    "torvalds",
    "yyx990803",
    "gaearon",
    "sindresorhus",
    "mrdoob",
    "addyosmani",
];
$("random-button").addEventListener("click", () => {
    const user = featured[Math.floor(Math.random() * featured.length)];
    $("username").value = user;
    $("token").value = "";
    loadProfile(user);
});
$("demo-button").addEventListener("click", () => {
    state.filters = defaultFilters();
    history.replaceState(null, "", "/");
    loadDemo();
});
$("guide-demo").addEventListener("click", () => {
    $("help-dialog").close();
    $("demo-button").click();
});
$("help-button").addEventListener("click", () => $("help-dialog").showModal());
for (const dialog of document.querySelectorAll("dialog")) {
    dialog
        .querySelector(".dialog-close")
        .addEventListener("click", () => dialog.close());
    dialog.addEventListener("click", (event) => {
        if (event.target === dialog) {
            const rect = dialog.getBoundingClientRect();
            if (
                event.clientX < rect.left ||
                event.clientX > rect.right ||
                event.clientY < rect.top ||
                event.clientY > rect.bottom
            )
                dialog.close();
        }
    });
}
let searchTimer;
$("search").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(readControls, 140);
});
for (const id of [
    "language",
    "sort",
    "min-stars",
    "updated",
    "created",
    "hide-forks",
    "hide-archived",
    "favorites-only",
])
    $(id).addEventListener("change", readControls);
$("reset-filters").addEventListener("click", resetFilters);
$("empty-reset").addEventListener("click", resetFilters);
$("all-languages").addEventListener("click", () => {
    state.filters.language = "";
    syncControls();
    render();
});
$("load-more").addEventListener("click", () => {
    const old = state.limit;
    state.limit += 24;
    renderCollection();
    $("repo-list").children[old]?.querySelector("button")?.focus();
});
$("layout-button").addEventListener("click", () => {
    state.list = !state.list;
    $("layout-button").textContent = state.list ? "Grid view" : "List view";
    $("layout-button").setAttribute("aria-pressed", String(state.list));
    renderCollection();
});
$("share-button").addEventListener("click", async () => {
    const url = shareURL(
        location.origin,
        state.demo ? "" : state.user,
        state.filters,
    );
    try {
        await navigator.clipboard.writeText(url);
        status("Link copied. Share a fresh perspective.");
    } catch {
        const field = element("input");
        field.value = url;
        field.readOnly = true;
        $("repo-details").replaceChildren(
            element("h2", "", "Share this view"),
            element(
                "p",
                "",
                "Copy this public link. It contains no token or favorites.",
            ),
            field,
        );
        $("repo-dialog").showModal();
        field.select();
    }
});
$("json-export").addEventListener("click", () => {
    download(
        JSON.stringify(
            {
                profile: state.user,
                demo: state.demo,
                exported_at: new Date().toISOString(),
                coverage:
                    "Up to 500 public repositories. Recent commits are bounded samples, not full history.",
                repos: state.visible,
            },
            null,
            2,
        ),
        "application/json",
        `code-forest-${state.user}.json`,
    );
    status("Exported the visible collection as JSON.");
});
$("csv-export").addEventListener("click", () => {
    download(
        "\ufeff" + exportCSV(state.visible),
        "text/csv;charset=utf-8",
        `code-forest-${state.user}.csv`,
    );
    status("Exported the visible collection as CSV.");
});
$("pause-button").setAttribute("aria-pressed", String(state.paused));
$("pause-button").textContent = state.paused ? "Resume" : "Pause";
$("pause-button").addEventListener("click", () => {
    state.paused = !state.paused;
    state.forest?.setPaused(state.paused);
    $("pause-button").setAttribute("aria-pressed", String(state.paused));
    $("pause-button").textContent = state.paused ? "Resume" : "Pause";
});
$("orbit-button").addEventListener("click", () => {
    state.orbit = !state.orbit;
    state.forest?.setOrbit(state.orbit);
    $("orbit-button").setAttribute("aria-pressed", String(state.orbit));
});
$("quality").addEventListener("change", () =>
    state.forest?.setQuality($("quality").value),
);
$("reset-camera").addEventListener("click", () => state.forest?.reset());
$("retry-3d").addEventListener("click", ensureForest);
$("snapshot-button").addEventListener("click", () => {
    try {
        state.forest?.snapshot(`code-forest-${state.user}.png`);
        status("Your forest snapshot is ready.");
    } catch {
        status(
            "The browser could not export this scene. Try the JSON or CSV export.",
            "error",
        );
    }
});
if (!document.fullscreenEnabled) $("fullscreen-button").hidden = true;
$("fullscreen-button").addEventListener("click", async () => {
    try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else await $("forest-stage").requestFullscreen();
    } catch {
        status("Fullscreen is unavailable in this browser.");
    }
});
window.addEventListener("pagehide", () => {
    state.request?.abort();
    $("token").value = "";
});
if (matchMedia("(max-width: 760px)").matches) $("filter-details").open = false;
const initialUser = new URLSearchParams(location.search).get("user");
syncControls();
if (initialUser && validUser(initialUser)) {
    $("username").value = initialUser;
    loadProfile(initialUser);
} else {
    loadDemo();
    if (initialUser)
        status(
            "The shared username is invalid. Explore the demo or enter a valid profile.",
            "error",
        );
}
