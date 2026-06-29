# Files preview auth refresh

## Goal
Stop right-sidebar file previews from remounting when `oc_url_token` rotates.

## Findings
- `packages/ui/src/components/views/FilesView.tsx` uses a shared `useAssetAuthRefresh(...)` hook for HTML, image, and PDF previews.
- That hook subscribes to `subscribeRuntimeUrlAuthToken(...)` and increments a nonce whenever the token is replaced.
- The nonce is used as the React `key` for the `<iframe>` / `<img>` preview elements, so every token replacement remounts the preview.
- `packages/ui/src/lib/runtime-auth.ts` proactively refreshes the URL token on a cadence, so the remount happens periodically even when the file did not change.
- PR #1694 confirmed the correct direction is centralized token refresh in `runtime-auth`, not feature-local auth churn.

## Desired behavior
- Preview lifecycle should depend on the selected file and preview mode, not on URL-token replacement.
- Auth refresh should remain centralized and transparent to the UI.
- HTML, image, and PDF previews should share the same stable behavior.

## Notes
- This is an investigation/planning branch only.
- The eventual implementation likely needs a stable preview transport, not a per-token remount.
