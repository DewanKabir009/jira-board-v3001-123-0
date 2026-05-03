# GolfNow CORE Jira Board

Interactive release dashboard for Jira fixVersion `v3001.123.0`.

- Live dashboard: <https://dewankabir009.github.io/jira-board-v3001-123-0/>
- Jira source: `fixVersion = "v3001.123.0" ORDER BY updated DESC`
- Current dashboard version: `v1.9.2`

The board groups release tickets by workflow status, keeps component and QA filters at the top, tracks subtask relationships, and preserves a Data Pull history so status movement is visible over time.

## GitHub Actions Refresh

The repo includes `.github/workflows/refresh-jira-board.yml`.

Behavior:

- Starts from a GitHub Actions schedule every 5 minutes.
- Each scheduled run performs one Jira pull and publishes the updated dashboard plus any new Jira media assets.
- Can also be run manually from the GitHub Actions tab.
- Pulls the latest Jira data for `v3001.123.0`.
- Compares the new Jira snapshot against the snapshot embedded in `index.html`.
- Publishes `index.html` after each successful pull so the dashboard shows the latest pull timestamp.
- Uses `No Change` in the Data Pull panel when Jira ticket fields match the previous snapshot.

Required repository secrets:

- `JIRA_MCP_TOKEN`: Jira API token used by the pull script.
- `JIRA_EMAIL`: Jira email address for API auth, for example `dewan.kabir@versantmedia.com`.
- `JIRA_CLOUD_ID`: Jira Cloud ID, currently `24a77690-829a-4704-94eb-fafef6370d21`.

Recommended setup:

```powershell
gh secret set JIRA_EMAIL --body "dewan.kabir@versantmedia.com" --repo DewanKabir009/jira-board-v3001-123-0
gh secret set JIRA_CLOUD_ID --body "24a77690-829a-4704-94eb-fafef6370d21" --repo DewanKabir009/jira-board-v3001-123-0
gh secret set JIRA_MCP_TOKEN --repo DewanKabir009/jira-board-v3001-123-0
```

For `JIRA_MCP_TOKEN`, paste the token only into the GitHub CLI prompt or GitHub repository secret UI. Do not commit it to the repository.

## Secured Assignee Updates

The repo also includes `.github/workflows/update-jira-assignee.yml`.

Behavior:

- The dashboard shows an assignee picker on every ticket and subtask.
- Submit calls a local workflow dispatch bridge on `http://127.0.0.1:3992/assign`.
- The bridge uses the already-authenticated GitHub CLI session to start the secured GitHub Actions workflow.
- The GitHub Action runs only for the trusted GitHub actor `DewanKabir009`.
- Jira credentials stay in GitHub Secrets and are never sent to the browser.
- The Action resolves the Jira account, updates the issue assignee, refreshes the board, and commits `index.html` when the board changes.
- Repo admins can also run the workflow manually with `workflow_dispatch` inputs.
- The footer shows `Assignee Bridge Status` and turns green when the local bridge is reachable and GitHub CLI auth is ready.

Current allowed assignees:

- Dewan Kabir
- Nicole Greer
- Alex Mcnay
- Anton Yurkevich

Start the local bridge when using the live dashboard to update assignees:

```powershell
node scripts/dispatch-assignee-workflow-server.cjs
```

The bridge does not hold the Jira token. It only dispatches the GitHub Actions workflow through `gh`, and the workflow reads the Jira token from GitHub Secrets.

## Local Refresh

The local generator can still be run from the workspace:

```powershell
node pull-jira-release-tickets.cjs v3001.123.0
Copy-Item -Path jira-board-latest.html -Destination index.html
```

The generator writes:

- `jira-board-latest.html`: latest generated dashboard.
- `jira-v3001.123.0-tickets.json`: latest local Jira snapshot.
- `index.html`: published dashboard when copied or committed.

## Dashboard Features

- Status sections are grouped and can be expanded or collapsed.
- Subtasks can be expanded per parent ticket or globally.
- Components are auto-built from Jira and can be used as filters.
- The Components header includes a copy action that copies component names as a bullet list.
- QA filters support Dewan Kabir, Nicole Greer, Alex Mcnay, and Anton Yurkevich.
- Ticket keys include copy-link buttons.
- Data Pull history shows added tickets, updated tickets, status moves, removed tickets, and retained historical changes.
- Subtask changes in Data Pull include the parent ticket key and parent summary.
- Each ticket includes an assignee picker that submits a secured GitHub Actions request.

