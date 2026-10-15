// Acesso aos dados do núcleo: equipe, contatos e serviços.
import { normalizePhone, nowIso, formatPhone, formatMoney } from '../lib/util.js';
import { mapLink } from '../lib/validate.js';

export function createCoreData(db) {
  const contacts = {
    get(id) {
      return db.prepare('SELECT * FROM contacts WHERE id = ?').get(id);
    },
    byPhone(phone) {
      const p = normalizePhone(phone);
      return p ? db.prepare('SELECT * FROM contacts WHERE phone = ?').get(p) : undefined;
    },
    search(q, limit = 50, offset = 0, recent = false) {
      const like = `%${q || ''}%`;
      const digits = normalizePhone(q);
      return db
        .prepare(
          `SELECT c.*, (SELECT COUNT(*) FROM services s WHERE s.contact_id = c.id) AS services_count
           FROM contacts c
           WHERE c.name LIKE ? OR (? <> '' AND c.phone LIKE ?)
           ORDER BY ${recent ? 'c.id DESC' : 'c.name COLLATE NOCASE'} LIMIT ? OFFSET ?`
        )
        .all(like, digits, `%${digits}%`, limit, offset);
    },
    count(q) {
      const digits = normalizePhone(q);
      return db
        .prepare(`SELECT COUNT(*) AS n FROM contacts WHERE name LIKE ? OR (? <> '' AND phone LIKE ?)`)
        .get(`%${q || ''}%`, digits, `%${digits}%`).n;
    },
    create({ name, phone, email = null, notes = null, source = 'manual' }) {
      const p = normalizePhone(phone) || null;
      const info = db
        .prepare('INSERT INTO contacts (name, phone, email, notes, source, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(name || (p ? formatPhone(p) : 'Cliente'), p, email, notes, source, nowIso());
      return contacts.get(Number(info.lastInsertRowid));
    },
    update(id, fields) {
      const current = contacts.get(id);
      if (!current) return null;
      const next = { ...current, ...fields };
      if (fields.phone !== undefined) next.phone = normalizePhone(fields.phone) || null;
      db.prepare('UPDATE contacts SET name = ?, phone = ?, email = ?, notes = ? WHERE id = ?').run(
        next.name,
        next.phone,
        next.email,
        next.notes,
        id
      );
      return contacts.get(id);
    },
    findOrCreate({ phone, name, source }) {
      return contacts.byPhone(phone) || contacts.create({ phone, name, source });
    },
    // Agenda do celular exportada em .vcf. Atualiza o nome de quem já existe.
    importVcf(text) {
      let created = 0;
      let updated = 0;
      let skipped = 0;
      for (const card of parseVcf(text)) {
        if (!card.phone) {
          skipped++;
          continue;
        }
        const existing = contacts.byPhone(card.phone);
        if (existing) {
          contacts.update(existing.id, { name: card.name || existing.name, email: card.email || existing.email });
          updated++;
        } else {
          contacts.create({ ...card, source: 'agenda' });
          created++;
        }
      }
      return { created, updated, skipped };
    },
  };

  const SERVICE_SELECT = `
    SELECT s.*, c.name AS contact_name, c.phone AS contact_phone, u.name AS driver_name
    FROM services s
    LEFT JOIN contacts c ON c.id = s.contact_id
    LEFT JOIN users u ON u.id = s.driver_id`;

  const services = {
    get(id) {
      return db.prepare(`${SERVICE_SELECT} WHERE s.id = ?`).get(id);
    },
    list({ status, driverId, contactId, since, doneSince, hideCancelled = false, withQueue = false, noDriver = false, limit = 100 } = {}) {
      const where = [];
      const params = [];
      // withQueue: "em andamento" + os que estão na fila de um motorista (aguardando ele começar).
      if (status === 'aberto' && withQueue) where.push("(s.status = 'aberto' OR (s.status = 'pendente' AND s.driver_id IS NOT NULL))");
      else if (status) {
        where.push('s.status = ?');
        params.push(status);
      }
      if (noDriver) where.push('s.driver_id IS NULL');
      if (hideCancelled) where.push("s.status <> 'cancelado'");
      if (driverId) {
        where.push('s.driver_id = ?');
        params.push(driverId);
      }
      if (contactId) {
        where.push('s.contact_id = ?');
        params.push(contactId);
      }
      if (since) {
        where.push('s.created_at >= ?');
        params.push(since);
      }
      // Entregues no período: conta pelo dia da entrega.
      if (doneSince) {
        where.push('COALESCE(s.completed_at, s.created_at) >= ?');
        params.push(doneSince);
      }
      const sql = `${SERVICE_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY s.id DESC LIMIT ?`;
      return db.prepare(sql).all(...params, limit);
    },
    create(fields) {
      const info = db
        .prepare(
          `INSERT INTO services (driver_id, contact_id, pickup, dropoff, vehicle, plate, miles, price_cents, notes, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          fields.driver_id ?? null,
          fields.contact_id ?? null,
          fields.pickup ?? null,
          fields.dropoff ?? null,
          fields.vehicle ?? null,
          fields.plate ?? null,
          fields.miles ?? null,
          fields.price_cents ?? null,
          fields.notes ?? null,
          fields.status || 'aberto',
          nowIso()
        );
      return services.get(Number(info.lastInsertRowid));
    },
    update(id, fields) {
      const allowed = ['driver_id', 'contact_id', 'pickup', 'dropoff', 'vehicle', 'plate', 'vin', 'vin_info', 'miles', 'price_cents', 'notes', 'status'];
      const keys = Object.keys(fields).filter((k) => allowed.includes(k));
      if (keys.length) {
        db.prepare(`UPDATE services SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(
          ...keys.map((k) => fields[k] ?? null),
          id
        );
      }
      if (fields.status === 'concluido') {
        db.prepare('UPDATE services SET completed_at = COALESCE(completed_at, ?) WHERE id = ?').run(nowIso(), id);
      }
      return services.get(id);
    },
    // O serviço "em mãos" do motorista: é nele que entram fotos, VIN e pagamentos mandados pelo WhatsApp.
    active(user) {
      const fresh = db.prepare('SELECT active_service_id FROM users WHERE id = ?').get(user.id);
      if (!fresh?.active_service_id) return null;
      const service = services.get(fresh.active_service_id);
      return service && service.status === 'aberto' ? service : null;
    },
    setActive(userId, serviceId) {
      db.prepare('UPDATE users SET active_service_id = ? WHERE id = ?').run(serviceId, userId);
    },
    describe(s) {
      const lines = [`*Serviço #${s.id}*`];
      if (s.contact_name) lines.push(`Cliente: ${s.contact_name}${s.contact_phone ? ' ' + formatPhone(s.contact_phone) : ''}`);
      // Com o link, o motorista toca e abre o mapa para navegar.
      if (s.pickup) lines.push(`Retirada: ${s.pickup}`, `🗺️ ${mapLink(s.pickup)}`);
      if (s.dropoff) lines.push(`Destino: ${s.dropoff}`, `🗺️ ${mapLink(s.dropoff)}`);
      if (s.vehicle || s.plate) lines.push(`Veículo: ${[s.vehicle, s.plate].filter(Boolean).join(' · ')}`);
      if (s.vin) lines.push(`VIN: ${s.vin}`);
      if (s.miles != null) lines.push(`Milhas: ${s.miles}`);
      if (s.price_cents != null) lines.push(`Valor: ${formatMoney(s.price_cents)}`);
      lines.push(`Situação: ${s.status === 'aberto' ? 'em andamento' : s.status === 'concluido' ? 'entregue' : s.status === 'pendente' ? 'pendente (na fila, sem motorista)' : s.status}`);
      return lines.join('\n');
    },
  };

  const users = {
    get(id) {
      return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    },
    list() {
      return db.prepare('SELECT * FROM users ORDER BY role DESC, name').all();
    },
    count() {
      return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    },
  };

  return { contacts, services, users };
}

// Lê um arquivo .vcf (pode ter vários contatos). Fica com o primeiro telefone de cada um.
export function parseVcf(text) {
  const lines = [];
  for (const line of String(text).replace(/\r\n?/g, '\n').split('\n')) {
    const prev = lines.at(-1);
    // Quoted-printable (vCard 2.1, Android): linha que termina em "=" continua na próxima.
    if (prev?.qp && prev.text.endsWith('=')) prev.text = prev.text.slice(0, -1) + line.trimStart();
    else if (prev && /^[ \t]/.test(line)) prev.text += line.slice(1);
    else lines.push({ text: line, qp: /QUOTED-PRINTABLE/i.test(line.split(':')[0]) });
  }
  const unfolded = lines.map((l) => l.text).join('\n');
  const cards = [];
  let current = null;
  for (const line of unfolded.split('\n')) {
    const upper = line.toUpperCase();
    if (upper.startsWith('BEGIN:VCARD')) current = { name: '', phone: '', email: '' };
    else if (upper.startsWith('END:VCARD')) {
      if (current) cards.push(current);
      current = null;
    } else if (current) {
      const idx = line.indexOf(':');
      if (idx < 0) continue;
      const params = line.slice(0, idx).toUpperCase();
      const key = params.split(';')[0].split('.').pop();
      let value = line.slice(idx + 1).trim();
      if (params.includes('QUOTED-PRINTABLE')) value = decodeQuotedPrintable(value);
      if (key === 'FN' && value) current.name = decodeVcfText(value);
      else if (key === 'N' && !current.name) {
        const [last, first] = value.split(';');
        current.name = decodeVcfText([first, last].filter(Boolean).join(' '));
      } else if (key === 'TEL' && !current.phone) current.phone = value.replace(/^tel:/i, '');
      else if (key === 'EMAIL' && !current.email) current.email = value;
    }
  }
  return cards;
}

function decodeVcfText(value) {
  return cleanName(value.replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\n/gi, ' '));
}

