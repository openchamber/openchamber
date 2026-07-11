import { describe, expect, test } from 'bun:test'
import type { Part } from '@opencode-ai/sdk/v2'
import { getFullText, getMessagePreview } from './messagePreview'

const textPart = (text: string): Part => ({ type: 'text', text } as Part)

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
})
