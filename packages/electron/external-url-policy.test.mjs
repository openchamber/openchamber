import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAutoOpenableExternalUrl, parseExternalUrl } from './external-url-policy.mjs';

test('preserves editor file paths, safe mail links, lines and columns for the OS handler', () => {
  for (const url of [
    'vscode://file/Users/person/Project/package.json:7',
    'vscode://file/C:/Project/src/PlayerData.luau:42:3',
    'cursor://file/C:/Project/src/a%20b.ts:12',
    'obsidian://open?vault=Notebook&file=a%20b',
    'https://example.test/path',
    'http://localhost:3901/',
    'mailto:user@example.test',
    'mailto:user@example.test?subject=Hello%20World',
    'mailto:user@example.test?subject=Hi&body=Line%201%0ALine%202',
  ]) {
    assert.equal(parseExternalUrl(url).toString(), url);
  }
  assert.equal(parseExternalUrl('VSCODE://file/C:/Project/a.ts:1').protocol, 'vscode:');
  assert.equal(parseExternalUrl('MAILTO:user@example.test').protocol, 'mailto:');
});

test('rejects dangerous, internal and non-app protocols at the native boundary', () => {
  for (const url of [
    'javascript:alert(1)', 'data:text/html,test', 'vbscript:msgbox(1)',
    'blob:https://example.test/id', 'filesystem:https://example.test/file', 'about:blank',
    'chrome://settings', 'chrome-extension://id/page', 'devtools://page',
    'moz-extension://id/page', 'ms-browser-extension://id/page', 'file:///etc/passwd',
    'ws://localhost', 'wss://example.test', 'ftp://example.test', 'ftps://example.test',
    'intent://scan/', 'ms-msdt:/id%20PCWDiagnostic', 'search-ms:query=report', 'shell:AppsFolder',
    'openchamber://connect?host=x', 'openchamber-ui://app/index.html', 'capacitor://localhost',
    'tel:+123', 'sms:+123', 'callto:+123', 'cid:id',
    'xmpp:user@example.test', 'irc://example.test', 'news:group', 'nntp://example.test',
    'feed:https://example.test', 'webcal://example.test/calendar', '', 'not a url', 'a://file',
  ]) {
    assert.throws(() => parseExternalUrl(url), undefined, url);
  }
});

test('rejects mail links that could pass headers or arguments to the mail client', () => {
  for (const url of [
    'mailto:',
    'mailto://user@example.test',
    'mailto:user@example.test?attach=/etc/passwd',
    'mailto:user@example.test?Attachment=C:/secret.txt',
    'mailto:user@example.test?%61ttach=/etc/passwd',
    'mailto:user@example.test?x-custom=1',
    'mailto:user@example.test?subject=Hi%0d%0aBcc:evil@example.test',
    'mailto:user@example.test?body=ok%00bad',
    'mailto:user@example.test" --arg=evil',
    'mailto:user@example.test\r\n',
  ]) {
    assert.throws(() => parseExternalUrl(url), undefined, url);
  }
});

test('allows only normalized http and https for automatic navigation and popup fallbacks', () => {
  for (const [url, expected] of [
    ['https://example.test/path?x=1', 'https://example.test/path?x=1'],
    ['http://example.test/', 'http://example.test/'],
    ['HTTPS://EXAMPLE.TEST/UPPER', 'https://example.test/UPPER'],
    [' https://example.test/trimmed ', 'https://example.test/trimmed'],
  ]) {
    assert.equal(parseAutoOpenableExternalUrl(url)?.toString(), expected, url);
  }
  for (const url of [
    'mailto:user@example.test',
    'vscode://file/Users/person/Project/package.json:7',
    'ms-msdt:/id%20PCWDiagnostic',
    'search-ms:query=report',
    'file:///etc/passwd',
    'smb://files.example.test/share',
    'ssh://user@example.test',
    'ms-officecmd:ofe|u|https://example.test/doc.docx',
    'javascript:alert(1)',
    'evil-test://payload',
    'openchamber://connect?host=x',
    'https://example.test/a\r\nb',
    'https://example.test/a\u0000b',
    'https:\\\\example.test/',
    'http:example.test',
    'http:///etc/passwd',
    '',
    'not a url',
  ]) {
    assert.equal(parseAutoOpenableExternalUrl(url), null, url);
  }
});
