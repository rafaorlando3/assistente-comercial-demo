// Contraexemplos da revisão do Codex (X-0051) para a demo: DEMO-01, DEMO-02 e DEMO-03.
// Escritos para rodar na base 6b43be6 (vermelho esperado) e no commit corrigido (verde).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { Assistente } from '../src/app.js';
import { criarServidor, semear } from '../src/server.js';
import { EnviadorSimulado, lerWebhook, payloadDeTeste, type Enviador } from '../src/whatsapp.js';
import { sugerirPorRegras } from '../src/regras.js';
import { extrairVisita } from '../src/texto.js';
import type { BaseConhecimento, Lead } from '../src/types.js';

const kb = JSON.parse(readFileSync(new URL('../data/base-conhecimento.json', import.meta.url), 'utf8')) as BaseConhecimento;
const AGORA = Date.parse('2026-09-28T13:00:00-03:00');

/** Aprova a sugestão atual pela API que existir: com versão (corrigido) ou sem (base). */
function aprovarAtual(a: Assistente, leadId: string, texto?: string) {
  const s = a.sugestoes.get(leadId) as unknown as { versao?: number } | undefined;
  if (s && 'versao' in s) return (a.aprovar as (id: string, o: { versao: number; texto?: string }) => Promise<void>)(leadId, { versao: s.versao!, ...(texto ? { texto } : {}) });
  return (a.aprovar as (id: string, t?: string) => Promise<void>)(leadId, texto);
}

describe('DEMO-01: demonstração nunca fala com serviços externos', () => {
  afterEach(() => vi.restoreAllMocks());
  const credenciais = { WHATSAPP_TOKEN: 'token-ficticio', WHATSAPP_PHONE_NUMBER_ID: '123', ANTHROPIC_API_KEY: 'chave-ficticia', ANTHROPIC_MODEL: 'modelo-ficticio', WHATSAPP_APP_SECRET: 'segredo-ficticio' };

  it('com credenciais no ambiente, demo recusa iniciar (ou não faz nenhuma chamada externa)', async () => {
    const externas: string[] = [];
    const original = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (u, init) => {
      const url = String(u instanceof Request ? u.url : u);
      if (!url.startsWith('http://127.0.0.1')) {
        externas.push(url);
        return new Response(JSON.stringify({ messages: [{ id: 'x' }], content: [{ type: 'text', text: '{"resposta":"oi"}' }] }), { status: 200 });
      }
      return original(u, init);
    });
    let criado: ReturnType<typeof criarServidor> | null = null;
    try {
      criado = criarServidor({ kb, cfg: { modo: 'sugerir', claude: { apiKey: 'chave-ficticia', model: 'modelo-ficticio' } }, demo: true, env: credenciais });
    } catch (e) {
      expect(String((e as Error).message)).toMatch(/demonstra/i);
      return; // recusou a configuração incoerente: nada pode ter saído
    }
    // Não recusou: então semear, simular, aprovar, avançar o relógio e follow-up não podem sair para fora.
    const { server, assistente, avancar } = criado;
    await semear(assistente, avancar);
    await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const h = { 'content-type': 'application/json' };
    const e = await (await fetch(`${base}/api/simular`, { method: 'POST', headers: h, body: JSON.stringify({ telefone: '5511999990000', nome: 'Teste', texto: 'Oi' }) })).json();
    const l = e.leads.find((x: Lead) => x.id === e.leadId) ?? e.leads.find((x: Lead) => x.telefone === '5511999990000');
    await aprovarAtual(assistente, l.id);
    await fetch(`${base}/api/relogio`, { method: 'POST', headers: h, body: JSON.stringify({ horas: 30 }) });
    server.close();
    expect(externas).toEqual([]);
  });
});

