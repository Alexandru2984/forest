import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
    defaultFilters,
    validUser,
    repoURL,
    commitURL,
    normalizeRepos,
    filterRepos,
    summarize,
    filtersFromURL,
    shareURL,
    exportCSV,
    csvCell,
} from "../public/js/model.js";
const repos = normalizeRepos(
    JSON.parse(
        await readFile(new URL("../public/data/demo.json", import.meta.url)),
    ),
);
test("GitHub usernames and links cannot escape their canonical host", () => {
    for (const user of ["octocat", "a", "a-1", "X".repeat(39)])
        assert.ok(validUser(user));
    for (const user of [
        "a--b",
        "-a",
        "a-",
        "a/b",
        "a".repeat(40),
        "https://evil.example",
        "",
    ])
        assert.ok(!validUser(user));
    assert.equal(repoURL("a/hello.world"), "https://github.com/a/hello.world");
    for (const repo of [
        "a/../secrets",
        "a/..",
        "a/.",
        "a/b?x",
        "//evil.example",
    ])
        assert.equal(repoURL(repo), null);
    assert.equal(
        commitURL("a/b", "https://github.com/a/b/commit/abcdef0"),
        "https://github.com/a/b/commit/abcdef0",
    );
    for (const url of [
        "javascript:alert(1)",
        "https://github.com.evil.test/a/b/commit/abcdef0",
        "https://user@github.com/a/b/commit/abcdef0",
        "https://github.com/a/b/commit/abcdef0?token=secret",
        "https://github.com/a/b/commit/not-a-sha",
    ])
        assert.equal(commitURL("a/b", url), null);
});
test("combined filters search descriptions and topics, dates and favorite scope", () => {
    const f = {
        ...defaultFilters(),
        q: "creative-coding",
        language: "Python",
        stars: 500,
        hideForks: true,
        hideArchived: true,
    };
    assert.deepEqual(
        filterRepos(repos, f).map((r) => r.name),
        ["wildflower"],
    );
    assert.equal(filterRepos(repos, { ...f, created: "2030-01-01" }).length, 0);
    assert.equal(
        filterRepos(
            repos,
            { ...defaultFilters(), favoritesOnly: true },
            new Set(["demo/moss"]),
        ).length,
        1,
    );
    assert.equal(
        filterRepos(repos, { ...defaultFilters(), updated: "2030-01-01" })
            .length,
        0,
    );
});
test("sorting is stable and leaves input untouched", () => {
    const before = repos.map((r) => r.full_name);
    const stars = filterRepos(repos, { ...defaultFilters(), sort: "stars" });
    assert.equal(stars[0].name, "firefly");
    assert.deepEqual(
        repos.map((r) => r.full_name),
        before,
    );
    const name = filterRepos(repos, { ...defaultFilters(), sort: "name" });
    assert.equal(name[0].name, "bluebell");
});
test("share URLs round-trip public filters without credentials or favorites", () => {
    const f = {
        ...defaultFilters(),
        q: "art & code",
        language: "C++",
        stars: 10,
        hideForks: true,
        hideArchived: true,
        created: "2024-01-01",
        sort: "stars",
        favoritesOnly: true,
    };
    const url = shareURL("https://forest.example", "octocat", f);
    assert.ok(!url.includes("token") && !url.includes("favorites"));
    const restored = filtersFromURL(new URL(url).search);
    assert.deepEqual(restored, { ...f, favoritesOnly: false });
    assert.equal(
        filtersFromURL("?sort=evil&stars=Infinity&updated=invalid").sort,
        "updated",
    );
    assert.equal(filtersFromURL("?stars=-100").stars, 0);
});
test("CSV export neutralizes spreadsheet formulas and escapes delimiters", () => {
    assert.equal(csvCell('=HYPERLINK("evil")'), '"\'=HYPERLINK(""evil"")"');
    assert.equal(csvCell("  +SUM(1,1)"), '"\'  +SUM(1,1)"');
    assert.equal(csvCell("a,b\nc"), '"a,b\nc"');
    assert.ok(
        exportCSV([{ ...repos[0], description: "@SUM(1,1)" }]).includes(
            '"\'@SUM(1,1)"',
        ),
    );
});
test("normalization bounds records and drops untrusted links and unknown fields", () => {
    assert.throws(() => normalizeRepos({ repos: [] }));
    assert.throws(() => normalizeRepos(Array(501).fill(repos[0])));
    assert.throws(() => normalizeRepos([repos[0], repos[0]]));
    const [normalized] = normalizeRepos([
        {
            ...repos[0],
            token: "secret",
            stars: NaN,
            commits: [{ url: "https://evil.example", hash: "abcdefg" }],
        },
    ]);
    assert.equal(normalized.token, undefined);
    assert.equal(normalized.stars, 0);
    assert.equal(normalized.commits.length, 0);
});
test("repository summary counts sampled commits and includes unsampled trees", () => {
    const summary = summarize(repos);
    assert.equal(summary.repos, 16);
    assert.equal(summary.languages.size, 10);
    assert.equal(summary.stars, 11191);
    assert.equal(
        summary.commits,
        repos.reduce((n, r) => n + r.commits.length, 0),
    );
});
