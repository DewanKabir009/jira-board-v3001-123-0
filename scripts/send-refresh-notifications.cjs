const fs = require("fs");
const net = require("net");
const path = require("path");
const tls = require("tls");

const workspace = path.resolve(__dirname, "..");
const version = process.env.JIRA_FIX_VERSION || "v3001.122.0";
const safeVersion = version.replace(/[^a-zA-Z0-9._-]/g, "_");
const jsonPath = path.join(workspace, `jira-${safeVersion}-tickets.json`);

function parseList(value) {
  return String(value || "")
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter(Boolean);
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

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function truncate(value, maxLength) {
  const text = String(value || "");
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function listKeys(items) {
  return (items || []).map((item) => item.key).filter(Boolean);
}

function issueText(item) {
  const parent = item.parent?.key
    ? ` Parent: ${item.parent.key} - ${item.parent.summary || "Untitled parent"}.`
    : "";
  const changes = Array.isArray(item.changes) && item.changes.length
    ? ` Changes: ${item.changes.map((change) => `${change.label || change.field}: ${change.before || "None"} -> ${change.after || "None"}`).join("; ")}.`
    : "";
  return `${item.key} - ${item.summary || "Untitled ticket"}.${parent}${changes}`;
}

function statusMoveText(item) {
  const parent = item.parent?.key
    ? ` Parent: ${item.parent.key} - ${item.parent.summary || "Untitled parent"}.`
    : "";
  return `${item.key} - ${item.summary || "Untitled ticket"}: ${item.before || "None"} -> ${item.after || "None"}.${parent}`;
}

function buildSummary(data) {
  const diff = data.pullDiff || {};
  const added = diff.added || [];
  const updated = diff.updated || [];
  const statusChanges = diff.statusChanges || [];
  const removed = diff.removed || [];
  const dashboardUrl = data.dashboardUrl || `https://dewankabir009.github.io/${data.repositorySlug?.split("/").pop() || ""}/`;
  const counts = {
    added: added.length,
    updated: updated.length,
    statusMoves: statusChanges.length,
    removed: removed.length,
  };
  const changedKeys = Array.from(new Set([
    ...listKeys(added),
    ...listKeys(updated),
    ...listKeys(statusChanges),
    ...listKeys(removed),
  ]));
  const headline = `${data.version}: ${counts.added} added, ${counts.updated} updated, ${counts.statusMoves} status moves, ${counts.removed} removed`;

  const sections = [];
  if (added.length) {
    sections.push(["Added", added.map(issueText)]);
  }
  if (updated.length) {
    sections.push(["Updated", updated.map(issueText)]);
  }
  if (statusChanges.length) {
    sections.push(["Status moves", statusChanges.map(statusMoveText)]);
  }
  if (removed.length) {
    sections.push(["Removed", removed.map(issueText)]);
  }

  return {
    data,
    diff,
    dashboardUrl,
    counts,
    changedKeys,
    headline,
    sections,
    pull: diff.currentPulledAtDisplay || data.pulledAtDisplay || "Unknown pull time",
    previousPull: diff.previousPulledAtDisplay || "None",
  };
}

function buildTextBody(summary) {
  const lines = [
    `Jira board changed: ${summary.headline}`,
    "",
    `Pull: ${summary.pull} ET`,
    `Previous pull: ${summary.previousPull}${summary.previousPull === "None" ? "" : " ET"}`,
    `Dashboard: ${summary.dashboardUrl}`,
  ];

  if (summary.changedKeys.length) {
    lines.push("", `Changed tickets: ${summary.changedKeys.join(", ")}`);
  }

  for (const [title, items] of summary.sections) {
    lines.push("", `${title}:`);
    for (const item of items) {
      lines.push(`- ${item}`);
    }
  }

  return lines.join("\n");
}

function buildHtmlBody(summary) {
  const sectionHtml = summary.sections.map(([title, items]) => {
    const rows = items.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
    return `<h3>${escapeHtml(title)}</h3><ul>${rows}</ul>`;
  }).join("");

  return [
    "<!doctype html>",
    "<html>",
    "<body style=\"font-family:Arial,sans-serif;color:#0f172a;line-height:1.45;\">",
    `<h2>Jira board changed: ${escapeHtml(summary.data.version)}</h2>`,
    `<p><strong>${escapeHtml(summary.counts.added)}</strong> added, <strong>${escapeHtml(summary.counts.updated)}</strong> updated, <strong>${escapeHtml(summary.counts.statusMoves)}</strong> status moves, <strong>${escapeHtml(summary.counts.removed)}</strong> removed.</p>`,
    `<p><strong>Pull:</strong> ${escapeHtml(summary.pull)} ET<br><strong>Previous pull:</strong> ${escapeHtml(summary.previousPull)}${summary.previousPull === "None" ? "" : " ET"}</p>`,
    `<p><a href="${escapeHtml(summary.dashboardUrl)}">Open dashboard</a></p>`,
    summary.changedKeys.length ? `<p><strong>Changed tickets:</strong> ${escapeHtml(summary.changedKeys.join(", "))}</p>` : "",
    sectionHtml,
    "</body>",
    "</html>",
  ].join("");
}

function buildSlackPayload(summary) {
  const detailLines = [];
  for (const [title, items] of summary.sections) {
    detailLines.push(`*${title}*`);
    detailLines.push(...items.slice(0, 8).map((item) => `- ${item}`));
    if (items.length > 8) {
      detailLines.push(`- ...and ${items.length - 8} more`);
    }
  }

  return {
    text: `Jira board changed: ${summary.headline}`,
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: truncate(`Jira board changed: ${summary.data.version}`, 150),
          emoji: false,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: [
            `*Pull:* ${summary.pull} ET`,
            `*Previous pull:* ${summary.previousPull}${summary.previousPull === "None" ? "" : " ET"}`,
            `*Counts:* ${summary.counts.added} added, ${summary.counts.updated} updated, ${summary.counts.statusMoves} status moves, ${summary.counts.removed} removed`,
          ].join("\n"),
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: truncate(detailLines.join("\n") || "Ticket data changed.", 2900),
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "Open dashboard",
              emoji: false,
            },
            url: summary.dashboardUrl,
          },
        ],
      },
    ],
  };
}

