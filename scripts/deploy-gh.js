#!/usr/bin/env node

const { execSync, spawnSync } = require('child_process');

const VALID_SERVICES = new Set(['proxy', 'analyse', 'auth', 'all']);
const repo = process.env.DEPLOY_REPO || 'whyops-org/be';
const workflow = process.env.DEPLOY_WORKFLOW || 'deploy.yml';
const service = process.argv[2] || 'all';

if (!VALID_SERVICES.has(service)) {
  console.error(`Invalid service '${service}'. Expected one of: ${[...VALID_SERVICES].join(', ')}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: options.stdio || 'pipe',
    encoding: 'utf8',
    ...options,
  });

  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    const stdout = (result.stdout || '').trim();
    const message = stderr || stdout || `Command failed: ${command} ${args.join(' ')}`;
    throw new Error(message);
  }

  return (result.stdout || '').trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const startedAt = new Date().toISOString();
  console.log(`Dispatching workflow '${workflow}' for service='${service}' on repo '${repo}'...`);

  run('gh', ['workflow', 'run', workflow, '--repo', repo, '-f', `service=${service}`], { stdio: 'inherit' });

  // Give GitHub a moment to register the run, then find the latest workflow_dispatch run.
  let runId = '';
  let runUrl = '';

  for (let attempt = 1; attempt <= 10; attempt += 1) {
    await sleep(2000);
    const raw = run('gh', [
      'run',
      'list',
      '--repo',
      repo,
      '--workflow',
      workflow,
      '--event',
      'workflow_dispatch',
      '--limit',
      '5',
      '--json',
      'databaseId,createdAt,url,displayTitle',
    ]);

    const runs = JSON.parse(raw);
    const candidate = runs.find((item) => item.createdAt >= startedAt) || runs[0];
    if (candidate?.databaseId) {
      runId = String(candidate.databaseId);
      runUrl = candidate.url || '';
      break;
    }
  }

  if (!runId) {
    console.log('Workflow dispatched, but run ID was not found automatically.');
    console.log(`Check manually: gh run list --repo ${repo} --workflow ${workflow}`);
    return;
  }

  console.log(`Run started: ${runId}${runUrl ? ` (${runUrl})` : ''}`);
  run('gh', ['run', 'watch', runId, '--repo', repo, '--interval', '15', '--exit-status'], {
    stdio: 'inherit',
  });
  console.log(`Deploy workflow completed successfully for service='${service}'.`);
}

main().catch((error) => {
  console.error(`Deploy command failed: ${error.message}`);
  process.exit(1);
});
