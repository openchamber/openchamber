#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-artifact}"
VERSION="${2:-}"
REF="${3:-}"

if ! command -v gh >/dev/null 2>&1; then
  echo "gh CLI is required"
  exit 1
fi

ARGS=("workflow" "run" "mobile-release.yml")

if [[ -n "$REF" ]]; then
  ARGS+=("--ref" "$REF")
fi

if [[ -n "$VERSION" ]]; then
  ARGS+=("-f" "version=$VERSION")
fi

case "$MODE" in
  artifact)
    ARGS+=("-f" "build_android=true")
    ARGS+=("-f" "build_ios=true")
    ARGS+=("-f" "publish_github_release=false")
    ARGS+=("-f" "upload_play_internal=false")
    ARGS+=("-f" "upload_testflight=false")
    ARGS+=("-f" "publish_fdroid_repo=false")
    ;;
  full)
    ARGS+=("-f" "build_android=true")
    ARGS+=("-f" "build_ios=true")
    ARGS+=("-f" "publish_github_release=true")
    ARGS+=("-f" "upload_play_internal=true")
    ARGS+=("-f" "upload_testflight=true")
    ARGS+=("-f" "publish_fdroid_repo=true")
    ;;
  fdroid)
    ARGS+=("-f" "build_android=true")
    ARGS+=("-f" "build_ios=false")
    ARGS+=("-f" "publish_github_release=false")
    ARGS+=("-f" "upload_play_internal=false")
    ARGS+=("-f" "upload_testflight=false")
    ARGS+=("-f" "publish_fdroid_repo=true")
    ;;
  *)
    echo "Unknown mode: $MODE"
    echo "Modes: artifact | full | fdroid"
    exit 1
    ;;
esac

gh "${ARGS[@]}"