async function sendSlack(summary) {
  const botToken = process.env.SLACK_BOT_TOKEN;
  const channelId = process.env.SLACK_CHANNEL_ID || process.env.SLACK_CHANNEL;

  if (botToken && channelId) {
    const payload = buildSlackPayload(summary);
    payload.channel = channelId;

    const response = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        authorization: `Bearer ${botToken}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(payload),
    });

    const resultText = await response.text();
    let result = null;
    try {
      result = JSON.parse(resultText);
    } catch {
      result = null;
    }

    if (!response.ok || !result?.ok) {
      const detail = result?.error || resultText || `HTTP ${response.status}`;
      throw new Error(`Slack bot notification failed: ${detail}`);
    }

    console.log(`Slack bot notification sent to ${channelId}.`);
    return true;
  }

  if (botToken && !channelId) {
    console.log("::warning::SLACK_BOT_TOKEN is configured but SLACK_CHANNEL_ID is missing; trying webhook fallback.");
  }

  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) {
    console.log("::warning::Slack notification skipped. Configure SLACK_BOT_TOKEN with SLACK_CHANNEL_ID, or configure SLACK_WEBHOOK_URL.");
    return false;
  }

  const payload = buildSlackPayload(summary);

  if (process.env.SLACK_CHANNEL) {
    payload.channel = process.env.SLACK_CHANNEL;
  }

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Slack notification failed with HTTP ${response.status}: ${await response.text()}`);
  }

  console.log("Slack notification sent.");
  return true;
}

class SmtpClient {
  constructor(socket) {
    this.socket = socket;
    this.lines = [];
    this.partial = "";
    this.waiters = [];
    socket.on("data", (chunk) => {
      const parts = `${this.partial}${chunk.toString("utf8")}`.split(/\r?\n/);
      this.partial = parts.pop() || "";
      this.lines.push(...parts.filter((line) => line.length));
      this.drain();
    });
  }

  drain() {
    while (this.waiters.length) {
      const response = this.extractResponse();
      if (!response) {
        return;
      }
      this.waiters.shift()(response);
    }
  }

  extractResponse() {
    const endIndex = this.lines.findIndex((line) => /^\d{3} /.test(line));
    if (endIndex === -1) {
      return null;
    }
    const lines = this.lines.splice(0, endIndex + 1);
    return {
      code: Number(lines[lines.length - 1].slice(0, 3)),
      lines,
    };
  }

