import { defineConfig } from "@playwright/test";
export default defineConfig({
    testDir: "./tests/browser",
    fullyParallel: false,
    workers: 1,
    timeout: 30000,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 1 : 0,
    reporter: process.env.CI ? "github" : "list",
    use: {
        baseURL: "http://127.0.0.1:18089",
        headless: true,
        viewport: { width: 1440, height: 1000 },
        trace: "retain-on-failure",
        launchOptions: {
            args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
        },
    },
    webServer: {
        command: "go run .",
        url: "http://127.0.0.1:18089/health",
        env: {
            PORT: "18089",
            GOMAXPROCS: "2",
            ALLOWED_ORIGINS: "http://127.0.0.1:18089",
        },
        reuseExistingServer: !process.env.CI,
        timeout: 120000,
    },
});
