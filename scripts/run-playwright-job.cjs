const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const workspace = path.resolve(__dirname, "..");
const registryPath = path.join(workspace, "playwright-specs", "script-registry.json");
const jobsRoot = path.join(workspace, "playwright-jobs");
const publicBase = "https://dewankabir009.github.io/jira-board-v3001-123-0/playwright-jobs";

function safeId(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function readPayload() {
  const raw = process.env.PLAYWRIGHT_JOB_PAYLOAD || "{}";
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("PLAYWRIGHT_JOB_PAYLOAD must be valid JSON.");
  }
}

function loadRegistry() {
  return JSON.parse(fs.readFileSync(registryPath, "utf8"));
}

function validatePayload(payload, registry) {
  const ticketKey = String(payload.ticketKey || "").trim().toUpperCase();
  const scriptId = String(payload.scriptId || "").trim();
  const environment = String(payload.environment || "").trim();
  const script = (registry.scripts || []).find((item) => item.id === scriptId);

  if (payload.schemaVersion !== "playwright-job/v1") {
    throw new Error("Unsupported Playwright job schema version.");
  }
  if (!script || script.status !== "ready") {
    throw new Error("Playwright script is not approved for this pilot.");
  }
  if (!/^[A-Z][A-Z0-9]+-\d+$/.test(ticketKey)) {
    throw new Error("A valid Jira ticket key is required.");
  }
  if (!script.allowedEnvironments.includes(environment)) {
    throw new Error("Selected environment is not allowed for this script.");
  }
  if (payload.repositorySlug !== "DewanKabir009/jira-board-v3001-123-0") {
    throw new Error("Playwright jobs are limited to the v3001.123.0 board repository.");
  }

  return { script, ticketKey, scriptId, environment };
}

function makeJobId(payload, ticketKey) {
  const explicit = safeId(payload.jobId);
  if (explicit) {
    return explicit;
  }

  return safeId(`${ticketKey}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`);
}

function createWriter(jobId, payload, validated) {
  const jobDir = path.join(jobsRoot, jobId);
  const logPath = path.join(jobDir, "logs.txt");
  const eventsPath = path.join(jobDir, "events.ndjson");
  const markerPath = path.join(jobsRoot, ".latest-job-id");
  const state = {
    schemaVersion: "playwright-job-summary/v1",
    jobId,
    status: "queued",
    message: "Playwright job queued.",
    currentStep: "Queued",
    ticketKey: validated.ticketKey,
    scriptId: validated.scriptId,
    scriptLabel: validated.script.label,
    environment: validated.environment,
    repositorySlug: payload.repositorySlug,
    requestedBy: payload.requestedBy || {},
    requestedAt: new Date().toISOString(),
    startedAt: "",
    completedAt: "",
    durationMs: 0,
    actionsUrl: process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : "",
    statusUrl: `${publicBase}/${jobId}/summary.json`,
    jobUrl: `${publicBase}/${jobId}/`,
    artifacts: [],
    failureReason: ""
  };
  const startTime = Date.now();

  fs.mkdirSync(jobDir, { recursive: true });
  fs.mkdirSync(jobsRoot, { recursive: true });
  fs.writeFileSync(markerPath, jobId);

  function writeSummary() {
    state.durationMs = Date.now() - startTime;
    fs.writeFileSync(path.join(jobDir, "summary.json"), `${JSON.stringify(state, null, 2)}\n`);
    fs.writeFileSync(path.join(jobDir, "index.html"), renderJobPage(state));
  }

  function event(type, detail) {
    const entry = { at: new Date().toISOString(), type, detail };
    fs.appendFileSync(eventsPath, `${JSON.stringify(entry)}\n`);
    fs.appendFileSync(logPath, `[${entry.at}] ${type}: ${detail}\n`);
  }

  function step(name) {
    state.status = "running";
    state.currentStep = name;
    if (!state.startedAt) {
      state.startedAt = new Date().toISOString();
    }
    event("step", name);
    writeSummary();
  }

  function artifact(type, label, fileName) {
    if (!fileName || !fs.existsSync(path.join(jobDir, fileName))) {
      return;
    }
    state.artifacts.push({
      type,
      label,
      href: `${publicBase}/${jobId}/${fileName}`
    });
    writeSummary();
  }

  function complete(message) {
    state.status = "completed";
    state.message = message;
    state.currentStep = "Complete";
    state.completedAt = new Date().toISOString();
    event("complete", message);
    writeSummary();
  }

  function fail(error) {
    state.status = "failed";
    state.message = "Playwright job failed.";
    state.failureReason = error instanceof Error ? error.message : String(error);
    state.completedAt = new Date().toISOString();
    event("failed", state.failureReason);
    writeSummary();
  }

  writeSummary();
  return { jobDir, state, step, event, artifact, complete, fail, writeSummary };
}

