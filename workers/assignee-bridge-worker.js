const DEFAULT_ALLOWED_ASSIGNEES = [
  "Dewan Kabir",
  "Nicole Greer",
  "Alex Mcnay",
  "Anton Yurkevich",
];

const DEFAULT_REPOSITORIES = [
  "DewanKabir009/jira-board-v3001-122-0",
  "DewanKabir009/jira-board-v3001-123-0",
];

const VERSION_REPOSITORIES = {
  "v3001.122.0": "DewanKabir009/jira-board-v3001-122-0",
  "v3001.123.0": "DewanKabir009/jira-board-v3001-123-0",
};

function parseList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function getAllowedOrigins(env) {
  const configured = parseList(env.ALLOWED_ORIGINS);
  return configured.length ? configured : ["https://dewankabir009.github.io"];
}

function getAllowedRepositories(env) {
  const configured = parseList(env.ALLOWED_REPOSITORIES);
  return new Set(configured.length ? configured : DEFAULT_REPOSITORIES);
}

function getAllowedAssignees(env) {
  const configured = parseList(env.ALLOWED_ASSIGNEES);
  return new Set(configured.length ? configured : DEFAULT_ALLOWED_ASSIGNEES);
}

function corsOrigin(request, env) {
  const origin = request.headers.get("Origin");
  const allowedOrigins = getAllowedOrigins(env);
  if (!origin) {
    return allowedOrigins[0] || "*";
  }
  return allowedOrigins.includes(origin) ? origin : "";
}

function corsHeaders(request, env) {
  const origin = corsOrigin(request, env);
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Bridge-Token",
    "Access-Control-Allow-Credentials": "true",
    Vary: "Origin",
  };
  if (origin) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function json(request, env, status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(request, env),
    },
  });
}

function optionsResponse(request, env) {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(request, env),
  });
}

function assertOrigin(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin || corsOrigin(request, env)) {
    return null;
  }
  return json(request, env, 403, {
    ok: false,
    message: "This dashboard origin is not allowed to use the hosted bridge.",
  });
}

function getAuthenticatedEmail(request) {
  return (
    request.headers.get("Cf-Access-Authenticated-User-Email") ||
    request.headers.get("X-Authenticated-User-Email") ||
    ""
  ).trim();
}

function hasValidAccessToken(request, env) {
  if (!env.BRIDGE_ACCESS_TOKEN) {
    return false;
  }
  const authorization = request.headers.get("Authorization") || "";
  const bearer = authorization.match(/^Bearer\s+(.+)$/i);
  const token = bearer ? bearer[1] : request.headers.get("X-Bridge-Token");
  return token === env.BRIDGE_ACCESS_TOKEN;
}

function authorizeMutation(request, env) {
  if (hasValidAccessToken(request, env)) {
    return { ok: true, mode: "access-token" };
  }

  const allowedEmails = parseList(env.ALLOWED_USER_EMAILS).map((email) => email.toLowerCase());
  if (allowedEmails.length) {
    const email = getAuthenticatedEmail(request).toLowerCase();
    if (email && allowedEmails.includes(email)) {
      return { ok: true, mode: "cloudflare-access", email };
    }
    return {
      ok: false,
      status: 401,
      message: "Sign in through the protected bridge endpoint before submitting dashboard updates.",
    };
  }

  return {
    ok: false,
    status: 503,
    message: "Hosted bridge auth is not configured. Set ALLOWED_USER_EMAILS with Cloudflare Access or BRIDGE_ACCESS_TOKEN.",
  };
}

function bridgeReady(env) {
  const hasGithubToken = Boolean(env.BOARD_DISPATCH_TOKEN);
  const hasAuthProtection = Boolean(env.BRIDGE_ACCESS_TOKEN) || parseList(env.ALLOWED_USER_EMAILS).length > 0;
  return hasGithubToken && hasAuthProtection;
}

function resolveRepositorySlug(payload, env) {
  const byVersion = VERSION_REPOSITORIES[payload.releaseVersion] || VERSION_REPOSITORIES[payload.version];
  const requested = payload.repositorySlug || byVersion || env.DEFAULT_REPOSITORY || DEFAULT_REPOSITORIES[0];
  const allowed = getAllowedRepositories(env);
  if (!allowed.has(requested)) {
    throw new Error("Dashboard repository is not allowed for this hosted bridge.");
  }
  return requested;
}

