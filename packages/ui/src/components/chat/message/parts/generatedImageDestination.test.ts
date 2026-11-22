import { describe, expect, test } from 'bun:test';

import { generatedImageDestination } from './generatedImageDestination';

describe('generatedImageDestination', () => {
  test('keeps a path with spaces one destination', () => {
    expect(generatedImageDestination('/tmp/my images/hero.png')).toBe('![](</tmp/my images/hero.png>)');
  });

  test('turns a Windows path into a file URL, since Markdown reads C: as a scheme', () => {
    expect(generatedImageDestination('C:\\Users\\me\\AppData\\Local\\Temp\\opencode\\a.png'))
      .toBe('![](<file:///C:/Users/me/AppData/Local/Temp/opencode/a.png>)');
  });
});
