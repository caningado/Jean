import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coordsOf } from '../src/lib/validate.js';
import { invoiceLocation } from '../src/modules/invoice/index.js';

test('invoice: link de mapa vira latitude e longitude', async () => {
  assert.equal(coordsOf('28.5383355, -81.3792371'), '28.538336, -81.379237');
  assert.equal(coordsOf('https://www.google.com/maps?q=28.5383,-81.3792'), '28.5383, -81.3792');
  assert.equal(coordsOf('https://www.google.com/maps/place/Walmart/@28.60,-81.20,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d28.6123!4d-81.2045'), '28.6123, -81.2045');
  assert.equal(coordsOf('https://waze.com/ul?ll=28.61230%2C-81.20450&navigate=yes'), '28.6123, -81.2045');
  assert.equal(coordsOf('429 Terrace Dr, Oviedo FL'), null);

  // Endereço escrito continua igual.
  assert.equal(await invoiceLocation('429 Terrace Dr, Oviedo FL 32765'), '429 Terrace Dr, Oviedo FL 32765');
  assert.equal(await invoiceLocation('https://www.google.com/maps?q=28.5383,-81.3792'), '28.5383, -81.3792');
  // Link curto: abre o link e pega as coordenadas do endereço completo.
  const fake = async (url) => ({ url: 'https://www.google.com/maps/place/X/@28.1,-81.1,17z/data=!3d28.6123!4d-81.2045', text: async () => '' });
  assert.equal(await invoiceLocation('https://maps.app.goo.gl/abc123', fake), '28.6123, -81.2045');
  // Sem internet: fica o que foi escrito (ou o link, se só tinha o link).
  const offline = async () => {
    throw new Error('offline');
  };
  assert.equal(await invoiceLocation('Walmart https://maps.app.goo.gl/abc123', offline), 'Walmart');
  assert.equal(await invoiceLocation('https://maps.app.goo.gl/abc123', offline), 'https://maps.app.goo.gl/abc123');
});