// =C3=A9 → é (bytes UTF-8 escritos em hexa).
export function decodeQuotedPrintable(value) {
  const bytes = [];
  for (let i = 0; i < value.length; i++) {
    const hex = value[i] === '=' && value.slice(i + 1, i + 3);
    if (hex && /^[0-9A-F]{2}$/i.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else if (value[i] !== '=') bytes.push(...Buffer.from(value[i]));
  }
  return Buffer.from(bytes).toString('utf8');
}

// Tira marcas invisíveis (‎) e troca letras "enfeitadas" (𝐂𝐥𝐚𝐮𝐝𝐢𝐨) pelas normais.
export function cleanName(value) {
  return String(value)
    .normalize('NFKC')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Nomes que já entraram codificados (=E2=80=8E=43...) por uma importação antiga.
export function repairEncodedNames(db) {
  const rows = db.prepare("SELECT id, name FROM contacts WHERE name LIKE '=%'").all();
  const update = db.prepare('UPDATE contacts SET name = ? WHERE id = ?');
  let fixed = 0;
  for (const { id, name } of rows) {
    if (!/^(=[0-9A-F]{2})+=?$/i.test(name)) continue;
    const decoded = cleanName(decodeQuotedPrintable(name.replace(/=$/, '')).replace(/\uFFFD/g, ''));
    if (!decoded) continue;
    update.run(decoded.slice(0, 60), id);
    fixed++;
  }
  return fixed;
}
