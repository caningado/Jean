// Painel no celular. Telas simples, uma por endereço (#/servicos, #/servico/12...).
const view = document.getElementById('view');
const titleEl = document.getElementById('title');
const tabs = document.getElementById('tabs');
const backBtn = document.getElementById('back');
const toastEl = document.getElementById('toast');

const state = { me: null, modules: [], company: 'Towing J&J' };
const has = (name) => state.modules.some((m) => m.name === name);

const METHODS = { zelle: 'Zelle', dinheiro: 'Dinheiro', cartao: 'Cartão', cheque: 'Cheque', seguradora: 'Seguradora / motor club' };
const CATEGORIES = { combustivel: 'Combustível', pedagio: 'Pedágio', manutencao: 'Manutenção', alimentacao: 'Alimentação', outros: 'Outros' };
const STATUS = { pendente: 'Pendente', aberto: 'Em andamento', concluido: 'Entregue', cancelado: 'Cancelado' };
// Pendente que já tem motorista: está na fila dele, "Aguardando" ele escolher e começar.
const queued = (s) => s.status === 'pendente' && !!s.driver_id;
const badge = (s) => (queued(s) ? '<span class="badge aguardando">Aguardando</span>' : `<span class="badge ${s.status}">${STATUS[s.status]}</span>`);
const PHOTO_KINDS = { antes: 'Antes', depois: 'Depois', vin: 'VIN', outro: 'Outra' };

// ---------- utilidades ----------
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
const money = (cents) => '$' + ((cents || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const phoneFmt = (p) => (/^1\d{10}$/.test(p || '') ? `(${p.slice(1, 4)}) ${p.slice(4, 7)}-${p.slice(7)}` : p ? '+' + p : '');
// Manda um texto pronto para o cliente: compartilhar do celular, WhatsApp ou copiar.
async function shareText(message, phone) {
  if (navigator.share) {
    navigator.share({ text: message }).catch(() => {});
  } else if (phone) {
    window.open(`https://wa.me/${phone}?text=${encodeURIComponent(message)}`, '_blank');
  } else {
    await navigator.clipboard?.writeText(message);
    toast('Mensagem copiada');
  }
}
const when = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');

// Endereço, link de mapa ou coordenadas -> link que abre no mapa do celular.
const COORDS = /(-?\d{1,2}\.\d{3,})\s*,\s*(-?\d{1,3}\.\d{3,})/;
function mapLink(location) {
  const url = location.match(/https?:\/\/[^\s]+/i)?.[0];
  if (url) return url;
  const c = location.match(COORDS);
  if (c) return `https://www.google.com/maps?q=${c[1]},${c[2]}`;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(location)}`;
}
// Mostra o local sem o link comprido, com um botão para abrir no mapa.
function placeHtml(icon, location, nickname) {
  if (!location) return '';
  const label = location.replace(/https?:\/\/[^\s]+/gi, '').trim() || 'Local pelo link do mapa';
  return `<div class="place">${icon} ${nickname ? `<strong>${esc(nickname)}</strong> · ` : ''}${esc(label)} <a href="${esc(mapLink(location))}" target="_blank" rel="noopener">Abrir no mapa</a></div>`;
}

function toast(message) {
  toastEl.textContent = message;
  toastEl.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => toastEl.classList.add('hidden'), 3000);
}

// Todo pedido ao servidor passa por aqui. Servidor fora do ar por alguns minutos (atualização):
// mostra o aviso de manutenção, que volta sozinho para a mesma tela quando o sistema responder.
function maintenance() {
  location.replace('/manutencao.html?volta=' + encodeURIComponent('/' + location.hash));
  return new Error('Sistema em manutenção.');
}
async function net(url, opts) {
  let res;
  try {
    res = await fetch(url, opts);
  } catch {
    // Nenhuma resposta: é o sinal do celular (com o servidor reiniciando a Render responde 502).
    throw new Error('Sem conexão. Confira o sinal e tente de novo.');
  }
  if (res.status >= 502 && res.status <= 504) throw maintenance();
  return res;
}

async function api(path, { method = 'GET', body, raw, type, withTotal } = {}) {
  const opts = { method, headers: {} };
  if (raw) {
    opts.body = raw;
    opts.headers['Content-Type'] = type || raw.type || 'application/octet-stream';
  } else if (body !== undefined) {
    opts.body = JSON.stringify(body);
    opts.headers['Content-Type'] = 'application/json';
  }
  const res = await net('/api' + path, opts);
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (res.status === 401 && path !== '/login') {
    state.me = null;
    location.hash = '#/login';
    throw new Error(data?.error || 'Faça login.');
  }
  if (!res.ok) {
    const err = new Error(data?.error || 'Algo deu errado.');
    err.code = data?.code;
    throw err;
  }
  return withTotal ? { data, total: Number(res.headers.get('X-Total-Count')) || 0 } : data;
}

// Agenda do celular (Contact Picker): funciona no Chrome do Android. O iPhone ainda não deixa.
const canPickContacts = 'contacts' in navigator && 'ContactsManager' in window;

// Abre a agenda do celular e devolve [{ name, phones: [...] }].
async function pickPhoneContacts(multiple = false) {
  // Pede também o endereço quando o celular deixa (Android).
  const can = (await navigator.contacts.getProperties?.().catch(() => [])) || [];
  const picked = await navigator.contacts.select(['name', 'tel', ...(can.includes('address') ? ['address'] : [])], { multiple });
  return picked
    .map((c) => ({ name: String([].concat(c.name || []).find((n) => n && String(n).trim()) || '').trim(), phones: [...new Set((c.tel || []).map((t) => t.trim()).filter(Boolean))], address: addressText((c.address || [])[0]) }))
    .filter((c) => c.name || c.phones.length);
}

const addressText = (a) => (a ? [...(a.addressLine || []), a.city, [a.region, a.postalCode].filter(Boolean).join(' ')].filter((v) => v && String(v).trim()).join(', ') : '');

const vcfEscape = (v) => String(v).replace(/[\\,;]/g, (m) => '\\' + m).replace(/\n/g, ' ');

// Sugestões de endereço do mapa enquanto digita (retirada e destino).
function placeSuggestions(input) {
  // Lista própria (não o <datalist> do navegador): o iPhone esconde a opção quando o
  // texto digitado é o apelido ("ribas") e não aparece no endereço ("643 Barry St").
  const wrap = document.createElement('div');
  wrap.className = 'suggest-wrap';
  input.before(wrap);
  wrap.append(input);
  const list = document.createElement('ul');
  list.className = 'suggest';
  list.hidden = true;
  wrap.append(list);
  input.autocomplete = 'off';
  let timer;
  const close = () => (list.hidden = true);
  input.addEventListener('blur', () => setTimeout(close, 200));
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2 || /https?:\/\//i.test(q)) return close();
    timer = setTimeout(async () => {
      // Endereços com apelido (ex.: "ribas") aparecem primeiro, depois os do mapa.
      const { matches = [], saved = [] } = await api(`/places?q=${encodeURIComponent(q)}`).catch(() => ({}));
      if (input.value.trim() !== q) return;
      const items = [
        ...saved.map((p) => ({ value: p.address, html: `⭐ <strong>${esc(p.nickname)}</strong><span class="sub">${esc(p.address)}</span>` })),
        ...matches.filter((m) => !saved.some((p) => p.address === m)).map((m) => ({ value: m, html: esc(m) })),
      ];
      list.innerHTML = items.map((it, i) => `<li><button type="button" data-i="${i}">${it.html}</button></li>`).join('');
      list.hidden = !items.length;
      list.querySelectorAll('button').forEach((b) => {
        // pointerdown: escolhe antes do campo perder o foco (e a lista fechar).
        const pick = (e) => {
          e.preventDefault();
          input.value = items[Number(b.dataset.i)].value;
          close();
          input.dispatchEvent(new Event('change', { bubbles: true }));
        };
        b.onpointerdown = pick;
        b.onclick = pick;
      });
    }, q.length < 6 ? 250 : 600);
  });
}

// Salva; se o endereço não foi achado no mapa, pergunta se quer salvar assim mesmo.
// Janela do próprio app (no lugar do confirm/prompt do navegador, que mostra "site says").
// Devolve true/false (pergunta), o texto digitado ou null (com campo), ou o índice escolhido (choices).
function dialog({ title = '', text = '', input = null, choices = null, ok = 'OK', cancel = 'Voltar', danger = false } = {}) {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'dialog-back';
    back.innerHTML = `<div class="dialog" role="dialog" aria-modal="true">
      ${title ? `<h2>${esc(title)}</h2>` : ''}
      ${text ? `<p>${esc(text).replace(/\n/g, '<br>')}</p>` : ''}
      ${input ? (input.multiline ? `<textarea rows="3" placeholder="${esc(input.placeholder || '')}">${esc(input.value ?? '')}</textarea>` : `<input inputmode="${input.numeric ? 'decimal' : 'text'}" placeholder="${esc(input.placeholder || '')}" value="${esc(input.value ?? '')}">`) : ''}
      ${choices ? `<div class="dialog-choices">${choices.map((c, i) => `<button type="button" class="secondary" data-i="${i}">${esc(c)}</button>`).join('')}</div>` : ''}
      <div class="dialog-actions"><button type="button" class="secondary" data-act="no">${esc(cancel)}</button>${choices ? '' : `<button type="button" class="${danger ? 'danger' : ''}" data-act="yes">${esc(ok)}</button>`}</div>
    </div>`;
    const field = back.querySelector('input, textarea');
    const done = (value) => {
      back.remove();
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };
    const yes = () => done(input ? field.value : true);
    const no = () => done(input ? null : choices ? null : false);
    const onKey = (e) => {
      if (e.key === 'Escape') no();
      if (e.key === 'Enter' && !(field && field.tagName === 'TEXTAREA') && !choices) yes();
    };
    back.querySelector('[data-act="no"]').onclick = no;
    back.querySelector('[data-act="yes"]')?.addEventListener('click', yes);
    back.querySelectorAll('[data-i]').forEach((b) => (b.onclick = () => done(Number(b.dataset.i))));
    back.onclick = (e) => e.target === back && no();
    document.addEventListener('keydown', onKey);
    document.body.append(back);
    (field || back.querySelector('[data-act="yes"]') || back.querySelector('[data-i]'))?.focus();
    if (field) field.select?.();
  });
}
const ask = (text, opts = {}) => dialog({ text, ok: 'Sim', cancel: 'Não', ...opts });
const askText = (text, value = '', opts = {}) => dialog({ ...opts, text, input: { value, ...(opts.input || {}) } });

async function sendCheckingAddress(send, body) {
  try {
    return await send(body);
  } catch (err) {
    if (err.code === 'endereco' && (await ask(`${err.message}\n\nSalvar assim mesmo?`))) return send({ ...body, address_ok: true });
    throw err;
  }
}

function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

// Diminui a foto antes de enviar (economiza dados e espaço).
async function shrinkImage(file, max = 1600) {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve) => canvas.toBlob((b) => resolve(b || file), 'image/jpeg', 0.85));
  } catch {
    return file;
  }
}

function pickPhoto() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.setAttribute('capture', 'environment');
    input.onchange = () => resolve(input.files[0] || null);
    input.click();
  });
}

// ---------- computador ----------
// Tela grande: menu na lateral, tabelas no lugar das listas e cartões lado a lado.
const deskQuery = window.matchMedia('(min-width: 1000px)');
const isDesk = () => deskQuery.matches;
const sideEl = document.getElementById('side');
const ICONS = {
  servicos: '<path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"/><path d="M15 18H9"/><path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.62l-3.48-4.35A1 1 0 0 0 17.52 8H14"/><circle cx="17" cy="18" r="2"/><circle cx="7" cy="18" r="2"/>',
  novo: '<circle cx="12" cy="12" r="9"/><path d="M12 8v8"/><path d="M8 12h8"/>',
  contatos: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  resumo: '<path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>',
  pendentes: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  planilha: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/><path d="M9 3v18"/>',
  despesas: '<path d="M4 2v20l3-2 3 2 3-2 3 2 3-2 1 .7V2l-1 .7-3-2-3 2-3-2-3 2-3-2Z"/><path d="M8 8h8"/><path d="M8 12h8"/><path d="M8 16h5"/>',
  caminhoes: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76Z"/>',
  comissao: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 12h.01"/><path d="M18 12h.01"/>',
  empresas: '<path d="M3 21h18"/><path d="M5 21V7l7-4 7 4v14"/><path d="M9 9h1"/><path d="M14 9h1"/><path d="M9 13h1"/><path d="M14 13h1"/><path d="M10 21v-4h4v4"/>',
  equipe: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/>',
  empresa: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h5"/>',
  enderecos: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
  backup: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>',
  robo: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z"/>',
  mais: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/>',
  sair: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>',
};
// Telas de dentro apontam para o item do menu de onde vieram.
const SIDE_PARENT = { servico: 'servicos', editar: 'servicos', invoice: 'servicos', contato: 'contatos', cliente: 'empresas', manutencao: 'caminhoes', motorista: 'comissao' };

function renderSide() {
  if (!state.me) return;
  const owner = state.me.role === 'dono';
  const item = (key, href, label) => `<a href="${href}" data-side="${key}"><svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[key] || ICONS.mais}</svg><span>${label}</span></a>`;
  const groups = [
    ['', [item('servicos', '#/servicos', 'Serviços'), item('novo', '#/novo', 'Novo serviço'), item('contatos', '#/contatos', 'Clientes'), item('resumo', '#/resumo', 'Resumo')]],
    [
      'Financeiro',
      [
        has('pagamentos') ? item('pendentes', '#/pendentes', owner ? 'Pendências' : 'Minhas pendências') : '',
        has('comissao') ? item('comissao', owner ? '#/comissao' : `#/motorista/${state.me.id}`, owner ? 'Pagar motoristas' : 'Meus ganhos') : '',
        has('despesas') ? item('despesas', '#/despesas', 'Despesas') : '',
        has('planilha') && owner ? item('planilha', '#/planilha', 'Planilha do Excel') : '',
      ],
    ],
    [
      'Empresa',
      [
        has('manutencao') ? item('caminhoes', '#/caminhoes', 'Caminhões') : '',
        has('empresas') && owner ? item('empresas', '#/empresas', 'Empresas e extrato') : '',
        owner ? item('equipe', '#/equipe', 'Equipe') : '',
        has('invoice') && owner ? item('empresa', '#/empresa', 'Dados da empresa') : '',
        item('enderecos', '#/enderecos', 'Endereços com apelido'),
        has('backup') && owner ? item('backup', '#/backup', 'Backup') : '',
        owner ? item('robo', '#/robo', 'Testar o Jay (robô)') : '',
      ],
    ],
  ];
  sideEl.innerHTML = `
    <div class="side-brand"><img src="/icon-192.png" alt=""><span>${esc(state.company)}</span></div>
    <nav>${groups
      .map(([title, items]) => (items.join('') ? `${title ? `<div class="side-title">${title}</div>` : ''}${items.join('')}` : ''))
      .join('')}</nav>
    <div class="side-foot">
      ${item('mais', '#/mais', 'Configurações')}
      <div class="side-me"><strong>${esc(state.me.name)}</strong><span>${owner ? 'ADM' : 'Motorista'}</span></div>
      ${item('sair', '#/sair', 'Sair')}
    </div>`;
}

function markSide(tab) {
  let key = SIDE_PARENT[state.screen] || state.screen;
  if (!sideEl.querySelector(`[data-side="${key}"]`)) key = tab === 'mais' ? 'mais' : tab;
  sideEl.querySelectorAll('a').forEach((a) => a.classList.toggle('active', a.dataset.side === key));
}

// Número do serviço: o motorista vê o número do dia dele (1, 2, 3... recomeça todo dia); o ADM vê o número geral.
// Aparece nas listas de motorista: motorista, ou ADM marcado como "ADM e motorista".
const drives = (u) => u.role === 'motorista' || u.drives;

function num(s) {
  return state.me?.role !== 'dono' && s.driver_id === state.me?.id && s.driver_seq ? s.driver_seq : s.id;
}
// O número do serviço é interno: só o ADM vê no painel (pedido do Caningado 21/10). Ex.: "#58 " ou "".
function numTag(s) {
  return state.me?.role === 'dono' ? `#${typeof s === 'object' ? num(s) : s} ` : '';
}

function setScreen(title, { tab = null, back = null } = {}) {
  titleEl.textContent = title;
  document.title = `${title} · ${state.company}`;
  tabs.classList.toggle('hidden', !state.me);
  sideEl.classList.toggle('hidden', !state.me);
  document.body.classList.toggle('logged', Boolean(state.me));
  if (state.me) markSide(tab);
  view.dataset.screen = state.screen || '';
  tabs.querySelectorAll('a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
  // No computador o menu lateral já leva a essas telas: o "voltar" só fica nas telas de dentro.
  if (isDesk() && state.me && sideEl.querySelector(`[data-side="${state.screen}"]`)) back = null;
  backBtn.classList.toggle('hidden', !back);
  document.getElementById('logo').classList.toggle('hidden', Boolean(back));
  backBtn.onclick = back ? () => (location.hash = back) : null;
  window.scrollTo(0, 0);
}

// ---------- gate pass (PDF ou foto do leilão) ----------
const DOC_ACCEPT = 'application/pdf,image/*';
const isDocFile = (f) => f && (f.type === 'application/pdf' || f.type.startsWith('image/'));
const docName = (f, i = 0) => f.name && f.name !== 'image.png' ? f.name : `gate pass${i ? ' ' + (i + 1) : ''}.${(f.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg')}`;
const uploadDoc = (serviceId, file, i = 0) => api(`/services/${serviceId}/docs?name=${encodeURIComponent(docName(file, i))}`, { method: 'POST', raw: file, type: file.type });

// Escolher, colar (Ctrl+V) ou arrastar arquivos: chama onFiles com os PDFs e imagens.
function docPicker(zone, button, onFiles) {
  const take = (files) => {
    const ok = [...files].filter(isDocFile);
    if (files.length && !ok.length) toast('Mande um PDF ou uma foto.');
    if (ok.length) onFiles(ok);
  };
  button.onclick = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = DOC_ACCEPT;
    input.multiple = true;
    input.onchange = () => take(input.files);
    input.click();
  };
  const onPaste = (e) => {
    if (!document.body.contains(zone)) return window.removeEventListener('paste', onPaste);
    const files = e.clipboardData?.files;
    if (files?.length) {
      e.preventDefault();
      take(files);
    }
  };
  window.addEventListener('paste', onPaste);
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('drop');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('drop'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('drop');
    take(e.dataTransfer.files);
  });
}

// Linhas de tabela que abrem uma tela ao clicar (ou Enter no teclado).
function linkRows(root) {
  root.querySelectorAll('tr[data-href]').forEach((tr) => {
    tr.onclick = (e) => {
      if (e.target.closest('a, button, input, select')) return;
      location.hash = tr.dataset.href;
    };
    tr.onkeydown = (e) => e.key === 'Enter' && tr.click();
  });
}

// ---------- telas ----------
const screens = {};

screens.login = async () => {
  const setup = await api('/setup');
  state.company = setup.company;
  setScreen(setup.company);
  if (setup.needsSetup) {
    view.innerHTML = `
      <div class="card">
        <h2>Primeiro acesso</h2>
        <p class="sub">Cadastre o ADM da empresa. Use o mesmo número do seu WhatsApp.</p>
        <form id="f">
          <label>Seu nome</label><input name="name" required autocomplete="name">
          <label>Telefone (WhatsApp)</label><input name="phone" type="tel" required placeholder="(508) 555-0100">
          <label>Crie um PIN (4 a 8 números)</label><input name="pin" type="password" inputmode="numeric" pattern="[0-9]{4,8}" required>
          <button class="block">Começar</button>
        </form>
      </div>`;
    view.querySelector('#f').onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api('/setup', { method: 'POST', body: formData(e.target) });
        await loadMe();
        location.hash = '#/servicos';
      } catch (err) {
        toast(err.message);
      }
    };
    return;
  }
  view.innerHTML = `
    <div class="card">
      <h2>Entrar</h2>
      <form id="f">
        <label>Telefone (WhatsApp)</label><input name="phone" type="tel" required autocomplete="tel">
        <label>PIN</label><input name="pin" type="password" inputmode="numeric" required>
        <button class="block">Entrar</button>
      </form>
    </div>`;
  view.querySelector('#f').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('/login', { method: 'POST', body: formData(e.target) });
      await loadMe();
      location.hash = '#/servicos';
    } catch (err) {
      toast(err.message);
    }
  };
};

// Fundo verde claro = pago; vermelho claro = falta receber.
// Serviço sem cobrança aparece como "Free".
const priceText = (cents) => (cents === 0 ? 'Free' : money(cents));
const payClass = (s) => (s.paid === true ? ' class="pago"' : s.paid === false ? ' class="nao-pago"' : '');

screens.servicos = async (params) => {
  setScreen('Serviços', { tab: 'servicos' });
  const status = params.get('status') ?? 'aberto';
  const driver = params.get('driver') || '';
  // Entregues: abre no dia de hoje; dá para trocar para a semana ou o mês.
  // "Todos" (só dono/sócio): também por período, de todos os motoristas.
  const comPeriodo = status === 'concluido' || (status === '' && state.me.role === 'dono');
  const periodo = comPeriodo ? (['semana', 'mes'].includes(params.get('periodo')) ? params.get('periodo') : 'dia') : '';
  // O ADM pode ver só os serviços de um motorista. A lista tem só quem tem cargo de motorista.
  const drivers = state.me.role === 'dono' ? (await api('/users')).filter((d) => drives(d) || String(d.id) === driver) : [];
  const query = (s, d, p = '') => `#/servicos?status=${s}${d ? `&driver=${d}` : ''}${p ? `&periodo=${p}` : ''}`;
  // Fila: serviços pendentes, que ainda não têm motorista trabalhando.
  // Só o dono vê a fila: é ele quem escolhe o motorista.
  const fila = state.me.role === 'dono' ? await api('/services?status=pendente').catch(() => []) : [];
  view.innerHTML = `
    <div class="segmented">
      ${state.me.role === 'dono' ? `<button data-s="pendente">Pendentes${fila.length ? ` <span class="badge pendente">${fila.length}</span>` : ''}</button>` : ''}<button data-s="aberto">Andamento</button><button data-s="concluido">Entregues</button>${state.me.role === 'dono' ? '<button data-s="">Todos</button>' : ''}
    </div>
    ${periodo ? `<div class="segmented periodo">${[['dia', 'Hoje'], ['semana', 'Semana'], ['mes', 'Mês']].map(([p, l]) => `<button data-p="${p}" class="${p === periodo ? 'active' : ''}">${l}</button>`).join('')}</div>` : ''}
    ${drivers.length > 1 ? `<select id="driver" aria-label="Motorista"><option value="">Todos os motoristas</option>${drivers.map((d) => `<option value="${d.id}" ${String(d.id) === driver ? 'selected' : ''}>${esc(d.name)}${d.id === state.me.id ? ' (eu)' : ''}</option>`).join('')}</select>` : ''}
    <div class="card"><ul class="list" id="list"><li class="empty">Carregando…</li></ul></div>`;
  view.querySelectorAll('.segmented:not(.periodo) button').forEach((b) => {
    b.classList.toggle('active', b.dataset.s === status);
    b.onclick = () => (location.hash = query(b.dataset.s, driver));
  });
  view.querySelectorAll('.periodo button').forEach((b) => (b.onclick = () => (location.hash = query(status, driver, b.dataset.p))));
  const select = view.querySelector('#driver');
  if (select) select.onchange = () => (location.hash = query(status, select.value, periodo));
  let list;
  try {
    list = await api(`/services?status=${status}${driver ? `&driver=${encodeURIComponent(driver)}` : ''}${periodo ? `&periodo=${periodo}` : ''}`);
  } catch (err) {
    // Lista suspensa por falta da milhagem da semana: mostra o que fazer.
    if (!/suspensa/.test(err.message)) throw err;
    view.innerHTML = `<div class="card"><h2>🚫 Lista suspensa</h2><p>${esc(err.message)}</p><a class="btn block" href="#/caminhoes">📏 Mandar a milhagem</a></div>`;
    return;
  }
  // Motorista: os dele em ordem do número do dia (dia mais recente primeiro, depois 1, 2, 3...).
  if (state.me.role !== 'dono') {
    const day = (s) => (s.driver_seq ? s.driver_ref_day : '') || '';
    list.sort((a, b) => day(b).localeCompare(day(a)) || (a.driver_seq || 1e9) - (b.driver_seq || 1e9) || b.id - a.id);
  }
  const empty = status === 'pendente' ? 'Nenhum serviço na fila. 👍' : (status === 'concluido'
        ? { dia: 'Nenhum serviço entregue hoje.', semana: 'Nenhum serviço entregue nesta semana.', mes: 'Nenhum serviço entregue neste mês.' }
        : { dia: 'Nenhum serviço hoje.', semana: 'Nenhum serviço nesta semana.', mes: 'Nenhum serviço neste mês.' })[periodo] || 'Nenhum serviço aqui.';
  if (status === 'aberto' && fila.length) {
    view.querySelector('.segmented').insertAdjacentHTML('afterend', `<a class="card linkcard" href="${query('pendente', driver)}"><span>⏳ <strong>${fila.length}</strong> serviço(s) na fila, sem motorista</span><span>›</span></a>`);
  }
  if (isDesk()) {
    // Computador: tabela com tudo numa linha só, e busca rápida na lista.
    const owner = state.me.role === 'dono';
    const short = (t) => esc((t || '').replace(/https?:\/\/\S+/g, 'local no mapa'));
    const tools = document.createElement('div');
    tools.className = 'toolbar';
    tools.innerHTML = '<input type="search" id="filtro" placeholder="Filtrar por cliente, veículo, endereço…" aria-label="Filtrar">';
    const segmented = view.querySelector('.segmented');
    tools.prepend(segmented);
    const per = view.querySelector('.periodo');
    if (per) segmented.after(per);
    if (select) tools.append(select);
    view.prepend(tools);
    const filaCard = tools.querySelector('.linkcard');
    if (filaCard) tools.after(filaCard);
    view.querySelector('.card:last-child').outerHTML = list.length
      ? `<div class="card table-card"><table class="table">
          <thead><tr><th>#</th><th>Cliente</th><th>Veículo</th><th>Retirada → Destino</th>${owner ? '<th>Motorista</th>' : ''}<th>Data</th><th class="num">Valor</th><th>Status</th></tr></thead>
          <tbody>${list
            .map(
              (s) => `<tr data-href="#/servico/${s.id}" data-cents="${s.price_cents || 0}" tabindex="0"${payClass(s)}>
                <td class="sub">${s.id}</td>
                <td><strong>${esc(s.contact_name || 'Sem cliente')}</strong>${s.contact_phone ? `<div class="sub">${phoneFmt(s.contact_phone)}</div>` : ''}</td>
                <td>${esc([s.vehicle, s.plate].filter(Boolean).join(' · ')) || '<span class="sub">—</span>'}</td>
                <td class="route"><div>${short(s.pickup_name || s.pickup) || '<span class="sub">—</span>'}</div>${s.dropoff || s.dropoff_name ? `<div class="sub">→ ${short(s.dropoff_name || s.dropoff)}</div>` : ''}</td>
                ${owner ? `<td>${esc(s.driver_name || '') || '<span class="sub">—</span>'}</td>` : ''}
                <td class="nowrap">${when(s.created_at)}</td>
                <td class="num">${s.price_cents != null ? priceText(s.price_cents) : '<span class="sub">—</span>'}</td>
                <td>${badge(s)}</td>
              </tr>`
            )
            .join('')}</tbody>
          <tfoot><tr><td colspan="${owner ? 6 : 5}" class="sub" id="conta">${list.length} serviço(s)</td><td class="num"><strong id="soma">${money(list.reduce((t, s) => t + (s.price_cents || 0), 0))}</strong></td><td></td></tr></tfoot>
        </table></div>`
      : `<div class="card"><p class="empty">${empty}</p></div>`;
    linkRows(view);
    const filtro = view.querySelector('#filtro');
    filtro.oninput = () => {
      const q = filtro.value.trim().toLowerCase();
      let n = 0;
      let cents = 0;
      view.querySelectorAll('tbody tr').forEach((tr) => {
        const show = !q || tr.textContent.toLowerCase().includes(q);
        tr.classList.toggle('hidden', !show);
        if (show) {
          n += 1;
          cents += Number(tr.dataset.cents);
        }
      });
      if (!list.length) return;
      view.querySelector('#conta').textContent = `${n} serviço(s)`;
      view.querySelector('#soma').textContent = money(cents);
    };
    return;
  }
  view.querySelector('#list').innerHTML = list.length
    ? list
        .map(
          (s) => `<li${payClass(s)}><a href="#/servico/${s.id}">
            <div><strong>${numTag(s)}${esc(s.contact_name || 'Sem cliente')}</strong>
              <div class="sub">${esc([s.vehicle, s.plate].filter(Boolean).join(' · ') || (s.pickup || '').replace(/https?:\/\/\S+/g, 'local no mapa'))}</div>
              <div class="sub">${when(s.created_at)}${state.me.role === 'dono' && s.driver_name ? ' · ' + esc(s.driver_name) : ''}</div></div>
            <div class="right">${s.price_cents != null ? priceText(s.price_cents) : ''}<br>${badge(s)}</div>
          </a></li>`
        )
        .join('')
    : `<li class="empty">${empty}</li>`;
  if (periodo && list.length) {
    view.querySelector('#list').insertAdjacentHTML('beforeend', `<li class="total"><span>${list.length} serviço(s)</span><strong>${money(list.reduce((t, s) => t + (s.price_cents || 0), 0))}</strong></li>`);
  }
};

