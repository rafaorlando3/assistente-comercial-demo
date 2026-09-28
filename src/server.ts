// Servidor HTTP sem dependências: painel, API do painel, webhook do WhatsApp e agenda .ics.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Assistente, ETAPAS, SugestaoDesatualizada, type Config } from './app.js';
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

/** Variáveis que ligam serviços externos. Na demonstração nenhuma pode estar definida. */
export const EXTERNAS = ['WHATSAPP_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_APP_SECRET', 'WHATSAPP_VERIFY_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL'];
/** Limites da demonstração pública (estado em memória, dados fictícios). */
export const LIMITES = { leads: 30, mensagensPorLead: 60, texto: 500, nome: 40 };

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
function loginOk(req: IncomingMessage, u: string, s: string): boolean {
  const h = req.headers.authorization ?? '';
  if (!h.startsWith('Basic ')) return false;
  const [du, ds] = Buffer.from(h.slice(6), 'base64').toString().split(':');
  return igual(du ?? '', u) && igual(ds ?? '', s);
}

/**
 * Demonstração: enviador simulado, regras, webhook desligado, e recusa iniciar se houver credencial externa.
 * Uso real: login do painel obrigatório; a agenda exige AGENDA_TOKEN ou o mesmo login.
 */
export function criarServidor(o: Opcoes) {
  const { env, demo } = o;
  if (demo) {
    const definidas = EXTERNAS.filter(k => env[k]);
    if (definidas.length || o.cfg.claude)
      throw new Error(
        `Configuração incoerente: a demonstração não fala com serviços externos, mas estas variáveis estão definidas: ${[...definidas, ...(o.cfg.claude ? ['cfg.claude'] : [])].join(', ')}. Remova-as ou use DEMO=0.`,
      );
  } else if (!env.PAINEL_USUARIO || !env.PAINEL_SENHA) {
    throw new Error('Uso real exige PAINEL_USUARIO e PAINEL_SENHA (o painel mostra dados de clientes).');
  }
  const cfg: Config = demo ? { ...o.cfg, claude: undefined } : o.cfg;
  let deslocamento = 0; // relógio da demonstração: "avançar horas" para ver o follow-up
  const relogio = () => Date.now() + deslocamento;
  const novoAssistente = () =>
    new Assistente(
      o.kb,
      !demo && env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID
        ? new EnviadorCloudApi(env.WHATSAPP_TOKEN, env.WHATSAPP_PHONE_NUMBER_ID, env.GRAPH_API_VERSION || 'v21.0')
        : new EnviadorSimulado(),
      cfg,
      relogio,
    );
  const estado = { a: novoAssistente(), seq: 0 };
  const html = readFileSync(path.join(raiz, 'public', 'index.html'));
  const autorizado = (req: IncomingMessage) => demo || loginOk(req, env.PAINEL_USUARIO!, env.PAINEL_SENHA!);
  const saida = () => ({ ...estado.a.estado(), demo, limites: demo ? LIMITES : null });

  const server = createServer(async (req, res) => {
    const a = estado.a;
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const p = url.pathname;

      if (p === '/health') return json(res, 200, { ok: true });

      if (p === '/webhook/whatsapp') {
        if (demo) return json(res, 404, { erro: 'webhook desligado na demonstração' });
        if (req.method === 'GET') {
          const desafio = verificarAssinaturaDoWebhook(url.searchParams, env.WHATSAPP_VERIFY_TOKEN);
          if (desafio === null) return json(res, 403, { erro: 'token de verificação inválido' });
          res.writeHead(200, { 'content-type': 'text/plain' });
          return res.end(desafio);
        }
        if (req.method === 'POST') {
          const bruto = await corpo(req);
          if (!env.WHATSAPP_APP_SECRET) return json(res, 503, { erro: 'defina WHATSAPP_APP_SECRET para aceitar webhooks' });
          if (!assinaturaValida(bruto, req.headers['x-hub-signature-256'] as string | undefined, env.WHATSAPP_APP_SECRET))
            return json(res, 401, { erro: 'assinatura inválida' });
          // Responde 200 logo; a Meta reenvia se demorar. Deduplicação em memória pelo ID da mensagem
          // (não é fila durável: ver limites no README).
          json(res, 200, { ok: true });
          for (const m of lerWebhook(JSON.parse(bruto.toString('utf8')))) await a.receber(m).catch(() => {});
          return;
        }
      }

      if (p === '/agenda.ics') {
        const t = env.AGENDA_TOKEN;
        const liberado = demo || (t ? igual(url.searchParams.get('token') ?? '', t) : false) || autorizado(req);
        if (!liberado) {
          res.writeHead(401, { 'www-authenticate': 'Basic realm="painel"' });
          return res.end('login ou token necessário');
        }
        res.writeHead(200, { 'content-type': 'text/calendar; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(ics(a.visitas, a.kb.empresa, 60, relogio()));
      }

      if (!autorizado(req)) {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="painel"' });
        return res.end('login necessário');
      }

      if (p === '/' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(html);
      }
      if (p === '/api/estado' && req.method === 'GET') return json(res, 200, saida());
      if (p === '/api/resumo' && req.method === 'GET') return json(res, 200, { texto: a.resumo() });

      if (req.method === 'POST' && p.startsWith('/api/')) {
        const b = JSON.parse((await corpo(req, 32 * 1024)).toString('utf8') || '{}') as Record<string, unknown>;
        const m = p.match(/^\/api\/leads\/([\w-]+)\/(aprovar|descartar|etapa)$/);
        if (m) {
          const [, id, acao] = m;
          try {
            if (acao === 'aprovar' || acao === 'descartar') {
              const versao = Number(b.versao);
              if (!Number.isInteger(versao) || versao < 1) return json(res, 400, { erro: 'versão da sugestão ausente' });
              if (acao === 'aprovar') await a.aprovar(id!, { versao, ...(typeof b.texto === 'string' ? { texto: b.texto.slice(0, 1000) } : {}) });
              else a.descartar(id!, versao);
            } else {
              if (!ETAPAS.includes(b.etapa as Etapa)) return json(res, 400, { erro: 'etapa inválida' });
              a.mudarEtapa(id!, b.etapa as Etapa);
            }
          } catch (e) {
            if (e instanceof SugestaoDesatualizada) return json(res, 409, { erro: e.message, estado: saida() });
            throw e;
          }
          return json(res, 200, saida());
        }
        if (demo && p === '/api/simular') {
          const texto = String(b.texto ?? '').trim().slice(0, LIMITES.texto);
          if (!texto) return json(res, 400, { erro: 'escreva a mensagem do cliente' });
          let lead = typeof b.leadId === 'string' ? a.lead(b.leadId) : undefined;
          if (b.leadId && !lead) return json(res, 404, { erro: 'lead não encontrado' });
          if (!lead && a.leads.size >= LIMITES.leads) return json(res, 400, { erro: `limite de ${LIMITES.leads} leads da demonstração; use Reiniciar` });
          if (lead && lead.mensagens.length >= LIMITES.mensagensPorLead) return json(res, 400, { erro: 'limite de mensagens deste lead na demonstração' });
          // Identidade fictícia gerada aqui: a demonstração não recebe telefone de ninguém.
          const tel = lead?.telefone ?? `5500000${String(1000 + ++estado.seq).padStart(6, '0')}`;
          const nome = lead?.nome ?? (String(b.nome ?? '').trim().slice(0, LIMITES.nome) || `Lead de teste ${estado.seq}`);
          const payload = payloadDeTeste(tel, nome, texto, `sim-${relogio()}-${Math.random().toString(36).slice(2, 8)}`, relogio());
          for (const r of lerWebhook(payload)) await a.receber(r);
          return json(res, 200, { ...saida(), leadId: a.leads.get(tel)?.id });
        }
        if (demo && p === '/api/relogio') {
          const h = Number(b.horas);
          if (!Number.isFinite(h) || h <= 0 || h > 24 * 14) return json(res, 400, { erro: 'horas' });
          deslocamento += h * 3_600_000;
          await a.rodarFollowUps();
          return json(res, 200, saida());
        }
        if (demo && p === '/api/reiniciar') {
          deslocamento = 0;
          estado.a = novoAssistente();
          await semear(estado.a, horas => (deslocamento += horas * 3_600_000));
          await estado.a.rodarFollowUps();
          return json(res, 200, saida());
        }
      }
      json(res, 404, { erro: 'não encontrado' });
    } catch (e) {
      if (!res.headersSent) json(res, 400, { erro: (e as Error).message });
    }
  });

  const timer = setInterval(() => void estado.a.rodarFollowUps().catch(() => {}), 60_000);
  timer.unref();
  return {
    server,
    get assistente() {
      return estado.a;
    },
    avancar: (h: number) => (deslocamento += h * 3_600_000),
  };
}

/** Dados de exemplo (fictícios) para a demonstração. */
export async function semear(a: Assistente, avancar: (h: number) => void) {
  const aprovarAtual = (tel: string) => {
    const id = a.leads.get(tel)!.id;
    return a.aprovar(id, { versao: a.sugestoes.get(id)!.versao });
  };
  // Carlos: recebeu a estimativa e sumiu (o follow-up aparece ao avançar o relógio).
  avancar(-30);
  await a.receber({ id: 'seed-1', telefone: '5500000000001', nome: 'Carlos Lima', texto: 'Boa tarde, minha conta vem uns 420 reais, moro em Campinas', em: a.relogio() });
  await aprovarAtual('5500000000001');
  avancar(26);
  // Ana: marcou visita.
  await a.receber({ id: 'seed-2', telefone: '5500000000002', nome: 'Ana Paula', texto: 'Oi! Consumo uns 300 kwh, sou de Valinhos', em: a.relogio() });
  await aprovarAtual('5500000000002');
  await a.receber({ id: 'seed-3', telefone: '5500000000002', nome: 'Ana Paula', texto: 'Pode ser amanhã às 10h a visita?', em: a.relogio() });
  await aprovarAtual('5500000000002');
  avancar(4);
  // Mariana: acabou de chegar pelo anúncio.
  await a.receber({ id: 'seed-4', telefone: '5500000000003', nome: 'Mariana Souza', texto: 'Oi, vi o anúncio de vocês. Quanto custa pra instalar?', em: a.relogio() });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const env = process.env;
  const kb = JSON.parse(readFileSync(path.join(raiz, 'data', 'base-conhecimento.json'), 'utf8')) as BaseConhecimento;
  const demo = env.DEMO !== '0';
  const cfg: Config = {
    modo: env.MODO === 'automatico' ? 'automatico' : 'sugerir',
    ...(!demo && env.ANTHROPIC_API_KEY && env.ANTHROPIC_MODEL ? { claude: { apiKey: env.ANTHROPIC_API_KEY, model: env.ANTHROPIC_MODEL } } : {}),
    ...(env.MODELO_FORA_DA_JANELA ? { modeloForaDaJanela: { nome: env.MODELO_FORA_DA_JANELA, idioma: env.MODELO_IDIOMA || 'pt_BR' } } : {}),
  };
  let criado: ReturnType<typeof criarServidor>;
  try {
    criado = criarServidor({ kb, cfg, demo, env });
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
  if (demo) {
    await semear(criado.assistente, criado.avancar);
    await criado.assistente.rodarFollowUps();
  }
  const porta = Number(env.PORT || 3000);
  criado.server.listen(porta, env.HOST || '0.0.0.0', () => {
    const a = criado.assistente;
    console.log(`assistente-comercial na porta ${porta} | modo ${cfg.modo} | IA ${cfg.claude ? 'claude' : 'regras'} | envio ${a.enviador.nome} | demo ${demo}`);
  });
}
