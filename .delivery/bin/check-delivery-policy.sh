#!/bin/sh
set -eu

sop_script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
sop_project_root=$(CDPATH= cd -- "$sop_script_dir/../.." && pwd)
sop_policy_path="$sop_project_root/.delivery/policy.yaml"

if [ ! -f "$sop_policy_path" ]; then
  echo "PROJECT_POLICY_MISSING" >&2
  exit 65
fi

sop_runner_path_value=$(awk '$1 == "path:" { print $2; exit }' "$sop_policy_path" | tr -d "\"'")
sop_runner_digest=$(awk '$1 == "sha256:" { print $2; exit }' "$sop_policy_path" | tr -d "\"'")

case "$sop_runner_path_value" in
  .delivery/runtime/engineering-governance-*.tgz) ;;
  *)
    echo "RUNNER_ARCHIVE_INVALID" >&2
    exit 65
    ;;
esac

if [ "${#sop_runner_digest}" -ne 64 ]; then
  echo "RUNNER_DIGEST_INVALID" >&2
  exit 65
fi
case "$sop_runner_digest" in
  *[!a-f0-9]*)
    echo "RUNNER_DIGEST_INVALID" >&2
    exit 65
    ;;
esac

sop_runner_path="$sop_project_root/$sop_runner_path_value"
if [ ! -f "$sop_runner_path" ]; then
  echo "RUNNER_ARCHIVE_MISSING" >&2
  exit 65
fi

if command -v shasum >/dev/null 2>&1; then
  sop_actual_digest=$(shasum -a 256 "$sop_runner_path" | awk '{ print $1 }')
elif command -v sha256sum >/dev/null 2>&1; then
  sop_actual_digest=$(sha256sum "$sop_runner_path" | awk '{ print $1 }')
else
  echo "SHA256_TOOL_MISSING" >&2
  exit 69
fi

if [ "$sop_actual_digest" != "$sop_runner_digest" ]; then
  echo "RUNNER_DIGEST_MISMATCH" >&2
  exit 65
fi

sop_temporary_prefix=$(mktemp -d "${TMPDIR:-/tmp}/engineering-governance.XXXXXX")
cleanup_sop_prefix() {
  rm -rf -- "$sop_temporary_prefix"
}
trap cleanup_sop_prefix EXIT HUP INT TERM

export npm_config_cache="$sop_temporary_prefix/cache"
export npm_config_ignore_scripts=true
export npm_config_offline=true
export npm_config_registry=http://127.0.0.1:9
export npm_config_userconfig="$sop_temporary_prefix/npmrc"

if [ -x /opt/homebrew/opt/node@22/bin/node ]; then
  PATH="/opt/homebrew/opt/node@22/bin:$PATH"
  export PATH
elif [ -x /usr/local/opt/node@22/bin/node ]; then
  PATH="/usr/local/opt/node@22/bin:$PATH"
  export PATH
fi

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "NODE_22_RUNTIME_MISSING" >&2
  exit 69
fi
sop_node_version=$(node -p 'process.versions.node')
case "$sop_node_version" in
  22.*) ;;
  *)
    echo "NODE_VERSION_UNSUPPORTED:$sop_node_version" >&2
    exit 69
    ;;
esac

npm install --offline --ignore-scripts --no-audit --no-fund \
  --prefix "$sop_temporary_prefix" "$sop_runner_path" >/dev/null

node "$sop_temporary_prefix/node_modules/@xgh/engineering-governance/dist/cli/main.js" \
  check "$sop_project_root" --json
