// Sugestão de resposta por regras: funciona sem chave de IA e serve de rede de segurança
// quando o Claude não responde ou devolve algo fora do formato.
import type { BaseConhecimento, Lead, SugestaoBase } from './types.js';
import {
  cidadeMencionada,
  detectarObjecao,
  extrairCidade,
  extrairConsumo,
  extrairVisita,
  formatarQuando,
  pediuParaSair,
  primeiroNome,
  recusaOuRemarcacao,
  aceiteInequivoco,
} from './texto.js';

/** Resposta quando o cliente cita horário sem aceite claro: pede um único dia e horário, sem marcar nada. */
export function pedirConfirmacao(lead: Lead, texto: string) {
  const nome = primeiroNome(lead.nome);
  const recusa = recusaOuRemarcacao(texto);
  return {
    resposta: recusa
      ? `Sem problema${nome ? `, ${nome}` : ''}. Qual dia e horário ficam melhores para você? A visita técnica é sem custo e leva cerca de uma hora.`
      : `${nome ? `${nome}, ` : ''}para eu reservar certinho, pode me confirmar um único dia e horário?`,
    intencao: recusa ? 'recusou ou quer remarcar' : 'horário sem confirmação',
    proximaAcao: 'Combinar um dia e horário antes de marcar a visita.',
    novaEtapa: null,
    visita: null,
  } as const;
}

export function faixaPara(kb: BaseConhecimento, kwh: number) {
  return kb.faixasDePreco.find(f => kwh <= f.ateKwhMes) ?? null;
}

export function sugerirPorRegras(lead: Lead, kb: BaseConhecimento, agora: number): SugestaoBase {
  const ultima = [...lead.mensagens].reverse().find(m => m.de === 'cliente');
  const texto = ultima?.texto ?? '';
  const nome = primeiroNome(lead.nome);
  const ola = nome ? `${nome}, ` : '';
  const base = { leadId: lead.id, fonte: 'regras' as const, criadaEm: agora, visita: null, objecao: null, dados: {} };

  if (pediuParaSair(texto))
    return {
      ...base,
      resposta: `Tudo bem${nome ? `, ${nome}` : ''}. Não vou mais te enviar mensagens. Se um dia quiser retomar, é só chamar aqui.`,
      intencao: 'pediu para sair',
      proximaAcao: 'Encerrar o atendimento e não fazer follow-up.',
      novaEtapa: 'perdido',
    };

  const consumo = extrairConsumo(texto, kb.tarifaReferenciaRsPorKwh) ?? undefined;
  const cidade = extrairCidade(texto, kb.cidadesAtendidas) ?? undefined;
  const dados = { ...(consumo ? { consumoKwh: consumo } : {}), ...(cidade ? { cidade } : {}) };
  const kwh = consumo ?? lead.consumoKwh;
  const cidadeLead = cidade ?? lead.cidade;

  const fora = cidadeMencionada(texto);
  if (fora && !cidade && !kb.cidadesAtendidas.some(c => c.toLowerCase() === fora.toLowerCase()))
    return {
      ...base,
      dados,
      resposta: `${ola}hoje a ${kb.empresa} atende ${kb.cidadesAtendidas.join(', ')}. Vou verificar com a equipe se conseguimos atender ${fora} e te respondo ainda hoje.`,
      intencao: 'cidade fora da área',
      proximaAcao: `Confirmar com a equipe se atende ${fora}.`,
      novaEtapa: lead.etapa === 'novo' ? 'conversando' : null,
    };

  const quando = extrairVisita(texto, agora);
  if (quando !== null && !aceiteInequivoco(texto)) return { ...base, dados, ...pedirConfirmacao(lead, texto) };
  if (quando !== null) {
    const onde = cidadeLead ? ` em ${cidadeLead}` : '';
    return {
      ...base,
      dados,
      resposta: `Combinado${nome ? `, ${nome}` : ''}! Visita técnica sem custo marcada para ${formatarQuando(quando)}${onde}. No dia anterior eu te mando uma confirmação. Pode deixar à mão uma conta de luz recente.`,
      intencao: 'aceitou visita',
      proximaAcao: 'Confirmar a visita no dia anterior.',
      novaEtapa: 'visita',
      visita: { quando, texto: `Visita técnica: ${lead.nome}${onde}` },
    };
  }

  const objecao = detectarObjecao(texto);
  if (objecao)
    return {
      ...base,
      dados,
      objecao,
      resposta: `${ola}${kb.objecoes[objecao]}`,
      intencao: `objeção: ${objecao}`,
      proximaAcao:
        objecao === 'pensar'
          ? 'Mandar a simulação e fazer follow-up em 24h.'
          : objecao === 'concorrente'
            ? 'Pedir o orçamento do concorrente e comparar item por item.'
            : 'Oferecer simulação e visita técnica.',
      novaEtapa: lead.etapa === 'novo' ? 'conversando' : null,
    };

  if (kwh) {
    const f = faixaPara(kb, kwh);
    if (!f)
      return {
        ...base,
        dados,
        resposta: `${ola}com um consumo de cerca de ${kwh} kWh por mês o projeto é sob medida. Posso agendar uma visita técnica sem custo para dimensionar certinho?`,
        intencao: 'consumo alto',
        proximaAcao: 'Agendar visita técnica para projeto sob medida.',
        novaEtapa: 'proposta',
      };
    const pedeCidade = cidadeLead ? '' : ' Em qual cidade é o imóvel?';
    return {
      ...base,
      dados,
      resposta: `${ola}para um consumo de cerca de ${kwh} kWh por mês, o sistema indicado fica em torno de ${f.kwp}, na faixa de ${f.faixa}. ${kb.financiamento} Quer que eu agende uma visita técnica sem custo para fechar o valor exato?${pedeCidade}`,
      intencao: 'pediu preço',
      proximaAcao: 'Oferecer visita técnica e mandar a simulação por escrito.',
      novaEtapa: 'proposta',
    };
  }

  const pergunta = kb.perguntasDeQualificacao[0]!;
  const primeiro = lead.mensagens.filter(m => m.de === 'empresa').length === 0;
  return {
    ...base,
    dados,
    resposta: primeiro
      ? `Olá${nome ? `, ${nome}` : ''}! Aqui é da ${kb.empresa}, obrigado pelo contato. Para te passar uma estimativa rápida: ${pergunta.charAt(0).toLowerCase()}${pergunta.slice(1)}`
      : `${ola}para eu calcular certinho: ${pergunta.charAt(0).toLowerCase()}${pergunta.slice(1)}`,
    intencao: 'qualificação',
    proximaAcao: 'Descobrir consumo e cidade para montar a estimativa.',
    novaEtapa: lead.etapa === 'novo' ? 'conversando' : null,
  };
}
