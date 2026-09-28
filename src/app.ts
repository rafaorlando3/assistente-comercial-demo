// Núcleo do assistente: recebe mensagens, mantém o CRM, gera sugestões, envia e cuida do follow-up.
import { randomUUID } from 'node:crypto';
import type { BaseConhecimento, Etapa, Lead, Sugestao, Visita } from './types.js';
import type { Enviador, Recebida } from './whatsapp.js';
import { pedirConfirmacao, sugerirPorRegras } from './regras.js';
import { sugerirPorClaude, type ConfigClaude } from './claude.js';
import { dentroDaJanela24h, followUpsDevidos, PADRAO, resumoDoDia, tarefas, type ConfigFollowUp } from './crm.js';
import { aceiteInequivoco, primeiroNome } from './texto.js';

export type Config = {
  modo: 'sugerir' | 'automatico';
  claude?: ConfigClaude;
  followUp?: ConfigFollowUp;
  /** Modelo aprovado na Meta para mensagens fora da janela de 24h (parâmetro 1 = primeiro nome). */
  modeloForaDaJanela?: { nome: string; idioma: string };
};

export type Evento = { em: number; tipo: string; texto: string };
export const ETAPAS: Etapa[] = ['novo', 'conversando', 'proposta', 'visita', 'fechado', 'perdido'];

/** A sugestão aprovada não é mais a atual (chegou mensagem nova, ou já foi enviada). Nada foi enviado. */
export class SugestaoDesatualizada extends Error {
  constructor() {
    super('A sugestão mudou (chegou mensagem nova ou ela já foi enviada). Nada foi enviado; revise a sugestão atual.');
  }
}

export class Assistente {
  readonly leads = new Map<string, Lead>();
  readonly sugestoes = new Map<string, Sugestao>();
  readonly visitas: Visita[] = [];
  readonly eventos: Evento[] = [];
  private vistos = new Set<string>();
  private geracao = new Map<string, number>();
  private versao = 0;
  private filas = new Map<string, Promise<unknown>>();

  constructor(
    readonly kb: BaseConhecimento,
    readonly enviador: Enviador,
    readonly cfg: Config,
    readonly relogio: () => number = Date.now,
  ) {}

  private evento(tipo: string, texto: string) {
    this.eventos.push({ em: this.relogio(), tipo, texto });
    if (this.eventos.length > 200) this.eventos.shift();
  }

