export type Etapa = 'novo' | 'conversando' | 'proposta' | 'visita' | 'fechado' | 'perdido';

export type Mensagem = {
  id: string;
  de: 'cliente' | 'empresa';
  texto: string;
  em: number; // epoch ms
  enviadaPor?: 'vendedor' | 'assistente-automatico' | 'follow-up';
};

export type Lead = {
  id: string;
  telefone: string; // só dígitos, com DDI
  nome: string;
  origem: string;
  etapa: Etapa;
  criadoEm: number;
  ultimaDoCliente: number | null;
  ultimaDaEmpresa: number | null;
  followUps: number;
  consumoKwh: number | null;
  cidade: string | null;
  mensagens: Mensagem[];
  notas: string[];
};

export type Objecao = 'preco' | 'pensar' | 'concorrente' | 'confianca' | 'financiamento' | 'telhado' | null;

export type Sugestao = {
  leadId: string;
  resposta: string;
  intencao: string;
  objecao: Objecao;
  proximaAcao: string;
  novaEtapa: Etapa | null;
  visita: { quando: number; texto: string } | null;
  dados: { consumoKwh?: number; cidade?: string; nome?: string };
  fonte: 'claude' | 'regras';
  criadaEm: number;
};

export type Visita = {
  id: string;
  leadId: string;
  quando: number; // epoch ms
  titulo: string;
  criadaEm: number;
};

export type Tarefa = {
  id: string;
  leadId: string;
  tipo: 'follow-up' | 'responder' | 'visita';
  texto: string;
  vence: number;
  feita: boolean;
};

export type BaseConhecimento = {
  empresa: string;
  aviso: string;
  cidadesAtendidas: string[];
  prazoInstalacaoDias: string;
  garantias: string[];
  financiamento: string;
  tarifaReferenciaRsPorKwh: number;
  faixasDePreco: { ateKwhMes: number; kwp: string; faixa: string }[];
  objecoes: Record<Exclude<Objecao, null>, string>;
  perguntasDeQualificacao: string[];
  followUps: string[];
};
