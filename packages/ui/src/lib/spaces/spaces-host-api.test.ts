import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { grantSpaceAccess, listSpacePlaces, listSpaces } from './spaces-api';

const id = 'a1b2c3d4e5f6';
const entry = {
  id, name: 'Work', placeId: 'docker', projectDirectory: '/project', directory: `/spaces/${id}/project`,
  state: 'running', step: null, failure: null, network: { mode: 'open', domains: [] },
  grants: [], access: null, needsAccess: [],
};

const fetch = spyOn(globalThis, 'fetch');
afterEach(() => { fetch.mockReset(); });

describe('host place responses', () => {
  it('defaults legacy places and spaces to Docker when the new fields are absent', async () => {
    // Given
    fetch.mockResolvedValueOnce(Response.json({ places: [
      { id: 'docker', available: true, hostIsolation: true },
    ] })).mockResolvedValueOnce(Response.json({ spaces: [entry] }));
    // When
    const places = await listSpacePlaces();
    const spaces = await listSpaces();
    // Then
    expect(places[0]).toMatchObject({ kind: 'docker', rootActivation: null });
    expect(spaces[0]?.kind).toBe('docker');
  });

  it('keeps host places readable and root disabled when activation metadata is malformed', async () => {
    // Given
    fetch.mockResolvedValue(Response.json({ places: [
      { id: 'host', kind: 'host', available: true, hostIsolation: true },
      { id: 'host-root', kind: 'host-root', available: true, hostIsolation: false,
        rootActivation: { available: 'yes', reason: 42, origins: null } },
    ] }));
    // When
    const places = await listSpacePlaces();
    // Then
    expect(places.map((place) => place.kind)).toEqual(['host', 'host-root']);
    expect(places[1]?.rootActivation).toEqual({ available: false, reason: null, origins: [] });
  });

  it('parses an MCP grant on a host space and sends only its connection and name', async () => {
    // Given
    const grant = { id: 'mcp-github', kind: 'mcp', connection: 'pmcp_0123456789abcdef', name: 'github' };
    fetch.mockResolvedValueOnce(Response.json({ spaces: [{ ...entry, kind: 'host', grants: [grant] }] }))
      .mockResolvedValueOnce(Response.json({ grant }));
    // When
    const spaces = await listSpaces();
    const given = await grantSpaceAccess(id, { kind: 'mcp', connection: grant.connection, name: grant.name });
    // Then
    expect(spaces[0]?.grants).toEqual([grant]);
    expect(given).toEqual(grant);
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({ method: 'POST', body: JSON.stringify({ kind: 'mcp', connection: grant.connection, name: grant.name }) });
  });
});