  read() {
    const response = this.extractResponse();
    if (response) {
      return Promise.resolve(response);
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  write(line) {
    this.socket.write(`${line}\r\n`);
  }

  async command(line, expectedCodes) {
    if (line) {
      this.write(line);
    }
    const response = await this.read();
    if (!expectedCodes.includes(response.code)) {
      throw new Error(`SMTP command failed: ${line || "(connect)"} -> ${response.lines.join(" | ")}`);
    }
    return response;
  }
}

function connectSocket(host, port, secure) {
  return new Promise((resolve, reject) => {
    const options = {
      host,
      port,
      servername: host,
      rejectUnauthorized: process.env.SMTP_REJECT_UNAUTHORIZED !== "false",
    };
    const socket = secure ? tls.connect(options) : net.createConnection(options);
    socket.once(secure ? "secureConnect" : "connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function extractEmail(value) {
  const text = String(value || "").trim();
  const match = text.match(/<([^>]+)>/);
  return (match ? match[1] : text).trim();
}

function dotStuff(message) {
  return message.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
}

function buildEmailMessage(summary, from, recipients) {
  const boundary = `jira-board-${Date.now().toString(36)}`;
  const subject = `Jira board ${summary.data.version} changed: ${summary.counts.added} added, ${summary.counts.updated} updated, ${summary.counts.statusMoves} moved, ${summary.counts.removed} removed`;
  const text = buildTextBody(summary);
  const html = buildHtmlBody(summary);

  return [
    `From: ${from}`,
    `To: ${recipients.join(", ")}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    text,
    "",
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    html,
    "",
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

async function sendEmail(summary) {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const username = process.env.SMTP_USERNAME;
  const password = process.env.SMTP_PASSWORD;
  const from = process.env.QA_EMAIL_FROM || username;
  const recipients = parseList(process.env.QA_EMAIL_TO);

  if (!host || !from || !recipients.length) {
    console.log("::warning::SMTP_HOST, QA_EMAIL_FROM/SMTP_USERNAME, or QA_EMAIL_TO is missing; QA email skipped.");
    return false;
  }

  const secure = String(process.env.SMTP_SECURE || "").toLowerCase() === "true" || port === 465;
  const startTls = !secure && String(process.env.SMTP_SECURE || "").toLowerCase() !== "false";
  let socket = await connectSocket(host, port, secure);
  let client = new SmtpClient(socket);

  await client.command(null, [220]);
  await client.command(`EHLO ${process.env.GITHUB_REPOSITORY || "jira-board"}`, [250]);

  if (startTls) {
    await client.command("STARTTLS", [220]);
    socket.removeAllListeners("data");
    socket = tls.connect({
      socket,
      servername: host,
      rejectUnauthorized: process.env.SMTP_REJECT_UNAUTHORIZED !== "false",
    });
    await new Promise((resolve, reject) => {
      socket.once("secureConnect", resolve);
      socket.once("error", reject);
    });
    client = new SmtpClient(socket);
    await client.command(`EHLO ${process.env.GITHUB_REPOSITORY || "jira-board"}`, [250]);
  }

  if (username && password) {
    await client.command("AUTH LOGIN", [334]);
    await client.command(Buffer.from(username).toString("base64"), [334]);
    await client.command(Buffer.from(password).toString("base64"), [235]);
  }

  await client.command(`MAIL FROM:<${extractEmail(from)}>`, [250]);
  for (const recipient of recipients) {
    await client.command(`RCPT TO:<${extractEmail(recipient)}>`, [250, 251]);
  }
  await client.command("DATA", [354]);
  client.socket.write(`${dotStuff(buildEmailMessage(summary, from, recipients))}\r\n.\r\n`);
  await client.command(null, [250]);
  await client.command("QUIT", [221]);

  console.log(`QA email notification sent to ${recipients.length} recipient(s).`);
  return true;
}

async function main() {
  if (!fs.existsSync(jsonPath)) {
    throw new Error(`Jira data file not found: ${jsonPath}`);
  }

  const data = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  if (!hasChanges(data.pullDiff || {})) {
    console.log("No Jira ticket changes detected; notifications skipped.");
    return;
  }

  const summary = buildSummary(data);
  const results = await Promise.allSettled([
    sendSlack(summary),
    sendEmail(summary),
  ]);
  const failures = results.filter((result) => result.status === "rejected");

  for (const failure of failures) {
    console.log(`::error::${failure.reason?.message || failure.reason}`);
  }

  if (failures.length) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
