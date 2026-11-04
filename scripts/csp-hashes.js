import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const html = await readFile("public/index.html", "utf8");
for (const match of html.matchAll(
    /<script type="(?:importmap|application\/ld\+json)">([\s\S]*?)<\/script>/g,
))
    console.log(
        "sha256-" + createHash("sha256").update(match[1]).digest("base64"),
    );