async function readJson(request) {
  try {
    return await request.json();
  } catch (error) {
    throw new Error("Request body must be valid JSON.");
  }
}

async function dispatchWorkflow(env, repositorySlug, workflowFile, inputs) {
  if (!env.BOARD_DISPATCH_TOKEN) {
    throw new Error("BOARD_DISPATCH_TOKEN is not configured on the hosted bridge.");
  }

  const response = await fetch(
    `https://api.github.com/repos/${repositorySlug}/actions/workflows/${workflowFile}/dispatches`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${env.BOARD_DISPATCH_TOKEN}`,
        "Content-Type": "application/json",
        "User-Agent": "jira-board-hosted-bridge",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({
        ref: env.GITHUB_REF || "master",
        inputs,
      }),
    },
  );

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`GitHub workflow dispatch failed (${response.status}): ${details.slice(0, 500)}`);
  }
}

async function handleStatus(request, env) {
  const ready = bridgeReady(env);
  return json(request, env, ready ? 200 : 503, {
    ok: ready,
    bridge: "hosted",
    mode: "github-actions-dispatch",
    message: ready ? "Hosted assignee bridge ready." : "Hosted bridge needs BOARD_DISPATCH_TOKEN and an auth guard.",
  });
}

async function handleAssign(request, env) {
  const auth = authorizeMutation(request, env);
  if (!auth.ok) {
    return json(request, env, auth.status, { ok: false, message: auth.message });
  }

  const payload = await readJson(request);
  const issueKey = String(payload.issueKey || payload.issue_key || "").trim().toUpperCase();
  const assigneeDisplayName = String(payload.assigneeDisplayName || payload.assignee_display_name || "").trim();

  if (!/^[A-Z][A-Z0-9]+-\d+$/.test(issueKey)) {
    return json(request, env, 400, { ok: false, message: "A valid Jira issue key is required." });
  }

  if (!getAllowedAssignees(env).has(assigneeDisplayName)) {
    return json(request, env, 400, { ok: false, message: "That assignee is not allowed for this dashboard." });
  }

  const repositorySlug = resolveRepositorySlug(payload, env);
  await dispatchWorkflow(env, repositorySlug, env.ASSIGNEE_WORKFLOW || "update-jira-assignee.yml", {
    issue_key: issueKey,
    assignee_display_name: assigneeDisplayName,
  });

  return json(request, env, 202, {
    ok: true,
    bridge: "hosted",
    repositorySlug,
    issueKey,
    assigneeDisplayName,
    message: "Assignee update workflow started.",
  });
}

async function handleChecklistComment(request, env) {
  const auth = authorizeMutation(request, env);
  if (!auth.ok) {
    return json(request, env, auth.status, { ok: false, message: auth.message });
  }

  const payload = await readJson(request);
  const issueKey = String(payload.issueKey || payload.issue_key || "").trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9]+-\d+$/.test(issueKey)) {
    return json(request, env, 400, { ok: false, message: "A valid Jira issue key is required." });
  }

  const repositorySlug = resolveRepositorySlug(payload, env);
  await dispatchWorkflow(env, repositorySlug, env.CHECKLIST_WORKFLOW || "post-test-checklist-comment.yml", {
    issue_key: issueKey,
    checklist_payload: JSON.stringify(payload),
  });

  return json(request, env, 202, {
    ok: true,
    bridge: "hosted",
    repositorySlug,
    issueKey,
    message: "Checklist comment workflow started.",
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return optionsResponse(request, env);
    }

    const originError = assertOrigin(request, env);
    if (originError) {
      return originError;
    }

    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname.endsWith("/status")) {
        return handleStatus(request, env);
      }
      if (request.method === "POST" && url.pathname.endsWith("/assign")) {
        return handleAssign(request, env);
      }
      if (request.method === "POST" && url.pathname.endsWith("/comment-checklist")) {
        return handleChecklistComment(request, env);
      }
      return json(request, env, 404, { ok: false, message: "Unknown bridge route." });
    } catch (error) {
      return json(request, env, 500, {
        ok: false,
        message: error instanceof Error ? error.message : "Hosted bridge request failed.",
      });
    }
  },
};
