// WhatsApp Business Cloud API (Meta): verificação do webhook, assinatura, leitura das mensagens e envio.
import { createHmac, timingSafeEqual } from 'node:crypto';

export type Recebida = { id: string; telefone: string; nome: string; texto: string; em: number };

/** GET de verificação: a Meta manda hub.mode=subscribe, hub.verify_token e hub.challenge. */
export function verificarAssinaturaDoWebhook(q: URLSearchParams, tokenEsperado: string | undefined): string | null {
  if (!tokenEsperado) return null;
  if (q.get('hub.mode') !== 'subscribe') return null;
  const t = q.get('hub.verify_token') ?? '';
  const a = Buffer.from(t);
  const b = Buffer.from(tokenEsperado);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return q.get('hub.challenge');
}

/** Cabeçalho X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(app secret, corpo bruto). */
export function assinaturaValida(corpo: Buffer, cabecalho: string | undefined, appSecret: string): boolean {
  if (!cabecalho?.startsWith('sha256=')) return false;
  const esperado = createHmac('sha256', appSecret).update(corpo).digest();
  let recebido: Buffer;
  try {
    recebido = Buffer.from(cabecalho.slice(7), 'hex');
  } catch {
    return false;
  }
  return recebido.length === esperado.length && timingSafeEqual(recebido, esperado);
}

type Payload = {
  object?: string;
  entry?: {
    changes?: {
      value?: {
        contacts?: { wa_id?: string; profile?: { name?: string } }[];
        messages?: { id?: string; from?: string; timestamp?: string; type?: string; text?: { body?: string }; button?: { text?: string }; interactive?: { button_reply?: { title?: string }; list_reply?: { title?: string } } }[];
      };
    }[];
  }[];
};

/** Extrai as mensagens de texto (e respostas de botão) de um webhook. Status de entrega e mídia são ignorados. */
export function lerWebhook(corpo: unknown): Recebida[] {
  const p = corpo as Payload;
  if (!p || p.object !== 'whatsapp_business_account' || !Array.isArray(p.entry)) return [];
  const out: Recebida[] = [];
  for (const e of p.entry)
    for (const c of e.changes ?? []) {
      const v = c.value ?? {};
      const nomes = new Map((v.contacts ?? []).map(k => [k.wa_id ?? '', k.profile?.name ?? '']));
      for (const m of v.messages ?? []) {
        const texto =
          m.type === 'text'
            ? m.text?.body
            : m.type === 'button'
              ? m.button?.text
              : m.type === 'interactive'
                ? (m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title)
                : undefined;
        if (!m.id || !m.from || !texto) continue;
        const ts = Number(m.timestamp);
        out.push({
          id: m.id,
          telefone: m.from.replace(/\D/g, ''),
          nome: nomes.get(m.from) ?? '',
          texto: texto.slice(0, 4096),
          em: Number.isFinite(ts) && ts > 0 ? ts * 1000 : 0, // 0 = hora desconhecida: não abre a janela de 24h
        });
      }
    }
  return out;
}

/** Monta um webhook no formato da Meta. Usado pelo simulador da demonstração e pelos testes. */
export function payloadDeTeste(telefone: string, nome: string, texto: string, id: string, emMs: number) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA_DEMO',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '550000000000', phone_number_id: 'DEMO' },
              contacts: [{ profile: { name: nome }, wa_id: telefone }],
              messages: [{ from: telefone, id, timestamp: String(Math.floor(emMs / 1000)), type: 'text', text: { body: texto } }],
            },
          },
        ],
      },
    ],
  };
}

export interface Enviador {
  readonly nome: string;
  texto(telefone: string, corpo: string): Promise<string>;
  modelo(telefone: string, modelo: string, idioma: string, parametros: string[]): Promise<string>;
}

/** Não envia nada para fora: a mensagem só aparece na conversa simulada. */
export class EnviadorSimulado implements Enviador {
  readonly nome = 'simulado';
  enviados: { telefone: string; corpo: string; modelo?: string }[] = [];
  async texto(telefone: string, corpo: string) {
    this.enviados.push({ telefone, corpo });
    return `sim-${this.enviados.length}`;
  }
  async modelo(telefone: string, modelo: string, _idioma: string, parametros: string[]) {
    this.enviados.push({ telefone, corpo: parametros.join(' | '), modelo });
    return `sim-${this.enviados.length}`;
  }
}

/** Envio real pela Cloud API. Token e ID do número só por variável de ambiente. */
export class EnviadorCloudApi implements Enviador {
  readonly nome = 'cloud-api';
  constructor(
    private token: string,
    private phoneNumberId: string,
    private versao = 'v21.0',
    private fetchImpl: typeof fetch = fetch,
  ) {}
  private async post(corpo: object): Promise<string> {
    const r = await this.fetchImpl(`https://graph.facebook.com/${this.versao}/${this.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', ...corpo }),
      signal: AbortSignal.timeout(15_000),
    });
    const j = (await r.json().catch(() => ({}))) as { messages?: { id?: string }[]; error?: { message?: string; code?: number } };
    if (!r.ok) throw new Error(`WhatsApp HTTP ${r.status}${j.error?.code ? ` código ${j.error.code}` : ''}`);
    const id = j.messages?.[0]?.id;
    if (!id) throw new Error('WhatsApp aceitou sem devolver o id da mensagem: resultado desconhecido, não reenviar sem conferir.');
    return id;
  }
  texto(telefone: string, corpo: string) {
    return this.post({ to: telefone, type: 'text', text: { body: corpo, preview_url: false } });
  }
  modelo(telefone: string, modelo: string, idioma: string, parametros: string[]) {
    return this.post({
      to: telefone,
      type: 'template',
      template: {
        name: modelo,
        language: { code: idioma },
        components: parametros.length ? [{ type: 'body', parameters: parametros.map(text => ({ type: 'text', text })) }] : [],
      },
    });
  }
}
