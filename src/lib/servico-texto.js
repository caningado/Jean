// Plano B quando a inteligência (Gemini) não responde: tira de um texto encaminhado
// (localização, valor, endereço, carro, telefone) o que der para abrir um serviço novo.
// O robô mostra o que entendeu e pergunta o resto, então errar aqui custa pouco.

const PHONE = /(?<!\d)(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/;
const MONEY = /\$\s?(\d{1,5}(?:[.,]\d{1,2})?)\b/;
const COORDS = /\(\s*-?\d{1,3}\.\d+\s*,\s*-?\d{1,3}\.\d+\s*\)/;
// "4209 Old Winter Garden Rd", "123 Main St, Orlando"
const STREET = /^\s*\d{1,6}\s+[A-Za-z]/;
const PLACE_WORDS = /\b(rd|road|st|street|ave|avenue|blvd|dr|drive|hwy|highway|ln|lane|pkwy|way|ct|pl|tpke|fl|florida)\b/i;
// Palavras soltas que são rótulo, não dado.
const LABELS = /^(pegar|retirar|retirada|buscar|deixar|levar|entregar|destino|origem|from|to|pickup|drop ?off|cliente|carro|valor|pre[cç]o|telefone|phone|ok|oi|ola|olá)\s*:?\s*$/i;

// "Pegar: 123 Main St" / "Drop off: ...": o rótulo diz se é retirada ou destino.
const PICK_LABEL = /^(pegar|retirar|retirada|buscar|origem|from|pick ?up)\s*:\s*(.+)$/i;
const DROP_LABEL = /^(deixar|levar|entregar|entrega|destino|to|drop ?off)\s*:\s*(.+)$/i;

export function guessService(text) {
  const novo = {};
  const places = [];
  for (const raw of String(text || '').split('\n')) {
    let line = raw.trim();
    if (!line) continue;
    const pick = line.match(PICK_LABEL);
    const drop = !pick && line.match(DROP_LABEL);
    if (pick && !novo.retirada) {
      novo.retirada = pick[2].trim();
      continue;
    }
    if (drop && !novo.destino) {
      novo.destino = drop[2].trim();
      continue;
    }
    const contact = line.match(/^Contato do cliente:\s*(.*)$/i);
    if (contact) line = contact[1];
    const phone = line.match(PHONE);
    if (phone && !novo.telefone) {
      novo.telefone = phone[0].replace(/\D/g, '').replace(/^(\d{10})$/, '1$1');
      const name = line.replace(phone[0], '').trim();
      if (contact && name && name !== 'sem nome') novo.cliente = name;
      continue;
    }
    const money = line.match(MONEY);
    if (money && novo.valor == null && line.length < 40) {
      novo.valor = Number(money[1].replace(',', '.'));
      continue;
    }
    if (COORDS.test(line) || STREET.test(line) || (PLACE_WORDS.test(line) && /\d/.test(line))) {
      places.push(line);
      continue;
    }
    if (LABELS.test(line)) continue;
    // Linha curta que sobrou (ex.: "Colorado", "2015 Honda Civic"): provavelmente o carro.
    if (!novo.veiculo && line.split(/\s+/).length <= 5 && line.length <= 40) novo.veiculo = line;
  }
  if (!novo.retirada && places.length) novo.retirada = places.shift();
  if (!novo.destino && places.length) novo.destino = places.shift();
  return novo;
}

// Tem cara de serviço: pelo menos dois dados fortes (lugar, telefone, valor).
export function looksLikeService(novo) {
  return [novo.retirada, novo.destino, novo.telefone, novo.valor != null].filter(Boolean).length >= 2;
}