screens.novo = async () => {
  setScreen('Novo serviço', { tab: 'novo' });
  const drivers = state.me.role === 'dono' ? await api('/users') : [];
  const { pricing } = state;
  const priced = pricing && (pricing.baseCents || pricing.perMileCents);
  view.innerHTML = `
    ${has('voz') && (await voiceEnabled()) ? '<p class="sub voice-hint">🎤 Dica: segure o microfone e fale o serviço. Eu pergunto o que faltar.</p>' : ''}
    <form class="card" id="f">
      <input type="hidden" name="contact_id">
      <input type="hidden" name="company_id">
      <label>Celular do cliente</label>
      <div class="copyrow"><div class="suggest-wrap"><input name="contact_phone" type="tel" inputmode="numeric" autocomplete="off" placeholder="4 últimos números ou o celular todo"><ul class="suggest" id="phone-suggest" hidden></ul></div>${canPickContacts ? '<button type="button" class="secondary" id="agenda">📇 Agenda</button>' : ''}</div>
      <label>Nome do cliente</label>
      <div class="suggest-wrap"><input name="contact_name" autocomplete="off" placeholder="Digite o nome para buscar na agenda"><ul class="suggest" hidden></ul></div>
      <p class="sub picked" hidden></p>
      <label>Retirada (onde pegar)</label><input name="pickup" required placeholder="Endereço ou link do mapa">
      <label>Destino (para onde levar)</label><input name="dropoff" placeholder="Endereço ou link do mapa">
      ${has('fotos') ? `<label>Gate pass (leilão)</label>
      <div class="docs-zone" id="docs-zone"><button type="button" class="secondary" id="docs-add">📎 Anexar PDF ou foto</button><span class="sub">${isDesk() ? 'ou cole (Ctrl+V) ou arraste o arquivo aqui' : ''}</span></div>
      <ul class="docs-list" id="docs-list"></ul>` : ''}
      ${has('vin') ? `<label>VIN (chassi) — opcional</label>
      <div class="copyrow"><input name="vin" maxlength="17" autocapitalize="characters" autocomplete="off" placeholder="17 caracteres"><button type="button" class="secondary" id="novo-scan">📷 Escanear</button></div>
      <p class="sub" id="vin-info" hidden></p>` : ''}
      <div class="row2">
        <div><label>Veículo</label><input name="vehicle" placeholder="Honda Civic"></div>
        <div><label>Placa</label><input name="plate" autocapitalize="characters"></div>
      </div>
      <div class="row2">
        <div><label>Milhas</label><input name="miles" type="number" step="0.1" inputmode="decimal"></div>
        <div><label>Valor (US$)</label><input name="price" inputmode="decimal" placeholder="0 = free"></div>
      </div>
      ${priced ? `<p class="sub">Tabela: ${money(pricing.baseCents)} + ${money(pricing.perMileCents)} por milha.</p>` : ''}
      ${drivers.length ? `<label>Motorista</label><select name="driver_id"><option value="fila" selected>⏳ Ninguém ainda (Pendente)</option>${drivers.filter((d) => d.active && drives(d)).map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}</select><p class="sub">O serviço entra como Pendente. Escolha o motorista agora ou depois, na tela do serviço.</p>` : ''}
      <label>Observações</label><textarea name="notes" rows="2"></textarea>
      <button class="block">Criar serviço</button>
    </form>`;
  const form = view.querySelector('#f');
  placeSuggestions(form.pickup);
  placeSuggestions(form.dropoff);
  // Veio do microfone (de outra tela): preenche e continua a conversa.
  const spoken = takePrefill('novo');
  if (spoken) setTimeout(() => talkNewService(form, spoken), 50);
  // Escolher o cliente direto da agenda do celular.
  const agenda = view.querySelector('#agenda');
  if (agenda) {
    agenda.onclick = async () => {
      try {
        const [contact] = await pickPhoneContacts();
        if (!contact) return;
        let phone = contact.phones[0] || '';
        if (contact.phones.length > 1) {
          const choice = await dialog({ title: `Qual número de ${contact.name}?`, choices: contact.phones });
          if (choice == null) return;
          phone = contact.phones[choice] || phone;
        }
        // Já é cliente no app: preenche tudo (nome, veículo e placa do último serviço).
        const digits = phone.replace(/\D/g, '').slice(-10);
        const known = digits.length >= 7 ? (await api(`/contacts/suggest?q=${digits}`).catch(() => [])).find((c) => c.id && (c.phone || '').endsWith(digits)) : null;
        if (known) {
          choose({ ...known, name: known.name || contact.name });
          if (contact.address && !form.pickup.value) form.pickup.value = contact.address;
          return;
        }
        form.contact_id.value = '';
        form.company_id.value = '';
        const d = phone.replace(/\D/g, '');
        form.contact_phone.value = /^1?\d{10}$/.test(d) ? phoneFmt(d.length === 10 ? '1' + d : d) : phone;
        form.contact_name.value = contact.name;
        if (contact.address && !form.pickup.value) form.pickup.value = contact.address;
        view.querySelector('#phone-suggest').hidden = true;
        picked.hidden = false;
        picked.innerHTML = contact.name ? `📇 ${esc(contact.name)} <em>(cliente novo, da agenda do celular)</em>` : '📇 Contato sem nome na agenda: digite o nome.';
        if (!contact.name) form.contact_name.focus();
      } catch (err) {
        toast('Não consegui abrir a agenda do celular.');
      }
    };
  }
  // Busca na agenda enquanto digita o nome (ou o telefone) e preenche o resto.
  const box = view.querySelector('.suggest');
  const phoneBox = view.querySelector('#phone-suggest');
  const picked = view.querySelector('.picked');
  let found = [];
  let timer;
  const choose = (c) => {
    form.contact_id.value = c.id || '';
    form.company_id.value = c.company_id || '';
    form.contact_name.value = c.name;
    if (c.phone) form.contact_phone.value = phoneFmt(c.phone);
    const filled = [];
    if (c.last) {
      if (!form.vehicle.value && c.last.vehicle) (form.vehicle.value = c.last.vehicle), filled.push('veículo');
      if (!form.plate.value && c.last.plate) (form.plate.value = c.last.plate), filled.push('placa');
    }
    picked.hidden = false;
    picked.innerHTML = `✅ ${esc(c.name)}${c.company_name ? ` · 🏢 ${esc(c.company_name)}` : ''}${
      c.last ? `<br>Último serviço (${numTag(c.last.id)}${when(c.last.created_at).split(',')[0]}): ${esc([c.last.vehicle, c.last.plate].filter(Boolean).join(' · ') || 'sem veículo')}${filled.length ? ` <em>(${filled.join(' e ')} preenchido${filled.length > 1 ? 's' : ''})</em>` : ''}` : ''
    }`;
    box.hidden = true;
    phoneBox.hidden = true;
  };
  // Toque/clique na sugestão sem tirar o foco do campo: assim a lista não fecha
  // antes de escolher (clique demorado no computador fazia a escolha se perder).
  const keepFocus = (b, pick) => {
    b.onmousedown = (e) => e.preventDefault();
    b.onclick = pick;
  };
  const search = (q) => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      found = q.trim().length >= 2 ? await api(`/contacts/suggest?q=${encodeURIComponent(q.trim())}`).catch(() => []) : [];
      box.innerHTML = found
        .map((c, i) => `<li><button type="button" data-i="${i}"><strong>${c.id ? '' : '🏢 '}${esc(c.name)}</strong><span class="sub">${!c.id ? 'empresa (ninguém cadastrado ainda)' : c.phone ? phoneFmt(c.phone) : 'sem telefone'}${c.company_name ? ' · ' + esc(c.company_name) : ''}${c.last?.vehicle ? ' · ' + esc(c.last.vehicle) : ''}</span></button></li>`)
        .join('');
      box.hidden = !found.length;
      box.querySelectorAll('button').forEach((b) => keepFocus(b, () => choose(found[Number(b.dataset.i)])));
    }, 250);
  };
  form.contact_name.oninput = () => {
    // Mudou o nome à mão: deixa de ser o contato escolhido.
    form.contact_id.value = '';
    form.company_id.value = '';
    picked.hidden = true;
    search(form.contact_name.value);
  };
  form.contact_name.onblur = () => setTimeout(() => (box.hidden = true), 200);
  // Digitou os 4 últimos números (ou mais) do celular: procura na agenda e preenche o cliente.
  form.contact_phone.oninput = () => {
    if (form.contact_id.value) return;
    const digits = form.contact_phone.value.replace(/\D/g, '');
    clearTimeout(timer);
    if (digits.length < 4) return (phoneBox.hidden = true);
    timer = setTimeout(async () => {
      const list = (await api(`/contacts/suggest?q=${digits}`).catch(() => [])).filter((c) => c.id && (c.phone || '').endsWith(digits));
      if (list.length === 1 && digits.length < 10) return choose(list[0]);
      phoneBox.innerHTML = list
        .map((c, i) => `<li><button type="button" data-i="${i}"><strong>${esc(c.name)}</strong><span class="sub">${phoneFmt(c.phone)}${c.company_name ? ' · ' + esc(c.company_name) : ''}${c.last?.vehicle ? ' · ' + esc(c.last.vehicle) : ''}</span></button></li>`)
        .join('');
      if (!list.length) {
        // Ninguém com esse final: avisa e oferece abrir a agenda do celular.
        phoneBox.innerHTML = `<li class="none">Não achei ninguém com celular terminando em ${esc(digits.slice(-4))}.${canPickContacts ? ' <button type="button" class="secondary" id="agenda2">📇 Procurar na agenda do celular</button>' : ''}</li>`;
        phoneBox.hidden = false;
        const ag = view.querySelector('#agenda2');
        if (ag) ag.onclick = () => view.querySelector('#agenda').click();
        return;
      }
      phoneBox.hidden = false;
      phoneBox.querySelectorAll('button').forEach((b) => keepFocus(b, () => choose(list[Number(b.dataset.i)])));
    }, 300);
  };
  form.contact_phone.onblur = () => setTimeout(() => (phoneBox.hidden = true), 200);
  form.miles.oninput = () => {
    if (!priced || form.price.dataset.touched) return;
    const miles = Number(form.miles.value) || 0;
    form.price.value = ((pricing.baseCents + miles * pricing.perMileCents) / 100).toFixed(2);
  };
  form.price.oninput = () => (form.price.dataset.touched = '1');
  // Trava o botão enquanto salva: dois toques (internet lenta) não criam dois serviços.
  const novoScan = form.querySelector('#novo-scan');
  if (novoScan) {
    // VIN completo: busca ano/marca/modelo e preenche o Veículo (sem apagar o que a pessoa digitou).
    const vinInfo = form.querySelector('#vin-info');
    let asked = '';
    const lookupVin = async () => {
      const vin = form.vin.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (vin.length !== 17) {
        asked = '';
        vinInfo.hidden = true;
        return;
      }
      if (vin === asked) return;
      asked = vin;
      vinInfo.hidden = false;
      vinInfo.textContent = 'Buscando o carro pelo VIN…';
      let r;
      try {
        r = await api(`/vin/decode/${vin}`);
      } catch {
        r = null;
      }
      if (asked !== vin) return;
      if (!r?.valid) {
        vinInfo.textContent = `⚠️ ${r?.reason || 'Não consegui conferir o VIN.'}`;
        return;
      }
      if (!r.vehicle) {
        vinInfo.textContent = 'VIN certo, mas não achei as informações do carro. Digite o veículo.';
        return;
      }
      const extra = [r.info.trim, r.info.body].filter(Boolean).join(' · ');
      vinInfo.textContent = `🚗 ${r.vehicle}${extra ? ` · ${extra}` : ''}`;
      const veh = form.vehicle;
      if (!veh.value.trim() || veh.value === veh.dataset.auto) {
        veh.value = r.vehicle.slice(0, 60);
        veh.dataset.auto = veh.value;
      }
    };
    form.vin.addEventListener('input', lookupVin);
    novoScan.onclick = async () => {
      const vin = await scanBarcode();
      if (vin) {
        form.vin.value = vin;
        lookupVin();
      }
    };
  }
  // Gate pass escolhido antes de criar o serviço: sobe logo depois que o serviço existe.
  const pendingDocs = [];
  const docsZone = form.querySelector('#docs-zone');
  if (docsZone) {
    const drawDocs = () => {
      form.querySelector('#docs-list').innerHTML = pendingDocs
        .map((f, i) => `<li>${f.type === 'application/pdf' ? '📄' : '🖼️'} ${esc(docName(f, i))} <button type="button" class="danger" data-rm="${i}" aria-label="Tirar">✕</button></li>`)
        .join('');
      form.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = () => (pendingDocs.splice(Number(b.dataset.rm), 1), drawDocs())));
    };
    docPicker(docsZone, form.querySelector('#docs-add'), (files) => {
      pendingDocs.push(...files);
      drawDocs();
    });
  }
  let saving = false;
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (saving) return;
    saving = true;
    const btn = form.querySelector('button[type=submit], button:not([type])');
    const label = btn?.textContent;
    if (btn) (btn.disabled = true), (btn.textContent = 'Salvando…');
    try {
      const { vin, ...body } = formData(form);
      if (body.driver_id && body.driver_id !== 'fila') body.driver_id = Number(body.driver_id);
      const service = await sendCheckingAddress((b) => api('/services', { method: 'POST', body: b }), body);
      novo.mine.add(service.id);
      // VIN digitado ou escaneado já entra no serviço; se o dígito verificador não bater, pergunta.
      if (vin?.trim()) {
        await api(`/services/${service.id}/vin`, { method: 'POST', body: { vin } }).catch(async (err) => {
          if (await ask(`${err.message}\n\nSalvar o VIN assim mesmo?`)) await api(`/services/${service.id}/vin`, { method: 'POST', body: { vin, force: true } }).catch(() => {});
        });
      }
      if (pendingDocs.length && btn) btn.textContent = 'Enviando o gate pass…';
      const failed = [];
      for (const [i, file] of pendingDocs.entries()) await uploadDoc(service.id, file, i).catch(() => failed.push(file));
      if (failed.length) {
        toast(`Serviço ${numTag(service)}criado, mas ${failed.length} arquivo(s) não foram. Anexe de novo na tela do serviço.`);
        location.hash = `#/servico/${service.id}`;
        return;
      }
      toast(queued(service) ? (service.driver_id === state.me.id ? `Serviço ${numTag(service)}na sua fila. Toque em Começar quando for fazer.` : `Serviço ${numTag(service)}na fila de ${service.driver_name || 'motorista'}`) : service.status === 'pendente' ? `Serviço #${num(service)} na fila` : `Serviço #${num(service)} criado`);
      location.hash = `#/servico/${service.id}`;
    } catch (err) {
      toast(err.message);
    } finally {
      saving = false;
      if (btn) (btn.disabled = false), (btn.textContent = label);
    }
  };
};

screens.servico = async (params, id) => {
  setScreen('Serviço', { tab: 'servicos', back: '#/servicos' });
  const s = await api(`/services/${id}`);
  setScreen(`Serviço ${numTag(s)}`.trim(), { tab: 'servicos', back: '#/servicos' });
  const owner = state.me.role === 'dono';
  const drivers = owner && s.status === 'pendente' ? await api('/users') : [];
  const voice = has('voz') && ['pendente', 'aberto'].includes(s.status) && (s.driver_id === state.me.id || (owner && s.driver_id)) && (await voiceEnabled());
  const vehicleInfo = s.vin_info ? [s.vin_info.year, s.vin_info.make, s.vin_info.model, s.vin_info.body].filter(Boolean).join(' · ') : '';
  const b = s.balance;

  view.innerHTML = `
    <div class="card">
      <div class="row" style="display:flex;justify-content:space-between;align-items:center">
        <h2 style="margin:0">${esc(s.contact_name || 'Sem cliente')}${s.company_name ? ` <span class="sub">· ${esc(s.company_name)}</span>` : ''}</h2>
        ${badge(s)}
      </div>
      ${s.contact_phone ? `<p><a href="tel:+${s.contact_phone}">📞 ${phoneFmt(s.contact_phone)}</a> · <a href="https://wa.me/${s.contact_phone}" target="_blank" rel="noopener">WhatsApp</a></p>` : ''}
      ${placeHtml('📍', s.pickup, s.pickup_name)}${placeHtml('🏁', s.dropoff, s.dropoff_name)}
      <p>🚗 ${esc([s.vehicle, s.plate].filter(Boolean).join(' · ') || 'Veículo não informado')}</p>
      ${s.miles != null ? `<p class="sub">${s.miles} milhas</p>` : ''}
      <p class="big">${s.price_cents != null ? priceText(s.price_cents) : 'Sem valor'}</p>
      <p class="sub">${when(s.created_at)}${s.driver_name ? ' · ' + esc(s.driver_name) + (owner && s.driver_seq ? ` (nº ${s.driver_seq} do dia ${s.driver_ref_day.slice(8)}/${s.driver_ref_day.slice(5, 7)})` : '') : ''}</p>
      ${s.notes ? `<p>${esc(s.notes)}</p>` : ''}
      ${s.status === 'aberto' && STAGES[s.stage] ? `<p class="stage">${STAGES[s.stage]}</p>` : ''}
      <div class="actions">
        ${s.status === 'pendente' ? (queued(s) && (owner || s.driver_id === state.me.id) ? '<button id="start">▶ Começar</button>' : '') : s.status === 'aberto' ? '<button id="done">✅ Entregue</button>' : '<button class="secondary" id="reopen">Reabrir</button>'}
        ${s.status !== 'pendente' || owner || s.driver_id === state.me.id ? '<button class="secondary" id="edit">Editar</button>' : ''}
      </div>
      ${s.status === 'pendente' ? `<p class="sub">${queued(s) ? `⏳ Aguardando: na fila de ${esc(s.driver_name || 'motorista')}. Toque em Começar quando for fazer este.` : '⏳ Na fila: ainda sem motorista.'}</p>${owner ? `<label>Escolher o motorista</label><div class="actions"><select id="assign" aria-label="Escolher o motorista"><option value="">${queued(s) ? 'Passar para outro motorista?' : 'Quem vai fazer?'}</option>${drivers.filter((d) => d.active && drives(d)).map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}</select></div>` : ''}` : ''}
      ${s.status === 'aberto' && owner ? '<div class="actions"><button class="secondary" id="queue">⏳ Voltar para a fila</button></div>' : ''}
      ${(['aberto', 'pendente'].includes(s.status) && (owner || s.driver_id === state.me.id)) ? '<div class="actions"><button class="danger" id="cancel">✖ Cancelar serviço</button></div>' : ''}
    </div>

    ${voice ? `
    <div class="card voice-card">
      <button type="button" class="mic" id="mic" aria-label="Comando de voz"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg></button>
      <p class="voice-status" id="voiceStatus">Segure e fale: "peguei o carro", "indo entregar", "finalizar", "recebi 150 no Zelle"…</p>
    </div>` : ''}
    ${s.events?.length ? `<div class="card"><h2>Histórico</h2><ul class="list">${s.events.map((e) => `<li><div class="row"><span>${esc(VOICE_LABELS[e.action] || e.action)}</span><span class="sub">${when(e.created_at)} · ${esc(e.user_name || '')}${e.source === 'voz' ? ' 🎤' : ''}</span></div></li>`).join('')}</ul></div>` : ''}

    ${has('fotos') ? `
    <div class="card docs-card" id="docs-zone">
      <h2>📄 Gate pass</h2>
      ${s.docs?.length ? `<ul class="list">${s.docs.map((d) => `<li><div class="row"><a href="${d.mime === 'application/pdf' && d.open_url ? d.open_url : d.url}" target="_blank" rel="noopener" data-opendoc="${d.id}">${d.mime === 'application/pdf' ? '📄' : '🖼️'} ${esc(d.name || 'gate pass')}</a>${owner || d.uploaded_by === state.me.id ? `<button class="danger" data-deldoc="${d.id}" aria-label="Apagar">✕</button>` : ''}</div></li>`).join('')}</ul>` : '<p class="sub">Nenhum gate pass anexado.</p>'}
      <div class="actions"><button class="secondary" id="docs-add">📎 Anexar PDF ou foto</button></div>
      ${isDesk() ? '<p class="sub">Também dá para colar (Ctrl+V) ou arrastar o arquivo aqui.</p>' : ''}
    </div>` : ''}

    ${has('vin') ? `
    <div class="card">
      <h2>VIN (chassi)</h2>
      ${!s.vin && s.company_requires_vin ? `<p class="warn">⚠️ A ${esc(s.company_name)} exige o VIN para fechar o serviço.</p>` : ''}
      ${s.vin ? `<p><strong>${esc(s.vin)}</strong>${vehicleInfo ? `<br><span class="sub">${esc(vehicleInfo)}</span>` : ''}</p>` : '<p class="sub">Ainda sem VIN.</p>'}
      <form id="vinForm" class="actions">
        <input name="vin" maxlength="17" autocapitalize="characters" placeholder="17 caracteres" value="${esc(s.vin || '')}">
        <button>Salvar</button>
      </form>
      <div class="actions">
        <button class="secondary" id="scanVin">📷 Escanear VIN</button>
        <button class="secondary" id="photoVin">🖼️ Ler da foto</button>
      </div>
    </div>` : ''}

    ${has('fotos') ? `
    <div class="card">
      <h2>Fotos</h2>
      ${photoGroups(s.photos || [])}
      <div class="actions">
        <button class="secondary" data-photo="antes">📷 Fotos de antes</button>
        <button class="secondary" data-photo="depois">📷 Fotos de depois</button>
      </div>
    </div>` : ''}

    ${has('pagamentos') ? `
    <div class="card">
      <h2>Pagamento</h2>
      ${s.payments?.length ? `<ul class="list">${s.payments.map((p) => `<li><div class="row">
          <div>${METHODS[p.method]}${p.payer ? ' · ' + esc(p.payer) : ''}<div class="sub">${p.status === 'recebido' ? 'Recebido ' + when(p.received_at) + (p.received_by_name ? ' por ' + esc(p.received_by_name) : '') : 'A receber'}</div></div>
          <div class="right">${money(p.amount_cents)}${p.status === 'a_receber' ? `<br><button class="secondary" data-received="${p.id}">Recebi</button>` : ''}</div>
        </div></li>`).join('')}</ul>` : ''}
      ${b ? `<p>${b.open_cents ? `Falta receber: <strong>${money(b.open_cents)}</strong>` : s.price_cents ? '<strong>Quitado ✅</strong>' : ''}${b.to_receive_cents ? `<br>A receber de seguradora: ${money(b.to_receive_cents)}` : ''}</p>` : ''}
      <form id="payForm">
        <div class="row2">
          <div><label>Valor</label><input name="amount" inputmode="decimal" value="${b?.open_cents ? (b.open_cents / 100).toFixed(2) : ''}" required></div>
          <div><label>Forma</label><select name="method">${Object.entries(METHODS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
        </div>
        <label class="payer hidden">Seguradora / motor club</label><input class="payer hidden" name="payer" placeholder="AAA, Agero, Honk…">
        <div class="actions"><button>Registrar pagamento</button>${b?.open_cents ? '<button type="button" class="secondary" id="charge">Cobrar cliente</button>' : ''}${b?.open_cents && s.square ? '<button type="button" class="secondary" id="cardlink">💳 Link do cartão (+ taxa)</button>' : ''}</div>
        <div id="cardlinkOut"></div>
      </form>
    </div>` : ''}
    ${has('invoice') ? `<a class="card linkcard" href="#/invoice/${s.id}"><span>🧾 Invoice para o cliente${s.invoice_number ? ` <span class="sub">nº ${s.invoice_number}</span>` : ''}</span><span>›</span></a>` : ''}`;

  const reload = () => screens.servico(params, id);
  const on = (sel, fn) => view.querySelector(sel) && (view.querySelector(sel).onclick = fn);

  const docsZone = view.querySelector('#docs-zone');
  if (docsZone) {
    docPicker(docsZone, view.querySelector('#docs-add'), async (files) => {
      try {
        toast('Enviando…');
        for (const [i, file] of files.entries()) await uploadDoc(id, file, (s.docs?.length || 0) + i);
        toast('Gate pass anexado');
        reload();
      } catch (err) {
        toast(err.message);
      }
    });
    view.querySelectorAll('[data-opendoc]').forEach((a) => {
      a.onclick = (e) => {
        if (e.ctrlKey || e.metaKey || e.shiftKey) return;
        const doc = s.docs.find((d) => String(d.id) === a.dataset.opendoc);
        // PDF abre o arquivo original no leitor de PDF do celular; foto abre aqui no app.
        if (doc?.mime === 'application/pdf' && doc.open_url) return;
        e.preventDefault();
        openDoc(doc);
      };
    });
    view.querySelectorAll('[data-deldoc]').forEach((b) => {
      b.onclick = async () => {
        if (!(await ask('Apagar este arquivo?', { danger: true }))) return;
        try {
          await api(`/docs/${b.dataset.deldoc}`, { method: 'DELETE' });
          reload();
        } catch (err) {
          toast(err.message);
        }
      };
    });
  }

  on('#done', async () => {
    try {
      const done = await api(`/services/${id}`, { method: 'PATCH', body: { status: 'concluido' } });
      toast(['Serviço entregue', ...(done.notices || [])].join(' · '));
      reload();
    } catch (err) {
      toast(err.message);
    }
  });
  const assign = view.querySelector('#assign');
  if (assign) {
    assign.onchange = async () => {
      if (!assign.value) return;
      try {
        const done = await api(`/services/${id}/passar`, { method: 'POST', body: { driver_id: Number(assign.value) } });
        toast(`Passado para ${done.driver_name}`);
        reload();
      } catch (err) {
        toast(err.message);
      }
    };
  }
  on('#start', async () => {
    try {
      await api(`/services/${id}`, { method: 'PATCH', body: { status: 'aberto' } });
      toast('Serviço em andamento');
      reload();
    } catch (err) {
      toast(err.message);
    }
  });
  on('#queue', async () => {
    if (!(await ask('Voltar este serviço para a fila, sem motorista?', { ok: 'Voltar para a fila', cancel: 'Não' }))) return;
    await api(`/services/${id}`, { method: 'PATCH', body: { status: 'pendente' } });
    toast('Serviço voltou para a fila');
    reload();
  });
  on('#cancel', async () => {
    const motivo = await dialog({
      title: `Cancelar o serviço ${numTag(s)}`.trim() + '?',
      text: 'Escreva o motivo, se quiser (ex.: cliente desistiu).',
      input: { multiline: true, placeholder: 'Motivo (opcional)' },
      ok: 'Cancelar serviço',
      cancel: 'Não, voltar',
      danger: true,
    });
    if (motivo === null) return;
    try {
      await api(`/services/${id}`, { method: 'PATCH', body: { status: 'cancelado', motivo } });
      toast('Serviço cancelado');
      reload();
    } catch (err) {
      toast(err.message);
    }
  });
  on('#reopen', async () => {
    // Cancelado que não tinha motorista volta para a fila.
    await api(`/services/${id}`, { method: 'PATCH', body: { status: s.driver_id ? 'aberto' : 'pendente' } });
    reload();
  });
  on('#edit', () => (location.hash = `#/editar/${id}`));
  state.voiceService = s.id;
  if (voice) wireMic(view.querySelector('#mic'), view.querySelector('#voiceStatus'), assistantVoice);

  const vinForm = view.querySelector('#vinForm');
  if (vinForm) {
    const saveVin = async (vin, force = false) => {
      try {
        await api(`/services/${id}/vin`, { method: 'POST', body: { vin, force } });
        toast('VIN salvo');
        reload();
      } catch (err) {
        if (await ask(`${err.message}\n\nSalvar assim mesmo?`)) saveVin(vin, true);
      }
    };
    vinForm.onsubmit = (e) => {
      e.preventDefault();
      saveVin(vinForm.vin.value);
    };
    on('#scanVin', async () => {
      const vin = await scanBarcode();
      if (vin) {
        vinForm.vin.value = vin;
        if (await ask(`VIN lido: ${vin}\nSalvar?`)) saveVin(vin);
      }
    });
    on('#photoVin', async () => {
      const file = await pickPhoto();
      if (!file) return;
      toast('Lendo o VIN…');
      const image = await shrinkImage(file, 2000);
      if (has('fotos')) api(`/services/${id}/photos?kind=vin`, { method: 'POST', raw: image, type: 'image/jpeg' }).catch(() => {});
      try {
        const result = await api('/vin/read', { method: 'POST', raw: image, type: 'image/jpeg' });
        vinForm.vin.value = result.vin;
        if (await ask(`VIN lido: ${result.vin}${result.valid ? '' : '\n(o dígito verificador não bateu, confira)'}\nSalvar?`)) saveVin(result.vin, !result.valid);
      } catch (err) {
        toast(err.message);
      }
    });
  }

  view.querySelectorAll('[data-photo]').forEach((btn) => {
    btn.onclick = async () => {
      const kind = btn.dataset.photo;
      const done = (s.photos || []).filter((p) => p.kind === kind).map((p) => p.angle);
      const saved = await guidedPhotos(id, kind, done);
      if (saved) reload();
    };
  });
  view.querySelectorAll('[data-view]').forEach((btn) => {
    btn.onclick = async () => {
      const photo = (s.photos || []).find((p) => String(p.id) === btn.dataset.view);
      const canDelete = owner || (s.status !== 'concluido' && s.status !== 'cancelado');
      if (photo && (await viewPhoto(photo, btn.dataset.label, canDelete))) reload();
    };
  });
  view.querySelectorAll('[data-retake]').forEach((btn) => {
    btn.onclick = async () => {
      const [kind, angle] = btn.dataset.retake.split(':');
      const saved = await guidedPhotos(id, kind, [], angle);
      if (saved) reload();
    };
  });

  const payForm = view.querySelector('#payForm');
  if (payForm) {
    payForm.method.onchange = () => payForm.querySelectorAll('.payer').forEach((el) => el.classList.toggle('hidden', payForm.method.value !== 'seguradora'));
    payForm.onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api(`/services/${id}/payments`, { method: 'POST', body: formData(payForm) });
        toast('Pagamento registrado');
        reload();
      } catch (err) {
        toast(err.message);
      }
    };
    // Link do Square com o valor que falta + taxa do cartão.
    on('#cardlink', async () => {
      const out = view.querySelector('#cardlinkOut');
      out.innerHTML = '<p class="sub">Criando o link no Square…</p>';
      try {
        const card = await api(`/services/${id}/square-link`, { method: 'POST' });
        out.innerHTML = `<p>Serviço ${money(card.base_cents)} + taxa ${money(card.fee_cents)} = <strong>${money(card.total_cents)}</strong>
          <span class="sub">(taxa ${card.fee.pct}% + ${money(card.fee.fixed_cents)}${card.fee.updated_at ? ', atualizada ' + when(card.fee.updated_at) : ''})</span></p>
          ${card.qr_svg ? `<div class="qr-pagar"><div class="qr-box">${card.qr_svg}</div><p class="sub">Cliente do lado? Ele aponta a câmera do celular para o QR e paga com o cartão.</p><p class="sub" id="cardlinkStatus">Esperando o pagamento…</p></div>` : ''}
          <p><a href="${esc(card.url)}" target="_blank" rel="noopener">${esc(card.url)}</a></p>
          <div class="actions"><button type="button" class="secondary" id="cardlinkSend">Mandar para o cliente</button></div>`;
        out.querySelector('#cardlinkSend').onclick = () => shareText(card.message, s.contact_phone);
        // Enquanto o QR está na tela, confere se o Square já avisou o pagamento (até 15 min).
        const status = out.querySelector('#cardlinkStatus');
        const until = Date.now() + 15 * 60000;
        const check = async () => {
          if (!status.isConnected || Date.now() > until) return;
          try {
            const now = await api(`/services/${id}`);
            if (!now.balance?.open_cents) {
              status.innerHTML = '<strong>✅ Pago! Pode liberar o cliente.</strong>';
              toast('Pagamento recebido no cartão');
              return setTimeout(reload, 2500);
            }
          } catch {}
          setTimeout(check, 4000);
        };
        if (status) setTimeout(check, 4000);
      } catch (err) {
        out.innerHTML = '';
        toast(err.message);
      }
    });
    on('#charge', async () => {
      const { message } = await api(`/services/${id}/charge`);
      if (message) shareText(message, s.contact_phone);
    });
  }
  view.querySelectorAll('[data-received]').forEach((btn) => {
    btn.onclick = async () => {
      await api(`/payments/${btn.dataset.received}`, { method: 'PATCH', body: { status: 'recebido' } });
      reload();
    };
  });
  // "Recebi 150 no Zelle" falado: preenche o pagamento para conferir.
  const pay = takePrefill('pagamento');
  if (pay) {
    if (payForm) {
      fillForm(payForm, pay.campos);
      payForm.method.onchange();
      payForm.scrollIntoView({ block: 'center' });
      voiceSay('Confira o pagamento e toque em registrar.', '✅ Preenchi o pagamento. Confira e toque em Registrar pagamento.');
    } else voiceSay('Não dá para registrar pagamento neste serviço.', 'Não dá para registrar pagamento neste serviço.', false);
  }
};

