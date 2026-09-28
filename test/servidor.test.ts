import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { criarServidor, semear } from '../src/server.js';
import { payloadDeTeste } from '../src/whatsapp.js';
import { dobrar } from '../src/agenda.js';
import type { BaseConhecimento } from '../src/types.js';

const kb = JSON.parse(readFileSync(new URL('../data/base-conhecimento.json', import.meta.url), 'utf8')) as BaseConhecimento;
// Modo real, mas sem WHATSAPP_TOKEN: envio simulado. Nenhuma chamada sai do processo.
const envReal = { WHATSAPP_VERIFY_TOKEN: 'verifica-123', WHATSAPP_APP_SECRET: 'segredo-app', PAINEL_USUARIO: 'vendas', PAINEL_SENHA: 'senha-forte', AGENDA_TOKEN: 'agenda-xyz' };
const auth = { authorization: 'Basic ' + Buffer.from('vendas:senha-forte').toString('base64') };
let real = '';
let demo = '';
const fechar: (() => void)[] = [];

async function subir(opts: Parameters<typeof criarServidor>[0], semente = false) {
  const c = criarServidor(opts);
  if (semente) await semear(c.assistente, c.avancar);
  await new Promise<void>(ok => c.server.listen(0, '127.0.0.1', ok));
  fechar.push(() => c.server.close());
  return `http://127.0.0.1:${(c.server.address() as AddressInfo).port}`;
}
beforeAll(async () => {
  real = await subir({ kb, cfg: { modo: 'sugerir' }, demo: false, env: envReal });
  demo = await subir({ kb, cfg: { modo: 'sugerir' }, demo: true, env: {} }, true);
});
afterAll(() => fechar.forEach(f => f()));

describe('configuração', () => {
  it('uso real sem login do painel não inicia', () => {
    expect(() => criarServidor({ kb, cfg: { modo: 'sugerir' }, demo: false, env: { PAINEL_USUARIO: 'x' } })).toThrow(/PAINEL_USUARIO e PAINEL_SENHA/);
  });
  it('demonstração com qualquer credencial externa não inicia', () => {
    for (const k of ['WHATSAPP_TOKEN', 'WHATSAPP_APP_SECRET', 'ANTHROPIC_API_KEY'])
      expect(() => criarServidor({ kb, cfg: { modo: 'sugerir' }, demo: true, env: { [k]: 'ficticio' } })).toThrow(new RegExp(k));
  });
});

describe('webhook da Meta (modo real)', () => {
  it('verificação: devolve o desafio só com o token certo', async () => {
    const ok = await fetch(`${real}/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=verifica-123&hub.challenge=987`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('987');
    const ruim = await fetch(`${real}/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=errado&hub.challenge=987`);
    expect(ruim.status).toBe(403);
  });

  it('assinatura: sem ou com assinatura errada é 401; certa é 200 e cria o lead uma vez', async () => {
    const corpo = JSON.stringify(payloadDeTeste('5511988887777', 'Leo Dias', 'Oi, quanto custa?', 'wamid.A1', Date.now()));
    const sem = await fetch(`${real}/webhook/whatsapp`, { method: 'POST', body: corpo, headers: { 'content-type': 'application/json' } });
    expect(sem.status).toBe(401);
    const errada = await fetch(`${real}/webhook/whatsapp`, { method: 'POST', body: corpo, headers: { 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) } });
    expect(errada.status).toBe(401);
    const sig = 'sha256=' + createHmac('sha256', 'segredo-app').update(corpo).digest('hex');
    for (let i = 0; i < 2; i++) {
      const r = await fetch(`${real}/webhook/whatsapp`, { method: 'POST', body: corpo, headers: { 'x-hub-signature-256': sig } });
      expect(r.status).toBe(200);
    }
    await new Promise(r => setTimeout(r, 50));
    const e = await (await fetch(`${real}/api/estado`, { headers: auth })).json();
    const leo = e.leads.find((l: { telefone: string }) => l.telefone === '5511988887777');
    expect(leo.mensagens).toHaveLength(1);
  });

  it('painel e agenda pedem login ou token; o simulador não existe no modo real', async () => {
    expect((await fetch(`${real}/api/estado`)).status).toBe(401);
    expect((await fetch(`${real}/`, { headers: auth })).status).toBe(200);
    expect((await fetch(`${real}/agenda.ics`)).status).toBe(401);
    expect((await fetch(`${real}/agenda.ics?token=errado`)).status).toBe(401);
    expect((await fetch(`${real}/agenda.ics?token=agenda-xyz`)).status).toBe(200);
    expect((await fetch(`${real}/agenda.ics`, { headers: auth })).status).toBe(200);
    const sim = await fetch(`${real}/api/simular`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: '{"texto":"oi"}' });
    expect(sim.status).toBe(404);
  });
});

