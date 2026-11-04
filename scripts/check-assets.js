import { readFile, readdir, stat } from "node:fs/promises";
import { resolve, dirname, relative } from "node:path";
import { createHash } from "node:crypto";
const publicRoot = resolve("public"),
    vendor = resolve(publicRoot, "vendor/three");
const manifest = JSON.parse(
    await readFile(resolve(vendor, "integrity.json"), "utf8"),
);
async function walk(path) {
    const result = [];
    for (const entry of await readdir(path, { withFileTypes: true })) {
        const full = resolve(path, entry.name);
        if (entry.isDirectory()) result.push(...(await walk(full)));
        else result.push(full);
    }
    return result;
}
for (const [name, expected] of Object.entries(manifest.sha256)) {
    const full = resolve(vendor, name);
    if (!full.startsWith(vendor + "/"))
        throw new Error("Manifest path escapes vendor directory");
    const hash = createHash("sha256")
        .update(await readFile(full))
        .digest("hex");
    if (hash !== expected)
        throw new Error(`Vendored asset integrity mismatch: ${name}`);
}
for (const file of await walk(vendor))
    if (file.endsWith(".js") && !manifest.sha256[relative(vendor, file)])
        throw new Error(`Unrecorded vendored JavaScript: ${file}`);
const map = {
    three: resolve(vendor, "build/three.module.js"),
    "three/addons/": resolve(vendor, "examples/jsm") + "/",
};
for (const file of [
    ...(await walk(resolve(publicRoot, "js"))),
    ...(await walk(vendor)),
].filter((p) => p.endsWith(".js"))) {
    const source = await readFile(file, "utf8");
    const imports = [
        ...source.matchAll(
            /^\s*import\s+(?:[\w\s{},*]+?\s+from\s+)?['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]/gm,
        ),
    ].map((match) => match[1] || match[2]);
    for (const specifier of imports) {
        let target;
        if (specifier === "three") target = map.three;
        else if (specifier.startsWith("three/addons/"))
            target = resolve(map["three/addons/"], specifier.slice(13));
        else if (specifier.startsWith("."))
            target = resolve(dirname(file), specifier);
        else
            throw new Error(`Unexpected module source ${specifier} in ${file}`);
        if (
            !target.startsWith(publicRoot + "/") ||
            !(await stat(target)).isFile()
        )
            throw new Error(`Missing import ${specifier} in ${file}`);
    }
}
const html = await readFile(resolve(publicRoot, "index.html"), "utf8");
if (/\son[a-z]+\s*=\s*['"]/i.test(html))
    throw new Error("Inline event handlers are forbidden");
for (const match of html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g))
    if (!match[1].startsWith("/"))
        throw new Error("Unexpected third-party executable script");
console.log(
    `Verified ${Object.keys(manifest.sha256).length} vendored files, module imports and script origins.`,
);