screens.editar = async (params, id) => {
  setScreen('Editar', { tab: 'servicos', back: `#/servico/${id}` });
  const s = await api(`/services/${id}`);
  setScreen(state.me.role === 'dono' ? `Editar #${num(s)}` : 'Editar serviço', { tab: 'servicos', back: `#/servico/${id}` });
  const drivers = state.me.role === 'dono' ? await api('/users') : [];
  view.innerHTML = `
    <form class="card" id="f">
      <label>Cliente</label>
      <div class="select-tap"><select name="contact_id" tabindex="-1"><option value="${s.contact_id || ''}">${esc(s.contact_name || 'Nenhum')}</option></select><button type="button" id="contactPick" aria-label="Trocar cliente"></button></div>
      <label>Retirada</label><input name="pickup" value="${esc(s.pickup)}">
      <label>Destino</label><input name="dropoff" value="${esc(s.dropoff)}">
      <div class="row2">
        <div><label>Veículo</label><input name="vehicle" value="${esc(s.vehicle)}"></div>
        <div><label>Placa</label><input name="plate" value="${esc(s.plate)}"></div>
      </div>
      <div class="row2">
        <div><label>Milhas</label><input name="miles" type="number" step="0.1" value="${s.miles ?? ''}"></div>
        <div><label>Valor (US$)</label><input name="price" inputmode="decimal" placeholder="0 = free" value="${s.price_cents != null ? (s.price_cents / 100).toFixed(2) : ''}"></div>
      </div>
      ${drivers.length ? `<label>Motorista</label><select name="driver_id">${s.driver_id ? '' : '<option value="" selected>Ninguém ainda (fila)</option>'}${drivers.filter((d) => d.id === s.driver_id || (d.active && drives(d))).map((d) => `<option value="${d.id}" ${d.id === s.driver_id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select>` : ''}
      <label>Situação</label><select name="status">${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${k === s.status ? 'selected' : ''}>${v}</option>`).join('')}</select>
      <label>Observações</label><textarea name="notes" rows="3">${esc(s.notes)}</textarea>
      <button class="block">Salvar</button>
    </form>`;
  placeSuggestions(view.querySelector('#f').pickup);
  placeSuggestions(view.querySelector('#f').dropoff);
  // Trocar o cliente: janela com os 5 mais novos e busca; dá para cadastrar um novo ali mesmo.
  const contactSel = view.querySelector('#f').contact_id;
  const setContact = (c) => (contactSel.innerHTML = `<option value="${c.id}">${esc(c.name)}</option>`);
  view.querySelector('#contactPick').onclick = async () => {
    const c = await pickDialog({
      title: 'Cliente',
      placeholder: 'Buscar nome ou telefone',
      none: '➕ Cadastrar cliente novo',
      items: async (q) =>
        (await api(q ? `/contacts?q=${encodeURIComponent(q)}&limit=20` : '/contacts?recent=1&limit=5')).map((x) => ({ id: x.id, name: x.name, sub: x.phone ? phoneFmt(x.phone) : '' })),
    });
    if (c) return setContact(c);
    if (c !== null) return;
    const name = await dialog({ title: 'Cliente novo', text: 'Nome do cliente', input: { placeholder: 'Nome' }, ok: 'Continuar' });
    if (!name?.trim()) return;
    const phone = await dialog({ title: 'Cliente novo', text: 'Telefone (pode deixar em branco)', input: { placeholder: '(407) 555-0123', numeric: true }, ok: 'Salvar' });
    if (phone === null) return;
    try {
      setContact(await api('/contacts', { method: 'POST', body: { name: name.trim(), phone: phone.trim() } }));
    } catch (err) {
      toast(err.message);
    }
  };
  view.querySelector('#f').onsubmit = async (e) => {
    e.preventDefault();
    const body = formData(e.target);
    if (String(body.contact_id || '') === String(s.contact_id || '')) delete body.contact_id;
    body.miles = body.miles === '' ? null : Number(body.miles);
    if (body.driver_id) body.driver_id = Number(body.driver_id);
    try {
      await sendCheckingAddress((b) => api(`/services/${id}`, { method: 'PATCH', body: b }), body);
      toast('Salvo');
      location.hash = `#/servico/${id}`;
    } catch (err) {
      toast(err.message);
    }
  };
};

screens.contatos = async (params) => {
  setScreen('Clientes', { tab: 'contatos' });
  const q = params.get('q') || '';
  view.innerHTML = `
    <form id="search" class="actions" style="margin-top:0;margin-bottom:12px"><input name="q" type="search" placeholder="Buscar nome ou telefone" value="${esc(q)}"></form>
    <div class="actions" style="margin-bottom:12px">
      ${state.me.role === 'dono' && canPickContacts ? '<button class="secondary" id="pick">📇 Da Agenda do Celular</button>' : ''}
      ${has('empresas') && state.me.role === 'dono' ? '<button class="secondary" id="nova-empresa">➕ Nova Empresa</button>' : ''}
      <button class="secondary" id="add">➕ Novo Cliente</button>
    </div>
    <div class="card"><ul class="list" id="list"><li class="empty">Carregando…</li></ul></div>`;
  view.querySelector('#search').onsubmit = (e) => {
    e.preventDefault();
    location.hash = `#/contatos?q=${encodeURIComponent(e.target.q.value)}`;
  };
  view.querySelector('#add').onclick = () => (location.hash = '#/contato/novo');
  const novaEmpresa = view.querySelector('#nova-empresa');
  if (novaEmpresa) novaEmpresa.onclick = () => (location.hash = '#/empresas/nova');
  // Escolhe vários contatos da agenda do celular e manda como um .vcf.
  const pickBtn = view.querySelector('#pick');
  if (pickBtn) {
    pickBtn.onclick = async () => {
      try {
        const picked = await pickPhoneContacts(true);
        if (!picked.length) return;
        const vcf = picked
          .map((c) => ['BEGIN:VCARD', 'VERSION:3.0', `FN:${vcfEscape(c.name || c.phones[0])}`, ...c.phones.slice(0, 1).map((p) => `TEL:${p}`), 'END:VCARD'].join('\n'))
          .join('\n');
        const r = await api('/contacts/import', { method: 'POST', raw: vcf, type: 'text/vcard' });
        toast(`${r.created} novos, ${r.updated} atualizados${r.skipped ? `, ${r.skipped} sem telefone` : ''}`);
        screens.contatos(params);
      } catch (err) {
        toast(err.message || 'Não consegui abrir a agenda do celular.');
      }
    };
  }
  // Celular, sem busca: só os 5 clientes mais novos. Com busca, ou o ADM no computador: todos
  // (em ordem de nome), aos poucos.
  const PAGE = 300;
  const all = Boolean(q) || (isDesk() && state.me.role === 'dono');
  const [first, companies] = await Promise.all([
    api(all ? `/contacts?q=${encodeURIComponent(q)}&limit=${PAGE}` : '/contacts?recent=1&limit=5', { withTotal: true }),
    has('empresas') ? api('/companies').catch(() => []) : [],
  ]);
  const list = first.data;
  const total = first.total;
  // Nome da empresa (oficina, dealer) de cada cliente, quando ele pede serviço por uma.
  const companyOf = Object.fromEntries(companies.map((co) => [co.id, co.name]));
  const company = (c) => (c.company_id && companyOf[c.company_id]) || '';
  // Números de serviços e valores: só o dono recebe do servidor.
  const owner = state.me.role === 'dono';
  const empty = 'Nenhum cliente. Traga a agenda do celular ou adicione um.';
  const deskRow = (c) =>
    `<tr data-href="#/contato/${c.id}" tabindex="0"><td><strong>${esc(c.name)}</strong></td><td class="nowrap">${phoneFmt(c.phone)}</td>${has('empresas') ? `<td>${esc(company(c)) || '<span class="sub">Particular</span>'}</td>` : ''}<td>${esc(c.email || '')}</td>${owner ? `<td class="num">${c.month_count || ''}</td><td class="num">${c.year_count || ''}</td><td class="num">${c.month_cents ? money(c.month_cents) : ''}</td><td class="num">${c.year_cents ? money(c.year_cents) : ''}</td>` : ''}</tr>`;
  const phoneRow = (c) => `<li><a href="#/contato/${c.id}"><div><strong>${esc(c.name)}</strong><div class="sub">${[phoneFmt(c.phone), esc(company(c))].filter(Boolean).join(' · ')}</div></div>
          <div class="right sub">${owner && c.year_count ? `${c.year_count} no ano<br>${money(c.year_cents)}` : ''}</div></a></li>`;
  const card = view.querySelector('#list').closest('.card');
  if (isDesk()) {
    card.outerHTML = list.length
      ? `<div class="card table-card"><table class="table">
          <thead><tr><th>Nome</th><th>Telefone</th>${has('empresas') ? '<th>Empresa</th>' : ''}<th>E-mail</th>${owner ? '<th class="num">Serviços mês</th><th class="num">Serviços ano</th><th class="num">Valor mês</th><th class="num">Valor ano</th>' : ''}</tr></thead>
          <tbody id="list">${list.map(deskRow).join('')}</tbody></table></div>`
      : `<div class="card"><p class="empty">${empty}</p></div>`;
  } else {
    view.querySelector('#list').innerHTML = list.length ? list.map(phoneRow).join('') : `<li class="empty">${empty}</li>`;
  }
  // Agenda grande: mostra aos poucos, com o total e o botão "Mostrar mais".
  if (all && total > list.length) {
    view.insertAdjacentHTML('beforeend', '<div class="more"><p class="sub" id="shown"></p><button class="secondary" id="more">Mostrar mais</button></div>');
    const shown = view.querySelector('#shown');
    const more = view.querySelector('#more');
    const count = () => (shown.textContent = `Mostrando ${list.length.toLocaleString('pt-BR')} de ${total.toLocaleString('pt-BR')} clientes${q ? '' : '. Para achar alguém rápido, use a busca acima.'}`);
    count();
    more.onclick = async () => {
      more.disabled = true;
      try {
        const next = await api(`/contacts?q=${encodeURIComponent(q)}&limit=${PAGE}&offset=${list.length}`);
        list.push(...next);
        view.querySelector('#list').insertAdjacentHTML('beforeend', next.map(isDesk() ? deskRow : phoneRow).join(''));
        if (isDesk()) linkRows(view);
        count();
        if (!next.length || list.length >= total) more.closest('.more').remove();
      } catch (err) {
        toast(err.message);
      } finally {
        more.disabled = false;
      }
    };
  }
  if (isDesk()) linkRows(view);
};

// Escolha com busca (ligar cliente e empresa): sem digitar, mostra os 5 mais novos; digitando, os que batem.
// items(q) devolve [{ id, name, sub }]; onPick recebe o escolhido.
function searchPicker(box, { placeholder, items, onPick }) {
  box.innerHTML = `<input type="search" placeholder="${esc(placeholder)}"><ul class="list picker"><li class="empty">Carregando…</li></ul>`;
  const input = box.querySelector('input');
  const ul = box.querySelector('ul');
  let seq = 0;
  const show = async () => {
    const mine = ++seq;
    const q = input.value.trim();
    let list;
    try {
      list = (await items(q)).slice(0, 5);
    } catch (err) {
      list = [];
    }
    if (mine !== seq) return;
    ul.innerHTML = list.length
      ? list.map((it, i) => `<li><button type="button" class="pickrow" data-i="${i}"><strong>${esc(it.name)}</strong>${it.sub ? `<span class="sub">${esc(it.sub)}</span>` : ''}</button></li>`).join('')
      : `<li class="empty">${q ? 'Nada encontrado.' : 'Nenhum ainda.'}</li>`;
    ul.querySelectorAll('button').forEach((b) => (b.onclick = () => onPick(list[Number(b.dataset.i)])));
  };
  let t;
  input.oninput = () => {
    clearTimeout(t);
    t = setTimeout(show, 250);
  };
  input.onkeydown = (e) => e.key === 'Enter' && e.preventDefault();
  show();
}
// Janela com busca (searchPicker). Devolve o item escolhido, null para "nenhum" ou undefined se voltou.
function pickDialog({ title, placeholder, none, items }) {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'dialog-back';
    back.innerHTML = `<div class="dialog" role="dialog" aria-modal="true"><h2>${esc(title)}</h2>
      ${none ? `<button type="button" class="secondary block" data-none>${esc(none)}</button>` : ''}<div class="pick-box"></div>
      <div class="dialog-actions"><button type="button" class="secondary" data-act="no">Voltar</button></div></div>`;
    const done = (v) => {
      back.remove();
      document.removeEventListener('keydown', onKey);
      resolve(v);
    };
    const onKey = (e) => e.key === 'Escape' && done(undefined);
    back.querySelector('[data-act="no"]').onclick = () => done(undefined);
    back.querySelector('[data-none]')?.addEventListener('click', () => done(null));
    back.onclick = (e) => e.target === back && done(undefined);
    document.addEventListener('keydown', onKey);
    document.body.append(back);
    searchPicker(back.querySelector('.pick-box'), { placeholder, items, onPick: done });
  });
}
const plain = (v) => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

screens.contato = async (params, id) => {
  const isNew = id === 'novo';
  setScreen(isNew ? 'Novo cliente' : 'Cliente', { tab: 'contatos', back: '#/contatos' });
  const c = isNew ? { services: [] } : await api(`/contacts/${id}`);
  const companies = has('empresas') ? await api('/companies') : [];
  view.innerHTML = `
    <form class="card" id="f">
      <label>Nome</label><input name="name" value="${esc(c.name)}" required>
      ${has('empresas') ? `<label>Empresa (se pede serviço por uma oficina ou dealer)</label>
        <div class="select-tap"><select name="company_id" tabindex="-1"><option value="${c.company_id || ''}">${esc(companies.find((co) => co.id === c.company_id)?.name || 'Nenhuma (cliente particular)')}</option></select><button type="button" id="companyPick" aria-label="Escolher empresa"></button></div>` : ''}
      <label>Telefone</label><input name="phone" type="tel" value="${esc(c.phone ? phoneFmt(c.phone) : '')}">
      <label>E-mail</label><input name="email" type="email" value="${esc(c.email)}">
      <label>Observações</label><textarea name="notes" rows="2">${esc(c.notes)}</textarea>
      ${!isNew && state.me.role === 'dono' && !c.services.length ? '<div class="actions save-del"><button>Salvar</button><button type="button" class="del-solid" id="delContact">Excluir</button></div>' : '<button class="block">Salvar</button>'}
    </form>
    ${!isNew ? `<div class="card"><h2>Histórico</h2><ul class="list">${
      c.services.length
        ? c.services.map((s) => `<li><a href="#/servico/${s.id}"><div>${esc(s.vehicle || s.pickup || 'Serviço')}<div class="sub">${when(s.created_at)}</div></div><div class="right">${s.price_cents != null ? money(s.price_cents) : ''}</div></a></li>`).join('')
        : '<li class="empty">Nenhum serviço ainda.</li>'
    }</ul></div>` : ''}
`;
  // Tocar em Empresa abre uma janela com busca e as 5 empresas mais novas (no lugar da lista com todas).
  const companyPick = view.querySelector('#companyPick');
  if (companyPick) {
    const sel = view.querySelector('#f').company_id;
    const newest = [...companies].sort((a, b) => b.id - a.id);
    companyPick.onclick = async () => {
      const co = await pickDialog({
        title: 'Empresa',
        placeholder: 'Buscar empresa',
        none: 'Nenhuma (cliente particular)',
        items: async (q) => newest.filter((x) => !q || plain(x.name).includes(plain(q)) || plain(x.nickname).includes(plain(q))).map((x) => ({ id: x.id, name: x.name, sub: x.nickname || '' })),
      });
      if (co === undefined) return;
      sel.innerHTML = `<option value="${co ? co.id : ''}">${esc(co ? co.name : 'Nenhuma (cliente particular)')}</option>`;
    };
  }
  // Excluir só aparece para cliente sem serviço (quem tem histórico não pode ser apagado).
  const del = view.querySelector('#delContact');
  if (del)
    del.onclick = async () => {
      if (!(await ask(`Apagar ${c.name} da lista de clientes? Não dá para desfazer.`, { danger: true }))) return;
      try {
        await api(`/contacts/${id}`, { method: 'DELETE' });
        toast('Cliente apagado');
        location.hash = '#/contatos';
      } catch (err) {
        toast(err.message);
      }
    };
  view.querySelector('#f').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const { company_id, ...body } = formData(e.target);
      const saved = isNew ? await api('/contacts', { method: 'POST', body }) : await api(`/contacts/${id}`, { method: 'PATCH', body });
      if (company_id !== undefined && String(company_id || '') !== String(c.company_id || '')) {
        await api(`/contacts/${saved.id}/company`, { method: 'PUT', body: { company_id: company_id || null } });
      }
      toast('Cliente salvo');
      location.hash = `#/contato/${saved.id}`;
    } catch (err) {
      toast(err.message);
    }
  };
};

screens.resumo = async (params) => {
  setScreen('Resumo', { tab: 'resumo' });
  const period = params.get('p') === 'mes' ? 'mes' : 'dia';
  const s = await api(`/summary?period=${period}`);
  const stat = (label, value) => `<div class="card"><div class="sub">${label}</div><div class="big">${value}</div></div>`;
  view.innerHTML = `
    <div id="alertas"></div>
    <div class="segmented"><button data-p="dia">Hoje</button><button data-p="mes">Este mês</button></div>
    <div class="stats">
      ${stat('Serviços', `${s.services}`)}
      ${stat('Faturado', money(s.billed_cents))}
      ${s.received_cents != null ? stat('Recebido', money(s.received_cents)) : ''}
      ${s.expenses_cents != null ? stat('Despesas', money(s.expenses_cents)) : ''}
    </div>
    ${s.received_cents != null && s.expenses_cents != null ? `<div class="card"><div class="sub">Saldo (recebido − despesas)</div><div class="big">${money(s.received_cents - s.expenses_cents)}</div></div>` : ''}
    ${s.received_by_method ? `<div class="card"><h2>Recebido por forma</h2><ul class="list">${Object.entries(s.received_by_method).map(([k, v]) => `<li><div class="row"><span>${METHODS[k]}</span><span>${money(v)}</span></div></li>`).join('') || '<li class="empty">Nada recebido.</li>'}</ul></div>` : ''}
    <div id="caixa"></div>
    ${state.me.role !== 'dono' && s.open_cents != null ? `<div class="card"><h2>Minhas pendências</h2><p>${s.open_cents || s.to_receive_cents ? `Clientes: ${money(s.open_cents)}<br>Seguradoras: ${money(s.to_receive_cents)}` : 'Nada pendente 👍'}</p><a class="btn secondary" href="#/pendentes">Ver lista</a></div>` : ''}
    ${state.me.role === 'dono' && (s.open_cents || s.to_receive_cents) ? `<div class="card"><h2>Pendências (todas)</h2><p>Clientes: ${money(s.open_cents)}<br>Seguradoras: ${money(s.to_receive_cents)}</p><a class="btn secondary" href="#/pendentes">Ver lista</a></div>` : ''}
    ${s.expenses_by_category && Object.keys(s.expenses_by_category).length ? `<div class="card"><h2>Despesas</h2><ul class="list">${Object.entries(s.expenses_by_category).map(([k, v]) => `<li><div class="row"><span>${CATEGORIES[k] || k}</span><span>${money(v)}</span></div></li>`).join('')}</ul></div>` : ''}
    ${has('pagamentos') && state.me.role === 'dono' ? '<a class="card linkcard" href="#/recebidos"><span>✅ Conferir caixa e banco (recebidos de serviços anteriores)</span><span>›</span></a>' : ''}
    ${state.me.role === 'dono' ? '<a class="card linkcard" href="#/relatorio"><span>🖨 Relatório do dia para imprimir</span><span>›</span></a>' : ''}
    ${has('planilha') && state.me.role === 'dono' ? '<a class="card linkcard" href="#/planilha"><span>📊 Planilha do Excel</span><span>›</span></a>' : ''}`;
  view.querySelectorAll('.segmented button').forEach((b) => {
    b.classList.toggle('active', b.dataset.p === period);
    b.onclick = () => (location.hash = `#/resumo?p=${b.dataset.p}`);
  });
  if (has('pagamentos')) cashCard(view.querySelector('#caixa'));
  alertsCard(view.querySelector('#alertas'));
};

// Avisos (cobrança atrasada, manutenção do caminhão): os mesmos do WhatsApp da manhã.
async function alertsCard(box) {
  const list = await api('/alerts').catch(() => []);
  box.innerHTML = list.length
    ? `<div class="card alerts"><h2>⚠️ Atenção</h2><ul class="list">${list
        .map((a) => `<li>${a.href ? `<a href="${esc(a.href)}"><span>${esc(a.text.replace(/\*/g, ''))}</span><span>›</span></a>` : esc(a.text)}</li>`)
        .join('')}</ul></div>`
    : '';
}

