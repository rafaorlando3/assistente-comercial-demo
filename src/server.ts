// Servidor HTTP sem dependências: painel, API do painel, webhook do WhatsApp e agenda .ics.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Assistente, ETAPAS, type Config } from './app.js';
import type { BaseConhecimento, Etapa } from './types.js';
import { assinaturaValida, EnviadorCloudApi, EnviadorSimulado, lerWebhook, payloadDeTeste, verificarAssinaturaDoWebhook } from './whatsapp.js';
import { ics } from './agenda.js';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export type Opcoes = {
  kb: BaseConhecimento;
  cfg: Config;
  demo: boolean;
  env: NodeJS.ProcessEnv;
};

function corpo(req: IncomingMessage, limite = 256 * 1024): Promise<Buffer> {
  return new Promise((ok, falha) => {
    const partes: Buffer[] = [];
    let n = 0;
    req.on('data', (c: Buffer) => {
      n += c.length;
      if (n > limite) {
        falha(new Error('corpo grande demais'));
        req.destroy();
      } else partes.push(c);
    });
    req.on('end', () => ok(Buffer.concat(partes)));
    req.on('error', falha);
  });
}
function json(res: ServerResponse, status: number, dado: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(dado));
}
function igual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
/** Basic auth no painel quando PAINEL_USUARIO e PAINEL_SENHA estão definidos. */
function autorizado(req: IncomingMessage, env: NodeJS.ProcessEnv): boolean {
  const u = env.PAINEL_USUARIO;
  const s = env.PAINEL_SENHA;
  if (!u || !s) return true;
  const h = req.headers.authorization ?? '';
  if (!h.startsWith('Basic ')) return false;
  const [du, ds] = Buffer.from(h.slice(6), 'base64').toString().split(':');
  return igual(du ?? '', u) && igual(ds ?? '', s);
}

export function criarServidor(o: Opcoes) {
  const { env } = o;
  let deslocamento = 0; // relógio da demonstração: "avançar horas" para ver o follow-up
  const relogio = () => Date.now() + deslocamento;
  const enviador =
    env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID
      ? new EnviadorCloudApi(env.WHATSAPP_TOKEN, env.WHATSAPP_PHONE_NUMBER_ID, env.GRAPH_API_VERSION || 'v21.0')
      : new EnviadorSimulado();
  const a = new Assistente(o.kb, enviador, o.cfg, relogio);
  const html = readFileSync(path.join(raiz, 'public', 'index.html'));

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const p = url.pathname;

      if (p === '/health') return json(res, 200, { ok: true });

      if (p === '/webhook/whatsapp' && req.method === 'GET') {
        const desafio = verificarAssinaturaDoWebhook(url.searchParams, env.WHATSAPP_VERIFY_TOKEN);
        if (desafio === null) return json(res, 403, { erro: 'token de verificação inválido' });
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end(desafio);
      }
      if (p === '/webhook/whatsapp' && req.method === 'POST') {
        const bruto = await corpo(req);
        if (!env.WHATSAPP_APP_SECRET) return json(res, 503, { erro: 'defina WHATSAPP_APP_SECRET para aceitar webhooks reais' });
        if (!assinaturaValida(bruto, req.headers['x-hub-signature-256'] as string | undefined, env.WHATSAPP_APP_SECRET))
          return json(res, 401, { erro: 'assinatura inválida' });
        // Responde 200 logo; a Meta reenvia se demorar. O processamento é idempotente pelo ID da mensagem.
        json(res, 200, { ok: true });
        for (const m of lerWebhook(JSON.parse(bruto.toString('utf8')))) await a.receber(m).catch(() => {});
        return;
      }

      if (p === '/agenda.ics') {
        const t = env.AGENDA_TOKEN;
        if (t && !igual(url.searchParams.get('token') ?? '', t)) return json(res, 403, { erro: 'token' });
        res.writeHead(200, { 'content-type': 'text/calendar; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(ics(a.visitas, a.kb.empresa, 60, relogio()));
      }

      if (!autorizado(req, env)) {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="painel"' });
        return res.end('login necessário');
      }

      if (p === '/' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(html);
      }
      if (p === '/api/estado' && req.method === 'GET') return json(res, 200, { ...a.estado(), demo: o.demo });
      if (p === '/api/resumo' && req.method === 'GET') return json(res, 200, { texto: a.resumo() });

      if (req.method === 'POST' && p.startsWith('/api/')) {
        const b = JSON.parse((await corpo(req, 32 * 1024)).toString('utf8') || '{}') as Record<string, unknown>;
        const m = p.match(/^\/api\/leads\/([\w-]+)\/(aprovar|descartar|etapa|follow-up)$/);
        if (m) {
          const [, id, acao] = m;
          if (acao === 'aprovar') await a.aprovar(id!, typeof b.texto === 'string' ? b.texto : undefined);
          else if (acao === 'descartar') a.descartar(id!);
          else if (acao === 'follow-up') await a.enviarFollowUp(id!);
          else if (acao === 'etapa') {
            if (!ETAPAS.includes(b.etapa as Etapa)) return json(res, 400, { erro: 'etapa inválida' });
            a.mudarEtapa(id!, b.etapa as Etapa);
          }
          return json(res, 200, a.estado());
        }
        if (o.demo && p === '/api/simular') {
          const tel = String(b.telefone ?? '').replace(/\D/g, '');
          const texto = String(b.texto ?? '').trim();
          if (tel.length < 10 || !texto) return json(res, 400, { erro: 'telefone e texto' });
          const payload = payloadDeTeste(tel, String(b.nome ?? ''), texto, `sim-${relogio()}-${Math.random().toString(36).slice(2, 8)}`, relogio());
          for (const r of lerWebhook(payload)) await a.receber(r);
          return json(res, 200, a.estado());
        }
        if (o.demo && p === '/api/relogio') {
          const h = Number(b.horas);
          if (!Number.isFinite(h) || h <= 0 || h > 24 * 14) return json(res, 400, { erro: 'horas' });
          deslocamento += h * 3_600_000;
          await a.rodarFollowUps();
          return json(res, 200, a.estado());
        }
      }
      json(res, 404, { erro: 'não encontrado' });
    } catch (e) {
      if (!res.headersSent) json(res, 400, { erro: (e as Error).message });
    }
  });

  const timer = setInterval(() => void a.rodarFollowUps().catch(() => {}), 60_000);
  timer.unref();
  return { server, assistente: a, avancar: (h: number) => (deslocamento += h * 3_600_000) };
}

