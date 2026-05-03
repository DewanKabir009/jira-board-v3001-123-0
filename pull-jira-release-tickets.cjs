const fs = require("fs");
const path = require("path");

const workspace = __dirname;
const siteUrl = "https://golfnow.atlassian.net";
const dashboardVersion = "v1.9.5";
const repositorySlug = "DewanKabir009/jira-board-v3001-123-0";
const dashboardUrl = "https://dewankabir009.github.io/jira-board-v3001-123-0/";
const assigneeDispatchEndpoint = "http://127.0.0.1:3992/assign";
const mediaAssetBasePath = "assets/jira-media";
const assigneeOptions = [
  "Dewan Kabir",
  "Nicole Greer",
  "Alex Mcnay",
  "Anton Yurkevich",
];
const cloudId = process.env.JIRA_CLOUD_ID || "24a77690-829a-4704-94eb-fafef6370d21";
const email = process.env.JIRA_EMAIL || "dewan.kabir@versantmedia.com";
const token = process.env.JIRA_MCP_TOKEN;
const version = process.argv[2] || process.env.JIRA_FIX_VERSION || "v3001.123.0";
const authHeader = `Basic ${Buffer.from(`${email}:${token || ""}`).toString("base64")}`;

if (!token) {
  console.error("JIRA_MCP_TOKEN is not set.");
  process.exit(2);
}

const fields = [
  "summary",
  "description",
  "status",
  "issuetype",
  "priority",
  "assignee",
  "updated",
  "created",
  "fixVersions",
  "components",
  "resolution",
  "parent",
  "attachment",
];

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function jiraUrl(key) {
  return `${siteUrl}/browse/${key}`;
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

function serializeJsonForScript(value) {
  return JSON.stringify(value)
    .replace(/&/g, "\\u0026")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function appendDescriptionText(node, output) {
  if (!node) {
    return;
  }

  if (typeof node === "string") {
    output.push(node);
    return;
  }

  if (Array.isArray(node)) {
    node.forEach((child) => appendDescriptionText(child, output));
    return;
  }

  switch (node.type) {
    case "text":
      output.push(node.text || "");
      break;
    case "hardBreak":
      output.push("\n");
      break;
    case "emoji":
      output.push(node.attrs?.shortName || node.attrs?.text || "");
      break;
    case "mention":
      output.push(node.attrs?.text || node.attrs?.displayName || "");
      break;
    case "inlineCard":
    case "blockCard":
      output.push(node.attrs?.url || "");
      break;
    case "listItem":
      output.push("- ");
      appendDescriptionText(node.content, output);
      output.push("\n");
      break;
    case "paragraph":
    case "heading":
    case "blockquote":
    case "codeBlock":
    case "mediaSingle":
    case "panel":
      appendDescriptionText(node.content, output);
      output.push("\n\n");
      break;
    case "bulletList":
    case "orderedList":
      appendDescriptionText(node.content, output);
      output.push("\n");
      break;
    case "rule":
      output.push("\n---\n");
      break;
    default:
      appendDescriptionText(node.content, output);
      break;
  }
}

function descriptionToText(description) {
  if (!description) {
    return "";
  }

  if (typeof description === "string") {
    return description.trim();
  }

  const output = [];
  appendDescriptionText(description, output);
  return output.join("")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function descriptionExcerpt(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) {
    return "None";
  }

  return text.length > 140 ? `${text.slice(0, 137)}...` : text;
}

function slugifyFilename(value) {
  return String(value || "image")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 120) || "image";
}

function isImageAttachment(attachment) {
  return /^image\//i.test(attachment?.mimeType || "");
}

function collectDescriptionMedia(node, output = []) {
  if (!node) {
    return output;
  }

  if (Array.isArray(node)) {
    node.forEach((child) => collectDescriptionMedia(child, output));
    return output;
  }

  if (node.type === "media") {
    output.push(node.attrs || {});
  }

  collectDescriptionMedia(node.content, output);
  return output;
}

function buildAttachmentQueues(attachments) {
  const queues = new Map();

  for (const attachment of attachments || []) {
    if (!isImageAttachment(attachment)) {
      continue;
    }

    const key = String(attachment.filename || "").toLowerCase();
    if (!queues.has(key)) {
      queues.set(key, []);
    }
    queues.get(key).push(attachment);
  }

  return queues;
}

function attachmentForMedia(media, attachmentQueues, fallbackAttachments, index) {
  const altKey = String(media.alt || "").toLowerCase();
  const queue = altKey ? attachmentQueues.get(altKey) : null;
  if (queue?.length) {
    return queue.shift();
  }

  return fallbackAttachments[index] || null;
}

function assetForAttachment(issueKey, attachment) {
  const filename = slugifyFilename(attachment.filename);
  const assetRelativePath = `${mediaAssetBasePath}/${issueKey}/${attachment.id}-${filename}`;

  return {
    id: attachment.id,
    filename: attachment.filename || filename,
    mimeType: attachment.mimeType || "",
    contentUrl: attachment.content,
    relativePath: assetRelativePath,
    filePath: path.join(workspace, assetRelativePath),
  };
}

async function downloadMediaAsset(asset) {
  if (!asset?.contentUrl || !asset.filePath) {
    return false;
  }

  if (fs.existsSync(asset.filePath) && fs.statSync(asset.filePath).size > 0) {
    return true;
  }

  fs.mkdirSync(path.dirname(asset.filePath), { recursive: true });
  const response = await fetch(asset.contentUrl, {
    headers: {
      Authorization: authHeader,
      Accept: "*/*",
    },
  });

  if (!response.ok) {
    console.warn(`Could not download Jira description image ${asset.filename}: HTTP ${response.status}`);
    return false;
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(asset.filePath, bytes);
  return true;
}

function buildDescriptionMedia(description, attachments, issueKey) {
  const mediaNodes = collectDescriptionMedia(description);
  const imageAttachments = (attachments || []).filter(isImageAttachment);
  const attachmentQueues = buildAttachmentQueues(imageAttachments);
  const usedAttachmentIds = new Set();

  return mediaNodes.map((media, index) => {
    const attachment = attachmentForMedia(media, attachmentQueues, imageAttachments, index);
    if (!attachment || usedAttachmentIds.has(attachment.id)) {
      return {
        alt: media.alt || "Jira description image",
        width: media.width || null,
        height: media.height || null,
        missing: true,
      };
    }

    usedAttachmentIds.add(attachment.id);
    return {
      ...assetForAttachment(issueKey, attachment),
      alt: media.alt || attachment.filename || "Jira description image",
      width: media.width || null,
      height: media.height || null,
      missing: false,
    };
  });
}

function renderTextMarks(value, marks = []) {
  let output = escapeHtml(value);

  for (const mark of marks) {
    switch (mark.type) {
      case "strong":
        output = `<strong>${output}</strong>`;
        break;
      case "em":
        output = `<em>${output}</em>`;
        break;
      case "strike":
        output = `<s>${output}</s>`;
        break;
      case "code":
        output = `<code>${output}</code>`;
        break;
      case "link": {
        const href = mark.attrs?.href || "";
        if (/^https?:\/\//i.test(href) || href.startsWith("mailto:")) {
          output = `<a href="${escapeHtml(href)}" target="_blank" rel="noopener">${output}</a>`;
        }
        break;
      }
      default:
        break;
    }
  }

  return output;
}

function renderAdfChildren(node, context) {
  return (node?.content || []).map((child) => renderAdfNode(child, context)).join("");
}

function renderMediaNode(media, context) {
  const asset = context.mediaAssets[context.mediaIndex++] || {};
  const alt = asset.alt || media.attrs?.alt || "Jira description image";

  if (!asset.relativePath || asset.missing) {
    return `<div class="description-media-missing">${escapeHtml(alt)} could not be embedded.</div>`;
  }

  return `<figure class="description-media">` +
    `<img src="${escapeHtml(asset.relativePath)}" alt="${escapeHtml(alt)}" loading="lazy">` +
    `<figcaption>${escapeHtml(alt)}</figcaption>` +
  `</figure>`;
}

function renderAdfNode(node, context) {
  if (!node) {
    return "";
  }

  if (Array.isArray(node)) {
    return node.map((child) => renderAdfNode(child, context)).join("");
  }

  switch (node.type) {
    case "doc":
      return renderAdfChildren(node, context);
    case "paragraph": {
      const content = renderAdfChildren(node, context);
      return content ? `<p>${content}</p>` : "";
    }
    case "text":
      return renderTextMarks(node.text || "", node.marks || []);
    case "hardBreak":
      return "<br>";
    case "heading": {
      const level = Math.min(5, Math.max(3, Number(node.attrs?.level || 4)));
      return `<h${level}>${renderAdfChildren(node, context)}</h${level}>`;
    }
    case "bulletList":
      return `<ul>${renderAdfChildren(node, context)}</ul>`;
    case "orderedList":
      return `<ol>${renderAdfChildren(node, context)}</ol>`;
    case "listItem":
      return `<li>${renderAdfChildren(node, context)}</li>`;
    case "blockquote":
      return `<blockquote>${renderAdfChildren(node, context)}</blockquote>`;
    case "codeBlock":
      return `<pre><code>${renderAdfChildren(node, context)}</code></pre>`;
    case "rule":
      return "<hr>";
    case "panel":
      return `<div class="description-note">${renderAdfChildren(node, context)}</div>`;
    case "mediaSingle":
    case "mediaGroup":
      return `<div class="description-media-group">${renderAdfChildren(node, context)}</div>`;
    case "media":
      return renderMediaNode(node, context);
    case "inlineCard":
    case "blockCard": {
      const url = node.attrs?.url || "";
      return url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(url)}</a>` : "";
    }
    case "mention":
      return escapeHtml(node.attrs?.text || node.attrs?.displayName || "");
    case "emoji":
      return escapeHtml(node.attrs?.shortName || node.attrs?.text || "");
    case "table":
      return `<div class="description-table-wrap"><table>${renderAdfChildren(node, context)}</table></div>`;
    case "tableRow":
      return `<tr>${renderAdfChildren(node, context)}</tr>`;
    case "tableHeader":
      return `<th>${renderAdfChildren(node, context)}</th>`;
    case "tableCell":
      return `<td>${renderAdfChildren(node, context)}</td>`;
    default:
      return renderAdfChildren(node, context);
  }
}

function descriptionToHtml(description, mediaAssets = []) {
  if (!description) {
    return "";
  }

  if (typeof description === "string") {
    return description
      .trim()
      .split(/\n{2,}/)
      .map((paragraph) => `<p>${paragraph.split(/\n/).map(escapeHtml).join("<br>")}</p>`)
      .join("");
  }

  return renderAdfNode(description, { mediaAssets, mediaIndex: 0 }).trim();
}

async function buildRichDescription(issueKey, description, attachments) {
  const mediaAssets = buildDescriptionMedia(description, attachments, issueKey);
  const downloaded = await Promise.all(mediaAssets.map(downloadMediaAsset));
  const availableMediaAssets = mediaAssets.map((asset, index) => ({
    ...asset,
    missing: asset.missing || !downloaded[index],
  }));

  return {
    text: descriptionToText(description),
    html: descriptionToHtml(description, availableMediaAssets),
    imageCount: availableMediaAssets.filter((asset) => !asset.missing && asset.relativePath).length,
  };
}

function parseJsonText(text) {
  const normalized = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return JSON.parse(normalized);
}

function readDataFromHtml(htmlPath) {
  if (!fs.existsSync(htmlPath)) {
    return null;
  }

  const html = fs.readFileSync(htmlPath, "utf8");
  const start = '<script id="jira-data" type="application/json">';
  const end = "</script>";
  const startIndex = html.indexOf(start);
  if (startIndex === -1) {
    return null;
  }

  const endIndex = html.indexOf(end, startIndex);
  if (endIndex === -1) {
    return null;
  }

  try {
    return parseJsonText(html.slice(startIndex + start.length, endIndex));
  } catch {
    return null;
  }
}

function newerPullData(left, right) {
  if (!left) {
    return right || null;
  }
  if (!right) {
    return left;
  }

  const leftTime = Date.parse(left.pulledAt || "");
  const rightTime = Date.parse(right.pulledAt || "");
  if (Number.isNaN(leftTime)) {
    return right;
  }
  if (Number.isNaN(rightTime)) {
    return left;
  }

  return rightTime > leftTime ? right : left;
}

async function fetchIssues() {
  const jql = `fixVersion = "${version}" ORDER BY updated DESC`;
  const endpoint = `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/search/jql`;
  const issues = [];
  let nextPageToken;

  do {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jql,
        maxResults: 100,
        nextPageToken,
        fields,
      }),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Jira search failed: HTTP ${response.status} ${response.statusText}\n${text}`);
    }

    const payload = JSON.parse(text);
    issues.push(...(payload.issues || []));
    nextPageToken = payload.nextPageToken;
  } while (nextPageToken);

  return { jql, issues };
}