// Planilha: baixar o Excel do mês e (dono) o link que mantém uma planilha sempre atualizada.
screens.planilha = async () => {
  setScreen('Planilha', { tab: 'resumo', back: '#/resumo' });
  const now = new Date();
  const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const owner = state.me.role === 'dono';
  const link = owner ? await api('/planilha/link') : null;
  const formula = (url) => `=IMPORTDATA("${url}")`;
  const MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
  const verRelatorio = (mes) =>
    openDoc({ url: `/api/planilha.pdf?mes=${mes}`, name: `Relatório ${MESES[Number(mes.slice(5, 7)) - 1]} ${mes.slice(0, 4)}.pdf`, mime: 'application/pdf' });
  // Motorista não tem relatório do mês (pedido do Caningado em 19/10).
  if (!owner) {
    location.hash = '#/resumo';
    return;
  }
  view.innerHTML = `
    <div class="card">
      <h2>📄 Relatório do mês (PDF)</h2>
      <p class="sub">O mesmo conteúdo da planilha, fácil de ler no celular.</p>
      <button class="block secondary" id="ver">Ver relatório do mês</button>
    </div>
    <div class="card">
      <h2>📥 Baixar planilha</h2>
      <p class="sub">Serviços${has('pagamentos') ? ', pagamentos' : ''}${has('despesas') ? ' e despesas' : ''}, cada um numa aba. Abre no Excel, no Google Planilhas e no Numbers.</p>
      <label>Mês</label><input type="month" id="mes" value="${thisMonth}">
      <div class="actions">
        <a class="btn" id="baixarMes" href="/api/planilha.xlsx?mes=${thisMonth}">Baixar o mês</a>
        <a class="btn secondary" href="/api/planilha.xlsx">Baixar tudo</a>
      </div>
    </div>
    ${has('fotos') ? `
    <div class="card">
      <h2>📷 Planilha com as fotos</h2>
      <p class="sub">Um arquivo .zip com a planilha do mês e as fotos de cada serviço, cada serviço numa pasta (ex.: "Serviço 12 - Maria Souza / antes - frente.jpg"). Bom para guardar uma cópia de tudo.</p>
      <div class="actions">
        <a class="btn" id="fotosMes" href="/api/planilha.zip?mes=${thisMonth}">Baixar o mês com fotos</a>
      </div>
    </div>` : ''}
    ${owner ? `
    <div class="card">
      <h2>🔄 Planilha que se atualiza sozinha</h2>
      ${link.active ? `
        <p class="sub">No <strong>Google Planilhas</strong> (grátis, funciona no celular): crie uma planilha, e em cada aba cole a fórmula abaixo na célula A1. Ela atualiza sozinha mais ou menos a cada hora.</p>
        ${link.sheets.map((sh) => `
          <label>${esc(sh.name)}</label>
          <div class="copyrow"><input readonly value="${esc(formula(sh.url))}"><button class="secondary" data-copy="${esc(formula(sh.url))}">Copiar</button></div>`).join('')}
        <details><summary>Usar no Excel do computador</summary>
          <p class="sub">No Excel: <strong>Dados › Obter Dados › Da Web</strong>, cole o link de uma aba e clique em Carregar. Para atualizar, use <strong>Dados › Atualizar Tudo</strong> (ou programe para atualizar ao abrir).</p>
          ${link.sheets.map((sh) => `<div class="copyrow"><input readonly value="${esc(sh.url)}"><button class="secondary" data-copy="${esc(sh.url)}">Copiar</button></div>`).join('')}
        </details>
        <p class="sub">⚠️ Quem tiver esses links vê os dados. Não compartilhe. Se vazar, troque o link.</p>
        <div class="actions"><button class="secondary" id="trocar">Trocar link</button><button class="danger" id="desligar">Desligar</button></div>`
      : `<p class="sub">Crie um link privado. O Google Planilhas ou o Excel leem esse link e a planilha fica sempre atualizada, sem precisar baixar de novo.</p>
        <button class="block" id="criar">Criar link</button>`}
    </div>` : ''}`;
  const mes = view.querySelector('#mes');
  view.querySelector('#ver').onclick = () => verRelatorio(mes.value || thisMonth);
  mes.onchange = () => {
    view.querySelector('#baixarMes').href = `/api/planilha.xlsx?mes=${mes.value}`;
    const fotos = view.querySelector('#fotosMes');
    if (fotos) fotos.href = `/api/planilha.zip?mes=${mes.value}`;
  };
  view.querySelectorAll('[data-copy]').forEach((b) => {
    b.onclick = async () => {
      try {
        await navigator.clipboard.writeText(b.dataset.copy);
      } catch {
        b.previousElementSibling.select();
        document.execCommand('copy');
      }
      toast('Copiado');
    };
  });
  const make = async () => {
    await api('/planilha/link', { method: 'POST' });
    screens.planilha();
  };
  view.querySelector('#criar')?.addEventListener('click', make);
  view.querySelector('#trocar')?.addEventListener('click', async () => (await ask('O link atual vai parar de funcionar. Trocar?')) && make());
  view.querySelector('#desligar')?.addEventListener('click', async () => {
    if (!(await ask('Desligar o link? As planilhas ligadas a ele param de atualizar.'))) return;
    await api('/planilha/link', { method: 'DELETE' });
    screens.planilha();
  });
};

// Dinheiro e cheques que estão com cada motorista, acumulando até o dono recolher.
async function cashCard(box) {
  const list = await api('/caixa');
  const owner = state.me.role === 'dono';
  if (!list.length) {
    box.innerHTML = owner ? '<div class="card"><h2>💵 Dinheiro em mãos</h2><p class="sub">Nenhum motorista com dinheiro ou cheque em mãos.</p></div>' : '';
    return;
  }
  const lastText = (d) => (d.last_collection ? `Último recolhimento: ${when(d.last_collection.created_at)} (${money(d.last_collection.amount_cents)})` : 'Ainda não recolhido');
  box.innerHTML = `<div class="card cash"><h2>💵 Dinheiro em mãos</h2><ul class="list">${list
    .map(
      (d) => `<li><div class="row"><div><strong>${owner ? esc(d.name) : 'Com você'}</strong><div class="sub">${lastText(d)}</div>
          ${d.payments.length ? `<details><summary class="sub">Ver ${d.payments.length === 1 ? "o pagamento" : `os ${d.payments.length} pagamentos`}</summary><ul class="sub">${d.payments.map((p) => `<li>${numTag(p.service_id)}${esc(p.contact_name || '')} · ${METHODS[p.method]} ${money(p.amount_cents)} · ${when(p.received_at)}</li>`).join('')}</ul></details>` : ''}</div>
        <div class="right"><div class="big">${money(d.in_hand_cents)}</div>
          ${owner && d.in_hand_cents > 0 ? `<button class="secondary small" data-collect="${d.driver_id}">Recolhi</button>` : ''}</div></div></li>`
    )
    .join('')}</ul>${owner ? '<p class="sub">Toque em <strong>Recolhi</strong> quando pegar o dinheiro: o valor do motorista volta para zero.</p>' : ''}</div>`;
  box.querySelectorAll('[data-collect]').forEach((b) => {
    b.onclick = async () => {
      const d = list.find((x) => String(x.driver_id) === b.dataset.collect);
      const value = await askText(`Quanto você pegou de ${d.name}?\n(Deixe o valor todo para zerar)`, (d.in_hand_cents / 100).toFixed(2), { input: { numeric: true } });
      if (value == null) return;
      try {
        const after = await api(`/caixa/${d.driver_id}/recolher`, { method: 'POST', body: { amount: value } });
        toast(after.in_hand_cents ? `Ainda fica com ${d.name}: ${money(after.in_hand_cents)}` : `${d.name} zerado ✅`);
        cashCard(box);
      } catch (err) {
        toast(err.message);
      }
    };
  });
}

// Pagamentos recebidos no dia de serviços de dias anteriores: o ADM confere com o caixa e o banco.
screens.recebidos = async (params) => {
  setScreen('Conferir caixa e banco', { tab: 'resumo', back: '#/resumo' });
  const r = await api(`/payments/recebidos${params.get('dia') ? `?dia=${encodeURIComponent(params.get('dia'))}` : ''}`);
  const day = (iso) => new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  view.innerHTML = `
    <div class="card"><div class="sub">Pagamentos recebidos neste dia de serviços abertos em dias anteriores.</div>
      <div class="copyrow"><input type="date" id="dia" value="${r.day}" max="${r.today}"></div></div>
    <div class="card"><h2>Total por forma</h2><ul class="list">${
      Object.entries(r.by_method).map(([k, v]) => `<li><div class="row"><span>${METHODS[k]}</span><span>${money(v)}</span></div></li>`).join('') || '<li class="empty">Nada recebido de serviços anteriores.</li>'
    }${r.list.length ? `<li><div class="row"><strong>Total</strong><strong>${money(r.total_cents)}</strong></div></li>` : ''}</ul></div>
    ${r.list.length ? `<div class="card"><h2>Pagamentos</h2><ul class="list">${r.list
      .map((p) => `<li><a href="#/servico/${p.service_id}"><div><strong>#${p.service_id} ${esc(p.contact_name || p.vehicle || 'Serviço')}</strong>
        <div class="sub">Serviço de ${day(p.service_created_at)} · recebido ${when(p.received_at)}${p.received_by_name ? ` por ${esc(p.received_by_name)}` : ''}${p.payer ? ` · ${esc(p.payer)}` : ''}</div></div>
        <div class="right">${money(p.amount_cents)}<br><span class="sub">${METHODS[p.method] || esc(p.method)}</span></div></a></li>`)
      .join('')}</ul></div>` : ''}`;
  view.querySelector('#dia').onchange = (e) => e.target.value && (location.hash = `#/recebidos?dia=${e.target.value}`);
};

screens.pendentes = async () => {
  setScreen(state.me.role === 'dono' ? 'Pendências' : 'Minhas pendências', { tab: 'resumo', back: '#/resumo' });
  const list = await api('/payments/pending');
  const late = list.filter((s) => s.overdue).length;
  const age = (d) => (d === 0 ? 'hoje' : d === 1 ? 'há 1 dia' : `há ${d} dias`);
  const words = (s) => plain([state.me.role === 'dono' ? s.id : '', s.contact_name, s.contact_phone, s.vehicle, s.plate, s.vin, s.payer, s.driver_name].filter(Boolean).join(' '));
  view.innerHTML = `${late ? `<div class="card alerts"><strong>⚠️ ${late === 1 ? '1 atrasado' : `${late} atrasados`}</strong><div class="sub">Abra o serviço e toque em <strong>Cobrar cliente</strong> para mandar a mensagem com o Zelle. Pagou só uma parte? Abra o serviço e mude o valor.</div></div>` : ''}
    ${list.length ? '<div class="card"><input type="search" id="busca" placeholder="🔎 Nome, celular, carro ou placa"><div class="sub" id="soma"></div><div class="actions"><button type="button" class="secondary" id="pdf">📄 PDF da lista</button></div></div>' : ''}
    <div class="card"><ul class="list">${
    list.length
      ? list.map((s) => `<li data-w="${esc(words(s))}" class="${s.overdue ? 'late' : ''}"><div class="row"><label class="pick">${s.open_cents ? `<input type="checkbox" value="${s.id}" data-open="${s.open_cents}">` : ''}</label><a href="#/servico/${s.id}" style="flex:1"><div><strong>${s.overdue ? '⚠️ ' : ''}${numTag(s)}${esc(s.contact_name || s.vehicle || 'Serviço')}</strong><div class="sub">${s.vehicle && s.contact_name ? `${esc(s.vehicle)} · ` : ''}${when(s.completed_at || s.created_at)} · ${age(s.days)}</div></div>
          <div class="right">${s.open_cents ? 'Cliente ' + money(s.open_cents) : ''}${s.to_receive_cents ? '<br>Seguradora ' + money(s.to_receive_cents) : ''}</div></a></div></li>`).join('')
      : '<li class="empty">Nada pendente 👍</li>'
  }</ul></div>
    ${list.some((s) => s.open_cents) ? `<form class="card" id="lote"><h2>Dar baixa nos marcados</h2><div class="sub" id="loteInfo"></div>
      <div class="row2"><div><label>Valor pago</label><input name="amount" inputmode="decimal" placeholder="tudo"></div>
      <div><label>Forma</label><select name="method">${Object.entries(METHODS).filter(([k]) => k !== 'seguradora').map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div></div>
      <div class="sub">Pagou só uma parte? Escreva quanto pagou: quita os serviços mais antigos primeiro e o que sobrar fica faltando no último.</div>
      <div class="actions"><button>✅ Marcar como pagos</button><button type="button" class="secondary" id="todos">Marcar todos da lista</button></div></form>` : ''}`;
  const items = [...view.querySelectorAll('li[data-w]')];
  const boxes = () => [...view.querySelectorAll('input[type=checkbox]')];
  // Só conta o que está aparecendo: o que a busca escondeu não é pago sem querer.
  const picked = () => boxes().filter((b) => b.checked && !b.closest('li').hidden);
  const form = view.querySelector('#lote');
  const refresh = () => {
    const shown = items.filter((li) => !li.hidden);
    const owed = shown.reduce((sum, li) => sum + Number(li.querySelector('input')?.dataset.open || 0), 0);
    const soma = view.querySelector('#soma');
    if (soma) soma.textContent = `${shown.length} serviço(s) · clientes devem ${money(owed)}`;
    if (!form) return;
    const marked = picked();
    form.querySelector('button:not([type])').disabled = !marked.length;
    form.querySelector('#loteInfo').textContent = marked.length
      ? `${marked.length} serviço(s) · ${money(marked.reduce((sum, b) => sum + Number(b.dataset.open), 0))} (o valor que falta em cada um)`
      : 'Marque os serviços na lista acima.';
  };
  const busca = view.querySelector('#busca');
  if (busca)
    busca.oninput = () => {
      const q = plain(busca.value).split(' ').filter(Boolean);
      for (const li of items) li.hidden = !q.every((w) => li.dataset.w.includes(w));
      refresh();
    };
  boxes().forEach((b) => (b.onchange = refresh));
  const pdf = view.querySelector('#pdf');
  if (pdf)
    pdf.onclick = () => {
      const q = (busca?.value || '').trim();
      openDoc({ url: `/api/payments/pending.pdf${q ? `?q=${encodeURIComponent(q)}` : ''}`, name: `Pendências${q ? ' ' + q : ''}.pdf`, mime: 'application/pdf' });
    };
  if (form) {
    form.querySelector('#todos').onclick = () => {
      items.forEach((li) => !li.hidden && li.querySelector('input') && (li.querySelector('input').checked = true));
      refresh();
    };
    form.onsubmit = async (e) => {
      e.preventDefault();
      const ids = picked().map((b) => Number(b.value));
      if (!ids.length) return;
      const { method, amount } = formData(form);
      const ask = amount ? `Registrar $${amount} por ${METHODS[method]} nesses ${ids.length} serviço(s)?` : `Marcar ${ids.length} serviço(s) como pagos por ${METHODS[method]}?`;
      if (!confirm(ask)) return;
      try {
        const r = await api('/payments/lote', { method: 'POST', body: { service_ids: ids, method, amount } });
        toast(`✅ ${money(r.total_cents)} registrado em ${r.count} serviço(s)${r.still_open_cents ? `. Ainda falta ${money(r.still_open_cents)}` : ''}`);
        screens.pendentes();
      } catch (err) {
        toast(err.message);
      }
    };
  }
  refresh();
};

const setTheme = (t) => {
  document.documentElement.dataset.theme = t;
  document.querySelector('meta[name="theme-color"]').content = t === 'dark' ? '#000000' : '#ffffff';
  try {
    localStorage.setItem('tema', t);
  } catch {}
};

// ---------- notificações no celular (app fechado) ----------
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const installed = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

async function pushStatus() {
  if (!pushSupported()) return isIOS && !installed() ? 'instalar' : 'sem-suporte';
  if (Notification.permission === 'denied') return 'bloqueado';
  const reg = await navigator.serviceWorker.ready;
  return (await reg.pushManager.getSubscription()) && Notification.permission === 'granted' ? 'ativo' : 'desligado';
}

function keyBytes(base64) {
  const raw = atob((base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function enablePush() {
  if ((await Notification.requestPermission()) !== 'granted') throw new Error('Notificações bloqueadas. Libere nos ajustes do celular para este app.');
  const reg = await navigator.serviceWorker.ready;
  const { key } = await api('/push/chave');
  const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) }));
  await api('/push/assinar', { method: 'POST', body: sub.toJSON() });
}

// Ao entrar: se este aparelho já ativou, confirma no servidor que ele é desta pessoa (troca de login no mesmo celular).
async function syncPush() {
  try {
    if (!pushSupported() || Notification.permission !== 'granted') return;
    const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
    if (sub) await api('/push/assinar', { method: 'POST', body: sub.toJSON() });
  } catch {}
}

async function pushCard() {
  const box = view.querySelector('#push');
  if (!box) return;
  const st = await pushStatus();
  const text = {
    ativo: '✅ Ativado neste aparelho. Chega notificação de serviço novo mesmo com o app fechado.',
    desligado: 'Receba notificação de serviço novo mesmo com o app fechado ou a tela bloqueada.',
    bloqueado: 'As notificações estão bloqueadas neste aparelho. Libere nos ajustes do celular (Notificações) para este app e volte aqui.',
    instalar: 'No iPhone, primeiro instale o app: toque em Compartilhar e depois em "Adicionar à Tela de Início". Abra pelo ícone e volte aqui.',
    'sem-suporte': 'Este navegador não recebe notificações. No Android, use o Chrome.',
  }[st];
  box.innerHTML = `<label>🔔 Aviso de serviço novo</label><p class="sub">${text}</p>${
    st === 'desligado' ? '<button class="block" id="pushOn">Ativar notificações</button>' : st === 'ativo' ? '<button class="secondary block" id="pushTest">Mandar um teste</button>' : ''
  }`;
  const on = box.querySelector('#pushOn');
  if (on)
    on.onclick = async () => {
      on.disabled = true;
      try {
        await enablePush();
        toast('Notificações ativadas');
      } catch (err) {
        toast(err.message);
      }
      pushCard();
    };
  const test = box.querySelector('#pushTest');
  if (test)
    test.onclick = async () => {
      try {
        await api('/push/teste', { method: 'POST' });
        toast('Teste enviado. A notificação chega em alguns segundos.');
      } catch (err) {
        toast(err.message);
      }
    };
}

screens.mais = async () => {
  setScreen('Menu', { tab: 'mais' });
  view.innerHTML = `
    <div class="card"><p><strong>${esc(state.me.name)}</strong><br><span class="sub">${phoneFmt(state.me.phone)} · ${state.me.role === 'dono' ? 'ADM' : 'Motorista'}</span></p></div>
    <div class="card"><ul class="list">
      ${has('pagamentos') && state.me.role !== 'dono' ? '<li><a href="#/pendentes"><span>⏳ Minhas pendências</span><span>›</span></a></li>' : ''}
      ${has('despesas') ? '<li><a href="#/despesas"><span>🧾 Despesas</span><span>›</span></a></li>' : ''}
      ${has('manutencao') ? '<li><a href="#/caminhoes"><span>🔧 Caminhões e manutenção</span><span>›</span></a></li>' : ''}
      ${has('comissao') ? `<li><a href="${state.me.role === 'dono' ? '#/comissao' : `#/motorista/${state.me.id}`}"><span>💰 ${state.me.role === 'dono' ? 'Pagamento dos motoristas' : 'Meus ganhos'}</span><span>›</span></a></li>` : ''}
      ${has('empresas') && state.me.role === 'dono' ? '<li><a href="#/empresas"><span>🏢 Empresas (oficinas, dealers) e extrato</span><span>›</span></a></li>' : ''}
      ${has('pagamentos') && state.me.role === 'dono' ? '<li><a href="#/recebidos"><span>✅ Conferir caixa e banco</span><span>›</span></a></li>' : ''}
      ${state.me.role === 'dono' ? '<li><a href="#/relatorio"><span>🖨 Relatório do dia (imprimir)</span><span>›</span></a></li>' : ''}
      ${state.me.role === 'dono' ? '<li><a href="#/equipe"><span>👥 Equipe</span><span>›</span></a></li>' : ''}
      ${has('invoice') && state.me.role === 'dono' ? '<li><a href="#/empresa"><span>🏢 Dados da empresa (invoice)</span><span>›</span></a></li>' : ''}
      <li><a href="#/enderecos"><span>📍 Endereços com apelido</span><span>›</span></a></li>
      ${has('backup') && state.me.role === 'dono' ? '<li><a href="#/backup"><span>💾 Backup</span><span>›</span></a></li>' : ''}
      ${state.me.role === 'dono' ? '<li><a href="#/robo"><span>💬 Testar o Jay (robô do WhatsApp)</span><span>›</span></a></li>' : ''}
      <li><a href="#/sair"><span>🚪 Sair</span><span>›</span></a></li>
    </ul></div>
    ${has('notificacoes') ? '<div class="card" id="push"></div>' : ''}
    <div class="card"><label>Aparência</label><div class="segmented" id="tema"><button data-t="light">☀️ Claro</button><button data-t="dark">🌙 Escuro</button></div></div>
    <p class="sub">Dica: no navegador do celular, use "Adicionar à tela inicial" para abrir como aplicativo.</p>`;
  view.querySelectorAll('#tema button').forEach((b) => {
    b.classList.toggle('active', b.dataset.t === (document.documentElement.dataset.theme || 'light'));
    b.onclick = () => {
      setTheme(b.dataset.t);
      screens.mais();
    };
  });
  pushCard();
};

// Relatório do dia (só dono): serviços abertos ou entregues no dia, pronto para imprimir.
screens.relatorio = async (params) => {
  setScreen('Relatório do dia', { tab: 'mais', back: '#/mais' });
  const r = await api(`/relatorio/dia${params.get('dia') ? `?dia=${encodeURIComponent(params.get('dia'))}` : ''}`);
  const [y, m, d] = r.day.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const weekday = date.toLocaleDateString('pt-BR', { weekday: 'long' });
  const short = (t) => esc((t || '').replace(/https?:\/\/\S+/g, 'local no mapa'));
  const pay = (s) => {
    if (!s.price_cents) return `<span class="sub">${s.price_cents === 0 ? 'free' : 'sem valor'}</span>`;
    const how = s.methods.length ? ` <span class="sub">${esc(s.methods.join(', '))}</span>` : '';
    if (s.received_cents >= s.price_cents) return `Pago${how}`;
    if (s.received_cents) return `Falta ${money(s.price_cents - s.received_cents)}${how}`;
    return `A receber${how}`;
  };
  // Uma folha por empresa (J&J e VIP): o serviço vai para a empresa do motorista.
  const sheet = (rep) => {
    const t = rep.totals;
    return `<div class="card relatorio firm-${rep.firm}">
      <div class="rel-head"><div><h2>${esc(rep.name)}</h2><div class="sub">Relatório de serviços do dia</div></div>
        <div class="right"><strong>${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}</strong><div class="sub">${weekday}</div></div></div>
      <div class="rel-stats">
        <div><span class="sub">Serviços</span><strong>${t.count}</strong><span class="sub">${t.delivered} entregue(s)</span></div>
        <div><span class="sub">Faturado</span><strong>${money(t.price_cents)}</strong></div>
        <div><span class="sub">Recebido</span><strong>${money(t.received_cents)}</strong></div>
        <div><span class="sub">A receber</span><strong>${money(t.open_cents)}</strong></div>
      </div>
      ${rep.services.length
        ? `<div class="rel-scroll"><table class="table rel-table rel-main"><thead><tr><th>Nº</th><th>Motorista</th><th>Cliente</th><th>Telefone</th><th>Veículo</th><th>Retirada → Entrega</th><th>Situação</th><th>Pagamento</th><th class="num">Valor</th></tr></thead>
          <tbody>${rep.services
            .map(
              (s) => `<tr class="${s.price_cents === 0 ? 'rel-pago' : !s.price_cents ? '' : s.received_cents >= s.price_cents ? 'rel-pago' : 'rel-nao-pago'}"><td class="nowrap">#${s.id}</td><td>${esc(s.driver_name || '–')}</td>
                <td>${esc(s.contact_name || '')}</td><td class="nowrap">${s.contact_phone ? phoneFmt(s.contact_phone) : '–'}</td>
                <td>${esc(s.vehicle || '')}${s.plate ? `<div class="sub">${esc(s.plate)}</div>` : ''}</td>
                <td>${short(s.pickup)}${s.dropoff ? `<div class="sub">→ ${short(s.dropoff)}</div>` : ''}</td>
                <td class="nowrap">${s.status === 'concluido' ? 'Entregue' : s.status === 'pendente' ? (s.driver_id ? 'Aguardando' : 'Pendente') : 'Em andamento'}</td>
                <td>${pay(s)}</td><td class="num">${s.price_cents ? money(s.price_cents) : '–'}</td></tr>`
            )
            .join('')}</tbody>
          <tfoot><tr><td colspan="8"><strong>Total</strong></td><td class="num"><strong>${money(t.price_cents)}</strong></td></tr></tfoot></table></div>
          <h3>Por motorista</h3>
          <div class="rel-scroll"><table class="table rel-table"><thead><tr><th>Motorista</th><th class="num">Serviços</th><th class="num">Faturado</th><th class="num">Recebido</th></tr></thead>
          <tbody>${rep.drivers.map((g) => `<tr><td>${esc(g.name)}</td><td class="num">${g.count}</td><td class="num">${money(g.price_cents)}</td><td class="num">${money(g.received_cents)}</td></tr>`).join('')}</tbody></table></div>`
        : '<p class="empty">Nenhum serviço neste dia.</p>'}
      <p class="sub rel-foot">Impresso em ${new Date().toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}. Cancelados não entram.${rep.firm === 'jj' ? ' Serviço sem motorista entra nesta folha.' : ''}</p>
    </div>`;
  };
  view.innerHTML = `
    <div class="card no-print"><label>Dia</label>
      <div class="copyrow"><input type="date" id="dia" value="${r.day}" max="${r.today}"><button id="imprimir">🖨 Imprimir</button></div>
      <p class="sub">Sai uma folha para cada empresa. A empresa de cada motorista fica em Menu › Equipe.</p>
    </div>
    ${r.reports.map(sheet).join('')}`;
  view.querySelector('#dia').onchange = (e) => e.target.value && (location.hash = `#/relatorio?dia=${e.target.value}`);
  view.querySelector('#imprimir').onclick = () => {
    fitOnePage();
    window.print();
  };
};

// Relatório do dia: cada folha diminui o tamanho para caber numa página só (Carta deitada).
function fitOnePage() {
  for (const report of view.querySelectorAll('.relatorio')) {
    const copy = report.cloneNode(true);
    copy.classList.add('rel-measure');
    document.body.appendChild(copy);
    const height = copy.scrollHeight;
    copy.remove();
    // Área útil da folha: 11 x 8,5 pol. menos as margens, com uma folga.
    report.style.setProperty('--fit', Math.min(1, 700 / height).toFixed(3));
  }
}
window.addEventListener('beforeprint', fitOnePage);

