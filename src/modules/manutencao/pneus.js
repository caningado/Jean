// Posições dos pneus do guincho (rodado duplo atrás), vistas de cima com a frente para cima.
export const TIRES = {
  de: 'Dianteiro esquerdo',
  dd: 'Dianteiro direito',
  tef: 'Traseiro esquerdo de fora',
  tei: 'Traseiro esquerdo de dentro',
  tdi: 'Traseiro direito de dentro',
  tdf: 'Traseiro direito de fora',
};
export const tiresText = (tires) => String(tires || '').split(',').filter((t) => TIRES[t]).map((t) => TIRES[t]).join(', ');
// Nome do serviço com os pneus, ex.: "Troca de pneu (Dianteiro esquerdo)".
export const withTires = (l) => (l.tires ? `${l.item_name} (${tiresText(l.tires)})` : l.item_name);
