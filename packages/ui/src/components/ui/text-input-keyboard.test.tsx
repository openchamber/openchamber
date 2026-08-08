import { describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';
import { Input } from './input';
import { Textarea } from './textarea';

mock.module('@/components/session/TodoSendDialog', () => ({
  TodoSendDialog: () => null,
}));

const { ProjectNotesTodoPanel } = await import('@/components/session/ProjectNotesTodoPanel');

type TestWindow = {
  Capacitor?: {
    getPlatform?: () => string;
  };
};

function withPlatform<T>(platform: 'ios' | 'android' | undefined, callback: () => T): T {
  const globals = globalThis as unknown as { window?: TestWindow };
  const previousWindow = globals.window;
  globals.window = platform
    ? { Capacitor: { getPlatform: () => platform } }
    : undefined;

  try {
    return callback();
  } finally {
    globals.window = previousWindow;
  }
}

function renderInput(props: React.ComponentProps<typeof Input> = {}): string {
  return renderToStaticMarkup(React.createElement(Input, props));
}

function renderTextarea(
  props: React.ComponentProps<typeof Textarea> = {},
  simple = true,
): string {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(Textarea, { simple, ...props }),
    ),
  );
}

function renderProjectNotesTodoPanel(): string {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ProjectNotesTodoPanel, {
        projectRef: { id: 'project-test', path: '/workspace/project' },
      }),
    ),
  );
}

function extractOpeningTag(
  markup: string,
  tagName: 'input' | 'textarea',
  predicate: (tag: string) => boolean = () => true,
): string {
  const tag = Array.from(
    markup.matchAll(new RegExp(`<${tagName}\\b[^>]*>`, 'gi')),
    (match) => match[0],
  ).find(predicate);

  if (!tag) {
    throw new Error(`Expected a matching <${tagName}> element`);
  }

  return tag;
}

function expectAttribute(markup: string, name: string, value: string): void {
  expect(markup.toLowerCase()).toContain(`${name.toLowerCase()}="${value.toLowerCase()}"`);
}

describe('shared text input keyboard defaults', () => {
  test('enables autocorrection only for opted-in fields on Capacitor iOS', () => {
    withPlatform('ios', () => {
      const inputMarkup = renderInput({ enableIOSAutocorrect: true });
      const simpleTextareaMarkup = renderTextarea({ enableIOSAutocorrect: true });
      const wrappedTextareaMarkup = renderTextarea({ enableIOSAutocorrect: true }, false);

      for (const markup of [inputMarkup, simpleTextareaMarkup, wrappedTextareaMarkup]) {
        expectAttribute(markup, 'spellcheck', 'true');
        expectAttribute(markup, 'autocorrect', 'on');
        expectAttribute(markup, 'autocapitalize', 'off');
      }
    });
  });

  test('wires the iOS opt-in to the project notes and new todo fields', () => {
    withPlatform('ios', () => {
      const markup = renderProjectNotesTodoPanel();
      const notesField = extractOpeningTag(markup, 'textarea');
      const newTodoField = extractOpeningTag(
        markup,
        'input',
        (tag) => tag.toLowerCase().includes('data-slot="input"'),
      );

      for (const field of [notesField, newTodoField]) {
        expectAttribute(field, 'spellcheck', 'true');
        expectAttribute(field, 'autocorrect', 'on');
        expectAttribute(field, 'autocapitalize', 'off');
      }
    });
  });

  test('keeps opted-in fields correction-off outside Capacitor iOS', () => {
    for (const platform of ['android', undefined] as const) {
      withPlatform(platform, () => {
        const inputMarkup = renderInput({ enableIOSAutocorrect: true });
        const simpleTextareaMarkup = renderTextarea({ enableIOSAutocorrect: true });
        const wrappedTextareaMarkup = renderTextarea({ enableIOSAutocorrect: true }, false);

        for (const markup of [inputMarkup, simpleTextareaMarkup, wrappedTextareaMarkup]) {
          expectAttribute(markup, 'spellcheck', 'false');
          expectAttribute(markup, 'autocorrect', 'off');
        }
      });
    }
  });

  test('keeps the correction-off policy by default on every runtime', () => {
    for (const platform of ['ios', 'android', undefined] as const) {
      withPlatform(platform, () => {
        const inputMarkup = renderInput();
        const simpleTextareaMarkup = renderTextarea();
        const wrappedTextareaMarkup = renderTextarea({}, false);

        for (const markup of [inputMarkup, simpleTextareaMarkup, wrappedTextareaMarkup]) {
          expectAttribute(markup, 'spellcheck', 'false');
          expectAttribute(markup, 'autocorrect', 'off');
          expectAttribute(markup, 'autocapitalize', 'off');
        }
      });
    }
  });

  test('preserves explicit correction-off overrides on iOS', () => {
    withPlatform('ios', () => {
      const inputMarkup = renderInput({
        enableIOSAutocorrect: true,
        spellCheck: false,
        autoCapitalize: 'none',
      });
      const simpleTextareaMarkup = renderTextarea({
        enableIOSAutocorrect: true,
        spellCheck: false,
        autoCapitalize: 'none',
      });
      const wrappedTextareaMarkup = renderTextarea({
        enableIOSAutocorrect: true,
        spellCheck: false,
        autoCapitalize: 'none',
      }, false);

      for (const markup of [inputMarkup, simpleTextareaMarkup, wrappedTextareaMarkup]) {
        expectAttribute(markup, 'spellcheck', 'false');
        expectAttribute(markup, 'autocorrect', 'off');
        expectAttribute(markup, 'autocapitalize', 'none');
      }
    });
  });

  test('preserves an explicit autocorrect override after the iOS default', () => {
    withPlatform('ios', () => {
      const inputMarkup = renderInput({
        enableIOSAutocorrect: true,
        spellCheck: false,
        autoCorrect: 'on',
      });
      const simpleTextareaMarkup = renderTextarea({
        enableIOSAutocorrect: true,
        spellCheck: false,
        autoCorrect: 'on',
      });
      const wrappedTextareaMarkup = renderTextarea({
        enableIOSAutocorrect: true,
        spellCheck: false,
        autoCorrect: 'on',
      }, false);

      expectAttribute(inputMarkup, 'spellcheck', 'false');
      expectAttribute(inputMarkup, 'autocorrect', 'on');
      for (const markup of [simpleTextareaMarkup, wrappedTextareaMarkup]) {
        expectAttribute(markup, 'spellcheck', 'false');
        expectAttribute(markup, 'autocorrect', 'on');
      }
    });
  });
});
