import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
const fixture = JSON.parse(
    (
        await readFile(
            new URL("../../public/data/demo.json", import.meta.url),
            "utf8",
        )
    ).replaceAll("demo/", "octocat/"),
);
async function mockGitHub(page, data = fixture, status = 200) {
    await page.route("**/api/github?**", (route) =>
        route.fulfill({
            status,
            headers: {
                "Content-Type": "application/json",
                "X-Forest-Sampled": "13",
                "X-Forest-Failed": "0",
                "X-Forest-Cache": "miss",
                "X-GitHub-RateLimit-Remaining": "42",
                "X-Forest-Fetched-At": "2026-11-04T12:00:00Z",
            },
            body: JSON.stringify(data),
        }),
    );
}
async function demo(page) {
    await page.goto("/");
    await expect(page.locator(".repo-card")).toHaveCount(16);
}
async function loadUser(page, user = "octocat") {
    await page.getByLabel("GitHub username", { exact: true }).fill(user);
    await page.getByRole("button", { name: "Grow forest" }).click();
    await expect(page.locator("#profile-title")).toHaveText(`@${user}.`);
}
test("demo is interactive, has no third-party requests and no JavaScript errors", async ({
    page,
}) => {
    const errors = [],
        external = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
        if (!request.url().startsWith("http://127.0.0.1:18089/"))
            external.push(request.url());
    });
    await demo(page);
    await expect(page.locator("canvas")).toBeVisible();
    await expect(page.locator("#scene-fallback")).toBeHidden();
    await expect(page.locator("#snapshot-button")).toBeEnabled();
    await page
        .getByRole("button", { name: "Explore project: firefly", exact: true })
        .click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(
        page.getByRole("heading", { name: "firefly", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
    await page.screenshot({ path: "test-results/desktop.png", fullPage: true });
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
});
test("public profile filters, sorting, empty search and reset are consistent", async ({
    page,
}) => {
    await mockGitHub(page);
    await demo(page);
    await loadUser(page);
    await page.getByLabel("Sort by").selectOption("stars");
    await expect(page.locator(".repo-name").first()).toHaveText("firefly");
    await page
        .getByLabel("Search repositories", { exact: true })
        .fill("creative-coding");
    await expect(page.locator(".repo-card")).toHaveCount(1);
    await expect(page.locator(".repo-name")).toHaveText("wildflower");
    await page
        .getByLabel("Search repositories", { exact: true })
        .fill("no-such-project");
    await expect(page.locator("#empty-state")).toBeVisible();
    await page.locator("#empty-reset").click();
    await expect(page.locator(".repo-card")).toHaveCount(16);
    await page.getByLabel("Minimum stars").fill("2000");
    await page.getByLabel("Minimum stars").dispatchEvent("change");
    await expect(page.locator(".repo-card")).toHaveCount(1);
    await expect(page.locator(".repo-name")).toHaveText("firefly");
    await page.locator("#reset-filters").click();
    await page.getByLabel("Hide forks", { exact: true }).check();
    await page.getByLabel("Hide archived projects", { exact: true }).check();
    await expect(page.locator(".repo-card")).toHaveCount(14);
});
test("favorites persist on this device and work as a filter", async ({
    page,
}) => {
    await demo(page);
    await page.locator(".favorite-button").first().click();
    await page.locator("#favorites-only").check();
    await expect(page.locator(".repo-card")).toHaveCount(1);
    expect(
        await page.evaluate(
            () => JSON.parse(localStorage.getItem("forest-favorites")).length,
        ),
    ).toBe(1);
    await page.reload();
    await expect(page.locator(".repo-card")).toHaveCount(16);
    await page.locator("#favorites-only").check();
    await expect(page.locator(".repo-card")).toHaveCount(1);
});
test("shared views restore language, star and sort filters", async ({
    page,
}) => {
    await mockGitHub(page);
    await page.goto("/?user=octocat&lang=Rust&stars=1000&sort=stars");
    await expect(page.locator("#profile-title")).toHaveText("@octocat.");
    await expect(page.locator(".repo-card")).toHaveCount(1);
    await expect(page.locator(".repo-name")).toHaveText("firefly");
    await expect(page.locator("#language")).toHaveValue("Rust");
});
test("tokens stay out of storage, URLs and downloaded snapshots", async ({
    page,
}) => {
    let authorization;
    await page.route("**/api/github?**", (route) => {
        authorization = route.request().headers().authorization;
        return route.fulfill({ json: fixture });
    });
    await page.addInitScript(() => {
        sessionStorage.setItem("cf_token", "legacy-secret");
    });
    await demo(page);
    await page.locator(".token-options summary").click();
    await page.locator("#token").fill("ghp_testPublicReadOnly");
    await loadUser(page);
    expect(authorization).toBe("Bearer ghp_testPublicReadOnly");
    expect(
        await page.evaluate(() => sessionStorage.getItem("cf_token")),
    ).toBeNull();
    expect(
        await page.evaluate(() =>
            JSON.stringify({ ...localStorage, ...sessionStorage }),
        ),
    ).not.toContain("ghp_testPublicReadOnly");
    expect(page.url()).not.toContain("token");
    const downloaded = page.waitForEvent("download");
    await page.locator("#json-export").click();
    const download = await downloaded;
    const content = await readFile(await download.path(), "utf8");
    expect(content).not.toContain("ghp_testPublicReadOnly");
    expect(JSON.parse(content).repos).toHaveLength(16);
    await page.locator("#clear-token").click();
    await expect(page.locator("#token")).toHaveValue("");
});
test("empty profiles clear the previous forest and collection", async ({
    page,
}) => {
    await mockGitHub(page, []);
    await demo(page);
    await loadUser(page, "empty");
    await expect(page.locator(".repo-card")).toHaveCount(0);
    await expect(page.locator("#stat-repos")).toHaveText("0");
    await expect(page.locator("#empty-message")).toHaveText(
        "This profile has no public repositories to explore.",
    );
});
test("GitHub failures are actionable and preserve the currently shown profile", async ({
    page,
}) => {
    await mockGitHub(
        page,
        {
            error: {
                code: "github_rate_limited",
                message: "GitHub API budget exhausted. Please retry later.",
            },
        },
        429,
    );
    await demo(page);
    await page.locator("#username").fill("octocat");
    await page.locator("#grow-button").click();
    await expect(page.locator("#status")).toContainText(
        "GitHub API budget exhausted",
    );
    await expect(page.locator("#profile-title")).toHaveText("The demo forest.");
    await expect(page.locator(".repo-card")).toHaveCount(16);
    await expect(page.locator("#grow-button")).toBeEnabled();
});
test("repository descriptions are text, and dialogs restore keyboard focus", async ({
    page,
}) => {
    const dangerous = structuredClone(fixture);
    dangerous[0].description = '<img src=x onerror="window.compromised=true">';
    await mockGitHub(page, dangerous);
    await demo(page);
    await loadUser(page);
    const trigger = page.getByRole("button", {
        name: "Explore project: canopy",
        exact: true,
    });
    await trigger.click();
    await expect(page.locator("#repo-details")).toContainText("<img src=x");
    expect(await page.evaluate(() => window.compromised)).toBeUndefined();
    await expect(page.locator("#repo-dialog img")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
});
test("the collection works when WebGL cannot start", async ({ page }) => {
    await page.addInitScript(() => {
        const original = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (type, ...args) {
            if (
                type === "webgl" ||
                type === "webgl2" ||
                type === "experimental-webgl"
            )
                return null;
            return original.call(this, type, ...args);
        };
    });
    await demo(page);
    await expect(page.locator("#scene-fallback")).toBeVisible();
    await page.getByLabel("Search repositories", { exact: true }).fill("moss");
    await expect(page.locator(".repo-card")).toHaveCount(1);
    await page
        .getByRole("button", { name: "Explore project: moss", exact: true })
        .click();
    await expect(page.locator("#repo-dialog")).toBeVisible();
});
test("reduced-motion preference starts with animation paused", async ({
    page,
}) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await demo(page);
    await expect(page.locator("#pause-button")).toHaveAttribute(
        "aria-pressed",
        "true",
    );
    await expect(page.locator("#pause-button")).toHaveText("Resume");
});
test("larger collections page correctly and search includes unloaded cards", async ({
    page,
}) => {
    const many = Array.from({ length: 80 }, (_, i) => ({
        ...fixture[0],
        name: `project-${i}`,
        full_name: `octocat/project-${i}`,
        commits: [],
    }));
    await mockGitHub(page, many);
    await demo(page);
    await loadUser(page);
    await expect(page.locator(".repo-card")).toHaveCount(24);
    await page.locator("#load-more").click();
    await expect(page.locator(".repo-card")).toHaveCount(48);
    await page.locator("#search").fill("project-79");
    await expect(page.locator(".repo-card")).toHaveCount(1);
    await expect(page.locator(".repo-name")).toHaveText("project-79");
});
for (const [width, height] of [
    [320, 740],
    [375, 812],
    [768, 1024],
    [1440, 1000],
    [844, 390],
])
    test(`layout and controls stay usable at ${width}×${height}`, async ({
        page,
    }) => {
        await page.setViewportSize({ width, height });
        await demo(page);
        await expect(page.locator("canvas")).toBeVisible();
        expect(
            await page.evaluate(
                () => document.documentElement.scrollWidth <= innerWidth + 1,
            ),
        ).toBe(true);
        if (width <= 760) {
            await page.locator("#filter-details summary").click();
            await expect(page.locator("#search")).toBeVisible();
            await page.locator("#search").fill("moss");
            await expect(page.locator(".repo-card")).toHaveCount(1);
            await page.locator("#reset-filters").click();
            await page.locator("#filter-details summary").click();
        }
        await page.locator("#grow-button").scrollIntoViewIfNeeded();
        await expect(page.locator("#grow-button")).toBeInViewport();
        await page.locator("#snapshot-button").scrollIntoViewIfNeeded();
        await expect(page.locator("#snapshot-button")).toBeInViewport();
        if (width === 375)
            await page.screenshot({
                path: "test-results/mobile.png",
                fullPage: true,
            });
    });
test("desktop explorer has no automatic WCAG 2.1 AA accessibility violations", async ({
    page,
}) => {
    const { default: AxeBuilder } = await import("@axe-core/playwright");
    await demo(page);
    const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();
    expect(results.violations).toEqual([]);
});
