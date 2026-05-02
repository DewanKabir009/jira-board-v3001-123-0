const fs = require("fs");
const path = require("path");
const cp = require("child_process");

const workspace = path.resolve(__dirname, "..");
const version = process.env.JIRA_FIX_VERSION || "v3001.123.0";
const safeVersion = version.replace(/[^a-zA-Z0-9._-]/g, "_");
const jsonPath = path.join(workspace, `jira-${safeVersion}-tickets.json`);
const htmlPath = path.join(workspace, "jira-board-latest.html");
const indexPath = path.join(workspace, "index.html");

function run(command, args) {
  cp.execFileSync(command, args, {
    cwd: workspace,
    stdio: "inherit",
  });
}

function listKeys(items) {
  return (items || []).map((item) => item.key).filter(Boolean);
}

function hasChanges(diff) {
  return Boolean(
    diff?.isBaseline ||
    (diff?.added || []).length ||
    (diff?.updated || []).length ||
    (diff?.statusChanges || []).length ||
    (diff?.removed || []).length
  );
}

function writeOutput(name, value) {
  if (!process.env.GITHUB_OUTPUT) {
    return;
  }

  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${String(value).replace(/\r?\n/g, " ")}\n`);
}

function writeSummary(markdown) {
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  }
  console.log(markdown);
}

run(process.execPath, [path.join(workspace, "pull-jira-release-tickets.cjs"), version]);

const data = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
const diff = data.pullDiff || {};
const added = diff.added || [];
const updated = diff.updated || [];
const statusChanges = diff.statusChanges || [];
const removed = diff.removed || [];
const jiraChanged = hasChanges(diff);
const previousIndex = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, "utf8") : "";

fs.copyFileSync(htmlPath, indexPath);

const currentIndex = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, "utf8") : "";
const publish = previousIndex !== currentIndex;

writeOutput("changed", jiraChanged ? "true" : "false");
writeOutput("publish", publish ? "true" : "false");
writeOutput("pulled_at", diff.currentPulledAtDisplay || data.pulledAtDisplay || "");

const lines = [
  `## Jira board refresh: ${jiraChanged ? "changes detected" : "No Change"}`,
  "",
  `- Version: \`${data.version}\``,
  `- Pull: ${diff.currentPulledAtDisplay || data.pulledAtDisplay} ET`,
  `- Previous pull: ${diff.previousPulledAtDisplay || "None"}${diff.previousPulledAtDisplay ? " ET" : ""}`,
  `- Added: ${added.length}`,
  `- Updated: ${updated.length}`,
  `- Status moves: ${statusChanges.length}`,
  `- Removed: ${removed.length}`,
  `- Dashboard: https://dewankabir009.github.io/jira-board-v3001-123-0/`,
];

if (added.length) {
  lines.push("", `Added tickets: ${listKeys(added).join(", ")}`);
}

if (updated.length) {
  lines.push("", `Updated tickets: ${listKeys(updated).join(", ")}`);
}

if (statusChanges.length) {
  lines.push("", "Status moves:");
  for (const item of statusChanges) {
    lines.push(`- ${item.key}: ${item.before} -> ${item.after}`);
  }
}

if (removed.length) {
  lines.push("", `Removed tickets: ${listKeys(removed).join(", ")}`);
}

if (!jiraChanged) {
  lines.push("", "No ticket field changes were detected. The dashboard timestamp and Data Pull panel were still published.");
}

if (!publish) {
  lines.push("", "The generated dashboard matched the current published file, so there was nothing to commit.");
}

writeSummary(lines.join("\n"));
