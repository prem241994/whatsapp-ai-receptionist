import {
  createRuleIntentProvider,
  type InboundIntent,
  type IntentProvider,
} from '@whatsapp-receptionist/shared';

const validIntents: InboundIntent[] = [
  'BOOKING',
  'AVAILABILITY',
  'HOURS',
  'SERVICES',
  'PRICING',
  'CANCEL',
  'RESCHEDULE',
  'GREETING',
  'HUMAN',
  'UNKNOWN',
];

function parseLlmResult(value: unknown) {
  if (!value || typeof value !== 'object') return null;
  const result = value as { intent?: unknown; confidence?: unknown };
  if (
    typeof result.intent !== 'string' ||
    !validIntents.includes(result.intent as InboundIntent) ||
    typeof result.confidence !== 'number' ||
    !Number.isFinite(result.confidence)
  )
    return null;
  return {
    intent: result.intent as InboundIntent,
    confidence: Math.max(0, Math.min(1, result.confidence)),
    source: 'llm' as const,
  };
}

export function parseLlmContent(content: string) {
  const withoutThinking = content
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  const objectStart = withoutThinking.indexOf('{');
  const objectEnd = withoutThinking.lastIndexOf('}');
  if (objectStart < 0 || objectEnd <= objectStart) return null;
  try {
    return parseLlmResult(
      JSON.parse(withoutThinking.slice(objectStart, objectEnd + 1)),
    );
  } catch {
    return null;
  }
}

export function createConfiguredIntentProvider(
  environment: NodeJS.ProcessEnv = process.env,
): IntentProvider {
  const fallback = createRuleIntentProvider();
  if (environment.INTENT_PROVIDER !== 'ollama') return fallback;

  const baseUrl = (
    environment.INTENT_LLM_BASE_URL ?? 'http://localhost:11434/v1'
  ).replace(/\/$/, '');
  const model = environment.INTENT_LLM_MODEL ?? 'llama3.2';
  const apiKey = environment.INTENT_LLM_API_KEY;

  return {
    async classify(text) {
      try {
        const response = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          signal: AbortSignal.timeout(5_000),
          headers: {
            'content-type': 'application/json',
            ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify({
            model,
            temperature: 0,
            response_format: { type: 'json_object' },
            messages: [
              {
                role: 'system',
                content:
                  'Classify the customer message for a salon receptionist. Return only one JSON object with intent and confidence; do not include reasoning, markdown, or extra text. intent must be one of BOOKING, AVAILABILITY, HOURS, SERVICES, PRICING, CANCEL, RESCHEDULE, GREETING, HUMAN, UNKNOWN. confidence must be a number from 0 to 1. Examples: "I want to book a haircut" = BOOKING; "Could I get a trim sometime?" = BOOKING; "Do you have a slot tomorrow?" = AVAILABILITY; "What time do you open?" = HOURS; "How much is coloring?" = PRICING; "What treatments do you offer?" = SERVICES; "Please cancel my appointment" = CANCEL; "Can I move my appointment?" = RESCHEDULE; "Hello" = GREETING; "I need a person" = HUMAN.',
              },
              { role: 'user', content: text },
            ],
          }),
        });
        if (!response.ok)
          throw new Error(`intent provider returned ${response.status}`);
        const payload = (await response.json()) as {
          choices?: Array<{ message?: { content?: unknown } }>;
        };
        const content = payload.choices?.[0]?.message?.content;
        if (typeof content !== 'string')
          throw new Error('intent provider returned no content');
        const result = parseLlmContent(content);
        if (!result) throw new Error('intent provider returned invalid JSON');
        const ruleResult = await fallback.classify(text);
        if (result.intent === 'UNKNOWN' && ruleResult.intent !== 'UNKNOWN')
          return ruleResult;
        return result;
      } catch {
        return fallback.classify(text);
      }
    },
  };
}