async function normalizeIssue(issue) {
  const issueFields = issue.fields || {};
  const issueType = issueFields.issuetype || {};
  const parentFields = issueFields.parent?.fields || {};
  const richDescription = await buildRichDescription(issue.key, issueFields.description, issueFields.attachment || []);
  const parentDescription = descriptionToText(parentFields.description);

  return {
    key: issue.key,
    url: jiraUrl(issue.key),
    summary: issueFields.summary || "",
    description: richDescription.text,
    descriptionHtml: richDescription.html,
    descriptionImageCount: richDescription.imageCount,
    type: issueType.name || "",
    isSubtask: Boolean(issueType.subtask),
    status: issueFields.status?.name || "",
    priority: issueFields.priority?.name || "None",
    assignee: issueFields.assignee?.displayName || "Unassigned",
    updated: issueFields.updated || "",
    updatedDisplay: formatDate(issueFields.updated),
    created: issueFields.created || "",
    createdDisplay: formatDate(issueFields.created),
    components: (issueFields.components || []).map((component) => component.name),
    fixVersions: (issueFields.fixVersions || []).map((fixVersion) => fixVersion.name),
    resolution: issueFields.resolution?.name || "",
    parent: issueFields.parent ? {
      key: issueFields.parent.key,
      url: jiraUrl(issueFields.parent.key),
      summary: parentFields.summary || "",
      description: parentDescription,
      type: parentFields.issuetype?.name || "Parent",
      status: parentFields.status?.name || "",
      priority: parentFields.priority?.name || "",
    } : null,
  };
}

function normalizeList(values) {
  return [...(values || [])].sort((left, right) => left.localeCompare(right));
}

