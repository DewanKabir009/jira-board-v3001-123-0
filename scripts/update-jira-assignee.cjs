const fs = require("fs");
const path = require("path");
const cp = require("child_process");

const workspace = path.resolve(__dirname, "..");
const siteUrl = "https://golfnow.atlassian.net";
const dashboardUrl = "https://dewankabir009.github.io/jira-board-v3001-123-0/";
const cloudId = process.env.JIRA_CLOUD_ID || "24a77690-829a-4704-94eb-fafef6370d21";
const email = process.env.JIRA_EMAIL || "dewan.kabir@versantmedia.com";
const token = process.env.JIRA_MCP_TOKEN;
const version = process.env.JIRA_FIX_VERSION || "v3001.123.0";
const safeVersion = version.replace(/[^a-zA-Z0-9._-]/g, "_");
const jsonPath = path.join(workspace, `jira-${safeVersion}-tickets.json`);
const htmlPath = path.join(workspace, "jira-board-latest.html");
const indexPath = path.join(workspace, "index.html");

const allowedAssignees = [
  "Dewan Kabir",
  "Nicole Greer",
  "Alex McNay",
  "Anton Yurkevich",
];

function normalize(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function writeOutput(name, value) {
  if (!process.env.GITHUB_OUTPUT) {
    return;
  }

  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${String(value).replace(/\r?\n/g, " ")}\n`);
}

function writeSummary(markdown) {
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown.trim()}\n`);
  }
  console.log(markdown);
}

function run(command, args) {
  cp.execFileSync(command, args, {
    cwd: workspace,
    stdio: "inherit",
    env: process.env,
  });
}

function getTrustedActors() {
  return (process.env.TRUSTED_GITHUB_ACTORS || "DewanKabir009")
    .split(",")
    .map((actor) => normalize(actor))
    .filter(Boolean);
}

function getRequest() {
  const eventName = process.env.GITHUB_EVENT_NAME || "";

  if (eventName === "workflow_dispatch") {
    return {
      issueKey: process.env.INPUT_ISSUE_KEY || process.env.ISSUE_KEY,
      assigneeDisplayName: process.env.INPUT_ASSIGNEE_DISPLAY_NAME || process.env.ASSIGNEE_DISPLAY_NAME,
      dashboardUrl,
      source: "workflow_dispatch",
    };
  }

  return { skip: true, reason: `Unsupported event: ${eventName || "unknown"}.` };
}

function validateRequest(request) {
  const actor = process.env.GITHUB_ACTOR || "";
  const trustedActors = getTrustedActors();

  if (!trustedActors.includes(normalize(actor))) {
    throw new Error(`GitHub actor ${actor || "unknown"} is not allowed to update Jira from this workflow.`);
  }

  if (!request.issueKey || !/^[A-Z][A-Z0-9]+-\d+$/.test(request.issueKey)) {
    throw new Error(`Invalid Jira issue key: ${request.issueKey || "blank"}.`);
  }

  if (!allowedAssignees.some((name) => normalize(name) === normalize(request.assigneeDisplayName))) {
    throw new Error(`Unsupported assignee: ${request.assigneeDisplayName || "blank"}.`);
  }

  if (!token) {
    throw new Error("JIRA_MCP_TOKEN is not set.");
  }
}

