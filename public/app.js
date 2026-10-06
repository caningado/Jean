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
const STATUS = { aberto: 'Em andamento', concluido: 'Entregue', cancelado: 'Cancelado' };
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
function placeHtml(icon, location) {
  if (!location) return '';
  const label = location.replace(/https?:\/\/[^\s]+/gi, '').trim() || 'Local pelo link do mapa';
  return `<div class="place">${icon} ${esc(label)} <a href="${esc(mapLink(location))}" target="_blank" rel="noopener">Abrir no mapa</a></div>`;
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
  if (!res.ok) throw new Error(data?.error || 'Algo deu errado.');
  return data;
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
  view.innerHTML = `
    <div class="segmented">
      <button data-s="aberto">Em andamento</button><button data-s="concluido">Entregues</button><button data-s="">Todos</button>
    </div>
    <div class="card"><ul class="list" id="list"><li class="empty">Carregando…</li></ul></div>`;
  view.querySelectorAll('.segmented button').forEach((b) => {
    b.classList.toggle('active', b.dataset.s === status);
    b.onclick = () => (location.hash = `#/servicos?status=${b.dataset.s}`);
  });
  const list = await api(`/services?status=${status}`);
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
    : '<li class="empty">Nenhum serviço aqui.</li>';
};

screens.novo = async () => {
  setScreen('Novo serviço', { tab: 'novo' });
  const drivers = state.me.role === 'dono' ? await api('/users') : [];
  const { pricing } = state;
  const priced = pricing && (pricing.baseCents || pricing.perMileCents);
  view.innerHTML = `
    <form class="card" id="f">
      <label>Telefone do cliente</label><input name="contact_phone" type="tel" list="contacts" placeholder="(508) 555-0123">
      <label>Nome do cliente</label><input name="contact_name">
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
      ${drivers.length ? `<label>Motorista</label><select name="driver_id">${drivers.filter((d) => d.active).map((d) => `<option value="${d.id}" ${d.id === state.me.id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select>` : ''}
      <label>Observações</label><textarea name="notes" rows="2"></textarea>
      <button class="block">Criar serviço</button>
    </form>`;
  const form = view.querySelector('#f');
  // Ao digitar o telefone, completa o nome se o cliente já estiver na agenda.
  form.contact_phone.onchange = async () => {
    const q = form.contact_phone.value.replace(/\D/g, '');
    if (q.length < 7 || form.contact_name.value) return;
    const found = await api(`/contacts?q=${q}`);
    if (found.length === 1) form.contact_name.value = found[0].name;
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
      if (body.driver_id) body.driver_id = Number(body.driver_id);
      const service = await api('/services', { method: 'POST', body });
      toast(`Serviço #${service.id} criado`);
      location.hash = `#/servico/${service.id}`;
    } catch (err) {
      toast(err.message);
    }
  };
};

