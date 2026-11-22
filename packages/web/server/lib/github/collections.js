// Shared collection readers for GitHub REST collections (design #1528,
// phase 1: issue #1529). A collection read is complete, or it says so:
// each reader paginates to a short page under a named cap, probes one
// page past the cap, and errors when the probe is non-empty, so a
// partial list is never returned as if it were complete. The contract
// these readers embody is stated in DOCUMENTATION.md
// ("Collection completeness"); GitLab and Linear collection results
// state completeness in the same shape.

export const GITHUB_PR_CONTEXT_PAGE_SIZE = 100;
const GITHUB_PR_CONTEXT_MAX_PAGES = 20;
const GITHUB_PR_CONTEXT_MAX_COUNT = GITHUB_PR_CONTEXT_PAGE_SIZE * GITHUB_PR_CONTEXT_MAX_PAGES;
export const GITHUB_CHECK_RUN_PAGE_SIZE = 100;
const GITHUB_CHECK_RUN_MAX_PAGES = 20;
const GITHUB_CHECK_RUN_MAX_COUNT = GITHUB_CHECK_RUN_PAGE_SIZE * GITHUB_CHECK_RUN_MAX_PAGES;
export const GITHUB_CHECK_RUN_ANNOTATION_PAGE_SIZE = 100;
const GITHUB_CHECK_RUN_ANNOTATION_MAX_PAGES = 20;
const GITHUB_CHECK_RUN_ANNOTATION_MAX_COUNT = GITHUB_CHECK_RUN_ANNOTATION_PAGE_SIZE * GITHUB_CHECK_RUN_ANNOTATION_MAX_PAGES;

function invalidProviderPayload(message) {
  const error = new Error(message);
  error.code = 'MALFORMED_PROVIDER_RESPONSE';
  return error;
}

function requireProviderArray(value, message) {
  if (!Array.isArray(value)) throw invalidProviderPayload(message);
  return value;
}

// Reads one /pulls/context collection page by page until a short page,
// under the same named-cap discipline as the branches route in routes.js: one
// probe past the cap, and an explicit error when the probe is non-empty,
// so a partial list is never returned as if it were complete (#1375).
export async function readPullContextCollection(label, invalidMessage, fetchPage) {
  const items = [];
  for (let page = 1; page <= GITHUB_PR_CONTEXT_MAX_PAGES; page += 1) {
    const payload = requireProviderArray((await fetchPage(page))?.data, invalidMessage);
    items.push(...payload);
    if (payload.length < GITHUB_PR_CONTEXT_PAGE_SIZE) {
      return items;
    }
    if (page === GITHUB_PR_CONTEXT_MAX_PAGES) {
      const probe = requireProviderArray((await fetchPage(page + 1))?.data, invalidMessage);
      if (probe.length === 0) {
        return items;
      }
      throw new Error(`GitHub ${label} list reached the ${GITHUB_PR_CONTEXT_MAX_COUNT} safety limit and may be incomplete`);
    }
  }
  return items;
}

// Reads one { total_count, items } collection (check runs for a ref, jobs
// for a workflow run) page by page under the same named-cap discipline as
// readPullContextCollection (#1405): paginate to a short page, probe one
// page past the cap, and error when the probe is non-empty, so a partial
// list is never summarised as complete. total_count from the first page is
// honoured two ways: reading stops as soon as it is covered, and a short
// page that still leaves runs unread is an explicit error, not an ending.
export async function readTotalCountCollection(label, extract, fetchPage) {
  const items = [];
  let totalCount = null;
  for (let page = 1; page <= GITHUB_CHECK_RUN_MAX_PAGES; page += 1) {
    const data = (await fetchPage(page))?.data;
    const payload = extract(data);
    if (page === 1 && Number.isSafeInteger(data?.total_count) && data.total_count >= 0) {
      totalCount = data.total_count;
    }
    items.push(...payload);
    if (totalCount !== null && items.length >= totalCount) {
      return items;
    }
    if (payload.length < GITHUB_CHECK_RUN_PAGE_SIZE) {
      if (totalCount !== null && items.length < totalCount) {
        throw new Error(`GitHub ${label} list ended after ${items.length} of ${totalCount} entries and may be incomplete`);
      }
      return items;
    }
    if (page === GITHUB_CHECK_RUN_MAX_PAGES) {
      const probe = extract((await fetchPage(page + 1))?.data);
      if (probe.length === 0 && (totalCount === null || items.length >= totalCount)) {
        return items;
      }
      throw new Error(`GitHub ${label} list reached the ${GITHUB_CHECK_RUN_MAX_COUNT} safety limit and may be incomplete`);
    }
  }
  return items;
}

// Reads one check run's annotations page by page under the same named-cap
// discipline as readPullContextCollection (#1420): listAnnotations returns a
// plain array with no total_count, so pagination follows short pages, probes
// one page past the cap, and errors when the probe is non-empty. A page error
// propagates to the caller instead of silently returning the pages read so
// far as if they were the complete list.
export async function readCheckRunAnnotations(fetchPage) {
  const items = [];
  for (let page = 1; page <= GITHUB_CHECK_RUN_ANNOTATION_MAX_PAGES; page += 1) {
    const payload = requireProviderArray((await fetchPage(page))?.data, 'GitHub returned an invalid check run annotation list');
    items.push(...payload);
    if (payload.length < GITHUB_CHECK_RUN_ANNOTATION_PAGE_SIZE) {
      return items;
    }
    if (page === GITHUB_CHECK_RUN_ANNOTATION_MAX_PAGES) {
      const probe = requireProviderArray((await fetchPage(page + 1))?.data, 'GitHub returned an invalid check run annotation list');
      if (probe.length === 0) {
        return items;
      }
      throw new Error(`GitHub check run annotation list reached the ${GITHUB_CHECK_RUN_ANNOTATION_MAX_COUNT} safety limit and may be incomplete`);
    }
  }
  return items;
}
