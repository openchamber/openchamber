import { describe, expect, test } from 'bun:test';

import { getHiddenDevServerPorts, hideDevServerPort, showHiddenDevServerPorts } from './hiddenDevServers';

describe('hidden dev server ports', () => {
  test('hides a port once, keeps them sorted, and shows them all again', () => {
    showHiddenDevServerPorts();
    hideDevServerPort(6463);
    hideDevServerPort(135);
    hideDevServerPort(6463);
    expect(getHiddenDevServerPorts()).toEqual([135, 6463]);

    showHiddenDevServerPorts();
    expect(getHiddenDevServerPorts()).toEqual([]);
  });
});
