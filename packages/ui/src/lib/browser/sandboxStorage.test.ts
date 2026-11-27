import { expect, test } from 'bun:test';
import { injectPreviewBridge } from '../../../../web/server/lib/fs/preview-bridge';
import { SANDBOX_STORAGE_SCRIPT } from './sandboxStorage';

test('chat pages and file previews get the same storage', () => {
  expect(injectPreviewBridge(Buffer.from('<p>x</p>')).toString()).toContain(SANDBOX_STORAGE_SCRIPT);
});
