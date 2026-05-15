const http = require("http");
const cp = require("child_process");
const fs = require("fs");

const host = process.env.ASSIGNEE_DISPATCH_HOST || "127.0.0.1";
const port = Number(process.env.ASSIGNEE_DISPATCH_PORT || 3992);
const repo = process.env.GITHUB_REPOSITORY || "DewanKabir009/jira-board-v3001-123-0";
const workflow = process.env.ASSIGNEE_WORKFLOW || "update-jira-assignee.yml";
const allowedOrigins = new Set([
  "https://dewankabir009.github.io",
  "http://127.0.0.1:3992",
  "http://localhost:3992",
  "null",
]);
const allowedAssignees = [
  "Dewan Kabir",
  "Nicole Greer",
  "Alex McNay",
  "Anton Yurkevich",
];

function normalize(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function findGh() {
  const candidates = [
    process.env.GH_PATH,
    "C:\\Program Files\\GitHub CLI\\gh.exe",
    "C:\\Program Files (x86)\\GitHub CLI\\gh.exe",
    "gh",
  ].filter(Boolean);

  return candidates.find((candidate) => candidate === "gh" || fs.existsSync(candidate));
}

function writeJson(response, status, payload, origin) {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": origin && allowedOrigins.has(origin) ? origin : "https://dewankabir009.github.io",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Credentials": "true",
  });
  response.end(JSON.stringify(payload));
}

function getBridgeStatus() {
  if (process.env.JIRA_MCP_TOKEN) {
    return {
      ok: true,
      bridge: "running",
      githubCli: "not required",
      jiraAssigneeUpdate: "direct",
      message: "Bridge ready.",
    };
  }

  const gh = findGh();
  if (!gh) {
    return {
      ok: false,
      bridge: "running",
      githubCli: "missing",
      message: "Bridge running, GitHub CLI missing.",
    };
  }

  try {
    cp.execFileSync(gh, ["auth", "status", "--hostname", "github.com"], {
      stdio: "pipe",
      windowsHide: true,
    });
    return {
      ok: true,
      bridge: "running",
      githubCli: "authenticated",
      message: "Bridge ready.",
    };
  } catch (error) {
    return {
      ok: false,
      bridge: "running",
      githubCli: "not authenticated",
      message: "Bridge running, GitHub CLI auth needs attention.",
    };
  }
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 4096) {
        request.destroy(new Error("Request body is too large."));
      }
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function validate(payload) {
  const issueKey = String(payload.issueKey || "").trim().toUpperCase();
  const assigneeDisplayName = String(payload.assigneeDisplayName || "").trim();

  if (!/^[A-Z][A-Z0-9]+-\d+$/.test(issueKey)) {
    throw new Error("Invalid Jira issue key.");
  }

  if (!allowedAssignees.some((name) => normalize(name) === normalize(assigneeDisplayName))) {
    throw new Error("Unsupported assignee.");
  }

  return { issueKey, assigneeDisplayName };
}

function dispatchWorkflow({ issueKey, assigneeDisplayName }) {
  const gh = findGh();
  if (!gh) {
    throw new Error("GitHub CLI was not found. Install gh or set GH_PATH.");
  }

  cp.execFileSync(gh, [
    "workflow",
    "run",
    workflow,
    "--repo",
    repo,
    "--ref",
    "master",
    "-f",
    `issue_key=${issueKey}`,
    "-f",
    `assignee_display_name=${assigneeDisplayName}`,
  ], {
    stdio: "pipe",
    windowsHide: true,
  });
}

function updateAssigneeDirect({ issueKey, assigneeDisplayName }) {
  cp.execFileSync(process.execPath, [
    "scripts\\update-jira-assignee.cjs",
  ], {
    cwd: process.cwd(),
    stdio: "pipe",
    windowsHide: true,
    env: {
      ...process.env,
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_ACTOR: "DewanKabir009",
      INPUT_ISSUE_KEY: issueKey,
      INPUT_ASSIGNEE_DISPLAY_NAME: assigneeDisplayName,
    },
  });
}

const server = http.createServer(async (request, response) => {
  const origin = request.headers.origin || "";

  if (request.method === "OPTIONS") {
    writeJson(response, 204, {}, origin);
    return;
  }

  if (request.method === "GET" && request.url === "/status") {
    writeJson(response, 200, getBridgeStatus(), origin);
    return;
  }

  if (request.method !== "POST" || request.url !== "/assign") {
    writeJson(response, 404, { ok: false, error: "Not found." }, origin);
    return;
  }

  if (origin && !allowedOrigins.has(origin)) {
    writeJson(response, 403, { ok: false, error: "Origin is not allowed." }, origin);
    return;
  }

  try {
    const payload = JSON.parse(await readBody(request) || "{}");
    const requestPayload = validate(payload);
    if (process.env.JIRA_MCP_TOKEN) {
      updateAssigneeDirect(requestPayload);
      writeJson(response, 200, {
        ok: true,
        issueKey: requestPayload.issueKey,
        assigneeDisplayName: requestPayload.assigneeDisplayName,
        mode: "direct",
        jiraUrl: `https://golfnow.atlassian.net/browse/${requestPayload.issueKey}`,
      }, origin);
      return;
    }

    dispatchWorkflow(requestPayload);
    writeJson(response, 202, {
      ok: true,
      issueKey: requestPayload.issueKey,
      assigneeDisplayName: requestPayload.assigneeDisplayName,
      actionsUrl: `https://github.com/${repo}/actions/workflows/${workflow}`,
    }, origin);
  } catch (error) {
    writeJson(response, 400, {
      ok: false,
      error: error && error.message ? error.message : String(error),
    }, origin);
  }
});

server.listen(port, host, () => {
  console.log(`Assignee workflow dispatch bridge listening on http://${host}:${port}/assign`);
});