describe('DEMO-02: horário mencionado não é aceite de visita', () => {
  const lead = (texto: string): Lead => ({
    id: 'l1', telefone: '1', nome: 'Joana', origem: '', etapa: 'conversando', criadoEm: 0, ultimaDoCliente: AGORA, ultimaDaEmpresa: null,
    followUps: 0, consumoKwh: 300, cidade: 'Campinas', mensagens: [{ id: 'm', de: 'cliente', texto, em: AGORA }], notas: [],
  });
  it.each([
    'Não posso amanhã às 10h',
    'Amanhã às 10h não dá pra mim',
    'Quero cancelar a visita de amanhã às 10h',
    'Preciso remarcar, sábado às 9h não consigo',
    'Pode ser amanhã às 10h ou sábado às 9h?',
  ])('"%s" não marca visita', texto => {
    const s = sugerirPorRegras(lead(texto), kb, AGORA);
    expect(s.visita).toBeNull();
    expect(s.novaEtapa).not.toBe('visita');
    expect(s.resposta).not.toMatch(/Combinado/);
  });
  it('mesmo que o Claude devolva visita para uma negativa, a guarda do app não marca', async () => {
    const claude: typeof fetch = async () =>
      new Response(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ resposta: 'Combinado!', novaEtapa: 'visita', visita: { quando: '2026-09-29T10:00:00-03:00' } }) }] }), { status: 200 });
    const a = new Assistente(kb, new EnviadorSimulado(), { modo: 'sugerir', claude: { apiKey: 'teste', model: 'modelo-teste', fetchImpl: claude } }, () => AGORA);
    await a.receber(lerWebhook(payloadDeTeste('5519990000009', 'Joana', 'Não posso amanhã às 10h', 'c1', AGORA))[0]!);
    const s = [...a.sugestoes.values()][0]!;
    expect(s.fonte).toBe('claude');
    expect(s.visita).toBeNull();
    expect(s.novaEtapa).not.toBe('visita');
  });
  it('confirmação positiva continua marcando', () => {
    const s = sugerirPorRegras(lead('Pode ser amanhã às 10h, combinado'), kb, AGORA);
    expect(s.visita?.quando).toBe(Date.parse('2026-09-29T10:00:00-03:00'));
  });
  it.each(['dia 31/02 às 10h', 'dia 31/09 às 10h', 'dia 30/02 às 9h'])('data que não existe (%s) não vira outra data', t => {
    expect(extrairVisita(t, AGORA)).toBeNull();
  });
});

describe('DEMO-03: aprovação só vale para a sugestão que o vendedor viu', () => {
  function montar(enviador: Enviador = new EnviadorSimulado()) {
    let n = 0;
    const a = new Assistente(kb, enviador, { modo: 'sugerir' }, () => AGORA);
    const chega = (texto: string) => a.receber(lerWebhook(payloadDeTeste('5519990000009', 'Joana', texto, `m${++n}`, AGORA))[0]!);
    return { a, chega };
  }

  it('editar S1, chegar S2 (com visita), aprovar S1: nada é enviado e a visita de S2 não é aplicada', async () => {
    const env = new EnviadorSimulado();
    const { a, chega } = montar(env);
    await chega('Oi, quanto custa?');
    const id = [...a.leads.values()][0]!.id;
    const s1 = a.sugestoes.get(id)! as unknown as { versao?: number };
    await chega('Pode ser amanhã às 10h, moro em Campinas'); // S2
    const aprovarS1 =
      'versao' in s1
        ? (a.aprovar as (id: string, o: { versao: number; texto?: string }) => Promise<void>)(id, { versao: s1.versao!, texto: 'Texto editado a partir de S1' })
        : (a.aprovar as (id: string, t?: string) => Promise<void>)(id, 'Texto editado a partir de S1');
    await aprovarS1.catch(() => {});
    expect(env.enviados).toHaveLength(0);
    expect(a.visitas).toHaveLength(0);
    expect([...a.leads.values()][0]!.etapa).not.toBe('visita');
  });

  it('S1 enviando (bloqueado), chega S2, S1 termina: S2 continua pendente e intacta', async () => {
    let soltar!: () => void;
    const preso = new Promise<void>(r => (soltar = r));
    const env = new EnviadorSimulado();
    const lento: Enviador = { nome: 'lento', texto: async (t, c) => { await preso; return env.texto(t, c); }, modelo: (t, m, i, p) => env.modelo(t, m, i, p) };
    const { a, chega } = montar(lento);
    await chega('Oi');
    const id = [...a.leads.values()][0]!.id;
    const envio = aprovarAtual(a, id);
    await new Promise(r => setTimeout(r, 5));
    await chega('Minha conta vem 300 reais');
    const s2 = a.sugestoes.get(id)!;
    soltar();
    await envio;
    expect(env.enviados).toHaveLength(1);
    expect(a.sugestoes.get(id)).toBe(s2);
    expect(a.sugestoes.get(id)?.resposta).toMatch(/3,3 kWp/);
  });

  it('duas aprovações simultâneas da mesma sugestão enviam uma vez só', async () => {
    let soltar!: () => void;
    const preso = new Promise<void>(r => (soltar = r));
    const env = new EnviadorSimulado();
    const lento: Enviador = { nome: 'lento', texto: async (t, c) => { await preso; return env.texto(t, c); }, modelo: (t, m, i, p) => env.modelo(t, m, i, p) };
    const { a, chega } = montar(lento);
    await chega('Oi');
    const id = [...a.leads.values()][0]!.id;
    const p1 = aprovarAtual(a, id).catch(() => 'recusada');
    const p2 = aprovarAtual(a, id).catch(() => 'recusada');
    soltar();
    await Promise.all([p1, p2]);
    expect(env.enviados).toHaveLength(1);
  });
});
