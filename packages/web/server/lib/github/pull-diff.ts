// The pull request diff read under the fork's byte cap (#1664). The raw body
// stream is judged while it arrives: an over-cap Content-Length is refused up
// front and the stream is cancelled as soon as the bytes cross the cap, so an
// over-cap diff is never held whole, served or cached. Upstream's provider
// split read the whole diff as a string; this came from the fork's
// github/routes.js.

import { readBoundedResponseText } from '../shared/response-body.js';
import { invalidProviderPayload } from './mappers.js';
import type { Octokit } from '@octokit/rest';

const PULL_DIFF_MAX_BYTES = 50 * 1024 * 1024;

const isReadableStream = (value: unknown): value is ReadableStream<Uint8Array<ArrayBuffer>> => value instanceof ReadableStream;

/** The error the context route answers with: 413 and `Pull request diff is too large to serve`. */
const diffTooLarge = () => Object.assign(new Error('Pull request diff is too large to serve'), { status: 413 });

export async function readPullDiff(octokit: Octokit, repo: { owner: string; repo: string }, number: number): Promise<string> {
  const response = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
    owner: repo.owner,
    repo: repo.repo,
    pull_number: number,
    headers: { accept: 'application/vnd.github.v3.diff' },
    request: { parseSuccessResponseBody: false },
  });
  const body: unknown = response?.data;
  if (!isReadableStream(body)) throw invalidProviderPayload('GitHub returned an invalid pull request diff');
  const headers = response.headers;
  const read = await readBoundedResponseText({
    headers: new Headers(Object.entries(headers).flatMap(([name, value]) => (value === undefined ? [] : [[name, String(value)]]))),
    body,
  }, PULL_DIFF_MAX_BYTES);
  if (read.tooLarge) throw diffTooLarge();
  return read.text;
}