// Endereços com apelido: oficinas, lojas... Ao digitar o apelido na retirada ou no destino, vira o endereço.
screens.enderecos = async () => {
  setScreen('Endereços com apelido', { tab: 'mais', back: '#/mais' });
  const owner = state.me.role === 'dono';
  const list = await api('/saved-places');
  view.innerHTML = `
    ${owner ? `<div class="card">
      <h2>Novo endereço</h2>
      <form id="f">
        <label>Apelido</label><input name="nickname" placeholder="Ex.: Ribas" required maxlength="60">
        <label>Endereço</label><input name="address" placeholder="Ex.: 643 Barry St, Orlando FL" required>
        <button class="block">Salvar</button>
      </form>
    </div>` : ''}
    <div class="card">
      <p class="sub">Na retirada ou no destino de um serviço, digite só o apelido (ex.: <strong>${esc(list[0]?.nickname || 'ribas')}</strong>) que o sistema troca pelo endereço. Vale no painel e no WhatsApp.</p>
      <ul class="list">${
        list.length
          ? list.map((p) => `<li><div class="row"><div><strong>⭐ ${esc(p.nickname)}</strong><div class="sub">${esc(p.address)}</div></div>${owner ? `<button class="danger" data-del="${p.id}" aria-label="Apagar">✕</button>` : ''}</div></li>`).join('')
          : '<li class="empty">Nenhum endereço ainda.</li>'
      }</ul>
    </div>`;
  const form = view.querySelector('#f');
  if (form) {
    placeSuggestions(form.address);
    form.onsubmit = async (e) => {
      e.preventDefault();
      try {
        const saved = await sendCheckingAddress((b) => api('/saved-places', { method: 'POST', body: b }), formData(form));
        toast(`"${saved.nickname}" salvo`);
        screens.enderecos();
      } catch (err) {
        toast(err.message);
      }
    };
  }
  view.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = async () => {
      const p = list.find((x) => String(x.id) === b.dataset.del);
      if (!(await ask(`Apagar o apelido "${p.nickname}"?`, { danger: true }))) return;
      await api(`/saved-places/${p.id}`, { method: 'DELETE' });
      screens.enderecos();
    };
  });
};

// Caminhões: milhas e manutenção (óleo, pneus, freios, inspeção...).
screens.caminhoes = async () => {
  setScreen('Caminhões', { tab: 'mais', back: '#/mais' });
  const owner = state.me.role === 'dono';
  const [trucks, users] = await Promise.all([api('/trucks'), owner ? api('/users') : []]);
  const miles = (n) => `${Number(n || 0).toLocaleString('en-US')} mi`;
  const ICON = { ok: '✅', perto: '🟡', vencido: '🔴' };
  const drivers = users.filter((u) => u.active && drives(u));
  const driverSelect = (selected) =>
    `<select name="driver_id"><option value="">Sem motorista fixo</option>${[...drivers, ...users.filter((u) => u.id === selected && !drivers.includes(u))].map((u) => `<option value="${u.id}"${u.id === selected ? ' selected' : ''}>${esc(u.name)}</option>`).join('')}</select>`;
  const every = (i) => [i.every_miles ? `a cada ${miles(i.every_miles)}` : '', i.every_days ? `a cada ${i.every_days} dias` : ''].filter(Boolean).join(' ou ');
  const today = new Intl.DateTimeFormat('en-CA').format(new Date());
  view.innerHTML = `${owner && trucks.length ? `<div class="card" id="semana"><h2>📊 Relatório da semana</h2>
      <p class="sub">Toda segunda de manhã o relatório da semana passada chega no seu WhatsApp. Para ver outra semana, escolha um dia dela.</p>
      <div class="copyrow"><input type="date" class="dia" value="${today}" max="${today}"><a class="btn secondary" target="_blank" rel="noopener">📄 Ver relatório</a></div>
      <p class="sub week-sum"></p></div>` : ''}
    ${trucks
    .map(
      (t) => `<div class="card truck" data-truck="${t.id}">
        <div class="row"><div><h2>🚛 ${esc(t.name)}${t.plate ? ` <span class="sub">${esc(t.plate)}</span>` : ''}</h2>
          <div class="sub">${t.driver_name ? esc(t.driver_name) + ' · ' : ''}atualizado ${when(t.odometer_at)}</div></div>
          <div class="right"><div class="big">${miles(t.odometer)}</div></div></div>
        <form class="copyrow odo"><input name="odometer" inputmode="numeric" placeholder="Milhas no painel do caminhão"><button>Atualizar</button></form>
        <ul class="list">${t.items
          .map(
            (i) => `<li class="m-${i.state}"><div class="row"><div><strong>${ICON[i.state]} ${esc(i.name)}</strong>
              <div class="sub">${esc(i.note || '')}${i.note ? ' · ' : ''}${every(i)}</div></div>
              <div class="right"><a class="btn secondary small" href="#/manutencao/${t.id}?item=${i.id}">Feito</a>
              ${owner ? `<button class="link small" data-edit="${i.id}">Editar</button>` : ''}</div></div></li>`
          )
          .join('')}</ul>
        <div class="actions"><a class="btn" href="#/manutencao/${t.id}">🔧 Registrar serviço</a><a class="btn secondary" href="#/manutencao/${t.id}?ver=historico">Histórico</a></div>
        ${owner ? `<div class="truck-month"><label>Despesas do mês</label><div class="copyrow"><input type="month" class="mes" value="${new Date().toISOString().slice(0, 7)}"><a class="btn secondary" data-pdf="${t.id}" target="_blank" rel="noopener">📄 Ver extrato</a></div><p class="sub month-sum"></p></div>` : ''}
        ${owner ? `<details><summary class="sub">Mais opções</summary>
          <form class="additem"><label>Novo item</label><input name="name" placeholder="Filtro de ar, correia…" required>
            <div class="row2"><div><label>A cada (milhas)</label><input name="every_miles" inputmode="numeric"></div><div><label>A cada (dias)</label><input name="every_days" inputmode="numeric"></div></div>
            <button class="secondary block">Adicionar item</button></form>
          <form class="edittruck"><label>Motorista</label>${driverSelect(t.driver_id)}<button class="secondary block">Salvar motorista</button></form>
          <button class="danger" data-deltruck="${t.id}">Apagar caminhão</button></details>` : ''}
      </div>`
    )
    .join('')}
    ${!trucks.length ? `<div class="card empty">${owner ? 'Cadastre seu caminhão abaixo. Ele já vem com troca de óleo, pneus, freios, inspeção e registro.' : 'Nenhum caminhão cadastrado. Peça para o ADM cadastrar.'}</div>` : ''}
    ${owner ? `<form class="card" id="novo"><h2>Cadastrar caminhão</h2>
      <div class="row2"><div><label>Nome</label><input name="name" placeholder="F-550" required></div><div><label>Placa</label><input name="plate"></div></div>
      <label>Milhas agora</label><input name="odometer" inputmode="numeric" required placeholder="123456">
      <label>Motorista</label>${driverSelect(null)}
      <p class="sub">Óleo a cada 5.000 mi, rodízio de pneus a cada 6.000 mi, freios a cada 25.000 mi, inspeção e registro todo ano. Dá para mudar depois.</p>
      <button class="block">Cadastrar</button></form>` : ''}
    <p class="sub">Pelo WhatsApp: <strong>odometro 123456</strong> para atualizar as milhas (se o motorista não mandar até sexta, recebe 3 avisos de hora em hora e depois a lista de serviços dele fica suspensa até mandar) e <strong>fiz oleo</strong> quando fizer a manutenção.</p>`;

  const week = view.querySelector('#semana');
  if (week) {
    const dia = week.querySelector('.dia');
    const show = async () => {
      week.querySelector('a').href = `/api/frota/semana.pdf?dia=${dia.value}`;
      const r = await api(`/frota/semana?dia=${dia.value}`).catch(() => null);
      if (!r) return;
      const d = (x) => x.slice(8, 10) + '/' + x.slice(5, 7);
      week.querySelector('.week-sum').textContent = `${d(r.start)} a ${d(r.end)}: ${r.totals.miles.toLocaleString('en-US')} mi rodadas · ${r.totals.services} serviço(s)${r.totals.late ? ` · ${r.totals.late} atrasado(s)` : ''}${r.totals.missing ? ` · ${r.totals.missing} sem milhagem` : ''}`;
    };
    dia.onchange = show;
    show();
  }

  const run = async (fn, ok) => {
    try {
      await fn();
      if (ok) toast(ok);
      screens.caminhoes();
    } catch (err) {
      toast(err.message);
    }
  };
  view.querySelector('#novo')?.addEventListener('submit', (e) => {
    e.preventDefault();
    run(() => api('/trucks', { method: 'POST', body: formData(e.target) }), 'Caminhão cadastrado');
  });
  view.querySelectorAll('[data-truck]').forEach((card) => {
    const id = card.dataset.truck;
    const truck = trucks.find((t) => String(t.id) === id);
    const mes = card.querySelector('.mes');
    if (mes) {
      const show = async () => {
        card.querySelector('[data-pdf]').href = `/api/trucks/${id}/extrato.pdf?mes=${mes.value}`;
        const m = await api(`/trucks/${id}/month?mes=${mes.value}`).catch(() => null);
        card.querySelector('.month-sum').textContent = m
          ? `Gasto ${money(m.total_cents)} · ${m.miles ? `${m.miles.toLocaleString('en-US')} mi rodadas · ${money(m.cost_per_mile_cents)} por milha` : 'milhas do mês ainda não informadas'}`
          : '';
      };
      mes.onchange = show;
      show();
    }
    card.querySelector('.odo').onsubmit = (e) => {
      e.preventDefault();
      run(() => api(`/trucks/${id}`, { method: 'PATCH', body: formData(e.target) }), 'Milhas atualizadas');
    };
    card.querySelector('.additem')?.addEventListener('submit', (e) => {
      e.preventDefault();
      run(() => api(`/trucks/${id}/items`, { method: 'POST', body: formData(e.target) }), 'Item adicionado');
    });
    card.querySelector('.edittruck')?.addEventListener('submit', (e) => {
      e.preventDefault();
      run(() => api(`/trucks/${id}`, { method: 'PATCH', body: formData(e.target) }), 'Salvo');
    });
    card.querySelectorAll('[data-edit]').forEach((b) => {
      b.onclick = async () => {
        const item = truck.items.find((i) => String(i.id) === b.dataset.edit);
        const m = await askText(`${item.name}: a cada quantas milhas? (vazio = não conta milhas)`, item.every_miles || '');
        if (m == null) return;
        const d = await askText(`${item.name}: a cada quantos dias? (vazio = não conta dias)\nPara apagar o item, deixe os dois vazios.`, item.every_days || '');
        if (d == null) return;
        if (!m && !d) {
          if (await ask(`Apagar "${item.name}"?`, { danger: true })) run(() => api(`/maintenance/${item.id}`, { method: 'DELETE' }), 'Item apagado');
          return;
        }
        run(() => api(`/maintenance/${item.id}`, { method: 'PATCH', body: { every_miles: m, every_days: d } }), 'Salvo');
      };
    });
  });
  view.querySelectorAll('[data-deltruck]').forEach((b) => {
    b.onclick = async () => (await ask('Apagar este caminhão e a manutenção dele?', { danger: true })) && run(() => api(`/trucks/${b.dataset.deltruck}`, { method: 'DELETE' }), 'Caminhão apagado');
  });
};

// Registrar serviço do caminhão (óleo, freio...) com a próxima troca, e o histórico.
screens.manutencao = async (params, id) => {
  setScreen('Registrar serviço', { tab: 'mais', back: '#/caminhoes' });
  const owner = state.me.role === 'dono';
  const [trucks, log] = await Promise.all([api('/trucks'), api(`/trucks/${id}/log`)]);
  const truck = trucks.find((t) => String(t.id) === String(id));
  if (!truck) throw new Error('Caminhão não encontrado.');
  const miles = (n) => `${Number(n || 0).toLocaleString('en-US')} mi`;
  const today = new Intl.DateTimeFormat('en-CA').format(new Date());
  const pre = params.get('item') || '';
  view.innerHTML = `<form class="card" id="f">
      <h2>🚛 ${esc(truck.name)}</h2><p class="sub">Agora: ${miles(truck.odometer)}</p>
      <label>O que foi feito</label>
      <select name="item_id">${truck.items.map((i) => `<option value="${i.id}"${String(i.id) === pre ? ' selected' : ''}>${esc(i.name)}</option>`).join('')}<option value="">Outro…</option></select>
      <div class="outro" hidden><label>Qual serviço?</label><input name="name" placeholder="Bateria, correia, alinhamento…"></div>
      <div class="row2"><div><label>Data</label><input type="date" name="date" value="${today}" max="${today}"></div>
        <div><label>Milhas no dia</label><input name="miles" inputmode="numeric" value="${truck.odometer}"></div></div>
      <div class="row2"><div><label>Valor ($)</label><input name="cost" inputmode="decimal" placeholder="opcional"></div>
        <div><label>Oficina / onde</label><input name="shop" placeholder="opcional"></div></div>
      <h3>Próxima troca</h3>
      <div class="row2"><div><label>Com quantas milhas</label><input name="next_miles" inputmode="numeric"></div>
        <div><label>Até que data</label><input type="date" name="next_date"></div></div>
      <p class="sub next-help"></p>
      <label>Observação</label><input name="notes" placeholder="opcional">
      <button class="block">Salvar serviço</button>
    </form>
    <div class="card" id="historico"><h2>Histórico</h2>${log.length ? `<ul class="list">${log
      .map(
        (l) => `<li><div class="row"><div><strong>${esc(l.item_name)}</strong>
          <div class="sub">${new Date(l.done_at).toLocaleDateString('pt-BR')} · ${miles(l.miles)}${l.shop ? ` · ${esc(l.shop)}` : ''}${l.user_name ? ` · ${esc(l.user_name)}` : ''}${l.notes ? ` · ${esc(l.notes)}` : ''}</div></div>
          <div class="right">${l.cost_cents ? money(l.cost_cents) : ''}${owner ? `<button class="link small" data-del="${l.id}">Apagar</button>` : ''}</div></div></li>`
      )
      .join('')}</ul>` : '<p class="sub">Nenhum serviço registrado ainda.</p>'}</div>`;

  const f = view.querySelector('#f');
  // Preenche a próxima troca pelo intervalo do item, até a pessoa mexer no campo.
  const touched = new Set();
  ['next_miles', 'next_date'].forEach((n) => f[n].addEventListener('input', () => touched.add(n)));
  const fill = () => {
    const item = truck.items.find((i) => String(i.id) === f.item_id.value);
    f.querySelector('.outro').hidden = Boolean(item);
    const m = Number(String(f.miles.value).replace(/[^\d]/g, '')) || truck.odometer;
    if (!touched.has('next_miles')) f.next_miles.value = item?.every_miles ? m + item.every_miles : '';
    if (!touched.has('next_date')) {
      f.next_date.value = item?.every_days && f.date.value ? new Date(Date.parse(f.date.value + 'T12:00:00Z') + item.every_days * 86400000).toISOString().slice(0, 10) : '';
    }
    const every = item ? [item.every_miles ? `a cada ${miles(item.every_miles)}` : '', item.every_days ? `a cada ${item.every_days} dias` : ''].filter(Boolean).join(' ou ') : '';
    f.querySelector('.next-help').textContent = every
      ? `Preenchido pelo intervalo (${every}). Pode mudar se a oficina indicou outro.`
      : 'Deixe vazio se não precisa avisar de novo.';
  };
  ['item_id', 'miles', 'date'].forEach((n) => f[n].addEventListener(n === 'item_id' ? 'change' : 'input', fill));
  fill();
  f.onsubmit = async (e) => {
    e.preventDefault();
    try {
      const r = await api(`/trucks/${id}/services`, { method: 'POST', body: formData(f) });
      toast(`${r.log.item_name} registrado ✅`);
      location.hash = '#/caminhoes';
    } catch (err) {
      toast(err.message);
    }
  };
  view.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = async () => {
      if (!(await ask('Apagar este serviço do histórico?', { danger: true }))) return;
      try {
        await api(`/maintenance-log/${b.dataset.del}`, { method: 'DELETE' });
        toast('Apagado');
        screens.manutencao(params, id);
      } catch (err) {
        toast(err.message);
      }
    };
  });
  if (params.get('ver') === 'historico') view.querySelector('#historico').scrollIntoView();
};

// Invoice (fatura/recibo em PDF) do serviço, no modelo da empresa.
const centsToInput = (c) => ((c || 0) / 100).toFixed(2);
const dayFmt = (day) => (day ? day.split('-').reverse().join('/') : '');

async function shareInvoice(inv) {
  const name = `Invoice ${inv.number}.pdf`;
  try {
    const res = await net(`/api/invoices/${inv.id}/pdf`);
    const file = new File([await res.blob()], name, { type: 'application/pdf' });
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: name, text: `Invoice #${inv.number}` });
      return;
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
  }
  if (inv.link && navigator.share) {
    await navigator.share({ title: name, text: `Here is your invoice #${inv.number}: ${inv.link}` }).catch(() => {});
    return;
  }
  location.href = `/api/invoices/${inv.id}/pdf?download=1`;
}

screens.invoice = async (params, id) => {
  setScreen('Invoice', { tab: 'servicos', back: `#/servico/${id}` });
  const { draft, invoices } = await api(`/services/${id}/invoices`);
  const editId = params.get('editar');
  const editing = editId ? invoices.find((i) => String(i.id) === editId) : null;
  const showForm = editing || !invoices.length || params.get('novo') === '1';
  const inv = editing || draft;
  const itemRow = (it = { description: '', details: '', qty: 1, unit_cents: 0 }) => `
    <div class="inv-item">
      <label>Descrição</label><input name="description" value="${esc(it.description)}" required>
      <div class="row2"><div><label>Qtd.</label><input name="qty" inputmode="decimal" value="${esc(it.qty)}"></div><div><label>Preço ($)</label><input name="unit" inputmode="decimal" value="${centsToInput(it.unit_cents)}"></div></div>
      <label>Detalhe (aparece embaixo, menor)</label><input name="details" value="${esc(it.details || '')}">
      <button type="button" class="danger small" data-rm>Tirar item</button>
    </div>`;
  view.innerHTML = `
    ${invoices.length ? `<div class="card"><h2>Invoices deste serviço</h2><ul class="list">${invoices
      .map(
        (i) => `<li><div class="row"><div><strong>Nº ${i.number}</strong> · ${money(i.total_cents)}<div class="sub">${dayFmt(i.issue_date)} · ${esc((i.bill_to || '').split('\n')[0])}</div></div></div>
        <div class="actions"><a class="btn secondary" href="/api/invoices/${i.id}/pdf" target="_blank" rel="noopener" data-view="${i.id}">Ver PDF</a>
          <button data-share="${i.id}">📤 Mandar</button>
          <a class="btn secondary" href="#/invoice/${id}?editar=${i.id}">Editar</a>
          ${state.me.role === 'dono' ? `<button class="danger" data-del="${i.id}">🗑 Apagar</button>` : ''}</div></li>`
      )
      .join('')}</ul>${showForm ? '' : `<a class="btn secondary block" href="#/invoice/${id}?novo=1">Fazer outro invoice</a>`}</div>` : ''}
    ${showForm ? `<form class="card" id="f">
      <h2>${editing ? `Editar invoice nº ${editing.number}` : 'Novo invoice'}</h2>
      <div class="row2"><div><label>Número</label><input name="number" inputmode="numeric" value="${inv.number}" ${editing ? 'disabled' : ''}></div><div></div></div>
      <label>Para (Bill to): nome, endereço…</label><textarea name="bill_to" rows="3">${esc(inv.bill_to || '')}</textarea>
      <div class="row2"><div><label>Data</label><input type="date" name="issue_date" value="${inv.issue_date}"></div><div><label>Vencimento</label><input type="date" name="due_date" value="${inv.due_date}"></div></div>
      <h3>Itens</h3><div id="items">${inv.items.map(itemRow).join('')}</div>
      <button type="button" class="secondary" id="addItem">+ Item (milhas extras, espera, pedágio…)</button>
      <label>Observação (opcional)</label><textarea name="notes" rows="2">${esc(inv.notes || '')}</textarea>
      <p class="sub">O invoice sai em inglês, com o logo e os dados da empresa (Menu › Dados da empresa). Se o serviço já foi pago, sai com "PAID".</p>
      <button class="block">${editing ? 'Salvar' : 'Criar invoice'}</button>
    </form>` : ''}`;
  const form = view.querySelector('#f');
  if (form) {
    const items = form.querySelector('#items');
    const wire = () => items.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = () => items.children.length > 1 && b.closest('.inv-item').remove()));
    wire();
    form.querySelector('#addItem').onclick = () => {
      items.insertAdjacentHTML('beforeend', itemRow());
      wire();
    };
    form.onsubmit = async (e) => {
      e.preventDefault();
      const body = {
        number: form.number.value,
        bill_to: form.bill_to.value,
        issue_date: form.issue_date.value,
        due_date: form.due_date.value,
        notes: form.notes.value,
        items: [...items.querySelectorAll('.inv-item')].map((row) => ({
          description: row.querySelector('[name=description]').value,
          details: row.querySelector('[name=details]').value,
          qty: row.querySelector('[name=qty]').value,
          unit: row.querySelector('[name=unit]').value,
        })),
      };
      try {
        const saved = editing
          ? await api(`/invoices/${editing.id}`, { method: 'PUT', body })
          : await api(`/services/${id}/invoices`, { method: 'POST', body });
        toast(`Invoice nº ${saved.number} pronto`);
        if (location.hash === `#/invoice/${id}`) screens.invoice(new URLSearchParams(), id);
        else location.hash = `#/invoice/${id}`;
      } catch (err) {
        toast(err.message);
      }
    };
  }
  view.querySelectorAll('[data-share]').forEach((b) => {
    b.onclick = () => shareInvoice(invoices.find((i) => String(i.id) === b.dataset.share));
  });
  // Ver PDF abre aqui dentro do app, com Voltar (no celular, a aba do PDF não tinha como voltar).
  view.querySelectorAll('[data-view]').forEach((a) => {
    a.onclick = (e) => {
      if (e.ctrlKey || e.metaKey || e.shiftKey) return;
      e.preventDefault();
      const i = invoices.find((x) => String(x.id) === a.dataset.view);
      openDoc({ url: `/api/invoices/${i.id}/pdf`, name: `Invoice ${i.number}.pdf`, mime: 'application/pdf' });
    };
  });
  view.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = async () => {
      const i = invoices.find((x) => String(x.id) === b.dataset.del);
      if (!(await ask(`Apagar o invoice nº ${i.number}? Não dá para desfazer.`, { ok: 'Apagar', cancel: 'Voltar', danger: true }))) return;
      try {
        await api(`/invoices/${i.id}`, { method: 'DELETE' });
        toast(`Invoice nº ${i.number} apagado`);
        screens.invoice(new URLSearchParams(), id);
      } catch (err) {
        toast(err.message);
      }
    };
  });
};

// Dados que aparecem no invoice: nome, endereço, telefone, Zelle, logo e numeração.
screens.empresa = async () => {
  setScreen('Dados da empresa', { tab: 'mais', back: '#/mais' });
  const c = await api('/company');
  const field = (name, label, extra = '') => `<label>${label}</label><input name="${name}" value="${esc(c[name] ?? '')}" ${extra}>`;
  view.innerHTML = `
    <form class="card" id="f">
      <h2>Aparece no invoice</h2>
      ${field('name', 'Nome da empresa', 'required')}
      <label>Endereço</label><textarea name="address" rows="3">${esc(c.address || '')}</textarea>
      <div class="row2"><div>${field('contact', 'Contato')}</div><div>${field('phone', 'Telefone', 'type="tel"')}</div></div>
      ${field('email', 'E-mail', 'type="email"')}
      <div class="row2"><div>${field('zelle', 'Zelle')}</div><div>${field('zelleName', 'Nome no Zelle')}</div></div>
      ${field('itemName', 'Nome do serviço no invoice')}
      <div class="row2"><div><label>Próximo número</label><input value="${c.next_number}" disabled></div>
        <div><label>Prazo (dias)</label><input name="dueDays" inputmode="numeric" value="${c.dueDays}"></div></div>
      <p class="sub">O número do invoice é ano + mês + sequência do mês (ex.: 2610001 = outubro de 2026, o 1º do mês).</p>
      <button class="block">Salvar</button>
    </form>
    <div class="card"><h2>Logo</h2><img class="logo-preview" src="/api/company/logo?t=${Date.now()}" alt="Logo">
      <button class="secondary block" id="logo">Trocar logo (JPG ou PNG)</button></div>`;
  view.querySelector('#f').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('/company', { method: 'PUT', body: formData(e.target) });
      toast('Salvo');
    } catch (err) {
      toast(err.message);
    }
  };
  view.querySelector('#logo').onclick = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg';
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return;
      try {
        await api('/company/logo', { method: 'POST', raw: file, type: file.type });
        toast('Logo trocado');
        screens.empresa();
      } catch (err) {
        toast(err.message);
      }
    };
    input.click();
  };
};

// Empresas clientes (oficinas, dealers) com vários solicitantes, e o extrato para cobrar tudo junto.
// Apelido e regras da empresa (no cadastro e na edição).
// Apelido logo depois do nome: é por ele que a empresa é achada no Novo serviço e no endereço.
const companyNick = (c = {}) => `<label>Apelido (ex.: SS, Moving)</label><input name="nickname" maxlength="30" placeholder="Nome curto para digitar rápido" value="${esc(c.nickname || '')}">`;
// Um endereço só: vai na cobrança (Bill to) e é onde pegar ou deixar carros.
const companyAddressField = (c = {}) => `<label>Endereço (cobrança e entrega)</label><input name="address" maxlength="300" placeholder="Rua, cidade, estado e CEP" value="${esc(c.address || '')}">`;
const companyRules = (c = {}) => `
  <p class="sub">O endereço vira sozinho um apelido: digite ${c.nickname || c.name ? `<strong>${esc(c.nickname || c.name)}</strong>` : 'o apelido (ou o nome)'} na retirada ou no destino.</p>
  <label class="check"><input type="checkbox" name="requires_vin" ${c.requires_vin ? 'checked' : ''}> Exige o VIN para fechar o serviço</label>
  <label class="check"><input type="checkbox" name="always_invoice" ${c.always_invoice ? 'checked' : ''}> Sempre fazer invoice ao fechar o serviço</label>`;
const companyBody = (form) => ({ ...formData(form), requires_vin: form.requires_vin.checked, always_invoice: form.always_invoice.checked });

// Lista de empresas com o extrato fica no menu Mais; "Nova empresa" abre só o cadastro (pela tela Clientes).
screens.empresas = async (params, id) => {
  if (id === 'nova') return novaEmpresa();
  setScreen('Empresas e extrato', { tab: 'mais', back: '#/mais' });
  const list = await api('/companies');
  view.innerHTML = `
    <div class="card"><ul class="list">${
      list.length
        ? list.map((c) => `<li><a href="#/cliente/${c.id}"><div><strong>${esc(c.name)}</strong>${c.nickname ? ` <span class="badge">${esc(c.nickname)}</span>` : ''}<div class="sub">${c.requesters_count} solicitante(s)${c.requires_vin ? ' · exige VIN' : ''}${c.always_invoice ? ' · sempre invoice' : ''}</div></div><div class="right">${c.due_cents ? `<strong>${money(c.due_cents)}</strong><div class="sub">em aberto</div>` : '<span class="sub">em dia ✅</span>'}</div></a></li>`).join('')
        : '<li class="empty">Nenhuma empresa ainda. Cadastre em Clientes › Nova empresa.</li>'
    }</ul></div>`;
};

const novaEmpresa = () => {
  setScreen('Nova empresa', { tab: 'contatos', back: '#/contatos' });
  view.innerHTML = `
    <form class="card" id="f">
      <label>Nome</label><input name="name" required placeholder="Ex.: USAVE Motors">
      ${companyNick()}
      ${companyAddressField()}
      <div class="row2"><div><label>Telefone</label><input name="phone" type="tel"></div><div><label>E-mail</label><input name="email" type="email"></div></div>
      ${companyRules()}
      <button class="block">Cadastrar</button>
    </form>`;
  view.querySelector('#f').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const c = await api('/companies', { method: 'POST', body: companyBody(e.target) });
      toast('Empresa cadastrada');
      location.hash = `#/cliente/${c.id}`;
    } catch (err) {
      toast(err.message);
    }
  };
};

