// Square: cria link de pagamento com cartão e confere os avisos de pagamento (webhook).
import crypto from 'node:crypto';

const VERSION = '2024-10-17';

export function createSquare({ token, locationId, sandbox = false }, fetchImpl = fetch) {
  const base = sandbox ? 'https://connect.squareupsandbox.com/v2' : 'https://connect.squareup.com/v2';
  const headers = { Authorization: `Bearer ${token}`, 'Square-Version': VERSION, 'Content-Type': 'application/json' };
  let location = locationId;

  const call = async (path, opts = {}) => {
    const res = await fetchImpl(base + path, { ...opts, headers });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Square respondeu ${res.status}: ${body.errors?.map((e) => e.detail || e.code).join('; ') || ''}`);
    return body;
  };

  // Sem SQUARE_LOCATION_ID, usa a primeira loja ativa da conta.
  async function findLocation() {
    if (location) return location;
    const { locations = [] } = await call('/locations');
    location = (locations.find((l) => l.status === 'ACTIVE') || locations[0])?.id;
    if (!location) throw new Error('Square: a conta não tem nenhuma loja (location).');
    return location;
  }

  return {
    configured: Boolean(token),
    // Link de pagamento com valor fixo. Devolve { id, url, orderId }.
    async createLink({ amountCents, name, note }) {
      const { payment_link: link } = await call('/online-checkout/payment-links', {
        method: 'POST',
        body: JSON.stringify({
          idempotency_key: crypto.randomUUID(),
          quick_pay: { name: name.slice(0, 255), price_money: { amount: amountCents, currency: 'USD' }, location_id: await findLocation() },
          payment_note: note?.slice(0, 500),
        }),
      });
      return { id: link.id, url: link.url, orderId: link.order_id };
    },
    // Pagamentos desde uma data (para saber a taxa que o Square cobrou de verdade).
    async listPayments(beginTime) {
      const out = [];
      let cursor = '';
      for (let page = 0; page < 10; page++) {
        const q = new URLSearchParams({ begin_time: beginTime, limit: '100', ...(cursor ? { cursor } : {}) });
        const body = await call(`/payments?${q}`);
        out.push(...(body.payments || []));
        if (!(cursor = body.cursor)) break;
      }
      return out;
    },
  };
}

// Assinatura do aviso do Square: HMAC-SHA256 (base64) da URL do webhook + corpo.
export function validSquareSignature({ key, url, rawBody, header }) {
  if (!key || !header) return false;
  const expected = crypto.createHmac('sha256', key).update(url + rawBody.toString('utf8')).digest('base64');
  return expected.length === header.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(header));
}
