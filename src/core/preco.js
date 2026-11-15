// Sugestão de preço que aprende com os serviços já feitos.
// Olha os serviços com milhas e valor do último ano e acha a "regra" que mais se parece
// com o que o dono cobra: um valor fixo + um valor por milha (regressão linear simples).
// Primeiro tenta só os serviços da mesma empresa do cliente; se forem poucos, usa todos;
// se ainda forem poucos, usa a tabela do Render (PRICE_BASE + PRICE_PER_MILE).
// É só sugestão: quem decide o valor é sempre o dono.

const MIN_SERVICES = 5; // menos que isso não dá para confiar
const MIN_SPREAD_MILES = 3; // as milhas precisam variar um pouco para saber quanto vale cada milha
const MAX_HISTORY = 300;

// Serviços que contam: com milhas e valor, não cancelados e que não são só cotação.
function history(ctx, companyId) {
  const since = new Date(Date.now() - 365 * 86400000).toISOString();
  const byCompany = companyId ? 'AND c.company_id = ?' : '';
  return ctx.db
    .prepare(
      `SELECT s.miles, s.price_cents FROM services s LEFT JOIN contacts c ON c.id = s.contact_id
       WHERE s.miles > 0 AND s.price_cents > 0 AND s.status <> 'cancelado' AND NOT (s.status = 'pendente' AND s.driver_id IS NULL)
         AND s.created_at >= ? ${byCompany}
       ORDER BY s.id DESC LIMIT ${MAX_HISTORY}`
    )
    .all(...[since, companyId].filter(Boolean));
}

// Valor fixo + valor por milha que melhor explicam os preços. null quando não dá para confiar.
export function fitPrices(rows) {
  if (rows.length < MIN_SERVICES) return null;
  const xs = rows.map((r) => r.miles);
  const ys = rows.map((r) => r.price_cents);
  const n = rows.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  const sxx = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
  if (Math.sqrt(sxx / n) < MIN_SPREAD_MILES) return null;
  let perMile = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0) / sxx;
  let base = my - perMile * mx;
  // Preço não pode cair com mais milhas: aí é um valor fixo (a média).
  if (perMile < 0) [perMile, base] = [0, my];
  // Valor fixo negativo não faz sentido: só por milha.
  if (base < 0) [base, perMile] = [0, xs.reduce((a, x, i) => a + x * ys[i], 0) / xs.reduce((a, x) => a + x * x, 0)];
  return { baseCents: Math.round(base), perMileCents: Math.round(perMile), n };
}

const roundTo5 = (cents) => Math.max(500, Math.round(cents / 500) * 500);
const usd = (cents) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;

// Empresa do cliente (para usar o preço que aquela empresa costuma pagar).
function companyOf(ctx, { contactId, companyId }) {
  if (companyId) return Number(companyId) || null;
  if (!contactId) return null;
  return ctx.db.prepare('SELECT company_id FROM contacts WHERE id = ?').get(contactId)?.company_id || null;
}

function companyName(ctx, id) {
  try {
    return ctx.db.prepare('SELECT name FROM companies WHERE id = ?').get(id)?.name || null;
  } catch {
    return null;
  }
}

// Devolve { cents, fonte: 'empresa' | 'historico' | 'tabela', n, texto } ou null.
export function priceSuggestion(ctx, miles, { contactId = null, companyId = null } = {}) {
  const m = Number(miles) > 0 ? Number(miles) : null;
  if (m != null) {
    const company = companyOf(ctx, { contactId, companyId });
    const fromCompany = company && fitPrices(history(ctx, company));
    const model = fromCompany || fitPrices(history(ctx, null));
    if (model) {
      const cents = roundTo5(model.baseCents + model.perMileCents * m);
      const who = fromCompany ? `nos ${model.n} últimos serviços de ${companyName(ctx, company) || 'desta empresa'}` : `nos ${model.n} últimos serviços`;
      return {
        cents,
        fonte: fromCompany ? 'empresa' : 'historico',
        n: model.n,
        base_cents: model.baseCents,
        per_mile_cents: model.perMileCents,
        texto: `Sugestão ${usd(cents)}, pelo que você cobrou ${who} (cerca de ${usd(model.baseCents)} + ${usd(model.perMileCents)} por milha).`,
      };
    }
  }
  const { baseCents, perMileCents } = ctx.config.pricing;
  if (!baseCents && !perMileCents) return null;
  if (m == null && !baseCents) return null;
  const cents = baseCents + Math.round((m || 0) * perMileCents);
  return {
    cents,
    fonte: 'tabela',
    n: 0,
    base_cents: baseCents,
    per_mile_cents: perMileCents,
    texto: perMileCents ? `Pela tabela dá ${usd(cents)} (${usd(baseCents)} + ${usd(perMileCents)} por milha).` : `Pela tabela dá ${usd(cents)}.`,
  };
}
