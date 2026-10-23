// Módulo agenda: marcar dia e hora para um serviço (quando for preciso) e lembrar antes.
// O serviço agendado aparece na lista com 📅 e o Jay avisa o motorista (ou o ADM, se não tiver motorista) 1 hora antes.
import { HttpError, simplify, nowIso } from '../../lib/util.js';

const REMIND_MIN = 60;
const WEEKDAYS = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'];

const migrations = [
  `ALTER TABLE services ADD COLUMN scheduled_at TEXT;
   ALTER TABLE services ADD COLUMN scheduled_reminded_at TEXT;`,
];

// Diferença do fuso (ms) num instante: hora local escrita como UTC menos o instante.
function offsetMs(timeZone, date) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - date.getTime();
}

// Dia e hora no fuso da empresa -> ISO.
export function localToIso(timeZone, y, m, d, h, mi) {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  return new Date(guess - offsetMs(timeZone, new Date(guess))).toISOString();
}

function localParts(timeZone, date) {
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone }).format(date).split('-').map(Number);
  const wd = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(date);
  return { y, m, d, wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd) };
}

// "amanhã 9h", "hoje 14:30", "24/10 8am", "sexta 10h", "2026-10-24T09:00" -> ISO (ou null).
export function parseWhen(text, timeZone, now = new Date()) {
  const raw = String(text || '').trim();
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})/);
  if (iso) return localToIso(timeZone, +iso[1], +iso[2], +iso[3], +iso[4], +iso[5]);
  const t = simplify(raw);
  const today = localParts(timeZone, now);
  let day = null;
  const dm = t.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (dm) {
    let y = dm[3] ? Number(dm[3]) : today.y;
    if (y < 100) y += 2000;
    day = { y, m: Number(dm[2]), d: Number(dm[1]) };
    // Sem ano e a data já passou: é do ano que vem.
    if (!dm[3] && (day.m < today.m || (day.m === today.m && day.d < today.d))) day.y += 1;
  } else if (/\bdepois de amanha\b/.test(t)) day = shift(today, 2);
  else if (/\bamanha\b/.test(t)) day = shift(today, 1);
  else if (/\bhoje\b/.test(t)) day = shift(today, 0);
  else {
    const wd = WEEKDAYS.findIndex((w) => new RegExp(`\\b${w}`).test(t));
    if (wd >= 0) day = shift(today, ((wd - today.wd + 7) % 7) || 7);
  }
  // Hora: 9h, 9h30, 9:30, 9am, 3pm, "as 15".
  const hm = t.match(/\b(\d{1,2})(?::(\d{2})|h(\d{2})?)\s*(am|pm)?\b/) || t.match(/\b(\d{1,2})\s*(am|pm)\b/);
  let hour = null;
  let min = 0;
  if (hm) {
    hour = Number(hm[1]);
    min = Number(hm[2] || hm[3] || 0) || 0;
    const ap = hm[4] || (hm.length === 3 ? hm[2] : null);
    if (ap === 'pm' && hour < 12) hour += 12;
    if (ap === 'am' && hour === 12) hour = 0;
  }
  if (!day && hour == null) return null;
  if (!day) day = shift(today, 0);
  if (hour == null) hour = 8;
  if (hour > 23 || min > 59 || day.m < 1 || day.m > 12 || day.d < 1 || day.d > 31) return null;
  return localToIso(timeZone, day.y, day.m, day.d, hour, min);
}

