// Núcleo do assistente: recebe mensagens, mantém o CRM, gera sugestões, envia e cuida do follow-up.
import { randomUUID } from 'node:crypto';
import type { BaseConhecimento, Etapa, Lead, Sugestao, Visita } from './types.js';
import type { Enviador, Recebida } from './whatsapp.js';
import { sugerirPorRegras } from './regras.js';
import { sugerirPorClaude, type ConfigClaude } from './claude.js';
import { dentroDaJanela24h, followUpsDevidos, PADRAO, resumoDoDia, tarefas, type ConfigFollowUp } from './crm.js';
import { primeiroNome } from './texto.js';

export type Config = {
  modo: 'sugerir' | 'automatico';
  claude?: ConfigClaude;
  followUp?: ConfigFollowUp;
  /** Modelo aprovado na Meta para mensagens fora da janela de 24h (parâmetro 1 = primeiro nome). */
  modeloForaDaJanela?: { nome: string; idioma: string };
};

export type Evento = { em: number; tipo: string; texto: string };
export const ETAPAS: Etapa[] = ['novo', 'conversando', 'proposta', 'visita', 'fechado', 'perdido'];

export class Assistente {
  readonly leads = new Map<string, Lead>();
  readonly sugestoes = new Map<string, Sugestao>();
  readonly visitas: Visita[] = [];
  readonly eventos: Evento[] = [];
  private vistos = new Set<string>();
  private geracao = new Map<string, number>();

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
    lead.mensagens.push({ id: r.id, de: 'cliente', texto: r.texto, em: agora });
    lead.ultimaDoCliente = agora;
    lead.followUps = 0;
    if (lead.etapa === 'perdido' && !/\b(parar|sair|remov)/i.test(r.texto)) {
      lead.etapa = 'conversando';
      this.evento('etapa', `${lead.nome || lead.telefone} voltou a conversar`);
    }
    await this.gerarSugestao(lead);
    return 'ok';
  }

  async gerarSugestao(lead: Lead): Promise<Sugestao> {
    const n = (this.geracao.get(lead.id) ?? 0) + 1;
    this.geracao.set(lead.id, n);
    const agora = this.relogio();
    let s: Sugestao;
    if (this.cfg.claude) {
      try {
        s = await sugerirPorClaude(lead, this.kb, agora, this.cfg.claude);
      } catch (e) {
        this.evento('ia', `Claude indisponível (${(e as Error).message}); usei as regras.`);
        s = sugerirPorRegras(lead, this.kb, agora);
      }
    } else s = sugerirPorRegras(lead, this.kb, agora);
    if (this.geracao.get(lead.id) !== n) return s; // chegou mensagem mais nova: descarta esta sugestão
    if (s.dados.consumoKwh) lead.consumoKwh = s.dados.consumoKwh;
    if (s.dados.cidade) lead.cidade = s.dados.cidade;
    if (s.dados.nome && !lead.nome) lead.nome = s.dados.nome;
    this.sugestoes.set(lead.id, s);
    if (this.cfg.modo === 'automatico') await this.aprovar(lead.id);
    return s;
  }

  /** Vendedor aprova a sugestão (pode editar o texto antes). Aplica etapa e visita só depois do envio. */
  async aprovar(leadId: string, textoEditado?: string): Promise<void> {
    const lead = this.lead(leadId);
    const s = this.sugestoes.get(leadId);
    if (!lead || !s) throw new Error('Não há sugestão pendente para este lead.');
    if (s.intencao.startsWith('follow-up')) return this.enviarFollowUp(leadId, textoEditado);
    const texto = (textoEditado ?? s.resposta).trim();
    if (!texto) throw new Error('Mensagem vazia.');
    await this.enviar(lead, texto, this.cfg.modo === 'automatico' ? 'assistente-automatico' : 'vendedor');
    this.sugestoes.delete(leadId);
    if (s.novaEtapa && s.novaEtapa !== lead.etapa) this.mudarEtapa(leadId, s.novaEtapa);
    if (s.visita) {
      const v: Visita = { id: randomUUID().slice(0, 8), leadId, quando: s.visita.quando, titulo: s.visita.texto, criadaEm: this.relogio() };
      this.visitas.push(v);
      this.evento('agenda', `${v.titulo}`);
    }
  }

  descartar(leadId: string) {
    this.sugestoes.delete(leadId);
  }

  async enviar(lead: Lead, texto: string, por: 'vendedor' | 'assistente-automatico' | 'follow-up'): Promise<void> {
    const agora = this.relogio();
    if (!dentroDaJanela24h(lead, agora))
      throw new Error('Fora da janela de 24h do WhatsApp: só é possível enviar um modelo aprovado. Use o follow-up.');
    const id = await this.enviador.texto(lead.telefone, texto);
    lead.mensagens.push({ id: id || randomUUID(), de: 'empresa', texto, em: agora, enviadaPor: por });
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
      if (this.cfg.modo === 'sugerir') {
        const atual = this.sugestoes.get(f.lead.id);
        if (atual?.intencao.startsWith('follow-up')) continue;
        this.sugestoes.set(f.lead.id, {
          leadId: f.lead.id,
          resposta: f.texto,
          intencao: `follow-up ${f.numero}${f.exigeModelo ? ' (modelo aprovado)' : ''}`,
          objecao: null,
          proximaAcao: f.exigeModelo ? 'Fora das 24h: sai pelo modelo aprovado na Meta.' : 'Enviar o follow-up.',
          novaEtapa: null,
          visita: null,
          dados: {},
          fonte: 'regras',
          criadaEm: agora,
        });
        continue;
      }
      await this.enviarFollowUp(f.lead.id);
      feitos++;
    }
    return feitos;
  }

  /** Fora da janela de 24h sai o modelo aprovado (texto editado não se aplica); dentro dela, texto livre. */
  async enviarFollowUp(leadId: string, textoEditado?: string): Promise<void> {
    const lead = this.lead(leadId);
    if (!lead) throw new Error('Lead não encontrado.');
    const agora = this.relogio();
    const f = followUpsDevidos([lead], this.kb, agora, this.cfg.followUp ?? PADRAO)[0];
    if (!f) throw new Error('Nenhum follow-up devido para este lead agora.');
    let id: string;
    let texto: string;
    if (f.exigeModelo) {
      const m = this.cfg.modeloForaDaJanela ?? { nome: 'retomada_atendimento', idioma: 'pt_BR' };
      id = await this.enviador.modelo(lead.telefone, m.nome, m.idioma, [primeiroNome(lead.nome) || 'tudo bem']);
      texto = `[modelo aprovado "${m.nome}"] ${f.texto}`;
    } else {
      texto = textoEditado?.trim() || f.texto;
      id = await this.enviador.texto(lead.telefone, texto);
    }
    lead.mensagens.push({ id: id || randomUUID(), de: 'empresa', texto, em: agora, enviadaPor: 'follow-up' });
    lead.ultimaDaEmpresa = agora;
    lead.followUps = f.numero;
    this.sugestoes.delete(leadId);
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