screens.cliente = async (params, id) => {
  setScreen('Empresa', { tab: 'mais', back: '#/empresas' });
  const periodo = params.get('periodo') || 'abertos';
  const c = await api(`/companies/${id}?periodo=${periodo}`);
  const st = c.statement;
  const now = new Date();
  const months = [...Array(12)].map((_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  });
  const monthName = (m) => new Date(`${m}-15T12:00:00`).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
  const pdfUrl = `/api/companies/${id}/statement.pdf?periodo=${periodo}`;
  view.innerHTML = `
    <div class="card">
      <h2>${esc(c.name)}</h2>
      <label>Extrato de</label>
      <select id="periodo"><option value="abertos">Tudo que está em aberto</option>${months.map((m) => `<option value="${m}"${m === periodo ? ' selected' : ''}>${monthName(m)} (todos)</option>`).join('')}</select>
      <p class="big" style="margin:12px 0 0">${money(st.due_cents)}</p>
      <p class="sub" style="margin-top:2px">em aberto · ${st.count} serviço(s)${st.paid_cents ? ` · já pago ${money(st.paid_cents)}` : ''}</p>
      <div class="actions"><a class="btn secondary" href="${pdfUrl}" target="_blank" rel="noopener">Ver PDF</a><button id="share">📤 Mandar extrato</button></div>
    </div>
    ${st.groups
      .map(
        (g) => `<div class="card"><h2>👤 ${esc(g.requester)} <span class="sub">· ${money(g.due_cents)}</span></h2><ul class="list">${g.services
          .map((s) => `<li><a href="#/servico/${s.id}"><div>#${s.id} ${esc(s.vehicle || '')}<div class="sub">${s.day.split('-').reverse().join('/')}${s.invoices.length ? ` · invoice ${s.invoices.join(', ')}` : ''}</div></div><div class="right">${s.due_cents ? money(s.due_cents) : '<span class="sub">pago ✅</span>'}</div></a></li>`)
          .join('')}</ul></div>`
      )
      .join('')}
    <div class="card"><h2>Solicitantes</h2><ul class="list">${
      c.requesters.length
        ? c.requesters.map((r) => `<li><div class="row"><a href="#/contato/${r.id}">${esc(r.name)}<div class="sub">${r.phone ? phoneFmt(r.phone) : ''}</div></a><button class="danger" data-unlink="${r.id}">Tirar</button></div></li>`).join('')
        : '<li class="empty">Ninguém ainda. Ligue abaixo as pessoas que pedem serviço por esta empresa.</li>'
    }</ul>
      <label>Adicionar solicitante</label>
      <div class="copyrow"><div class="select-tap"><select id="reqSel" tabindex="-1"><option value="">Escolha um cliente…</option></select><button type="button" id="addReq" aria-label="Escolher cliente"></button></div><button class="secondary" id="addBtn">Adicionar</button></div>
      <p class="sub">Pelo WhatsApp: abra o serviço e mande <strong>empresa ${esc(c.name.split(' ')[0].toLowerCase())}</strong>.</p>
    </div>
    <details class="card"><summary>Dados da empresa</summary>
      <form id="f">
        <label>Nome</label><input name="name" value="${esc(c.name)}" required>
        ${companyNick(c)}
        ${companyAddressField(c)}
        <div class="row2"><div><label>Telefone</label><input name="phone" type="tel" value="${esc(c.phone || '')}"></div><div><label>E-mail</label><input name="email" type="email" value="${esc(c.email || '')}"></div></div>
        ${companyRules(c)}
        <label>Observações</label><textarea name="notes" rows="2">${esc(c.notes || '')}</textarea>
        <button class="block">Salvar</button>
      </form>
      <button class="danger" id="del">Apagar empresa</button>
    </details>`;
  const reload = () => screens.cliente(params, id);
  view.querySelector('#periodo').onchange = (e) => (location.hash = `#/cliente/${id}?periodo=${e.target.value}`);
  view.querySelector('#share').onclick = async () => {
    const name = `Statement ${c.name}.pdf`;
    try {
      const file = new File([await (await net(pdfUrl)).blob()], name, { type: 'application/pdf' });
      if (navigator.canShare?.({ files: [file] })) return await navigator.share({ files: [file], title: name });
    } catch (err) {
      if (err.name === 'AbortError') return;
    }
    if (c.link && navigator.share) return navigator.share({ title: name, text: `Here is your statement: ${c.link}` }).catch(() => {});
    location.href = pdfUrl + '&download=1';
  };
  // Clientes mais novos (ou os da busca) que ainda não são desta empresa; tocar adiciona.
  const linked = new Set(c.requesters.map((r) => r.id));
  view.querySelector('#addReq').onclick = async () => {
    const p = await pickDialog({
      title: 'Adicionar solicitante',
      placeholder: 'Buscar cliente por nome ou telefone',
      items: async (q) =>
        (await api(q ? `/contacts?q=${encodeURIComponent(q)}&limit=20` : '/contacts?recent=1&limit=20'))
          .filter((x) => !linked.has(x.id))
          .map((x) => ({ id: x.id, name: x.name, sub: x.phone ? phoneFmt(x.phone) : '' })),
    });
    if (p) view.querySelector('#reqSel').innerHTML = `<option value="${p.id}">${esc(p.name)}${p.sub ? ' · ' + esc(p.sub) : ''}</option>`;
  };
  view.querySelector('#addBtn').onclick = async () => {
    const pid = view.querySelector('#reqSel').value;
    if (!pid) return toast('Escolha um cliente');
    try {
      await api(`/contacts/${pid}/company`, { method: 'PUT', body: { company_id: Number(id) } });
      toast('Solicitante adicionado');
      reload();
    } catch (err) {
      toast(err.message);
    }
  };
  view.querySelectorAll('[data-unlink]').forEach((b) => {
    b.onclick = async () => {
      if (!(await ask('Tirar esta pessoa da empresa? Os serviços dela saem do extrato.'))) return;
      await api(`/contacts/${b.dataset.unlink}/company`, { method: 'PUT', body: { company_id: null } });
      reload();
    };
  });
  view.querySelector('#f').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api(`/companies/${id}`, { method: 'PATCH', body: companyBody(e.target) });
      toast('Salvo');
      reload();
    } catch (err) {
      toast(err.message);
    }
  };
  view.querySelector('#del').onclick = async () => {
    if (!(await ask(`Apagar ${c.name}? Os solicitantes continuam na lista de clientes.`, { danger: true }))) return;
    await api(`/companies/${id}`, { method: 'DELETE' });
    location.hash = '#/empresas';
  };
};

// Backup: baixar o banco e as fotos num arquivo só, para guardar no Google Drive.
screens.backup = async () => {
  setScreen('Backup', { tab: 'mais', back: '#/mais' });
  const info = await api('/backup');
  const mb = Math.max(1, Math.round(info.bytes / 1048576));
  view.innerHTML = `<div class="card"><h2>💾 Backup</h2>
      <p>Um arquivo com tudo: serviços, clientes, pagamentos, despesas, caminhões e as ${info.files} foto(s)/arquivo(s). Cerca de ${mb} MB.</p>
      <p class="sub">Dentro dele vem a <strong>planilha-completa.xlsx</strong>, que abre no Excel ou no Google Planilhas.</p>
      <p class="sub">${info.last_download ? `Último backup baixado: ${when(info.last_download)}.` : 'Nenhum backup baixado ainda.'}</p>
      <a class="btn block" href="/api/backup.zip">⬇️ Baixar backup agora</a>
    </div>
    <div class="card"><h2>Como guardar no Google Drive</h2>
      <ol class="steps"><li>Toque em <strong>Baixar backup agora</strong>.</li>
      <li>No celular, abra o arquivo baixado e escolha <strong>Compartilhar › Drive</strong> (ou "Salvar no Drive").</li>
      <li>Pronto. Guarde os últimos 4 ou 5 e apague os mais antigos.</li></ol>
      <p class="sub">Todo domingo chega no seu WhatsApp um link para fazer isso. O servidor também guarda uma cópia diária do disco (Render).</p>
    </div>`;
};

// Pagamento dos motoristas: % do faturamento do mês, pago por semana e acertado no fim do mês.
const monthOptions = (selected) => {
  const now = new Date();
  return [...Array(12)]
    .map((_, i) => {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const m = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const label = d.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
      return `<option value="${m}"${m === selected ? ' selected' : ''}>${label}</option>`;
    })
    .join('');
};

screens.comissao = async (params) => {
  setScreen('Pagamento dos motoristas', { tab: 'mais', back: '#/mais' });
  const mes = params.get('mes') || '';
  const data = await api(`/comissao${mes ? `?mes=${mes}` : ''}`);
  const tiers = data.tiers;
  view.innerHTML = `
    <div class="card"><label>Mês</label><select id="mes">${monthOptions(data.mes)}</select></div>
    <div class="card"><ul class="list">${
      data.drivers.length
        ? data.drivers
            .map((d) => `<li><a href="#/motorista/${d.id}?mes=${data.mes}"><div><strong>${esc(d.name)}</strong>${d.active ? '' : ' <span class="badge cancelado">desativado</span>'}<div class="sub">Faturou ${money(d.revenue_cents)} · ${d.pct}%</div></div>
              <div class="right"><strong>${money(d.commission_cents)}</strong><div class="sub">${d.settlement_cents > 0 ? `falta ${money(d.settlement_cents)}` : 'em dia ✅'}</div></div></a></li>`)
            .join('')
        : '<li class="empty">Nenhum motorista. Cadastre em Menu › Equipe.</li>'
    }</ul></div>
    <details class="card"><summary>Faixas de porcentagem</summary>
      <form id="faixas">
        <p class="sub">A % vale para todo o faturamento do mês do motorista.</p>
        ${tiers
          .map((t, i) => `<div class="row2"><div><label>${i ? 'A partir de ($)' : 'Abaixo da próxima faixa'}</label><input name="from" inputmode="decimal" value="${(t.from_cents / 100).toFixed(0)}" ${i ? '' : 'readonly'}></div><div><label>%</label><input name="pct" inputmode="decimal" value="${t.pct}"></div></div>`)
          .join('')}
        <button class="block">Salvar faixas</button>
      </form>
    </details>`;
  view.querySelector('#mes').onchange = (e) => (location.hash = `#/comissao?mes=${e.target.value}`);
  view.querySelector('#faixas').onsubmit = async (e) => {
    e.preventDefault();
    const froms = [...e.target.querySelectorAll('[name=from]')].map((i) => i.value);
    const pcts = [...e.target.querySelectorAll('[name=pct]')].map((i) => i.value);
    try {
      await api('/comissao/faixas', { method: 'PUT', body: { tiers: froms.map((f, i) => ({ from: f, pct: pcts[i] })) } });
      toast('Faixas salvas');
      screens.comissao(params);
    } catch (err) {
      toast(err.message);
    }
  };
};

async function sharePdf(url, name) {
  try {
    const file = new File([await (await net(url)).blob()], name, { type: 'application/pdf' });
    if (navigator.canShare?.({ files: [file] })) return await navigator.share({ files: [file], title: name });
  } catch (err) {
    if (err.name === 'AbortError') return;
  }
  location.href = url + '&download=1';
}

screens.motorista = async (params, id) => {
  const owner = state.me.role === 'dono';
  const mes = params.get('mes') || '';
  const m = await api(`/comissao/${id}${mes ? `?mes=${mes}` : ''}`);
  setScreen(owner ? m.driver.name : 'Meus ganhos', { tab: 'mais', back: owner ? `#/comissao?mes=${m.mes}` : '#/mais' });
  const pdf = (week) => `/api/comissao/${id}/extrato.pdf?mes=${m.mes}${week ? `&semana=${week}` : ''}`;
  const dm = (d) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
  const due = m.settlement_cents - m.settled_cents;
  view.innerHTML = `
    <div class="card">
      <label>Mês</label><select id="mes">${monthOptions(m.mes)}</select>
      <div class="stats" style="margin-top:12px">
        <div><div class="sub">Faturou no mês</div><div class="big">${money(m.revenue_cents)}</div></div>
        <div><div class="sub">${m.pct}% do mês</div><div class="big">${money(m.commission_cents)}</div></div>
      </div>
      ${m.next_tier ? `<p class="sub">Faltam ${money(m.next_tier.missing_cents)} de faturamento para ${m.next_tier.pct}%.</p>` : ''}
    </div>
    <div class="card"><h2>Semanas</h2><ul class="list">${m.weeks
      .map((w) => {
        const paid = w.paid_cents >= w.amount_cents && w.amount_cents > 0;
        return `<li class="${w.current ? 'week-now' : ''}"><div class="row"><div><strong>${dm(w.start)} a ${dm(w.end)}</strong>${w.current ? ' <span class="badge aberto">esta semana</span>' : ''}
          <div class="sub">${w.services} serviço(s) · faturou ${money(w.revenue_cents)} · ${w.pct}%</div></div>
          <div class="right"><strong>${money(w.amount_cents)}</strong><div class="sub">${paid ? 'pago ✅' : w.paid_cents ? `pago ${money(w.paid_cents)}` : w.amount_cents ? 'a pagar' : ''}</div></div></div>
          ${w.services ? `<div class="actions"><a class="btn secondary small" href="${pdf(w.start)}" target="_blank" rel="noopener">📄 PDF da semana</a><button class="secondary small" data-share="${w.start}">📤 Mandar</button>${owner && !paid && w.amount_cents ? `<button class="small" data-pay="${w.start}">Paguei</button>` : ''}</div>` : ''}</li>`;
      })
      .join('')}</ul></div>
    <div class="card"><h2>Fechamento do mês</h2>
      <p>${money(m.revenue_cents)} × ${m.pct}% = <strong>${money(m.commission_cents)}</strong><br>
      <span class="sub">Já pago nas semanas: ${money(m.weekly_paid_cents)}${m.settled_cents ? ` · acerto pago: ${money(m.settled_cents)}` : ''}</span></p>
      <p class="big">${due > 0 ? `Acerto: ${money(due)}` : due < 0 ? `Recebeu ${money(-due)} a mais` : 'Mês quitado ✅'}</p>
      ${m.month_over ? '' : '<p class="sub">O mês ainda não acabou: o acerto pode mudar até o último dia.</p>'}
      <div class="actions"><a class="btn secondary" href="${pdf()}" target="_blank" rel="noopener">📄 PDF do mês</a><button class="secondary" data-share="">📤 Mandar</button>${owner && due ? '<button id="acerto">Paguei o acerto</button>' : ''}</div>
    </div>
    ${owner && m.payments.length ? `<details class="card"><summary>Pagamentos registrados</summary><ul class="list">${m.payments
      .map((p) => `<li><div class="row"><div>${p.kind === 'acerto' ? 'Acerto do mês' : `Semana de ${dm(p.week_start)}`}<div class="sub">${when(p.created_at)}</div></div><div class="right">${money(p.amount_cents)}<br><button class="danger" data-delpay="${p.id}">Apagar</button></div></div></li>`)
      .join('')}</ul></details>` : ''}`;
  const reload = () => screens.motorista(params, id);
  view.querySelector('#mes').onchange = (e) => (location.hash = `#/motorista/${id}?mes=${e.target.value}`);
  view.querySelectorAll('[data-share]').forEach((b) => {
    b.onclick = () => sharePdf(pdf(b.dataset.share), `${b.dataset.share ? `Semana ${b.dataset.share}` : `Fechamento ${m.mes}`} ${m.driver.name}.pdf`);
  });
  const pay = async (body, suggested) => {
    const value = await askText(`Quanto você pagou para ${m.driver.name}?`, (suggested / 100).toFixed(2), { input: { numeric: true } });
    if (value == null) return;
    try {
      await api(`/comissao/${id}/pagamentos`, { method: 'POST', body: { mes: m.mes, amount: value, ...body } });
      toast('Pagamento registrado ✅');
      reload();
    } catch (err) {
      toast(err.message);
    }
  };
  view.querySelectorAll('[data-pay]').forEach((b) => {
    const w = m.weeks.find((x) => x.start === b.dataset.pay);
    b.onclick = () => pay({ kind: 'semanal', week_start: w.start }, w.amount_cents - w.paid_cents);
  });
  view.querySelector('#acerto')?.addEventListener('click', () => pay({ kind: 'acerto' }, due));
  view.querySelectorAll('[data-delpay]').forEach((b) => {
    b.onclick = async () => {
      if (!(await ask('Apagar este pagamento?', { danger: true }))) return;
      await api(`/comissao/pagamentos/${b.dataset.delpay}`, { method: 'DELETE' });
      reload();
    };
  });
};

screens.despesas = async () => {
  setScreen('Despesas', { tab: 'mais', back: '#/mais' });
  const [list, trucks] = await Promise.all([api('/expenses'), has('manutencao') ? api('/trucks') : []]);
  const mine = trucks.filter((t) => t.driver_id === state.me.id);
  const defaultTruck = mine.length === 1 ? mine[0].id : trucks.length === 1 ? trucks[0].id : '';
  view.innerHTML = `
    <form class="card" id="f">
      <h2>Nova despesa</h2>
      <div class="row2">
        <div><label>Valor</label><input name="amount" inputmode="decimal" required></div>
        <div><label>Tipo</label><select name="category">${Object.entries(CATEGORIES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
      </div>
      <label>Descrição</label><input name="description" placeholder="Diesel, pedágio I-90…">
      ${trucks.length ? `<label>Caminhão</label><select name="truck_id"><option value="">Nenhum (despesa geral)</option>${trucks.map((t) => `<option value="${t.id}"${t.id === defaultTruck ? ' selected' : ''}>${esc(t.name)}</option>`).join('')}</select>` : ''}
      ${trucks.length ? '<label>Milhas do caminhão (painel) — opcional</label><input name="odometer" type="number" inputmode="numeric" placeholder="Ex.: depois de abastecer">' : ''}
      <button class="block">Registrar</button>
    </form>
    <div class="card"><ul class="list">${
      list.length
        ? list.map((e) => `<li><div class="row"><div>${CATEGORIES[e.category] || e.category}${e.description ? ' · ' + esc(e.description) : ''}<div class="sub">${when(e.created_at)}${state.me.role === 'dono' && e.user_name ? ' · ' + esc(e.user_name) : ''}${e.truck_name ? ' · 🚛 ' + esc(e.truck_name) : ''}</div></div>
            <div class="right">${money(e.amount_cents)}<br><button class="danger" data-del="${e.id}">Apagar</button></div></div></li>`).join('')
        : '<li class="empty">Nenhuma despesa.</li>'
    }</ul></div>`;
  view.querySelector('#f').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('/expenses', { method: 'POST', body: formData(e.target) });
      toast('Despesa registrada');
      screens.despesas();
    } catch (err) {
      toast(err.message);
    }
  };
  const spoken = takePrefill('despesa');
  if (spoken) {
    const form = view.querySelector('#f');
    const c = spoken.campos;
    fillForm(form, { amount: c.amount, category: c.category, description: c.description, odometer: c.odometer, truck_id: c.truck_id });
    const missing = c.amount ? '' : 'Faltou o valor: digite quanto gastou.';
    voiceSay(missing || 'Confira a despesa e toque em registrar.', missing || '✅ Preenchi a despesa. Confira e toque em Registrar.', !missing);
    (missing ? form.amount : form.querySelector('button')).focus();
  }
  view.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = async () => {
      if (!(await ask('Apagar esta despesa?', { danger: true }))) return;
      await api(`/expenses/${b.dataset.del}`, { method: 'DELETE' });
      screens.despesas();
    };
  });
};

// ADM que também faz serviço: a caixinha só aparece quando a função é ADM.
const alsoDriver = (show, checked) =>
  `<label class="check also-driver"${show ? '' : ' hidden'}><input type="checkbox" name="drives"${checked ? ' checked' : ''}> Também é motorista (aparece na lista para receber serviços)</label>`;
// Função + caixinha viram um valor só para o servidor: motorista, dono ou dono_motorista.
function teamBody(form) {
  const body = formData(form);
  if (body.role === 'dono' && body.drives) body.role = 'dono_motorista';
  delete body.drives;
  return body;
}
function wireRole(form) {
  const role = form.querySelector('[name=role]');
  const box = form.querySelector('.also-driver');
  role.onchange = () => {
    box.hidden = role.value !== 'dono';
  };
}

screens.equipe = async () => {
  setScreen('Equipe', { tab: 'mais', back: '#/mais' });
  const users = await api('/users');
  const apoio = has('ajuda') ? await api('/ajuda/apoio').catch(() => null) : null;
  view.innerHTML = `
    ${apoio ? apoioCard(apoio, users) : ''}
    <div class="card"><ul class="list">${users
      .map((u) => `<li><div class="row"><div><strong>${esc(u.name)}</strong> ${u.active ? '' : '<span class="badge cancelado">desativado</span>'}<div class="sub">${phoneFmt(u.phone)} · ${u.role === 'dono' ? (u.drives ? 'ADM e motorista' : 'ADM') : 'Motorista'}</div>
        <select class="firm-pick" data-firm="${u.id}" aria-label="Empresa de ${esc(u.name)}">${firmOptions(u.firm)}</select></div>
        <div class="actions"><button class="secondary" data-edit="${u.id}">✏️ Editar</button></div></div>
        <form class="team-edit" data-form="${u.id}" hidden>
          <label>Nome</label><input name="name" value="${esc(u.name)}" required>
          <label>Telefone (WhatsApp)</label><input name="phone" type="tel" value="${phoneFmt(u.phone)}" required>
          <label>Novo PIN (deixe vazio para não mudar)</label><input name="pin" inputmode="numeric" pattern="[0-9]{4,8}">
          <label>Função</label><select name="role">${u.id !== state.me.id ? `<option value="motorista"${u.role === 'motorista' ? ' selected' : ''}>Motorista</option>` : ''}<option value="dono"${u.role === 'dono' ? ' selected' : ''}>ADM (administrador)</option></select>
          ${alsoDriver(u.role === 'dono', u.drives)}
          <div class="actions"><button>Salvar</button><button type="button" class="secondary" data-cancel>Cancelar</button></div>
          ${u.id !== state.me.id ? `<div class="actions"><button type="button" class="${u.active ? 'danger' : 'secondary'}" data-toggle="${u.id}" data-active="${u.active}">${u.active ? 'Desativar' : 'Ativar'} ${esc(u.name)}</button></div>` : ''}
        </form></li>`)
      .join('')}</ul></div>
    <form class="card" id="f">
      <h2>Adicionar pessoa</h2>
      <p class="sub">O número precisa ser o WhatsApp da pessoa, para o robô reconhecer.</p>
      <label>Nome</label><input name="name" required>
      <label>Telefone (WhatsApp)</label><input name="phone" type="tel" required>
      <label>PIN para entrar no painel (opcional)</label><input name="pin" inputmode="numeric" pattern="[0-9]{4,8}">
      <label>Função</label><select name="role"><option value="motorista">Motorista</option><option value="dono">ADM (administrador)</option></select>
      ${alsoDriver(false, false)}
      <label>Empresa</label><select name="firm">${firmOptions('jj')}</select>
      <button class="block">Adicionar</button>
    </form>`;
  view.querySelectorAll('form.team-edit, #f').forEach(wireRole);
  view.querySelector('#f').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('/users', { method: 'POST', body: teamBody(e.target) });
      toast('Pessoa adicionada');
      screens.equipe();
    } catch (err) {
      toast(err.message);
    }
  };
  view.querySelectorAll('[data-edit]').forEach((b) => {
    const form = view.querySelector(`[data-form="${b.dataset.edit}"]`);
    b.onclick = () => {
      form.hidden = !form.hidden;
    };
    form.querySelector('[data-cancel]').onclick = () => {
      form.hidden = true;
    };
    form.onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api(`/users/${b.dataset.edit}`, { method: 'PATCH', body: teamBody(form) });
        toast('Salvo');
        screens.equipe();
      } catch (err) {
        toast(err.message);
      }
    };
  });
  view.querySelectorAll('[data-toggle]').forEach((b) => {
    b.onclick = async () => {
      const off = b.dataset.active === 'true';
      if (off && !(await ask(`Desativar ${b.textContent.replace(/^Desativar /, '')}? A pessoa não consegue mais entrar no painel nem usar o robô.`, { danger: true }))) return;
      await api(`/users/${b.dataset.toggle}`, { method: 'PATCH', body: { active: !off } });
      toast(off ? 'Desativado' : 'Ativado');
      screens.equipe();
    };
  });
  if (apoio) wireApoio();
  // Empresa do motorista: os serviços dele saem na folha dessa empresa no relatório do dia.
  view.querySelectorAll('[data-firm]').forEach((sel) => {
    sel.onchange = async () => {
      try {
        await api(`/users/${sel.dataset.firm}`, { method: 'PATCH', body: { firm: sel.value } });
        toast(`Agora é da ${sel.selectedOptions[0].textContent}`);
      } catch (err) {
        toast(err.message);
      }
    };
  });
};

// Quem ajuda o Jay: recebe no WhatsApp os pedidos de ajuda quando o Jay não consegue resolver.
function apoioCard(apoio, users) {
  const falha =
    apoio.falha === 'janela'
      ? `⚠️ A Meta não entregou a última mensagem para ${esc(apoio.name || '')}. Peça para ela mandar um "oi" para o Jay e teste de novo.`
      : apoio.falha
        ? `⚠️ A Meta não entregou a última mensagem: ${esc(apoio.falha)}`
        : '';
  return `<div class="card" id="apoio">
    <h2>🆘 Quem ajuda o Jay</h2>
    <p class="sub">Quando o Jay não consegue resolver, ele manda o pedido para essa pessoa no WhatsApp e cobra a cada 2 minutos até ela mandar <strong>resolvido</strong>.</p>
    <select id="apoio-pick"><option value="">Ninguém</option>${users
      .filter((u) => u.active)
      .map((u) => `<option value="${u.id}"${u.id === apoio.user_id ? ' selected' : ''}>${esc(u.name)} · ${phoneFmt(u.phone)}</option>`)
      .join('')}</select>
    ${apoio.missing ? `<p class="sub">O número ${phoneFmt(apoio.phone)} (do Render) não está na Equipe.</p>` : ''}
    <div class="actions"><button class="secondary" id="apoio-teste"${apoio.user_id ? '' : ' disabled'}>Mandar mensagem de teste</button></div>
    <p class="sub" id="apoio-msg">${falha}</p>
  </div>`;
}
function wireApoio() {
  const pick = view.querySelector('#apoio-pick');
  const msg = view.querySelector('#apoio-msg');
  const btn = view.querySelector('#apoio-teste');
  pick.onchange = async () => {
    try {
      const r = await api('/ajuda/apoio', { method: 'PUT', body: { user_id: pick.value || null } });
      btn.disabled = !r.user_id;
      msg.textContent = '';
      toast(r.name ? `${r.name} vai receber os pedidos de ajuda` : 'Ninguém recebe os pedidos de ajuda');
    } catch (err) {
      toast(err.message);
    }
  };
  btn.onclick = async () => {
    btn.disabled = true;
    msg.textContent = 'Mandando…';
    try {
      const r = await api('/ajuda/teste', { method: 'POST' });
      if (!r.ok) {
        msg.textContent = `⚠️ Não consegui mandar: ${r.error}`;
        return;
      }
      msg.textContent = `Mandei para ${r.name}. Conferindo se a Meta entregou…`;
      // A Meta avisa a falha de entrega alguns segundos depois.
      await new Promise((ok) => setTimeout(ok, 8000));
      const a = await api('/ajuda/apoio');
      msg.textContent =
        a.falha === 'janela'
          ? `⚠️ A Meta não entregou. ${r.name} precisa mandar um "oi" para o Jay primeiro (o número de teste só fala com quem escreveu nas últimas 24 h). Depois teste de novo.`
          : a.falha
            ? `⚠️ A Meta não entregou: ${a.falha}`
            : `✅ Mandei para ${r.name}. Pergunte se chegou "Teste do pedido de ajuda".`;
    } catch (err) {
      msg.textContent = `⚠️ ${err.message}`;
    } finally {
      btn.disabled = false;
    }
  };
}

