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
    search(q, limit = 50) {
      const like = `%${q || ''}%`;
      const digits = normalizePhone(q);
      return db
        .prepare(
          `SELECT c.*, (SELECT COUNT(*) FROM services s WHERE s.contact_id = c.id) AS services_count
           FROM contacts c
           WHERE c.name LIKE ? OR (? <> '' AND c.phone LIKE ?)
           ORDER BY c.name COLLATE NOCASE LIMIT ?`
        )
        .all(like, digits, `%${digits}%`, limit);
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
    list({ status, driverId, contactId, since, limit = 100 } = {}) {
      const where = [];
      const params = [];
      if (status) {
        where.push('s.status = ?');
        params.push(status);
      }
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
  const unfolded = String(text).replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
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
      const key = line.slice(0, idx).split(';')[0].split('.').pop().toUpperCase();
      const value = line.slice(idx + 1).trim();
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
  return value.replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\n/gi, ' ').trim();
}
