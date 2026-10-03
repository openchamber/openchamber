import { describe, expect, it } from 'vitest';

import { unwrapOpenCodeResponse } from './response-envelope.js';

describe('unwrapOpenCodeResponse', () => {
  it('unwraps a single record sent as { data } alone', () => {
    expect(unwrapOpenCodeResponse({ data: { id: 'ses_1', parentID: 'ses_0' } })).toEqual({ id: 'ses_1', parentID: 'ses_0' });
  });

  it('unwraps a { location, data } answer', () => {
    expect(unwrapOpenCodeResponse({ location: { directory: '/repo' }, data: [{ name: 'review' }] })).toEqual([{ name: 'review' }]);
  });

  it('keeps a page envelope so its cursor stays readable', () => {
    const page = { data: [{ id: 'ses_1' }], cursor: { next: 'c1' } };
    expect(unwrapOpenCodeResponse(page)).toBe(page);
  });

  it('passes through what is not an envelope', () => {
    expect(unwrapOpenCodeResponse(null)).toBe(null);
    expect(unwrapOpenCodeResponse([1])).toEqual([1]);
  });
});