// O Jay é homem: usa uma voz masculina em português do aparelho, se tiver (senão fica a padrão).
const MALE_VOICES = /felipe|daniel|antonio|ant[oô]nio|ricardo|fabio|f[aá]bio|donato|julio|j[uú]lio|humberto|nicolau|valerio|val[eé]rio|male|masculin/i;
function maleVoice() {
  const pt = (speechSynthesis.getVoices?.() || []).filter((v) => /^pt/i.test(v.lang));
  return pt.find((v) => /pt[-_]BR/i.test(v.lang) && MALE_VOICES.test(`${v.name} ${v.voiceURI}`)) || pt.find((v) => MALE_VOICES.test(`${v.name} ${v.voiceURI}`)) || null;
}

function firmOptions(selected) {
  const firms = state.firms?.length ? state.firms : [{ id: 'jj', name: 'Towing J&J LLC' }, { id: 'vip', name: 'Towing VIP LLC' }];
  return firms.map((f) => `<option value="${f.id}"${f.id === (selected || 'jj') ? ' selected' : ''}>${esc(f.name)}</option>`).join('');
}

screens.robo = async () => {
  // Só o ADM testa o robô (pedido do Caningado em 19/10).
  if (state.me.role !== 'dono') {
    location.hash = '#/mais';
    return;
  }
  setScreen('Testar o Jay', { tab: 'mais', back: '#/mais' });
  view.innerHTML = `
    <div class="jay-foto"><img src="/jay.png" alt="Jay" width="72" height="72"><button type="button" class="btn" id="foto-jay">Usar esta foto no WhatsApp do Jay</button></div>
    <p class="sub">Funciona igual ao WhatsApp, usando o seu número. Comece com <strong>ajuda</strong> ou <strong>novo</strong>.</p>
    <div class="chat" id="chat"></div>
    <form class="chat-input" id="f"><input name="text" autocomplete="off" placeholder="Mensagem"><button>Enviar</button>${has('voz') && (await voiceEnabled()) ? `<button type="button" class="mic chat-mic" id="mic" aria-label="Mandar áudio">${MIC_SVG}</button>` : ''}</form>`;
  view.querySelector('#foto-jay').onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = 'Trocando a foto…';
    try {
      await api('/whatsapp/foto-jay', { method: 'POST' });
      btn.textContent = '✅ Foto trocada! Pode levar alguns minutos para aparecer.';
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Tentar de novo';
      toast(err.message);
    }
  };
  const chat = view.querySelector('#chat');
  const add = (text, who) => {
    const div = document.createElement('div');
    div.className = `bubble ${who}`;
    div.textContent = text;
    chat.appendChild(div);
    div.scrollIntoView({ block: 'end' });
  };
  view.querySelector('#f').onsubmit = async (e) => {
    e.preventDefault();
    const text = e.target.text.value.trim();
    if (!text) return;
    e.target.text.value = '';
    add(text, 'me');
    try {
      const { replies } = await api('/bot/simulate', { method: 'POST', body: { text } });
      replies.forEach((r) => add(r.replace(/\*/g, ''), 'bot'));
    } catch (err) {
      add(err.message, 'bot');
    }
  };
  // Áudio: segure o microfone e fale, como a mensagem de voz do WhatsApp.
  const mic = view.querySelector('#mic');
  if (mic) {
    const input = view.querySelector('#f').text;
    const hint = input.placeholder;
    // "Ouvindo…" fica no campo de texto; aviso de erro vira balão do robô.
    const setStatus = (text) => {
      const working = /^(🔴|Entendendo)/.test(text);
      input.placeholder = working ? text : hint;
      if (text && !working) add(text, 'bot');
    };
    wireMic(mic, setStatus, async (audio) => {
      add('🎤 (áudio)', 'me');
      const { replies, voz } = await api('/bot/simulate/audio', { method: 'POST', raw: audio, type: audio.type });
      replies.forEach((r) => add(r.replace(/\*/g, ''), 'bot'));
      // Resposta em áudio, como o robô faz no WhatsApp quando a pessoa manda áudio.
      if (voz) {
        const player = document.createElement('audio');
        player.className = 'bubble bot';
        player.controls = true;
        player.src = `data:audio/wav;base64,${voz}`;
        chat.appendChild(player);
        player.scrollIntoView({ block: 'end' });
        player.play().catch(() => {});
      }
    }, 60000);
  }
};

screens.sair = async () => {
  await api('/logout', { method: 'POST' });
  state.me = null;
  location.hash = '#/login';
};

// ---------- fotos da volta no carro ----------
const ANGLES = ['frente', 'lateral_esquerda', 'traseira', 'lateral_direita'];
const ANGLE_LABEL = {
  frente: 'Frente',
  lateral_esquerda: 'Lateral esquerda (motorista)',
  traseira: 'Traseira',
  lateral_direita: 'Lateral direita (passageiro)',
  detalhe: 'Detalhe / dano',
};

// Desenho do carro em cada ângulo, para encaixar o carro na foto.
// Estilo do desenho: 'guia' (contorno fino + moldura tracejada, escolhido pelo Caningado),
// 'silhueta', 'linha' (contorno fino) ou 'cantos' (cantos + sombra).
const FRAME_STYLE = 'guia';
const CAR_SIDE = {
  viewBox: '0 0 640 240',
  body: 'M48 176 L44 150 Q44 130 60 124 L78 112 Q130 100 190 96 Q240 60 300 50 Q360 42 410 48 Q450 56 492 92 Q560 100 592 114 Q606 122 606 142 L602 168 Q600 178 588 180 L546 180 A46 46 0 0 0 454 180 L196 180 A46 46 0 0 0 104 180 L60 180 Q50 180 48 176 Z',
  details: 'M206 96 Q250 64 300 56 L312 56 L318 96 Z M330 96 L326 56 L400 54 Q440 60 474 94 Z M322 98 L318 176 M206 100 Q200 140 210 176 M470 98 Q478 140 470 172 M474 96 L486 86 L500 90 L494 100 Z M572 112 Q594 118 600 130 L578 128 Q566 122 572 112 Z M50 132 Q62 124 84 122 L80 134 Q62 136 50 136 Z M190 104 L480 102 M280 114 h18 M420 114 h18 M196 168 L454 168',
  wheels: [[150, 182], [500, 182]],
  ground: 222,
};
const CAR_FRONT = {
  viewBox: '0 0 400 300',
  body: 'M70 262 L64 206 Q62 180 76 168 L90 160 L118 92 Q126 74 148 72 L252 72 Q274 74 282 92 L310 160 L324 168 Q338 180 336 206 L330 262 Z',
  details: 'M104 128 Q84 124 80 136 Q82 146 100 146 Z M296 128 Q316 124 320 136 Q318 146 300 146 Z M122 156 L146 92 Q150 84 162 84 L238 84 Q250 84 254 92 L278 156 Q200 148 122 156 Z M92 166 Q200 150 308 166 M80 184 Q100 174 140 180 L132 198 Q100 200 82 196 Z M320 184 Q300 174 260 180 L268 198 Q300 200 318 196 Z M152 186 Q200 180 248 186 L242 210 Q200 216 158 210 Z M120 236 Q200 246 280 236 M88 224 h24 M288 224 h24 M176 222 h48 v14 h-48 Z',
  tires: [[72, 258], [284, 258]],
  ground: 290,
};
const CAR_REAR = {
  viewBox: '0 0 400 300',
  body: CAR_FRONT.body,
  details: 'M104 128 Q84 124 80 136 Q82 146 100 146 Z M296 128 Q316 124 320 136 Q318 146 300 146 Z M128 152 L150 96 Q154 88 166 88 L234 88 Q246 88 250 96 L272 152 Q200 144 128 152 Z M86 166 Q200 154 314 166 M72 176 Q116 168 162 176 L156 196 Q112 198 74 192 Z M328 176 Q284 168 238 176 L244 196 Q288 198 326 192 Z M162 178 L238 178 M170 204 h60 v24 h-60 Z M76 238 Q200 250 324 238 M290 252 h20',
  tires: [[72, 258], [284, 258]],
  ground: 290,
};
// estilo: 'guia' | 'silhueta' | 'cantos' | 'linha'
function drawCar(car, style, mirror = false) {
  const [, , w, h] = car.viewBox.split(' ').map(Number);
  const r = car.wheels && w > 600 ? 38 : 34;
  const wheels = (car.wheels || []).map(([x, y]) => `<circle cx="${x}" cy="${y}" r="${r}"/><circle cx="${x}" cy="${y}" r="${Math.round(r * 0.62)}"/>`).join('');
  const tires = (car.tires || []).map(([x, y]) => `<rect x="${x}" y="${y}" width="44" height="28" rx="8"/>`).join('');
  const flip = mirror ? ` transform="translate(${w} 0) scale(-1 1)"` : '';
  if (style === 'cantos') {
    const m = 14, L = 46;
    const c = `M${m} ${m + L} V${m} H${m + L} M${w - m - L} ${m} H${w - m} V${m + L} M${w - m} ${h - m - L} V${h - m} H${w - m - L} M${m + L} ${h - m} H${m} V${h - m - L}`;
    return `<svg viewBox="${car.viewBox}" class="g cantos"><path class="corner" d="${c}"/><g${flip} class="ghost"><path d="${car.body}"/>${wheels}${tires}</g><path class="groundline" d="M${w * 0.12} ${car.ground} H${w * 0.88}"/></svg>`;
  }
  // Moldura tracejada em volta do carro: o carro inteiro tem que caber dentro dela.
  const top = w > 600 ? 26 : 50;
  const box = style === 'guia' ? `<rect class="box" x="18" y="${top}" width="${w - 36}" height="${car.ground - top}"/>` : '';
  return `<svg viewBox="${car.viewBox}" class="g ${style}">${box}<g${flip}><path class="body" d="${car.body}"/><path class="det" d="${car.details}"/>${wheels}${tires}</g></svg>`;
}
// Desenhos do modelo que o Caningado mandou (linha branca, fundo transparente).
const CAR_IMAGES = {
  frente: ['frente', false],
  traseira: ['traseira', false],
  lateral_esquerda: ['lateral', false],
  lateral_direita: ['lateral', true],
};
function carDrawing(angle, style = FRAME_STYLE) {
  const img = CAR_IMAGES[angle];
  if (img && style !== 'cantos' && style !== 'silhueta') {
    return `<div class="g carro ${style}${img[1] ? ' espelho' : ''}"><img src="/carros/carro-${img[0]}.png" alt=""></div>`;
  }
  if (angle === 'frente') return drawCar(CAR_FRONT, style);
  if (angle === 'traseira') return drawCar(CAR_REAR, style);
  if (angle === 'lateral_esquerda') return drawCar(CAR_SIDE, style);
  if (angle === 'lateral_direita') return drawCar(CAR_SIDE, style, true);
  return '';
}

// Fotos do serviço separadas em antes/depois, com os 4 ângulos (e o que está faltando).
function photoGroups(photos) {
  if (!photos.length) return '<p class="sub">Nenhuma foto. São opcionais.</p>';
  const figure = (p, label) =>
    `<figure><button type="button" class="photo-open" data-view="${p.id}" data-label="${esc(label)}"><img src="${p.url}" loading="lazy" alt="${esc(label)}"></button><figcaption>${esc(label)}</figcaption></figure>`;
  const groups = ['antes', 'depois'].map((kind) => {
    const list = photos.filter((p) => p.kind === kind);
    if (!list.length) return '';
    const slots = ANGLES.map((angle) => {
      const p = list.filter((x) => x.angle === angle).at(-1);
      return p
        ? figure(p, ANGLE_LABEL[angle].split(' (')[0])
        : `<figure class="missing"><button class="link" data-retake="${kind}:${angle}">${carDrawing(angle, 'linha')}<span>+ ${ANGLE_LABEL[angle].split(' (')[0]}</span></button></figure>`;
    });
    const extras = list.filter((p) => !ANGLES.includes(p.angle) || list.filter((x) => x.angle === p.angle).at(-1) !== p);
    return `<h3>${PHOTO_KINDS[kind]}</h3><div class="photos">${slots.join('')}${extras.map((p) => figure(p, ANGLE_LABEL[p.angle] || 'Outra')).join('')}</div>`;
  });
  const others = photos.filter((p) => p.kind !== 'antes' && p.kind !== 'depois');
  if (others.length) groups.push(`<h3>Outras</h3><div class="photos">${others.map((p) => figure(p, PHOTO_KINDS[p.kind])).join('')}</div>`);
  return groups.join('');
}

// Foto em tela cheia, com Apagar (motorista só até entregar; o dono sempre). Devolve true se apagou.
function viewPhoto(photo, label, canDelete) {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'photo-view';
    back.innerHTML = `<div class="photo-view-top"><span>${esc(label || '')}</span><button type="button" class="secondary" data-act="close">✕ Fechar</button></div>
      <img src="${photo.url}" alt="${esc(label || '')}">
      ${canDelete ? '<div class="photo-view-actions"><button type="button" class="danger" data-act="delete">🗑 Apagar foto</button></div>' : ''}`;
    const done = (value) => {
      back.remove();
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };
    const onKey = (e) => e.key === 'Escape' && done(false);
    back.querySelector('[data-act="close"]').onclick = () => done(false);
    back.onclick = (e) => e.target === back && done(false);
    const del = back.querySelector('[data-act="delete"]');
    if (del) {
      del.onclick = async () => {
        if (!(await ask('Apagar esta foto? Não dá para desfazer.', { ok: 'Apagar', cancel: 'Voltar', danger: true }))) return;
        try {
          await api(`/photos/${photo.id}`, { method: 'DELETE' });
          toast('Foto apagada.');
          done(true);
        } catch (err) {
          toast(err.message);
        }
      };
    }
    document.addEventListener('keydown', onKey);
    document.body.append(back);
  });
}

