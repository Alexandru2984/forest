import { readFile } from "node:fs/promises";
const manifest = JSON.parse(
    await readFile("public/vendor/three/integrity.json", "utf8"),
);
const response = await fetch(
    "https://registry.npmjs.org/-/npm/v1/security/advisories/bulk",
    {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [manifest.package]: [manifest.version] }),
        signal: AbortSignal.timeout(15000),
    },
);
if (!response.ok)
    throw new Error(
        `Vendored dependency advisory lookup failed: HTTP ${response.status}`,
    );
const report = await response.json();
const advisories = report[manifest.package] || [];
if (advisories.length)
    throw new Error(
        `Review advisories for ${manifest.package}@${manifest.version}: ${advisories.map((a) => `${a.title} (${a.url})`).join("; ")}`,
    );
console.log(
    `No npm advisories reported for vendored ${manifest.package}@${manifest.version}.`,
);