  /** Uma operação de envio por lead de cada vez (aprovação e follow-up), na ordem de chegada. */
  private serial<T>(leadId: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.filas.get(leadId) ?? Promise.resolve()).then(fn);
    const cauda = run.then(
      () => {},
      () => {},
    );
    this.filas.set(leadId, cauda);
    void cauda.then(() => {
      if (this.filas.get(leadId) === cauda) this.filas.delete(leadId);
    });
    return run;
  }

  private guardar(s: Omit<Sugestao, 'versao'>): Sugestao {
    const v: Sugestao = { ...s, versao: ++this.versao };
    this.sugestoes.set(s.leadId, v);
    return v;
  }

  lead(id: string): Lead | undefined {
    return [...this.leads.values()].find(l => l.id === id);
  }

  /** Entrada única para webhook real e simulador. Idempotente pelo ID da mensagem (a Meta reenvia webhooks). */
  async receber(r: Recebida): Promise<'duplicada' | 'ok'> {
    if (this.vistos.has(r.id)) return 'duplicada';
    this.vistos.add(r.id);
    const agora = this.relogio();
    let lead = this.leads.get(r.telefone);
    if (!lead) {
      lead = {
        id: randomUUID().slice(0, 8),
        telefone: r.telefone,
        nome: r.nome,
        origem: 'WhatsApp',
        etapa: 'novo',
        criadoEm: agora,
        ultimaDoCliente: null,
        ultimaDaEmpresa: null,
        followUps: 0,
        consumoKwh: null,
        cidade: null,
        mensagens: [],
        notas: [],
      };
      this.leads.set(r.telefone, lead);
      this.evento('lead', `Novo lead: ${r.nome || r.telefone}`);
    }
    if (!lead.nome && r.nome) lead.nome = r.nome;
    // A janela de 24h conta da hora da mensagem do cliente, não da hora em que o webhook chegou.
    // Entrega atrasada não reabre a janela. Hora inválida (0) ou no futuro (além de 5 min de tolerância de relógio)
    // não é confiável: a mensagem é guardada, mas não abre a janela.
    const hora = r.em > 0 && r.em <= agora + 5 * 60_000 ? Math.min(r.em, agora) : null;
    lead.mensagens.push({ id: r.id, de: 'cliente', texto: r.texto, em: hora ?? agora });
    if (hora !== null) lead.ultimaDoCliente = Math.max(lead.ultimaDoCliente ?? 0, hora);
    lead.followUps = 0;
    if (lead.etapa === 'perdido' && !/\b(parar|sair|remov)/i.test(r.texto)) {
      lead.etapa = 'conversando';
      this.evento('etapa', `${lead.nome || lead.telefone} voltou a conversar`);
    }
    await this.gerarSugestao(lead);
    return 'ok';
  }

  async gerarSugestao(lead: Lead): Promise<Sugestao | null> {
    const n = (this.geracao.get(lead.id) ?? 0) + 1;
    this.geracao.set(lead.id, n);
    const agora = this.relogio();
    let s: Omit<Sugestao, 'versao'>;
    if (this.cfg.claude) {
      try {
        s = await sugerirPorClaude(lead, this.kb, agora, this.cfg.claude);
      } catch (e) {
        this.evento('ia', `Claude indisponível (${(e as Error).message}); usei as regras.`);
        s = sugerirPorRegras(lead, this.kb, agora);
      }
    } else s = sugerirPorRegras(lead, this.kb, agora);
    // Guarda comum às duas fontes: sem aceite inequívoco de um único dia e horário, não marca visita,
    // e o texto também pede confirmação (texto e etapa precisam dizer a mesma coisa).
    const ultima = [...lead.mensagens].reverse().find(m => m.de === 'cliente')?.texto ?? '';
    if ((s.visita || s.novaEtapa === 'visita') && !aceiteInequivoco(ultima)) s = { ...s, ...pedirConfirmacao(lead, ultima) };
    if (this.geracao.get(lead.id) !== n) return null; // chegou mensagem mais nova: esta sugestão é descartada
    if (s.dados.consumoKwh) lead.consumoKwh = s.dados.consumoKwh;
    if (s.dados.cidade) lead.cidade = s.dados.cidade;
    if (s.dados.nome && !lead.nome) lead.nome = s.dados.nome;
    const guardada = this.guardar(s);
    if (this.cfg.modo === 'automatico')
      await this.aprovar(lead.id, { versao: guardada.versao }).catch(e => this.evento('envio', (e as Error).message));
    return guardada;
  }

  /**
   * O vendedor aprova a versão da sugestão que viu (pode editar o texto). Se ela não é mais a atual, nada é
   * enviado. Etapa e visita vêm só da versão aprovada e só depois do envio.
   */
  aprovar(leadId: string, o: { versao: number; texto?: string }): Promise<void> {
    return this.serial(leadId, async () => {
      const lead = this.lead(leadId);
      const s = this.sugestoes.get(leadId);
      if (!lead || !s || s.versao !== o.versao) throw new SugestaoDesatualizada();
      if (s.intencao.startsWith('follow-up')) return this.followUpAgora(lead, s, o.texto);
      const texto = (o.texto ?? s.resposta).trim();
      if (!texto) throw new Error('Mensagem vazia.');
      await this.enviar(lead, texto, this.cfg.modo === 'automatico' ? 'assistente-automatico' : 'vendedor');
      if (this.sugestoes.get(leadId)?.versao === s.versao) this.sugestoes.delete(leadId);
      if (s.novaEtapa && s.novaEtapa !== lead.etapa) this.mudarEtapa(leadId, s.novaEtapa);
      if (s.visita) {
        const v: Visita = { id: randomUUID().slice(0, 8), leadId, quando: s.visita.quando, titulo: s.visita.texto, criadaEm: this.relogio() };
        this.visitas.push(v);
        this.evento('agenda', `${v.titulo}`);
      }
    });
  }

  descartar(leadId: string, versao: number) {
    const s = this.sugestoes.get(leadId);
    if (!s || s.versao !== versao) throw new SugestaoDesatualizada();
    this.sugestoes.delete(leadId);
  }

  private async enviar(lead: Lead, texto: string, por: 'vendedor' | 'assistente-automatico' | 'follow-up'): Promise<void> {
    const agora = this.relogio();
    if (!dentroDaJanela24h(lead, agora))
      throw new Error('Fora da janela de 24h do WhatsApp: só é possível enviar um modelo aprovado. Use o follow-up.');
    const id = await this.enviador.texto(lead.telefone, texto);
    if (!id) throw new Error('O envio não devolveu identificador: resultado desconhecido. Confira no WhatsApp antes de reenviar.');
    lead.mensagens.push({ id, de: 'empresa', texto, em: agora, enviadaPor: por });
    lead.ultimaDaEmpresa = agora;
  }

  mudarEtapa(leadId: string, etapa: Etapa) {
    const lead = this.lead(leadId);
    if (!lead || !ETAPAS.includes(etapa)) throw new Error('Lead ou etapa inválida.');
    lead.etapa = etapa;
    if (etapa === 'perdido' || etapa === 'fechado') this.sugestoes.delete(leadId);
    this.evento('etapa', `${lead.nome || lead.telefone}: ${etapa}`);
  }

  /** Roda a cada minuto. Em modo sugerir, só prepara o follow-up; em modo automático, envia. */
  async rodarFollowUps(): Promise<number> {
    const agora = this.relogio();
    let feitos = 0;
    for (const f of followUpsDevidos([...this.leads.values()], this.kb, agora, this.cfg.followUp ?? PADRAO)) {
      if (this.sugestoes.get(f.lead.id)?.intencao.startsWith('follow-up')) continue;
      const s = this.guardar({
        leadId: f.lead.id,
        resposta: f.texto,
        intencao: `follow-up ${f.numero}${f.exigeModelo ? ' (modelo aprovado)' : ''}`,
        objecao: null,
        proximaAcao: f.exigeModelo
          ? 'Fora das 24h a Meta só aceita um modelo aprovado. O texto não pode ser editado (na demonstração, o envio do modelo é simulado).'
          : 'Enviar o follow-up.',
        novaEtapa: null,
        visita: null,
        dados: {},
        fonte: 'regras',
        criadaEm: agora,
      });
      if (this.cfg.modo === 'automatico') {
        await this.aprovar(f.lead.id, { versao: s.versao }).then(
          () => feitos++,
          e => this.evento('envio', (e as Error).message),
        );
      }
    }
    return feitos;
  }

  /** Envia o follow-up da sugestão aprovada. Fora da janela de 24h sai o modelo; texto editado não se aplica. */
  private async followUpAgora(lead: Lead, s: Sugestao, textoEditado?: string): Promise<void> {
    const agora = this.relogio();
    const f = followUpsDevidos([lead], this.kb, agora, this.cfg.followUp ?? PADRAO)[0];
    if (!f) {
      if (this.sugestoes.get(lead.id)?.versao === s.versao) this.sugestoes.delete(lead.id);
      throw new SugestaoDesatualizada();
    }
    let id: string;
    let texto: string;
    if (f.exigeModelo) {
      const m = this.cfg.modeloForaDaJanela ?? { nome: 'retomada_atendimento', idioma: 'pt_BR' };
      const parametro = primeiroNome(lead.nome) || 'tudo bem';
      id = await this.enviador.modelo(lead.telefone, m.nome, m.idioma, [parametro]);
      texto = `Modelo aprovado "${m.nome}" (parâmetro: ${parametro}). O texto entregue é o cadastrado na Meta.`;
    } else {
      texto = textoEditado?.trim() || f.texto;
      id = await this.enviador.texto(lead.telefone, texto);
    }
    if (!id) throw new Error('O envio não devolveu identificador: resultado desconhecido. Confira no WhatsApp antes de reenviar.');
    lead.mensagens.push({ id, de: 'empresa', texto, em: agora, enviadaPor: 'follow-up' });
    lead.ultimaDaEmpresa = agora;
    lead.followUps = f.numero;
    if (this.sugestoes.get(lead.id)?.versao === s.versao) this.sugestoes.delete(lead.id);
    this.evento('follow-up', `${f.numero}º follow-up para ${lead.nome || lead.telefone}${f.exigeModelo ? ' (modelo)' : ''}`);
  }

  resumo(): string {
    return resumoDoDia([...this.leads.values()], this.visitas, this.kb, this.relogio(), this.cfg.followUp ?? PADRAO);
  }

  estado() {
    const agora = this.relogio();
    const leads = [...this.leads.values()].sort((a, b) => (b.ultimaDoCliente ?? b.criadoEm) - (a.ultimaDoCliente ?? a.criadoEm));
    return {
      agora,
      modo: this.cfg.modo,
      ia: this.cfg.claude ? 'claude' : 'regras',
      enviador: this.enviador.nome,
      empresa: this.kb.empresa,
      aviso: this.kb.aviso,
      leads: leads.map(l => ({ ...l, janela24h: dentroDaJanela24h(l, agora) })),
      sugestoes: Object.fromEntries(this.sugestoes),
      tarefas: tarefas(leads, this.visitas, this.kb, agora, this.cfg.followUp ?? PADRAO),
      visitas: [...this.visitas].sort((a, b) => a.quando - b.quando),
      eventos: this.eventos.slice(-30).reverse(),
    };
  }
}
