import { describe, expect, test } from 'bun:test';

import { dict as en } from './en';
import { dict as es } from './es';
import { dict as fr } from './fr';
import { dict as ko } from './ko';
import { dict as pl } from './pl';
import { dict as ptBR } from './pt-BR';
import { dict as uk } from './uk';
import { dict as zhCN } from './zh-CN';
import { dict as zhTW } from './zh-TW';
import { dict as ja } from './ja';

const REQUIRED_KEYS = [
    'chat.toolGroup.context.title.active',
    'chat.toolGroup.context.title.done',
    'chat.toolGroup.context.title.failed',
    'chat.toolGroup.context.summary.readSingle',
    'chat.toolGroup.context.summary.searchSingle',
    'chat.toolGroup.context.summary.listSingle',
    'chat.toolGroup.context.summary.readPluralFew',
    'chat.toolGroup.context.summary.readPluralMany',
    'chat.toolGroup.context.summary.searchPluralFew',
    'chat.toolGroup.context.summary.searchPluralMany',
    'chat.toolGroup.context.summary.listPluralFew',
    'chat.toolGroup.context.summary.listPluralMany',
    'chat.toolGroup.context.child.active',
    'chat.toolGroup.context.child.error',
    'chat.toolGroup.context.child.read',
    'chat.toolGroup.context.child.search',
    'chat.toolGroup.context.child.list',
    'chat.toolGroup.context.actions.expandWithSummary',
    'chat.toolGroup.context.actions.collapseWithSummary',
] as const;

const dictionaries = {
    en,
    es,
    fr,
    ko,
    pl,
    'pt-BR': ptBR,
    uk,
    'zh-CN': zhCN,
    'zh-TW': zhTW,
    ja,
};

describe('context tool group i18n messages', () => {
    test('all main locale dictionaries define the context group keys', () => {
        for (const dict of Object.values(dictionaries)) {
            for (const key of REQUIRED_KEYS) {
                const message = dict[key];
                expect(typeof message).toBe('string');
                expect(message.trim()).not.toBe('');
            }
        }
    });
});
