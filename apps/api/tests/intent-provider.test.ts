import { describe, expect, it } from 'vitest';
import { parseLlmContent } from '../src/intent-provider.js';

describe('LLM intent response parsing', () => {
  it('parses plain JSON', () => {
    expect(parseLlmContent('{"intent":"BOOKING","confidence":0.9}')).toEqual({
      intent: 'BOOKING',
      confidence: 0.9,
      source: 'llm',
    });
  });

  it('removes reasoning and markdown fences', () => {
    expect(
      parseLlmContent(
        '<think>Pick the best category.</think>```json\n{"intent":"HOURS","confidence":0.8}\n```',
      ),
    ).toEqual({
      intent: 'HOURS',
      confidence: 0.8,
      source: 'llm',
    });
  });

  it('rejects invalid intents', () => {
    expect(parseLlmContent('{"intent":"MAKE_COFFEE","confidence":1}')).toBe(
      null,
    );
  });
});
