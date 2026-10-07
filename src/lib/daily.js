// Aviso da manhã: junta os alertas de todos os módulos (cobranças atrasadas,
// manutenção do caminhão...) e manda uma mensagem só para cada dono pelo WhatsApp.
import { nowIso } from './util.js';

// Alertas que um usuário vê agora: [{ text, href }].
export function collectAlerts(ctx, user) {
  return ctx.loaded.flatMap((m) => {
    try {
      return m.alerts?.({ ctx, user }) || [];
    } catch (err) {
      ctx.log(`Erro nos alertas do módulo ${m.name}`, err);
      return [];
    }
  });
}

function localParts(timeZone, date = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
      .formatToParts(date)
      .map((x) => [x.type, x.value])
  );
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

// Manda o aviso se já passou da hora e ainda não mandou hoje. Devolve quantas mensagens saíram.
export async function runDaily(ctx, date = new Date()) {
  const hour = ctx.config.dailyHour;
  if (hour == null) return 0;
  const { day, hour: now } = localParts(ctx.config.timeZone, date);
  if (now < hour) return 0;
  const done = ctx.db.prepare("SELECT value FROM settings WHERE key = 'daily_last'").get();
  if (done?.value === day) return 0;
  ctx.db.prepare("INSERT INTO settings (key, value) VALUES ('daily_last', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(day);

  let sent = 0;
  const owners = ctx.db.prepare("SELECT * FROM users WHERE role = 'dono' AND active = 1").all();
  for (const owner of owners) {
    const alerts = collectAlerts(ctx, owner);
    if (!alerts.length) continue;
    const text = ['☀️ *Bom dia! Atenção hoje:*', ...alerts.map((a) => `• ${a.text}`), '', 'Mande *pendentes* ou *caminhao* para ver os detalhes.'].join('\n');
    try {
      if (await ctx.send(owner.phone, text)) sent++;
    } catch (err) {
      ctx.log(`Não consegui mandar o aviso da manhã para ${owner.name}`, err);
    }
  }
  // Tarefas diárias dos módulos (ex.: lembrete de milhagem e relatório da semana).
  for (const m of ctx.loaded) {
    try {
      await m.daily?.({ ctx, day });
    } catch (err) {
      ctx.log(`Erro na tarefa diária do módulo ${m.name}`, err);
    }
  }
  ctx.log(`Aviso da manhã (${day}): ${sent} mensagem(ns) às ${nowIso()}`);
  return sent;
}

// Tarefas que os módulos conferem a cada 10 minutos (ex.: cobrança da milhagem de hora em hora).
export async function runTick(ctx, now = new Date()) {
  for (const m of ctx.loaded) {
    try {
      await m.tick?.({ ctx, now });
    } catch (err) {
      ctx.log(`Erro na tarefa do módulo ${m.name}`, err);
    }
  }
}

// Algum módulo suspendeu os serviços deste usuário? Devolve a mensagem, ou null.
export function servicesBlocked(ctx, user) {
  for (const m of ctx.loaded) {
    const msg = m.blockServices?.({ ctx, user });
    if (msg) return msg;
  }
  return null;
}

// Confere a cada 10 minutos (não segura o processo aberto).
export function startDaily(ctx) {
  const tick = () =>
    runDaily(ctx)
      .catch((err) => ctx.log('Erro no aviso da manhã', err))
      .then(() => runTick(ctx));
  setTimeout(tick, 30_000).unref();
  setInterval(tick, 10 * 60_000).unref();
}