Security note: the dashboard is static GitHub Pages, so it does not store Jira credentials. Assignee writes go through GitHub Actions, where Jira credentials stay private in repository secrets.

## Version History

### v0.1 - Initial Board

Screenshot: `screenshots/jira-board-versions/01-initial-board.png`

- Published the first static Jira board for `v3001.123.0`.
- Grouped tickets by Jira workflow status.
- Showed ticket key, summary, assignee, priority, updated date, and components.
- Published the board through GitHub Pages.

### v0.2 - Responsive Interactive Board

Screenshot: `screenshots/jira-board-versions/02-responsive-interactive.png`

- Made the board responsive for desktop and smaller screens.
- Added top-level metrics.
- Added component filters.
- Added expand and collapse controls for status sections.
- Improved card sizing and layout behavior.

### v0.3 - Collapsible Subtasks

Screenshot: `screenshots/jira-board-versions/03-collapsible-subtasks.png`

- Added subtask layering under parent tickets.
- Added per-ticket subtask expand/collapse controls.
- Added a global Expand all subtasks / Collapse all subtasks control.
- Kept subtasks available without letting them dominate the main ticket view.

### v0.4 - Copy Actions

Screenshot: `screenshots/jira-board-versions/04-copy-actions.png`

- Added copy icons beside every Jira ticket key.
- Added a Components copy action.
- Component copying outputs only names, formatted as a bullet list.

### v0.5 - Data Pull Diff Panel

Screenshot: `screenshots/jira-board-versions/05-data-pull-diff-panel.png`

- Added the Data Pull section at the bottom of the page.
- Displayed previous pull and most recent pull timestamps.
- Added counts for added, updated, status moves, and removed tickets.
- Included detailed field-level changes when Jira data changed.

### v0.6 - Packed Status Layout

Screenshot: `screenshots/jira-board-versions/06-packed-status-layout.png`

- Improved board packing so shorter status columns leave less empty space.
- Balanced status sections across columns.
- Kept later statuses easier to find near the upper part of the page.

### v0.7 - Retained Data Pull History

Screenshot: `screenshots/jira-board-versions/07-retained-data-pull-history.png`

- Added retained Data Pull history.
- Prevented no-change pulls from hiding previous meaningful changes.
- Restored the previously captured `CORE-14210` status move history.

### v0.8 - No Change State

Screenshot: `screenshots/jira-board-versions/08-no-change-data-pull-state.png`

- Added a clear modern `No Change` state to the Data Pull panel.
- Kept latest pull timestamps visible while preserving prior change history.
- Updated refresh summaries to use `No Change` language.

### v0.9 - QA Filters, Parent Context, Assignee Actions

Screenshot: `screenshots/jira-board-versions/09-qa-filter-parent-assignee-actions.png`

- Added a QA section under Components.
- Added filters for Dewan Kabir, Nicole Greer, Alex Mcnay, and Anton Yurkevich.
- Made QA filters combinable with component filters.
- Added parent ticket key and parent summary to subtask changes in Data Pull.
- Added Update assignee links that open Jira safely from each ticket card.

### v1.0 - GitHub Actions Automation and Release Notes Link

- Added a GitHub Actions workflow to poll Jira every 5 minutes.
- Added an action runner script that commits only when Jira ticket data changes.
- Added this README with dashboard version history.
- Added a dashboard footer link to these release notes.

### v1.1 - Secured Assignee Picker

Screenshot: `screenshots/jira-board-versions/10-secure-assignee-picker.png`

- Replaced the Update assignee link with a compact assignee picker and submit action.
- Added a secured GitHub Actions workflow for Jira assignee updates.
- Kept Jira credentials inside GitHub Secrets instead of the public dashboard.
- Added an Action script that updates Jira and refreshes the board.
- Added manual workflow dispatch inputs as a repo-admin fallback.

### v1.2 - Direct Workflow Dispatch Bridge

Screenshot: `screenshots/jira-board-versions/11-workflow-dispatch-bridge.png`

