gh auth login# Jira Timesheet Calendar

A personal calendar with reviewed work-log submission for https://paragon-automation.atlassian.net.
React, FullCalendar Standard (free), and a local Node.js server. No Marketplace app, database, telemetry, or external frontend CDN.

## Start

Use a supported Node.js LTS release (Node 22 or newer recommended). This project was also tested on the existing Node 20.17 installation.

```sh
cd ~/Projects/jira-timesheet-calendar
npm ci
npm run build
npm start
```

Open http://127.0.0.1:4317. If occupied, the server tries the next ten ports and prints the selected URL. It binds only to 127.0.0.1; do not expose it through a tunnel or reverse proxy.

Dependencies and the first build are already installed on this Mac, so only `npm start` is needed on subsequent launches. Stop with Ctrl+C in the server terminal.

For source development, use `npm run dev`. Reload after frontend edits; hot reload is disabled to keep the server local and single-port. Backend and credential changes require a restart.

If your default npm registry is unavailable, use an approved registry. For public npm packages:

```sh
npm ci --registry=https://registry.npmjs.org --cache="$TMPDIR/npm-cache"
```

## Connect Your Account

Only create a token if your organization permits it. Do not share credentials in chat, screenshots, commits, or shell commands.

1. Open https://id.atlassian.com/manage-profile/security/api-tokens and create a personal API token with an appropriate expiry.
2. Prefer **Create API token with scopes**, select Jira, and grant classic scopes `read:jira-work` and `read:jira-user`. To save work logs, also include `write:jira-work`; a read-only token still supports viewing reports. No administrator scopes are needed. Your Jira account must have Browse Projects and Work on Issues permissions for the target issue, and time tracking must be enabled. The write scope grants more than just work-log access, so protect the token accordingly.
3. Open the existing `.env` locally in an editor:

   ```sh
   code ~/Projects/jira-timesheet-calendar/.env
   ```

4. Set `JIRA_EMAIL` to your Atlassian account email and `JIRA_API_TOKEN` to the token. For a **scoped token**, also set `JIRA_CLOUD_ID` to your site's cloud ID. For this site the login redirect identified `8e3cd3a8-f987-45c6-96ba-44e0296173fa`; verify it at https://paragon-automation.atlassian.net/_edge/tenant_info if needed. For an **unscoped token**, leave `JIRA_CLOUD_ID` empty.
5. Restart the server. Turn off **Sample data**, then refresh the calendar.

`.env` has owner-only file permissions (600) and is excluded from Git. It is plaintext on disk, not encrypted; protect your Mac account and backups. The browser never receives the token. Keep it out of frontend `VITE_*` variables. The app does not log upstream response bodies or credentials.

For a fresh checkout, create a local `.env` with the settings above and restrict it with `chmod 600 .env` before entering credentials. Environment files, including templates, are excluded from Git. Never overwrite an existing configured `.env`.

## Calendar and Totals

- Month, week, and agenda views; Monday-start weeks.
- Use the moon/sun button to switch between light and dark mode. The choice is saved in this browser; on the first visit it follows the system setting.
- Choose a date or work log to see its issue, description, start time, and duration. Real issue links open Jira in a new tab.
- Daily details also show the issue's current original estimate, total time spent, and due date, or indicate when they are unset or unavailable. Estimate and time spent are displayed in hours; issue time spent may include work logged by other users and is separate from this account's report totals.
- Daily details show story points when Jira exposes a numeric custom field named **Story Points** or **Story point estimate**. They are the issue's current estimate, not points earned on that date; repeated logs repeat the same estimate. Unset or unavailable values and conflicting populated fields are flagged. Renamed fields are not detected.
- Use **Display fields** in the right-side panel to show or hide story points, original estimate, time spent, and due date. Your choices are saved in this browser.
- Daily and period totals use exact logged seconds; displayed hours are rounded to two decimals.
- Daily average uses days with work logs, not scheduled working days. Partial weekly totals include only days inside the displayed period.
- Work logs are filtered and grouped by their `started` date in the local server's system time zone (your Mac's time zone), not your Jira profile time zone. For example, September 9 at 23:56 in Berlin appears on September 10 at 03:26 in India. The entire duration stays on its local start date; this is a timesheet, not a reconstructed activity timeline.
- Today/navigation follows your browser's local date. The connection strip displays the reporting time zone.
- CSV exports the displayed period with exact seconds, decimal hours, and story points. Spreadsheet-formula-like text is escaped.
- Sample mode uses fabricated, labeled entries and does not access Jira. It is off by default and resets on reload.
- No time is inferred from issue status, assignment, estimates, or commits. Hours must be logged in Jira, either directly or through this app's confirmed Log work action.

## Log Work

1. Select a calendar date, then choose **Log work**. This action is disabled in sample mode and until a live report loads.
2. Enter an issue key, local date and start time, duration (such as `8h`, `30m`, or `1h 30m`), and an optional description. Duration accepts whole hours/minutes from 1 minute to 24 hours. Dates and times use the reporting time zone shown in the form. Ambiguous or nonexistent daylight-saving times are rejected.
3. Select **Review**. This only reads Jira: it resolves the issue and checks your existing entries for the same issue and local date. Review the account, issue title, date, duration, and description.
4. Check existing Jira logs and any pending Jira Assistant extension entries before acknowledging the duplicate warning. The app cannot see the extension's unsent local entries. Never upload the same work through both tools.
5. Select **Save to Jira**. Only this confirmation submits a new log with `POST /rest/api/3/issue/{id}/worklog?adjustEstimate=leave`. The issue's remaining estimate is not changed. Jira may send its normal notifications.