async function jiraFetch(apiPath, options = {}) {
  const auth = Buffer.from(`${email}:${token}`).toString("base64");
  const response = await fetch(`https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3${apiPath}`, {
    ...options,
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Jira API failed: HTTP ${response.status} ${response.statusText}\n${text}`);
  }

  return text ? JSON.parse(text) : null;
}

async function getIssue(issueKey) {
  return jiraFetch(`/issue/${encodeURIComponent(issueKey)}?fields=summary,assignee,status`);
}

async function findAssignableAccount(issueKey, displayName) {
  const users = await jiraFetch(
    `/user/assignable/search?issueKey=${encodeURIComponent(issueKey)}&query=${encodeURIComponent(displayName)}&maxResults=50`,
  );
  const activeUsers = (Array.isArray(users) ? users : []).filter((user) => user.active !== false);
  const exact = activeUsers.find((user) => normalize(user.displayName) === normalize(displayName));
  const partial = activeUsers.find((user) => normalize(user.displayName).includes(normalize(displayName)));
  const user = exact || partial || (activeUsers.length === 1 ? activeUsers[0] : null);

  if (!user?.accountId) {
    const names = activeUsers.map((candidate) => candidate.displayName).join(", ") || "none";
    throw new Error(`Could not resolve assignable Jira user "${displayName}" for ${issueKey}. Matches: ${names}.`);
  }

  return user;
}

async function updateAssignee(issueKey, accountId) {
  await jiraFetch(`/issue/${encodeURIComponent(issueKey)}/assignee`, {
    method: "PUT",
    body: JSON.stringify({ accountId }),
  });
}

function refreshBoard() {
  const before = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, "utf8") : "";
  run(process.execPath, [path.join(workspace, "pull-jira-release-tickets.cjs"), version]);
  fs.copyFileSync(htmlPath, indexPath);
  const after = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, "utf8") : "";
  const data = JSON.parse(fs.readFileSync(jsonPath, "utf8"));

  return {
    boardChanged: before !== after,
    pulledAtDisplay: data.pullDiff?.currentPulledAtDisplay || data.pulledAtDisplay,
    diff: data.pullDiff || {},
  };
}

function listKeys(items) {
  return (items || []).map((item) => item.key).filter(Boolean).join(", ") || "None";
}

function buildComment({ request, beforeIssue, afterIssue, assignee, refresh }) {
  const beforeAssignee = beforeIssue.fields?.assignee?.displayName || "Unassigned";
  const afterAssignee = afterIssue.fields?.assignee?.displayName || "Unassigned";
  const diff = refresh.diff || {};

  return [
    `Jira assignee update complete for ${request.issueKey}.`,
    "",
    `- Assignee: ${beforeAssignee} -> ${afterAssignee}`,
    `- Jira user matched: ${assignee.displayName}`,
    `- Board pull: ${refresh.pulledAtDisplay} ET`,
    `- Board published: ${refresh.boardChanged ? "Yes" : "No content change"}`,
    `- Added: ${(diff.added || []).length}`,
    `- Updated: ${(diff.updated || []).length} (${listKeys(diff.updated)})`,
    `- Status moves: ${(diff.statusChanges || []).length}`,
    `- Removed: ${(diff.removed || []).length}`,
    `- Dashboard: ${request.dashboardUrl || dashboardUrl}`,
  ].join("\n");
}

async function main() {
  const request = getRequest();

  if (request.skip) {
    writeOutput("processed", "false");
    writeOutput("board_changed", "false");
    writeSummary(`Jira assignee update skipped: ${request.reason}`);
    return;
  }

  validateRequest(request);

  try {
    const beforeIssue = await getIssue(request.issueKey);
    const assignee = await findAssignableAccount(request.issueKey, request.assigneeDisplayName);
    await updateAssignee(request.issueKey, assignee.accountId);
    const afterIssue = await getIssue(request.issueKey);
    const refresh = refreshBoard();
    const comment = buildComment({ request, beforeIssue, afterIssue, assignee, refresh });

    writeOutput("processed", "true");
    writeOutput("success", "true");
    writeOutput("issue_key", request.issueKey);
    writeOutput("assignee_display_name", assignee.displayName);
    writeOutput("previous_assignee_display_name", beforeIssue.fields?.assignee?.displayName || "Unassigned");
    writeOutput("issue_summary", afterIssue.fields?.summary || beforeIssue.fields?.summary || "");
    writeOutput("issue_status", afterIssue.fields?.status?.name || "");
    writeOutput("issue_url", `${siteUrl}/browse/${request.issueKey}`);
    writeOutput("dashboard_url", request.dashboardUrl || dashboardUrl);
    writeOutput("board_changed", refresh.boardChanged ? "true" : "false");
    writeSummary(comment);
  } catch (error) {
    const message = error && error.stack ? error.stack : String(error);
    const comment = [
      `Jira assignee update failed for ${request.issueKey || "unknown issue"}.`,
      "",
      "```",
      message,
      "```",
    ].join("\n");

    writeOutput("processed", "true");
    writeOutput("success", "false");
    writeOutput("board_changed", "false");
    writeSummary(comment);
    throw error;
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
