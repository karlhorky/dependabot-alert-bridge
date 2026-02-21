# Dependabot Alert Bridge for GitHub Actions

Enable GitHub Actions workflow triggers for Dependabot alerts by bridging `dependabot_alert` webhooks to `repository_dispatch` events.

## Why

GitHub sends `dependabot_alert` as a webhook event, but GitHub Actions cannot trigger on it directly.

This bridge converts:

- `dependabot_alert` webhook
- to `repository_dispatch` with type `dependabot-alert-bridge.dependabot-alert-opened`

## Flow

1. GitHub creates or reopens a Dependabot alert.
2. GitHub sends `dependabot_alert` to this app.
3. This app verifies webhook signature.
4. This app normalizes dependency names (trim + dedupe + sort) and sends `repository_dispatch`.
5. Your workflow handles `repository_dispatch` and reads `github.event.client_payload`.

```text
dependabot_alert webhook -> this bridge -> repository_dispatch (dependabot-alert-bridge.dependabot-alert-opened) -> your workflow
```

## Environment Variables

Required:

- `GITHUB_APP_ID`: GitHub App `App ID`
- `GITHUB_APP_PRIVATE_KEY`: private key content from the generated `.pem` file (`\\n` escaped newlines supported)
- `GITHUB_WEBHOOK_SECRET`: same webhook secret configured in GitHub App webhook settings

Optional:

- `PORT` (default `3000`)

See `.env.example`

## GitHub App Setup

1. Generate a webhook secret:
   - `openssl rand -hex 32`
   - Save this value, you will use it in GitHub App webhook settings, local `.env`, and deployed env vars
2. Open [GitHub Apps settings](https://github.com/settings/apps) and click `New GitHub App`
3. `Create GitHub App`
   - GitHub App name: `Dependabot Alert Bridge`
   - Description:

     ```md
     Enable GitHub Actions workflow triggers for Dependabot alerts by bridging `dependabot_alert` webhooks to `repository_dispatch` events.

     Use cases: trigger remediation workflows from Dependabot alerts, run custom update commands such as `pnpm up -r --depth 100 ...`, and automate pull request creation for dependency updates.

     ### Permissions

     `Contents: Read and write` is only used to send `repository_dispatch` events for GitHub Actions workflow triggers - feel free to audit [the app server code](https://github.com/karlhorky/dependabot-alert-bridge/blob/main/index.ts) for yourself.
     ```

   - Homepage URL: `https://github.com/karlhorky/dependabot-alert-bridge`

4. `Webhook`
   - Webhook URL: temporary placeholder `https://example.com/webhook` (to be updated later, after deploy)
   - Secret: paste the generated webhook secret
5. `Permissions`
   - `Contents`: Read and write
   - `Dependabot alerts`: Read-only
6. `Subscribe to events`
   - `Dependabot alert`
7. `Where can this GitHub App be installed?`
   - `Only on this account`
8. Create the app
9. Generate a private key
   - In `Private keys`, click `Generate a private key` and use the downloaded `.pem` file contents as `GITHUB_APP_PRIVATE_KEY`
10. Install on target repositories

- In GitHub App settings, open `Install App`, click `Install` on each target repository/account

11. Collect these values for deployment (`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`)
12. Deploy the bridge service (see `Deploy on Deno Deploy`)
13. Update Webhook URL in GitHub App settings to your deployed URL plus `/webhook`

Docs:

- [Registering a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app)
- [Choosing permissions for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/setting-up-a-github-app/choosing-permissions-for-a-github-app)
- [Using webhooks with GitHub Apps](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/using-webhooks-with-github-apps)

## Deploy on Deno Deploy

1. Fork this repository to your GitHub account
2. Go to [Deno Deploy - Create a New Project](https://dash.deno.com/new_project)
3. Click `Continue with GitHub`, authorize Deno Deploy, accept terms
4. If your account does not appear, click `Add GitHub Account` and authorize it
5. Select your account and select the forked repository
6. Set `Entrypoint` to `index.ts`
7. Add environment variables in project settings:
   - `GITHUB_APP_ID`
   - `GITHUB_APP_PRIVATE_KEY` (single line with `\n` escapes)
     ```bash
     cat path/to/private-key.pem | tr -d '\r' | perl -pe 's/\n/\\n/g' | pbcopy
     ```
   - `GITHUB_WEBHOOK_SECRET`
   - optional: `PORT`
8. Deploy
9. Copy the Production Deployment `.deno.dev` URL and set GitHub App Webhook URL to:
   - `https://<your-project>.deno.dev/webhook`

## Test

1. Trigger a Dependabot alert in an installed repository
2. Check bridge logs for `Dispatched dependabot-alert-bridge.dependabot-alert-opened`
3. Confirm the `repository_dispatch` workflow runs

## Run Locally

Requirements:

- Node.js v24+
- pnpm

```bash
pnpm install
node --env-file=.env index.ts
```

Expose local webhook endpoint:

```bash
cloudflared tunnel --url http://localhost:3000
```

Then set the GitHub App Webhook URL to:

```text
https://<your-cloudflared-subdomain>/webhook
```

After local testing, remember to set GitHub App Webhook URL back to your Deno Deploy `/webhook` URL.

Checks:

```bash
pnpm tsc
pnpm lint
```

## `repository_dispatch` Payload

`event_type` is always:

- `dependabot-alert-bridge.dependabot-alert-opened`

`client_payload` shape (example for an npm alert):

```json
{
  "alert_number": 123,
  "ghsa_id": "GHSA-xxxx-yyyy-zzzz",
  "severity": "high",
  "ecosystem": "npm",
  "dependencies": ["brace-expansion", "minimatch"]
}
```

## Workflow Example

Bridge forwards all ecosystems. This example filters to npm in the workflow job and runs `pnpm up` for the affected dependencies:

- [`.github/workflows/dependabot-alert-remediation.yml`](.github/workflows/dependabot-alert-remediation.yml)

This workflow file must be on the repository default branch.

Create a fine-grained PAT for PR creation:

1. Go to GitHub `Settings` -> `Developer settings` -> `Personal access tokens` -> `Fine-grained tokens` -> `Generate new token`, set token name to `dependabot-alert-bridge-pr-token`
2. Select the target repository, set repository permissions to `Contents: Read and write` and `Pull requests: Read and write`
3. In the target repository, go to `Settings` -> `Secrets and variables` -> `Actions`, then add secret `DEPENDABOT_ALERT_BRIDGE_PR_TOKEN` with the token value

This token is used by `peter-evans/create-pull-request` so CI checks run on bridge-created PRs

## Troubleshooting

- Signature mismatch:
  - Check `GITHUB_WEBHOOK_SECRET` matches GitHub App webhook secret
- Missing dependencies:
  - Payload shape is unexpected, request fails and logs an error
- `403` dispatch errors:
  - Confirm app permissions and installation on the target repo

## Notes

- ESM-only TypeScript
- Node.js v24+ with type stripping
