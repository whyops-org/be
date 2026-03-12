#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DEFAULT_REPO = 'whyops-org/be';

function parseArgs(argv) {
  const args = {
    key: '',
    value: '',
    file: '',
    repo: DEFAULT_REPO,
    env: '',
    dryRun: false,
    includeEmpty: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];

    if (current === '-h' || current === '--help') {
      args.help = true;
      continue;
    }

    if (current === '-k' || current === '--key') {
      args.key = argv[i + 1] || '';
      i += 1;
      continue;
    }

    if (current === '-v' || current === '--value') {
      args.value = argv[i + 1] || '';
      i += 1;
      continue;
    }

    if (current === '-f' || current === '--file') {
      args.file = argv[i + 1] || '';
      i += 1;
      continue;
    }

    if (current === '-r' || current === '--repo') {
      args.repo = argv[i + 1] || DEFAULT_REPO;
      i += 1;
      continue;
    }

    if (current === '-e' || current === '--env') {
      args.env = argv[i + 1] || '';
      i += 1;
      continue;
    }

    if (current === '--dry-run') {
      args.dryRun = true;
      continue;
    }

    if (current === '--include-empty') {
      args.includeEmpty = true;
      continue;
    }
  }

  return args;
}

function printHelp() {
  console.log(`
Usage:
  npm run env-gh-secret-sync -- -k KEY -v VALUE
  npm run env-gh-secret-sync -- -f /path/to/source.env

Options:
  -k, --key            Single secret key (uppercase style)
  -v, --value          Value for single secret
  -f, --file           Source env file to sync
  -r, --repo           GitHub repo in owner/name format (default: ${DEFAULT_REPO})
  -e, --env            GitHub Environment name (optional). If provided, sets environment secrets.
      --dry-run        Print planned operations without updating GitHub
      --include-empty  Include empty values from file (default: skip empty)
  -h, --help           Show this help

Examples:
  npm run env-gh-secret-sync -- -k REDIS_URL -v rediss://...
  npm run env-gh-secret-sync -- -f .env.production
  npm run env-gh-secret-sync -- -f .env.production -r whyops-org/be -e production
`.trim());
}

function validateEnvKey(key) {
  return /^[A-Z][A-Z0-9_]*$/.test(key);
}

function trimWhitespace(value) {
  return value.replace(/^\s+|\s+$/g, '');
}

function stripSurroundingQuotes(value) {
  if (value.length < 2) return value;
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function parseEnvFile(content, includeEmpty) {
  const lines = content.split(/\r?\n/);
  const map = new Map();

  for (const rawLine of lines) {
    const line = trimWhitespace(rawLine);
    if (!line || line.startsWith('#')) continue;

    const normalized = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eqIndex = normalized.indexOf('=');
    if (eqIndex <= 0) continue;

    const key = trimWhitespace(normalized.slice(0, eqIndex));
    let value = trimWhitespace(normalized.slice(eqIndex + 1));
    value = stripSurroundingQuotes(value);

    if (!validateEnvKey(key)) continue;
    if (!includeEmpty && value === '') continue;

    map.set(key, value);
  }

  return Array.from(map.entries()).map(([key, value]) => ({ key, value }));
}

function runGh(args) {
  const out = spawnSync('gh', args, { encoding: 'utf8' });
  return out;
}

function assertGhAvailable() {
  const out = runGh(['--version']);
  if (out.status !== 0) {
    console.error('gh CLI not found. Install: https://cli.github.com/');
    process.exit(1);
  }
}

function assertRepoAccess(repo) {
  const out = runGh(['repo', 'view', repo]);
  if (out.status !== 0) {
    const msg = (out.stderr || out.stdout || '').trim();
    console.error(`Cannot access repo ${repo}. Ensure: gh auth login`);
    if (msg) {
      console.error(msg);
    }
    process.exit(1);
  }
}

function setSecret({ repo, envName, key, value, dryRun }) {
  const commandPreview = `gh secret set ${key} --repo ${repo}${envName ? ` --env ${envName}` : ''} --body ***`;
  if (dryRun) {
    console.log(`[dry-run] ${commandPreview}`);
    return { ok: true };
  }

  const args = ['secret', 'set', key, '--repo', repo, '--body', value];
  if (envName) {
    args.push('--env', envName);
  }

  const out = runGh(args);
  if (out.status !== 0) {
    return {
      ok: false,
      error: (out.stderr || out.stdout || '').trim() || 'gh secret set failed',
    };
  }
  return { ok: true };
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const singleMode = Boolean(args.key) || args.value !== '';
  const fileMode = Boolean(args.file);

  if ((singleMode && fileMode) || (!singleMode && !fileMode)) {
    console.error('Use either -k/-v for single secret OR -f for file sync.');
    console.error('Run: npm run env-gh-secret-sync -- --help');
    process.exit(1);
  }

  let pairs = [];

  if (fileMode) {
    const sourcePath = path.isAbsolute(args.file) ? args.file : path.join(process.cwd(), args.file);
    if (!fs.existsSync(sourcePath)) {
      console.error(`Source file not found: ${sourcePath}`);
      process.exit(1);
    }

    const content = fs.readFileSync(sourcePath, 'utf8');
    pairs = parseEnvFile(content, args.includeEmpty);

    if (pairs.length === 0) {
      console.error('No valid key/value pairs found in source file.');
      process.exit(1);
    }
  } else {
    if (!args.key || args.value === '') {
      console.error('Single mode requires both -k and -v.');
      process.exit(1);
    }
    if (!validateEnvKey(args.key)) {
      console.error('Invalid key. Use uppercase env style, e.g. REDIS_URL');
      process.exit(1);
    }
    pairs = [{ key: args.key, value: args.value }];
  }

  assertGhAvailable();
  assertRepoAccess(args.repo);

  const scopeText = args.env ? `environment '${args.env}'` : 'repository';
  console.log(`Syncing ${pairs.length} secret(s) to ${scopeText} secrets in ${args.repo}...`);

  let updated = 0;
  let failed = 0;

  for (const pair of pairs) {
    const result = setSecret({
      repo: args.repo,
      envName: args.env,
      key: pair.key,
      value: pair.value,
      dryRun: args.dryRun,
    });

    if (result.ok) {
      updated += 1;
      console.log(`✓ ${pair.key}`);
    } else {
      failed += 1;
      console.error(`✗ ${pair.key}: ${result.error}`);
    }
  }

  console.log(`Done. Updated: ${updated}, Failed: ${failed}, Total: ${pairs.length}`);
  if (failed > 0) {
    process.exit(1);
  }
}

main();
