import { describe, expect, test } from 'bun:test';
import { settingsDict as en } from './en.settings';
import { settingsDict as es } from './es.settings';
import { settingsDict as fr } from './fr.settings';
import { settingsDict as ja } from './ja.settings';
import { settingsDict as ko } from './ko.settings';
import { settingsDict as pl } from './pl.settings';
import { settingsDict as ptBR } from './pt-BR.settings';
import { settingsDict as uk } from './uk.settings';
import { settingsDict as zhCN } from './zh-CN.settings';
import { settingsDict as zhTW } from './zh-TW.settings';

const dictionaries = [en, es, fr, ja, ko, pl, ptBR, uk, zhCN, zhTW] as const;
const keys = [
  'settings.openchamber.permissionAutoAccept.title',
  'settings.openchamber.permissionAutoAccept.info',
  'settings.openchamber.permissionAutoAccept.field.globalLabel',
  'settings.openchamber.permissionAutoAccept.field.globalAria',
  'settings.openchamber.permissionAutoAccept.field.globalWarning',
  'settings.openchamber.permissionAutoAccept.dialog.title',
  'settings.openchamber.permissionAutoAccept.dialog.description',
  'settings.openchamber.permissionAutoAccept.dialog.confirm',
] as const;

describe('permission auto-accept settings locales', () => {
  test('define every new sessions-page key in every locale dictionary', () => {
    for (const dict of dictionaries) {
      for (const key of keys) {
        expect(typeof dict[key]).toBe('string');
        expect(dict[key].trim().length).toBeGreaterThan(0);
      }
    }
  });
});
