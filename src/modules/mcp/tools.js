// Ferramentas que o Claude usa no sistema. Todas passam pelas MESMAS regras do painel
// (ctx.api.servicos, pagamentos, VIN) e cada ação fica registrada como feita pelo Claude:
// no histórico do serviço (service_events, source 'claude') e no registro mcp_actions.
// Não existe ferramenta de apagar.
import { z } from 'zod';
import { formatMoney, formatPhone, normalizePhone, simplify, nowIso } from '../../lib/util.js';
import { mapLink } from '../../lib/validate.js';
import { routeLines } from '../../lib/rotas.js';
import { zonedMidnight } from '../planilha/index.js';
import { applyAction } from '../voz/index.js';

export const SOURCE = 'claude';

// ---------- registro de quem fez ----------

export function logAction(ctx, user, serviceId, tool, details = {}, eventAction = null) {
  ctx.db
    .prepare('INSERT INTO mcp_actions (service_id, tool, details, user_id, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(serviceId ?? null, tool, JSON.stringify(details), user.id, nowIso());
  if (eventAction && serviceId && hasTable(ctx, 'service_events')) {
    ctx.db
      .prepare('INSERT INTO service_events (service_id, action, user_id, source, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(serviceId, eventAction, user.id, SOURCE, nowIso());
  }
}

const hasTable = (ctx, name) => !!ctx.db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name);
const hasColumn = (ctx, table, col) => !!ctx.db.prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name = ?`).get(col);

// ---------- textos ----------

const STATUS_TEXT = { pendente: 'pendente', aberto: 'em andamento', concluido: 'entregue', cancelado: 'cancelado' };
const STAGE_TEXT = { coletado: 'carro pego', entregando: 'indo entregar' };

function statusText(s) {
  if (s.status === 'pendente' && !s.driver_id) return 'pendente sem motorista (cotação)';
  if (s.status === 'pendente') return `na fila de ${s.driver_name}`;
  if (s.status === 'aberto' && s.stage && STAGE_TEXT[s.stage]) return `em andamento (${STAGE_TEXT[s.stage]})`;
  return STATUS_TEXT[s.status] || s.status;
}

function firmOf(ctx, s) {
  if (!s.driver_id) return null;
  const firm = ctx.db.prepare('SELECT firm FROM users WHERE id = ?').get(s.driver_id)?.firm || 'jj';
  return ctx.api.servicos.firmName(firm);
}

function payInfo(ctx, s) {
  if (!ctx.api.pagamentos || s.status === 'cancelado') return null;
  const b = ctx.api.pagamentos.balance(s);
  const price = s.price_cents || 0;
  const paid = price > 0 ? b.open_cents === 0 && b.to_receive_cents === 0 : null;
  return { ...b, paid };
}

function payText(p, s) {
  if (!p) return '';
  if (s.price_cents == null) return 'sem preço';
  if (s.price_cents === 0) return 'grátis';
  if (p.paid) return 'pago';
  const parts = [];
  if (p.received_cents) parts.push(`recebido ${formatMoney(p.received_cents)}`);
  if (p.to_receive_cents) parts.push(`a receber da seguradora ${formatMoney(p.to_receive_cents)}`);
  if (p.open_cents) parts.push(`falta ${formatMoney(p.open_cents)}`);
  return parts.join(', ') || 'não pago';
}

function line(ctx, s) {
  const p = payInfo(ctx, s);
  return [
    `#${s.id}`,
    statusText(s),
    s.contact_name || 'sem cliente',
    s.vehicle,
    [s.pickup, s.dropoff].filter(Boolean).join(' → '),
    s.price_cents != null ? (s.price_cents === 0 ? 'Free' : formatMoney(s.price_cents)) : null,
    payText(p, s),
    s.driver_name ? `motorista: ${s.driver_name}` : null,
    firmOf(ctx, s),
  ]
    .filter(Boolean)
    .join(' · ');
}

const ok = (text) => ({ content: [{ type: 'text', text }] });
const fail = (text) => ({ content: [{ type: 'text', text }], isError: true });

