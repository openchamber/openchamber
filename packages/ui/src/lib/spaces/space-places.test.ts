import { describe, expect, it } from 'bun:test';
import { orderedSpacePlaces, selectedSpacePlace, spacePlaceName } from './space-places';
import type { SpacePlace } from './spaces-api';

const place = (kind: SpacePlace['kind'], available = true): SpacePlace => available ? {
  id: kind, kind, available, hostIsolation: kind !== 'host-root', machine: null, setup: null,
  rootActivation: kind === 'host-root' ? { available: true, reason: null, origins: ['https://host.test'] } : null, version: '',
} : { id: kind, kind, available, code: 'unavailable', message: 'Unavailable', machine: null, setup: null, rootActivation: null };

describe('place choice', () => {
  it('orders the host before Docker and keeps root last regardless of the server order', () => {
    // Given / When
    const places = orderedSpacePlaces([place('host-root'), place('docker'), place('host')]);
    // Then
    expect(places.map((entry) => entry.id)).toEqual(['host', 'docker', 'host-root']);
    expect(selectedSpacePlace(places, null)?.id).toBe('host');
  });

  it('chooses available Docker when the isolated host is down', () => {
    // Given / When
    const selected = selectedSpacePlace([place('host-root'), place('host', false), place('docker')], null);
    // Then
    expect(selected?.kind).toBe('docker');
  });

  it('shows the first unavailable isolated place when root alone is available', () => {
    // Given / When
    const selected = selectedSpacePlace([place('host-root'), place('docker', false), place('host', false)], null);
    // Then
    expect(selected).toMatchObject({ kind: 'host', available: false });
  });

  it('selects nothing when only root exists, including after an old selection disappears', () => {
    // Given / When / Then
    expect(selectedSpacePlace([place('host-root')], null)).toBeNull();
    expect(selectedSpacePlace([place('host-root')], 'docker')).toBeNull();
    expect(selectedSpacePlace([place('host'), place('host-root')], 'docker')).toBeNull();
  });

  it('retains root only when the person explicitly selects it', () => {
    // Given / When
    const selected = selectedSpacePlace([place('host'), place('host-root')], 'host-root');
    // Then
    expect(selected?.kind).toBe('host-root');
  });

  it('names a remote Docker machine and distinguishes the host kinds', () => {
    // Given
    const t = (key: string) => key;
    // When / Then
    expect(spacePlaceName(t, { kind: 'docker', machine: 'me@builder' })).toBe('me@builder');
    expect(spacePlaceName(t, { kind: 'host', machine: null })).toBe('spaces.place.host');
    expect(spacePlaceName(t, { kind: 'host-root', machine: null })).toBe('spaces.place.root');
  });
});
