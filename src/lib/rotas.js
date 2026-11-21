// Milhas de carro entre a retirada e o destino, pelo Google Maps (Routes API).
// Precisa da chave GOOGLE_MAPS_API_KEY. Sem chave, nada é calculado e as milhas continuam à mão.
// Cada cálculo pede a rota normal com o valor do pedágio e, se ela tiver pedágio, também a rota sem pedágio.
// O valor do pedágio que o Google dá é o de CARRO (2 eixos): o guincho com carro em cima pode pagar mais.

import { coordsOf, isMapReference } from './validate.js';

const ROUTES = 'https://routes.googleapis.com/directions/v2:computeRoutes';
// Link curto (maps.app.goo.gl, Waze) não tem as coordenadas: abre o link para achar.
const SHORT_LINK = /^https?:\/\/(maps\.app\.goo\.gl|goo\.gl|g\.co|waze\.com\/ul)\b/i;
const METERS_PER_MILE = 1609.344;

export function createRouter({ apiKey, fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  if (!apiKey) return null;
  const cache = new Map();

  // Endereço, coordenadas ou link do mapa -> ponto que o Google entende. null = não deu para saber onde é.
  async function waypoint(location) {
    const text = String(location || '').trim();
    if (!text) return null;
    let coords = coordsOf(text);
    if (!coords && isMapReference(text)) {
      const url = text.match(/https?:\/\/[^\s]+/i)?.[0];
      if (url && SHORT_LINK.test(url)) {
        try {
          const res = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(5000) });
          coords = coordsOf(res.url) || coordsOf((await res.text()).slice(0, 200000));
        } catch {
          /* link quebrado ou sem internet */
        }
      }
      // Sobrou o que foi escrito junto do link (ex.: "Walmart Kissimmee https://...").
      if (!coords) {
        const rest = text.replace(/https?:\/\/[^\s]+/gi, '').trim();
        return rest.length >= 4 ? { address: rest } : null;
      }
    }
    if (coords) {
      const [latitude, longitude] = coords.split(',').map(Number);
      return { location: { latLng: { latitude, longitude } } };
    }
    return { address: text };
  }

  async function compute(from, to, avoidTolls) {
    const body = { origin: from, destination: to, travelMode: 'DRIVE', routingPreference: 'TRAFFIC_UNAWARE', units: 'IMPERIAL' };
    if (avoidTolls) body.routeModifiers = { avoidTolls: true };
    else body.extraComputations = ['TOLLS'];
    let data;
    try {
      const res = await fetchImpl(ROUTES, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration' + (avoidTolls ? '' : ',routes.travelAdvisory.tollInfo'),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      data = await res.json().catch(() => null);
      if (!res.ok) {
        const err = new Error(data?.error?.message || `Google Maps respondeu ${res.status}`);
        err.status = res.status;
        throw err;
      }
    } catch (err) {
      err.google = true;
      throw err;
    }
    const best = data?.routes?.[0];
    if (!best?.distanceMeters) return null;
    const out = { miles: Math.round((best.distanceMeters / METERS_PER_MILE) * 10) / 10, minutes: Math.round(parseInt(best.duration, 10) / 60) || null };
    if (!avoidTolls) {
      const prices = best.travelAdvisory?.tollInfo?.estimatedPrice || [];
      const usd = prices.find((p) => (p.currencyCode || 'USD') === 'USD');
      // tollInfo presente = a rota passa por pedágio. Sem preço = o Google não sabe quanto custa.
      out.has_tolls = Boolean(best.travelAdvisory?.tollInfo);
      out.toll_cents = usd ? Math.round(Number(usd.units || 0) * 100 + Number(usd.nanos || 0) / 1e7) : null;
    }
    return out;
  }

  // Duas rotas: a normal do Google (pode ter pedágio, com o valor do pedágio de CARRO) e a sem pedágio.
  // Devolve { miles, minutes, has_tolls, toll_cents, sem_pedagio: { miles, minutes } | null } ou null.
  // miles/minutes = rota normal (a mais rápida).
  async function route(origin, destination) {
    const key = `${String(origin).trim().toLowerCase()}|${String(destination).trim().toLowerCase()}`;
    if (cache.has(key)) return cache.get(key);
    const [from, to] = await Promise.all([waypoint(origin), waypoint(destination)]);
    if (!from || !to) return null;
    const main = await compute(from, to, false);
    let result = main;
    if (main?.has_tolls) {
      // Só pede a rota sem pedágio quando a normal tem pedágio (economiza cálculos).
      const free = await compute(from, to, true).catch(() => null);
      result = { ...main, sem_pedagio: free && { miles: free.miles, minutes: free.minutes } };
    } else if (main) result = { ...main, sem_pedagio: null };
    cache.set(key, result);
    if (cache.size > 500) cache.delete(cache.keys().next().value);
    return result;
  }

  return { route };
}

const tempo = (min) => (!min ? '' : min < 60 ? `${min} min` : `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}`);
const dolar = (cents) => `$${(cents / 100).toFixed(2)}`;

// As rotas em texto (para o Jay e o Claude). bold = '*' no WhatsApp.
export function routeLines(r, bold = '') {
  if (!r) return [];
  const b = (t) => `${bold}${t}${bold}`;
  if (!r.has_tolls) return [`📍 Pelo Google Maps: ${b(`${r.miles} mi`)}${r.minutes ? `, uns ${tempo(r.minutes)}` : ''} (sem pedágio no caminho).`];
  const toll = r.toll_cents != null ? `pedágio ~${dolar(r.toll_cents)} (preço de carro)` : 'tem pedágio (valor não informado)';
  const lines = [`📍 Com pedágio: ${b(`${r.miles} mi`)}${r.minutes ? `, uns ${tempo(r.minutes)}` : ''}, ${toll}.`];
  if (r.sem_pedagio) lines.push(`📍 Sem pedágio: ${b(`${r.sem_pedagio.miles} mi`)}${r.sem_pedagio.minutes ? `, uns ${tempo(r.sem_pedagio.minutes)}` : ''}.`);
  return lines;
}

// Calcula sem quebrar nada: qualquer erro vira null (e fica no log).
export async function routeMiles(ctx, pickup, dropoff) {
  if (!ctx.rotas || !pickup || !dropoff) return null;
  try {
    return await ctx.rotas.route(pickup, dropoff);
  } catch (err) {
    ctx.log('Google Maps (milhas):', err.message);
    return null;
  }
}
