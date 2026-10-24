import { describe, expect, it } from 'vitest';
import { createRuleIntentProvider } from '../src/index.js';

describe('rule intent provider', () => {
  it('returns a replaceable provider-shaped result', async () => {
    await expect(
      createRuleIntentProvider().classify('What time do you open?'),
    ).resolves.toEqual({
      intent: 'HOURS',
      confidence: 0.85,
      source: 'rules',
    });
  });
});