- Removed the GitHub Issue request trigger path from the dashboard.
- Added a local dispatch bridge so Submit starts `update-jira-assignee.yml` without creating GitHub issues.
- Kept Jira updates inside GitHub Actions with Jira credentials stored only in GitHub Secrets.
- Added an Actions shortcut on each ticket for visibility into workflow runs.

### v1.3 - Assignee Bridge Status Indicator

Screenshot: `screenshots/jira-board-versions/12-assignee-bridge-status.png`

- Added an `Assignee Bridge Status` indicator in the dashboard footer.
- Added a non-mutating `/status` endpoint to the local bridge.
- The indicator shows green when the bridge is reachable and GitHub CLI auth is ready.
- The indicator shows offline when assignee updates cannot currently be dispatched from the page.

### v1.3.1 - v3001.123.0 Separate Board

Screenshot: `screenshots/jira-board-versions/13-v3001-123-initial-board.png`

- Created a separate GitHub Pages board for fixVersion `v3001.123.0`.
- Kept the v3001.123.0 repo, page URL, Jira data, screenshots, workflows, and assignee bridge separate from v3001.122.0.
- Assigned the v3001.123.0 assignee bridge to local port `3992` so it can run next to the v3001.122.0 bridge on port `3991`.
- Pulled the first v3001.123.0 Jira snapshot as a baseline.

### v1.4 - Published No-Change Pulls

- Updated the GitHub Actions refresh path so every successful Jira pull publishes the dashboard timestamp.
- Kept `No Change` visible in the Data Pull panel when Jira ticket fields did not change.
- Preserved separate Jira-change counts so the workflow summary still distinguishes true ticket changes from timestamp refreshes.

### v1.5 - Next Refresh Stamp

Screenshot: `screenshots/jira-board-versions/14-next-refresh-stamp.png`

- Added `Next Refresh on:` to the Jira pull stamp.
- Calculates the next expected 5-minute refresh boundary in Eastern Time.
- Keeps the last pull timestamp and next expected refresh visible together.

### v1.6 - Auto Freshness Check

Screenshot: `screenshots/jira-board-versions/15-auto-freshness-check.png`

- Added no-cache meta hints to the static dashboard HTML.
- Added a lightweight freshness check that asks the live GitHub Pages page for the latest deployed pull timestamp.
- Automatically reloads an open dashboard tab when a newer deployed pull is available.
- Preserves the newest embedded pull history when local generator snapshots are older than `index.html`.

### v1.7 - Watchdog Refresh Loop

Screenshot: `screenshots/jira-board-versions/16-watchdog-refresh-loop.png`

- Replaced the unreliable `*/5` GitHub scheduler assumption with an hourly watcher job.
- Scheduled refresh runs now poll Jira every 5 minutes inside the running GitHub Actions job.
- Increased the refresh job timeout to cover the full watcher window.
- Kept manual workflow runs as a single immediate Jira pull.

### v1.8 - Ticket Description Dropdowns

Screenshot: `screenshots/jira-board-versions/17-ticket-description-dropdowns.png`

- Added Jira descriptions to the pulled ticket snapshot.
- Added a collapsed `Description` dropdown to every main ticket and subtask card.
- Preserved readable line breaks from Jira descriptions and included description edits in Data Pull update detection.

### v1.9 - Full Description Images

Screenshot: `screenshots/jira-board-versions/18-full-description-images.png`

- Rendered richer Jira description content, including lists, links, code blocks, tables, and panels.
- Embedded Jira description images as dashboard assets under `assets/jira-media`.
- Updated description toggles to show the image count when a ticket description includes screenshots.

### v1.9.1 - Direct Five-Minute Refresh

- Replaced the hourly watchdog start with direct every-5-minute scheduled refresh attempts.
- Kept Jira media assets in the scheduled publish path so new description images are committed with the refreshed dashboard.
- Reduced the refresh job timeout because each scheduled run now performs one pull instead of sleeping inside a long runner session.

### v1.9.2 - Metric Status Split

- Clarified status metric counts by adding a main/subtask split under tracked-ticket and workflow-status metrics.
- Kept the Jira source count intact while making hidden nested subtasks visible in the top summary.
- Helps explain cases where a status lane has one main card but the Jira count includes subtasks under a parent in another lane.

## Planned Next Steps

- Add email notification support that sends the dashboard link and pull summary without attaching the HTML file.
- Add optional allow-list expansion if more GitHub users should be allowed to submit dashboard assignee updates.
