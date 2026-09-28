import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { criarServidor } from '../src/server.js';
import { payloadDeTeste } from '../src/whatsapp.js';
import { dobrar } from '../src/agenda.js';
import type { BaseConhecimento } from '../src/types.js';

const kb = JSON.parse(readFileSync(new URL('../data/base-conhecimento.json', import.meta.url), 'utf8')) as BaseConhecimento;
const env = { WHATSAPP_VERIFY_TOKEN: 'verifica-123', WHATSAPP_APP_SECRET: 'segredo-app', PAINEL_USUARIO: 'vendas', PAINEL_SENHA: 'senha-forte' };
let base = '';
let fechar: () => void;
const auth = { authorization: 'Basic ' + Buffer.from('vendas:senha-forte').toString('base64') };

beforeAll(async () => {
  const { server } = criarServidor({ kb, cfg: { modo: 'sugerir' }, demo: true, env });
  await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fechar = () => server.close();
});
afterAll(() => fechar());

describe('webhook da Meta', () => {
  it('verificação: devolve o desafio só com o token certo', async () => {
    const ok = await fetch(`${base}/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=verifica-123&hub.challenge=987`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('987');
    const ruim = await fetch(`${base}/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=errado&hub.challenge=987`);
    expect(ruim.status).toBe(403);
  });

  it('assinatura: sem ou com assinatura errada é 401; certa é 200 e cria o lead', async () => {
    const corpo = JSON.stringify(payloadDeTeste('5511988887777', 'Leo Dias', 'Oi, quanto custa?', 'wamid.A1', Date.now()));
    const sem = await fetch(`${base}/webhook/whatsapp`, { method: 'POST', body: corpo, headers: { 'content-type': 'application/json' } });
    expect(sem.status).toBe(401);
    const errada = await fetch(`${base}/webhook/whatsapp`, { method: 'POST', body: corpo, headers: { 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) } });
    expect(errada.status).toBe(401);
    const sig = 'sha256=' + createHmac('sha256', 'segredo-app').update(corpo).digest('hex');
    for (let i = 0; i < 2; i++) {
      const r = await fetch(`${base}/webhook/whatsapp`, { method: 'POST', body: corpo, headers: { 'x-hub-signature-256': sig } });
      expect(r.status).toBe(200);
    }
    await new Promise(r => setTimeout(r, 50));
    const e = await (await fetch(`${base}/api/estado`, { headers: auth })).json();
    const leo = e.leads.find((l: { telefone: string }) => l.telefone === '5511988887777');
    expect(leo.mensagens).toHaveLength(1); // o reenvio não duplicou
  });
});

describe('painel', () => {
  it('pede login quando usuário e senha estão configurados', async () => {
    expect((await fetch(`${base}/api/estado`)).status).toBe(401);
    expect((await fetch(`${base}/`, { headers: auth })).status).toBe(200);
  });

  it('simula mensagem, aprova e mostra na agenda .ics', async () => {
    const h = { ...auth, 'content-type': 'application/json' };
    let e = await (await fetch(`${base}/api/simular`, { method: 'POST', headers: h, body: JSON.stringify({ telefone: '5519977776666', nome: 'Rita', texto: 'Pode ser amanhã às 10h, sou de Vinhedo' }) })).json();
    const rita = e.leads.find((l: { telefone: string }) => l.telefone === '5519977776666');
    expect(e.sugestoes[rita.id].visita).not.toBeNull();
    e = await (await fetch(`${base}/api/leads/${rita.id}/aprovar`, { method: 'POST', headers: h, body: '{}' })).json();
    expect(e.visitas.some((v: { leadId: string }) => v.leadId === rita.id)).toBe(true);
    const cal = await (await fetch(`${base}/agenda.ics`)).text();
    expect(cal).toMatch(/^BEGIN:VCALENDAR\r\n/);
    expect(cal).toContain('Rita em Vinhedo');
  });

  it('etapa inválida é recusada', async () => {
    const h = { ...auth, 'content-type': 'application/json' };
    const e = await (await fetch(`${base}/api/estado`, { headers: auth })).json();
    const r = await fetch(`${base}/api/leads/${e.leads[0].id}/etapa`, { method: 'POST', headers: h, body: JSON.stringify({ etapa: 'ganhou' }) });
    expect(r.status).toBe(400);
  });
});

it('linhas do .ics dobradas em até 75 octetos sem cortar acento', () => {
  const l = 'SUMMARY:' + 'Visita técnica: João Conceição '.repeat(6);
  const d = dobrar(l);
  for (const parte of d.split('\r\n')) expect(Buffer.byteLength(parte)).toBeLessThanOrEqual(75);
  expect(d.split('\r\n ').join('')).toBe(l);
});
