# RootNote monitoring

`resilient-monitor.yml` runs the existing Upptime action for uptime checks every
five minutes and response-time recording at 23:00 UTC. Only a failed monitor step
is retried, up to two times, in separate jobs with newly allocated hosted runners.
The final attempt is not allowed to fail silently. Checkout failures and job
timeouts remain failures rather than being hidden by the retry policy.

This addresses Globalping API errors such as a security block on a GitHub runner
IP (HTTP 403) and transient measurement errors. A fresh runner offers a different
network path but does not guarantee a different IP or successful measurement.
Persistent provider problems still fail the workflow and send normal GitHub
failure notifications. Recovered errors remain visible in the attempt logs.

Actual endpoint results still go through Upptime's existing confirmation,
incident, history, and notification logic. An endpoint reported down is not a
failed action, so this workflow does not retry or suppress a confirmed incident.
The API continues to use the US Globalping datacenter probe; direct GitHub-runner
checks previously produced false incidents from network timeouts.

## Rollout after merge

These custom filenames survive Upptime's template regeneration. The generated
`uptime.yml` and `response-time.yml` must be disabled in GitHub Actions to prevent
duplicate checks and the old failure emails. Disabling a workflow is repository
state, so regenerating its file does not remove the disable setting.

1. Run `gh workflow run resilient-monitor.yml --repo rootnoteco/upptime -f command=update`
   and verify success, then repeat with `-f command=response-time`.
2. Disable the two replaced workflows:
   ```sh
   gh workflow disable uptime.yml --repo rootnoteco/upptime
   gh workflow disable response-time.yml --repo rootnoteco/upptime
   ```
3. Verify a scheduled `Resilient Monitor CI` run completes. All status writers
   share the existing repository/branch concurrency group.

Rollback: enable `uptime.yml` and `response-time.yml`, then disable
`resilient-monitor.yml`. Do not disable the remaining generated workflows.

The custom reusable workflow pins the Upptime action independently of generated
workflows. Review and update its version when adopting upstream monitor fixes.
It forwards the existing `GH_PAT` and `GLOBALPING_TOKEN` secrets; if additional
Upptime notification channels are configured, explicitly add their secrets to
both custom workflows and the `SECRETS_CONTEXT` allowlist.

## Verification

Run `pnpm install --frozen-lockfile` and `pnpm test`. Tests evaluate the actual
workflow retry conditions for success, recovery, exhausted retries, cancellation,
and command routing without making live measurements or writing incidents.
Validate workflow syntax with `actionlint`. The production workflows have no PR
trigger; PR checks run only the offline tests.
