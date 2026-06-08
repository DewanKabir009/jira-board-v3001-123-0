const DEFAULT_ALLOWED_ASSIGNEES = [
  "Dewan Kabir",
  "Nicole Greer",
  "Alex Mcnay",
  "Anton Yurkevich",
];

const DEFAULT_REPOSITORIES = [
  "DewanKabir009/jira-board-template",
];

const VERSION_REPOSITORIES = {};

const JIRA_FIELDS = [
  "summary",
  "description",
  "status",
  "issuetype",
  "priority",
  "assignee",
  "customfield_11800",
  "updated",
  "components",
  "parent",
  "attachment",
];

function parseList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function getAllowedOrigins(env) {
  const configured = parseList(env.ALLOWED_ORIGINS);
  return configured.length ? configured : ["https://dewankabir009.github.io", "https://*.dfkabir253.workers.dev"];
}

function allowedOriginMatches(origin, allowedOrigin) {
  if (allowedOrigin === "*" || allowedOrigin === origin) {
    return true;
  }
  if (!allowedOrigin.includes("*")) {
    return false;
  }

  const pattern = `^${allowedOrigin
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")}$`;
  return new RegExp(pattern).test(origin);
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
  return allowedOrigins.some((allowedOrigin) => allowedOriginMatches(origin, allowedOrigin)) ? origin : "";
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

function base64UrlDecode(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function decodeJwtPart(value) {
  const decoded = new TextDecoder().decode(base64UrlDecode(value));
  return JSON.parse(decoded);
}

async function verifyAccessJwt(request, env) {
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token || !env.ACCESS_AUD || !env.ACCESS_JWKS_URL) {
    return null;
  }

  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Cloudflare Access JWT is malformed.");
  }

  const header = decodeJwtPart(parts[0]);
  const payload = decodeJwtPart(parts[1]);
  const now = Math.floor(Date.now() / 1000);
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];

  if (!audiences.includes(env.ACCESS_AUD)) {
    throw new Error("Cloudflare Access JWT audience does not match this bridge.");
  }
  if (env.ACCESS_ISSUER && payload.iss !== env.ACCESS_ISSUER) {
    throw new Error("Cloudflare Access JWT issuer does not match this bridge.");
  }
  if (payload.exp && payload.exp < now) {
    throw new Error("Cloudflare Access JWT has expired.");
  }
  if (payload.nbf && payload.nbf > now) {
    throw new Error("Cloudflare Access JWT is not active yet.");
  }

  const jwksResponse = await fetch(env.ACCESS_JWKS_URL, {
    headers: { Accept: "application/json" },
  });
  if (!jwksResponse.ok) {
    throw new Error(`Could not load Cloudflare Access signing keys (${jwksResponse.status}).`);
  }

  const jwks = await jwksResponse.json();
  const key = (jwks.keys || []).find((candidate) => candidate.kid === header.kid);
  if (!key) {
    throw new Error("Cloudflare Access signing key was not found.");
  }

  const cryptoKey = await crypto.subtle.importKey(
    "jwk",
    key,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signedData = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const signature = base64UrlDecode(parts[2]);
  const verified = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", cryptoKey, signature, signedData);
  if (!verified) {
    throw new Error("Cloudflare Access JWT signature is invalid.");
  }

  return {
    email: String(payload.email || payload.common_name || "").trim(),
    subject: payload.sub,
  };
}

