export const PROJECT_NAME = 'WhatsApp AI Receptionist';

export type HealthStatus = {
  status: 'ok';
  service: string;
};

export type InboundIntent =
  | 'BOOKING'
  | 'AVAILABILITY'
  | 'HOURS'
  | 'SERVICES'
  | 'PRICING'
  | 'CANCEL'
  | 'RESCHEDULE'
  | 'GREETING'
  | 'HUMAN'
  | 'UNKNOWN';

export type IntentResult = {
  intent: InboundIntent;
  confidence: number;
  source: 'rules' | 'llm';
};

export interface IntentProvider {
  classify(text: string): Promise<IntentResult>;
}

export function createRuleIntentProvider(): IntentProvider {
  return {
    async classify(text) {
      const intent = classifyInboundIntent(text);
      return {
        intent,
        confidence: intent === 'UNKNOWN' ? 0 : 0.85,
        source: 'rules',
      };
    },
  };
}

/**
 * Provider-independent first-pass intent detection.
 * A future LLM can replace or enrich this result, but booking validation must
 * continue to happen in the API's deterministic state machine.
 */
export function classifyInboundIntent(text: string): InboundIntent {
  const normalized = text.toLowerCase().trim();
  if (/\b(price|prices|pricing|cost|costs|料金|how much)\b/.test(normalized))
    return 'PRICING';
  if (/\b(cancel|cancellation|call off)\b/.test(normalized)) return 'CANCEL';
  if (
    /\b(reschedule|move|change)\b.*\b(appointment|booking|visit)\b/.test(
      normalized,
    )
  )
    return 'RESCHEDULE';
  if (/\b(availability|available|slot|free slot|open slot)\b/.test(normalized))
    return 'AVAILABILITY';
  if (/\b(book|booking|appointment|schedule|reserve)\b/.test(normalized))
    return 'BOOKING';
  if (
    /\b(trim|haircut|hair color|hair coloring)\b/.test(normalized) &&
    /\b(can|could|would|want|like|need|sometime|today|tomorrow)\b/.test(
      normalized,
    )
  )
    return 'BOOKING';
  if (/\b(human|person|agent|staff|representative|someone)\b/.test(normalized))
    return 'HUMAN';
  if (/\b(hours?|open|opening|close|closing|when do you)\b/.test(normalized))
    return 'HOURS';
  if (
    /\b(service|services|treatment|treatments|offer|offers|menu)\b/.test(
      normalized,
    )
  )
    return 'SERVICES';
  if (
    /^(hi|hello|hey|namaste|good morning|good afternoon|good evening)\b/.test(
      normalized,
    )
  )
    return 'GREETING';
  return 'UNKNOWN';
}
