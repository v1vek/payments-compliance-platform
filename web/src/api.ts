export type Role = 'customer' | 'compliance';
export type User = { id: string; email: string; name: string; role: Role; label: string; initials: string };

export type CustomerStatus = 'processing' | 'sent' | 'on_hold' | 'cannot_be_processed';
export type CustomerPayment = {
  id: string; code: string; recipient: string; country: string; account: string; reference: string;
  amountCents: number; status: CustomerStatus; submittedAt: string; heldAt: string | null; resolvedAt: string | null;
};
export type Overview = {
  account: { holderName: string; maskedNumber: string; currency: string; ledgerCents: number; heldCents: number; availableCents: number };
  payments: CustomerPayment[];
};

export type Status = 'screening' | 'sent' | 'on_hold' | 'refused' | 'rejected';
export type HoldReason = 'threshold' | 'sanctions_timeout' | 'sanctions_match';
export type ReviewStep = { byId: string; byName: string; action: 'release' | 'reject'; note: string; at: string };
export type FlaggedPayment = {
  id: string; code: string; recipient: string; country: string; account: string; reference: string;
  amountCents: number; status: Status; holdReason: HoldReason; createdAt: string;
  customerName: string; businessName: string;
  screening: { entry: string; type: string; score: number; input: string } | null;
  thresholdCents: number | null; windowPriorCents: number | null;
  recommendation: ReviewStep | null; decision: ReviewStep | null;
};
export type BriefPayment = { id: string; code: string; recipient: string; amountCents: number; status: Status; holdReason: HoldReason | null; createdAt: string };
export type AuditEvent = { id: number; at: string; actor: string; action: string; detail: string; paymentId: string | null; paymentCode: string | null };
export type PaymentDetail = { payment: FlaggedPayment; windowPayments: BriefPayment[]; history: BriefPayment[]; audit: AuditEvent[] };

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

async function request<T>(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(res.status, data?.error?.code ?? 'error', data?.error?.message ?? 'Something went wrong.');
  }
  return data as T;
}

export const api = {
  me: () => request<{ user: User | null }>('GET', '/api/auth/me'),
  config: () => request<{ demoMode: boolean }>('GET', '/api/config'),
  login: (email: string, password: string) => request<{ user: User }>('POST', '/api/auth/login', { email, password }),
  logout: () => request<{ ok: true }>('POST', '/api/auth/logout', {}),
  resetDemo: () => request<{ ok: true }>('POST', '/api/demo/reset', {}),

  overview: () => request<Overview>('GET', '/api/customer/overview'),
  sendPayment: (body: { recipient: string; country: string; account: string; reference: string; amount: string }, idempotencyKey: string) =>
    request<{ payment: CustomerPayment }>('POST', '/api/customer/payments', body, { 'idempotency-key': idempotencyKey }),

  flagged: () => request<{ payments: FlaggedPayment[] }>('GET', '/api/compliance/payments'),
  detail: (id: string) => request<PaymentDetail>('GET', `/api/compliance/payments/${id}`),
  recommend: (id: string, action: 'release' | 'reject', note: string) =>
    request<PaymentDetail>('POST', `/api/compliance/payments/${id}/recommendation`, { action, note }),
  decide: (id: string, action: 'release' | 'reject', note: string) =>
    request<PaymentDetail>('POST', `/api/compliance/payments/${id}/decision`, { action, note }),
  audit: () => request<{ total: number; events: AuditEvent[] }>('GET', '/api/compliance/audit'),
};