async function authorizeMutation(request, env) {
  if (hasValidAccessToken(request, env)) {
    return { ok: true, mode: "access-token" };
  }

  const allowedEmails = parseList(env.ALLOWED_USER_EMAILS).map((email) => email.toLowerCase());
  if (allowedEmails.length) {
    let email = getAuthenticatedEmail(request).toLowerCase();
    if (!email) {
      const accessIdentity = await verifyAccessJwt(request, env);
      email = String(accessIdentity?.email || "").toLowerCase();
    }
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
    return JSON.parse((await request.text()) || "{}");
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

function jiraConfig(env) {
  const cloudId = env.JIRA_CLOUD_ID || "24a77690-829a-4704-94eb-fafef6370d21";
  const email = env.JIRA_EMAIL || "dewan.kabir@versantmedia.com";
  const token = env.JIRA_MCP_TOKEN || env.JIRA_API_TOKEN || "";
  const siteUrl = (env.JIRA_SITE_URL || "https://golfnow.atlassian.net").replace(/\/$/, "");

  if (!cloudId || !email || !token) {
    throw new Error("Jira lookup is not configured on the bridge. Set JIRA_CLOUD_ID, JIRA_EMAIL, and JIRA_MCP_TOKEN.");
  }

  return { cloudId, email, token, siteUrl };
}

function jiraCommentUrl(config, issueKey, commentId) {
  const base = `${config.siteUrl}/browse/${issueKey}`;
  return commentId ? `${base}?focusedCommentId=${encodeURIComponent(commentId)}` : base;
}

async function jiraFetch(env, apiPath) {
  const config = jiraConfig(env);
  const response = await fetch(`https://api.atlassian.com/ex/jira/${config.cloudId}/rest/api/3${apiPath}`, {
    headers: {
      Accept: "application/json",
      Authorization: `Basic ${btoa(`${config.email}:${config.token}`)}`,
    },
  });

  if (!response.ok) {
    const details = await response.text();
    const error = new Error(`Jira lookup failed (${response.status}): ${details.slice(0, 300)}`);
    error.status = response.status;
    throw error;
  }

  return response.json();
}

async function jiraJsonMutation(env, apiPath, method, payload) {
  const config = jiraConfig(env);
  const response = await fetch(`https://api.atlassian.com/ex/jira/${config.cloudId}/rest/api/3${apiPath}`, {
    method,
    headers: {
      Accept: "application/json",
      Authorization: `Basic ${btoa(`${config.email}:${config.token}`)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const body = await response.json().catch(async () => ({ message: await response.text().catch(() => "") }));
  if (!response.ok) {
    const details = JSON.stringify(body).slice(0, 500);
    const error = new Error(`Jira mutation failed (${response.status}): ${details}`);
    error.status = response.status;
    throw error;
  }

  return body;
}

async function jiraBinaryFetch(env, apiPath) {
  const config = jiraConfig(env);
  const response = await fetch(`https://api.atlassian.com/ex/jira/${config.cloudId}/rest/api/3${apiPath}`, {
    headers: {
      Accept: "*/*",
      Authorization: `Basic ${btoa(`${config.email}:${config.token}`)}`,
    },
    redirect: "follow",
  });

  if (!response.ok) {
    const details = await response.text();
    const error = new Error(`Jira media lookup failed (${response.status}): ${details.slice(0, 300)}`);
    error.status = response.status;
    throw error;
  }

  return response;
}

function formatDate(input) {
  if (!input) {
    return "";
  }

  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(input));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function appendDescriptionText(node, output) {
  if (!node) {
    return;
  }

  if (typeof node.text === "string") {
    output.push(node.text);
  }

  if (node.type === "paragraph" || node.type === "heading") {
    output.push("\n");
  }

  if (Array.isArray(node.content)) {
    for (const child of node.content) {
      appendDescriptionText(child, output);
    }
  }
}

function descriptionText(description) {
  if (!description) {
    return "";
  }

  if (typeof description === "string") {
    return description;
  }

  const output = [];
  appendDescriptionText(description, output);
  return output.join("").replace(/\n{3,}/g, "\n\n").trim();
}

function isImageAttachment(attachment) {
  return String(attachment?.mimeType || "").startsWith("image/");
}

function isVideoAttachment(attachment) {
  return String(attachment?.mimeType || "").startsWith("video/");
}

function mediaProxyUrl(request, attachment) {
  if (!request || !attachment?.id) {
    return "";
  }

  const url = new URL(request.url);
  url.pathname = url.pathname.replace(/\/issue$/, "/media").replace(/\/media$/, "/media");
  url.search = "";
  url.searchParams.set("attachmentId", attachment.id);
  return url.toString();
}

function renderAttachmentMedia(attachments = [], request = null) {
  const mediaAttachments = attachments.filter((attachment) => isImageAttachment(attachment) || isVideoAttachment(attachment));
  if (!mediaAttachments.length || !request) {
    return "";
  }

  const renderedMedia = mediaAttachments.map((attachment) => {
    const label = escapeHtml(attachment.filename || "Jira media");
    const src = escapeHtml(mediaProxyUrl(request, attachment));
    if (!src) {
      return "";
    }
    if (isVideoAttachment(attachment)) {
      return `<figure class="description-media description-video"><video src="${src}" controls preload="metadata"></video><figcaption>${label}</figcaption></figure>`;
    }
    return `<figure class="description-media"><img src="${src}" alt="${label}" loading="lazy"><figcaption>${label}</figcaption></figure>`;
  }).filter(Boolean).join("");

  return renderedMedia ? `<div class="description-media-group">${renderedMedia}</div>` : "";
}

function descriptionHtml(description, attachments = [], request = null) {
  const text = descriptionText(description);
  const mediaHtml = renderAttachmentMedia(attachments, request);
  if (!text && !mediaHtml) {
    return "";
  }

  const bodyHtml = text
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`)
    .join("");
  return `${bodyHtml}${mediaHtml}`;
}

function personName(person) {
  if (!person) {
    return "";
  }

  if (Array.isArray(person)) {
    return person.map(personName).filter(Boolean).join(", ");
  }

  if (typeof person === "string") {
    return person;
  }

  return person.displayName || person.name || person.value || "";
}

function personAvatar(person) {
  if (!person || typeof person === "string") {
    return "";
  }

  if (Array.isArray(person)) {
    return personAvatar(person.find(Boolean));
  }

  return person.avatarUrls?.["48x48"] || person.avatarUrls?.["32x32"] || person.avatarUrls?.["24x24"] || "";
}

function personAccountId(person) {
  if (!person || typeof person === "string") {
    return "";
  }

  if (Array.isArray(person)) {
    return personAccountId(person.find(Boolean));
  }

  return person.accountId || "";
}

function countDescriptionMedia(node) {
  if (!node || typeof node !== "object") {
    return 0;
  }

  const selfCount = node.type === "media" || node.type === "mediaSingle" ? 1 : 0;
  const childCount = Array.isArray(node.content)
    ? node.content.reduce((total, child) => total + countDescriptionMedia(child), 0)
    : 0;
  return selfCount + childCount;
}

function collectAdfMediaNodes(node, output = []) {
  if (!node || typeof node !== "object") {
    return output;
  }

  if (Array.isArray(node)) {
    node.forEach((child) => collectAdfMediaNodes(child, output));
    return output;
  }

  if (node.type === "media") {
    output.push(node);
  }

  if (Array.isArray(node.content)) {
    node.content.forEach((child) => collectAdfMediaNodes(child, output));
  }

  return output;
}

function attachmentsForAdfMedia(node, attachments = []) {
  const mediaNodes = collectAdfMediaNodes(node);
  if (!mediaNodes.length) {
    return [];
  }

  const mediaLabels = new Set(mediaNodes.map((media) => String(media.attrs?.alt || "").toLowerCase()).filter(Boolean));
  return attachments.filter((attachment) => {
    const filename = String(attachment?.filename || "").toLowerCase();
    return filename && mediaLabels.has(filename);
  });
}

function latestIssueComment(comments = []) {
  const sortedComments = [...comments].sort((left, right) => {
    return new Date(left.created || 0).getTime() - new Date(right.created || 0).getTime();
  });
  return sortedComments[sortedComments.length - 1] || null;
}

function serializeIssueComments(comments = [], issueKey = "", attachments = [], request = null, config = null) {
  return comments.map((comment) => {
    const author = comment.author || {};
    const mediaCount = collectAdfMediaNodes(comment.body).length;
    const commentUrl = config && issueKey ? jiraCommentUrl(config, issueKey, comment.id || "") : "";
    const mediaAttachments = attachmentsForAdfMedia(comment.body, attachments);
    return {
      id: comment.id || "",
      url: commentUrl,
      author: personName(author) || "Unknown",
      authorAvatarUrl: personAvatar(author),
      created: comment.created || "",
      createdDisplay: formatDate(comment.created),
      updated: comment.updated || "",
      updatedDisplay: comment.updated && comment.updated !== comment.created ? formatDate(comment.updated) : "",
      hasMedia: mediaCount > 0,
      mediaCount,
      body: descriptionText(comment.body),
      bodyHtml: descriptionHtml(comment.body, mediaAttachments, request),
    };
  });
}

function normalizeJiraIssue(rawIssue, env, request, comments = []) {
  const fields = rawIssue.fields || {};
  const config = jiraConfig(env);
  const assignedDeveloper = fields.customfield_11800;
  const parentFields = fields.parent?.fields || {};
  const attachments = Array.isArray(fields.attachment) ? fields.attachment : [];
  const imageCount = attachments.filter(isImageAttachment).length;
  const videoCount = attachments.filter(isVideoAttachment).length;
  const mediaCount = imageCount + videoCount || countDescriptionMedia(fields.description);
  const latestComment = latestIssueComment(comments);

  return {
    key: rawIssue.key,
    url: `${config.siteUrl}/browse/${rawIssue.key}`,
    summary: fields.summary || "",
    type: fields.issuetype?.name || "",
    isSubtask: Boolean(fields.issuetype?.subtask),
    status: fields.status?.name || "",
    priority: fields.priority?.name || "None",
    assignee: personName(fields.assignee) || "Unassigned",
    assigneeAvatarUrl: personAvatar(fields.assignee),
    assigneeAccountId: personAccountId(fields.assignee),
    assignedDeveloper: personName(assignedDeveloper),
    assignedDeveloperAvatarUrl: personAvatar(assignedDeveloper),
    assignedDeveloperAccountId: personAccountId(assignedDeveloper),
    updated: fields.updated || "",
    updatedDisplay: formatDate(fields.updated),
    components: Array.isArray(fields.components) ? fields.components.map((component) => component.name).filter(Boolean) : [],
    parent: fields.parent ? {
      key: fields.parent.key,
      url: `${config.siteUrl}/browse/${fields.parent.key}`,
      summary: parentFields.summary || "",
      type: parentFields.issuetype?.name || "",
      status: parentFields.status?.name || "",
      priority: parentFields.priority?.name || "",
    } : null,
    description: descriptionText(fields.description),
    descriptionHtml: descriptionHtml(fields.description, attachments, request),
    descriptionImageCount: imageCount,
    descriptionVideoCount: videoCount,
    descriptionMediaCount: mediaCount,
    commentCount: comments.length,
    comments: serializeIssueComments(comments, rawIssue.key, attachments, request, config),
    lastCommentUrl: latestComment ? jiraCommentUrl(config, rawIssue.key, latestComment.id || "") : "",
    lastCommentDisplay: latestComment ? formatDate(latestComment.created) : "",
    lastCommentAuthor: personName(latestComment?.author) || "",
  };
}

async function fetchIssueComments(env, issueKey) {
  const comments = [];
  let startAt = 0;
  let total = 0;

  do {
    const payload = await jiraFetch(env, `/issue/${encodeURIComponent(issueKey)}/comment?maxResults=100&startAt=${startAt}&expand=renderedBody`);
    comments.push(...(payload.comments || []));
    total = Number(payload.total || comments.length);
    startAt += Number(payload.maxResults || 100);
  } while (comments.length < total);

  return comments.slice(-25);
}

async function handleIssueLookup(request, env) {
  const auth = await authorizeMutation(request, env);
  if (!auth.ok) {
    return json(request, env, auth.status, { ok: false, message: auth.message });
  }

  const url = new URL(request.url);
  const issueKey = String(url.searchParams.get("issueKey") || "").trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9]+-\d+$/.test(issueKey)) {
    return json(request, env, 400, { ok: false, message: "A valid Jira issue key is required." });
  }

  try {
    const issue = await jiraFetch(env, `/issue/${issueKey}?fields=${encodeURIComponent(JIRA_FIELDS.join(","))}`);
    const comments = await fetchIssueComments(env, issueKey);
    return json(request, env, 200, { ok: true, issue: normalizeJiraIssue(issue, env, request, comments) });
  } catch (error) {
    return json(request, env, error.status === 404 ? 404 : 500, {
      ok: false,
      message: error instanceof Error ? error.message : "Jira issue lookup failed.",
    });
  }
}

async function handleMediaProxy(request, env) {
  const auth = await authorizeMutation(request, env);
  if (!auth.ok) {
    return json(request, env, auth.status, { ok: false, message: auth.message });
  }

  const url = new URL(request.url);
  const attachmentId = String(url.searchParams.get("attachmentId") || "").trim();
  if (!/^\d+$/.test(attachmentId)) {
    return json(request, env, 400, { ok: false, message: "A valid Jira attachment id is required." });
  }

  try {
    const mediaResponse = await jiraBinaryFetch(env, `/attachment/content/${encodeURIComponent(attachmentId)}`);
    const headers = new Headers(corsHeaders(request, env));
    headers.set("Content-Type", mediaResponse.headers.get("Content-Type") || "application/octet-stream");
    headers.set("Cache-Control", "private, max-age=300");
    return new Response(mediaResponse.body, {
      status: mediaResponse.status,
      headers,
    });
  } catch (error) {
    return json(request, env, error.status === 404 ? 404 : 500, {
      ok: false,
      message: error instanceof Error ? error.message : "Jira media lookup failed.",
    });
  }
}

async function handleProjects(request, env) {
  const auth = await authorizeMutation(request, env);
  if (!auth.ok) {
    return json(request, env, auth.status, { ok: false, message: auth.message });
  }

  const payload = await jiraFetch(env, "/project/search?maxResults=100&orderBy=key");
  const projects = (payload.values || []).map((project) => ({
    key: project.key,
    name: project.name,
  })).filter((project) => project.key);

  return json(request, env, 200, { ok: true, projects });
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

function prefersHtml(request) {
  const accept = request.headers.get("Accept") || "";
  return accept.includes("text/html") && !accept.includes("application/json");
}

function html(request, env, status, body) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      ...corsHeaders(request, env),
    },
  });
}

function handleBridgeLanding(request, env) {
  const url = new URL(request.url);
  const ready = bridgeReady(env);
  const statusJsonUrl = new URL("/status?format=json", url.origin).toString();
  const assignUrl = new URL("/assign", url.origin).toString();
  const checklistUrl = new URL("/comment-checklist", url.origin).toString();
  const refreshUrl = new URL("/refresh", url.origin).toString();
  const hqUrl = env.HQ_URL || "https://core-qa-headquarters-124.dfkabir253.workers.dev/hq/";
  const boardUrl = env.BOARD_URL || "https://core-qa-headquarters-124.dfkabir253.workers.dev/";
  const repoList = parseList(env.ALLOWED_REPOSITORIES);
  const repoText = repoList.length ? repoList.join(", ") : "Not configured";
  const statusLabel = ready ? "Ready" : "Needs configuration";
  const statusDetail = ready
    ? "Hosted assignee, refresh, comment, checklist, and ticket lookup routes are online."
    : "Set BOARD_DISPATCH_TOKEN and an auth guard before dashboard writes can run.";

  return html(request, env, ready ? 200 : 503, `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Jira Board Bridge</title>
    <style>
      :root {
        color-scheme: light;
        --blue: #006edb;
        --green: #008a3d;
        --orange: #f58220;
        --ink: #061826;
        --muted: #456176;
        --line: #b8def5;
        --panel: rgba(255, 255, 255, 0.92);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: var(--ink);
        background:
          radial-gradient(circle at 20% 20%, rgba(0, 110, 219, 0.18), transparent 34rem),
          radial-gradient(circle at 85% 15%, rgba(117, 216, 75, 0.22), transparent 34rem),
          linear-gradient(135deg, #f6fbff 0%, #effffa 100%);
      }
      main {
        width: min(1100px, calc(100% - 32px));
        margin: 0 auto;
        padding: 56px 0;
      }
      .hero, .panel {
        border: 1px solid var(--line);
        border-radius: 10px;
        background: var(--panel);
        box-shadow: 0 22px 70px rgba(8, 43, 68, 0.12);
      }
      .hero {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 20px;
        padding: 30px;
      }
      .eyebrow {
        margin: 0 0 8px;
        color: var(--blue);
        font-size: 0.75rem;
        font-weight: 900;
        letter-spacing: 0;
        text-transform: uppercase;
      }
      h1 {
        margin: 0;
        font-size: clamp(2rem, 5vw, 4.6rem);
        line-height: 0.95;
      }
      p {
        color: var(--muted);
        font-size: 1rem;
        line-height: 1.55;
      }
      .status {
        align-self: start;
        min-width: 210px;
        border: 1px solid ${ready ? "#9decc4" : "#ffd08a"};
        border-radius: 999px;
        background: ${ready ? "#e5fff0" : "#fff6dd"};
        padding: 12px 16px;
        color: ${ready ? "var(--green)" : "#9f4d00"};
        font-weight: 950;
        text-align: center;
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-top: 22px;
      }
      a.button {
        display: inline-flex;
        min-height: 42px;
        align-items: center;
        justify-content: center;
        border: 1px solid var(--blue);
        border-radius: 8px;
        padding: 10px 14px;
        color: var(--blue);
        font-weight: 900;
        text-decoration: none;
      }
      a.button.primary {
        border-color: var(--blue);
        background: linear-gradient(135deg, var(--blue), #008a3d);
        color: #fff;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 12px;
        margin-top: 16px;
      }
      .panel {
        padding: 18px;
      }
      .panel strong {
        display: block;
        margin-bottom: 6px;
      }
      code {
        display: block;
        overflow-wrap: anywhere;
        border: 1px solid #d2eafb;
        border-radius: 8px;
        background: #f6fbff;
        padding: 10px;
        color: #12354d;
      }
      @media (max-width: 780px) {
        .hero, .grid { grid-template-columns: 1fr; }
        .status { min-width: 0; }
      }
    </style>
  </head>
  <body>
    <main>
      <section class="hero">
        <div>
          <p class="eyebrow">Cloudflare hosted bridge</p>
          <h1>Jira board bridge</h1>
          <p>${escapeHtml(statusDetail)} Use this page as the login checkpoint before assigning tickets, refreshing the board, posting checklist comments, or opening live Jira ticket details from the dashboard.</p>
          <div class="actions">
            <a class="button primary" href="${escapeHtml(boardUrl)}">Open .124 board</a>
            <a class="button" href="${escapeHtml(hqUrl)}">Open QA HQ</a>
            <a class="button" href="${escapeHtml(statusJsonUrl)}">Open status JSON</a>
          </div>
        </div>
        <div class="status">${escapeHtml(statusLabel)}</div>
      </section>
      <div class="grid" aria-label="Bridge routes and configuration">
        <article class="panel">
          <strong>Write routes</strong>
          <p>These are called by the dashboard after Cloudflare Access or token auth is available.</p>
          <code>${escapeHtml(assignUrl)}<br>${escapeHtml(checklistUrl)}<br>${escapeHtml(refreshUrl)}</code>
        </article>
        <article class="panel">
          <strong>Allowed repositories</strong>
          <p>Dashboards outside this list are rejected before a GitHub workflow dispatch.</p>
          <code>${escapeHtml(repoText)}</code>
        </article>
        <article class="panel">
          <strong>Browser behavior</strong>
          <p>Opening /status in a browser now shows this page. Dashboard status checks and /status?format=json still return JSON.</p>
          <code>${escapeHtml(statusJsonUrl)}</code>
        </article>
      </div>
    </main>
  </body>
</html>`);
}

async function handleRefresh(request, env) {
  const auth = await authorizeMutation(request, env);
  if (!auth.ok) {
    return json(request, env, auth.status, { ok: false, message: auth.message });
  }

  const payload = await readJson(request);
  const repositorySlug = resolveRepositorySlug(payload, env);
  const workflowFile = env.REFRESH_WORKFLOW || "refresh-jira-board.yml";

  await dispatchWorkflow(env, repositorySlug, workflowFile, {});

  return json(request, env, 202, {
    ok: true,
    bridge: "hosted",
    repositorySlug,
    workflowFile,
    actionsUrl: `https://github.com/${repositorySlug}/actions/workflows/${workflowFile}`,
    message: "Jira ticket refresh workflow started.",
  });
}

async function handleAssign(request, env) {
  const auth = await authorizeMutation(request, env);
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
  const auth = await authorizeMutation(request, env);
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

function textToAdf(text) {
  const normalized = String(text || "").replace(/\r\n/g, "\n").trim();
  const paragraphs = normalized.split(/\n{2,}/).map((paragraph) => paragraph.trim()).filter(Boolean);
  return {
    type: "doc",
    version: 1,
    content: (paragraphs.length ? paragraphs : [normalized || " "]).map((paragraph) => ({
      type: "paragraph",
      content: paragraph.split(/\n/).flatMap((line, index) => {
        const nodes = [];
        if (index > 0) {
          nodes.push({ type: "hardBreak" });
        }
        if (line) {
          nodes.push({ type: "text", text: line });
        }
        return nodes;
      }),
    })),
  };
}

function isJiraAdfDocument(value) {
  return Boolean(
    value
    && value.type === "doc"
    && value.version === 1
    && Array.isArray(value.content)
    && value.content.length > 0
  );
}

async function handlePlainComment(request, env) {
  const auth = await authorizeMutation(request, env);
  if (!auth.ok) {
    return json(request, env, auth.status, { ok: false, message: auth.message });
  }

  const payload = await readJson(request);
  const issueKey = String(payload.issueKey || payload.issue_key || "").trim().toUpperCase();
  const body = String(payload.body || payload.comment || "").trim();

  if (!/^[A-Z][A-Z0-9]+-\d+$/.test(issueKey)) {
    return json(request, env, 400, { ok: false, message: "A valid Jira issue key is required." });
  }
  if (!body) {
    return json(request, env, 400, { ok: false, message: "Comment text is required." });
  }
  if (body.length > 32000) {
    return json(request, env, 400, { ok: false, message: "Comment text is too long for this dashboard composer." });
  }

  const adfBody = isJiraAdfDocument(payload.adf) ? payload.adf : textToAdf(body);
  const comment = await jiraJsonMutation(env, `/issue/${encodeURIComponent(issueKey)}/comment`, "POST", {
    body: adfBody,
  });
  const config = jiraConfig(env);
  const commentId = comment.id || "";

  return json(request, env, 201, {
    ok: true,
    bridge: "hosted",
    issueKey,
    commentId,
    commentUrl: jiraCommentUrl(config, issueKey, commentId),
    message: "Jira comment posted.",
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
      if (request.method === "GET" && url.pathname === "/") {
        return handleBridgeLanding(request, env);
      }
      if (request.method === "GET" && url.pathname.endsWith("/status")) {
        if (prefersHtml(request) && url.searchParams.get("format") !== "json") {
          return handleBridgeLanding(request, env);
        }
        return handleStatus(request, env);
      }
      if (request.method === "GET" && url.pathname.endsWith("/projects")) {
        return handleProjects(request, env);
      }
      if (request.method === "GET" && url.pathname.endsWith("/issue")) {
        return handleIssueLookup(request, env);
      }
      if (request.method === "GET" && url.pathname.endsWith("/media")) {
        return handleMediaProxy(request, env);
      }
      if (request.method === "POST" && url.pathname.endsWith("/refresh")) {
        return handleRefresh(request, env);
      }
      if (request.method === "POST" && url.pathname.endsWith("/assign")) {
        return handleAssign(request, env);
      }
      if (request.method === "POST" && url.pathname.endsWith("/comment-checklist")) {
        return handleChecklistComment(request, env);
      }
      if (request.method === "POST" && url.pathname.endsWith("/comment")) {
        return handlePlainComment(request, env);
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