// Erros das regras (400, 404, 409...) voltam como texto para o Claude explicar ao dono.
function safe(ctx, fn) {
  return async (args) => {
    try {
      return await fn(args || {});
    } catch (err) {
      if (err.status && err.status < 500) {
        const options = err.options?.length ? `\nOpções: ${err.options.join(' | ')}` : '';
        return fail(`${err.message}${options}`);
      }
      ctx.log('MCP: erro na ferramenta', err);
      return fail('Erro no servidor. Tente de novo.');
    }
  };
}

function getService(ctx, numero) {
  const s = ctx.data.services.get(Number(numero));
  if (!s) {
    const e = new Error(`Não achei o serviço #${numero}.`);
    e.status = 404;
    throw e;
  }
  return s;
}

function userError(message) {
  const e = new Error(message);
  e.status = 400;
  return e;
}

// Motorista pelo nome ("Jorge"), "eu" (o dono) ou "nenhum".
export function findDriver(ctx, user, name) {
  const key = simplify(name);
  if (['eu', 'mim', 'comigo'].includes(key)) return user;
  const team = ctx.db.prepare("SELECT * FROM users WHERE active = 1 AND (role = 'motorista' OR drives = 1 OR id = ?) ORDER BY name").all(user.id);
  const exact = team.filter((u) => simplify(u.name) === key);
  const first = team.filter((u) => simplify(u.name).split(' ')[0] === key.split(' ')[0]);
  const found = exact.length ? exact : first;
  if (found.length === 1) return found[0];
  throw userError(
    found.length
      ? `Tem mais de um motorista com esse nome: ${found.map((u) => u.name).join(', ')}. Qual deles?`
      : `Não achei o motorista "${name}". A equipe é: ${team.map((u) => u.name).join(', ')}.`
  );
}

const NONE = (v) => ['nenhum', 'ninguem', 'sem motorista', 'nao', 'none'].includes(simplify(v));

function checkVinArg(ctx, vin, conferido) {
  if (!vin) return null;
  if (!ctx.api.vin) throw userError('O módulo de VIN está desligado.');
  const check = ctx.api.vin.validate(vin);
  if (check.vin.length !== 17) throw userError(check.reason);
  if (!check.valid && !conferido) throw userError(`${check.reason} VIN lido: ${check.vin}. Confira com o dono; se ele confirmar que está certo, mande de novo com vin_conferido = true.`);
  return check.vin;
}

// Situação pedida -> filtro.
const STATUS_FILTER = { pendente: 'pendente', em_andamento: 'aberto', entregue: 'concluido', cancelado: 'cancelado' };

