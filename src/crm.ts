// Tarefas do vendedor, follow-up automático e resumo do dia.
import type { BaseConhecimento, Lead, Tarefa, Visita } from './types.js';
import { formatarQuando, OFFSET_BR_MIN, primeiroNome } from './texto.js';

const H = 3_600_000;

export type ConfigFollowUp = {
  /** Horas sem resposta do cliente antes de cada follow-up (1º, 2º, 3º). */
  horas: number[];
  /** Minutos para o vendedor responder uma mensagem nova do cliente. */
  minutosParaResponder: number;
};
export const PADRAO: ConfigFollowUp = { horas: [24, 48, 96], minutosParaResponder: 5 };

/** Janela de atendimento do WhatsApp Business: texto livre só até 24h depois da última mensagem do cliente. */
export function dentroDaJanela24h(lead: Lead, agora: number): boolean {
  return lead.ultimaDoCliente !== null && agora - lead.ultimaDoCliente < 24 * H;
}

export type FollowUpDevido = { lead: Lead; numero: number; texto: string; exigeModelo: boolean };

/** Leads que pararam de responder e precisam do próximo follow-up agora. */
export function followUpsDevidos(leads: Lead[], kb: BaseConhecimento, agora: number, cfg = PADRAO): FollowUpDevido[] {
  const out: FollowUpDevido[] = [];
  for (const l of leads) {
    if (l.etapa === 'fechado' || l.etapa === 'perdido' || l.etapa === 'visita') continue;
    if (l.ultimaDaEmpresa === null) continue;
    if (l.ultimaDoCliente !== null && l.ultimaDoCliente > l.ultimaDaEmpresa) continue; // cliente respondeu
    if (l.followUps >= cfg.horas.length || l.followUps >= kb.followUps.length) continue;
    const espera = cfg.horas[l.followUps]! * H;
    if (agora - l.ultimaDaEmpresa < espera) continue;
    const texto = kb.followUps[l.followUps]!.replaceAll('{nome}', primeiroNome(l.nome) || 'tudo bem');
    out.push({ lead: l, numero: l.followUps + 1, texto, exigeModelo: !dentroDaJanela24h(l, agora) });
  }
  return out;
}

/** Sem resposta depois do último follow-up: o lead esfriou. */
export function esfriando(leads: Lead[], agora: number, cfg = PADRAO): Lead[] {
  const ultimo = cfg.horas.at(-1)! * H;
  return leads.filter(
    l =>
      l.etapa !== 'fechado' &&
      l.etapa !== 'perdido' &&
      l.followUps >= cfg.horas.length &&
      l.ultimaDaEmpresa !== null &&
      (l.ultimaDoCliente === null || l.ultimaDoCliente < l.ultimaDaEmpresa) &&
      agora - l.ultimaDaEmpresa >= ultimo,
  );
}

export function tarefas(leads: Lead[], visitas: Visita[], kb: BaseConhecimento, agora: number, cfg = PADRAO): Tarefa[] {
  const t: Tarefa[] = [];
  for (const l of leads) {
    if (l.etapa === 'perdido' || l.etapa === 'fechado') continue;
    if (l.ultimaDoCliente !== null && (l.ultimaDaEmpresa === null || l.ultimaDoCliente > l.ultimaDaEmpresa))
      t.push({
        id: `responder-${l.id}`,
        leadId: l.id,
        tipo: 'responder',
        texto: `Responder ${l.nome || l.telefone}`,
        vence: l.ultimaDoCliente + cfg.minutosParaResponder * 60_000,
        feita: false,
      });
  }
  for (const f of followUpsDevidos(leads, kb, agora, cfg))
    t.push({
      id: `follow-${f.lead.id}-${f.numero}`,
      leadId: f.lead.id,
      tipo: 'follow-up',
      texto: `${f.numero}º follow-up para ${f.lead.nome || f.lead.telefone}${f.exigeModelo ? ' (fora das 24h: usar modelo aprovado)' : ''}`,
      vence: agora,
      feita: false,
    });
  const [ini, fim] = diaBR(agora);
  for (const v of visitas)
    if (v.quando >= ini && v.quando < fim)
      t.push({ id: `visita-${v.id}`, leadId: v.leadId, tipo: 'visita', texto: `${v.titulo}, ${formatarQuando(v.quando)}`, vence: v.quando, feita: false });
  return t.sort((a, b) => a.vence - b.vence);
}

/** Início e fim do dia de hoje no horário de Brasília. */
export function diaBR(agora: number): [number, number] {
  const off = OFFSET_BR_MIN * 60_000;
  const d = new Date(agora + off);
  const ini = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - off;
  return [ini, ini + 24 * H];
}

/** Mensagem que o vendedor recebe de manhã. */
export function resumoDoDia(leads: Lead[], visitas: Visita[], kb: BaseConhecimento, agora: number, cfg = PADRAO): string {
  const nomes = (ls: Lead[]) => ls.map(l => l.nome || l.telefone).join(', ');
  const responder = leads.filter(
    l => l.etapa !== 'perdido' && l.etapa !== 'fechado' && l.ultimaDoCliente !== null && (l.ultimaDaEmpresa === null || l.ultimaDoCliente > l.ultimaDaEmpresa),
  );
  const follow = followUpsDevidos(leads, kb, agora, cfg).map(f => f.lead);
  const frios = esfriando(leads, agora, cfg);
  const [ini, fim] = diaBR(agora);
  const hoje = visitas.filter(v => v.quando >= ini && v.quando < fim).sort((a, b) => a.quando - b.quando);
  const novos = leads.filter(l => l.criadoEm >= ini - 24 * H && l.criadoEm < ini).length;
  const por = (e: Lead['etapa']) => leads.filter(l => l.etapa === e).length;
  const linhas = [
    `Bom dia! Resumo de ${formatarQuando(agora).split(' às')[0]}:`,
    responder.length ? `• Responder agora (${responder.length}): ${nomes(responder)}` : '• Ninguém esperando resposta.',
    follow.length ? `• Follow-up hoje (${follow.length}): ${nomes(follow)}` : '• Nenhum follow-up pendente.',
    hoje.length ? `• Visitas hoje: ${hoje.map(v => `${formatarQuando(v.quando).split('às ')[1]} ${v.titulo.replace('Visita técnica: ', '')}`).join('; ')}` : '• Nenhuma visita hoje.',
    frios.length ? `• Esfriando, sem resposta depois de todos os follow-ups: ${nomes(frios)}` : '',
    `• Funil: ${por('novo')} novos, ${por('conversando')} em conversa, ${por('proposta')} com proposta, ${por('visita')} com visita, ${por('fechado')} fechados. Chegaram ontem: ${novos}.`,
  ];
  return linhas.filter(Boolean).join('\n');
}
