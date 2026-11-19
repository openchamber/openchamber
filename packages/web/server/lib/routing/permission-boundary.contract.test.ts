import { expect, it } from 'vitest';
import { translateWireEvent } from '../event-stream/translate-v2.js';
import { buildPermissionRequest } from './jev.js';

it('forwards translated JSON permission fields without claiming string resources or object metadata', () => {
  const [event] = translateWireEvent({
    type: 'permission.asked',
    data: { id: 'permission', sessionID: 'session', resources: [17, null, { pattern: '*' }], metadata: null },
  });
  if (event?.type !== 'permission.asked') throw new Error('Expected a permission event');
  const properties = event.properties;
  if (!properties.id || !properties.sessionID) throw new Error('Expected permission identity');
  const request = buildPermissionRequest({ ...properties, id: properties.id, sessionID: properties.sessionID });
  expect(request.state).toEqual({
    permission: { type: '', patterns: [17, null, { pattern: '*' }], metadata: null },
  });
});