function dayRange(ctx, day) {
  const tz = ctx.config.timeZone;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
  const d = !day || simplify(day) === 'hoje' ? today : simplify(day) === 'ontem' ? shift(today, -1) : simplify(day) === 'amanha' ? shift(today, 1) : day;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw userError('Data inválida. Use AAAA-MM-DD, "hoje", "ontem" ou "amanhã".');
  const at = (x, plus = 0) => {
    const [y, m, dd] = x.split('-').map(Number);
    const n = new Date(Date.UTC(y, m - 1, dd + plus));
    return zonedMidnight(n.getUTCFullYear(), n.getUTCMonth() + 1, n.getUTCDate(), tz);
  };
  return { day: d, start: at(d), end: at(d, 1) };
}
function shift(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// ---------- ferramentas ----------

export function registerTools(server, ctx, user) {
  const { data } = ctx;
  const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
  const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const CONFIRM = 'Antes de chamar, leia os dados para o dono em voz alta e só chame depois que ele disser que está certo.';

  // 1. Criar serviço
  server.registerTool(
    'criar_servico',
    {
      title: 'Criar serviço',
      description: `Cria um serviço de guincho no sistema. ${CONFIRM} Obrigatórios: cliente (cliente_id da busca, ou nome e/ou telefone), retirada, destino, veículo (marca e modelo, ou VIN) e preço. Se faltar algo, a ferramenta diz o que falta e não cria nada. Sem motorista, o serviço fica pendente sem motorista, que no sistema é uma cotação (QUOTE): pergunte ao dono quem vai fazer. Use buscar_cliente antes, para não duplicar cliente.`,
      inputSchema: {
        cliente_id: z.number().int().optional().describe('Id do cliente achado em buscar_cliente'),
        cliente_nome: z.string().optional(),
        cliente_telefone: z.string().optional().describe('Com código de área, ex.: 508 555 0123'),
        marca: z.string().optional(),
        modelo: z.string().optional(),
        ano: z.string().optional(),
        cor: z.string().optional(),
        placa: z.string().optional(),
        vin: z.string().optional().describe('VIN de 17 caracteres (ex.: lido da foto que o dono mandou)'),
        vin_conferido: z.boolean().optional().describe('true só se o dono confirmou um VIN cujo dígito verificador não bateu'),
        retirada: z.string().optional().describe('Endereço, coordenadas ou link de mapa de onde pegar o carro'),
        destino: z.string().optional().describe('Endereço de entrega'),
        endereco_conferido: z.boolean().optional().describe('true se o dono confirmou o endereço do jeito que está, quando o mapa não achou'),
        preco: z.union([z.number(), z.string()]).optional().describe('Preço em dólares, ex.: 180, ou "free"'),
        forma_pagamento: z.string().optional().describe('Forma de pagamento combinada (Zelle, dinheiro, cartão, Square, cheque, Brasil, seguradora)'),
        observacoes: z.string().optional(),
        motorista: z.string().optional().describe('Nome de quem vai fazer, "eu" para o dono, ou "nenhum"'),
        mesmo_incompleto: z.boolean().optional().describe('true só se o dono mandou criar mesmo faltando dados'),
      },
      annotations: write,
    },
    safe(ctx, async (a) => {
      const vehicle = [a.ano, a.marca, a.modelo, a.cor].map((v) => (v == null ? '' : String(v).trim())).filter(Boolean).join(' ');
      const missing = [];
      if (!a.cliente_id && !a.cliente_nome && !a.cliente_telefone) missing.push('cliente (nome ou telefone)');
      if (!a.retirada) missing.push('endereço de retirada');
      if (!a.destino) missing.push('endereço de entrega');
      if (!a.marca && !a.modelo && !a.vin) missing.push('veículo (marca e modelo)');
      if (a.preco == null || a.preco === '') missing.push('preço');
      if (!a.retirada) return ok(`Não criei. Falta: ${missing.join(', ')}. O endereço de retirada é obrigatório no sistema.`);
      if (missing.length && !a.mesmo_incompleto) return ok(`Não criei ainda. Falta: ${missing.join(', ')}. Pergunte ao dono, ou chame de novo com mesmo_incompleto = true se ele mandar criar assim.`);
      const vin = checkVinArg(ctx, a.vin, a.vin_conferido);
      let driverId = null;
      if (a.motorista && !NONE(a.motorista)) driverId = findDriver(ctx, user, a.motorista).id;
      const notes = [a.observacoes?.trim(), a.forma_pagamento ? `Pagamento combinado: ${a.forma_pagamento.trim()}` : null].filter(Boolean).join('\n') || null;
      const body = {
        contact_id: a.cliente_id || undefined,
        contact_name: a.cliente_nome,
        contact_phone: a.cliente_telefone,
        pickup: a.retirada,
        dropoff: a.destino,
        vehicle: vehicle || undefined,
        plate: a.placa,
        price: a.preco == null ? undefined : String(a.preco),
        notes,
        driver_id: driverId,
        address_ok: a.endereco_conferido || undefined,
      };
      const { status, service } = await ctx.api.servicos.create(user, body);
      if (status === 200) return ok(`Esse serviço já tinha sido criado agora há pouco: ${line(ctx, service)}`);
      let s = service;
      if (vin) s = (await ctx.api.vin.save(s, vin)).service;
      logAction(ctx, user, s.id, 'criar_servico', { args: a }, 'criado_servico');
      if (vin) logAction(ctx, user, s.id, 'vin', { vin }, 'vin_salvo');
      s = data.services.get(s.id);
      const lines = [`Serviço #${s.id} criado.`, line(ctx, s)];
      if (s.contact_phone && a.cliente_nome && simplify(s.contact_name) !== simplify(a.cliente_nome)) lines.push(`Atenção: esse telefone já era do cliente "${s.contact_name}"; o serviço ficou no nome dele.`);
      if (s.pickup) lines.push(`Retirada no mapa: ${mapLink(s.pickup)}`);
      if (s.dropoff) lines.push(`Entrega no mapa: ${mapLink(s.dropoff)}`);
      return ok(lines.join('\n'));
    })
  );

  // 2. Listar serviços
  server.registerTool(
    'listar_servicos',
    {
      title: 'Listar serviços',
      description:
        'Lista os serviços de um dia (padrão: hoje). Cada serviço conta num dia só: o da entrega, ou o dia em que foi aberto se ainda não foi entregue (mesma regra do relatório do dia). Use data = "todas" para ver sem filtro de data (os mais recentes). Situação: pendente, em_andamento, entregue, cancelado, pago, nao_pago. Sem situação, mostra todos menos cancelados.',
      inputSchema: {
        data: z.string().optional().describe('"hoje", "ontem", "amanhã", AAAA-MM-DD ou "todas"'),
        situacao: z.enum(['pendente', 'em_andamento', 'entregue', 'cancelado', 'pago', 'nao_pago']).optional(),
        motorista: z.string().optional().describe('Nome do motorista, ou "eu"'),
        limite: z.number().int().min(1).max(200).optional(),
      },
      annotations: read,
    },
    safe(ctx, async (a) => {
      const all = simplify(a.data) === 'todas';
      const range = all ? null : dayRange(ctx, a.data);
      const status = STATUS_FILTER[a.situacao] || null;
      const driverId = a.motorista ? findDriver(ctx, user, a.motorista).id : null;
      let list = data.services.list({
        status,
        driverId,
        doneSince: range?.start,
        doneUntil: range?.end,
        hideCancelled: !status,
        limit: all ? a.limite || 30 : 2000,
      });
      if (a.situacao === 'pago' || a.situacao === 'nao_pago') {
        if (!ctx.api.pagamentos) return fail('O módulo de pagamentos está desligado.');
        list = list.filter((s) => (a.situacao === 'pago' ? payInfo(ctx, s)?.paid === true : payInfo(ctx, s)?.paid === false));
      }
      if (!all && a.limite) list = list.slice(0, a.limite);
      const title = all ? 'Serviços mais recentes' : `Serviços de ${range.day}`;
      if (!list.length) return ok(`${title}: nenhum${a.situacao ? ` (${a.situacao.replace('_', ' ')})` : ''}.`);
      return ok([`${title} (${list.length}):`, ...list.map((s) => `- ${line(ctx, s)}`)].join('\n'));
    })
  );

  // 3. Ver um serviço
  server.registerTool(
    'ver_servico',
    {
      title: 'Ver serviço',
      description:
        'Mostra todos os detalhes de um serviço, com link do Google Maps da retirada e da entrega. Quando o dono pedir o endereço, fale o endereço e mostre o link na tela como link clicável.',
      inputSchema: { numero: z.number().int().describe('Número do serviço (#)') },
      annotations: read,
    },
    safe(ctx, async ({ numero }) => {
      const s = getService(ctx, numero);
      const p = payInfo(ctx, s);
      const out = [`Serviço #${s.id} · ${statusText(s)}`];
      const firm = firmOf(ctx, s);
      if (firm) out.push(`Empresa: ${firm}`);
      if (s.contact_name) out.push(`Cliente: ${s.contact_name}${s.contact_phone ? ` · ${formatPhone(s.contact_phone)}` : ''}`);
      if (s.vehicle || s.plate) out.push(`Veículo: ${[s.vehicle, s.plate].filter(Boolean).join(' · ')}`);
      if (s.vin) out.push(`VIN: ${s.vin}`);
      if (s.pickup) out.push(`Retirada: ${s.pickup}`, `Mapa da retirada: ${mapLink(s.pickup)}`);
      if (s.dropoff) out.push(`Entrega: ${s.dropoff}`, `Mapa da entrega: ${mapLink(s.dropoff)}`);
      if (s.pickup && s.dropoff && !/https?:/.test(s.pickup + s.dropoff)) {
        out.push(`Rota: https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(s.pickup)}&destination=${encodeURIComponent(s.dropoff)}`);
      }
      if (s.miles != null) out.push(`Milhas: ${s.miles}`);
      if (s.price_cents != null) out.push(`Preço: ${s.price_cents === 0 ? 'Free' : formatMoney(s.price_cents)}`);
      if (p) out.push(`Pagamento: ${payText(p, s)}`);
      if (ctx.api.pagamentos) {
        for (const pay of ctx.api.pagamentos.list(s.id)) {
          out.push(`  • ${formatMoney(pay.amount_cents)} ${ctx.api.pagamentos.methods[pay.method] || pay.method}${pay.payer ? ` (${pay.payer})` : ''} – ${pay.status === 'recebido' ? 'recebido' : 'a receber'}`);
        }
      }
      if (s.driver_name) out.push(`Motorista: ${s.driver_name}`);
      if (s.notes) out.push(`Observações: ${s.notes}`);
      out.push(`Aberto em: ${s.created_at}${s.completed_at ? ` · entregue em: ${s.completed_at}` : ''}`);
      if (hasTable(ctx, 'service_events')) {
        const events = ctx.db
          .prepare('SELECT e.action, e.source, e.created_at, u.name FROM service_events e LEFT JOIN users u ON u.id = e.user_id WHERE e.service_id = ? ORDER BY e.id')
          .all(s.id);
        if (events.length) {
          out.push('Histórico:');
          for (const e of events) out.push(`  • ${e.created_at} ${e.action} – ${e.name || ''}${e.source === SOURCE ? ' (pelo Claude)' : e.source === 'voz' ? ' (voz no app)' : ''}`);
        }
      }
      return ok(out.join('\n'));
    })
  );

  // 4. Atualizar status
  server.registerTool(
    'atualizar_status',
    {
      title: 'Atualizar situação do serviço',
      description: `Muda a situação do serviço: comecar, peguei_o_carro, indo_entregar, entregue (dá baixa como concluído) ou cancelado. ${CONFIRM} Para cancelar, pergunte o motivo. Se o cliente pagou na entrega, depois use marcar_pago.`,
      inputSchema: {
        numero: z.number().int(),
        acao: z.enum(['comecar', 'peguei_o_carro', 'indo_entregar', 'entregue', 'cancelado']),
        motivo: z.string().optional().describe('Motivo do cancelamento'),
      },
      annotations: { ...write, destructiveHint: true },
    },
    safe(ctx, async ({ numero, acao, motivo }) => {
      const s = getService(ctx, numero);
      const map = { comecar: 'iniciar_servico', peguei_o_carro: 'peguei_o_carro', indo_entregar: 'indo_entregar', entregue: 'finalizar_servico', cancelado: 'cancelar_servico' };
      let result;
      if (ctx.has('voz')) {
        result = applyAction(ctx, user, s, map[acao], { confirm: true, source: SOURCE });
        if (acao === 'cancelado' && motivo) {
          const fresh = data.services.get(s.id);
          data.services.update(s.id, { notes: [fresh.notes, `Cancelado: ${motivo.trim().slice(0, 300)}`].filter(Boolean).join('\n') }, user.id);
        }
      } else {
        const status = { comecar: 'aberto', peguei_o_carro: 'aberto', indo_entregar: 'aberto', entregue: 'concluido', cancelado: 'cancelado' }[acao];
        if (s.status === status && acao !== 'comecar') result = { updated: s, notices: [] };
        else result = ctx.api.servicos.change(user, s, { status }, motivo);
        logAction(ctx, user, s.id, 'atualizar_status', { acao }, map[acao]);
      }
      if (ctx.has('voz')) logAction(ctx, user, s.id, 'atualizar_status', { acao, motivo: motivo || null });
      const updated = data.services.get(s.id);
      const notices = (result.notices || []).map((n) => (typeof n === 'string' ? n : n.text || JSON.stringify(n)));
      return ok([`Serviço #${s.id}: ${statusText(updated)}.`, line(ctx, updated), ...notices].join('\n'));
    })
  );

  // 5. Marcar como pago
  server.registerTool(
    'marcar_pago',
    {
      title: 'Registrar pagamento',
      description: `Registra o pagamento de um serviço. Sem valor, registra o que falta pagar. Formas: zelle, dinheiro, cartao, square (entra como cartão), cheque, brasil (cliente pagou no Brasil, ex.: pix; valor em dólar), seguradora (motor club; ponha o nome em pagador; fica "a receber"). ${CONFIRM}`,
      inputSchema: {
        numero: z.number().int(),
        forma: z.enum(['zelle', 'dinheiro', 'cartao', 'square', 'cheque', 'brasil', 'seguradora']),
        valor: z.union([z.number(), z.string()]).optional().describe('Valor em dólares; sem valor = o que falta'),
        pagador: z.string().optional().describe('Nome da seguradora/motor club, quando for seguradora'),
        confirmado_por: z.string().optional().describe('Quem confirmou o pagamento (ex.: "eu", "Jorge")'),
      },
      annotations: write,
    },
    safe(ctx, async (a) => {
      if (!ctx.api.pagamentos) return fail('O módulo de pagamentos está desligado.');
      const s = getService(ctx, a.numero);
      if (s.status === 'cancelado') return fail('Esse serviço está cancelado.');
      const method = a.forma === 'square' ? 'cartao' : a.forma;
      const left = ctx.api.pagamentos.balance(s).open_cents;
      let cents;
      if (a.valor == null || a.valor === '') {
        if (!left) return fail(s.price_cents == null ? 'O serviço não tem preço. Diga o valor pago.' : 'Esse serviço não tem nada faltando para pagar.');
        cents = left;
      } else {
        const n = Number(String(a.valor).replace(/[$,\s]/g, ''));
        if (!Number.isFinite(n) || n <= 0 || n > 20000) return fail('Valor inválido.');
        cents = Math.round(n * 100);
      }
      const payer = method === 'seguradora' ? a.pagador?.trim() || null : a.forma === 'square' ? 'Square' : null;
      const payment = ctx.api.pagamentos.add({ serviceId: s.id, amountCents: cents, method, payer, userId: user.id });
      await ctx.api.pagamentos.notify([{ service: s, payment }], user.id);
      logAction(ctx, user, s.id, 'marcar_pago', { valor: cents / 100, forma: a.forma, pagador: payer, confirmado_por: a.confirmado_por || null }, 'pagamento');
      const fresh = data.services.get(s.id);
      return ok(`Pagamento de ${formatMoney(cents)} (${ctx.api.pagamentos.methods[method]}${payer ? `, ${payer}` : ''}) registrado no serviço #${s.id}${a.confirmado_por ? `, confirmado por ${a.confirmado_por}` : ''}. Situação do pagamento: ${payText(payInfo(ctx, fresh), fresh)}.`);
    })
  );

  // Milhas pelo Google Maps e preço sugerido (pelo que o dono já cobrou). Não grava nada.
  server.registerTool(
    'calcular_preco',
    {
      title: 'Calcular milhas e preço',
      description:
        'Calcula as milhas de carro entre a retirada e o destino pelo Google Maps e sugere um preço, aprendido com os serviços que o dono já fez (da mesma empresa do cliente, quando tem). Não grava nada. Use antes de perguntar o preço ao dono e leia a sugestão para ele: quem decide o preço é sempre o dono. Se já souber as milhas, mande em milhas.',
      inputSchema: {
        retirada: z.string().optional().describe('Endereço, coordenadas ou link de mapa de onde pegar'),
        destino: z.string().optional().describe('Endereço, coordenadas ou link de mapa de onde entregar'),
        milhas: z.number().optional().describe('Milhas, se já souber (aí não usa o Google Maps)'),
        cliente_id: z.number().int().optional().describe('Id do cliente (de buscar_cliente), para usar o preço da empresa dele'),
      },
      annotations: { ...read, openWorldHint: true },
    },
    safe(ctx, async (a) => {
      const servicos = ctx.api.servicos;
      let miles = Number(a.milhas) > 0 ? Number(a.milhas) : null;
      const out = [];
      if (miles == null && a.retirada && a.destino) {
        if (!ctx.rotas) out.push('O Google Maps ainda não está ligado no sistema (falta a chave GOOGLE_MAPS_API_KEY no Render): pergunte as milhas ao dono.');
        else {
          const r = await servicos.route(a.retirada, a.destino);
          if (r) {
            miles = r.miles;
            out.push(...routeLines(r));
            if (r.has_tolls) out.push('O valor do pedágio é o de carro: o guincho com carro em cima pode pagar mais. A sugestão de preço usa as milhas da rota com pedágio; se o dono for pela rota sem pedágio, chame de novo com milhas.');
          } else out.push('O Google Maps não achou a rota entre esses dois endereços. Confira os endereços ou pergunte as milhas ao dono.');
        }
      }
      const sug = servicos.priceSuggestion(miles, { contactId: a.cliente_id || null });
      out.push(sug ? sug.texto : 'Ainda não dá para sugerir preço: pergunte ao dono.');
      out.push('Confirme o preço com o dono antes de criar o serviço.');
      return ok(out.join('\n'));
    })
  );

  // 6. Buscar cliente
  server.registerTool(
    'buscar_cliente',
    {
      title: 'Buscar cliente',
      description:
        'Procura cliente pelo telefone, nome ou apelido. Se vierem vários (ex.: dez "Luan"), leia para o dono o telefone, o último carro e os endereços de cada um, e pergunte qual é. Cada telefone é de um cliente só.',
      inputSchema: { busca: z.string().min(1) },
      annotations: read,
    },
    safe(ctx, async ({ busca }) => {
      const digits = normalizePhone(busca);
      let rows;
      const nick = hasColumn(ctx, 'contacts', 'nickname');
      if (digits.length >= 4 && digits.length >= String(busca).replace(/\s/g, '').length - 4) {
        rows = ctx.db.prepare('SELECT * FROM contacts WHERE phone LIKE ? ORDER BY name LIMIT 30').all(`%${digits.slice(-10)}%`);
      } else {
        const key = simplify(busca);
        rows = ctx.db
          .prepare(`SELECT * FROM contacts ORDER BY name COLLATE NOCASE`)
          .all()
          .filter((c) => simplify(c.name).includes(key) || (nick && c.nickname && simplify(c.nickname).includes(key)))
          .slice(0, 30);
      }
      if (!rows.length) return ok(`Nenhum cliente achado para "${busca}".`);
      const out = [`${rows.length} cliente(s) para "${busca}":`];
      for (const c of rows) {
        const services = ctx.db.prepare("SELECT vehicle, pickup, dropoff FROM services WHERE contact_id = ? AND status <> 'cancelado' ORDER BY id DESC LIMIT 20").all(c.id);
        const places = [...new Set(services.flatMap((s) => [s.pickup, s.dropoff]).filter(Boolean))].slice(0, 4);
        const lastCar = services.find((s) => s.vehicle)?.vehicle;
        out.push(
          `- id ${c.id}: ${c.name}${nick && c.nickname ? ` ("${c.nickname}")` : ''} · ${c.phone ? formatPhone(c.phone) : 'sem telefone'} · ${services.length} serviço(s)${lastCar ? ` · último carro: ${lastCar}` : ''}${places.length ? ` · endereços: ${places.join(' | ')}` : ''}`
        );
      }
      return ok(out.join('\n'));
    })
  );

  server.registerTool(
    'apelido_cliente',
    {
      title: 'Dar apelido ao cliente',
      description: `Grava um apelido no cadastro do cliente (ex.: "Luan mecânico"), para achar depois pela busca. Apelido vazio apaga o apelido. ${CONFIRM}`,
      inputSchema: { cliente_id: z.number().int(), apelido: z.string() },
      annotations: write,
    },
    safe(ctx, async ({ cliente_id, apelido }) => {
      const c = data.contacts.get(cliente_id);
      if (!c) return fail('Cliente não encontrado.');
      const value = String(apelido).trim().slice(0, 60) || null;
      ctx.db.prepare('UPDATE contacts SET nickname = ? WHERE id = ?').run(value, c.id);
      logAction(ctx, user, null, 'apelido_cliente', { cliente_id: c.id, apelido: value });
      return ok(value ? `Apelido "${value}" gravado para ${c.name}.` : `Apelido de ${c.name} apagado.`);
    })
  );

  // Atualizar dados do serviço (inclui o VIN)
  server.registerTool(
    'atualizar_servico',
    {
      title: 'Alterar dados do serviço',
      description: `Altera dados de um serviço: VIN (ex.: lido da foto que o dono mandou), veículo, placa, retirada, destino, preço, observações ou cliente. Só mande os campos que mudam. ${CONFIRM}`,
      inputSchema: {
        numero: z.number().int(),
        vin: z.string().optional(),
        vin_conferido: z.boolean().optional().describe('true só se o dono confirmou um VIN cujo dígito verificador não bateu'),
        veiculo: z.string().optional().describe('Ano, marca, modelo e cor, ex.: "2018 Honda Civic preto"'),
        placa: z.string().optional(),
        retirada: z.string().optional(),
        destino: z.string().optional(),
        endereco_conferido: z.boolean().optional(),
        preco: z.union([z.number(), z.string()]).optional(),
        observacoes: z.string().optional().describe('Substitui as observações'),
        observacoes_adicionar: z.string().optional().describe('Acrescenta uma linha nas observações'),
        cliente_id: z.number().int().optional(),
      },
      annotations: write,
    },
    safe(ctx, async (a) => {
      const s = getService(ctx, a.numero);
      const vin = checkVinArg(ctx, a.vin, a.vin_conferido);
      const body = {};
      if (a.veiculo !== undefined) body.vehicle = a.veiculo;
      if (a.placa !== undefined) body.plate = a.placa;
      if (a.retirada !== undefined) body.pickup = a.retirada;
      if (a.destino !== undefined) body.dropoff = a.destino;
      if (a.preco !== undefined) body.price = String(a.preco);
      if (a.observacoes !== undefined) body.notes = a.observacoes;
      if (a.observacoes_adicionar) body.notes = [a.observacoes ?? s.notes, a.observacoes_adicionar.trim()].filter(Boolean).join('\n');
      if (a.cliente_id !== undefined) body.contact_id = a.cliente_id;
      if (a.endereco_conferido) body.address_ok = true;
      const changed = Object.keys(body).filter((k) => k !== 'address_ok');
      if (!changed.length && !vin) return fail('Nada para mudar.');
      if (changed.length) await ctx.api.servicos.edit(user, s, body);
      if (vin) {
        await ctx.api.vin.save(data.services.get(s.id), vin);
        logAction(ctx, user, s.id, 'vin', { vin }, 'vin_salvo');
      }
      if (changed.length) logAction(ctx, user, s.id, 'atualizar_servico', { args: a }, 'editado');
      const fresh = data.services.get(s.id);
      return ok([`Serviço #${s.id} alterado.`, line(ctx, fresh), fresh.vin ? `VIN: ${fresh.vin}` : null].filter(Boolean).join('\n'));
    })
  );

  // 7. Atribuir motorista
  server.registerTool(
    'atribuir_motorista',
    {
      title: 'Escolher motorista',
      description: `Escolhe quem faz o serviço: o nome do motorista, "eu" (o dono) ou "nenhum" (volta para pendente sem motorista). Serviço pendente entra na fila do motorista; em andamento troca de motorista. ${CONFIRM}`,
      inputSchema: { numero: z.number().int(), motorista: z.string() },
      annotations: write,
    },
    safe(ctx, async ({ numero, motorista }) => {
      const s = getService(ctx, numero);
      if (!['pendente', 'aberto'].includes(s.status)) return fail('Serviço entregue ou cancelado não troca de motorista.');
      const none = NONE(motorista);
      const driver = none ? null : findDriver(ctx, user, motorista);
      if (s.status === 'pendente') ctx.api.servicos.pass(user, s, none ? null : driver.id);
      else ctx.api.servicos.change(user, s, { driver_id: none ? null : driver.id });
      logAction(ctx, user, s.id, 'atribuir_motorista', { motorista: driver?.name || null }, 'motorista');
      const fresh = data.services.get(s.id);
      return ok(`Serviço #${s.id}: ${statusText(fresh)}.`);
    })
  );

  server.registerTool(
    'equipe',
    {
      title: 'Ver equipe',
      description: 'Lista os motoristas (e o dono, quando ele também dirige), com a empresa de cada um e o que está em andamento.',
      inputSchema: {},
      annotations: read,
    },
    safe(ctx, async () => {
      const team = ctx.db.prepare("SELECT * FROM users WHERE active = 1 AND (role = 'motorista' OR drives = 1 OR id = ?) ORDER BY name").all(user.id);
      const out = team.map((u) => {
        const busy = ctx.db.prepare("SELECT id FROM services WHERE driver_id = ? AND status = 'aberto' ORDER BY id").all(u.id).map((r) => `#${r.id}`);
        return `- ${u.name}${u.id === user.id ? ' (você)' : ''} · ${ctx.api.servicos.firmName(u.firm || 'jj')}${busy.length ? ` · em andamento: ${busy.join(', ')}` : ''}`;
      });
      return ok(out.join('\n'));
    })
  );
}