A successful save displays confirmation and refreshes the calendar. Search indexing may delay the new entry; check the issue's Work log before submitting it again. Cancel, close, or edit during review does not write anything to Jira.

Reviews expire after 10 minutes and are kept only in server memory. Repeated submissions of the same review are handled as one attempt during that server session. This is not durable exactly-once delivery: new reviews, server restarts, concurrent use of other tools, or lost responses can still lead to duplicates. On a timeout or unconfirmed save, the form blocks further saving and asks you to verify Jira first. There is no automatic write retry.

Local writes require the exact same browser origin, a server-issued CSRF token, JSON, and explicit confirmation. The server uses the stored reviewed values, not replacement fields in the save request.

If your existing API token has only read scopes, create a replacement scoped token including the two read scopes plus `write:jira-work`, update only its local value in `.env`, and restart the server. Do not share the token in chat. Revoke obsolete tokens after verifying the replacement works.

## Edit and Delete

Select a date, then use the pencil or trash icon beside a work log in daily details. These actions are unavailable for sample data. Double-clicking a month/week date square still opens a new Log work form; it does not modify an existing entry.

- **Edit:** date, local start time, and duration are prefilled. The issue cannot be changed. Select **Replace description** only when you want to replace the existing rich-text comment with plain text (an empty replacement clears it). Otherwise the original comment and its formatting remain untouched. Unchanged duration seconds and timestamp precision are preserved, including legacy values outside the new-entry limits. Changed durations accept whole hours/minutes from 1 minute to 24 hours. Review the proposed values and any previous time/duration shown, acknowledge the changes, then choose **Update in Jira**.
- **Delete:** select **Review deletion**, inspect the latest issue, date, duration, and description, acknowledge permanent deletion, then choose **Delete from Jira**. There is no undo in this app.
- Cancel, close, and review do not mutate Jira. Successful updates/deletions refresh the calendar and totals. All changes use `adjustEstimate=leave`; remaining estimates stay unchanged.

The scoped token needs `write:jira-work` plus the existing read scopes. Your Jira account must also have **Edit Own Worklogs** and/or **Delete Own Worklogs** in the target project. Token scopes cannot grant missing project permissions; Jira remains the authority on access. The app only permits changes to entries authored by the currently authenticated account.

The server reads each existing work log at review and again immediately before updating or deleting, checking ownership and a fingerprint of its content/version against the entry you loaded. A stale entry is rejected; refresh and review it again. Overlapping changes to the same entry are blocked within this server process. Jira does not provide an atomic compare-and-swap here, so an external change between the final read and write can still race; coordinate concurrent edits. Separate app instances do not share locks.

Update and delete reuse the expiring, server-held review and single-attempt protections described above. The confirmed action must match the review; replacement values or IDs sent with confirmation are ignored. If a response is lost, inspect Jira before trying again. There is no automatic retry or durable cross-restart exactly-once guarantee.

## Data Accuracy and Limits

The backend identifies you with `GET /rest/api/3/myself`, finds story-point fields using `GET /rest/api/3/field`, discovers candidate issues using `POST /rest/api/3/search/jql`, then fetches paginated `GET /rest/api/3/issue/{id}/worklog` results. It filters each log by your account ID and the exact reporting dates. JQL date bounds are padded for time-zone differences; they are not used as the final inclusion check.

Search and work logs are both paginated, duplicate IDs are removed, and no partial totals are returned on failure. Up to three issue work-log requests run concurrently. Requests have timeouts; reports are limited to 62 days. A rate limit produces an explicit error rather than automatic repeated requests.

Jira search indexing can lag behind new or changed work logs. Refresh after a short delay. Jira permissions, issue visibility, archived/deleted issues, and restricted work logs can limit available data. This is a personal reporting aid, not an authoritative payroll system.

## Troubleshooting

- **Jira not connected:** complete `.env`, restart the server, and refresh. No credentials are requested through the web UI.
- **Credentials rejected:** check account email, token expiry, and scoped versus unscoped configuration.
- **Access denied:** check token scopes, project permissions, and organization policy; saving needs `write:jira-work` and Work on Issues permission. Do not bypass company restrictions.
- **No work logs:** confirm the period and use Jira's Log work action. An issue-level Time Spent total alone does not identify your individual entries.
- **Connection error:** check VPN/network. Do not disable TLS verification to work around certificate issues.
- **Rate limit:** wait before refreshing. No partial totals are displayed.

## Verify

```sh
npm test
npm run lint
npm run format:check
npm run build
```

Tests cover pagination, author isolation, exclusive date boundaries, daylight-saving transitions, incomplete responses, local host/origin restrictions, CSRF and action confirmation, single-attempt writes, reviewed-payload integrity, concurrent-change locks, ownership and stale-entry checks, PUT/DELETE including 204 responses, precision and untouched-comment preservation, duration validation, aggregation, and safe CSV formatting. Mutation tests use mocks and never add, update, or delete real Jira entries. Live Jira mutation verification requires an intentional user-confirmed action and suitable permissions.

Official references:

- https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/
- https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-worklogs/
- https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/
