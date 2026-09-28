import { describe, expect, it } from 'vitest';
import { detectarObjecao, extrairCidade, extrairConsumo, extrairVisita, formatarQuando, pediuParaSair, cidadeMencionada } from '../src/texto.js';

// Segunda-feira, 28/09/2026, 13h em Brasília.
const AGORA = Date.parse('2026-09-28T13:00:00-03:00');
const br = (s: string) => Date.parse(`${s}-03:00`);

describe('objeções', () => {
  it.each([
    ['Achei meio caro', 'preco'],
    ['Tá muito salgado pra mim', 'preco'],
    ['Vou pensar e depois te falo', 'pensar'],
    ['preciso ver com minha esposa', 'pensar'],
    ['Já tenho orçamento de outra empresa', 'concorrente'],
    ['Dá pra parcelar? Tem financiamento?', 'financiamento'],
    ['Isso não é golpe né?', 'confianca'],
    ['Meu telhado tem muita sombra', 'telhado'],
    ['Oi, quero saber mais', null],
  ])('%s → %s', (t, esperado) => expect(detectarObjecao(t)).toBe(esperado));
});

describe('consumo', () => {
  it('kWh explícito', () => expect(extrairConsumo('gasto uns 450 kWh por mês', 1)).toBe(450));
  it('valor da conta em reais, pela tarifa de referência', () => {
    expect(extrairConsumo('minha conta vem uns 380 reais', 1)).toBe(380);
    expect(extrairConsumo('Pago R$ 500,00 de luz', 1.25)).toBe(400);
  });
  it('sem número de consumo, nada', () => expect(extrairConsumo('quero saber o preço', 1)).toBeNull());
});

describe('cidade', () => {
  const cidades = ['Campinas', 'Sumaré', 'Paulínia'];
  it('acha cidade atendida, com ou sem acento', () => {
    expect(extrairCidade('moro em sumare', cidades)).toBe('Sumaré');
    expect(extrairCidade('Sou de Campinas.', cidades)).toBe('Campinas');
  });
  it('cidade fora da lista é só mencionada', () => {
    expect(extrairCidade('moro em Jundiaí', cidades)).toBeNull();
    expect(cidadeMencionada('moro em Jundiaí')).toBe('Jundiaí');
  });
});

describe('horário de visita (Brasília)', () => {
  it.each([
    ['pode ser amanhã às 10h', br('2026-09-29T10:00:00')],
    ['sábado 9h30 fica bom', br('2026-10-03T09:30:00')],
    ['hoje 16h', br('2026-09-28T16:00:00')],
    ['dia 05/10 às 14:00', br('2026-10-05T14:00:00')],
    ['segunda às 8h', br('2026-10-05T08:00:00')], // hoje é segunda e 8h já passou
    ['depois de amanhã 11 horas', br('2026-09-30T11:00:00')],
  ])('%s', (t, esperado) => expect(extrairVisita(t, AGORA)).toBe(esperado));
  it('sem dia não adivinha; horário fora do expediente ou já passado não vale', () => {
    expect(extrairVisita('às 10h', AGORA)).toBeNull();
    expect(extrairVisita('amanhã às 23h', AGORA)).toBeNull();
    expect(extrairVisita('hoje às 9h', AGORA)).toBeNull();
    expect(extrairVisita('consumo 450 kwh amanhã', AGORA)).toBeNull();
  });
  it('dia do mês já passado vai para o mês seguinte', () => expect(extrairVisita('dia 10 às 9h', AGORA)).toBe(br('2026-10-10T09:00:00')));
  it('formata em português', () => expect(formatarQuando(br('2026-10-03T09:30:00'))).toBe('sábado 03/10 às 09h30'));
});

it('pedido para sair', () => {
  expect(pediuParaSair('Não tenho interesse, pare de mandar mensagem')).toBe(true);
  expect(pediuParaSair('tenho interesse sim')).toBe(false);
});
