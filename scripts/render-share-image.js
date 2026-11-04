import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
const browser = await chromium.launch({ headless: true });
try {
    const page = await browser.newPage({
        viewport: { width: 1200, height: 630 },
        deviceScaleFactor: 1,
    });
    await page.setContent(
        "<style>html,body{margin:0}</style>" +
            (await readFile("public/social-card.svg", "utf8")),
    );
    await page.screenshot({ path: "public/social-card.png" });
} finally {
    await browser.close();
}
