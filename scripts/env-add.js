#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = {
    key: '',
    value: '',
    file: '',
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
  }

  return args;
}

function validateEnvKey(key) {
  return /^[A-Z][A-Z0-9_]*$/.test(key);
}

function readIfExists(filePath) {
  if (!fs.existsSync(filePath)) {
    return '';
  }

  return fs.readFileSync(filePath, 'utf8');
}

function ensureTrailingNewline(content) {
  return content.endsWith('\n') ? content : `${content}\n`;
}

function upsertEnvKeyValue(content, key, value) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${escapedKey}=.*$`, 'm');
  const line = `${key}=${value}`;

  if (pattern.test(content)) {
    return content.replace(pattern, line);
  }

  const normalized = ensureTrailingNewline(content);
  return `${normalized}${line}\n`;
}

function ensureEnvExampleKey(content, key) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${escapedKey}=.*$`, 'm');

  if (pattern.test(content)) {
    return content;
  }

  const normalized = ensureTrailingNewline(content);
  return `${normalized}${key}=\n`;
}

function upsertEnvSchema(content, keys) {
  const schemaBlockPattern = /const envSchema = z\.object\(\{([\s\S]*?)\n\}\);/;
  const match = content.match(schemaBlockPattern);

  if (!match) {
    throw new Error('Could not find envSchema object in shared/src/config/env.ts');
  }

  const objectBody = match[1];
  let updatedBody = objectBody;

  for (const key of keys) {
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const fieldPattern = new RegExp(`^\\s*${escapedKey}:\\s*.*,$`, 'm');
    const schemaField = `  ${key}: z.string().optional(),`;

    if (!fieldPattern.test(updatedBody)) {
      updatedBody = `${updatedBody}\n${schemaField}`;
    }
  }

  return content.replace(schemaBlockPattern, `const envSchema = z.object({${updatedBody}\n});`);
}

function parseEnvLines(content) {
  const lines = content.split(/\r?\n/);
  const parsed = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line;
    const match = withoutExport.match(/^([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!match) {
      continue;
    }

    const key = match[1];
    const value = match[2];
    if (!validateEnvKey(key)) {
      continue;
    }

    parsed.push({ key, value });
  }

  return parsed;
}

function printHelp() {
  console.log(`
Usage:
  npm run env-add -- -k KEY -v VALUE
  npm run env-add -- -f /path/to/source.env

Options:
  -k, --key      Single env key (uppercase style)
  -v, --value    Value for single key
  -f, --file     Source env file to bulk sync
  -h, --help     Show this help

Behavior:
  - Updates/appends keys in .env
  - Ensures keys exist in .env.example (empty value)
  - Ensures keys exist in shared/src/config/env.ts as z.string().optional()
`.trim());
}

function writeFile(filePath, content) {
  fs.writeFileSync(filePath, content, 'utf8');
}

function main() {
  const { key, value, file, help } = parseArgs(process.argv.slice(2));

  if (help) {
    printHelp();
    process.exit(0);
  }

  const hasSingle = Boolean(key) || value !== '';
  const hasFile = Boolean(file);

  if ((hasSingle && hasFile) || (!hasSingle && !hasFile)) {
    console.error('Use either -k/-v for single key, or -f for bulk file sync.');
    console.error('Run: npm run env-add -- --help');
    process.exit(1);
  }

  const root = process.cwd();
  const envPath = path.join(root, '.env');
  const envExamplePath = path.join(root, '.env.example');
  const envTsPath = path.join(root, 'shared', 'src', 'config', 'env.ts');

  const envContent = readIfExists(envPath);
  const envExampleContent = readIfExists(envExamplePath);
  const envTsContent = readIfExists(envTsPath);

  let pairs = [];

  if (hasFile) {
    const sourcePath = path.isAbsolute(file) ? file : path.join(root, file);
    if (!fs.existsSync(sourcePath)) {
      console.error(`Source env file not found: ${sourcePath}`);
      process.exit(1);
    }

    const sourceContent = readIfExists(sourcePath);
    pairs = parseEnvLines(sourceContent);
    if (pairs.length === 0) {
      console.error('No valid env key/value pairs found in source file.');
      process.exit(1);
    }
  } else {
    if (!key || value === '') {
      console.error('Usage: npm run env-add -- -k KEY -v VALUE');
      process.exit(1);
    }

    if (!validateEnvKey(key)) {
      console.error('Invalid key. Use uppercase environment variable style, e.g. MY_NEW_KEY');
      process.exit(1);
    }

    pairs = [{ key, value }];
  }

  let updatedEnv = envContent;
  let updatedEnvExample = envExampleContent;
  const keys = [];

  for (const pair of pairs) {
    updatedEnv = upsertEnvKeyValue(updatedEnv, pair.key, pair.value);
    updatedEnvExample = ensureEnvExampleKey(updatedEnvExample, pair.key);
    if (!keys.includes(pair.key)) {
      keys.push(pair.key);
    }
  }

  const updatedEnvTs = upsertEnvSchema(envTsContent, keys);

  writeFile(envPath, updatedEnv);
  writeFile(envExamplePath, updatedEnvExample);
  writeFile(envTsPath, updatedEnvTs);

  if (hasFile) {
    console.log(`Synced ${keys.length} keys from ${file} into .env, .env.example, and shared/src/config/env.ts`);
  } else {
    console.log(`Added/updated ${key} in .env, .env.example, and shared/src/config/env.ts`);
  }
}

main();
