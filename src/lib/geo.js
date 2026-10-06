// Confere se um endereço existe no mapa, usando serviços gratuitos e sem chave:
// 1) Census Geocoder do governo americano (endereços com número da casa);
// 2) Photon (mapa aberto OpenStreetMap) para lugares, rodovias, saídas, lojas...
// Se os dois estiverem fora do ar, o endereço é aceito como foi digitado.

const CENSUS = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';
const PHOTON = 'https://photon.komoot.io/api/';
const KEEP_UPPER = /^(N|S|E|W|NE|NW|SE|SW|\d.*)$/;

// "12 MAIN ST, FRAMINGHAM, MA, 01701" -> "12 Main St, Framingham, MA 01701"
export function prettyCensus(matched) {
  const parts = String(matched).split(',').map((p) => p.trim());
  const zip = /^\d{5}$/.test(parts.at(-1)) ? parts.pop() : '';
  const last = parts.length - 1; // a última parte é o estado (MA, DC...)
  const words = parts.map((p, i) =>
    i === last && /^[A-Z]{2}$/.test(p)
      ? p
      : p
          .split(/\s+/)
          .map((w) => (KEEP_UPPER.test(w) ? w : w.charAt(0) + w.slice(1).toLowerCase()))
          .join(' ')
  );
  if (zip) words[words.length - 1] += ' ' + zip;
  return words.join(', ');
}

export function photonLabel(p) {
  const street = [p.housenumber, p.street].filter(Boolean).join(' ');
  const first = p.name && p.name !== street ? [p.name, street].filter(Boolean).join(', ') : street || p.name;
  const city = p.city || p.town || p.village || p.district || p.county;
  const state = [p.state, p.postcode].filter(Boolean).join(' ');
  return [first, city !== first ? city : null, state].filter(Boolean).join(', ');
}

export function createGeocoder({ fetchImpl = fetch, timeoutMs = 6000, userAgent = 'towing-jj (guincho)' } = {}) {
  const cache = new Map();
  const get = async (url) => {
    const res = await fetchImpl(url, { headers: { 'User-Agent': userAgent, Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };

  async function census(query) {
    const url = `${CENSUS}?benchmark=Public_AR_Current&format=json&address=${encodeURIComponent(query)}`;
    const data = await get(url);
    return (data?.result?.addressMatches || []).map((m) => ({
      label: prettyCensus(m.matchedAddress),
      lat: m.coordinates?.y,
      lng: m.coordinates?.x,
    }));
  }

  async function photon(query, limit) {
    const data = await get(`${PHOTON}?q=${encodeURIComponent(query)}&limit=${limit * 2}&lang=en`);
    return (data?.features || [])
      .filter((f) => (f.properties?.countrycode || '').toUpperCase() === 'US')
      .map((f) => ({ label: photonLabel(f.properties), lat: f.geometry?.coordinates?.[1], lng: f.geometry?.coordinates?.[0] }));
  }

  // Devolve { status: 'ok' | 'nada' | 'erro', matches: [{ label, lat, lng }] }
  async function lookup(query, { limit = 5 } = {}) {
    const key = `${limit}:${query.toLowerCase()}`;
    if (cache.has(key)) return cache.get(key);
    let matches = [];
    let failures = 0;
    if (/^\s*\d+[a-z]?\s+\S/i.test(query)) {
      try {
        matches = await census(query);
      } catch {
        failures++;
      }
    }
    if (!matches.length) {
      try {
        matches = await photon(query, limit);
      } catch {
        failures++;
      }
    }
    const seen = new Set();
    matches = matches.filter((m) => m.label && !seen.has(m.label.toLowerCase()) && seen.add(m.label.toLowerCase())).slice(0, limit);
    const result = { status: matches.length ? 'ok' : failures && !matches.length ? 'erro' : 'nada', matches };
    if (result.status !== 'erro') {
      cache.set(key, result);
      if (cache.size > 500) cache.delete(cache.keys().next().value);
    }
    return result;
  }

  return { lookup };
}