describe('demonstração', () => {
  const h = { 'content-type': 'application/json' };
  it('webhook desligado', async () => {
    expect((await fetch(`${demo}/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=x&hub.challenge=1`)).status).toBe(404);
  });

  it('simula lead com identidade fictícia, aprova a versão vista e mostra na agenda .ics', async () => {
    let e = await (await fetch(`${demo}/api/simular`, { method: 'POST', headers: h, body: JSON.stringify({ nome: 'Rita', texto: 'Pode ser amanhã às 10h, sou de Vinhedo', telefone: '5519977776666' }) })).json();
    const rita = e.leads.find((l: { id: string }) => l.id === e.leadId);
    expect(rita.telefone).toMatch(/^5500000/); // telefone enviado pelo visitante é ignorado
    const s = e.sugestoes[rita.id];
    expect(s.visita).not.toBeNull();
    const semVersao = await fetch(`${demo}/api/leads/${rita.id}/aprovar`, { method: 'POST', headers: h, body: '{}' });
    expect(semVersao.status).toBe(400);
    e = await (await fetch(`${demo}/api/leads/${rita.id}/aprovar`, { method: 'POST', headers: h, body: JSON.stringify({ versao: s.versao }) })).json();
    expect(e.visitas.some((v: { leadId: string }) => v.leadId === rita.id)).toBe(true);
    const cal = await (await fetch(`${demo}/agenda.ics`)).text();
    expect(cal).toMatch(/^BEGIN:VCALENDAR\r\n/);
    expect(cal).toContain('Rita em Vinhedo');
  });

  it('aprovar uma versão antiga devolve 409 com o estado atual e não envia', async () => {
    let e = await (await fetch(`${demo}/api/simular`, { method: 'POST', headers: h, body: JSON.stringify({ texto: 'Oi' }) })).json();
    const id = e.leadId;
    const v1 = e.sugestoes[id].versao;
    e = await (await fetch(`${demo}/api/simular`, { method: 'POST', headers: h, body: JSON.stringify({ leadId: id, texto: 'Pode ser amanhã às 11h' }) })).json();
    const r = await fetch(`${demo}/api/leads/${id}/aprovar`, { method: 'POST', headers: h, body: JSON.stringify({ versao: v1, texto: 'texto antigo' }) });
    expect(r.status).toBe(409);
    const j = await r.json();
    const lead = j.estado.leads.find((l: { id: string }) => l.id === id);
    expect(lead.mensagens.filter((m: { de: string }) => m.de === 'empresa')).toHaveLength(0);
    expect(j.estado.visitas.some((v: { leadId: string }) => v.leadId === id)).toBe(false);
  });

  it('limites: texto cortado em 500 caracteres; reiniciar volta aos dados de exemplo', async () => {
    const e = await (await fetch(`${demo}/api/simular`, { method: 'POST', headers: h, body: JSON.stringify({ texto: 'x'.repeat(2000) }) })).json();
    expect(e.leads.find((l: { id: string }) => l.id === e.leadId).mensagens[0].texto).toHaveLength(500);
    const r = await (await fetch(`${demo}/api/reiniciar`, { method: 'POST', headers: h, body: '{}' })).json();
    expect(r.leads.map((l: { nome: string }) => l.nome).sort()).toEqual(['Ana Paula', 'Carlos Lima', 'Mariana Souza']);
  });

  it('etapa inválida é recusada', async () => {
    const e = await (await fetch(`${demo}/api/estado`)).json();
    const r = await fetch(`${demo}/api/leads/${e.leads[0].id}/etapa`, { method: 'POST', headers: h, body: JSON.stringify({ etapa: 'ganhou' }) });
    expect(r.status).toBe(400);
  });
});

it('linhas do .ics dobradas em até 75 octetos sem cortar acento', () => {
  const l = 'SUMMARY:' + 'Visita técnica: João Conceição '.repeat(6);
  const d = dobrar(l);
  for (const parte of d.split('\r\n')) expect(Buffer.byteLength(parte)).toBeLessThanOrEqual(75);
  expect(d.split('\r\n ').join('')).toBe(l);
});