screens.servico = async (params, id) => {
  setScreen(`Serviço #${id}`, { tab: 'servicos', back: '#/servicos' });
  const s = await api(`/services/${id}`);
  const vehicleInfo = s.vin_info ? [s.vin_info.year, s.vin_info.make, s.vin_info.model, s.vin_info.body].filter(Boolean).join(' · ') : '';
  const b = s.balance;

  view.innerHTML = `
    <div class="card">
      <div class="row" style="display:flex;justify-content:space-between;align-items:center">
        <h2 style="margin:0">${esc(s.contact_name || 'Sem cliente')}</h2>
        <span class="badge ${s.status}">${STATUS[s.status]}</span>
      </div>
      ${s.contact_phone ? `<p><a href="tel:+${s.contact_phone}">📞 ${phoneFmt(s.contact_phone)}</a> · <a href="https://wa.me/${s.contact_phone}" target="_blank" rel="noopener">WhatsApp</a></p>` : ''}
      ${placeHtml('📍', s.pickup)}${placeHtml('🏁', s.dropoff)}
      <p>🚗 ${esc([s.vehicle, s.plate].filter(Boolean).join(' · ') || 'Veículo não informado')}</p>
      ${s.miles != null ? `<p class="sub">${s.miles} milhas</p>` : ''}
      <p class="big">${s.price_cents != null ? money(s.price_cents) : 'Sem valor'}</p>
      <p class="sub">${when(s.created_at)}${s.driver_name ? ' · ' + esc(s.driver_name) : ''}</p>
      ${s.notes ? `<p>${esc(s.notes)}</p>` : ''}
      <div class="actions">
        ${s.status === 'aberto' ? '<button id="done">✅ Entregue</button>' : '<button class="secondary" id="reopen">Reabrir</button>'}
        <button class="secondary" id="edit">Editar</button>
      </div>
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
      ${s.photos?.length ? `<div class="photos">${s.photos.map((p) => `<figure><a href="${p.url}" target="_blank"><img src="${p.url}" loading="lazy" alt="Foto ${PHOTO_KINDS[p.kind]}"></a><figcaption>${PHOTO_KINDS[p.kind]}</figcaption></figure>`).join('')}</div>` : '<p class="sub">Nenhuma foto. São opcionais.</p>'}
      <div class="actions">
        <button class="secondary" data-photo="antes">📷 Antes</button>
        <button class="secondary" data-photo="depois">📷 Depois</button>
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
    </div>` : ''}`;

  const reload = () => screens.servico(params, id);
  const on = (sel, fn) => view.querySelector(sel) && (view.querySelector(sel).onclick = fn);

  on('#done', async () => {
    await api(`/services/${id}`, { method: 'PATCH', body: { status: 'concluido' } });
    toast('Serviço entregue');
    reload();
  });
  on('#reopen', async () => {
    await api(`/services/${id}`, { method: 'PATCH', body: { status: 'aberto' } });
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
      const file = await pickPhoto();
      if (!file) return;
      btn.disabled = true;
      try {
        await api(`/services/${id}/photos?kind=${btn.dataset.photo}`, { method: 'POST', raw: await shrinkImage(file), type: 'image/jpeg' });
        toast('Foto salva');
        reload();
      } catch (err) {
        toast(err.message);
        btn.disabled = false;
      }
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
      ${drivers.length ? `<label>Motorista</label><select name="driver_id">${drivers.map((d) => `<option value="${d.id}" ${d.id === s.driver_id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select>` : ''}
      <label>Situação</label><select name="status">${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${k === s.status ? 'selected' : ''}>${v}</option>`).join('')}</select>
      <label>Observações</label><textarea name="notes" rows="3">${esc(s.notes)}</textarea>
      <button class="block">Salvar</button>
    </form>`;
  view.querySelector('#f').onsubmit = async (e) => {
    e.preventDefault();
    const body = formData(e.target);
    body.miles = body.miles === '' ? null : Number(body.miles);
    if (body.driver_id) body.driver_id = Number(body.driver_id);
    try {
      await api(`/services/${id}`, { method: 'PATCH', body });
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
      ${state.me.role === 'dono' ? '<button class="secondary" id="import">📥 Importar agenda (.vcf)</button>' : ''}
    </div>
    <div class="card"><ul class="list" id="list"><li class="empty">Carregando…</li></ul></div>`;
  view.querySelector('#search').onsubmit = (e) => {
    e.preventDefault();
    location.hash = `#/contatos?q=${encodeURIComponent(e.target.q.value)}`;
  };
  view.querySelector('#add').onclick = () => (location.hash = '#/contato/novo');
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
    : '<li class="empty">Nenhum contato. Importe a agenda do celular (.vcf) ou adicione um.</li>';
};

screens.contato = async (params, id) => {
  const isNew = id === 'novo';
  setScreen(isNew ? 'Novo contato' : 'Contato', { tab: 'contatos', back: '#/contatos' });
  const c = isNew ? { services: [] } : await api(`/contacts/${id}`);
  view.innerHTML = `
    <form class="card" id="f">
      <label>Nome</label><input name="name" value="${esc(c.name)}" required>
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
      const body = formData(e.target);
      const saved = isNew ? await api('/contacts', { method: 'POST', body }) : await api(`/contacts/${id}`, { method: 'PATCH', body });
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
    <div class="segmented"><button data-p="dia">Hoje</button><button data-p="mes">Este mês</button></div>
    <div class="stats">
      ${stat('Serviços', `${s.services}`)}
      ${stat('Faturado', money(s.billed_cents))}
      ${s.received_cents != null ? stat('Recebido', money(s.received_cents)) : ''}
      ${s.expenses_cents != null ? stat('Despesas', money(s.expenses_cents)) : ''}
    </div>
    ${s.received_cents != null && s.expenses_cents != null ? `<div class="card"><div class="sub">Saldo (recebido − despesas)</div><div class="big">${money(s.received_cents - s.expenses_cents)}</div></div>` : ''}
    ${s.received_by_method ? `<div class="card"><h2>Recebido por forma</h2><ul class="list">${Object.entries(s.received_by_method).map(([k, v]) => `<li><div class="row"><span>${METHODS[k]}</span><span>${money(v)}</span></div></li>`).join('') || '<li class="empty">Nada recebido.</li>'}</ul></div>` : ''}
    ${s.cash_by_driver && Object.keys(s.cash_by_driver).length ? `<div class="card"><h2>💵 Dinheiro com cada motorista</h2><ul class="list">${Object.entries(s.cash_by_driver).map(([k, v]) => `<li><div class="row"><span>${esc(k)}</span><span>${money(v)}</span></div></li>`).join('')}</ul></div>` : ''}
    ${s.open_cents || s.to_receive_cents ? `<div class="card"><h2>Pendências (todas)</h2><p>Clientes: ${money(s.open_cents)}<br>Seguradoras: ${money(s.to_receive_cents)}</p><a class="btn secondary" href="#/pendentes">Ver lista</a></div>` : ''}
    ${s.expenses_by_category && Object.keys(s.expenses_by_category).length ? `<div class="card"><h2>Despesas</h2><ul class="list">${Object.entries(s.expenses_by_category).map(([k, v]) => `<li><div class="row"><span>${CATEGORIES[k] || k}</span><span>${money(v)}</span></div></li>`).join('')}</ul></div>` : ''}`;
  view.querySelectorAll('.segmented button').forEach((b) => {
    b.classList.toggle('active', b.dataset.p === period);
    b.onclick = () => (location.hash = `#/resumo?p=${b.dataset.p}`);
  });
};

screens.pendentes = async () => {
  setScreen('Pendências', { tab: 'resumo', back: '#/resumo' });
  const list = await api('/payments/pending');
  view.innerHTML = `<div class="card"><ul class="list">${
    list.length
      ? list.map((s) => `<li><a href="#/servico/${s.id}"><div><strong>#${s.id} ${esc(s.contact_name || '')}</strong><div class="sub">${when(s.created_at)}</div></div>
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
      ${state.me.role === 'dono' ? '<li><a href="#/equipe"><span>👥 Equipe</span><span>›</span></a></li>' : ''}
      <li><a href="#/robo"><span>💬 Testar o robô do WhatsApp</span><span>›</span></a></li>
      <li><a href="#/sair"><span>🚪 Sair</span><span>›</span></a></li>
    </ul></div>
    <p class="sub">Dica: no navegador do celular, use "Adicionar à tela inicial" para abrir como aplicativo.</p>`;
};

screens.despesas = async () => {
  setScreen('Despesas', { tab: 'mais', back: '#/mais' });
  const list = await api('/expenses');
  view.innerHTML = `
    <form class="card" id="f">
      <h2>Nova despesa</h2>
      <div class="row2">
        <div><label>Valor</label><input name="amount" inputmode="decimal" required></div>
        <div><label>Tipo</label><select name="category">${Object.entries(CATEGORIES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
      </div>
      <label>Descrição</label><input name="description" placeholder="Diesel, pedágio I-90…">
      <button class="block">Registrar</button>
    </form>
    <div class="card"><ul class="list">${
      list.length
        ? list.map((e) => `<li><div class="row"><div>${CATEGORIES[e.category] || e.category}${e.description ? ' · ' + esc(e.description) : ''}<div class="sub">${when(e.created_at)}${state.me.role === 'dono' && e.user_name ? ' · ' + esc(e.user_name) : ''}</div></div>
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
