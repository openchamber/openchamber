import { expect, test } from 'bun:test';

import { closeAllBackLayers, registerBackLayer } from './mobileBackLayers';

test('closing all back layers closes every open sheet, topmost first', () => {
  const closed: string[] = [];
  const unregisterSheet = registerBackLayer(() => closed.push('attach sheet'));
  const unregisterDialog = registerBackLayer(() => closed.push('dialog'));

  closeAllBackLayers();

  expect(closed).toEqual(['dialog', 'attach sheet']);
  unregisterDialog();
  unregisterSheet();
});
