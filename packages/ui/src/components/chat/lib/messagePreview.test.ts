import { describe, expect, test } from 'bun:test'
import type { Part } from '@opencode-ai/sdk/v2'
import { CONTEXT_METADATA_KEY, type ContextPartPayload } from '@/lib/messages/contextParts'
import { getFullText, getMessagePreview, getPromptPreviewText } from './messagePreview'

const textPart = (text: string): Part => ({ type: 'text', text } as Part)

// SAFETY: a synthetic context part as the composer builds it; the preview
// helpers read only type, text, and metadata.
const contextPart = (payload: ContextPartPayload, text: string): Part => ({
  id: 'prt_1',
  sessionID: 'ses_1',
  messageID: 'msg_1',
  type: 'text',
  text,
  synthetic: true,
  metadata: { [CONTEXT_METADATA_KEY]: payload },
} as Part)

const chatQuote = (quote: string, text = ''): ContextPartPayload => ({ kind: 'chat-quote', quote, text })

const t = (key: string): string => (key === 'chat.message.context.chatQuote' ? 'Quoted from an earlier message' : key)

describe('messagePreview', () => {
  test('joins text parts for full text', () => {
    expect(getFullText([textPart('hello'), textPart('world')])).toBe('hello\nworld')
  })

  test('collapses newlines and truncates previews', () => {
    expect(getMessagePreview([textPart('line one\nline two')], 80)).toBe('line one line two')
    expect(getMessagePreview([textPart('abcdefghijklmnopqrstuvwxyz')], 10)).toBe('abcdefghij…')
  })

  test('returns empty string when there is no text', () => {
    expect(getMessagePreview([])).toBe('')
    expect(getFullText([{ type: 'file' } as Part])).toBe('')
  })

  test('labels a quote-only message from its context part', () => {
    const parts = [contextPart(chatQuote('the anchored scroll bit'), 'Comment on this fragment...')]
    expect(getPromptPreviewText(parts, t)).toBe('Quoted from an earlier message: the anchored scroll bit')
    expect(getMessagePreview(parts, 160, t)).toBe('Quoted from an earlier message: the anchored scroll bit')
  })

  test('prefers the quote comment over the quote itself', () => {
    const parts = [contextPart(chatQuote('the anchored scroll bit', 'why this?'), 'raw model text')]
    expect(getPromptPreviewText(parts, t)).toBe('Quoted from an earlier message: why this?')
  })

  test('keeps the typed text when a message has both text and quotes', () => {
    const parts = [contextPart(chatQuote('quoted bit'), 'raw model text'), textPart('please explain')]
    expect(getPromptPreviewText(parts, t)).toBe('please explain')
  })

  test('falls back to raw text without a translator', () => {
    const parts = [contextPart(chatQuote('quoted bit'), 'raw model text')]
    expect(getPromptPreviewText(parts)).toBe('raw model text')
  })
})