function listsEqual(left, right) {
  const normalizedLeft = normalizeList(left);
  const normalizedRight = normalizeList(right);

  return normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

function formatList(values) {
  return normalizeList(values).join(", ") || "None";
}

function compareIssues(previous, current) {
  const changes = [];
  const scalarFields = [
    ["summary", "Summary"],
    ["type", "Type"],
    ["status", "Status"],
    ["priority", "Priority"],
    ["assignee", "Assignee"],
    ["resolution", "Resolution"],
    ["updatedDisplay", "Jira updated"],
  ];

  for (const [field, label] of scalarFields) {
    const before = previous[field] || "None";
    const after = current[field] || "None";
    if (before !== after) {
      changes.push({ field, label, before, after });
    }
  }

  if (!listsEqual(previous.components, current.components)) {
    changes.push({
      field: "components",
      label: "Components",
      before: formatList(previous.components),
      after: formatList(current.components),
    });
  }

  if (Object.prototype.hasOwnProperty.call(previous, "description") &&
      (previous.description || "") !== (current.description || "")) {
    changes.push({
      field: "description",
      label: "Description",
      before: descriptionExcerpt(previous.description),
      after: descriptionExcerpt(current.description),
    });
  }

  if ((previous.parent?.key || "") !== (current.parent?.key || "")) {
    changes.push({
      field: "parent",
      label: "Parent",
      before: previous.parent?.key || "None",
      after: current.parent?.key || "None",
    });
  }

  return changes;
}

function issueContext(issue) {
  if (!issue) {
    return {};
  }

  return {
    type: issue.type || "",
    isSubtask: Boolean(issue.isSubtask),
    assignee: issue.assignee || "Unassigned",
    status: issue.status || "",
    parent: issue.parent || null,
  };
}

function enrichPullItem(item, issuesByKey) {
  const issue = issuesByKey.get(item.key);
  return {
    ...item,
    ...issueContext(issue),
  };
}

function enrichPullDiff(diff, issuesByKey) {
  if (!diff) {
    return diff;
  }

  return {
    ...diff,
    added: (diff.added || []).map((issue) => ({
      ...issue,
      ...issueContext(issuesByKey.get(issue.key) || issue),
    })),
    removed: (diff.removed || []).map((issue) => ({
      ...issue,
      ...issueContext(issuesByKey.get(issue.key) || issue),
    })),
    updated: (diff.updated || []).map((item) => enrichPullItem(item, issuesByKey)),
    statusChanges: (diff.statusChanges || []).map((item) => enrichPullItem(item, issuesByKey)),
  };
}

function buildPullDiff(previousData, issues, pulledAt, pulledAtDisplay) {
  const previousIssues = previousData?.issues || [];
  const previousByKey = new Map(previousIssues.map((issue) => [issue.key, issue]));
  const currentByKey = new Map(issues.map((issue) => [issue.key, issue]));
  const added = [];
  const removed = [];
  const updated = [];
  const statusChanges = [];

  for (const issue of issues) {
    const previous = previousByKey.get(issue.key);
    if (!previous) {
      added.push(issue);
      continue;
    }

    const changes = compareIssues(previous, issue);
    if (changes.length) {
      updated.push({
        key: issue.key,
        url: issue.url,
        summary: issue.summary,
        changes,
      });
    }

    if ((previous.status || "") !== (issue.status || "")) {
      statusChanges.push({
        key: issue.key,
        url: issue.url,
        summary: issue.summary,
        before: previous.status || "None",
        after: issue.status || "None",
      });
    }
  }

  for (const issue of previousIssues) {
    if (!currentByKey.has(issue.key)) {
      removed.push(issue);
    }
  }

  return {
    previousPulledAt: previousData?.pulledAt || null,
    previousPulledAtDisplay: previousData?.pulledAtDisplay || null,
    currentPulledAt: pulledAt,
    currentPulledAtDisplay: pulledAtDisplay,
    isBaseline: !previousData?.issues?.length,
    added,
    removed,
    updated,
    statusChanges,
  };
}

function isDescriptionBackfillDiff(entry, previousData) {
  if (previousData?.dashboardVersion === dashboardVersion) {
    return false;
  }

  const updated = entry?.updated || [];
  if (!updated.length ||
      (entry.added || []).length ||
      (entry.removed || []).length ||
      (entry.statusChanges || []).length) {
    return false;
  }

  return updated.every((item) => {
    const changes = item.changes || [];
    return changes.length &&
      changes.every((change) => change.field === "description" && change.before === "None");
  });
}

function buildPullHistory(previousData, currentDiff) {
  const previousHistory = Array.isArray(previousData?.pullHistory)
    ? previousData.pullHistory
    : (previousData?.pullDiff ? [previousData.pullDiff] : []);
  const seen = new Set();
  const history = [];

  for (const entry of [currentDiff, ...previousHistory]) {
    if (!entry?.currentPulledAt || seen.has(entry.currentPulledAt)) {
      continue;
    }
    if (isDescriptionBackfillDiff(entry, previousData)) {
      continue;
    }
    seen.add(entry.currentPulledAt);
    history.push(entry);
  }

  return history.slice(0, 168);
}

function buildJson(issues, jql, previousData) {
  const pulledAt = new Date().toISOString();
  const pulledAtDisplay = formatDate(pulledAt);
  const issuesByKey = new Map(issues.map((issue) => [issue.key, issue]));
  const pullDiff = enrichPullDiff(
    buildPullDiff(previousData, issues, pulledAt, pulledAtDisplay),
    issuesByKey,
  );

  return {
    version,
    dashboardVersion,
    siteUrl,
    jql,
    pulledAt,
    pulledAtDisplay,
    total: issues.length,
    issues,
    pullDiff,
    pullHistory: buildPullHistory(previousData, pullDiff).map((entry) => enrichPullDiff(entry, issuesByKey)),
  };
}

function renderHtml(data) {
  const jiraFilterUrl = `${siteUrl}/issues/?jql=${encodeURIComponent(data.jql)}`;
  const readmeUrl = "https://github.com/DewanKabir009/jira-board-v3001-123-0#version-history";
  const dataJson = serializeJsonForScript({
    ...data,
    jiraFilterUrl,
    dashboardVersion,
    repositorySlug,
    dashboardUrl,
    assigneeDispatchEndpoint,
    assigneeOptions,
  });

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Cache-Control" content="no-store, no-cache, must-revalidate">
  <meta http-equiv="Pragma" content="no-cache">
  <meta http-equiv="Expires" content="0">
  <title>GolfNow CORE Jira Board - ${escapeHtml(version)}</title>
  <style>
    :root {
      --ink: #172033;
      --muted: #60708d;
      --line: #d8dee9;
      --paper: #f7f9fc;
      --panel: #ffffff;
      --panel-soft: #fbfcff;
      --blue: #0c66e4;
      --blue-soft: #eef4ff;
      --teal: #118d7c;
      --teal-soft: #e9f7f4;
      --amber: #b76e00;
      --amber-soft: #fff3d9;
      --red: #c9372c;
      --red-soft: #ffe9e7;
      --shadow: 0 18px 45px rgba(23, 32, 51, .11);
    }

    * {
      box-sizing: border-box;
    }

    html {
      min-width: 0;
    }

    body {
      margin: 0;
      min-width: 320px;
      min-height: 100vh;
      color: var(--ink);
      background: var(--paper);
      font: 13px/1.42 "Segoe UI", Arial, sans-serif;
      letter-spacing: 0;
      overflow-x: hidden;
    }

    body.modal-open {
      overflow: hidden;
    }

    button,
    input,
    select {
      font: inherit;
      letter-spacing: 0;
    }

    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }

    .page {
      width: 100%;
      max-width: 1540px;
      margin: 0 auto;
      padding: clamp(12px, 2vw, 28px);
    }

    .shell {
      width: 100%;
      border: 1px solid rgba(96, 112, 141, .18);
      border-radius: 8px;
      background: rgba(255, 255, 255, .96);
      box-shadow: var(--shadow);
      overflow: hidden;
    }

    header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 20px;
      padding: clamp(18px, 2.3vw, 30px);
      border-bottom: 1px solid var(--line);
      background: linear-gradient(90deg, #fff, #f5f8ff 56%, #f2fbf8);
    }

    h1 {
      margin: 0;
      font-size: clamp(24px, 3.4vw, 34px);
      line-height: 1.08;
      font-weight: 760;
      letter-spacing: 0;
    }

    .subtitle {
      margin-top: 8px;
      color: var(--muted);
      font-size: 14px;
      max-width: 860px;
    }

    .stamp {
      flex: 0 0 auto;
      min-width: min(288px, 100%);
      padding: 12px 14px;
      border: 1px solid #cdd7e7;
      border-radius: 8px;
      background: #fff;
      color: var(--muted);
      line-height: 1.55;
      text-align: right;
    }

    .stamp strong {
      display: block;
      color: var(--ink);
      font-size: 13px;
    }

    .stamp-next,
    .stamp-domain {
      display: block;
    }

    .stamp-next {
      margin-top: 2px;
      color: #334968;
      font-size: 12px;
      font-weight: 720;
    }

    .toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 14px clamp(18px, 2.3vw, 30px);
      border-bottom: 1px solid var(--line);
      background: var(--panel-soft);
    }

    .toolbar-group {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }

    .control-button,
    .chip,
    .section-toggle {
      border: 1px solid #cdd7e7;
      border-radius: 8px;
      background: #fff;
      color: #284263;
      cursor: pointer;
      font-weight: 700;
    }

    .control-button {
      min-height: 34px;
      padding: 7px 11px;
    }

    .control-button:hover,
    .chip:hover,
    .section-toggle:hover {
      border-color: #9eb5d5;
      color: var(--blue);
    }

    .control-button[aria-pressed="true"],
    .chip.active {
      border-color: var(--blue);
      background: var(--blue-soft);
      color: #0747a6;
    }

    .filter-state {
      color: var(--muted);
      font-size: 12px;
      font-weight: 650;
    }

    .metrics {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
      gap: 12px;
      padding: 18px clamp(18px, 2.3vw, 30px);
      border-bottom: 1px solid var(--line);
      background: #fff;
    }

    .metric {
      min-width: 0;
      border: 1px solid #dce3ef;
      border-radius: 8px;
      background: #fff;
      padding: 12px 14px;
    }

    .value {
      font-size: 28px;
      font-weight: 780;
      line-height: 1;
    }

    .label {
      margin-top: 5px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 650;
      text-transform: uppercase;
    }

    .metric-detail {
      margin-top: 6px;
      color: #41506a;
      font-size: 11px;
      font-weight: 650;
    }

    .components-panel {
      padding: 16px clamp(18px, 2.3vw, 30px) 18px;
      border-bottom: 1px solid var(--line);
      background: var(--panel-soft);
    }

    .qa-panel {
      background: #fff;
    }

    .priority-panel {
      background: #fff;
    }

    .panel-title {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 10px;
    }

    .panel-title h2 {
      margin: 0;
      font-size: 15px;
      font-weight: 780;
    }

    .title-row,
    .key-row {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
    }

    .panel-note {
      color: var(--muted);
      font-size: 12px;
      text-align: right;
    }

    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }

    .chip {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      min-height: 30px;
      padding: 5px 9px;
      max-width: 100%;
    }

    .chip-name {
      overflow-wrap: anywhere;
    }

    .chip-count {
      min-width: 22px;
      border-radius: 999px;
      background: #eef2f7;
      padding: 1px 7px;
      color: #41506a;
      text-align: center;
      font-size: 11px;
    }

    .chip.active .chip-count {
      background: #fff;
      color: #0747a6;
    }

    .priority-summary {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 8px;
    }

    .priority-card {
      min-width: 0;
      border: 1px solid #dce3ef;
      border-radius: 8px;
      background: #fff;
      padding: 9px 10px;
    }

    .priority-card-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }

    .priority-total {
      color: var(--ink);
      font-size: 22px;
      font-weight: 780;
      line-height: 1;
    }

    .priority-card-detail {
      margin-top: 6px;
      color: #41506a;
      font-size: 11px;
      font-weight: 650;
    }

    .board {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(min(100%, 365px), 1fr));
      align-items: start;
      gap: 16px;
      padding: 22px clamp(18px, 2.3vw, 30px) 26px;
    }

    .board-column {
      display: grid;
      align-content: start;
      gap: 16px;
      min-width: 0;
    }

    .section {
      min-width: 0;
    }

    .section-toggle {
      width: 100%;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto auto;
      align-items: center;
      gap: 10px;
      margin-bottom: 10px;
      padding: 9px 10px;
      border-color: transparent;
      border-top: 3px solid var(--blue);
      background: var(--blue-soft);
      color: #0b3f8a;
      text-align: left;
    }

    .section-toggle .title {
      overflow-wrap: anywhere;
    }

    .count {
      min-width: 24px;
      border-radius: 999px;
      background: #fff;
      padding: 2px 8px;
      text-align: center;
      font-size: 12px;
    }

    .chevron {
      color: #41506a;
      font-size: 12px;
    }

    .section.collapsed .chevron {
      transform: rotate(-90deg);
    }

    .cards {
      display: grid;
      gap: 10px;
    }

    .section.collapsed .cards {
      display: none;
    }

    .ticket,
    .subtask {
      min-width: 0;
      border: 1px solid #dce3ef;
      border-radius: 8px;
      background: var(--panel);
      padding: 12px;
      break-inside: avoid;
    }

    .ticket.parent-stub {
      border-style: dashed;
      background: #fffdf8;
    }

    .topline {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }

    .key {
      color: var(--blue);
      font-size: 15px;
      font-weight: 800;
      text-decoration: none;
      white-space: nowrap;
    }

    .key:hover {
      text-decoration: underline;
    }

    .copy-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      flex: 0 0 24px;
      border: 1px solid #cdd7e7;
      border-radius: 6px;
      background: #fff;
      color: #41506a;
      cursor: pointer;
      padding: 0;
    }

    .copy-button:hover,
    .copy-button:focus-visible {
      border-color: var(--blue);
      color: var(--blue);
      outline: 0;
    }

    .copy-button.copied {
      border-color: var(--teal);
      background: var(--teal-soft);
      color: var(--teal);
    }

    .copy-button svg {
      width: 14px;
      height: 14px;
      stroke: currentColor;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
      fill: none;
      pointer-events: none;
    }

    .type {
      border: 1px solid #cfd8e6;
      border-radius: 999px;
      padding: 2px 8px;
      color: var(--muted);
      font-size: 11px;
      font-weight: 700;
      text-align: right;
    }

    .summary {
      margin: 8px 0 10px;
      font-size: 13px;
      font-weight: 680;
      overflow-wrap: anywhere;
    }

    .meta {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 7px 12px;
      color: var(--muted);
      font-size: 11px;
    }

    .meta b {
      display: block;
      color: #41506a;
      font-size: 10px;
      text-transform: uppercase;
    }

    .priority {
      display: inline-block;
      border-radius: 999px;
      padding: 1px 7px;
      background: #eef2f7;
      color: #41506a;
      font-weight: 750;
    }

    .p-p0 {
      background: var(--red-soft);
      color: var(--red);
    }

    .p-p1 {
      background: var(--amber-soft);
      color: var(--amber);
    }

    .p-p2 {
      background: var(--blue-soft);
      color: var(--blue);
    }

    .p-p3 {
      background: var(--teal-soft);
      color: var(--teal);
    }

    .components-list {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
      margin-top: 3px;
    }

    .component-pill {
      border-radius: 999px;
      background: #eef2f7;
      padding: 2px 7px;
      color: #334968;
      font-size: 11px;
      font-weight: 650;
      overflow-wrap: anywhere;
    }

    .ticket-actions {
      display: grid;
      gap: 6px;
      margin-top: 10px;
    }

    .description-shell {
      margin-top: 10px;
      border-left: 3px solid #c8dcff;
      padding-left: 10px;
    }

    .description-toggle {
      width: 100%;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto auto;
      align-items: center;
      gap: 8px;
      border: 0;
      border-radius: 6px;
      background: var(--blue-soft);
      padding: 7px 8px;
      color: #0747a6;
      font-size: 11px;
      font-weight: 800;
      text-align: left;
      text-transform: uppercase;
      cursor: pointer;
    }

    .description-toggle:hover {
      color: #05326f;
    }

    .description-toggle .chevron {
      color: #0747a6;
    }

    .description-state {
      border-radius: 999px;
      background: #fff;
      padding: 2px 8px;
      color: #41506a;
      font-size: 11px;
      font-weight: 750;
      text-transform: none;
    }

    .description-panel {
      display: grid;
      gap: 8px;
      max-height: min(72vh, 760px);
      overflow: auto;
      margin-top: 8px;
      border: 1px solid #dce3ef;
      border-radius: 8px;
      background: #fbfcff;
      padding: 10px 11px;
      color: #334968;
      font-size: 12px;
      font-weight: 600;
    }

    .description-panel h3,
    .description-panel h4,
    .description-panel h5 {
      margin: 6px 0 2px;
      color: #172033;
      font-size: 13px;
    }

    .description-panel p {
      margin: 0;
      overflow-wrap: anywhere;
    }

    .description-panel ul,
    .description-panel ol {
      margin: 0;
      padding-left: 18px;
    }

    .description-panel li {
      margin: 3px 0;
    }

    .description-panel blockquote,
    .description-note {
      margin: 0;
      border-left: 3px solid #b8c7dc;
      border-radius: 6px;
      background: #fff;
      padding: 8px 10px;
    }

    .description-panel pre {
      max-width: 100%;
      overflow: auto;
      margin: 0;
      border-radius: 6px;
      background: #172033;
      padding: 10px;
      color: #fff;
      font-size: 11px;
    }

    .description-panel code {
      border-radius: 4px;
      background: #eef2f7;
      padding: 1px 4px;
      color: #172033;
      font-size: 11px;
    }

    .description-panel pre code {
      background: transparent;
      padding: 0;
      color: inherit;
    }

    .description-panel a {
      color: var(--blue);
      font-weight: 750;
    }

    .description-media-group {
      display: grid;
      gap: 10px;
    }

    .description-media {
      margin: 0;
      border: 1px solid #dce3ef;
      border-radius: 8px;
      background: #fff;
      padding: 8px;
    }

    .description-media img {
      display: block;
      width: 100%;
      max-height: 560px;
      object-fit: contain;
      border-radius: 6px;
      background: #f7f9fc;
    }

    .description-media figcaption,
    .description-media-missing {
      margin-top: 6px;
      color: var(--muted);
      font-size: 11px;
      font-weight: 700;
      overflow-wrap: anywhere;
    }

    .description-table-wrap {
      max-width: 100%;
      overflow: auto;
    }

    .description-panel table {
      width: 100%;
      border-collapse: collapse;
      background: #fff;
      font-size: 11px;
    }

    .description-panel th,
    .description-panel td {
      border: 1px solid #dce3ef;
      padding: 6px;
      text-align: left;
      vertical-align: top;
    }

    .description-panel th {
      background: #eef4ff;
      color: #172033;
    }

    .description-modal[hidden] {
      display: none;
    }

    .description-modal {
      position: fixed;
      inset: 0;
      z-index: 80;
      display: grid;
      place-items: center;
      padding: 18px;
    }

    .description-backdrop {
      position: absolute;
      inset: 0;
      background: rgba(15, 23, 42, 0.48);
    }

    .description-dialog {
      position: relative;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
      width: min(1120px, 100%);
      max-height: min(900px, calc(100vh - 36px));
      overflow: hidden;
      border: 1px solid #cbd7e6;
      border-radius: 10px;
      background: #fff;
      box-shadow: 0 24px 70px rgba(23, 32, 51, 0.28);
    }

    .description-modal-header {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 12px;
      align-items: start;
      padding: 16px 18px;
      border-bottom: 1px solid var(--line);
      background: #f8fbff;
    }

    .description-modal-title {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      margin-bottom: 7px;
    }

    .description-modal-title h2 {
      margin: 0;
      color: var(--ink);
      font-size: 18px;
      line-height: 1.25;
    }

    .description-modal-summary {
      margin: 0;
      color: #334968;
      font-size: 13px;
      font-weight: 700;
      line-height: 1.4;
    }

    .description-modal-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 7px;
      margin-top: 10px;
    }

    .description-modal-meta span,
    .description-modal-meta a {
      border: 1px solid #dce3ef;
      border-radius: 999px;
      background: #fff;
      padding: 3px 8px;
      color: #41506a;
      font-size: 11px;
      font-weight: 750;
      text-decoration: none;
    }

    .description-close {
      width: 34px;
      height: 34px;
      border-radius: 8px;
      border: 1px solid #cbd7e6;
      background: #fff;
      color: #334968;
      font-size: 20px;
      line-height: 1;
      cursor: pointer;
    }

    .description-close:hover {
      border-color: #9eb1c8;
      color: var(--ink);
    }

    .description-modal-body {
      min-height: 0;
      overflow: auto;
      padding: 18px;
      background: #fff;
    }

    .description-modal-body .description-panel {
      max-height: none;
      margin: 0;
      border: 0;
      background: transparent;
      padding: 0;
      color: #26384f;
      font-size: 14px;
      line-height: 1.5;
    }

    .description-modal-body .description-panel h3,
    .description-modal-body .description-panel h4,
    .description-modal-body .description-panel h5 {
      font-size: 15px;
    }

    .description-modal-body .description-media-group {
      gap: 14px;
    }

    .description-modal-body .description-media {
      padding: 10px;
      background: #f8fafc;
    }

    .description-modal-body .description-media img {
      max-height: min(72vh, 760px);
      border-radius: 6px;
      background: #fff;
    }

    .description-empty {
      color: var(--muted);
      font-style: italic;
    }

    .assign-form {
      display: grid;
      gap: 5px;
      min-width: 0;
    }

    .assign-controls {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto auto auto;
      align-items: center;
      gap: 6px;
      min-width: 0;
    }

    .assign-select {
      min-width: 0;
      min-height: 30px;
      border: 1px solid #cdd7e7;
      border-radius: 8px;
      background: #fff;
      color: #284263;
      padding: 5px 8px;
      font-size: 11px;
      font-weight: 720;
    }

    .assign-select:focus-visible {
      border-color: var(--blue);
      outline: 2px solid rgba(12, 102, 228, .16);
    }

    .assign-submit,
    .assign-jira-link {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 28px;
      border: 1px solid #cdd7e7;
      border-radius: 8px;
      background: #fff;
      padding: 5px 9px;
      color: #284263;
      font-size: 11px;
      font-weight: 760;
      text-decoration: none;
    }

    .assign-submit {
      cursor: pointer;
    }

    .assign-submit:disabled {
      cursor: wait;
      opacity: .68;
    }

    .assign-submit:hover,
    .assign-submit:focus-visible,
    .assign-jira-link:hover,
    .assign-jira-link:focus-visible {
      border-color: var(--blue);
      color: var(--blue);
      outline: 0;
    }

    .assign-status {
      min-height: 14px;
      color: var(--muted);
      font-size: 11px;
      font-weight: 700;
    }

    .subtask-shell {
      margin-top: 12px;
      border-left: 3px solid #cde7df;
      padding-left: 10px;
    }

    .subtask-toggle {
      width: 100%;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto auto;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
      border: 0;
      border-radius: 6px;
      background: var(--teal-soft);
      padding: 7px 8px;
      color: #0f6c60;
      font-size: 11px;
      font-weight: 800;
      text-align: left;
      text-transform: uppercase;
      cursor: pointer;
    }

    .subtask-toggle:hover {
      color: #084c44;
    }

    .subtask-toggle .chevron {
      color: #0f6c60;
    }

    .subtask-list {
      display: grid;
      gap: 8px;
    }

    .subtask {
      background: #fbfffd;
      padding: 10px;
    }

    .subtask .key {
      font-size: 13px;
    }

    .subtask .summary {
      margin-bottom: 8px;
      font-size: 12px;
    }

    .subtasks-collapsed {
      margin-top: 8px;
      color: #0f6c60;
      font-size: 12px;
      font-weight: 750;
    }

    .empty {
      grid-column: 1 / -1;
      border: 1px dashed #cdd7e7;
      border-radius: 8px;
      background: #fff;
      padding: 20px;
      color: var(--muted);
      text-align: center;
      font-weight: 700;
    }

    .data-pull {
      margin: 0 clamp(18px, 2.3vw, 30px) 24px;
      border: 1px solid #dce3ef;
      border-radius: 8px;
      background: #fff;
      overflow: hidden;
    }

    .data-pull > summary {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      gap: 12px;
      padding: 13px 14px;
      background: #fbfcff;
      cursor: pointer;
      font-weight: 780;
    }

    .data-pull > summary::-webkit-details-marker {
      display: none;
    }

    .pull-meta {
      color: var(--muted);
      font-size: 12px;
      font-weight: 650;
      text-align: right;
    }

    .pull-body {
      display: grid;
      gap: 14px;
      padding: 14px;
      border-top: 1px solid var(--line);
    }

    .pull-snapshot,
    .pull-history,
    .pull-entry-body {
      display: grid;
      gap: 12px;
    }

    .pull-section-title {
      margin: 0;
      font-size: 13px;
      font-weight: 800;
    }

    .pull-history-entry {
      border: 1px solid #e1e7f0;
      border-radius: 8px;
      background: #fff;
      overflow: hidden;
    }

    .pull-history-entry > summary {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 10px 12px;
      background: #f8fbff;
      cursor: pointer;
      list-style: none;
      font-weight: 780;
    }

    .pull-history-entry > summary::-webkit-details-marker {
      display: none;
    }

    .pull-history-entry > summary::after {
      content: ">";
      color: var(--blue);
      font-weight: 900;
    }

    .pull-history-entry[open] > summary::after {
      content: "v";
    }

    .pull-entry-body {
      padding: 12px;
      border-top: 1px solid var(--line);
    }

    .pull-entry-meta {
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
    }

    .pull-stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
      gap: 10px;
    }

    .pull-stat {
      border: 1px solid #e1e7f0;
      border-radius: 8px;
      background: #fff;
      padding: 10px 12px;
    }

    .pull-stat strong {
      display: block;
      font-size: 20px;
      line-height: 1;
    }

    .pull-stat span {
      display: block;
      margin-top: 5px;
      color: var(--muted);
      font-size: 11px;
      font-weight: 750;
      text-transform: uppercase;
    }

    .pull-stat.is-no-change {
      border-color: #b9ead2;
      background: #effcf6;
    }

    .pull-stat.is-no-change strong {
      color: #057a55;
      font-size: 18px;
    }

    .pull-no-change {
      display: grid;
      gap: 3px;
      border: 1px solid #b9ead2;
      border-radius: 8px;
      background: #effcf6;
      padding: 11px 12px;
    }

    .pull-no-change strong {
      color: #057a55;
      font-size: 14px;
      font-weight: 850;
    }

    .pull-no-change span {
      color: #326152;
      font-size: 12px;
      font-weight: 700;
    }

    .pull-group {
      border-top: 1px solid var(--line);
      padding-top: 12px;
    }

    .pull-group h3 {
      margin: 0 0 8px;
      font-size: 13px;
      font-weight: 800;
    }

    .pull-list {
      display: grid;
      gap: 8px;
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .pull-item {
      border: 1px solid #e1e7f0;
      border-radius: 8px;
      background: #fff;
      padding: 10px;
    }

    .pull-item-title {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 7px;
      font-weight: 750;
    }

    .change-list {
      display: grid;
      gap: 5px;
      margin-top: 8px;
      color: var(--muted);
      font-size: 12px;
    }

    .change-list b {
      color: #334968;
    }

    .parent-context {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
      margin-top: 8px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 650;
    }

    .parent-context b {
      color: #334968;
    }

    .parent-context a {
      color: var(--blue);
      font-weight: 780;
      text-decoration: none;
    }

    .parent-context a:hover {
      text-decoration: underline;
    }

    .no-changes {
      color: var(--muted);
      font-weight: 700;
    }

    .footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 18px;
      padding: 14px clamp(18px, 2.3vw, 30px) 18px;
      border-top: 1px solid var(--line);
      color: var(--muted);
      font-size: 12px;
    }

    .footer a {
      color: var(--blue);
      font-weight: 700;
      text-decoration: none;
      white-space: nowrap;
    }

    .footer-links {
      display: inline-flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: flex-end;
      gap: 10px 16px;
    }

    .bridge-status {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-height: 30px;
      border: 1px solid #d6deea;
      border-radius: 999px;
      background: #fff;
      padding: 5px 10px;
      color: #41506a;
      white-space: nowrap;
    }

    .bridge-dot {
      width: 10px;
      height: 10px;
      flex: 0 0 10px;
      border-radius: 999px;
      background: #f59e0b;
      box-shadow: 0 0 0 4px rgba(245, 158, 11, .16);
    }

    .bridge-status b {
      color: #334968;
      font-weight: 800;
    }

    .bridge-status small {
      margin-left: 6px;
      color: var(--muted);
      font-size: 11px;
      font-weight: 700;
    }

    .bridge-status.online {
      border-color: #b9ead2;
      background: #effcf6;
    }

    .bridge-status.online .bridge-dot {
      background: #12b76a;
      box-shadow: 0 0 0 4px rgba(18, 183, 106, .16);
    }

    .bridge-status.offline {
      border-color: #ffd5d2;
      background: #fff3f1;
    }

    .bridge-status.offline .bridge-dot {
      background: #ef4444;
      box-shadow: 0 0 0 4px rgba(239, 68, 68, .14);
    }

    @media (max-width: 760px) {
      header,
      .toolbar,
      .panel-title,
      .footer {
        flex-direction: column;
        align-items: stretch;
      }

      .stamp,
      .panel-note {
        text-align: left;
      }

      .toolbar-group {
        width: 100%;
      }

      .control-button {
        flex: 1 1 150px;
      }

      .meta {
        grid-template-columns: 1fr;
      }

      .assign-controls {
        grid-template-columns: 1fr;
      }

      .data-pull > summary {
        grid-template-columns: 1fr;
      }

      .pull-meta {
        text-align: left;
      }

      .footer-links {
        justify-content: flex-start;
      }

      .bridge-status {
        width: 100%;
        justify-content: flex-start;
        white-space: normal;
      }

      .description-modal {
        padding: 10px;
      }

      .description-dialog {
        max-height: calc(100vh - 20px);
      }

      .description-modal-header {
        padding: 12px;
      }

      .description-modal-body {
        padding: 12px;
      }
    }
  </style>
