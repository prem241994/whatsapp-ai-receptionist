export type OutboundTextMessage = {
  to: string;
  body: string;
};

export type SentMessage = {
  providerMessageId: string;
};

export interface WhatsAppClient {
  sendText(message: OutboundTextMessage): Promise<SentMessage>;
}

type MetaWhatsAppClientOptions = {
  accessToken: string;
  phoneNumberId: string;
  graphApiVersion?: string;
};

export function createMetaWhatsAppClient(
  options: MetaWhatsAppClientOptions,
): WhatsAppClient {
  const graphApiVersion = options.graphApiVersion ?? 'v22.0';
  return {
    async sendText(message) {
      const response = await fetch(
        `https://graph.facebook.com/${graphApiVersion}/${options.phoneNumberId}/messages`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${options.accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: message.to,
            type: 'text',
            text: { preview_url: false, body: message.body },
          }),
        },
      );
      if (!response.ok)
        throw new Error(`Meta send failed with status ${response.status}`);
      const result = (await response.json()) as {
        messages?: Array<{ id?: string }>;
      };
      const providerMessageId = result.messages?.[0]?.id;
      if (!providerMessageId)
        throw new Error('Meta send response did not include a message id');
      return { providerMessageId };
    },
  };
}
