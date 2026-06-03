const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const sourceDir = path.join(repoRoot, "modern");
const outputDir = path.join(repoRoot, ".cloudflare-hq-assets");
const githubAssetPrefix = "/jira-board-v3001-123-0/modern/_astro/";
const cloudflareAssetPrefix = "/_astro/";

if (!fs.existsSync(sourceDir)) {
  throw new Error(`Missing modern dashboard output at ${sourceDir}`);
}

fs.rmSync(outputDir, { recursive: true, force: true });
fs.cpSync(sourceDir, outputDir, { recursive: true });

function rewriteHtmlAssets(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const filePath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      rewriteHtmlAssets(filePath);
      continue;
    }

    if (!entry.isFile() || !entry.name.endsWith(".html")) {
      continue;
    }

    const html = fs.readFileSync(filePath, "utf8");
    fs.writeFileSync(filePath, html.replaceAll(githubAssetPrefix, cloudflareAssetPrefix));
  }
}

rewriteHtmlAssets(outputDir);
console.log(`Prepared Cloudflare HQ assets at ${outputDir}`);
