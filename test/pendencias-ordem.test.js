import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sortPending } from '../src/modules/pagamentos/index.js';

const list = [
  { id: 1, days: 30, open_cents: 10000, to_receive_cents: 0, contact_name: 'Thyago' },
  { id: 2, days: 5, open_cents: 50000, to_receive_cents: 0, contact_name: 'ana' },
  { id: 3, days: 12, open_cents: 0, to_receive_cents: 20000, company_name: 'Polax', contact_name: 'Zé' },
];
const ids = (order) => sortPending(list, order).map((s) => s.id);

test('Pendências: ordenar por data, maior valor e nome', () => {
  assert.deepEqual(ids(''), [1, 3, 2]); // padrão: mais antigo primeiro
  assert.deepEqual(ids('data'), [1, 3, 2]);
  assert.deepEqual(ids('recente'), [2, 3, 1]);
  assert.deepEqual(ids('valor'), [2, 3, 1]); // cliente + seguradora
  assert.deepEqual(ids('nome'), [2, 3, 1]); // ana, Polax (empresa), Thyago
  assert.deepEqual(list.map((s) => s.id), [1, 2, 3]); // não mexe na lista original
});
