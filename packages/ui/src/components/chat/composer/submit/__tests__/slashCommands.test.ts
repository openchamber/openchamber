import { describe, expect, test } from 'bun:test';

import {
    buildCommandVariables,
    canRunCommand,
    findMagicPromptCommand,
    MAGIC_PROMPT_COMMANDS,
    parseSlashCommand,
} from '../slashCommands';

describe('parseSlashCommand', () => {
    test('reads a bare command', () => {
        expect(parseSlashCommand('/explore')).toEqual({ name: 'explore', argument: '' });
    });

    test('reads a command with an argument', () => {
        expect(parseSlashCommand('/summary rate limiting'))
            .toEqual({ name: 'summary', argument: 'rate limiting' });
    });

    test('leading whitespace is tolerated', () => {
        expect(parseSlashCommand('   /debug')).toEqual({ name: 'debug', argument: '' });
    });

    test('the name is lowercased but the argument keeps its casing', () => {
        expect(parseSlashCommand('/Summary Rate Limiting'))
            .toEqual({ name: 'summary', argument: 'Rate Limiting' });
    });

    test('a multi-line argument is preserved', () => {
        expect(parseSlashCommand('/craft-goal line one\nline two'))
            .toEqual({ name: 'craft-goal', argument: 'line one\nline two' });
    });

    test('ordinary prose is not a command', () => {
        expect(parseSlashCommand('explore the code')).toBeNull();
        expect(parseSlashCommand('see src/a.ts')).toBeNull();
        expect(parseSlashCommand('')).toBeNull();
    });

    test('a bare slash is not a command', () => {
        expect(parseSlashCommand('/')).toBeNull();
        expect(parseSlashCommand('/   ')).toBeNull();
    });
});

describe('findMagicPromptCommand', () => {
    test('finds a registered command', () => {
        expect(findMagicPromptCommand('explore')?.name).toBe('explore');
    });

    test('commands handled elsewhere are not prompt-pair commands', () => {
        // undo/redo/timeline/compact/handoff-review manipulate state or open
        // UI rather than sending a message.
        expect(findMagicPromptCommand('undo')).toBeNull();
        expect(findMagicPromptCommand('timeline')).toBeNull();
        expect(findMagicPromptCommand('compact')).toBeNull();
    });

    test('an unknown name finds nothing', () => {
        expect(findMagicPromptCommand('nope')).toBeNull();
    });
});

describe('canRunCommand', () => {
    const summary = findMagicPromptCommand('summary')!;
    const explore = findMagicPromptCommand('explore')!;

    test('summarizing needs an existing conversation', () => {
        expect(canRunCommand(summary, { hasSession: true, hasDraft: false })).toBe(true);
        expect(canRunCommand(summary, { hasSession: false, hasDraft: true })).toBe(false);
    });

    test('most commands also run from a new-session draft', () => {
        expect(canRunCommand(explore, { hasSession: false, hasDraft: true })).toBe(true);
        expect(canRunCommand(explore, { hasSession: true, hasDraft: false })).toBe(true);
    });

    test('nothing runs with neither', () => {
        expect(canRunCommand(explore, { hasSession: false, hasDraft: false })).toBe(false);
        expect(canRunCommand(summary, { hasSession: false, hasDraft: false })).toBe(false);
    });
});

describe('buildCommandVariables', () => {
    test('a command without an argument contributes no variables', () => {
        expect(buildCommandVariables(findMagicPromptCommand('explore')!, ''))
            .toEqual({ visible: {}, instructions: {} });
    });

    test('a summary topic reaches both prompts', () => {
        const variables = buildCommandVariables(findMagicPromptCommand('summary')!, 'auth');
        expect(variables.visible.topic_line).toBe(' focused on: auth');
        expect(variables.instructions.topic_block).toContain('auth');
    });

    test('an absent summary topic leaves both slots blank, not "undefined"', () => {
        const variables = buildCommandVariables(findMagicPromptCommand('summary')!, '');
        expect(variables.visible.topic_line).toBe('');
        expect(variables.instructions.topic_block).toBe('');
    });

    test('an idea is formatted as its own block', () => {
        const variables = buildCommandVariables(findMagicPromptCommand('craft-goal')!, 'a CLI');
        expect(variables.visible.idea_block).toBe('\n\nHere is my initial idea:\na CLI');
    });

    test('an absent idea leaves the slot blank', () => {
        expect(buildCommandVariables(findMagicPromptCommand('schedule-task')!, '').visible.idea_block)
            .toBe('');
    });
});

describe('the command table', () => {
    test('names are unique', () => {
        const names = MAGIC_PROMPT_COMMANDS.map((command) => command.name);
        expect(new Set(names).size).toBe(names.length);
    });

    test('every command names both prompts and a failure toast', () => {
        for (const command of MAGIC_PROMPT_COMMANDS) {
            expect(command.visiblePrompt.startsWith('session.')).toBe(true);
            expect(command.instructionsPrompt.startsWith('session.')).toBe(true);
            expect(command.errorToastKey.startsWith('chat.chatInput.toast.')).toBe(true);
        }
    });
});
