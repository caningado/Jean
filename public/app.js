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
const PHOTO_KINDS = { antes: 'Antes', depois: 'Depois', vin: 'VIN', outro: 'Outra' };

// ---------- utilidades ----------
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
const money = (cents) => '$' + ((cents || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const phoneFmt = (p) => (/^1\d{10}$/.test(p || '') ? `(${p.slice(1, 4)}) ${p.slice(4, 7)}-${p.slice(7)}` : p ? '+' + p : '');
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

async function api(path, { method = 'GET', body, raw, type } = {}) {
  const opts = { method, headers: {} };
  if (raw) {
    opts.body = raw;
    opts.headers['Content-Type'] = type || raw.type || 'application/octet-stream';
  } else if (body !== undefined) {
    opts.body = JSON.stringify(body);
    opts.headers['Content-Type'] = 'application/json';
  }
  const res = await fetch('/api' + path, opts);
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
  return data;
}

// Agenda do celular (Contact Picker): funciona no Chrome do Android. O iPhone ainda não deixa.
const canPickContacts = 'contacts' in navigator && 'ContactsManager' in window;

// Abre a agenda do celular e devolve [{ name, phones: [...] }].
async function pickPhoneContacts(multiple = false) {
  const picked = await navigator.contacts.select(['name', 'tel'], { multiple });
  return picked
    .map((c) => ({ name: (c.name || []).find(Boolean) || '', phones: [...new Set((c.tel || []).map((t) => t.trim()).filter(Boolean))] }))
    .filter((c) => c.name || c.phones.length);
}

const vcfEscape = (v) => String(v).replace(/[\\,;]/g, (m) => '\\' + m).replace(/\n/g, ' ');

// Sugestões de endereço do mapa enquanto digita (retirada e destino).
function placeSuggestions(input) {
  const list = document.createElement('datalist');
  list.id = `places-${input.name}`;
  input.after(list);
  input.setAttribute('list', list.id);
  input.autocomplete = 'off';
  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2 || /https?:\/\//i.test(q)) return;
    timer = setTimeout(async () => {
      // Endereços com apelido (ex.: "ribas") aparecem primeiro, depois os do mapa.
      const { matches = [], saved = [] } = await api(`/places?q=${encodeURIComponent(q)}`).catch(() => ({}));
      if (input.value.trim() !== q) return;
      list.innerHTML = [
        ...saved.map((p) => `<option value="${esc(p.address)}" label="⭐ ${esc(p.nickname)}">`),
        ...matches.filter((m) => !saved.some((p) => p.address === m)).map((m) => `<option value="${esc(m)}">`),
      ].join('');
    }, q.length < 6 ? 250 : 600);
  });
}

