'use client';

import { createAuthClient } from 'better-auth/react';
import { useEffect, useState } from 'react';

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
const authClient = createAuthClient({ baseURL: apiUrl });
const days = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];
type Business = { id: string; displayName: string; role: string };
type Staff = { id: string; name: string; enabled: boolean };
type Service = {
  id: string;
  name: string;
  durationMinutes: number;
  priceMinor: number;
  enabled: boolean;
};
type Hour = { dayOfWeek: number; startTime: string; endTime: string };
type AvailabilitySlot = {
  staffId: string;
  staffName: string;
  startAt: string;
  endAt: string;
};
type Appointment = {
  id: string;
  startsAt: string;
  endsAt: string;
  status: string;
  customer: { displayName: string | null; phone: string };
  service: { name: string };
  staff: { name: string };
};
type Faq = {
  id: string;
  question: string;
  answer: string;
  keywords: string[];
  enabled: boolean;
};
type ConversationMessage = {
  id: string;
  direction: 'INBOUND' | 'OUTBOUND';
  messageType: string;
  textBody: string | null;
  status: string;
  createdAt: string;
};
type Conversation = {
  id: string;
  status: string;
  lastMessageAt: string;
  customer: { displayName: string | null; phone: string };
  messages: ConversationMessage[];
};
type OutboundQueueItem = {
  id: string;
  textBody: string | null;
  createdAt: string;
  conversation: { id: string; customer: { phone: string } };
};
type ReminderJob = {
  id: string;
  kind: string;
  scheduledFor: string;
  status: string;
  attempts: number;
  sentAt: string | null;
  lastError: string | null;
  appointment: {
    startsAt: string;
    status: string;
    customer: { phone: string; displayName: string | null; optedOut: boolean };
    service: { name: string };
  };
};
type MessageTemplate = {
  id: string;
  name: string;
  language: string;
  category: string;
  bodyPreview: string;
  providerTemplateId: string | null;
  status: string;
  enabled: boolean;
};

function today() {
  return new Date().toISOString().slice(0, 10);
}

function displayTime(value: string) {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(value));
}

