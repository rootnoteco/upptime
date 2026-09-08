import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { parse } from 'yaml';

const read = (path) => parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const workflow = read('../.github/workflows/resilient-monitor.yml');
const attempt = read('../.github/workflows/monitor-attempt.yml');
const evaluate = (expression, context) => typeof expression === 'string'
  ? runInNewContext(expression.replace(/^\$\{\{\s*|\s*\}\}$/g, ''), context)
  : expression;

// Exercise the actual workflow conditions and failure policy, with the monitor's
// process outcome supplied by each scenario. No network or incident writes.
function simulate(outcomes, cancelled = false) {
  const needs = {};
  const calls = [];
  const step = attempt.jobs.monitor.steps.find((step) => step.id === 'monitor');
  for (const [name, job] of Object.entries(workflow.jobs)) {
    const dependencies = Object.fromEntries([job.needs ?? []].flat().map((name) => [name, needs[name]]));
    if (job.if && !evaluate(job.if, { needs: dependencies, cancelled: () => cancelled })) {
      needs[name] = { result: 'skipped', outputs: {} };
      continue;
    }
    const outcome = outcomes[calls.length];
    assert.ok(outcome, 'unexpected additional monitor attempt');
    calls.push(name);
    const tolerated = evaluate(step['continue-on-error'], { inputs: job.with });
    needs[name] = {
      result: outcome === 'failure' && !tolerated ? 'failure' : 'success',
      outputs: {
        outcome: evaluate(attempt.on.workflow_call.outputs.outcome.value, { jobs: { monitor: {
          outputs: { outcome: evaluate(attempt.jobs.monitor.outputs.outcome, {
            steps: { monitor: { outcome, conclusion: tolerated ? 'success' : outcome } },
          }) },
        } } }),
      },
    };
  }
  return { calls, failed: Object.values(needs).some((job) => job.result === 'failure') };
}

test('a healthy check uses one runner', () => {
  assert.deepEqual(simulate(['success']), { calls: ['first'], failed: false });
});
test('a Globalping 403 can recover on a fresh runner without failing the run', () => {
  assert.deepEqual(simulate(['failure', 'success']), {
    calls: ['first', 'retry'], failed: false,
  });
});
test('two provider errors can recover on the final runner', () => {
  assert.deepEqual(simulate(['failure', 'failure', 'success']), {
    calls: ['first', 'retry', 'final'], failed: false,
  });
});
test('persistent monitor errors still fail the workflow', () => {
  assert.equal(simulate(['failure', 'failure', 'failure']).failed, true);
});
test('cancellation prevents retries', () => {
  assert.deepEqual(simulate(['failure'], true).calls, ['first']);
});
test('only monitoring errors are tolerated, not checkout failures', () => {
  const checkout = attempt.jobs.monitor.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
  assert.ok(checkout);
  assert.ok(!checkout['continue-on-error']);
  assert.ok(!attempt.jobs.monitor['continue-on-error']);
});
test('both scheduled commands and dispatch routes select the correct monitor operation', () => {
  const command = workflow.jobs.first.with.command;
  for (const [event, inputs, expected] of [
    [{ schedule: '*/5 * * * *' }, {}, 'update'],
    [{ schedule: '0 23 * * *' }, {}, 'response-time'],
    [{ action: 'uptime' }, {}, 'update'],
    [{ action: 'response_time' }, {}, 'response-time'],
    [{}, { command: 'response-time' }, 'response-time'],
    [{}, { command: 'update' }, 'update'],
  ]) {
    assert.equal(evaluate(command, { github: { event }, inputs }), expected);
  }
  for (const job of Object.values(workflow.jobs)) assert.equal(job.with.command, command);
  assert.deepEqual(workflow.on.schedule.map((entry) => entry.cron), ['*/5 * * * *', '0 23 * * *']);
});
test('retries preserve the upstream monitor, API probe and shared write lock', () => {
  const step = attempt.jobs.monitor.steps.find((step) => step.id === 'monitor');
  assert.match(step.uses, /^upptime\/uptime-monitor@/);
  assert.equal(step.with.command, '${{ inputs.command }}');
  assert.match(step.env.SECRETS_CONTEXT, /secrets\.GLOBALPING_TOKEN/);
  const generated = read('../.github/workflows/uptime.yml');
  assert.deepEqual(workflow.concurrency, generated.concurrency);
  const api = read('../.upptimerc.yml').sites.find((site) => site.name === 'RootNote API');
  assert.equal(api.type, 'globalping');
  assert.deepEqual(api.expectedStatusCodes, [200]);
});
