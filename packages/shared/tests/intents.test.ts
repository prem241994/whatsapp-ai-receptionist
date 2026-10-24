import { describe, expect, it } from 'vitest';
import { classifyInboundIntent } from '../src/index.js';

describe('inbound intent classification', () => {
  it.each([
    ['Can I schedule a haircut?', 'BOOKING'],
    ['Could I get a trim sometime?', 'BOOKING'],
    ['What time do you open?', 'HOURS'],
    ['Do you have a slot tomorrow?', 'AVAILABILITY'],
    ['How much is hair coloring?', 'PRICING'],
    ['What services do you offer?', 'SERVICES'],
    ['Please cancel my appointment', 'CANCEL'],
    ['Can I move my appointment?', 'RESCHEDULE'],
    ['Hello', 'GREETING'],
    ['I need to speak to a person', 'HUMAN'],
    ['Thanks, see you soon', 'UNKNOWN'],
  ] as const)('classifies %s as %s', (text, intent) => {
    expect(classifyInboundIntent(text)).toBe(intent);
  });
});
