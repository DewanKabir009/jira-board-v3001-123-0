const siteUrl = process.env.JIRA_SITE_URL || "https://golfnow.atlassian.net";

function cleanText(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeName(value) {
  return cleanText(value).toLowerCase();
}

function normalizeSlackUserId(value) {
  const text = cleanText(value);
  const mention = text.match(/^<@([^>|]+)(?:\|[^>]+)?>$/);
  return mention ? mention[1] : text.replace(/^@/, "");
}

function truncate(value, maxLength) {
  const text = String(value || "");
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function slackLink(url, label) {
  return url ? `<${url}|${label}>` : label;
}

const assigneeSlackUserIds = {
  [normalizeName("Nicole Greer")]: normalizeSlackUserId(process.env.SLACK_USER_NICOLE_GREER_ID || "U0998DAQ1QF"),
  [normalizeName("Anton Yurkevich")]: normalizeSlackUserId(process.env.SLACK_USER_ANTON_YURKEVICH_ID || "U0998DE5U8P"),
  [normalizeName("Alex McNay")]: normalizeSlackUserId(process.env.SLACK_USER_ALEX_MCNAY_ID || "U09986MHDN3"),
};

function slackAssignee(displayName) {
  const userId = assigneeSlackUserIds[normalizeName(displayName)];
  return userId ? `<@${userId}>` : cleanText(displayName) || "Unassigned";
}

function defaultDashboardUrl() {
  const repositorySlug = process.env.BOARD_REPOSITORY_SLUG || process.env.GITHUB_REPOSITORY || "";
  const [repositoryOwner, repositoryName] = repositorySlug.split("/");
  if (!repositoryOwner || !repositoryName) {
    return "";
  }
  return `https://${repositoryOwner.toLowerCase()}.github.io/${repositoryName}/`;
}

function buildPayload() {
  const issueKey = cleanText(process.env.ASSIGNEE_ISSUE_KEY || process.env.ISSUE_KEY);
  const assigneeDisplayName = cleanText(process.env.ASSIGNEE_DISPLAY_NAME || process.env.NEW_ASSIGNEE_DISPLAY_NAME);

  if (!issueKey) {
    throw new Error("ASSIGNEE_ISSUE_KEY or ISSUE_KEY is required for assignee Slack notifications.");
  }
  if (!assigneeDisplayName) {
    throw new Error("ASSIGNEE_DISPLAY_NAME or NEW_ASSIGNEE_DISPLAY_NAME is required for assignee Slack notifications.");
  }

  const issueUrl = cleanText(process.env.ISSUE_URL) || `${siteUrl}/browse/${encodeURIComponent(issueKey)}`;
  const dashboardUrl = cleanText(process.env.DASHBOARD_URL) || defaultDashboardUrl();
  const issueSummary = cleanText(process.env.ISSUE_SUMMARY);
  const issueStatus = cleanText(process.env.ISSUE_STATUS);
  const previousAssignee = cleanText(process.env.PREVIOUS_ASSIGNEE_DISPLAY_NAME);
  const version = cleanText(process.env.JIRA_FIX_VERSION);
  const actor = cleanText(process.env.GITHUB_ACTOR);
  const boardChanged = cleanText(process.env.BOARD_CHANGED);
  const issueLabel = issueSummary ? `${issueKey} - ${issueSummary}` : issueKey;
  const lines = [
    `${slackAssignee(assigneeDisplayName)} was assigned ${slackLink(issueUrl, issueLabel)}.`,
    previousAssignee ? `*Previous assignee:* ${previousAssignee}` : "",
    issueStatus ? `*Status:* ${issueStatus}` : "",
    version ? `*Board:* ${version}` : "",
    boardChanged ? `*Dashboard refreshed:* ${boardChanged === "true" ? "Yes" : "No content change"}` : "",
    actor ? `*Updated by:* ${actor}` : "",
  ].filter(Boolean);
  const actions = [
    {
      type: "button",
      text: { type: "plain_text", text: "Open Jira ticket", emoji: false },
      url: issueUrl,
    },
  ];

  if (dashboardUrl) {
    actions.push({
      type: "button",
      text: { type: "plain_text", text: "Open dashboard", emoji: false },
      url: dashboardUrl,
    });
  }

  return {
    text: `Jira assignee updated: ${issueKey} assigned to ${assigneeDisplayName}`,
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: truncate("Jira assignee updated", 150),
          emoji: false,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: truncate(lines.join("\n"), 2900),
        },
      },
      {
        type: "actions",
        elements: actions,
      },
    ],
  };
}

async function postSlackPayload(payload) {
  const botToken = process.env.SLACK_BOT_TOKEN;
  const channelId = process.env.SLACK_CHANNEL_ID || process.env.SLACK_CHANNEL;

  if (botToken && channelId) {
    const message = { ...payload, channel: channelId };
    const response = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        authorization: `Bearer ${botToken}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(message),
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
      throw new Error(`Slack bot assignee notification failed: ${detail}`);
    }

    console.log(`Slack assignee notification sent to ${channelId}.`);
    return true;
  }

  if (botToken && !channelId) {
    console.log("::warning::SLACK_BOT_TOKEN is configured but SLACK_CHANNEL_ID is missing; trying webhook fallback.");
  }

  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) {
    console.log("::warning::Slack assignee notification skipped. Configure SLACK_BOT_TOKEN with SLACK_CHANNEL_ID, or configure SLACK_WEBHOOK_URL.");
    return false;
  }

  const message = { ...payload };
  if (process.env.SLACK_CHANNEL) {
    message.channel = process.env.SLACK_CHANNEL;
  }

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(message),
  });

  if (!response.ok) {
    throw new Error(`Slack assignee notification failed with HTTP ${response.status}: ${await response.text()}`);
  }

  console.log("Slack assignee notification sent.");
  return true;
}

async function main() {
  await postSlackPayload(buildPayload());
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