// Salva; se o endereço não foi achado no mapa, pergunta se quer salvar assim mesmo.
async function sendCheckingAddress(send, body) {
  try {
    return await send(body);
  } catch (err) {
    if (err.code === 'endereco' && confirm(`${err.message}\n\nSalvar assim mesmo?`)) return send({ ...body, address_ok: true });
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

function setScreen(title, { tab = null, back = null } = {}) {
  titleEl.textContent = title;
  document.title = `${title} · ${state.company}`;
  tabs.classList.toggle('hidden', !state.me);
  tabs.querySelectorAll('a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
  backBtn.classList.toggle('hidden', !back);
  backBtn.onclick = back ? () => (location.hash = back) : null;
  window.scrollTo(0, 0);
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
        <p class="sub">Cadastre o dono da empresa. Use o mesmo número do seu WhatsApp.</p>
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

screens.servicos = async (params) => {
  setScreen('Serviços', { tab: 'servicos' });
  const status = params.get('status') ?? 'aberto';
  const driver = params.get('driver') || '';
  // O dono pode ver só os serviços de um motorista (inclusive os dele mesmo).
  const drivers = state.me.role === 'dono' ? await api('/users') : [];
  const query = (s, d) => `#/servicos?status=${s}${d ? `&driver=${d}` : ''}`;
  // Fila: serviços pendentes, que ainda não têm motorista trabalhando.
  // Só o dono vê a fila: é ele quem escolhe o motorista.
  const fila = state.me.role === 'dono' ? await api('/services?status=pendente').catch(() => []) : [];
  view.innerHTML = `
    <div class="segmented">
      ${state.me.role === 'dono' ? `<button data-s="pendente">Pendentes${fila.length ? ` <span class="badge pendente">${fila.length}</span>` : ''}</button>` : ''}<button data-s="aberto">Andamento</button><button data-s="concluido">Entregues</button><button data-s="">Todos</button>
    </div>
    ${drivers.length > 1 ? `<select id="driver" aria-label="Motorista"><option value="">Todos os motoristas</option>${drivers.map((d) => `<option value="${d.id}" ${String(d.id) === driver ? 'selected' : ''}>${esc(d.name)}${d.id === state.me.id ? ' (eu)' : ''}</option>`).join('')}</select>` : ''}
    <div class="card"><ul class="list" id="list"><li class="empty">Carregando…</li></ul></div>`;
  view.querySelectorAll('.segmented button').forEach((b) => {
    b.classList.toggle('active', b.dataset.s === status);
    b.onclick = () => (location.hash = query(b.dataset.s, driver));
  });
  const select = view.querySelector('#driver');
  if (select) select.onchange = () => (location.hash = query(status, select.value));
  let list;
  try {
    list = await api(`/services?status=${status}${driver ? `&driver=${encodeURIComponent(driver)}` : ''}`);
  } catch (err) {
    // Lista suspensa por falta da milhagem da semana: mostra o que fazer.
    if (!/suspensa/.test(err.message)) throw err;
    view.innerHTML = `<div class="card"><h2>🚫 Lista suspensa</h2><p>${esc(err.message)}</p><a class="btn block" href="#/caminhoes">📏 Mandar a milhagem</a></div>`;
    return;
  }
  const empty = status === 'pendente' ? 'Nenhum serviço na fila. 👍' : 'Nenhum serviço aqui.';
  if (status === 'aberto' && fila.length) {
    view.querySelector('.segmented').insertAdjacentHTML('afterend', `<a class="card linkcard" href="${query('pendente', driver)}"><span>⏳ <strong>${fila.length}</strong> serviço(s) na fila, sem motorista</span><span>›</span></a>`);
  }
  view.querySelector('#list').innerHTML = list.length
    ? list
        .map(
          (s) => `<li><a href="#/servico/${s.id}">
            <div><strong>#${s.id} ${esc(s.contact_name || 'Sem cliente')}</strong>
              <div class="sub">${esc([s.vehicle, s.plate].filter(Boolean).join(' · ') || (s.pickup || '').replace(/https?:\/\/\S+/g, 'local no mapa'))}</div>
              <div class="sub">${when(s.created_at)}${state.me.role === 'dono' && s.driver_name ? ' · ' + esc(s.driver_name) : ''}</div></div>
            <div class="right">${s.price_cents != null ? money(s.price_cents) : ''}<br><span class="badge ${s.status}">${STATUS[s.status]}</span></div>
          </a></li>`
        )
        .join('')
    : `<li class="empty">${empty}</li>`;
};

screens.novo = async () => {
  setScreen('Novo serviço', { tab: 'novo' });
  const drivers = state.me.role === 'dono' ? await api('/users') : [];
  const { pricing } = state;
  const priced = pricing && (pricing.baseCents || pricing.perMileCents);
  view.innerHTML = `
    <form class="card" id="f">
      <input type="hidden" name="contact_id">
      <label>Nome do cliente</label>
      <div class="suggest-wrap"><input name="contact_name" autocomplete="off" placeholder="Digite o nome para buscar na agenda"><ul class="suggest" hidden></ul></div>
      <p class="sub picked" hidden></p>
      <label>Telefone do cliente</label>
      <div class="copyrow"><input name="contact_phone" type="tel" autocomplete="off" placeholder="(508) 555-0123">${canPickContacts ? '<button type="button" class="secondary" id="agenda">📇 Agenda</button>' : ''}</div>
      <label>Retirada (onde pegar)</label><input name="pickup" required placeholder="Endereço ou link do mapa">
      <label>Destino (para onde levar)</label><input name="dropoff" placeholder="Endereço ou link do mapa">
      <div class="row2">
        <div><label>Veículo</label><input name="vehicle" placeholder="Honda Civic"></div>
        <div><label>Placa</label><input name="plate" autocapitalize="characters"></div>
      </div>
      <div class="row2">
        <div><label>Milhas</label><input name="miles" type="number" step="0.1" inputmode="decimal"></div>
        <div><label>Valor (US$)</label><input name="price" inputmode="decimal"></div>
      </div>
      ${priced ? `<p class="sub">Tabela: ${money(pricing.baseCents)} + ${money(pricing.perMileCents)} por milha.</p>` : ''}
      ${drivers.length ? `<label>Motorista</label><select name="driver_id">${drivers.filter((d) => d.active).map((d) => `<option value="${d.id}" ${d.id === state.me.id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}<option value="fila">⏳ Ninguém ainda (Pendente)</option></select>` : ''}
      <label>Observações</label><textarea name="notes" rows="2"></textarea>
      <button class="block">Criar serviço</button>
    </form>`;
  const form = view.querySelector('#f');
  placeSuggestions(form.pickup);
  placeSuggestions(form.dropoff);
  // Escolher o cliente direto da agenda do celular.
  const agenda = view.querySelector('#agenda');
  if (agenda) {
    agenda.onclick = async () => {
      try {
        const [contact] = await pickPhoneContacts();
        if (!contact) return;
        let phone = contact.phones[0] || '';
        if (contact.phones.length > 1) {
          const choice = prompt(`Qual número de ${contact.name}?\n${contact.phones.map((p, i) => `${i + 1}) ${p}`).join('\n')}`, '1');
          if (choice == null) return;
          phone = contact.phones[Number(choice) - 1] || phone;
        }
        form.contact_id.value = '';
        form.contact_phone.value = phone;
        form.contact_name.value = contact.name;
      } catch (err) {
        toast('Não consegui abrir a agenda do celular.');
      }
    };
  }
  // Busca na agenda enquanto digita o nome (ou o telefone) e preenche o resto.
  const box = view.querySelector('.suggest');
  const picked = view.querySelector('.picked');
  let found = [];
  let timer;
  const choose = (c) => {
    form.contact_id.value = c.id;
    form.contact_name.value = c.name;
    if (c.phone) form.contact_phone.value = phoneFmt(c.phone);
    const filled = [];
    if (c.last) {
      if (!form.vehicle.value && c.last.vehicle) (form.vehicle.value = c.last.vehicle), filled.push('veículo');
      if (!form.plate.value && c.last.plate) (form.plate.value = c.last.plate), filled.push('placa');
    }
    picked.hidden = false;
    picked.innerHTML = `✅ ${esc(c.name)}${c.company_name ? ` · 🏢 ${esc(c.company_name)}` : ''}${
      c.last ? `<br>Último serviço (#${c.last.id}, ${when(c.last.created_at).split(',')[0]}): ${esc([c.last.vehicle, c.last.plate].filter(Boolean).join(' · ') || 'sem veículo')}${filled.length ? ` <em>(${filled.join(' e ')} preenchido${filled.length > 1 ? 's' : ''})</em>` : ''}` : ''
    }`;
    box.hidden = true;
  };
  const search = (q) => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      found = q.trim().length >= 2 ? await api(`/contacts/suggest?q=${encodeURIComponent(q.trim())}`).catch(() => []) : [];
      box.innerHTML = found
        .map((c, i) => `<li><button type="button" data-i="${i}"><strong>${esc(c.name)}</strong><span class="sub">${c.phone ? phoneFmt(c.phone) : 'sem telefone'}${c.company_name ? ' · ' + esc(c.company_name) : ''}${c.last?.vehicle ? ' · ' + esc(c.last.vehicle) : ''}</span></button></li>`)
        .join('');
      box.hidden = !found.length;
      box.querySelectorAll('button').forEach((b) => (b.onclick = () => choose(found[Number(b.dataset.i)])));
    }, 250);
  };
  form.contact_name.oninput = () => {
    // Mudou o nome à mão: deixa de ser o contato escolhido.
    form.contact_id.value = '';
    picked.hidden = true;
    search(form.contact_name.value);
  };
  form.contact_name.onblur = () => setTimeout(() => (box.hidden = true), 200);
  form.contact_phone.oninput = () => {
    if (form.contact_id.value) return;
    const digits = form.contact_phone.value.replace(/\D/g, '');
    if (digits.length < 7) return;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const list = await api(`/contacts/suggest?q=${digits}`).catch(() => []);
      if (list.length === 1 && !form.contact_name.value) choose(list[0]);
    }, 400);
  };
  form.miles.oninput = () => {
    if (!priced || form.price.dataset.touched) return;
    const miles = Number(form.miles.value) || 0;
    form.price.value = ((pricing.baseCents + miles * pricing.perMileCents) / 100).toFixed(2);
  };
  form.price.oninput = () => (form.price.dataset.touched = '1');
  form.onsubmit = async (e) => {
    e.preventDefault();
    try {
      const body = formData(form);
      if (body.driver_id && body.driver_id !== 'fila') body.driver_id = Number(body.driver_id);
      const service = await sendCheckingAddress((b) => api('/services', { method: 'POST', body: b }), body);
      toast(service.status === 'pendente' ? `Serviço #${service.id} na fila` : `Serviço #${service.id} criado`);
      location.hash = `#/servico/${service.id}`;
    } catch (err) {
      toast(err.message);
    }
  };
};

screens.servico = async (params, id) => {
  setScreen(`Serviço #${id}`, { tab: 'servicos', back: '#/servicos' });
  const s = await api(`/services/${id}`);
  const owner = state.me.role === 'dono';
  const drivers = owner && s.status === 'pendente' ? await api('/users') : [];
  const vehicleInfo = s.vin_info ? [s.vin_info.year, s.vin_info.make, s.vin_info.model, s.vin_info.body].filter(Boolean).join(' · ') : '';
  const b = s.balance;

  view.innerHTML = `
    <div class="card">
      <div class="row" style="display:flex;justify-content:space-between;align-items:center">
        <h2 style="margin:0">${esc(s.contact_name || 'Sem cliente')}${s.company_name ? ` <span class="sub">· ${esc(s.company_name)}</span>` : ''}</h2>
        <span class="badge ${s.status}">${STATUS[s.status]}</span>
      </div>
      ${s.contact_phone ? `<p><a href="tel:+${s.contact_phone}">📞 ${phoneFmt(s.contact_phone)}</a> · <a href="https://wa.me/${s.contact_phone}" target="_blank" rel="noopener">WhatsApp</a></p>` : ''}
      ${placeHtml('📍', s.pickup, s.pickup_name)}${placeHtml('🏁', s.dropoff, s.dropoff_name)}
      <p>🚗 ${esc([s.vehicle, s.plate].filter(Boolean).join(' · ') || 'Veículo não informado')}</p>
      ${s.miles != null ? `<p class="sub">${s.miles} milhas</p>` : ''}
      <p class="big">${s.price_cents != null ? money(s.price_cents) : 'Sem valor'}</p>
      <p class="sub">${when(s.created_at)}${s.driver_name ? ' · ' + esc(s.driver_name) : ''}</p>
      ${s.notes ? `<p>${esc(s.notes)}</p>` : ''}
      <div class="actions">
        ${s.status === 'pendente' ? '' : s.status === 'aberto' ? '<button id="done">✅ Entregue</button>' : '<button class="secondary" id="reopen">Reabrir</button>'}
        ${s.status !== 'pendente' || state.me.role === 'dono' ? '<button class="secondary" id="edit">Editar</button>' : ''}
      </div>
      ${s.status === 'pendente' ? `<p class="sub">⏳ Na fila: ainda sem motorista.</p>${owner ? `<label>Escolher o motorista</label><div class="actions"><select id="assign" aria-label="Escolher o motorista"><option value="">Quem vai fazer?</option>${drivers.filter((d) => d.active).map((d) => `<option value="${d.id}">${esc(d.name)}${d.id === state.me.id ? ' (eu)' : ''}</option>`).join('')}</select></div>` : ''}` : ''}
      ${s.status === 'aberto' && owner ? '<div class="actions"><button class="secondary" id="queue">⏳ Voltar para a fila</button></div>' : ''}
      ${(s.status === 'aberto' && (owner || s.driver_id === state.me.id)) || (s.status === 'pendente' && owner) ? '<div class="actions"><button class="danger" id="cancel">✖ Cancelar serviço</button></div>' : ''}
    </div>

    ${has('vin') ? `
    <div class="card">
      <h2>VIN (chassi)</h2>
      ${s.vin ? `<p><strong>${esc(s.vin)}</strong>${vehicleInfo ? `<br><span class="sub">${esc(vehicleInfo)}</span>` : ''}</p>` : '<p class="sub">Ainda sem VIN.</p>'}
      <form id="vinForm" class="actions">
        <input name="vin" maxlength="17" autocapitalize="characters" placeholder="17 caracteres" value="${esc(s.vin || '')}">
        <button>Salvar</button>
      </form>
      <div class="actions">
        <button class="secondary" id="scanVin">📷 Escanear código</button>
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
        <div class="actions"><button>Registrar pagamento</button>${b?.open_cents ? '<button type="button" class="secondary" id="charge">Cobrar cliente</button>' : ''}</div>
      </form>
    </div>` : ''}
    ${has('invoice') ? `<a class="card linkcard" href="#/invoice/${s.id}"><span>🧾 Invoice para o cliente${s.invoice_number ? ` <span class="sub">nº ${s.invoice_number}</span>` : ''}</span><span>›</span></a>` : ''}`;

  const reload = () => screens.servico(params, id);
  const on = (sel, fn) => view.querySelector(sel) && (view.querySelector(sel).onclick = fn);

  on('#done', async () => {
    await api(`/services/${id}`, { method: 'PATCH', body: { status: 'concluido' } });
    toast('Serviço entregue');
    reload();
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
  on('#queue', async () => {
    if (!confirm('Voltar este serviço para a fila, sem motorista?')) return;
    await api(`/services/${id}`, { method: 'PATCH', body: { status: 'pendente' } });
    toast('Serviço voltou para a fila');
    reload();
  });
  on('#cancel', async () => {
    const motivo = prompt('Cancelar o serviço? Escreva o motivo (opcional):');
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

  const vinForm = view.querySelector('#vinForm');
  if (vinForm) {
    const saveVin = async (vin, force = false) => {
      try {
        await api(`/services/${id}/vin`, { method: 'POST', body: { vin, force } });
        toast('VIN salvo');
        reload();
      } catch (err) {
        if (confirm(`${err.message}\n\nSalvar assim mesmo?`)) saveVin(vin, true);
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
        if (confirm(`VIN lido: ${vin}\nSalvar?`)) saveVin(vin);
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
        if (confirm(`VIN lido: ${result.vin}${result.valid ? '' : '\n(o dígito verificador não bateu, confira)'}\nSalvar?`)) saveVin(result.vin, !result.valid);
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
    on('#charge', async () => {
      const { message } = await api(`/services/${id}/charge`);
      if (!message) return;
      if (navigator.share) {
        navigator.share({ text: message }).catch(() => {});
      } else if (s.contact_phone) {
        window.open(`https://wa.me/${s.contact_phone}?text=${encodeURIComponent(message)}`, '_blank');
      } else {
        await navigator.clipboard?.writeText(message);
        toast('Mensagem copiada');
      }
    });
  }
  view.querySelectorAll('[data-received]').forEach((btn) => {
    btn.onclick = async () => {
      await api(`/payments/${btn.dataset.received}`, { method: 'PATCH', body: { status: 'recebido' } });
      reload();
    };
  });
};

screens.editar = async (params, id) => {
  setScreen(`Editar #${id}`, { tab: 'servicos', back: `#/servico/${id}` });
  const s = await api(`/services/${id}`);
  const drivers = state.me.role === 'dono' ? await api('/users') : [];
  view.innerHTML = `
    <form class="card" id="f">
      <label>Retirada</label><input name="pickup" value="${esc(s.pickup)}">
      <label>Destino</label><input name="dropoff" value="${esc(s.dropoff)}">
      <div class="row2">
        <div><label>Veículo</label><input name="vehicle" value="${esc(s.vehicle)}"></div>
        <div><label>Placa</label><input name="plate" value="${esc(s.plate)}"></div>
      </div>
      <div class="row2">
        <div><label>Milhas</label><input name="miles" type="number" step="0.1" value="${s.miles ?? ''}"></div>
        <div><label>Valor (US$)</label><input name="price" inputmode="decimal" value="${s.price_cents != null ? (s.price_cents / 100).toFixed(2) : ''}"></div>
      </div>
      ${drivers.length ? `<label>Motorista</label><select name="driver_id">${s.driver_id ? '' : '<option value="" selected>Ninguém ainda (fila)</option>'}${drivers.map((d) => `<option value="${d.id}" ${d.id === s.driver_id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select>` : ''}
      <label>Situação</label><select name="status">${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${k === s.status ? 'selected' : ''}>${v}</option>`).join('')}</select>
      <label>Observações</label><textarea name="notes" rows="3">${esc(s.notes)}</textarea>
      <button class="block">Salvar</button>
    </form>`;
  placeSuggestions(view.querySelector('#f').pickup);
  placeSuggestions(view.querySelector('#f').dropoff);
  view.querySelector('#f').onsubmit = async (e) => {
    e.preventDefault();
    const body = formData(e.target);
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
  setScreen('Contatos', { tab: 'contatos' });
  const q = params.get('q') || '';
  view.innerHTML = `
    <form id="search" class="actions" style="margin-top:0;margin-bottom:12px"><input name="q" type="search" placeholder="Buscar nome ou telefone" value="${esc(q)}"></form>
    <div class="actions" style="margin-bottom:12px">
      <button class="secondary" id="add">➕ Novo contato</button>
      ${state.me.role === 'dono' && canPickContacts ? '<button class="secondary" id="pick">📇 Da agenda do celular</button>' : ''}
      ${state.me.role === 'dono' ? '<button class="secondary" id="import">📥 Importar arquivo (.vcf)</button>' : ''}
    </div>
    ${state.me.role === 'dono' && !canPickContacts ? `<details class="card"><summary>Como trazer a agenda do celular</summary>
      <p class="sub"><strong>iPhone:</strong> no app <strong>Contatos</strong>, toque em <strong>Listas</strong> (no alto, à esquerda), segure o dedo em <strong>Todos os Contatos</strong> e toque em <strong>Exportar</strong>. Salve em Arquivos e depois toque em <strong>📥 Importar arquivo (.vcf)</strong> aqui e escolha o arquivo.</p>
      <p class="sub"><strong>Android:</strong> abra o painel pelo <strong>Chrome</strong>: aparece o botão <strong>📇 Da agenda do celular</strong>.</p></details>` : ''}
    ${has('empresas') && state.me.role === 'dono' ? '<a class="card linkcard" href="#/empresas"><span>🏢 Empresas (oficinas, dealers) e extrato</span><span>›</span></a>' : ''}
    <div class="card"><ul class="list" id="list"><li class="empty">Carregando…</li></ul></div>`;
  view.querySelector('#search').onsubmit = (e) => {
    e.preventDefault();
    location.hash = `#/contatos?q=${encodeURIComponent(e.target.q.value)}`;
  };
  view.querySelector('#add').onclick = () => (location.hash = '#/contato/novo');
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
  const importBtn = view.querySelector('#import');
  if (importBtn) {
    importBtn.onclick = () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.vcf,text/vcard,text/x-vcard';
      input.onchange = async () => {
        const file = input.files[0];
        if (!file) return;
        try {
          const r = await api('/contacts/import', { method: 'POST', raw: await file.text(), type: 'text/vcard' });
          toast(`${r.created} novos, ${r.updated} atualizados${r.skipped ? `, ${r.skipped} sem telefone` : ''}`);
          screens.contatos(params);
        } catch (err) {
          toast(err.message);
        }
      };
      input.click();
    };
  }
  const list = await api(`/contacts?q=${encodeURIComponent(q)}`);
  view.querySelector('#list').innerHTML = list.length
    ? list
        .map(
          (c) => `<li><a href="#/contato/${c.id}"><div><strong>${esc(c.name)}</strong><div class="sub">${phoneFmt(c.phone)}</div></div>
          <div class="right sub">${c.services_count ? c.services_count + ' serviço' + (c.services_count > 1 ? 's' : '') : ''}</div></a></li>`
        )
        .join('')
    : '<li class="empty">Nenhum contato. Traga a agenda do celular ou adicione um.</li>';
};

screens.contato = async (params, id) => {
  const isNew = id === 'novo';
  setScreen(isNew ? 'Novo contato' : 'Contato', { tab: 'contatos', back: '#/contatos' });
  const c = isNew ? { services: [] } : await api(`/contacts/${id}`);
  const companies = has('empresas') ? await api('/companies') : [];
  view.innerHTML = `
    <form class="card" id="f">
      <label>Nome</label><input name="name" value="${esc(c.name)}" required>
      ${has('empresas') ? `<label>Empresa (se pede serviço por uma oficina ou dealer)</label><select name="company_id"><option value="">Nenhuma (cliente particular)</option>${companies
        .map((co) => `<option value="${co.id}"${co.id === c.company_id ? ' selected' : ''}>${esc(co.name)}</option>`)
        .join('')}</select>` : ''}
      <label>Telefone</label><input name="phone" type="tel" value="${esc(c.phone ? phoneFmt(c.phone) : '')}">
      <label>E-mail</label><input name="email" type="email" value="${esc(c.email)}">
      <label>Observações</label><textarea name="notes" rows="2">${esc(c.notes)}</textarea>
      <button class="block">Salvar</button>
    </form>
    ${!isNew ? `<div class="card"><h2>Histórico</h2><ul class="list">${
      c.services.length
        ? c.services.map((s) => `<li><a href="#/servico/${s.id}"><div>#${s.id} ${esc(s.vehicle || s.pickup || '')}<div class="sub">${when(s.created_at)}</div></div><div class="right">${s.price_cents != null ? money(s.price_cents) : ''}</div></a></li>`).join('')
        : '<li class="empty">Nenhum serviço ainda.</li>'
    }</ul></div>` : ''}`;
  view.querySelector('#f').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const { company_id, ...body } = formData(e.target);
      const saved = isNew ? await api('/contacts', { method: 'POST', body }) : await api(`/contacts/${id}`, { method: 'PATCH', body });
      if (company_id !== undefined && String(company_id || '') !== String(c.company_id || '')) {
        await api(`/contacts/${saved.id}/company`, { method: 'PUT', body: { company_id: company_id || null } });
      }
      toast('Contato salvo');
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
    ${s.open_cents || s.to_receive_cents ? `<div class="card"><h2>Pendências (todas)</h2><p>Clientes: ${money(s.open_cents)}<br>Seguradoras: ${money(s.to_receive_cents)}</p><a class="btn secondary" href="#/pendentes">Ver lista</a></div>` : ''}
    ${s.expenses_by_category && Object.keys(s.expenses_by_category).length ? `<div class="card"><h2>Despesas</h2><ul class="list">${Object.entries(s.expenses_by_category).map(([k, v]) => `<li><div class="row"><span>${CATEGORIES[k] || k}</span><span>${money(v)}</span></div></li>`).join('')}</ul></div>` : ''}
    ${has('planilha') ? `<a class="card linkcard" href="#/planilha"><span>📊 Planilha do Excel</span><span>›</span></a>` : ''}`;
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
  view.innerHTML = `
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
  view.querySelector('#trocar')?.addEventListener('click', () => confirm('O link atual vai parar de funcionar. Trocar?') && make());
  view.querySelector('#desligar')?.addEventListener('click', async () => {
    if (!confirm('Desligar o link? As planilhas ligadas a ele param de atualizar.')) return;
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
          ${d.payments.length ? `<details><summary class="sub">Ver ${d.payments.length === 1 ? "o pagamento" : `os ${d.payments.length} pagamentos`}</summary><ul class="sub">${d.payments.map((p) => `<li>#${p.service_id} ${esc(p.contact_name || '')} · ${METHODS[p.method]} ${money(p.amount_cents)} · ${when(p.received_at)}</li>`).join('')}</ul></details>` : ''}</div>
        <div class="right"><div class="big">${money(d.in_hand_cents)}</div>
          ${owner && d.in_hand_cents > 0 ? `<button class="secondary small" data-collect="${d.driver_id}">Recolhi</button>` : ''}</div></div></li>`
    )
    .join('')}</ul>${owner ? '<p class="sub">Toque em <strong>Recolhi</strong> quando pegar o dinheiro: o valor do motorista volta para zero.</p>' : ''}</div>`;
  box.querySelectorAll('[data-collect]').forEach((b) => {
    b.onclick = async () => {
      const d = list.find((x) => String(x.driver_id) === b.dataset.collect);
      const value = prompt(`Quanto você pegou de ${d.name}?\n(Deixe o valor todo para zerar)`, (d.in_hand_cents / 100).toFixed(2));
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

screens.pendentes = async () => {
  setScreen('Pendências', { tab: 'resumo', back: '#/resumo' });
  const list = await api('/payments/pending');
  const late = list.filter((s) => s.overdue).length;
  const age = (d) => (d === 0 ? 'hoje' : d === 1 ? 'há 1 dia' : `há ${d} dias`);
  view.innerHTML = `${late ? `<div class="card alerts"><strong>⚠️ ${late === 1 ? '1 atrasado' : `${late} atrasados`}</strong><div class="sub">Abra o serviço e toque em <strong>Cobrar cliente</strong> para mandar a mensagem com o Zelle.</div></div>` : ''}<div class="card"><ul class="list">${
    list.length
      ? list.map((s) => `<li${s.overdue ? ' class="late"' : ''}><a href="#/servico/${s.id}"><div><strong>${s.overdue ? '⚠️ ' : ''}#${s.id} ${esc(s.contact_name || '')}</strong><div class="sub">${when(s.completed_at || s.created_at)} · ${age(s.days)}</div></div>
          <div class="right">${s.open_cents ? 'Cliente ' + money(s.open_cents) : ''}${s.to_receive_cents ? '<br>Seguradora ' + money(s.to_receive_cents) : ''}</div></a></li>`).join('')
      : '<li class="empty">Nada pendente 👍</li>'
  }</ul></div>`;
};

screens.mais = async () => {
  setScreen('Mais', { tab: 'mais' });
  view.innerHTML = `
    <div class="card"><p><strong>${esc(state.me.name)}</strong><br><span class="sub">${phoneFmt(state.me.phone)} · ${state.me.role === 'dono' ? 'Dono' : 'Motorista'}</span></p></div>
    <div class="card"><ul class="list">
      ${has('despesas') ? '<li><a href="#/despesas"><span>🧾 Despesas</span><span>›</span></a></li>' : ''}
      ${has('manutencao') ? '<li><a href="#/caminhoes"><span>🔧 Caminhões e manutenção</span><span>›</span></a></li>' : ''}
      ${has('comissao') ? `<li><a href="${state.me.role === 'dono' ? '#/comissao' : `#/motorista/${state.me.id}`}"><span>💰 ${state.me.role === 'dono' ? 'Pagamento dos motoristas' : 'Meus ganhos'}</span><span>›</span></a></li>` : ''}
      ${state.me.role === 'dono' ? '<li><a href="#/equipe"><span>👥 Equipe</span><span>›</span></a></li>' : ''}
      ${has('invoice') && state.me.role === 'dono' ? '<li><a href="#/empresa"><span>🏢 Dados da empresa (invoice)</span><span>›</span></a></li>' : ''}
      <li><a href="#/enderecos"><span>📍 Endereços com apelido</span><span>›</span></a></li>
      ${has('backup') && state.me.role === 'dono' ? '<li><a href="#/backup"><span>💾 Backup</span><span>›</span></a></li>' : ''}
      <li><a href="#/robo"><span>💬 Testar o robô do WhatsApp</span><span>›</span></a></li>
      <li><a href="#/sair"><span>🚪 Sair</span><span>›</span></a></li>
    </ul></div>
    <p class="sub">Dica: no navegador do celular, use "Adicionar à tela inicial" para abrir como aplicativo.</p>`;
};

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
      if (!confirm(`Apagar o apelido "${p.nickname}"?`)) return;
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
  const drivers = users.filter((u) => u.active);
  const driverSelect = (selected) =>
    `<select name="driver_id"><option value="">Sem motorista fixo</option>${drivers.map((u) => `<option value="${u.id}"${u.id === selected ? ' selected' : ''}>${esc(u.name)}</option>`).join('')}</select>`;
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
    ${!trucks.length ? `<div class="card empty">${owner ? 'Cadastre seu caminhão abaixo. Ele já vem com troca de óleo, pneus, freios, inspeção e registro.' : 'Nenhum caminhão cadastrado. Peça para o dono cadastrar.'}</div>` : ''}
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
      b.onclick = () => {
        const item = truck.items.find((i) => String(i.id) === b.dataset.edit);
        const m = prompt(`${item.name}: a cada quantas milhas? (vazio = não conta milhas)`, item.every_miles || '');
        if (m == null) return;
        const d = prompt(`${item.name}: a cada quantos dias? (vazio = não conta dias)\nPara apagar o item, deixe os dois vazios.`, item.every_days || '');
        if (d == null) return;
        if (!m && !d) {
          if (confirm(`Apagar "${item.name}"?`)) run(() => api(`/maintenance/${item.id}`, { method: 'DELETE' }), 'Item apagado');
          return;
        }
        run(() => api(`/maintenance/${item.id}`, { method: 'PATCH', body: { every_miles: m, every_days: d } }), 'Salvo');
      };
    });
  });
  view.querySelectorAll('[data-deltruck]').forEach((b) => {
    b.onclick = () => confirm('Apagar este caminhão e a manutenção dele?') && run(() => api(`/trucks/${b.dataset.deltruck}`, { method: 'DELETE' }), 'Caminhão apagado');
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
      if (!confirm('Apagar este serviço do histórico?')) return;
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
    const res = await fetch(`/api/invoices/${inv.id}/pdf`);
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
        <div class="actions"><a class="btn secondary" href="/api/invoices/${i.id}/pdf" target="_blank" rel="noopener">Ver PDF</a>
          <button data-share="${i.id}">📤 Mandar</button>
          <a class="btn secondary" href="#/invoice/${id}?editar=${i.id}">Editar</a></div></li>`
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
      <p class="sub">O invoice sai em inglês, com o logo e os dados da empresa (Mais › Dados da empresa). Se o serviço já foi pago, sai com "PAID".</p>
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
      <div class="row2"><div><label>Próximo número</label><input name="nextNumber" inputmode="numeric" value="${c.next_number}"></div>
        <div><label>Prazo (dias)</label><input name="dueDays" inputmode="numeric" value="${c.dueDays}"></div></div>
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
screens.empresas = async () => {
  setScreen('Empresas', { tab: 'contatos', back: '#/contatos' });
  const list = await api('/companies');
  view.innerHTML = `
    <div class="card"><ul class="list">${
      list.length
        ? list.map((c) => `<li><a href="#/cliente/${c.id}"><div><strong>${esc(c.name)}</strong><div class="sub">${c.requesters_count} solicitante(s)</div></div><div class="right">${c.due_cents ? `<strong>${money(c.due_cents)}</strong><div class="sub">em aberto</div>` : '<span class="sub">em dia ✅</span>'}</div></a></li>`).join('')
        : '<li class="empty">Nenhuma empresa ainda.</li>'
    }</ul></div>
    <form class="card" id="f">
      <h2>Nova empresa</h2>
      <label>Nome</label><input name="name" required placeholder="Ex.: USAVE Motors">
      <label>Para quem sai a cobrança (Bill to): nome e endereço</label><textarea name="bill_to" rows="3" placeholder="Nome, rua, cidade, estado e CEP"></textarea>
      <div class="row2"><div><label>Telefone</label><input name="phone" type="tel"></div><div><label>E-mail</label><input name="email" type="email"></div></div>
      <button class="block">Cadastrar</button>
    </form>`;
  view.querySelector('#f').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const c = await api('/companies', { method: 'POST', body: formData(e.target) });
      toast('Empresa cadastrada');
      location.hash = `#/cliente/${c.id}`;
    } catch (err) {
      toast(err.message);
    }
  };
};

screens.cliente = async (params, id) => {
  setScreen('Empresa', { tab: 'contatos', back: '#/empresas' });
  const periodo = params.get('periodo') || 'abertos';
  const [c, contacts] = await Promise.all([api(`/companies/${id}?periodo=${periodo}`), api('/contacts')]);
  const st = c.statement;
  const now = new Date();
  const months = [...Array(12)].map((_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  });
  const monthName = (m) => new Date(`${m}-15T12:00:00`).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
  const pdfUrl = `/api/companies/${id}/statement.pdf?periodo=${periodo}`;
  const free = contacts.filter((p) => !c.requesters.some((r) => r.id === p.id));
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
      <div class="copyrow"><select id="addReq"><option value="">Escolha um contato…</option>${free.map((p) => `<option value="${p.id}">${esc(p.name)}${p.phone ? ' · ' + phoneFmt(p.phone) : ''}</option>`).join('')}</select><button class="secondary" id="addBtn">Adicionar</button></div>
      <p class="sub">Pelo WhatsApp: abra o serviço e mande <strong>empresa ${esc(c.name.split(' ')[0].toLowerCase())}</strong>.</p>
    </div>
    <details class="card"><summary>Dados da empresa</summary>
      <form id="f">
        <label>Nome</label><input name="name" value="${esc(c.name)}" required>
        <label>Para quem sai a cobrança (Bill to)</label><textarea name="bill_to" rows="3">${esc(c.bill_to || '')}</textarea>
        <div class="row2"><div><label>Telefone</label><input name="phone" type="tel" value="${esc(c.phone || '')}"></div><div><label>E-mail</label><input name="email" type="email" value="${esc(c.email || '')}"></div></div>
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
      const file = new File([await (await fetch(pdfUrl)).blob()], name, { type: 'application/pdf' });
      if (navigator.canShare?.({ files: [file] })) return await navigator.share({ files: [file], title: name });
    } catch (err) {
      if (err.name === 'AbortError') return;
    }
    if (c.link && navigator.share) return navigator.share({ title: name, text: `Here is your statement: ${c.link}` }).catch(() => {});
    location.href = pdfUrl + '&download=1';
  };
  view.querySelector('#addBtn').onclick = async () => {
    const pid = view.querySelector('#addReq').value;
    if (!pid) return toast('Escolha um contato');
    await api(`/contacts/${pid}/company`, { method: 'PUT', body: { company_id: Number(id) } });
    toast('Solicitante adicionado');
    reload();
  };
  view.querySelectorAll('[data-unlink]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Tirar esta pessoa da empresa? Os serviços dela saem do extrato.')) return;
      await api(`/contacts/${b.dataset.unlink}/company`, { method: 'PUT', body: { company_id: null } });
      reload();
    };
  });
  view.querySelector('#f').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api(`/companies/${id}`, { method: 'PATCH', body: formData(e.target) });
      toast('Salvo');
      reload();
    } catch (err) {
      toast(err.message);
    }
  };
  view.querySelector('#del').onclick = async () => {
    if (!confirm(`Apagar ${c.name}? Os solicitantes continuam nos contatos.`)) return;
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
        : '<li class="empty">Nenhum motorista. Cadastre em Mais › Equipe.</li>'
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
    const file = new File([await (await fetch(url)).blob()], name, { type: 'application/pdf' });
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
    const value = prompt(`Quanto você pagou para ${m.driver.name}?`, (suggested / 100).toFixed(2));
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
      if (!confirm('Apagar este pagamento?')) return;
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
  view.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Apagar esta despesa?')) return;
      await api(`/expenses/${b.dataset.del}`, { method: 'DELETE' });
      screens.despesas();
    };
  });
};

screens.equipe = async () => {
  setScreen('Equipe', { tab: 'mais', back: '#/mais' });
  const users = await api('/users');
  view.innerHTML = `
    <div class="card"><ul class="list">${users
      .map((u) => `<li><div class="row"><div><strong>${esc(u.name)}</strong> ${u.active ? '' : '<span class="badge cancelado">desativado</span>'}<div class="sub">${phoneFmt(u.phone)} · ${u.role === 'dono' ? 'Dono' : 'Motorista'}</div></div>
        ${u.id !== state.me.id ? `<button class="secondary" data-toggle="${u.id}" data-active="${u.active}">${u.active ? 'Desativar' : 'Ativar'}</button>` : ''}</div></li>`)
      .join('')}</ul></div>
    <form class="card" id="f">
      <h2>Adicionar pessoa</h2>
      <p class="sub">O número precisa ser o WhatsApp da pessoa, para o robô reconhecer.</p>
      <label>Nome</label><input name="name" required>
      <label>Telefone (WhatsApp)</label><input name="phone" type="tel" required>
      <label>PIN para entrar no painel (opcional)</label><input name="pin" inputmode="numeric" pattern="[0-9]{4,8}">
      <label>Função</label><select name="role"><option value="motorista">Motorista</option><option value="dono">Dono / sócio</option></select>
      <button class="block">Adicionar</button>
    </form>`;
  view.querySelector('#f').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('/users', { method: 'POST', body: formData(e.target) });
      toast('Pessoa adicionada');
      screens.equipe();
    } catch (err) {
      toast(err.message);
    }
  };
  view.querySelectorAll('[data-toggle]').forEach((b) => {
    b.onclick = async () => {
      await api(`/users/${b.dataset.toggle}`, { method: 'PATCH', body: { active: b.dataset.active !== 'true' } });
      screens.equipe();
    };
  });
};

screens.robo = async () => {
  setScreen('Testar o robô', { tab: 'mais', back: '#/mais' });
  view.innerHTML = `
    <p class="sub">Funciona igual ao WhatsApp, usando o seu número. Comece com <strong>ajuda</strong> ou <strong>novo</strong>.</p>
    <div class="chat" id="chat"></div>
    <form class="chat-input" id="f"><input name="text" autocomplete="off" placeholder="Mensagem"><button>Enviar</button></form>`;
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
// Estilo do desenho: 'silhueta', 'linha' (contorno fino) ou 'cantos' (cantos + sombra).
const FRAME_STYLE = 'silhueta';
const CAR_SIDE = {
  viewBox: '0 0 600 220',
  body: 'M40 170 Q30 168 30 150 L32 132 Q36 120 52 116 L150 102 Q185 98 228 96 Q262 58 300 50 Q350 44 400 46 Q440 50 478 92 L540 100 Q566 104 570 120 L572 150 Q572 168 556 170 L505 170 A45 45 0 0 0 415 170 L180 170 A45 45 0 0 0 90 170 Z',
  details: 'M240 96 Q268 64 300 58 L345 56 L348 96 Z M360 96 L358 56 L398 56 Q430 60 462 94 Z M350 100 L352 162 M232 98 L224 88 L212 88 L216 98 Z M40 124 Q60 118 80 120 L74 132 Q52 134 40 132 Z M556 108 L570 116 L570 128 L556 124 Z M300 112 h18',
  wheels: [[135, 172], [460, 172]],
  ground: 206,
};
const CAR_FRONT = {
  viewBox: '0 0 400 300',
  body: 'M60 252 L56 190 Q58 160 80 150 L100 150 L130 80 Q140 66 160 64 L240 64 Q260 66 270 80 L300 150 L320 150 Q342 160 344 190 L340 252 Z',
  details: 'M115 145 L140 88 Q146 78 160 78 L240 78 Q254 78 260 88 L285 145 Z M96 140 L72 132 L70 148 L96 152 Z M304 140 L328 132 L330 148 L304 152 Z M76 172 Q90 164 130 168 L126 186 Q96 188 78 184 Z M324 172 Q310 164 270 168 L274 186 Q304 188 322 184 Z M150 172 L250 172 Q256 172 254 180 L248 200 Q246 206 240 206 L160 206 Q154 206 152 200 L146 180 Q144 172 150 172 Z M64 222 L336 222 M170 228 h60 v18 h-60 Z',
  tires: [[62, 250], [284, 250]],
  ground: 278,
};
const CAR_REAR = {
  viewBox: '0 0 400 300',
  body: CAR_FRONT.body,
  details: 'M120 145 L145 90 Q150 80 162 80 L238 80 Q250 80 255 90 L280 145 Z M96 140 L72 132 L70 148 L96 152 Z M304 140 L328 132 L330 148 L304 152 Z M62 170 L120 170 L116 194 L64 194 Z M338 170 L280 170 L284 194 L336 194 Z M120 168 L280 168 M165 192 h70 v26 h-70 Z M64 228 L336 228 M296 244 h22',
  tires: [[62, 250], [284, 250]],
  ground: 278,
};
// estilo: 'silhueta' | 'cantos' | 'linha'
function drawCar(car, style, mirror = false) {
  const [, , w, h] = car.viewBox.split(' ').map(Number);
  const wheels = (car.wheels || []).map(([x, y]) => `<circle cx="${x}" cy="${y}" r="34"/><circle cx="${x}" cy="${y}" r="13"/>`).join('');
  const tires = (car.tires || []).map(([x, y]) => `<rect x="${x}" y="${y}" width="54" height="26" rx="8"/>`).join('');
  const flip = mirror ? ` transform="translate(${w} 0) scale(-1 1)"` : '';
  if (style === 'cantos') {
    const m = 14, L = 46;
    const c = `M${m} ${m + L} V${m} H${m + L} M${w - m - L} ${m} H${w - m} V${m + L} M${w - m} ${h - m - L} V${h - m} H${w - m - L} M${m + L} ${h - m} H${m} V${h - m - L}`;
    return `<svg viewBox="${car.viewBox}" class="g cantos"><path class="corner" d="${c}"/><g${flip} class="ghost"><path d="${car.body}"/>${wheels}${tires}</g><path class="groundline" d="M${w * 0.12} ${car.ground} H${w * 0.88}"/></svg>`;
  }
  return `<svg viewBox="${car.viewBox}" class="g ${style}"><g${flip}><path class="body" d="${car.body}"/><path class="det" d="${car.details}"/>${wheels}${tires}</g></svg>`;
}
function carDrawing(angle, style = FRAME_STYLE) {
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
    `<figure><a href="${p.url}" target="_blank"><img src="${p.url}" loading="lazy" alt="${esc(label)}"></a><figcaption>${esc(label)}</figcaption></figure>`;
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
      <p class="camera-step"></p>
      <button class="scanner-close" data-act="close" aria-label="Fechar">✕</button>
    </div>
    <p class="scanner-tip">Encaixe o carro no desenho. Dica: deite o celular para caber o carro todo.</p>
    <p class="scanner-status"></p>
    <div class="scanner-actions">
      <button class="secondary" data-act="skip">Pular</button>
      <button class="shutter" data-act="shoot" aria-label="Tirar foto"></button>
      <button class="secondary" data-act="close2">Terminar</button>
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

  const show = () => {
    if (index >= queue.length) {
      // Terminou a volta: pode continuar tirando fotos de detalhe.
      queue.push('detalhe');
    }
    const angle = queue[index];
    frame.innerHTML = carDrawing(angle);
    stepEl.textContent = angle === 'detalhe' ? `${PHOTO_KINDS[kind]} · Detalhe / dano (opcional)` : `${PHOTO_KINDS[kind]} · ${ANGLES.indexOf(angle) + 1}/4 · ${ANGLE_LABEL[angle]}`;
    button('skip').hidden = angle === 'detalhe';
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
  window.removeEventListener('popstate', finish);
  if (history.state?.scanner) history.back();
  stream.getTracks().forEach((t) => t.stop());
  overlay.remove();
  if (saved) toast(`${saved} foto${saved === 1 ? '' : 's'} salva${saved === 1 ? '' : 's'}`);
  return saved;
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
  detectorPromise.catch(() => (detectorPromise = null));
  return detectorPromise;
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
    <p class="scanner-tip">Coloque o código de barras do VIN <strong>dentro do retângulo</strong>, deitado, bem de perto.</p>
    <p class="scanner-status">Abrindo a câmera…</p>
    <div class="scanner-actions">
      <button class="secondary" data-act="torch" hidden>🔦 Lanterna</button>
      <button class="secondary" data-act="photo">📸 Tirar foto</button>
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
  const frame = (crop) => {
    const c = crop || { x: 0, y: 0, w: video.videoWidth, h: video.videoHeight };
    canvas.width = Math.round(c.w);
    canvas.height = Math.round(c.h);
    canvas.getContext('2d').drawImage(video, c.x, c.y, c.w, c.h, 0, 0, canvas.width, canvas.height);
    return canvas;
  };

  button('photo').onclick = async () => {
    if (!video.videoWidth) return;
    status.textContent = 'Lendo a foto…';
    const image = await new Promise((r) => frame().toBlob(r, 'image/jpeg', 0.92));
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

    let detector;
    try {
      status.textContent = 'Preparando o leitor…';
      detector = await barcodeDetector();
    } catch (err) {
      status.textContent = 'Leitor indisponível. Use 📸 Tirar foto.';
      return await result;
    }
    status.textContent = 'Procurando o código de barras…';
    (async () => {
      for (let i = 0; !done; i++) {
        const codes = await detector.detect(frame(i % 3 === 2 ? null : boxCrop())).catch(() => []);
        for (const code of codes) {
          const vin = vinFromCode(code.rawValue);
          if (vin) return finish(vin);
          status.textContent = 'Achei um código, mas não é o VIN. Procure o código com 17 letras e números.';
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
    state.pricing = me.pricing;
  } catch {
    state.me = null;
  }
}

async function route() {
  const [path, query] = location.hash.slice(2).split('?');
  const [name, id] = (path || 'servicos').split('/');
  const params = new URLSearchParams(query || '');
  if (!state.me && name !== 'login') {
    location.hash = '#/login';
    return;
  }
  const screen = screens[name] || screens.servicos;
  try {
    await screen(params, id);
  } catch (err) {
    if (state.me) view.innerHTML = `<div class="card empty">${esc(err.message)}</div>`;
  }
}

window.addEventListener('hashchange', route);
await loadMe();
if (!location.hash) location.hash = state.me ? '#/servicos' : '#/login';
else route();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
