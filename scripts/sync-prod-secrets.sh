#!/usr/bin/env bash
set -euo pipefail

REPO="whyops-org/be"
ENV_FILE=".env.production"

if ! command -v gh >/dev/null 2>&1; then
  echo "gh CLI not found. Install from https://cli.github.com/ and login first." >&2
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE in repo root." >&2
  exit 1
fi

if ! gh repo view "$REPO" >/dev/null 2>&1; then
  echo "Cannot access $REPO. Run: gh auth login" >&2
  exit 1
fi

updated=0
skipped=0

while IFS= read -r line || [[ -n "$line" ]]; do
  # Trim leading/trailing whitespace
  line="${line#${line%%[![:space:]]*}}"
  line="${line%${line##*[![:space:]]}}"

  # Skip blank lines and comments
  if [[ -z "$line" || "$line" == \#* ]]; then
    continue
  fi

  # Allow optional 'export '
  line="${line#export }"

  # Require key=value
  if [[ "$line" != *"="* ]]; then
    echo "Skipping invalid line: $line" >&2
    skipped=$((skipped + 1))
    continue
  fi

  key="${line%%=*}"
  value="${line#*=}"

  # Trim key/value whitespace
  key="${key#${key%%[![:space:]]*}}"
  key="${key%${key##*[![:space:]]}}"
  value="${value#${value%%[![:space:]]*}}"
  value="${value%${value##*[![:space:]]}}"

  # Strip surrounding quotes
  if [[ "$value" == "\""*"\"" ]]; then
    value="${value:1:${#value}-2}"
  elif [[ "$value" == "'"*"'" ]]; then
    value="${value:1:${#value}-2}"
  fi

  if [[ -z "$key" ]]; then
    skipped=$((skipped + 1))
    continue
  fi

  if [[ -z "$value" ]]; then
    echo "Skipping $key (empty value)" >&2
    skipped=$((skipped + 1))
    continue
  fi

  gh secret set "$key" --repo "$REPO" --body "$value"
  updated=$((updated + 1))

  # Avoid triggering GitHub rate limits on large files
  sleep 0.05
done < "$ENV_FILE"

echo "Updated $updated secrets in $REPO (skipped $skipped)"