// Câmera guiada: mostra o desenho do carro em cada ângulo e salva cada foto na hora.
// Sem câmera ao vivo (permissão negada), usa a câmera normal do celular, um ângulo por vez.
// Devolve quantas fotos foram salvas.
async function guidedPhotos(serviceId, kind, doneAngles = [], onlyAngle = null) {
  const queue = onlyAngle ? [onlyAngle] : [...ANGLES.filter((a) => !doneAngles.includes(a)), ...(ANGLES.every((a) => doneAngles.includes(a)) ? ['detalhe'] : [])];
  let index = 0;
  let saved = 0;
  const upload = async (blob, angle) => {
    await api(`/services/${serviceId}/photos?kind=${kind}&angle=${angle}`, { method: 'POST', raw: blob, type: 'image/jpeg' });
    saved++;
  };

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } } });
  } catch {
    // Plano B: câmera do sistema, avisando qual lado fotografar.
    for (const angle of queue) {
      if (!confirm(`Foto de ${PHOTO_KINDS[kind].toLowerCase()}: ${ANGLE_LABEL[angle]}.\nAbrir a câmera?`)) break;
      const file = await pickPhoto();
      if (!file) break;
      try {
        await upload(await shrinkImage(file), angle);
      } catch (err) {
        toast(err.message);
        break;
      }
    }
    if (saved) toast(`${saved} foto${saved === 1 ? '' : 's'} salva${saved === 1 ? '' : 's'}`);
    return saved;
  }

  const overlay = document.createElement('div');
  overlay.className = 'scanner camera';
  overlay.innerHTML = `
    <div class="scanner-view">
      <video playsinline muted autoplay></video>
      <div class="car-frame"></div>
      <div class="turn-hint" hidden><span class="turn-phone" aria-hidden="true">📱</span><strong></strong></div>
      <p class="camera-step"></p>
      <button class="scanner-close" data-act="close" aria-label="Fechar">✕</button>
    </div>
    <div class="camera-side">
      <p class="scanner-tip">Encaixe o carro no desenho.</p>
      <p class="scanner-status"></p>
      <div class="scanner-actions">
        <button class="secondary" data-act="skip">Pular</button>
        <button class="shutter" data-act="shoot" aria-label="Tirar foto"></button>
        <button class="secondary" data-act="close2">Terminar</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const video = overlay.querySelector('video');
  const frame = overlay.querySelector('.car-frame');
  const stepEl = overlay.querySelector('.camera-step');
  const status = overlay.querySelector('.scanner-status');
  const button = (act) => overlay.querySelector(`[data-act="${act}"]`);
  video.srcObject = stream;
  await video.play().catch(() => {});

  let finish;
  const result = new Promise((resolve) => (finish = resolve));
  history.pushState({ scanner: true }, '');
  window.addEventListener('popstate', finish);

  // Laterais com o celular deitado; frente e traseira em pé. No Android a tela gira
  // sozinha (precisa de tela cheia); no iPhone aparece o aviso e o botão espera.
  const turnHint = overlay.querySelector('.turn-hint');
  const landscapeQuery = matchMedia('(orientation: landscape)');
  const wanted = () => {
    const angle = queue[index];
    return angle?.startsWith('lateral') ? 'landscape' : angle === 'frente' || angle === 'traseira' ? 'portrait' : null;
  };
  let fullscreen = false;
  const lockOrientation = async () => {
    const want = wanted();
    try {
      if (!want) return screen.orientation?.unlock?.();
      if (!document.fullscreenElement && overlay.requestFullscreen) {
        await overlay.requestFullscreen({ navigationUI: 'hide' });
        fullscreen = true;
      }
      await screen.orientation?.lock?.(want);
    } catch {
      // Sem suporte (iPhone): o aviso na tela pede para virar o celular.
    }
  };
  const checkTurn = () => {
    const want = wanted();
    const wrong = want && (want === 'landscape') !== landscapeQuery.matches;
    turnHint.hidden = !wrong;
    turnHint.className = `turn-hint ${want === 'landscape' ? 'to-landscape' : 'to-portrait'}`;
    turnHint.querySelector('strong').textContent = want === 'landscape' ? 'Deite o celular para fotografar a lateral' : 'Coloque o celular em pé para fotografar';
    button('shoot').classList.toggle('waiting', Boolean(wrong));
  };
  landscapeQuery.addEventListener('change', checkTurn);

  const show = () => {
    if (index >= queue.length) {
      // Terminou a volta: pode continuar tirando fotos de detalhe.
      queue.push('detalhe');
    }
    const angle = queue[index];
    frame.innerHTML = carDrawing(angle);
    stepEl.textContent = angle === 'detalhe' ? `${PHOTO_KINDS[kind]} · Detalhe / dano (opcional)` : `${PHOTO_KINDS[kind]} · ${ANGLES.indexOf(angle) + 1}/4 · ${ANGLE_LABEL[angle]}`;
    button('skip').hidden = angle === 'detalhe';
    lockOrientation().then(checkTurn);
    checkTurn();
  };
  show();

  button('close').onclick = () => finish();
  button('close2').onclick = () => finish();
  button('skip').onclick = () => {
    index++;
    status.textContent = '';
    show();
  };
  button('shoot').onclick = async () => {
    if (!video.videoWidth || button('shoot').disabled) return;
    if (!turnHint.hidden) return toast(turnHint.textContent.trim().replace('📱', '').trim());
    const angle = queue[index];
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 1600 / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
    overlay.classList.add('flash');
    setTimeout(() => overlay.classList.remove('flash'), 150);
    button('shoot').disabled = true;
    status.textContent = 'Salvando…';
    try {
      await upload(blob, angle);
      status.textContent = `✅ ${ANGLE_LABEL[angle]} salva`;
      if (onlyAngle) return finish();
      index++;
      show();
    } catch (err) {
      status.textContent = err.message;
    } finally {
      button('shoot').disabled = false;
    }
  };

  await result;
  landscapeQuery.removeEventListener('change', checkTurn);
  try {
    screen.orientation?.unlock?.();
    if (fullscreen && document.fullscreenElement) await document.exitFullscreen();
  } catch {}
  window.removeEventListener('popstate', finish);
  if (history.state?.scanner) history.back();
  stream.getTracks().forEach((t) => t.stop());
  overlay.remove();
  if (saved) toast(`${saved} foto${saved === 1 ? '' : 's'} salva${saved === 1 ? '' : 's'}`);
  return saved;
}

// Abre o gate pass dentro do app. O app instalado no iPhone não leva o login para
// outra aba, e o Chrome do Android baixa o PDF em vez de mostrar; aqui o PDF é
// desenhado página por página com o pdf.js, e a foto aparece direto.
let pdfjsPromise;
function pdfjs() {
  pdfjsPromise ??= import('/vendor/pdf.mjs').then((lib) => {
    lib.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.mjs';
    return lib;
  });
  pdfjsPromise.catch(() => (pdfjsPromise = null));
  return pdfjsPromise;
}

async function openDoc(doc) {
  if (!doc) return;
  const name = doc.name || 'gate pass';
  const overlay = document.createElement('div');
  overlay.className = 'viewer';
  overlay.innerHTML = `
    <div class="viewer-bar"><strong>${esc(name)}</strong><button class="secondary" data-act="share" disabled>Compartilhar</button><button class="secondary" data-act="close" aria-label="Voltar">← Voltar</button></div>
    <div class="viewer-body"><p class="sub">Abrindo…</p></div>`;
  document.body.appendChild(overlay);
  const body = overlay.querySelector('.viewer-body');
  let blobUrl;
  const close = () => {
    window.removeEventListener('popstate', close);
    document.removeEventListener('keydown', onKey);
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    overlay.remove();
  };
  const onKey = (e) => e.key === 'Escape' && overlay.querySelector('[data-act=close]').click();
  history.pushState({ viewer: true }, '');
  window.addEventListener('popstate', close);
  document.addEventListener('keydown', onKey);
  overlay.querySelector('[data-act=close]').onclick = () => (history.state?.viewer ? history.back() : close());

  try {
    const res = await net(doc.url);
    if (!res.ok) throw new Error(res.status === 404 ? 'Arquivo não encontrado.' : 'Não consegui abrir o arquivo.');
    const blob = await res.blob();
    if (!overlay.isConnected) return;
    const file = new File([blob], name, { type: doc.mime });
    blobUrl = URL.createObjectURL(blob);
    const share = overlay.querySelector('[data-act=share]');
    share.disabled = false;
    share.onclick = async () => {
      if (navigator.canShare?.({ files: [file] })) return navigator.share({ files: [file], title: name }).catch(() => {});
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = name;
      a.click();
    };
    if (doc.mime !== 'application/pdf') {
      body.innerHTML = '';
      const img = new Image();
      img.alt = name;
      img.src = blobUrl;
      body.appendChild(img);
      return;
    }
    const lib = await pdfjs();
    const pdf = await lib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
    body.innerHTML = '';
    const width = body.clientWidth - 16;
    for (let n = 1; n <= pdf.numPages && overlay.isConnected; n++) {
      const page = await pdf.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(width / base.width, 3);
      const viewport = page.getViewport({ scale: scale * (window.devicePixelRatio || 1) });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = `${Math.floor(base.width * scale)}px`;
      body.appendChild(canvas);
      await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport }).promise;
    }
  } catch (err) {
    if (overlay.isConnected) body.innerHTML = `<p class="warn">${esc(err.message || 'Não consegui abrir o arquivo.')}</p>`;
  }
}

// Leitor de código de barras: usa o do celular (Android/Chrome) e, quando não
// existe (iPhone), carrega um leitor próprio servido pelo nosso servidor.
const VIN_FORMATS = ['code_39', 'code_128', 'data_matrix', 'qr_code', 'pdf417'];
let detectorPromise;
function barcodeDetector() {
  detectorPromise ??= (async () => {
    if ('BarcodeDetector' in window) {
      const supported = await BarcodeDetector.getSupportedFormats().catch(() => []);
      if (VIN_FORMATS.every((f) => supported.includes(f))) return new BarcodeDetector({ formats: VIN_FORMATS });
    }
    return zxingDetector();
  })();
  detectorPromise.catch(() => (detectorPromise = null));
  return detectorPromise;
}
let zxingPromise;
function zxingDetector() {
  zxingPromise ??= (async () => {
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = '/vendor/barcode-detector.js';
      script.onload = resolve;
      script.onerror = () => reject(new Error('Não consegui carregar o leitor de código de barras.'));
      document.head.appendChild(script);
    });
    const { BarcodeDetector: Detector, prepareZXingModule } = window.BarcodeDetectionAPI;
    prepareZXingModule({ overrides: { locateFile: (file) => `/vendor/${file}` } });
    return new Detector({ formats: VIN_FORMATS });
  })();
  zxingPromise.catch(() => (zxingPromise = null));
  return zxingPromise;
}

// Etiquetas às vezes trazem um "I" na frente do VIN (Code 39 de importados).
function vinFromCode(text) {
  const clean = String(text || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (clean.length === 18 && clean.startsWith('I')) return clean.slice(1);
  return clean.match(/[A-HJ-NPR-Z0-9]{17}/)?.[0] || null;
}

// Câmera lendo o código de barras do VIN (porta do motorista ou para-brisa).
// Mostra uma moldura: o leitor procura primeiro só dentro dela (em resolução cheia),
// e de vez em quando na imagem toda. "Tirar foto" manda a imagem para o servidor ler.
async function scanBarcode() {
  let stream;
  const overlay = document.createElement('div');
  overlay.className = 'scanner';
  overlay.innerHTML = `
    <div class="scanner-view">
      <video playsinline muted></video>
      <div class="scanner-mask"><div class="scanner-box"><i></i><i></i><i></i><i></i><div class="scanner-line"></div></div></div>
      <button class="scanner-close" data-act="close" aria-label="Fechar">✕</button>
    </div>
    <p class="scanner-tip">Aponte para o VIN (código de barras <strong>dentro do retângulo</strong> ou o número escrito), de perto e sem reflexo. Eu tento ler os dois sozinho; se demorar, toque em <strong>📸 Ler as letras</strong>.</p>
    <p class="scanner-status">Abrindo a câmera…</p>
    <div class="scanner-actions">
      <button class="secondary" data-act="torch" hidden>🔦 Lanterna</button>
      <button class="secondary" data-act="photo">📸 Ler as letras</button>
      <button class="secondary" data-act="cancel">Cancelar</button>
    </div>`;
  document.body.appendChild(overlay);
  const video = overlay.querySelector('video');
  const box = overlay.querySelector('.scanner-box');
  const status = overlay.querySelector('.scanner-status');
  const button = (act) => overlay.querySelector(`[data-act="${act}"]`);
  const canvas = document.createElement('canvas');
  let done = false;
  let finish;
  const result = new Promise((resolve) => (finish = (vin) => { done = true; resolve(vin); }));
  button('cancel').onclick = () => finish(null);
  button('close').onclick = () => finish(null);
  // O "voltar" do celular (gesto ou botão) também fecha a câmera.
  history.pushState({ scanner: true }, '');
  const onBack = () => finish(null);
  window.addEventListener('popstate', onBack);

  // Parte da imagem da câmera que aparece dentro da moldura (o vídeo usa object-fit: cover).
  const boxCrop = () => {
    const vw = video.videoWidth, vh = video.videoHeight;
    const v = video.getBoundingClientRect(), b = box.getBoundingClientRect();
    const scale = Math.max(v.width / vw, v.height / vh);
    const offX = (v.width - vw * scale) / 2, offY = (v.height - vh * scale) / 2;
    const x = Math.max(0, (b.left - v.left - offX) / scale), y = Math.max(0, (b.top - v.top - offY) / scale);
    return { x, y, w: Math.min(vw - x, b.width / scale), h: Math.min(vh - y, b.height / scale) };
  };
  // Faixa da largura toda do vídeo em volta da moldura: o código comprido não fica cortado
  // quando a tela em pé mostra só o meio da imagem da câmera.
  const band = () => {
    const b = boxCrop(), vh = video.videoHeight;
    const h = Math.min(vh, b.h * 2.2);
    return { x: 0, y: Math.max(0, Math.min(vh - h, b.y + b.h / 2 - h / 2)), w: video.videoWidth, h };
  };
  const ctx2d = canvas.getContext('2d', { willReadFrequently: true });
  // contrast: deixa a imagem só preto e branco (ajuda com etiqueta gasta, reflexo ou pouca luz).
  const frame = (crop, { contrast = false } = {}) => {
    const c = crop || { x: 0, y: 0, w: video.videoWidth, h: video.videoHeight };
    canvas.width = Math.round(c.w);
    canvas.height = Math.round(c.h);
    ctx2d.drawImage(video, c.x, c.y, c.w, c.h, 0, 0, canvas.width, canvas.height);
    if (contrast) {
      const img = ctx2d.getImageData(0, 0, canvas.width, canvas.height);
      const d = img.data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11;
      const mid = sum / (d.length / 4);
      for (let i = 0; i < d.length; i += 4) d[i] = d[i + 1] = d[i + 2] = d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11 < mid ? 0 : 255;
      ctx2d.putImageData(img, 0, 0);
    }
    return canvas;
  };
  // Foto em resolução cheia (bem maior que o vídeo em muitos celulares), reduzida para no máximo 2400 px.
  const stillPhoto = async ({ max = 2400, quality = 0.92, quiet = false } = {}) => {
    let source = null;
    try {
      if ('ImageCapture' in window) {
        source = await createImageBitmap(await new ImageCapture(stream.getVideoTracks()[0]).takePhoto(quiet ? { fillLightMode: 'off' } : undefined));
      }
    } catch {}
    if (!source || source.width < video.videoWidth) return new Promise((r) => frame().toBlob(r, 'image/jpeg', quality));
    const k = Math.min(1, max / Math.max(source.width, source.height));
    const out = document.createElement('canvas');
    out.width = Math.round(source.width * k);
    out.height = Math.round(source.height * k);
    out.getContext('2d').drawImage(source, 0, 0, out.width, out.height);
    return new Promise((r) => out.toBlob(r, 'image/jpeg', quality));
  };

  button('photo').onclick = async () => {
    if (!video.videoWidth) return;
    status.textContent = 'Lendo o VIN da foto… (pode levar alguns segundos)';
    const image = await stillPhoto();
    try {
      const read = await api('/vin/read', { method: 'POST', raw: image, type: 'image/jpeg' });
      finish(read.vin);
    } catch (err) {
      status.textContent = err.message;
    }
  };

  try {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
      });
    } catch {
      toast('Não consegui abrir a câmera. Libere a câmera para este site nas configurações do celular, ou use "Ler da foto".');
      return null;
    }
    video.srcObject = stream;
    await video.play();
    const track = stream.getVideoTracks()[0];
    const caps = track.getCapabilities?.() || {};
    if (caps.focusMode?.includes('continuous')) track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
    if (caps.torch) {
      let torch = false;
      button('torch').hidden = false;
      button('torch').onclick = () => {
        torch = !torch;
        track.applyConstraints({ advanced: [{ torch }] }).catch(() => {});
      };
    }

    // Ao mesmo tempo, tira fotos sozinho (com foco e resolução de foto) e manda para o
    // servidor ler o código de barras. Sem código de barras, a partir da 3ª foto manda
    // também para ler as letras (como o botão 📸), no máximo 3 vezes. Para depois de umas 10 fotos.
    (async () => {
      await new Promise((r) => setTimeout(r, 2000));
      let letters = 0;
      for (let n = 0; n < 10 && !done; n++) {
        const image = await stillPhoto({ max: 2000, quality: 0.85, quiet: true });
        if (done || !image) break;
        const full = n >= 2 && n % 2 === 0 && letters < 3;
        if (full) {
          letters++;
          if (/^(Procurando|Não achei)/.test(status.textContent)) status.textContent = 'Lendo as letras do VIN…';
        }
        const read = await api(full ? '/vin/read' : '/vin/read?so=codigo', { method: 'POST', raw: image, type: 'image/jpeg' }).catch(() => null);
        if (read?.vin && !done) return finish(read.vin);
        if (full && !done && status.textContent === 'Lendo as letras do VIN…') status.textContent = 'Ainda não consegui. Chegue mais perto do VIN, sem reflexo.';
        await new Promise((r) => setTimeout(r, 1500));
      }
    })();
    let detector;
    try {
      status.textContent = 'Preparando o leitor…';
      detector = await barcodeDetector();
    } catch (err) {
      status.textContent = 'Leitor indisponível. Use 📸 Ler as letras.';
      return await result;
    }
    // Leitor reserva (o nosso) quando o principal é o do celular.
    let backup = null;
    if ('BarcodeDetector' in window && detector instanceof window.BarcodeDetector) {
      zxingDetector().then((d) => (backup = d)).catch(() => {});
    }
    status.textContent = 'Procurando o código de barras…';
    const started = Date.now();
    (async () => {
      for (let i = 0; !done; i++) {
        // Sem código de barras depois de uns segundos: lembra do botão que lê as letras.
        if (Date.now() - started > 6000 && /^Procurando/.test(status.textContent)) status.textContent = 'Não achei código de barras. Para ler o VIN escrito, toque em 📸 Ler as letras.';
        // Revezando: moldura, faixa larga, imagem toda, e as mesmas em preto e branco.
        // No Android, o leitor do celular e o nosso se revezam (um lê o que o outro perde).
        const step = i % 6;
        const image = frame([boxCrop, band, () => null][step % 3](), { contrast: step >= 3 });
        const reader = backup && i % 2 ? backup : detector;
        const codes = await reader.detect(image).catch(() => []);
        for (const code of codes) {
          const vin = vinFromCode(code.rawValue);
          if (vin) return finish(vin);
          status.textContent = `Achei o código "${String(code.rawValue || '').slice(0, 24)}", que não é o VIN. Coloque só o código do VIN (17 letras e números) dentro do retângulo.`;
        }
        await new Promise((r) => setTimeout(r, 120));
      }
    })();
    return await result;
  } finally {
    done = true;
    window.removeEventListener('popstate', onBack);
    if (history.state?.scanner) history.back();
    stream?.getTracks().forEach((t) => t.stop());
    overlay.remove();
  }
}

// ---------- navegação ----------
async function loadMe() {
  try {
    const me = await api('/me');
    state.me = me.user;
    state.modules = me.modules;
    state.company = me.company;
    state.firms = me.firms;
    state.pricing = me.pricing;
    state.meAt = Date.now();
    renderSide();
    if (has('notificacoes')) syncPush();
  } catch {
    state.me = null;
  }
}

// Confere o perfil de novo (o cargo pode ter mudado). Sem sinal, fica com o que já tem.
async function refreshMe() {
  try {
    const me = await api('/me');
    Object.assign(state, { me: me.user, modules: me.modules, company: me.company, firms: me.firms, pricing: me.pricing, meAt: Date.now() });
    renderSide();
  } catch {}
}

async function route() {
  const [path, query] = location.hash.slice(2).split('?');
  const [name, id] = (path || 'servicos').split('/');
  const params = new URLSearchParams(query || '');
  if (!state.me && name !== 'login') {
    location.hash = '#/login';
    return;
  }
  // O ADM pode mudar o cargo de alguém com o app já aberto: confere o perfil de novo a cada minuto.
  if (name !== 'login' && Date.now() - (state.meAt || 0) > 60000) {
    await refreshMe();
    if (!state.me) return;
  }
  const nav = (state.nav = (state.nav || 0) + 1);
  const screen = screens[name] || screens.servicos;
  state.screen = screens[name] ? name : 'servicos';
  state.voiceService = null;
  try {
    await screen(params, id);
  } catch (err) {
    // Erro de uma tela que já foi trocada por outra (clique rápido) não aparece.
    if (state.me && nav === state.nav) view.innerHTML = `<div class="card empty">${esc(err.message)}</div>`;
  }
  if (nav === state.nav) showFab();
}

// ---------- comandos de voz ----------
// Na tela do serviço: segure o microfone e fale (ou toque uma vez para começar e outra para parar).
// O servidor manda o áudio para o Gemini, que diz qual comando foi, e muda a situação do serviço.
const STAGES = { coletado: '🚚 Carro coletado', entregando: '🏁 Indo entregar' };
const VOICE_LABELS = {
  iniciar_servico: '▶ Serviço começado',
  peguei_o_carro: '🚚 Peguei o carro',
  indo_entregar: '🏁 Indo entregar',
  finalizar_servico: '✅ Serviço entregue',
  cancelar_servico: '✖ Serviço cancelado',
};
let voiceOn = null;
async function voiceEnabled() {
  if (voiceOn === null) voiceOn = Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder) && (await api('/voice-command').then((r) => r.enabled).catch(() => false));
  return voiceOn;
}

// Fala e toca um bip curto (agudo = deu certo, grave = não entendeu). Termina quando acaba de falar.
function voiceFeedback(text, ok) {
  const ctx = novo.audio;
  if (ctx && ctx.state === 'running') {
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = ok ? 990 : 330;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.4, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.26);
  }
  navigator.vibrate?.(ok ? 120 : [80, 80, 80]);
  if (!('speechSynthesis' in window)) return Promise.resolve();
  // Termina quando acaba de falar (para poder escutar a resposta em seguida).
  return new Promise((resolve) => {
    const say = new SpeechSynthesisUtterance(text);
    say.lang = 'pt-BR';
    say.voice = maleVoice();
    const timer = setTimeout(resolve, 2000 + text.length * 90);
    say.onend = say.onerror = () => {
      clearTimeout(timer);
      resolve();
    };
    setTimeout(() => {
      speechSynthesis.cancel();
      speechSynthesis.speak(say);
    }, 300);
  });
}

// Converte a gravação para WAV mono 16 kHz: o Gemini entende WAV sempre, e cada celular grava num formato
// (iPhone em mp4, Android em webm). Se o celular não conseguir converter, manda como gravou.
async function toWav(blob) {
  try {
    const AC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const decoded = await new (window.AudioContext || window.webkitAudioContext)().decodeAudioData(await blob.arrayBuffer());
    const rate = 16000;
    const offline = new AC(1, Math.ceil(decoded.duration * rate), rate);
    const src = offline.createBufferSource();
    src.buffer = decoded;
    src.connect(offline.destination);
    src.start();
    const samples = (await offline.startRendering()).getChannelData(0);
    const out = new DataView(new ArrayBuffer(44 + samples.length * 2));
    const text = (at, str) => [...str].forEach((c, i) => out.setUint8(at + i, c.charCodeAt(0)));
    text(0, 'RIFF');
    out.setUint32(4, 36 + samples.length * 2, true);
    text(8, 'WAVEfmt ');
    out.setUint32(16, 16, true);
    out.setUint16(20, 1, true);
    out.setUint16(22, 1, true);
    out.setUint32(24, rate, true);
    out.setUint32(28, rate * 2, true);
    out.setUint16(32, 2, true);
    out.setUint16(34, 16, true);
    text(36, 'data');
    out.setUint32(40, samples.length * 2, true);
    samples.forEach((v, i) => out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, v)) * 0x7fff, true));
    return new Blob([out], { type: 'audio/wav' });
  } catch {
    return blob;
  }
}

// ---------- assistente de voz: o microfone que fica em todas as telas ----------
// Entende o que a pessoa pede (abrir uma tela, criar serviço, "peguei o carro", lançar despesa,
// pagamento ou milhas do caminhão). Dinheiro e milhas: só preenche a tela, a pessoa confere e confirma.
const MIC_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';
const fab = Object.assign(document.createElement('button'), { type: 'button', className: 'mic fab-mic hidden', innerHTML: MIC_SVG });
fab.setAttribute('aria-label', 'Assistente de voz');
const bubble = Object.assign(document.createElement('div'), { className: 'voice-bubble hidden' });
bubble.setAttribute('role', 'status');
document.body.append(bubble, fab);
let fabMic = null;

// Balão em cima do microfone com o que ele está fazendo ou perguntando.
function bubbleStatus(text) {
  bubble.textContent = text;
  bubble.classList.toggle('hidden', !text);
  clearTimeout(bubbleStatus.timer);
  if (text && !/^(🔴|🎤|Entendendo)/.test(text)) bubbleStatus.timer = setTimeout(() => bubble.classList.add('hidden'), 8000);
}

// Mostra o microfone flutuante (menos no login e na tela que já tem o microfone grande).
async function showFab() {
  const on = Boolean(state.me) && state.screen !== 'login' && has('voz') && (await voiceEnabled());
  const own = Boolean(view.querySelector('#mic'));
  fab.classList.toggle('hidden', !on || own);
  document.body.classList.toggle('has-fab', on && !own);
  if (!on) bubbleStatus('');
  if (on && !fabMic) fabMic = wireMic(fab, bubbleStatus, assistantVoice, 60000, true);
}

// O microfone pode mandar para outra tela já com os campos para preencher.
function go(hash, kind = null, data = null) {
  state.voicePrefill = kind ? { kind, data } : null;
  if (location.hash === hash) route();
  else location.hash = hash;
}
function takePrefill(kind) {
  const p = state.voicePrefill;
  if (!p || p.kind !== kind) return null;
  state.voicePrefill = null;
  return p.data;
}

// Preenche os campos pelo name e avisa cada um (buscas, mostrar/esconder campos).
function fillForm(form, values) {
  for (const [name, value] of Object.entries(values || {})) {
    const input = form?.elements[name];
    if (!input || value == null || value === '') continue;
    input.value = value;
    input.dispatchEvent(new Event(input.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  }
}

const voiceSay = (spoken, shown = spoken, ok = true) => {
  bubbleStatus(shown);
  return voiceFeedback(spoken, ok);
};

async function assistantVoice(audio, setStatus) {
  const form = state.screen === 'novo' ? view.querySelector('#f') : null;
  const q = new URLSearchParams();
  if (state.voiceService) q.set('servico', state.voiceService);
  if (form?.talk?.current) q.set('pergunta', form.talk.current);
  const r = await api(`/voice-command/assistente?${q}`, { method: 'POST', raw: audio, type: audio.type });
  const heard = r.transcricao ? ` (ouvi: "${r.transcricao}")` : '';
  if (r.intencao === 'nao_entendi' || r.intencao === 'pular') {
    // No meio da conversa do serviço novo: pergunta de novo (ou passa para a próxima).
    // (sem await: ele escuta a resposta depois que este áudio termina)
    if (form?.talk?.current) return void askNext(form, { again: r.intencao === 'nao_entendi' });
    setStatus(`${r.mensagem || 'Não entendi, tente de novo.'}${r.intencao === 'nao_entendi' ? heard : ''}`);
    return voiceFeedback(r.mensagem || 'Não entendi, tente de novo', false);
  }
  if (r.intencao === 'abrir_tela') {
    setStatus(`Abrindo ${r.label}`);
    voiceFeedback(r.label, true);
    return go(r.hash);
  }
  if (r.intencao === 'servico_novo') {
    if (form) return talkNewService(form, r.campos);
    setStatus('Abrindo Novo serviço…');
    return go('#/novo', 'novo', r.campos);
  }
  if (r.intencao === 'status_servico') {
    const refresh = () => ['servico', 'servicos'].includes(state.screen) && route();
    if (r.confirmar) {
      voiceFeedback('Confirme o cancelamento', true);
      setStatus('Cancelar o serviço? Confirme na tela.');
      if (!(await ask(`Cancelar o serviço ${numTag(r.service)}`.trim() + '?', { ok: 'Confirmar cancelamento', cancel: 'Não cancelar', danger: true }))) return setStatus('Cancelamento desfeito. Nada mudou.');
      await api('/voice-command/confirmar', { method: 'POST', body: { servico: r.service_id, acao: 'cancelar_servico' } });
      voiceFeedback('Status atualizado: serviço cancelado', true);
      setStatus('Status atualizado: Serviço cancelado');
      return refresh();
    }
    const text = `Status atualizado: ${r.label}`;
    voiceFeedback(text, true);
    setStatus([state.me.role === 'dono' ? `${text} (serviço #${num(r.service)})` : text, ...(r.notices || [])].join(' · '));
    return refresh();
  }
  if (r.intencao === 'pagamento') return go(`#/servico/${r.service_id}`, 'pagamento', r);
  if (r.intencao === 'despesa') return go('#/despesas', 'despesa', r);
  if (r.intencao === 'milhas_caminhao') {
    if (!r.truck_id) {
      voiceSay('Escolha o caminhão e digite as milhas.', `Escolha o caminhão e digite ${r.odometer.toLocaleString('en-US')} mi.`);
      return go('#/caminhoes');
    }
    const n = r.odometer.toLocaleString('en-US');
    voiceFeedback(`Atualizar as milhas do ${r.truck_name}?`, true);
    if (!(await ask(`Atualizar as milhas do ${r.truck_name} para ${n} mi?`, { ok: 'Atualizar', cancel: 'Não' }))) return setStatus('Nada mudou.');
    await api(`/trucks/${r.truck_id}`, { method: 'PATCH', body: { odometer: r.odometer } });
    voiceSay('Milhas atualizadas', `✅ Milhas do ${r.truck_name}: ${n} mi`);
    if (['caminhoes', 'manutencao'].includes(state.screen)) route();
  }
}

// Serviço novo falado: preenche o formulário com o que o Gemini entendeu. Devolve o que preencheu.
function fillNewService(form, r) {
  const filled = [];
  const put = (name, value, label) => {
    const input = form[name];
    if (!input || value == null || value === '') return;
    input.value = value;
    // Dispara a busca do campo (cliente na agenda, endereço no mapa, VIN).
    input.dispatchEvent(new Event('input', { bubbles: true }));
    filled.push(label);
  };
  if (r.contact_phone || r.contact_name) form.contact_id.value = '';
  const d = (r.contact_phone || '').replace(/\D/g, '');
  put('contact_phone', /^1?\d{10}$/.test(d) ? phoneFmt(d.length === 10 ? '1' + d : d) : r.contact_phone, 'celular');
  put('contact_name', r.contact_name, 'cliente');
  put('pickup', r.pickup, 'retirada');
  put('dropoff', r.dropoff, 'destino');
  put('vin', r.vin, 'VIN');
  put('vehicle', r.vehicle, 'veículo');
  put('plate', r.plate, 'placa');
  put('miles', r.miles, 'milhas');
  put('price', r.price, 'valor');
  if (r.notes) put('notes', [form.notes.value, r.notes].filter(Boolean).join('\n'), 'observações');
  if (r.driver_id && form.driver_id) {
    form.driver_id.value = String(r.driver_id);
    filled.push('motorista');
  }
  return filled;
}

// Conversa do serviço novo: depois de preencher, pergunta o que falta e já escuta a resposta.
const NEW_QUESTIONS = [
  ['contact_phone', 'telefone', 'Qual o telefone do cliente?'],
  ['contact_name', 'cliente', 'Qual o nome do cliente?'],
  ['pickup', 'retirada', 'Onde pegar o carro?'],
  ['dropoff', 'destino', 'Para onde levar?'],
  ['vehicle', 'veiculo', 'Qual é o carro?'],
  ['price', 'valor', 'Qual o valor do serviço?'],
];
function talkNewService(form, campos) {
  form.talk ||= { asked: new Set(), current: null, misses: 0 };
  const filled = fillNewService(form, campos || {});
  if (filled.length) bubbleStatus(`✅ Preenchi: ${filled.join(', ')}.`);
  // Espera a busca na agenda: cliente que já existe completa o nome sozinho.
  setTimeout(() => askNext(form), 900);
}
async function askNext(form, { again = false } = {}) {
  const talk = (form.talk ||= { asked: new Set(), current: null, misses: 0 });
  if (state.screen !== 'novo' || !form.isConnected) return;
  talk.misses = again ? talk.misses + 1 : 0;
  // Não entendeu: pergunta a mesma coisa uma vez; na segunda, passa para a próxima.
  let next = again && talk.misses === 1 ? NEW_QUESTIONS.find((q) => q[1] === talk.current) : null;
  next ||= NEW_QUESTIONS.find(([field]) => form[field] && !form[field].value.trim() && !talk.asked.has(field));
  if (!next) {
    talk.current = null;
    form.querySelector('button.block')?.scrollIntoView({ block: 'center' });
    return voiceSay('Pronto. Confira e toque em criar serviço.', '✅ Pronto. Confira os dados e toque em Criar serviço.');
  }
  const [field, key, question] = next;
  talk.current = key;
  talk.asked.add(field);
  form[field].scrollIntoView({ block: 'center' });
  const asking = `${again ? 'Não entendi. ' : ''}${question}`;
  bubbleStatus(`🎤 ${asking}`);
  await voiceFeedback(asking, true);
  if (talk.current === key && state.screen === 'novo' && form.isConnected) fabMic?.listen(`🔴 ${asking} Pode falar (ou diga "pula").`);
}

// Liga o botão de microfone: grava, converte para WAV e entrega o áudio para handle(audio, setStatus).
// status: o elemento do texto (ou uma função). keep: o botão continua na tela quando ela muda.
// Devolve { listen }: começa a escutar sozinho e para quando a pessoa termina de falar.
function wireMic(btn, status, handle, maxMs = 15000, keep = false) {
  const TYPES = ['audio/mp4;codecs=mp4a.40.2', 'audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus'];
  let rec = null;
  let starting = false;
  let stream = null;
  let chunks = [];
  let pressedAt = 0;
  let timer = null;
  let busy = false;
  const setStatus = typeof status === 'function' ? status : (text) => (status.textContent = text);
  const release = () => {
    clearTimeout(timer);
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    btn.classList.remove('rec');
  };
  const start = async (auto = false, prompt = '') => {
    if (rec || busy || starting) return;
    starting = true;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      return setStatus('Libere o microfone para este app nos ajustes do celular.');
    } finally {
      starting = false;
    }
    const type = TYPES.find((t) => MediaRecorder.isTypeSupported?.(t));
    rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => send(new Blob(chunks, { type: rec.mimeType || type || 'audio/webm' }));
    rec.start();
    btn.classList.add('rec');
    setStatus(auto ? prompt || '🔴 Pode falar…' : '🔴 Ouvindo… solte (ou toque de novo) quando terminar.');
    timer = setTimeout(stop, maxMs); // tempo máximo de gravação
    if (auto) watchSilence(stream);
  };
  // Escuta sozinho: para 1,5 s depois que a pessoa para de falar; ninguém falou em 7 s, desiste.
  const watchSilence = (s) => {
    try {
      const ac = (novo.audio ||= new (window.AudioContext || window.webkitAudioContext)());
      ac.resume();
      const source = ac.createMediaStreamSource(s);
      const meter = ac.createAnalyser();
      meter.fftSize = 1024;
      source.connect(meter);
      const buf = new Uint8Array(meter.fftSize);
      const began = Date.now();
      let spoke = false;
      let quietSince = began;
      const check = () => {
        if (!rec || rec.state === 'inactive' || stream !== s) return source.disconnect();
        meter.getByteTimeDomainData(buf);
        let peak = 0;
        for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
        const now = Date.now();
        if (peak > 14) {
          spoke = true;
          quietSince = now;
        }
        if (spoke && now - quietSince > 1500) return stop();
        if (!spoke && now - began > 7000) {
          drop();
          return setStatus('Toque no microfone para responder.');
        }
        setTimeout(check, 100);
      };
      check();
    } catch {}
  };
  // Para de gravar sem mandar.
  const drop = () => {
    if (rec) {
      rec.onstop = null;
      if (rec.state !== 'inactive') rec.stop();
      rec = null;
    }
    release();
  };
  const stop = () => {
    if (!rec || rec.state === 'inactive') return;
    rec.stop();
    release();
  };
  const send = async (blob) => {
    rec = null;
    if (blob.size < 500) return setStatus('Não ouvi nada. Segure o microfone enquanto fala.');
    busy = true;
    btn.disabled = true;
    setStatus('Entendendo…');
    try {
      await handle(await toWav(blob), setStatus);
    } catch (err) {
      setStatus(err.message);
      voiceFeedback('Não deu certo', false);
    } finally {
      busy = false;
      btn.disabled = false;
    }
  };
  // Segurar: grava enquanto o dedo está no botão. Toque rápido: grava até tocar de novo.
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (rec) return stop();
    pressedAt = Date.now();
    start();
  });
  btn.addEventListener('pointerup', () => {
    if (rec && pressedAt && Date.now() - pressedAt > 600) stop();
    pressedAt = 0;
  });
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
  // Saiu da tela: para de gravar sem mandar.
  window.addEventListener('hashchange', drop, { once: !keep });
  return { listen: (prompt) => start(true, prompt) };
}

// ---------- aviso de serviço novo ----------
// Com o app aberto, confere a cada 20 s se entrou serviço (para o motorista: dado para ele; para o ADM:
// qualquer um). Tem serviço novo: toca um alarme, fala "Serviço novo" e mostra o aviso.
// Serviço que a própria pessoa criou neste aparelho não toca.
const novo = { user: null, ids: null, mine: new Set(), audio: null };

// O navegador só deixa tocar som depois que a pessoa toca na tela uma vez.
function unlockSound() {
  try {
    novo.audio ||= new (window.AudioContext || window.webkitAudioContext)();
    novo.audio.resume();
    if (!novo.voiceReady && 'speechSynthesis' in window) {
      speechSynthesis.speak(Object.assign(new SpeechSynthesisUtterance(''), { volume: 0 }));
      novo.voiceReady = true;
    }
  } catch {}
}
document.addEventListener('pointerdown', unlockSound, { capture: true });

function alarm(count) {
  const ctx = novo.audio;
  if (ctx && ctx.state === 'running') {
    // Três toques de dois tons, como uma campainha.
    for (let i = 0; i < 3; i++) {
      for (const [freq, at] of [[880, 0], [660, 0.18]]) {
        const t = ctx.currentTime + i * 0.5 + at;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(0.5, t + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t);
        osc.stop(t + 0.17);
      }
    }
  }
  if ('speechSynthesis' in window) {
    const say = new SpeechSynthesisUtterance(count > 1 ? `${count} serviços novos` : 'Serviço novo');
    say.lang = 'pt-BR';
    say.voice = maleVoice();
    setTimeout(() => speechSynthesis.speak(say), 1600);
  }
  navigator.vibrate?.([300, 150, 300, 150, 300]);
  toast(count > 1 ? `🔔 ${count} serviços novos` : '🔔 Serviço novo');
}

async function checkNew() {
  if (!state.me || document.visibilityState === 'hidden') return;
  if (novo.user !== state.me.id) Object.assign(novo, { user: state.me.id, ids: null });
  let ids;
  try {
    ids = await api('/servicos-ativos');
  } catch {
    return;
  }
  if (novo.ids) {
    const fresh = ids.filter((id) => !novo.ids.has(id) && !novo.mine.has(id));
    if (fresh.length) {
      alarm(fresh.length);
      if (state.screen === 'servicos') route();
    }
  }
  novo.ids = new Set(ids);
}
setInterval(checkNew, 20000);
document.addEventListener('visibilitychange', checkNew);

window.addEventListener('hashchange', route);
// Voltou para o app (outra aba, celular desbloqueado): se o cargo mudou, redesenha a tela com as permissões novas.
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || !state.me || Date.now() - (state.meAt || 0) < 60000) return;
  const role = state.me.role;
  await refreshMe();
  if (state.me && state.me.role !== role) route();
});
// Virou a tela (ou mudou o tamanho da janela): desenha de novo no formato certo.
deskQuery.addEventListener('change', () => state.me && route());
await loadMe();
checkNew();
if (!location.hash) location.hash = state.me ? '#/servicos' : '#/login';
else route();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