</head>
<body>
  <main class="page">
    <section class="shell">
      <header>
        <div>
          <h1>GolfNow CORE Jira Board</h1>
          <div class="subtitle">Latest Jira snapshot for fixVersion ${escapeHtml(version)}, grouped by workflow status and ordered by most recent Jira update.</div>
        </div>
        <div class="stamp">
          <strong>Pulled from Jira</strong>
          <span id="pulled-at"></span> ET
          <span class="stamp-next">Next Refresh on: <span id="next-refresh-at"></span> ET</span>
          <span class="stamp-domain">${escapeHtml(siteUrl.replace("https://", ""))}</span>
        </div>
      </header>

      <section class="toolbar" aria-label="Board controls">
        <div class="toolbar-group">
          <button class="control-button" id="toggle-subtasks" type="button" aria-pressed="false">Expand all subtasks</button>
          <button class="control-button" id="expand-all" type="button">Expand all sections</button>
          <button class="control-button" id="collapse-all" type="button">Collapse all sections</button>
        </div>
        <div class="filter-state" id="filter-state">Showing all components</div>
      </section>

      <section class="metrics" id="metrics" aria-label="Board metrics"></section>

      <section class="components-panel priority-panel" aria-label="Priority summary">
        <div class="panel-title">
          <div class="title-row">
            <h2>Priority</h2>
          </div>
          <div class="panel-note">Counts include main tickets and subtasks.</div>
        </div>
        <div class="priority-summary" id="priority-summary"></div>
      </section>

      <section class="components-panel" aria-label="Components">
        <div class="panel-title">
          <div class="title-row">
            <h2>Components</h2>
            <button class="copy-button" id="copy-components" type="button" aria-label="Copy component list" title="Copy component list"></button>
          </div>
          <div class="panel-note">Auto-built from the current Jira ticket components.</div>
        </div>
        <div class="chips" id="component-chips"></div>
      </section>

      <section class="components-panel qa-panel" aria-label="QA filters">
        <div class="panel-title">
          <div class="title-row">
            <h2>QA</h2>
          </div>
          <div class="panel-note">Filter tickets by current assignee.</div>
        </div>
        <div class="chips" id="qa-chips"></div>
      </section>

      <section class="board" id="board" aria-label="Jira tickets by status"></section>

      <details class="data-pull" id="data-pull">
        <summary>
          <span>Data Pull</span>
          <span class="pull-meta" id="pull-meta"></span>
        </summary>
        <div class="pull-body" id="pull-body"></div>
      </details>

      <div class="footer">
        <span id="source-line"></span>
        <span class="footer-links">
          <span class="bridge-status" id="bridge-status" role="status" aria-live="polite">
            <span class="bridge-dot" aria-hidden="true"></span>
            <span><b>Assignee Bridge Status</b><small id="bridge-status-text">Checking</small></span>
          </span>
          <a href="${escapeHtml(readmeUrl)}">Dashboard ${escapeHtml(dashboardVersion)} notes</a>
          <a href="${escapeHtml(jiraFilterUrl)}">Open Jira filter</a>
        </span>
      </div>
    </section>
  </main>

  <div class="description-modal" id="description-modal" hidden>
    <div class="description-backdrop" data-description-close></div>
    <section class="description-dialog" role="dialog" aria-modal="true" aria-labelledby="description-modal-title">
      <header class="description-modal-header">
        <div>
          <div class="description-modal-title" id="description-modal-title"></div>
          <p class="description-modal-summary" id="description-modal-summary"></p>
          <div class="description-modal-meta" id="description-modal-meta"></div>
        </div>
        <button class="description-close" type="button" data-description-close aria-label="Close description">x</button>
      </header>
      <div class="description-modal-body">
        <div class="description-panel" id="description-modal-content"></div>
      </div>
    </section>
  </div>

  <script id="jira-data" type="application/json">${dataJson}</script>
  <script>
    (function () {
      "use strict";

      var data = JSON.parse(document.getElementById("jira-data").textContent);
      var state = {
        activeComponent: "all",
        activeQa: "all",
        collapsedStatuses: new Set(),
        expandedSubtasks: new Set(),
        activeDescriptionKey: null
      };
      var githubRepo = data.repositorySlug || "DewanKabir009/jira-board-v3001-123-0";
      var dashboardUrl = data.dashboardUrl || "https://dewankabir009.github.io/jira-board-v3001-123-0/";
      var assigneeDispatchEndpoint = data.assigneeDispatchEndpoint || "http://127.0.0.1:3992/assign";
      var assigneeNames = data.assigneeOptions || [
        "Dewan Kabir",
        "Nicole Greer",
        "Alex Mcnay",
        "Anton Yurkevich"
      ];
      var qaNames = assigneeNames;
      var statusOrder = [
        "Blocked",
        "Analysis",
        "Pre Planning",
        "Code Review",
        "Pending Deployment (DEV)",
        "Pending Deployment (STG)",
        "Pending Deployment (PROD)",
        "QA Testing (DEV)",
        "QA Testing (STG)",
        "Closed"
      ];
      var priorityOrder = ["P0", "P1", "P2", "P3", "None"];
      var priorityLabels = {
        None: "No Priority"
      };

      function text(value) {
        return String(value == null ? "" : value);
      }

      function escape(value) {
        return text(value)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;");
      }

      function priorityKey(priority) {
        var value = text(priority).trim();
        if (!value || value.toLowerCase() === "none" || value.toLowerCase() === "no priority") {
          return "None";
        }
        var normalized = value.toUpperCase();
        return priorityOrder.indexOf(normalized) === -1 ? value : normalized;
      }

      function priorityLabel(priority) {
        var key = priorityKey(priority);
        return priorityLabels[key] || key;
      }

      function priorityClass(priority) {
        return "p-" + priorityKey(priority).toLowerCase().replace(/[^a-z0-9]+/g, "-");
      }

      function copyIcon() {
        return "<svg viewBox=\\"0 0 24 24\\" aria-hidden=\\"true\\"><rect x=\\"9\\" y=\\"9\\" width=\\"13\\" height=\\"13\\" rx=\\"2\\" ry=\\"2\\"></rect><path d=\\"M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1\\"></path></svg>";
      }

      function renderKeyLink(issue) {
        return "<span class=\\"key-row\\">" +
          "<a class=\\"key\\" href=\\"" + escape(issue.url) + "\\">" + escape(issue.key) + "</a>" +
          "<button class=\\"copy-button\\" type=\\"button\\" data-copy-link=\\"" + escape(issue.url) + "\\" aria-label=\\"Copy " + escape(issue.key) + " link\\" title=\\"Copy " + escape(issue.key) + " link\\">" + copyIcon() + "</button>" +
        "</span>";
      }

      function optionSelected(left, right) {
        return text(left).toLowerCase() === text(right).toLowerCase() ? " selected" : "";
      }

      function getActionsWorkflowUrl() {
        return "https://github.com/" + encodeURIComponent(githubRepo).replace("%2F", "/") +
          "/actions/workflows/update-jira-assignee.yml";
      }

      function getAssigneeStatusEndpoint() {
        return assigneeDispatchEndpoint.replace(/\\/assign$/, "/status");
      }

      function formatEasternTimestamp(date) {
        return new Intl.DateTimeFormat("en-US", {
          timeZone: "America/New_York",
          month: "short",
          day: "numeric",
          year: "numeric",
          hour: "numeric",
          minute: "2-digit"
        }).format(date);
      }

      function getNextRefreshDate() {
        var now = new Date();
        var next = new Date(now.getTime());
        next.setSeconds(0, 0);
        if (next <= now) {
          next.setMinutes(next.getMinutes() + 1);
        }

        var remainder = next.getMinutes() % 5;
        if (remainder !== 0) {
          next.setMinutes(next.getMinutes() + (5 - remainder));
        }

        return next;
      }

      function renderNextRefresh() {
        var target = document.getElementById("next-refresh-at");
        if (target) {
          target.textContent = formatEasternTimestamp(getNextRefreshDate());
        }
      }

      function cacheBustedUrl(paramName) {
        var url = new URL(window.location.href);
        url.searchParams.set(paramName, String(Date.now()));
        return url.toString();
      }

      function readPulledAtFromHtml(html) {
        var start = '<script id="jira-data" type="application/json">';
        var end = "<\\/script>";
        var startIndex = html.indexOf(start);
        if (startIndex === -1) {
          return "";
        }

        var endIndex = html.indexOf(end, startIndex);
        if (endIndex === -1) {
          return "";
        }

        try {
          return JSON.parse(html.slice(startIndex + start.length, endIndex)).pulledAt || "";
        } catch (error) {
          return "";
        }
      }

      function checkForFreshDeployment() {
        if (!/^https?:$/.test(window.location.protocol) || !window.fetch || !data.pulledAt) {
          return;
        }

        fetch(cacheBustedUrl("freshnessCheck"), { cache: "no-store" })
          .then(function (response) {
            if (!response.ok) {
              throw new Error("Freshness check failed.");
            }
            return response.text();
          })
          .then(function (html) {
            var latestPulledAt = readPulledAtFromHtml(html);
            var currentTime = Date.parse(data.pulledAt || "");
            var latestTime = Date.parse(latestPulledAt || "");
            if (!Number.isNaN(currentTime) && !Number.isNaN(latestTime) && latestTime > currentTime) {
              window.location.replace(cacheBustedUrl("fresh"));
            }
          })
          .catch(function () {
            // Keep the dashboard usable even if GitHub Pages is briefly slow.
          });
      }

      function setBridgeStatus(mode, message) {
        var badge = document.getElementById("bridge-status");
        var textNode = document.getElementById("bridge-status-text");
        if (!badge || !textNode) {
          return;
        }

        badge.classList.remove("online", "offline");
        if (mode) {
          badge.classList.add(mode);
        }
        textNode.textContent = message;
        badge.title = "Assignee Bridge Status: " + message;
      }

      function checkBridgeStatus() {
        setBridgeStatus("", "Checking");
        fetch(getAssigneeStatusEndpoint(), { method: "GET", cache: "no-store" })
          .then(function (response) {
            return response.json().catch(function () {
              return { ok: false, message: "Unreadable bridge response." };
            }).then(function (payload) {
              if (!response.ok || !payload.ok) {
                throw new Error(payload.message || payload.error || "Bridge is not ready.");
              }
              return payload;
            });
          })
          .then(function () {
            setBridgeStatus("online", "Ready");
          })
          .catch(function () {
            setBridgeStatus("offline", "Offline");
          });
      }

      function fallbackCopyText(value) {
        var textarea = document.createElement("textarea");
        textarea.value = value;
        textarea.setAttribute("readonly", "");
        textarea.style.position = "fixed";
        textarea.style.left = "-9999px";
        textarea.style.top = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
      }

      function copyText(value) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          return navigator.clipboard.writeText(value).catch(function () {
            fallbackCopyText(value);
          });
        }

        fallbackCopyText(value);
        return Promise.resolve();
      }

      function markCopied(button) {
        button.classList.add("copied");
        window.setTimeout(function () {
          button.classList.remove("copied");
        }, 1200);
      }

      function issueComponents(issue) {
        return Array.isArray(issue.components) ? issue.components : [];
      }

      function hasComponent(issue, component) {
        if (component === "all") {
          return true;
        }

        return issueComponents(issue).indexOf(component) !== -1;
      }

      function hasQa(issue, qaName) {
        return qaName === "all" || issue.assignee === qaName;
      }

      function issueMatchesFilters(issue) {
        return hasComponent(issue, state.activeComponent) && hasQa(issue, state.activeQa);
      }

      function sortByUpdatedDesc(left, right) {
        return new Date(right.updated || 0) - new Date(left.updated || 0);
      }

      function getPriorityRank(priority) {
        var index = priorityOrder.indexOf(priorityKey(priority));
        return index === -1 ? priorityOrder.length : index;
      }

      function sortCardsByPriority(left, right) {
        return getPriorityRank(left.issue.priority) - getPriorityRank(right.issue.priority) ||
          sortByUpdatedDesc(left.issue, right.issue);
      }

      function getStatusRank(status) {
        var index = statusOrder.indexOf(status);
        return index === -1 ? statusOrder.length : index;
      }

      function getComponentCounts() {
        var counts = new Map();

        data.issues.forEach(function (issue) {
          issueComponents(issue).forEach(function (component) {
            counts.set(component, (counts.get(component) || 0) + 1);
          });
        });

        return Array.from(counts.entries()).sort(function (left, right) {
          return right[1] - left[1] || left[0].localeCompare(right[0]);
        });
      }

      function getQaCounts() {
        return qaNames.map(function (qaName) {
          var count = data.issues.filter(function (issue) {
            return issue.assignee === qaName;
          }).length;
          return [qaName, count];
        });
      }

      function getPriorityCounts() {
        return priorityOrder.map(function (priority) {
          var issues = data.issues.filter(function (issue) {
            return priorityKey(issue.priority) === priority;
          });
          var subtasks = issues.filter(function (issue) {
            return issue.isSubtask;
          }).length;

          return {
            priority: priority,
            label: priorityLabel(priority),
            total: issues.length,
            main: issues.length - subtasks,
            subtasks: subtasks
          };
        });
      }

      function getIssueModel() {
        var issueByKey = new Map();
        var subtasksByParent = new Map();
        var primaryIssues = [];
        var orphanSubtasks = [];

        data.issues.forEach(function (issue) {
          issueByKey.set(issue.key, issue);
        });

        data.issues.forEach(function (issue) {
          if (!issue.isSubtask) {
            primaryIssues.push(issue);
            return;
          }

          if (issue.parent && issueByKey.has(issue.parent.key)) {
            if (!subtasksByParent.has(issue.parent.key)) {
              subtasksByParent.set(issue.parent.key, []);
            }
            subtasksByParent.get(issue.parent.key).push(issue);
          } else {
            orphanSubtasks.push(issue);
          }
        });

        subtasksByParent.forEach(function (items) {
          items.sort(sortByUpdatedDesc);
        });

        var cards = primaryIssues.map(function (issue) {
          return {
            issue: issue,
            subtasks: subtasksByParent.get(issue.key) || [],
            isParentStub: false
          };
        });

        var orphanGroups = new Map();
        orphanSubtasks.forEach(function (issue) {
          var parentKey = issue.parent ? issue.parent.key : "No parent";
          var groupKey = parentKey + "|" + issue.status;

          if (!orphanGroups.has(groupKey)) {
            orphanGroups.set(groupKey, {
              issue: {
                key: parentKey,
                url: issue.parent ? issue.parent.url : data.jiraFilterUrl,
                summary: issue.parent && issue.parent.summary ? issue.parent.summary : "Subtasks without a parent in this release",
                type: issue.parent && issue.parent.type ? issue.parent.type : "Parent",
                status: issue.status,
                priority: issue.parent && issue.parent.priority ? issue.parent.priority : "None",
                assignee: "Parent outside this release",
                updated: issue.updated,
                updatedDisplay: issue.updatedDisplay,
                components: [],
                description: issue.parent && issue.parent.description ? issue.parent.description : "",
                descriptionHtml: "",
                descriptionImageCount: 0,
                isSubtask: false
              },
              subtasks: [],
              isParentStub: true
            });
          }

          orphanGroups.get(groupKey).subtasks.push(issue);
        });

        orphanGroups.forEach(function (card) {
          card.subtasks.sort(sortByUpdatedDesc);
          cards.push(card);
        });

        cards.sort(function (left, right) {
          var rank = getStatusRank(left.issue.status) - getStatusRank(right.issue.status);
          return rank || sortCardsByPriority(left, right);
        });

        return cards;
      }

      function cardMatchesFilters(card) {
        return issueMatchesFilters(card.issue) ||
          card.subtasks.some(function (subtask) {
            return issueMatchesFilters(subtask);
          });
      }

      function visibleSubtasksForCard(card) {
        return card.subtasks.filter(issueMatchesFilters);
      }

      function getVisibleSubtaskCards() {
        return getIssueModel().filter(cardMatchesFilters).filter(function (card) {
          return card.subtasks.some(function (subtask) {
            return issueMatchesFilters(subtask);
          });
        });
      }

      function buildMetrics(cards) {
        var visibleIssues = [];
        cards.forEach(function (card) {
          visibleIssues.push(card.issue);
          card.subtasks.forEach(function (subtask) {
            visibleIssues.push(subtask);
          });
        });

        var subtaskCount = data.issues.filter(function (issue) { return issue.isSubtask; }).length;
        var mainCount = data.issues.filter(function (issue) { return !issue.isSubtask; }).length;
        function statusSplit(status) {
          var matching = data.issues.filter(function (issue) { return issue.status === status; });
          var subtasks = matching.filter(function (issue) { return issue.isSubtask; }).length;
          return {
            total: matching.length,
            main: matching.length - subtasks,
            subtasks: subtasks
          };
        }
        function splitDetail(split) {
          return split.main + " main / " + split.subtasks + " subtasks";
        }
        var qaSplit = statusSplit("QA Testing (DEV)");
        var pendingDevSplit = statusSplit("Pending Deployment (DEV)");
        var highPriorityCount = data.issues.filter(function (issue) {
          var priority = priorityKey(issue.priority);
          return priority === "P0" || priority === "P1";
        }).length;

        var metrics = [
          { value: data.total, label: "Tracked tickets", detail: mainCount + " main / " + subtaskCount + " subtasks" },
          { value: qaSplit.total, label: "QA Testing (DEV)", detail: splitDetail(qaSplit) },
          { value: pendingDevSplit.total, label: "Pending Deployment (DEV)", detail: splitDetail(pendingDevSplit) },
          { value: highPriorityCount, label: "P0/P1 priority items" },
          { value: subtaskCount, label: "Subtasks linked" }
        ];

        document.getElementById("metrics").innerHTML = metrics.map(function (metric) {
          return "<div class=\\"metric\\"><div class=\\"value\\">" + escape(metric.value) + "</div><div class=\\"label\\">" + escape(metric.label) + "</div>" + (metric.detail ? "<div class=\\"metric-detail\\">" + escape(metric.detail) + "</div>" : "") + "</div>";
        }).join("");
      }

      function renderPrioritySummary() {
        document.getElementById("priority-summary").innerHTML = getPriorityCounts().map(function (entry) {
          return "<div class=\\"priority-card\\">" +
            "<div class=\\"priority-card-top\\">" +
              "<span class=\\"priority " + escape(priorityClass(entry.priority)) + "\\">" + escape(entry.label) + "</span>" +
              "<span class=\\"priority-total\\">" + escape(entry.total) + "</span>" +
            "</div>" +
            "<div class=\\"priority-card-detail\\">" + escape(entry.main + " main / " + entry.subtasks + " subtasks") + "</div>" +
          "</div>";
        }).join("");
      }

      function renderComponentChips() {
        var chips = [
          "<button class=\\"chip " + (state.activeComponent === "all" ? "active" : "") + "\\" type=\\"button\\" data-component=\\"all\\"><span class=\\"chip-name\\">All components</span><span class=\\"chip-count\\">" + data.total + "</span></button>"
        ];

        getComponentCounts().forEach(function (entry) {
          var component = entry[0];
          var count = entry[1];
          chips.push(
            "<button class=\\"chip " + (state.activeComponent === component ? "active" : "") + "\\" type=\\"button\\" data-component=\\"" + escape(component) + "\\">" +
              "<span class=\\"chip-name\\">" + escape(component) + "</span>" +
              "<span class=\\"chip-count\\">" + escape(count) + "</span>" +
            "</button>"
          );
        });

        document.getElementById("component-chips").innerHTML = chips.join("");
      }

      function renderQaChips() {
        var chips = [
          "<button class=\\"chip " + (state.activeQa === "all" ? "active" : "") + "\\" type=\\"button\\" data-qa=\\"all\\"><span class=\\"chip-name\\">All QAs</span><span class=\\"chip-count\\">" + data.total + "</span></button>"
        ];

        getQaCounts().forEach(function (entry) {
          var qaName = entry[0];
          var count = entry[1];
          chips.push(
            "<button class=\\"chip " + (state.activeQa === qaName ? "active" : "") + "\\" type=\\"button\\" data-qa=\\"" + escape(qaName) + "\\">" +
              "<span class=\\"chip-name\\">" + escape(qaName) + "</span>" +
              "<span class=\\"chip-count\\">" + escape(count) + "</span>" +
            "</button>"
          );
        });

        document.getElementById("qa-chips").innerHTML = chips.join("");
      }

      function renderComponents(components) {
        if (!components || !components.length) {
          return "<span class=\\"component-pill\\">None</span>";
        }

        return components.map(function (component) {
          return "<span class=\\"component-pill\\">" + escape(component) + "</span>";
        }).join("");
      }

      function renderDescriptionText(value) {
        var description = text(value).trim();
        if (!description) {
          return "<p class=\\"description-empty\\">No description provided.</p>";
        }

        return description.split(/\\n{2,}/).map(function (paragraph) {
          return "<p>" + paragraph.split(/\\n/).map(escape).join("<br>") + "</p>";
        }).join("");
      }

      function hasDescription(issue) {
        return text(issue.description).trim().length > 0 ||
          text(issue.descriptionHtml).trim().length > 0 ||
          Number(issue.descriptionImageCount || 0) > 0;
      }

      function renderDescriptionContent(issue) {
        if (text(issue.descriptionHtml).trim()) {
          return issue.descriptionHtml;
        }

        return renderDescriptionText(issue.description);
      }

      function renderDescription(issue) {
        var hasIssueDescription = hasDescription(issue);
        var imageCount = Number(issue.descriptionImageCount || 0);
        var stateLabel = !hasIssueDescription
          ? "Empty"
          : (imageCount ? imageCount + " image" + (imageCount === 1 ? "" : "s") : "View");

        return "<div class=\\"description-shell" + (hasIssueDescription ? "" : " is-empty") + "\\">" +
          "<button class=\\"description-toggle\\" type=\\"button\\" aria-haspopup=\\"dialog\\" data-description-for=\\"" + escape(issue.key) + "\\">" +
            "<span>Description</span>" +
            "<span class=\\"description-state\\">" + escape(stateLabel) + "</span>" +
            "<span class=\\"chevron\\">></span>" +
          "</button>" +
        "</div>";
      }

      function findDescriptionIssue(issueKey) {
        var cards = getIssueModel();
        for (var index = 0; index < cards.length; index += 1) {
          if (cards[index].issue.key === issueKey) {
            return cards[index].issue;
          }

          var subtask = cards[index].subtasks.find(function (item) {
            return item.key === issueKey;
          });
          if (subtask) {
            return subtask;
          }
        }

        return data.issues.find(function (issue) {
          return issue.key === issueKey;
        });
      }

      function openDescriptionModal(issueKey) {
        var issue = findDescriptionIssue(issueKey);
        if (!issue) {
          return;
        }

        state.activeDescriptionKey = issue.key;
        document.getElementById("description-modal-title").innerHTML =
          renderKeyLink(issue) + "<h2>Description</h2>";
        document.getElementById("description-modal-summary").textContent = issue.summary || "";
        document.getElementById("description-modal-meta").innerHTML =
          "<span>" + escape(issue.type || "Ticket") + "</span>" +
          "<span>Status: " + escape(issue.status || "No status") + "</span>" +
          "<span>Priority: " + escape(priorityLabel(issue.priority)) + "</span>" +
          "<span>Updated: " + escape(issue.updatedDisplay || "Unknown") + "</span>" +
          "<span>Images: " + escape(Number(issue.descriptionImageCount || 0)) + "</span>" +
          "<a href=\\"" + escape(issue.url) + "\\" target=\\"_blank\\" rel=\\"noopener\\">Open Jira</a>";
        document.getElementById("description-modal-content").innerHTML = renderDescriptionContent(issue);
        document.getElementById("description-modal").hidden = false;
        document.body.classList.add("modal-open");
        var closeButton = document.querySelector("[data-description-close].description-close");
        if (closeButton) {
          closeButton.focus();
        }
      }

      function closeDescriptionModal() {
        state.activeDescriptionKey = null;
        document.getElementById("description-modal").hidden = true;
        document.getElementById("description-modal-content").innerHTML = "";
        document.body.classList.remove("modal-open");
      }

      function renderMeta(issue, includeStatus) {
        var status = includeStatus ? "<div><b>Status</b>" + escape(issue.status) + "</div>" : "";
        return "<div class=\\"meta\\">" +
          "<div><b>Assignee</b>" + escape(issue.assignee) + "</div>" +
          "<div><b>Priority</b><span class=\\"priority " + escape(priorityClass(issue.priority)) + "\\">" + escape(issue.priority) + "</span></div>" +
          status +
          "<div><b>Updated</b>" + escape(issue.updatedDisplay) + "</div>" +
          "<div><b>Components</b><div class=\\"components-list\\">" + renderComponents(issueComponents(issue)) + "</div></div>" +
        "</div>";
      }

      function renderIssueActions(issue) {
        var selectId = "assign-" + escape(issue.key);
        var actionsUrl = getActionsWorkflowUrl();
        var options = [
          "<option value=\\"\\">Assignee</option>"
        ].concat(assigneeNames.map(function (name) {
          return "<option value=\\"" + escape(name) + "\\"" + optionSelected(name, issue.assignee) + ">" + escape(name) + "</option>";
        })).join("");

        return "<div class=\\"ticket-actions\\">" +
          "<form class=\\"assign-form\\" data-assign-form data-issue-key=\\"" + escape(issue.key) + "\\" data-issue-summary=\\"" + escape(issue.summary) + "\\" data-current-assignee=\\"" + escape(issue.assignee) + "\\">" +
            "<label class=\\"sr-only\\" for=\\"" + selectId + "\\">Assignee for " + escape(issue.key) + "</label>" +
            "<div class=\\"assign-controls\\">" +
              "<select class=\\"assign-select\\" id=\\"" + selectId + "\\" name=\\"assignee\\" aria-label=\\"Assignee for " + escape(issue.key) + "\\">" + options + "</select>" +
              "<button class=\\"assign-submit\\" type=\\"submit\\">Submit</button>" +
              "<a class=\\"assign-jira-link\\" href=\\"" + escape(actionsUrl) + "\\" target=\\"_blank\\" rel=\\"noopener\\">Actions</a>" +
              "<a class=\\"assign-jira-link\\" href=\\"" + escape(issue.url) + "\\" target=\\"_blank\\" rel=\\"noopener\\">Jira</a>" +
            "</div>" +
            "<span class=\\"assign-status\\" role=\\"status\\"></span>" +
          "</form>" +
        "</div>";
      }

      function renderSubtask(subtask) {
        return "<article class=\\"subtask\\">" +
          "<div class=\\"topline\\">" +
            renderKeyLink(subtask) +
            "<span class=\\"type\\">" + escape(subtask.type) + "</span>" +
          "</div>" +
          "<p class=\\"summary\\">" + escape(subtask.summary) + "</p>" +
          renderDescription(subtask) +
          renderMeta(subtask, true) +
          renderIssueActions(subtask) +
        "</article>";
      }

      function renderCard(card) {
        var issue = card.issue;
        var visibleSubtasks = visibleSubtasksForCard(card);
        var className = "ticket" + (card.isParentStub ? " parent-stub" : "");
        var subtaskBlock = "";

        if (visibleSubtasks.length) {
          var expanded = state.expandedSubtasks.has(issue.key);
          subtaskBlock =
            "<div class=\\"subtask-shell\\">" +
              "<button class=\\"subtask-toggle\\" type=\\"button\\" aria-expanded=\\"" + expanded + "\\" data-subtasks-for=\\"" + escape(issue.key) + "\\">" +
                "<span>Subtasks</span>" +
                "<span class=\\"count\\">" + visibleSubtasks.length + "</span>" +
                "<span class=\\"chevron\\">" + (expanded ? "v" : ">") + "</span>" +
              "</button>" +
              (expanded
                ? "<div class=\\"subtask-list\\">" + visibleSubtasks.map(renderSubtask).join("") + "</div>"
                : "<div class=\\"subtasks-collapsed\\">Main ticket only. Expand to review linked subtasks.</div>") +
            "</div>";
        }

        return "<article class=\\"" + className + "\\">" +
          "<div class=\\"topline\\">" +
            renderKeyLink(issue) +
            "<span class=\\"type\\">" + escape(issue.type) + "</span>" +
          "</div>" +
          "<p class=\\"summary\\">" + escape(issue.summary) + "</p>" +
          renderDescription(issue) +
          renderMeta(issue, false) +
          renderIssueActions(issue) +
          subtaskBlock +
        "</article>";
      }

      function groupCards(cards) {
        var groups = new Map();

        cards.forEach(function (card) {
          var status = card.issue.status || "No status";
          if (!groups.has(status)) {
            groups.set(status, []);
          }
          groups.get(status).push(card);
        });

        groups.forEach(function (statusCards) {
          statusCards.sort(sortCardsByPriority);
        });

        return Array.from(groups.entries()).sort(function (left, right) {
          return getStatusRank(left[0]) - getStatusRank(right[0]) || left[0].localeCompare(right[0]);
        });
      }

      function getBoardColumnCount(board) {
        var width = board.clientWidth || window.innerWidth;
        if (width < 760) {
          return 1;
        }
        if (width < 1120) {
          return 2;
        }
        return 3;
      }

      function estimateCardWeight(card) {
        var weight = 2.8;
        var summaryLength = text(card.issue.summary).length;
        weight += Math.min(1.3, summaryLength / 90);
        weight += issueComponents(card.issue).length * 0.25;

        if (card.subtasks.length) {
          weight += 0.9;
          if (state.expandedSubtasks.has(card.issue.key)) {
            weight += card.subtasks.reduce(function (total, subtask) {
              return total + 1.8 + Math.min(1.1, text(subtask.summary).length / 100) + issueComponents(subtask).length * 0.18;
            }, 0);
          }
        }

        return weight;
      }

      function estimateSectionWeight(status, statusCards) {
        if (state.collapsedStatuses.has(status)) {
          return 1.2;
        }

        return 1.4 + statusCards.reduce(function (total, card) {
          return total + estimateCardWeight(card);
        }, 0);
      }

      function renderSection(status, statusCards) {
        var issueCount = statusCards.reduce(function (total, card) {
          return total + 1 + visibleSubtasksForCard(card).length;
        }, 0);
        var collapsed = state.collapsedStatuses.has(status);

        return "<section class=\\"section " + (collapsed ? "collapsed" : "") + "\\" data-status=\\"" + escape(status) + "\\">" +
          "<button class=\\"section-toggle\\" type=\\"button\\" aria-expanded=\\"" + (!collapsed) + "\\" data-status=\\"" + escape(status) + "\\">" +
            "<span class=\\"title\\">" + escape(status) + "</span>" +
            "<span class=\\"count\\">" + issueCount + "</span>" +
            "<span class=\\"chevron\\">v</span>" +
          "</button>" +
          "<div class=\\"cards\\">" + statusCards.map(renderCard).join("") + "</div>" +
        "</section>";
      }

      function renderBoard() {
        var cards = getIssueModel().filter(cardMatchesFilters);
        var board = document.getElementById("board");
        var groups = groupCards(cards);

        buildMetrics(cards);
        renderPrioritySummary();
        renderComponentChips();
        renderQaChips();

        if (!groups.length) {
          board.innerHTML = "<div class=\\"empty\\">No tickets match the selected filters.</div>";
          return;
        }

        var columns = Array.from({ length: getBoardColumnCount(board) }, function () {
          return { weight: 0, sections: [] };
        });

        groups.forEach(function (entry) {
          var status = entry[0];
          var statusCards = entry[1];
          var target = columns.reduce(function (best, column) {
            return column.weight < best.weight ? column : best;
          }, columns[0]);

          target.sections.push(renderSection(status, statusCards));
          target.weight += estimateSectionWeight(status, statusCards);
        });

        board.innerHTML = columns.map(function (column) {
          return "<div class=\\"board-column\\">" + column.sections.join("") + "</div>";
        }).join("");
      }

      function renderFilterState() {
        var filters = [];
        if (state.activeComponent !== "all") {
          filters.push("Component: " + state.activeComponent);
        }
        if (state.activeQa !== "all") {
          filters.push("QA: " + state.activeQa);
        }

        document.getElementById("filter-state").textContent = filters.length
          ? "Filtered by " + filters.join(" / ")
          : "Showing all tickets";
      }

      function renderParentContext(issue) {
        if (!issue.isSubtask || !issue.parent) {
          return "";
        }

        return "<div class=\\"parent-context\\">" +
          "<b>Parent:</b>" +
          "<a href=\\"" + escape(issue.parent.url) + "\\">" + escape(issue.parent.key) + "</a>" +
          "<span>" + escape(issue.parent.summary || "") + "</span>" +
        "</div>";
      }

      function renderPullIssue(issue) {
        return "<span class=\\"pull-item-title\\">" +
          renderKeyLink(issue) +
          "<span>" + escape(issue.summary || "") + "</span>" +
        "</span>" +
        renderParentContext(issue);
      }

      function renderChange(change) {
        return "<div><b>" + escape(change.label) + ":</b> " +
          "<span>" + escape(change.before) + "</span> -> " +
          "<span>" + escape(change.after) + "</span></div>";
      }

      function renderPullGroup(title, items, renderer) {
        if (!items.length) {
          return "";
        }

        return "<section class=\\"pull-group\\">" +
          "<h3>" + escape(title) + "</h3>" +
          "<ul class=\\"pull-list\\">" + items.map(function (item) {
            return "<li class=\\"pull-item\\">" + renderer(item) + "</li>";
          }).join("") + "</ul>" +
        "</section>";
      }

      function getDiffLists(diff) {
        return {
          added: diff.added || [],
          removed: diff.removed || [],
          updated: diff.updated || [],
          statusChanges: diff.statusChanges || []
        };
      }

      function pullHasChanges(diff) {
        var lists = getDiffLists(diff || {});
        return lists.added.length || lists.removed.length || lists.updated.length || lists.statusChanges.length;
      }

      function plural(count, singular, pluralText) {
        return count === 1 ? singular : (pluralText || singular + "s");
      }

      function renderPullStats(diff) {
        var lists = getDiffLists(diff || {});
        var stats = [
          { value: lists.added.length, label: "Added" },
          { value: lists.updated.length, label: "Updated" },
          { value: lists.statusChanges.length, label: "Status moves" },
          { value: lists.removed.length, label: "Removed" }
        ];

        if (!diff.isBaseline && !pullHasChanges(diff)) {
          stats.unshift({ value: "No Change", label: "Since previous pull", className: " is-no-change" });
        }

        return stats.map(function (stat) {
          return "<div class=\\"pull-stat" + (stat.className || "") + "\\"><strong>" + escape(stat.value) + "</strong><span>" + escape(stat.label) + "</span></div>";
        }).join("");
      }

      function renderPullTiming(diff) {
        var previous = diff.previousPulledAtDisplay || "No previous pull";
        var current = diff.currentPulledAtDisplay || data.pulledAtDisplay;

        return "<div class=\\"change-list\\">" +
          "<div><b>Previous pull:</b> " + escape(previous) + "</div>" +
          "<div><b>Most recent pull:</b> " + escape(current) + " ET</div>" +
        "</div>";
      }

      function renderDiffDetails(diff) {
        var lists = getDiffLists(diff || {});
        var hasChanges = pullHasChanges(diff);
        var baselineNote = diff.isBaseline
          ? "<div class=\\"no-changes\\">Baseline pull captured. Future pulls will compare against this snapshot.</div>"
          : "";
        var emptyNote = !diff.isBaseline && !hasChanges
          ? "<div class=\\"pull-no-change\\"><strong>No Change</strong><span>Latest Jira pull completed. Ticket fields match the previous snapshot.</span></div>"
          : "";

        return baselineNote +
          emptyNote +
          renderPullGroup("Added tickets", lists.added, function (issue) {
            return renderPullIssue(issue) +
              "<div class=\\"change-list\\"><div><b>Status:</b> " + escape(issue.status) + "</div><div><b>Updated:</b> " + escape(issue.updatedDisplay) + "</div></div>";
          }) +
          renderPullGroup("Updated tickets", lists.updated, function (item) {
            return renderPullIssue(item) +
              "<div class=\\"change-list\\">" + (item.changes || []).map(renderChange).join("") + "</div>";
          }) +
          renderPullGroup("Status changes", lists.statusChanges, function (item) {
            return renderPullIssue(item) +
              "<div class=\\"change-list\\"><div><b>Status:</b> " + escape(item.before) + " -> " + escape(item.after) + "</div></div>";
          }) +
          renderPullGroup("Removed tickets", lists.removed, function (issue) {
            return renderPullIssue(issue) +
              "<div class=\\"change-list\\"><div><b>Last known status:</b> " + escape(issue.status) + "</div></div>";
          });
      }

      function renderPullComparison(diff) {
        return "<section class=\\"pull-snapshot\\">" +
          "<h3 class=\\"pull-section-title\\">Latest comparison</h3>" +
          renderPullTiming(diff) +
          "<div class=\\"pull-stats\\">" + renderPullStats(diff) + "</div>" +
          renderDiffDetails(diff) +
        "</section>";
      }

      function renderHistorySummary(diff) {
        var lists = getDiffLists(diff || {});
        var parts = [];

        if (lists.added.length) {
          parts.push(lists.added.length + " " + plural(lists.added.length, "added ticket"));
        }
        if (lists.updated.length) {
          parts.push(lists.updated.length + " " + plural(lists.updated.length, "updated ticket"));
        }
        if (lists.statusChanges.length) {
          parts.push(lists.statusChanges.length + " " + plural(lists.statusChanges.length, "status move"));
        }
        if (lists.removed.length) {
          parts.push(lists.removed.length + " " + plural(lists.removed.length, "removed ticket"));
        }

        return parts.length ? parts.join(", ") : "No Change";
      }

      function renderHistoryEntry(diff, index) {
        var current = diff.currentPulledAtDisplay || data.pulledAtDisplay;
        return "<details class=\\"pull-history-entry\\"" + (index === 0 ? " open" : "") + ">" +
          "<summary><span>" + escape(current) + " ET</span><span class=\\"pull-entry-meta\\">" + escape(renderHistorySummary(diff)) + "</span></summary>" +
          "<div class=\\"pull-entry-body\\">" +
            renderPullTiming(diff) +
            "<div class=\\"pull-stats\\">" + renderPullStats(diff) + "</div>" +
            renderDiffDetails(diff) +
          "</div>" +
        "</details>";
      }

      function renderPullHistory(history, latestDiff) {
        var latestId = latestDiff.currentPulledAt || "";
        var changedHistory = history.filter(function (entry) {
          return pullHasChanges(entry) && entry.currentPulledAt !== latestId;
        });

        if (!changedHistory.length) {
          return "";
        }

        return "<section class=\\"pull-history\\">" +
          "<h3 class=\\"pull-section-title\\">Retained change history</h3>" +
          changedHistory.map(renderHistoryEntry).join("") +
        "</section>";
      }

      function renderDataPull() {
        var history = Array.isArray(data.pullHistory) ? data.pullHistory : [];
        var diff = data.pullDiff || history[0] || {};
        var current = diff.currentPulledAtDisplay || data.pulledAtDisplay;

        if (!history.length && data.pullDiff) {
          history = [data.pullDiff];
        }

        document.getElementById("pull-meta").textContent = "Latest pull: " + current + " ET";
        document.getElementById("pull-body").innerHTML =
          renderPullComparison(diff) +
          renderPullHistory(history, diff);
      }

      function renderAll() {
        renderFilterState();
        renderBoard();
        renderDataPull();
        document.getElementById("pulled-at").textContent = data.pulledAtDisplay;
        renderNextRefresh();
        document.getElementById("source-line").textContent = "Source: live Jira JQL " + data.jql + ". Components, descriptions, embedded images, and subtasks are generated from the current ticket snapshot.";
        document.getElementById("copy-components").innerHTML = copyIcon();
        var toggle = document.getElementById("toggle-subtasks");
        var cardsWithSubtasks = getVisibleSubtaskCards();
        var allSubtasksExpanded = cardsWithSubtasks.length > 0 && cardsWithSubtasks.every(function (card) {
          return state.expandedSubtasks.has(card.issue.key);
        });
        toggle.setAttribute("aria-pressed", allSubtasksExpanded ? "true" : "false");
        toggle.textContent = allSubtasksExpanded ? "Collapse all subtasks" : "Expand all subtasks";
      }

      document.getElementById("component-chips").addEventListener("click", function (event) {
        var chip = event.target.closest("[data-component]");
        if (!chip) {
          return;
        }

        state.activeComponent = chip.getAttribute("data-component");
        renderAll();
      });

      document.getElementById("qa-chips").addEventListener("click", function (event) {
        var chip = event.target.closest("[data-qa]");
        if (!chip) {
          return;
        }

        state.activeQa = chip.getAttribute("data-qa");
        renderAll();
      });

      document.getElementById("copy-components").addEventListener("click", function (event) {
        var components = getComponentCounts().map(function (entry) {
          return "- " + entry[0];
        });

        copyText(components.join("\\n")).then(function () {
          markCopied(event.currentTarget);
        });
      });

      document.getElementById("data-pull").addEventListener("click", function (event) {
        var copyButton = event.target.closest("[data-copy-link]");
        if (!copyButton) {
          return;
        }

        copyText(copyButton.getAttribute("data-copy-link")).then(function () {
          markCopied(copyButton);
        });
      });

      document.getElementById("board").addEventListener("submit", function (event) {
        var form = event.target.closest("[data-assign-form]");
        if (!form) {
          return;
        }

        event.preventDefault();
        var select = form.querySelector("[name='assignee']");
        var submit = form.querySelector(".assign-submit");
        var status = form.querySelector(".assign-status");
        var requestedAssignee = select ? select.value : "";
        var issueKey = form.getAttribute("data-issue-key");

        if (!requestedAssignee) {
          status.textContent = "Choose an assignee.";
          return;
        }

        status.textContent = "Starting secure workflow...";
        if (submit) {
          submit.disabled = true;
        }

        fetch(assigneeDispatchEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            issueKey: issueKey,
            assigneeDisplayName: requestedAssignee
          })
        })
          .then(function (response) {
            return response.json().catch(function () {
              return { ok: false, error: "The dispatch bridge returned an unreadable response." };
            }).then(function (payload) {
              if (!response.ok || !payload.ok) {
                throw new Error(payload.error || "The dispatch bridge rejected the request.");
              }
              return payload;
            });
          })
          .then(function () {
            status.textContent = "Workflow started. Jira will refresh shortly.";
          })
          .catch(function (error) {
            status.textContent = "Bridge offline. Open Actions to run it.";
            console.error(error);
          })
          .finally(function () {
            if (submit) {
              submit.disabled = false;
            }
          });
      });

      document.getElementById("board").addEventListener("click", function (event) {
        var copyButton = event.target.closest("[data-copy-link]");
        if (copyButton) {
          copyText(copyButton.getAttribute("data-copy-link")).then(function () {
            markCopied(copyButton);
          });
          return;
        }

        var subtaskToggle = event.target.closest(".subtask-toggle");
        if (subtaskToggle) {
          var issueKey = subtaskToggle.getAttribute("data-subtasks-for");
          if (state.expandedSubtasks.has(issueKey)) {
            state.expandedSubtasks.delete(issueKey);
          } else {
            state.expandedSubtasks.add(issueKey);
          }
          renderAll();
          return;
        }

        var descriptionToggle = event.target.closest(".description-toggle");
        if (descriptionToggle) {
          openDescriptionModal(descriptionToggle.getAttribute("data-description-for"));
          return;
        }

        var toggle = event.target.closest(".section-toggle");
        if (!toggle) {
          return;
        }

        var status = toggle.getAttribute("data-status");
        if (state.collapsedStatuses.has(status)) {
          state.collapsedStatuses.delete(status);
        } else {
          state.collapsedStatuses.add(status);
        }
        renderAll();
      });

      document.getElementById("description-modal").addEventListener("click", function (event) {
        var closeTarget = event.target.closest("[data-description-close]");
        if (closeTarget) {
          closeDescriptionModal();
          return;
        }

        var copyButton = event.target.closest("[data-copy-link]");
        if (copyButton) {
          copyText(copyButton.getAttribute("data-copy-link")).then(function () {
            markCopied(copyButton);
          });
        }
      });

      document.addEventListener("keydown", function (event) {
        if (event.key === "Escape" && !document.getElementById("description-modal").hidden) {
          closeDescriptionModal();
        }
      });

      document.getElementById("toggle-subtasks").addEventListener("click", function () {
        var cards = getVisibleSubtaskCards();
        var allExpanded = cards.length > 0 && cards.every(function (card) {
          return state.expandedSubtasks.has(card.issue.key);
        });

        if (allExpanded) {
          cards.forEach(function (card) {
            state.expandedSubtasks.delete(card.issue.key);
          });
        } else {
          cards.forEach(function (card) {
            state.expandedSubtasks.add(card.issue.key);
          });
        }
        renderAll();
      });

      document.getElementById("expand-all").addEventListener("click", function () {
        state.collapsedStatuses.clear();
        renderAll();
      });

      document.getElementById("collapse-all").addEventListener("click", function () {
        groupCards(getIssueModel().filter(cardMatchesFilters)).forEach(function (entry) {
          state.collapsedStatuses.add(entry[0]);
        });
        renderAll();
      });

      var resizeTimer;
      window.addEventListener("resize", function () {
        window.clearTimeout(resizeTimer);
        resizeTimer = window.setTimeout(renderAll, 120);
      });

      renderAll();
      checkBridgeStatus();
      window.setTimeout(checkForFreshDeployment, 5000);
      window.setInterval(renderNextRefresh, 30000);
      window.setInterval(checkForFreshDeployment, 60000);
      window.setInterval(checkBridgeStatus, 30000);
    })();
  </script>
</body>
</html>
`;
}

async function main() {
  const safeVersion = version.replace(/[^a-zA-Z0-9._-]/g, "_");
  const jsonPath = path.join(workspace, `jira-${safeVersion}-tickets.json`);
  const htmlPath = path.join(workspace, "jira-board-latest.html");
  const indexPath = path.join(workspace, "index.html");
  let previousData = null;

  const previousJsonData = fs.existsSync(jsonPath)
    ? parseJsonText(fs.readFileSync(jsonPath, "utf8"))
    : null;
  const previousHtmlData = readDataFromHtml(indexPath);
  previousData = newerPullData(previousJsonData, previousHtmlData);

  const { jql, issues: rawIssues } = await fetchIssues();
  const issues = await Promise.all(rawIssues.map(normalizeIssue));
  const json = buildJson(issues, jql, previousData);

  fs.writeFileSync(jsonPath, `${JSON.stringify(json, null, 2)}\n`);
  fs.writeFileSync(htmlPath, renderHtml(json));

  console.log(JSON.stringify({
    version,
    total: issues.length,
    jsonPath,
    htmlPath,
    jiraFilterUrl: `${siteUrl}/issues/?jql=${encodeURIComponent(jql)}`,
  }, null, 2));
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
