# Playwright Automation Specs

This folder is the 123-board pilot playbook for dashboard-triggered Playwright automation.

The dashboard can link to these files from `/modern/`, while execution remains out of the static page and behind a protected hosted runner.

## Completed Specs

- `PW-01`: runner contract and payload schema
- `PW-02`: protected runner skeleton through GitHub Actions
- `PW-03`: dashboard job queue control
- `PW-04`: observable job polling and status display
- `PW-05`: durable evidence publishing under `playwright-jobs/<jobId>/`
- `PW-06`: production gates, audit fields, and locked registry rules
- Approved script registry: `script-registry.json`
- Job payload schema: `job-contract.schema.json`

## Guardrails

- The dashboard must never accept arbitrary JavaScript or raw Playwright code.
- Users can choose only scripts listed in the approved registry.
- Every job must include a ticket key, target environment, requested user, and artifact plan.
- Execution must happen in a protected runner, not in the GitHub Pages browser tab.
- Artifacts must be durable links: screenshot, video, trace, logs, and summary JSON.