function displayDateTime(value: string) {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

export default function HomePage() {
  const [session, setSession] = useState<{
    user: { id: string; email: string };
  } | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [businessId, setBusinessId] = useState('');
  const [services, setServices] = useState<Service[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [staffId, setStaffId] = useState('');
  const [hours, setHours] = useState<Hour[]>([]);
  const [availabilityDate, setAvailabilityDate] = useState(today());
  const [availabilityServiceId, setAvailabilityServiceId] = useState('');
  const [availabilityStaffId, setAvailabilityStaffId] = useState('');
  const [availabilitySlots, setAvailabilitySlots] = useState<
    AvailabilitySlot[]
  >([]);
  const [selectedSlot, setSelectedSlot] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [faqs, setFaqs] = useState<Faq[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [outboundQueue, setOutboundQueue] = useState<OutboundQueueItem[]>([]);
  const [reminderJobs, setReminderJobs] = useState<ReminderJob[]>([]);
  const [messageTemplates, setMessageTemplates] = useState<MessageTemplate[]>(
    [],
  );
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [simulatorPhone, setSimulatorPhone] = useState('+919876543210');
  const [simulatorText, setSimulatorText] = useState(
    'What are your opening hours?',
  );
  useEffect(() => {
    void authClient
      .getSession()
      .then(({ data }) => setSession(data?.user ? { user: data.user } : null));
  }, []);
  useEffect(() => {
    if (!session) return;
    void fetch(`${apiUrl}/v1/me/businesses`, { credentials: 'include' })
      .then(async (response) => {
        if (!response.ok) throw new Error('Unable to load salon memberships');
        const result: Business[] = await response.json();
        setBusinesses(result);
        setBusinessId(result[0]?.id ?? '');
      })
      .catch((cause: Error) => setError(cause.message));
  }, [session]);
  async function loadSetup(selectedBusinessId: string) {
    const [serviceResponse, staffResponse] = await Promise.all([
      fetch(`${apiUrl}/v1/businesses/${selectedBusinessId}/services`, {
        credentials: 'include',
      }),
      fetch(`${apiUrl}/v1/businesses/${selectedBusinessId}/staff`, {
        credentials: 'include',
      }),
    ]);
    if (!serviceResponse.ok || !staffResponse.ok)
      throw new Error('Unable to load salon setup');
    const serviceResult: Service[] = await serviceResponse.json();
    const staffResult: Staff[] = await staffResponse.json();
    setServices(serviceResult);
    setStaff(staffResult);
    setAvailabilityServiceId(serviceResult[0]?.id ?? '');
    setStaffId(staffResult[0]?.id ?? '');
  }
  useEffect(() => {
    if (businessId)
      void loadSetup(businessId).catch((cause: Error) =>
        setError(cause.message),
      );
  }, [businessId]);
  async function loadConversations(selectedBusinessId: string) {
    const response = await fetch(
      `${apiUrl}/v1/businesses/${selectedBusinessId}/conversations`,
      { credentials: 'include' },
    );
    if (!response.ok) throw new Error('Unable to load conversations');
    setConversations(await response.json());
  }
  async function loadOutboundQueue(selectedBusinessId: string) {
    const response = await fetch(
      `${apiUrl}/v1/businesses/${selectedBusinessId}/outbound-queue`,
      { credentials: 'include' },
    );
    if (!response.ok) throw new Error('Unable to load outbound queue');
    setOutboundQueue(await response.json());
  }
  async function loadPhaseFiveData(selectedBusinessId: string) {
    const [reminderResponse, templateResponse] = await Promise.all([
      fetch(`${apiUrl}/v1/businesses/${selectedBusinessId}/reminder-jobs`, {
        credentials: 'include',
      }),
      fetch(`${apiUrl}/v1/businesses/${selectedBusinessId}/message-templates`, {
        credentials: 'include',
      }),
    ]);
    if (!reminderResponse.ok || !templateResponse.ok)
      throw new Error('Unable to load reminder settings');
    setReminderJobs(await reminderResponse.json());
    setMessageTemplates(await templateResponse.json());
  }
  async function markOutboundMessage(
    messageId: string,
    status: 'SENT' | 'FAILED',
  ) {
    const response = await fetch(
      `${apiUrl}/v1/businesses/${businessId}/outbound-queue/${messageId}`,
      {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      },
    );
    if (!response.ok) {
      setError('Could not update outbound message');
      return;
    }
    await loadOutboundQueue(businessId);
    await loadConversations(businessId);
  }
  async function updateConversationStatus(
    conversationId: string,
    action: 'handoff' | 'resume',
  ) {
    const response = await fetch(
      `${apiUrl}/v1/businesses/${businessId}/conversations/${conversationId}/${action}`,
      { method: 'POST', credentials: 'include' },
    );
    if (!response.ok) {
      setError('Could not update conversation status');
      return;
    }
    await loadConversations(businessId);
    await loadOutboundQueue(businessId);
  }
  async function sendManualReply(
    event: React.FormEvent<HTMLFormElement>,
    conversationId: string,
  ) {
    event.preventDefault();
    const text = replyDrafts[conversationId]?.trim();
    if (!text) return;
    const response = await fetch(
      `${apiUrl}/v1/businesses/${businessId}/conversations/${conversationId}/messages`,
      {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      },
    );
    if (!response.ok) {
      setError('Could not queue staff reply');
      return;
    }
    setReplyDrafts((current) => ({ ...current, [conversationId]: '' }));
    await loadConversations(businessId);
    await loadOutboundQueue(businessId);
  }
  async function simulateMessage(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!businessId || !simulatorPhone.trim() || !simulatorText.trim()) return;
    const response = await fetch(
      `${apiUrl}/v1/businesses/${businessId}/dev/simulate-whatsapp`,
      {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          senderPhone: simulatorPhone,
          text: simulatorText,
        }),
      },
    );
    if (!response.ok) {
      setError('Could not simulate WhatsApp message');
      return;
    }
    await loadConversations(businessId);
    setSimulatorText('');
  }
  useEffect(() => {
    if (!businessId) {
      setConversations([]);
      return;
    }
    void loadConversations(businessId).catch((cause: Error) =>
      setError(cause.message),
    );
    void loadOutboundQueue(businessId).catch((cause: Error) =>
      setError(cause.message),
    );
    void loadPhaseFiveData(businessId).catch((cause: Error) =>
      setError(cause.message),
    );
  }, [businessId]);
  useEffect(() => {
    if (!businessId) return;
    void fetch(`${apiUrl}/v1/businesses/${businessId}/faqs`, {
      credentials: 'include',
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('Unable to load FAQs');
        setFaqs(await response.json());
      })
      .catch((cause: Error) => setError(cause.message));
  }, [businessId]);
  useEffect(() => {
    if (!businessId || !staffId) return;
    void fetch(
      `${apiUrl}/v1/businesses/${businessId}/staff/${staffId}/working-hours`,
      { credentials: 'include' },
    )
      .then(async (response) => {
        if (!response.ok) throw new Error('Unable to load working hours');
        setHours(await response.json());
      })
      .catch((cause: Error) => setError(cause.message));
  }, [businessId, staffId]);
  useEffect(() => {
    if (!businessId || !availabilityDate || !availabilityServiceId) {
      setAvailabilitySlots([]);
      return;
    }
    const query = new URLSearchParams({
      date: availabilityDate,
      serviceId: availabilityServiceId,
    });
    if (availabilityStaffId) query.set('staffId', availabilityStaffId);
    void fetch(
      `${apiUrl}/v1/businesses/${businessId}/availability?${query.toString()}`,
      { credentials: 'include' },
    )
      .then(async (response) => {
        if (!response.ok) throw new Error('Unable to load availability');
        const result: { slots: AvailabilitySlot[] } = await response.json();
        setAvailabilitySlots(result.slots);
      })
      .catch((cause: Error) => setError(cause.message));
  }, [
    businessId,
    availabilityDate,
    availabilityServiceId,
    availabilityStaffId,
  ]);
  useEffect(() => {
    setSelectedSlot('');
  }, [availabilityDate, availabilityServiceId, availabilityStaffId]);
  useEffect(() => {
    if (!businessId) return;
    const from = new Date();
    const to = new Date(from.getTime() + 30 * 24 * 60 * 60 * 1000);
    const query = new URLSearchParams({
      from: from.toISOString(),
      to: to.toISOString(),
    });
    void fetch(
      `${apiUrl}/v1/businesses/${businessId}/appointments?${query.toString()}`,
      { credentials: 'include' },
    )
      .then(async (response) => {
        if (!response.ok) throw new Error('Unable to load appointments');
        setAppointments(await response.json());
      })
      .catch((cause: Error) => setError(cause.message));
  }, [businessId]);
  async function signIn(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    const result = await authClient.signIn.email({ email, password });
    if (result.error) setError(result.error.message ?? 'Sign in failed');
    else setSession(result.data?.user ? { user: result.data.user } : null);
  }
  async function signUp() {
    setError('');
    const result = await authClient.signUp.email({
      email,
      password,
      name: email.split('@')[0] ?? 'Salon owner',
    });
    if (result.error) setError(result.error.message ?? 'Sign up failed');
    else setSession(result.data?.user ? { user: result.data.user } : null);
  }
  async function add(kind: 'services' | 'staff') {
    const name = window.prompt(
      kind === 'services' ? 'Service name' : 'Staff name',
    );
    if (!name?.trim() || !businessId) return;
    const body =
      kind === 'services'
        ? { name, durationMinutes: 30, priceMinor: 0 }
        : { name };
    const response = await fetch(
      `${apiUrl}/v1/businesses/${businessId}/${kind}`,
      {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) {
      setError('Could not save this item');
      return;
    }
    await loadSetup(businessId);
  }
  async function updateItem(
    kind: 'services' | 'staff',
    id: string,
    body: Record<string, string | number | boolean>,
  ) {
    const response = await fetch(
      `${apiUrl}/v1/businesses/${businessId}/${kind}/${id}`,
      {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) {
      setError('Could not update this item');
      return;
    }
    await loadSetup(businessId);
  }
  async function editService(item: Service) {
    const name = window.prompt('Service name', item.name);
    if (!name?.trim()) return;
    const duration = window.prompt(
      'Duration in minutes',
      String(item.durationMinutes),
    );
    const price = window.prompt(
      'Price in rupees',
      String(item.priceMinor / 100),
    );
    const durationMinutes = Number(duration);
    const priceMinor = Math.round(Number(price) * 100);
    if (
      !Number.isInteger(durationMinutes) ||
      durationMinutes < 1 ||
      !Number.isInteger(priceMinor) ||
      priceMinor < 0
    ) {
      setError('Enter a valid duration and price');
      return;
    }
    await updateItem('services', item.id, {
      name: name.trim(),
      durationMinutes,
      priceMinor,
    });
  }
  async function editStaff(item: Staff) {
    const name = window.prompt('Staff name', item.name);
    if (!name?.trim()) return;
    await updateItem('staff', item.id, { name: name.trim() });
  }
  async function removeItem(
    kind: 'services' | 'staff',
    id: string,
    name: string,
  ) {
    if (!window.confirm(`Delete ${name}?`)) return;
    const response = await fetch(
      `${apiUrl}/v1/businesses/${businessId}/${kind}/${id}`,
      { method: 'DELETE', credentials: 'include' },
    );
    if (!response.ok) {
      setError('Could not delete this item');
      return;
    }
    await loadSetup(businessId);
  }
  function toggleDay(dayOfWeek: number) {
    const existing = hours.find((hour) => hour.dayOfWeek === dayOfWeek);
    setHours(
      existing
        ? hours.filter((hour) => hour.dayOfWeek !== dayOfWeek)
        : [...hours, { dayOfWeek, startTime: '10:00', endTime: '19:00' }].sort(
            (a, b) => a.dayOfWeek - b.dayOfWeek,
          ),
    );
  }
  function changeHour(
    dayOfWeek: number,
    field: 'startTime' | 'endTime',
    value: string,
  ) {
    setHours(
      hours.map((hour) =>
        hour.dayOfWeek === dayOfWeek ? { ...hour, [field]: value } : hour,
      ),
    );
  }
  async function saveHours() {
    if (!businessId || !staffId) return;
    const response = await fetch(
      `${apiUrl}/v1/businesses/${businessId}/staff/${staffId}/working-hours`,
      {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hours }),
      },
    );
    if (!response.ok) {
      setError('Could not save working hours');
      return;
    }
    setHours(await response.json());
  }
  async function createAppointment() {
    if (!businessId || !availabilityServiceId || !selectedSlot) {
      setError('Choose an available slot first');
      return;
    }
    const slot = availabilitySlots.find(
      (item) => item.startAt === selectedSlot,
    );
    if (!slot) {
      setError('Choose an available slot first');
      return;
    }
    const response = await fetch(
      `${apiUrl}/v1/businesses/${businessId}/appointments`,
      {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerName,
          customerPhone,
          serviceId: availabilityServiceId,
          staffId: slot.staffId,
          startsAt: slot.startAt,
        }),
      },
    );
    if (!response.ok) {
      setError(
        response.status === 409
          ? 'That slot is no longer available'
          : 'Could not create appointment',
      );
      return;
    }
    setCustomerName('');
    setCustomerPhone('');
    setSelectedSlot('');
    const created: Appointment = await response.json();
    setAppointments((current) =>
      [...current, created].sort(
        (a, b) =>
          new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
      ),
    );
  }
  async function addFaq() {
    const question = window.prompt('FAQ question');
    const answer = question ? window.prompt('FAQ answer') : null;
    const keywordText = answer
      ? window.prompt('Keywords, comma separated')
      : null;
    const keywords = keywordText
      ?.split(',')
      .map((keyword) => keyword.trim())
      .filter(Boolean);
    if (!question?.trim() || !answer?.trim() || !keywords?.length) return;
    const response = await fetch(`${apiUrl}/v1/businesses/${businessId}/faqs`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, answer, keywords }),
    });
    if (!response.ok) {
      setError('Could not save FAQ');
      return;
    }
    const created: Faq = await response.json();
    setFaqs((current) => [...current, created]);
  }
  async function editFaq(item: Faq) {
    const question = window.prompt('FAQ question', item.question);
    const answer = window.prompt('FAQ answer', item.answer);
    const keywordText = window.prompt(
      'Keywords, comma separated',
      item.keywords.join(', '),
    );
    const keywords = keywordText
      ?.split(',')
      .map((keyword) => keyword.trim())
      .filter(Boolean);
    if (!question?.trim() || !answer?.trim() || !keywords?.length) return;
    const response = await fetch(
      `${apiUrl}/v1/businesses/${businessId}/faqs/${item.id}`,
      {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, answer, keywords }),
      },
    );
    if (!response.ok) {
      setError('Could not update FAQ');
      return;
    }
    setFaqs((current) =>
      current.map((faq) =>
        faq.id === item.id ? { ...faq, question, answer, keywords } : faq,
      ),
    );
  }
  async function removeFaq(item: Faq) {
    if (!window.confirm(`Delete FAQ "${item.question}"?`)) return;
    const response = await fetch(
      `${apiUrl}/v1/businesses/${businessId}/faqs/${item.id}`,
      { method: 'DELETE', credentials: 'include' },
    );
    if (!response.ok) {
      setError('Could not delete FAQ');
      return;
    }
    setFaqs((current) => current.filter((faq) => faq.id !== item.id));
  }
  if (!session)
    return (
      <main>
        <form className="login" onSubmit={signIn}>
          <p className="eyebrow">SALON WORKSPACE</p>
          <h1>Sign in</h1>
          <p>
            Account authentication runs on this app and your PostgreSQL
            database.
          </p>
          <label>
            Email
            <input
              type="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <label>
            Password
            <input
              type="password"
              minLength={8}
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <button>Sign in</button>
          <button
            type="button"
            className="secondary"
            onClick={() => void signUp()}
          >
            Create account
          </button>
          {error && <p role="alert">{error}</p>}
        </form>
      </main>
    );
  if (!businessId)
    return (
      <main>
        <header>
          <div>
            <p className="eyebrow">SALON WORKSPACE</p>
            <h1>No salon access</h1>
            <p>
              Signed in as {session.user.email}. Add a business membership to
              continue.
            </p>
          </div>
          <button
            onClick={() =>
              void authClient.signOut().then(() => setSession(null))
            }
          >
            Sign out
          </button>
        </header>
      </main>
    );
  return (
    <main>
      <header>
        <div>
          <p className="eyebrow">SALON WORKSPACE</p>
          <h1>Salon setup</h1>
          <p>Signed in as {session.user.email}</p>
        </div>
        <div className="header-actions">
          <select
            aria-label="Choose salon"
            value={businessId}
            onChange={(event) => setBusinessId(event.target.value)}
          >
            {businesses.map((business) => (
              <option key={business.id} value={business.id}>
                {business.displayName} · {business.role}
              </option>
            ))}
          </select>
          <button
            onClick={() =>
              void authClient.signOut().then(() => setSession(null))
            }
          >
            Sign out
          </button>
        </div>
      </header>
      {error && <p role="alert">{error}</p>}
      <section className="summary">
        <p className="eyebrow">SETUP</p>
        <h2>Prepare your receptionist</h2>
        <p>Add your services, team, and hours before connecting WhatsApp.</p>
      </section>
      <section className="grid">
        <article className="card inbox-card">
          <div className="card-title">
            <div>
              <p className="eyebrow">INBOX</p>
              <h2>Customer conversations</h2>
            </div>
            <button
              className="small secondary"
              onClick={() => {
                void loadConversations(businessId).catch((cause: Error) =>
                  setError(cause.message),
                );
                void loadOutboundQueue(businessId).catch((cause: Error) =>
                  setError(cause.message),
                );
              }}
            >
              Refresh
            </button>
          </div>
          <p>Messages received from WhatsApp will appear here.</p>
          <form className="simulator" onSubmit={simulateMessage}>
            <label>
              Test customer phone
              <input
                value={simulatorPhone}
                onChange={(event) => setSimulatorPhone(event.target.value)}
                placeholder="+919876543210"
                required
              />
            </label>
            <label>
              Simulated message
              <input
                value={simulatorText}
                onChange={(event) => setSimulatorText(event.target.value)}
                placeholder="Ask about opening hours"
                required
              />
            </label>
            <button type="submit">Simulate message</button>
          </form>
          {conversations.map((conversation) => (
            <div className="conversation" key={conversation.id}>
              <div className="conversation-header">
                <div>
                  <strong>
                    {conversation.customer.displayName ||
                      conversation.customer.phone}
                  </strong>
                  <small>
                    {conversation.customer.phone} · {conversation.status}
                  </small>
                </div>
                <div className="conversation-actions">
                  <small>{displayDateTime(conversation.lastMessageAt)}</small>
                  {conversation.status === 'HANDOFF' ? (
                    <button
                      className="tiny secondary"
                      onClick={() =>
                        void updateConversationStatus(conversation.id, 'resume')
                      }
                    >
                      Resume bot
                    </button>
                  ) : (
                    <button
                      className="tiny secondary"
                      onClick={() =>
                        void updateConversationStatus(
                          conversation.id,
                          'handoff',
                        )
                      }
                    >
                      Take over
                    </button>
                  )}
                </div>
              </div>
              <div className="message-list">
                {conversation.messages.map((message) => (
                  <div
                    className={`message ${message.direction.toLowerCase()}`}
                    key={message.id}
                  >
                    <span>
                      {message.textBody || `[${message.messageType}]`}
                    </span>
                    <small>
                      {message.direction === 'INBOUND'
                        ? 'Customer'
                        : 'Receptionist'}{' '}
                      · {message.status.toLowerCase()}
                    </small>
                  </div>
                ))}
              </div>
              {conversation.status === 'HANDOFF' && (
                <form
                  className="manual-reply"
                  onSubmit={(event) =>
                    void sendManualReply(event, conversation.id)
                  }
                >
                  <input
                    value={replyDrafts[conversation.id] ?? ''}
                    onChange={(event) =>
                      setReplyDrafts((current) => ({
                        ...current,
                        [conversation.id]: event.target.value,
                      }))
                    }
                    placeholder="Write a staff reply..."
                    required
                  />
                  <button type="submit">Queue reply</button>
                </form>
              )}
            </div>
          ))}
          {conversations.length === 0 && <p>No conversations yet.</p>}
          <div className="queue-section">
            <div className="card-title">
              <h3>Queued automatic replies</h3>
              <span className="queue-count">{outboundQueue.length}</span>
            </div>
            {outboundQueue.map((message) => (
              <div className="queue-row" key={message.id}>
                <div>
                  <strong>{message.conversation.customer.phone}</strong>
                  <small>{message.textBody || '[empty message]'}</small>
                </div>
                <div className="item-actions">
                  <button
                    className="tiny secondary"
                    onClick={() => void markOutboundMessage(message.id, 'SENT')}
                  >
                    Mark sent
                  </button>
                  <button
                    className="tiny danger"
                    onClick={() =>
                      void markOutboundMessage(message.id, 'FAILED')
                    }
                  >
                    Mark failed
                  </button>
                </div>
              </div>
            ))}
            {outboundQueue.length === 0 && <p>No queued replies.</p>}
          </div>
        </article>
        <article className="card">
          <div className="card-title">
            <h2>Services</h2>
            <button className="small" onClick={() => void add('services')}>
              Add
            </button>
          </div>
          {services.map((item) => (
            <div className="item-row" key={item.id}>
              <p>
                {item.name} · {item.durationMinutes} min · ₹
                {(item.priceMinor / 100).toFixed(0)}
              </p>
              <div className="item-actions">
                <button
                  className="tiny secondary"
                  onClick={() => void editService(item)}
                >
                  Edit
                </button>
                <button
                  className="tiny danger"
                  onClick={() =>
                    void removeItem('services', item.id, item.name)
                  }
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
          {services.length === 0 && <p>No services yet.</p>}
        </article>
        <article className="card">
          <div className="card-title">
            <h2>Staff</h2>
            <button className="small" onClick={() => void add('staff')}>
              Add
            </button>
          </div>
          {staff.map((item) => (
            <div className="item-row" key={item.id}>
              <p>{item.name}</p>
              <div className="item-actions">
                <button
                  className="tiny secondary"
                  onClick={() => void editStaff(item)}
                >
                  Edit
                </button>
                <button
                  className="tiny danger"
                  onClick={() => void removeItem('staff', item.id, item.name)}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
          {staff.length === 0 && <p>No staff yet.</p>}
        </article>
        <article className="card faq-card">
          <div className="card-title">
            <h2>FAQs</h2>
            <button className="small" onClick={() => void addFaq()}>
              Add
            </button>
          </div>
          {faqs.map((item) => (
            <div className="faq-row" key={item.id}>
              <div>
                <strong>{item.question}</strong>
                <small>{item.answer}</small>
                <small>Keywords: {item.keywords.join(', ')}</small>
              </div>
              <div className="item-actions">
                <button
                  className="tiny secondary"
                  onClick={() => void editFaq(item)}
                >
                  Edit
                </button>
                <button
                  className="tiny danger"
                  onClick={() => void removeFaq(item)}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
          {faqs.length === 0 && <p>No FAQs yet.</p>}
        </article>
        <article className="card">
          <div className="card-title">
            <h2>Reminder jobs</h2>
            <button
              className="small secondary"
              onClick={() =>
                void loadPhaseFiveData(businessId).catch((cause: Error) =>
                  setError(cause.message),
                )
              }
            >
              Refresh
            </button>
          </div>
          <p>Upcoming appointment reminders and consent state.</p>
          {reminderJobs.map((job) => (
            <div className="item-row" key={job.id}>
              <div>
                <strong>
                  {job.appointment.service.name} ·{' '}
                  {job.appointment.customer.displayName ||
                    job.appointment.customer.phone}
                </strong>
                <small>
                  {displayDateTime(job.appointment.startsAt)} · {job.status}
                  {job.appointment.customer.optedOut ? ' · opted out' : ''}
                </small>
              </div>
              <span>{displayDateTime(job.scheduledFor)}</span>
            </div>
          ))}
          {reminderJobs.length === 0 && <p>No reminder jobs yet.</p>}
        </article>
        <article className="card">
          <div className="card-title">
            <h2>WhatsApp templates</h2>
          </div>
          <p>Template metadata and Meta approval state.</p>
          {messageTemplates.map((template) => (
            <div className="item-row" key={template.id}>
              <div>
                <strong>{template.name}</strong>
                <small>
                  {template.language} · {template.category} · {template.status}
                </small>
                <small>{template.bodyPreview}</small>
              </div>
            </div>
          ))}
          {messageTemplates.length === 0 && <p>No templates configured.</p>}
        </article>
        <article className="card availability">
          <div className="card-title">
            <h2>Availability</h2>
          </div>
          <p>Preview open slots before creating an appointment.</p>
          <div className="availability-filters">
            <label>
              Date
              <input
                type="date"
                value={availabilityDate}
                onChange={(event) => setAvailabilityDate(event.target.value)}
              />
            </label>
            <label>
              Service
              <select
                value={availabilityServiceId}
                onChange={(event) =>
                  setAvailabilityServiceId(event.target.value)
                }
              >
                {services.map((service) => (
                  <option key={service.id} value={service.id}>
                    {service.name} · {service.durationMinutes} min
                  </option>
                ))}
              </select>
            </label>
            <label>
              Staff
              <select
                value={availabilityStaffId}
                onChange={(event) => setAvailabilityStaffId(event.target.value)}
              >
                <option value="">Any staff member</option>
                {staff.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {availabilitySlots.length > 0 ? (
            <div className="slot-list">
              {availabilitySlots.map((slot) => (
                <button
                  className={`slot${selectedSlot === slot.startAt ? ' selected' : ''}`}
                  key={`${slot.staffId}-${slot.startAt}`}
                  type="button"
                  onClick={() => setSelectedSlot(slot.startAt)}
                >
                  <span>
                    {displayTime(slot.startAt)}–{displayTime(slot.endAt)}
                  </span>
                  <small>{slot.staffName}</small>
                </button>
              ))}
            </div>
          ) : (
            <p>No open slots for this date and selection.</p>
          )}
          <div className="appointment-form">
            <label>
              Customer name
              <input
                value={customerName}
                onChange={(event) => setCustomerName(event.target.value)}
                placeholder="Optional"
              />
            </label>
            <label>
              Customer phone
              <input
                required
                value={customerPhone}
                onChange={(event) => setCustomerPhone(event.target.value)}
                placeholder="+91..."
              />
            </label>
            <button
              type="button"
              disabled={!selectedSlot || !customerPhone.trim()}
              onClick={() => void createAppointment()}
            >
              Book selected slot
            </button>
          </div>
        </article>
        <article className="card appointments">
          <div className="card-title">
            <h2>Upcoming appointments</h2>
          </div>
          {appointments.map((appointment) => (
            <div className="appointment-row" key={appointment.id}>
              <div>
                <strong>
                  {displayTime(appointment.startsAt)} ·{' '}
                  {appointment.customer.displayName ||
                    appointment.customer.phone}
                </strong>
                <small>
                  {appointment.service.name} with {appointment.staff.name}
                </small>
              </div>
              <span>{appointment.status}</span>
            </div>
          ))}
          {appointments.length === 0 && <p>No upcoming appointments.</p>}
        </article>
        <article className="card schedule">
          <div className="card-title">
            <h2>Working hours</h2>
            <button className="small" onClick={() => void saveHours()}>
              Save
            </button>
          </div>
          <select
            aria-label="Choose staff member"
            value={staffId}
            onChange={(event) => setStaffId(event.target.value)}
          >
            {staff.map((member) => (
              <option key={member.id} value={member.id}>
                {member.name}
              </option>
            ))}
          </select>
          {days.map((day, dayOfWeek) => {
            const hour = hours.find((item) => item.dayOfWeek === dayOfWeek);
            return (
              <div className="hour-row" key={day}>
                <label>
                  <input
                    type="checkbox"
                    checked={Boolean(hour)}
                    onChange={() => toggleDay(dayOfWeek)}
                  />
                  {day}
                </label>
                {hour && (
                  <>
                    <input
                      type="time"
                      value={hour.startTime}
                      onChange={(event) =>
                        changeHour(dayOfWeek, 'startTime', event.target.value)
                      }
                    />
                    <span>to</span>
                    <input
                      type="time"
                      value={hour.endTime}
                      onChange={(event) =>
                        changeHour(dayOfWeek, 'endTime', event.target.value)
                      }
                    />
                  </>
                )}
              </div>
            );
          })}
        </article>
      </section>
    </main>
  );
}