function shift({ y, m, d }, days) {
  const dt = new Date(Date.UTC(y, m - 1, d + days, 12));
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

export function formatWhen(iso, timeZone) {
  if (!iso) return '';
  return new Intl.DateTimeFormat('pt-BR', { timeZone, weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)).replace(',', '');
}

function setSchedule(ctx, serviceId, iso) {
  ctx.db.prepare('UPDATE services SET scheduled_at = ?, scheduled_reminded_at = NULL WHERE id = ?').run(iso, serviceId);
  const service = ctx.data.services.get(serviceId);
  // Agendado para depois e já estava em andamento: volta para a fila (do mesmo motorista) até começar,
  // e a data do serviço passa a ser o dia em que ele começar.
  if (iso && Date.parse(iso) > Date.now() && service.status === 'aberto') {
    ctx.data.services.update(serviceId, { status: 'pendente', driver_id: service.driver_id });
    ctx.db.prepare('UPDATE users SET active_service_id = NULL WHERE active_service_id = ?').run(serviceId);
    return ctx.data.services.get(serviceId);
  }
  return service;
}

function upcoming(ctx, user) {
  const mine = user.role === 'dono' ? '' : 'AND s.driver_id = ?';
  return ctx.db
    .prepare(
      `SELECT s.id, s.scheduled_at, s.status, s.driver_id, s.pickup, s.vehicle, c.name AS contact_name, u.name AS driver_name
       FROM services s LEFT JOIN contacts c ON c.id = s.contact_id LEFT JOIN users u ON u.id = s.driver_id
       WHERE s.scheduled_at IS NOT NULL AND s.status IN ('pendente', 'aberto') AND s.scheduled_at >= ? ${mine}
       ORDER BY s.scheduled_at`
    )
    .all(...[new Date(Date.now() - 12 * 3600000).toISOString(), ...(mine ? [user.id] : [])]);
}

const commands = [
  {
    names: ['agendar', 'agenda'],
    help: '*agendar amanhã 9h* – marca dia e hora do serviço em andamento (*agenda* mostra os agendados)',
    run({ ctx, user, args }) {
      const tz = ctx.config.timeZone;
      if (!args.length) {
        const list = upcoming(ctx, user);
        if (!list.length) return 'Nenhum serviço agendado. Para agendar: abra o serviço e mande *agendar amanhã 9h*.';
        const lines = list.map((s) => `📅 ${formatWhen(s.scheduled_at, tz)} – ${s.contact_name || s.vehicle || 'Serviço'}${s.driver_name ? ` (${s.driver_name})` : ' (sem motorista)'}`);
        return ['*Agenda*', ...lines].join('\n');
      }
      const service = ctx.data.services.active(user);
      if (!service) return 'Nenhum serviço em andamento. Mande *abrir 12* para escolher o serviço e depois *agendar amanhã 9h*.';
      const text = args.join(' ');
      if (/^(cancelar|tirar|remover|sem)$/.test(simplify(text))) {
        setSchedule(ctx, service.id, null);
        return '📅 Agendamento tirado.';
      }
      const iso = parseWhen(text, tz);
      if (!iso) return 'Não entendi o dia/hora. Ex: *agendar amanhã 9h*, *agendar 24/10 14:30*, *agendar sexta 8am*.';
      const after = setSchedule(ctx, service.id, iso);
      const fila = after.status === 'pendente' && service.status === 'aberto' ? ' Ele fica na fila até você começar; a data do serviço será o dia em que começar.' : '';
      return `📅 Serviço agendado para *${formatWhen(iso, tz)}*. Aviso 1 hora antes.${fila}`;
    },
  },
];

function routes(api, ctx) {
  // Marca ou tira (scheduled_at vazio) o dia e hora do serviço.
  api.put('/services/:id/agenda', (req, res) => {
    const service = ctx.data.services.get(Number(req.params.id));
    if (!service || (req.user.role !== 'dono' && service.driver_id !== req.user.id)) throw new HttpError(404, 'Serviço não encontrado.');
    const value = req.body?.scheduled_at;
    let iso = null;
    if (value) {
      iso = parseWhen(value, ctx.config.timeZone);
      if (!iso) throw new HttpError(400, 'Data ou hora inválida.');
    }
    res.json(setSchedule(ctx, service.id, iso));
  });

  api.get('/agenda', (req, res) => {
    res.json(upcoming(ctx, req.user));
  });
}

// Lembrete 1 hora antes: para o motorista do serviço, ou para os ADMs se ainda não tem motorista.
async function minuteTick({ ctx, now = new Date() }) {
  const limit = new Date(now.getTime() + REMIND_MIN * 60000).toISOString();
  const due = ctx.db
    .prepare(
      `SELECT s.*, c.name AS contact_name FROM services s LEFT JOIN contacts c ON c.id = s.contact_id
       WHERE s.scheduled_at IS NOT NULL AND s.scheduled_reminded_at IS NULL AND s.status IN ('pendente', 'aberto')
         AND s.scheduled_at <= ? AND s.scheduled_at >= ?`
    )
    .all(limit, new Date(now.getTime() - 3 * 3600000).toISOString());
  for (const s of due) {
    ctx.db.prepare('UPDATE services SET scheduled_reminded_at = ? WHERE id = ?').run(nowIso(), s.id);
    const people = s.driver_id
      ? [ctx.db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(s.driver_id)].filter(Boolean)
      : ctx.db.prepare("SELECT * FROM users WHERE role = 'dono' AND active = 1").all();
    for (const u of people) {
      const text = [
        `⏰ *Serviço agendado* para ${formatWhen(s.scheduled_at, ctx.config.timeZone)}`,
        s.contact_name && `Cliente: ${s.contact_name}`,
        s.pickup && `Pegar: ${s.pickup}`,
        s.vehicle && `Carro: ${s.vehicle}`,
        !s.driver_id && 'Ainda está *sem motorista*: escolha no painel.',
      ]
        .filter(Boolean)
        .join('\n');
      try {
        await ctx.send(u.phone, text);
      } catch (err) {
        ctx.log('Agenda: não consegui mandar o lembrete', err.message);
      }
    }
  }
}

export default {
  name: 'agenda',
  label: 'Agenda',
  migrations,
  commands,
  routes,
  minuteTick,
  serviceHint: '📅 Para marcar dia e hora: *agendar amanhã 9h*.',
  serviceDetail: ({ service }) => ({ scheduled_at: service.scheduled_at || null }),
};