function renderJobPage(state) {
  const artifactLinks = (state.artifacts || [])
    .map((artifact) => renderResultLink(artifact.href, artifact.label || artifact.type, artifact.type))
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Playwright Job ${escapeHtml(state.jobId)}</title>
  <style>
    body { margin: 0; background: #f5fbff; color: #071b25; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { display: grid; gap: 16px; max-width: 1040px; margin: 0 auto; padding: 28px; }
    header, section { border: 1px solid #b7d8e4; border-radius: 8px; background: #fff; padding: 20px; box-shadow: 0 18px 48px rgba(0, 84, 122, 0.12); }
    h1, h2, p { margin: 0; }
    h1 { font-size: clamp(2rem, 4vw, 4rem); line-height: 1; }
    p { color: #536a78; line-height: 1.55; }
    body.modal-open { overflow: hidden; }
    a, button.result-button { display: inline-flex; min-height: 34px; align-items: center; border: 1px solid #5db7d7; border-radius: 8px; background: #fff; color: #005fcc; cursor: pointer; font: inherit; font-weight: 850; margin: 6px 6px 0 0; padding: 0 10px; text-decoration: none; }
    a:hover, button.result-button:hover, a:focus-visible, button.result-button:focus-visible { border-color: #007a4d; color: #007a4d; outline: none; }
    .status { display: inline-flex; border-radius: 999px; background: #007a4d; color: #fff; font-weight: 900; padding: 5px 9px; }
    .status.failed { background: #be123c; }
    dl { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
    dl > div { border: 1px solid #b7d8e4; border-radius: 8px; padding: 10px; }
    dt { color: #536a78; font-size: .76rem; font-weight: 900; text-transform: uppercase; }
    dd { margin: 4px 0 0; font-weight: 900; }
    .result-modal { position: fixed; inset: 0; z-index: 20; display: none; background: rgba(7, 27, 37, 0.76); padding: 18px; }
    .result-modal.open { display: grid; }
    .result-modal-shell { display: grid; grid-template-rows: auto minmax(0, 1fr); min-height: 0; overflow: hidden; border: 1px solid #9fd0df; border-radius: 10px; background: #f7fcff; box-shadow: 0 28px 80px rgba(0, 42, 67, 0.36); }
    .result-modal-bar { display: flex; gap: 10px; align-items: center; justify-content: space-between; border-bottom: 1px solid #b7d8e4; padding: 12px 14px; }
    .result-modal-bar strong { font-size: 1.05rem; }
    .result-modal-actions { display: flex; gap: 8px; align-items: center; }
    .result-modal-actions a, .result-modal-actions button { margin: 0; }
    .result-modal-close { min-width: 42px; justify-content: center; border-color: #5db7d7; background: #fff; color: #071b25; }
    .result-modal-body { min-height: 0; overflow: auto; padding: 16px; }
    .result-modal-body iframe { width: 100%; height: calc(100vh - 126px); border: 1px solid #b7d8e4; border-radius: 8px; background: #fff; }
    .result-modal-body img, .result-modal-body video { display: block; max-width: 100%; max-height: calc(100vh - 126px); margin: 0 auto; border: 1px solid #b7d8e4; border-radius: 8px; background: #fff; box-shadow: 0 18px 48px rgba(0, 84, 122, 0.12); }
    .download-card { display: grid; place-items: center; min-height: calc(100vh - 150px); text-align: center; }
    .download-card > div { max-width: 560px; background: #fff; }
  </style>
</head>
<body>
  <main>
    <header>
      <span class="status ${state.status === "failed" ? "failed" : ""}">${escapeHtml(state.status)}</span>
      <h1>${escapeHtml(state.jobId)}</h1>
      <p>${escapeHtml(state.message)}</p>
    </header>
    <section>
      <h2>Job details</h2>
      <dl>
        <div><dt>Ticket</dt><dd>${escapeHtml(state.ticketKey)}</dd></div>
        <div><dt>Script</dt><dd>${escapeHtml(state.scriptLabel || state.scriptId)}</dd></div>
        <div><dt>Environment</dt><dd>${escapeHtml(state.environment)}</dd></div>
        <div><dt>Current step</dt><dd>${escapeHtml(state.currentStep)}</dd></div>
        <div><dt>Started</dt><dd>${escapeHtml(state.startedAt || "Queued")}</dd></div>
        <div><dt>Duration</dt><dd>${Math.round((state.durationMs || 0) / 1000)}s</dd></div>
      </dl>
    </section>
    <section>
      <h2>Artifacts</h2>
      ${renderResultLink("summary.json", "Summary JSON", "json")}
      ${renderResultLink("logs.txt", "Logs", "logs")}
      ${renderResultLink("events.ndjson", "Events", "events")}
      ${artifactLinks}
    </section>
  </main>
  <div class="result-modal" data-results-modal aria-hidden="true">
    <div class="result-modal-shell" role="dialog" aria-modal="true" aria-labelledby="result-modal-title">
      <div class="result-modal-bar">
        <strong id="result-modal-title" data-results-modal-title>Result</strong>
        <div class="result-modal-actions">
          <a href="#" target="_blank" rel="noreferrer" data-results-modal-open>Open full page</a>
          <button class="result-button result-modal-close" type="button" aria-label="Close result viewer" data-results-modal-close>X</button>
        </div>
      </div>
      <div class="result-modal-body" data-results-modal-body></div>
    </div>
  </div>
  <script>
    (() => {
      const modal = document.querySelector("[data-results-modal]");
      const titleNode = document.querySelector("[data-results-modal-title]");
      const bodyNode = document.querySelector("[data-results-modal-body]");
      const openNode = document.querySelector("[data-results-modal-open]");
      const closeNode = document.querySelector("[data-results-modal-close]");
      const links = Array.from(document.querySelectorAll("[data-result-link]"));

      function closeModal() {
        modal.classList.remove("open");
        modal.setAttribute("aria-hidden", "true");
        document.body.classList.remove("modal-open");
        bodyNode.innerHTML = "";
      }

      function openModal(link) {
        const href = link.getAttribute("href") || "";
        const title = link.getAttribute("data-result-title") || link.textContent || "Result";
        const type = ((link.getAttribute("data-result-type") || "") + " " + href).toLowerCase();
        titleNode.textContent = title;
        openNode.href = href;
        bodyNode.innerHTML = "";

        if (/screenshot|image|\\.png|\\.jpe?g|\\.gif|\\.webp/.test(type)) {
          const image = document.createElement("img");
          image.src = href;
          image.alt = title;
          bodyNode.appendChild(image);
        } else if (/video|\\.webm|\\.mp4|\\.mov/.test(type)) {
          const video = document.createElement("video");
          video.src = href;
          video.controls = true;
          video.playsInline = true;
          bodyNode.appendChild(video);
        } else if (/trace|\\.zip/.test(type)) {
          const card = document.createElement("div");
          card.className = "download-card";
          card.innerHTML = '<div><h2>Trace package</h2><p>Browser trace files are downloaded and opened in Playwright Trace Viewer.</p><a href="' + href + '" target="_blank" rel="noreferrer">Open or download trace</a></div>';
          bodyNode.appendChild(card);
        } else {
          const frame = document.createElement("iframe");
          frame.src = href;
          frame.title = title;
          bodyNode.appendChild(frame);
        }

        modal.classList.add("open");
        modal.setAttribute("aria-hidden", "false");
        document.body.classList.add("modal-open");
        closeNode.focus();
      }

      links.forEach((link) => {
        link.addEventListener("click", (event) => {
          event.preventDefault();
          openModal(link);
        });
      });
      closeNode.addEventListener("click", closeModal);
      modal.addEventListener("click", (event) => {
        if (event.target === modal) closeModal();
      });
      window.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && modal.classList.contains("open")) closeModal();
      });
    })();
  </script>
</body>
</html>`;
}

function renderResultLink(href, label, type) {
  return `<a href="${escapeHtml(href)}" data-result-link data-result-type="${escapeHtml(type || "")}" data-result-title="${escapeHtml(label || type || "Result")}">${escapeHtml(label || type || "Result")}</a>`;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function runBrowserJob(payload, writer) {
  const { chromium } = require("playwright");
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    recordVideo: { dir: writer.jobDir, size: { width: 1280, height: 720 } }
  });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  const page = await context.newPage();

  try {
    const targetUrl = targetUrlForPayload(payload, writer.state.scriptId, writer.state.ticketKey);
    writer.step(`Opening ${targetUrl}`);
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(1800);

    if (writer.state.scriptId === "dashboard-regression-smoke") {
      writer.step("Checking dashboard controls");
      await page.getByText("Ticket board").first().waitFor({ timeout: 20000 });
      await page.getByRole("button", { name: /table/i }).first().click().catch(() => {});
      await page.getByRole("button", { name: /cards/i }).first().click().catch(() => {});
    }

    writer.step("Capturing screenshot");
    await page.screenshot({ path: path.join(writer.jobDir, "screenshot.png"), fullPage: true });
    writer.artifact("screenshot", "Screenshot", "screenshot.png");

    writer.step("Saving trace");
    await context.tracing.stop({ path: path.join(writer.jobDir, "trace.zip") });
    writer.artifact("trace", "Trace", "trace.zip");
  } finally {
    await context.close();
    await browser.close();
    const videoFile = fs.readdirSync(writer.jobDir).find((file) => file.endsWith(".webm"));
    if (videoFile) {
      fs.renameSync(path.join(writer.jobDir, videoFile), path.join(writer.jobDir, "video.webm"));
      writer.artifact("video", "Video", "video.webm");
    }
  }
}

function targetUrlForPayload(payload, scriptId, ticketKey) {
  const params = payload.parameters || {};
  if (scriptId === "dashboard-regression-smoke") {
    return String(params.dashboardUrl || payload.dashboardUrl || "https://dewankabir009.github.io/jira-board-v3001-123-0/modern/");
  }
  if (scriptId === "golfnow-central-smoke") {
    const startUrl = String(params.startUrl || "https://golfnowcentral.dev.golfnow.io/");
    const parsed = new URL(startUrl);
    if (!parsed.hostname.endsWith("golfnow.io")) {
      throw new Error("GolfNow Central smoke script only accepts golfnow.io targets.");
    }
    return startUrl;
  }
  return String(params.ticketUrl || `https://golfnow.atlassian.net/browse/${ticketKey}`);
}

async function main() {
  let writer;
  try {
    const payload = readPayload();
    const registry = loadRegistry();
    const validated = validatePayload(payload, registry);
    const jobId = makeJobId(payload, validated.ticketKey);
    writer = createWriter(jobId, payload, validated);
    writer.step("Starting browser runner");
    await runBrowserJob(payload, writer);
    writer.artifact("logs", "Logs", "logs.txt");
    writer.artifact("events", "Events", "events.ndjson");
    writer.complete("Playwright job completed and evidence was published.");
  } catch (error) {
    if (!writer) {
      const fallbackPayload = { repositorySlug: "DewanKabir009/jira-board-v3001-123-0", requestedBy: {} };
      const fallbackScript = { id: "validation", label: "Validation", allowedEnvironments: ["dev"] };
      writer = createWriter(`failed-${Date.now().toString(36)}`, fallbackPayload, {
        script: fallbackScript,
        ticketKey: "CORE-0",
        scriptId: "validation",
        environment: "dev"
      });
    }
    writer.fail(error);
    process.exitCode = 1;
  }
}

main();