/** Dados de exemplo para a demonstração. */
export async function semear(a: Assistente, avancar: (h: number) => void) {
  const agora = a.relogio();
  // Carlos: recebeu a estimativa e sumiu (o follow-up aparece ao avançar o relógio).
  avancar(-30);
  await a.receber({ id: 'seed-1', telefone: '5519990000001', nome: 'Carlos Lima', texto: 'Boa tarde, minha conta vem uns 420 reais, moro em Campinas', em: a.relogio() });
  await a.aprovar(a.leads.get('5519990000001')!.id);
  avancar(26);
  // Ana: marcou visita.
  await a.receber({ id: 'seed-2', telefone: '5519990000002', nome: 'Ana Paula', texto: 'Oi! Consumo uns 300 kwh, sou de Valinhos', em: a.relogio() });
  await a.aprovar(a.leads.get('5519990000002')!.id);
  await a.receber({ id: 'seed-3', telefone: '5519990000002', nome: 'Ana Paula', texto: 'Pode ser amanhã às 10h a visita?', em: a.relogio() });
  await a.aprovar(a.leads.get('5519990000002')!.id);
  avancar(4);
  // Mariana: acabou de chegar pelo anúncio.
  await a.receber({ id: 'seed-4', telefone: '5519990000003', nome: 'Mariana Souza', texto: 'Oi, vi o anúncio de vocês. Quanto custa pra instalar?', em: a.relogio() });
  void agora;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const env = process.env;
  const kb = JSON.parse(readFileSync(path.join(raiz, 'data', 'base-conhecimento.json'), 'utf8')) as BaseConhecimento;
  const demo = env.DEMO !== '0';
  const cfg: Config = {
    modo: env.MODO === 'automatico' ? 'automatico' : 'sugerir',
    ...(env.ANTHROPIC_API_KEY && env.ANTHROPIC_MODEL ? { claude: { apiKey: env.ANTHROPIC_API_KEY, model: env.ANTHROPIC_MODEL } } : {}),
    ...(env.MODELO_FORA_DA_JANELA ? { modeloForaDaJanela: { nome: env.MODELO_FORA_DA_JANELA, idioma: env.MODELO_IDIOMA || 'pt_BR' } } : {}),
  };
  const { server, assistente, avancar } = criarServidor({ kb, cfg, demo, env });
  if (demo) {
    await semear(assistente, avancar);
    await assistente.rodarFollowUps();
  }
  const porta = Number(env.PORT || 3000);
  server.listen(porta, env.HOST || '0.0.0.0', () => {
    console.log(`assistente-comercial na porta ${porta} | modo ${cfg.modo} | IA ${cfg.claude ? 'claude' : 'regras'} | envio ${assistente.enviador.nome} | demo ${demo}`);
  });
}
