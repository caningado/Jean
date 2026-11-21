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

// Preço pelo tempo do caminhão: ida + volta (tempo da rota de carro + 10% por ser guincho)
// + carregar e descarregar, vezes o valor da hora, arredondado de $10 em $10.
// null quando não tem os minutos ou o valor da hora.
export function timePrice(ctx, minutes) {
  const min = Number(minutes);
  const { perHourCents = 0, loadMinutes = 30, truckFactor = 1 } = ctx.config.pricing || {};
  if (!(min > 0) || !(perHourCents > 0)) return null;
  const ida = Math.round(min * (Number(truckFactor) > 0 ? Number(truckFactor) : 1));
  const load = Number(loadMinutes) || 0;
  const total = ida * 2 + load;
  const cents = Math.max(1000, Math.round(((total / 60) * perHourCents) / 1000) * 1000);
  return { cents, ida, total, perHourCents, loadMinutes: load };
}

const hoursText = (min) => `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}`;

// Devolve { cents, fonte: 'empresa' | 'historico' | 'tabela' | 'tempo', n, texto } ou null.
// Com os minutos da rota, a sugestão é o maior entre o preço por milha e o preço pelo tempo.
export function priceSuggestion(ctx, miles, { contactId = null, companyId = null, minutes = null } = {}) {
  const byMiles = milesSuggestion(ctx, miles, { contactId, companyId });
  const byTime = timePrice(ctx, minutes);
  if (!byTime || (byMiles && byMiles.cents >= byTime.cents)) return byMiles;
  const { ida } = byTime;
  return {
    cents: byTime.cents,
    fonte: 'tempo',
    n: byMiles?.n ?? 0,
    base_cents: byMiles?.base_cents ?? null,
    per_mile_cents: byMiles?.per_mile_cents ?? null,
    minutos_total: byTime.total,
    milhas_cents: byMiles?.cents ?? null,
    texto: `Sugestão ${usd(byTime.cents)} pelo tempo do guincho: ${ida} min de ida + ${ida} de volta + ${byTime.loadMinutes} para pegar e entregar = ${hoursText(byTime.total)} a ${usd(byTime.perHourCents)} a hora.${byMiles ? ` (Só pelas milhas daria ${usd(byMiles.cents)}.)` : ''}`,
  };
}

function milesSuggestion(ctx, miles, { contactId = null, companyId = null } = {}) {
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
