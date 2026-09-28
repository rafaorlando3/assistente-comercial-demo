// Leitura de mensagens em português: objeções, consumo, cidade, horário de visita e pedido de saída.
// Regras simples e testadas. Com a chave da Anthropic configurada, o Claude faz essa leitura e estas
// regras viram a rede de segurança (mesmo formato de saída).
import type { Objecao } from './types.js';

/** Brasília (UTC-3, sem horário de verão desde 2019). */
export const OFFSET_BR_MIN = -180;

export function normalizar(t: string): string {
  return t
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const OBJECOES: [Exclude<Objecao, null>, RegExp][] = [
  ['concorrente', /\b(outro orcamento|ja tenho (um )?orcamento|outra empresa|concorrente|orcamento mais barato|fizeram por menos)\b/],
  ['financiamento', /\b(financ\w*|parcel\w*|entrada|a prazo|cartao)\b/],
  ['preco', /\b(caro|cara|muito dinheiro|nao tenho (esse )?dinheiro|desconto|mais barato|salgado|puxado)\b/],
  ['pensar', /\b(vou pensar|pensar melhor|preciso pensar|deixa eu ver|depois (eu )?(vejo|falo|te chamo)|mais pra frente|mais para frente|ver com (minha|meu) (esposa|marido|socio|familia))\b/],
  ['confianca', /\b(golpe|confiavel|confianca|referencia\w*|tem clientes|e seguro)\b/],
  ['telhado', /\b(telhado|laje|sombra|estrutura|telha)\b/],
];

export function detectarObjecao(texto: string): Objecao {
  const t = normalizar(texto);
  for (const [nome, re] of OBJECOES) if (re.test(t)) return nome;
  return null;
}

export function pediuParaSair(texto: string): boolean {
  return /\b(parar|pare de|nao quero mais|nao tenho interesse|sem interesse|me remova|remover meu numero|sair da lista|nao me mande)\b/.test(
    normalizar(texto),
  );
}

/** kWh/mês a partir de "450 kwh" ou do valor da conta ("minha conta vem uns 380 reais"). */
export function extrairConsumo(texto: string, tarifaRsPorKwh: number): number | null {
  const t = normalizar(texto);
  const kwh = t.match(/(\d{2,5})\s*kw\s?h/);
  if (kwh) return Number(kwh[1]);
  const reais =
    t.match(/r\$\s*(\d{2,5})(?:[.,]\d{1,2})?/) ??
    t.match(/(\d{2,5})(?:[.,]\d{1,2})?\s*(?:reais|conto|pila)\b/) ??
    t.match(/\b(?:conta|pago|vem|fica|gasto)\D{0,20}?(\d{2,5})(?:[.,]\d{1,2})?\b/);
  if (reais && tarifaRsPorKwh > 0) return Math.round(Number(reais[1]) / tarifaRsPorKwh);
  return null;
}

export function extrairCidade(texto: string, cidades: string[]): string | null {
  const t = ` ${normalizar(texto)} `;
  for (const c of cidades) if (t.includes(` ${normalizar(c)} `) || t.includes(` ${normalizar(c)},`) || t.includes(` ${normalizar(c)}.`)) return c;
  return null;
}

/** Cidade dita mas fora da lista: "sou de Jundiaí", "moro em Itu". */
export function cidadeMencionada(texto: string): string | null {
  const m = texto.match(/\b(?:sou de|moro em|fica em|aqui em|cidade de|casa em|imovel em|imóvel em)\s+([A-ZÀ-Ú][\wÀ-ú]+(?:\s+(?:d[aeo]s?\s+)?[A-ZÀ-Ú][\wÀ-ú]+)*)/);
  return m ? m[1]!.trim() : null;
}

/** Negativa, cancelamento ou pedido para remarcar: um horário citado aqui NÃO é aceite de visita. */
export function recusaOuRemarcacao(texto: string): boolean {
  return /\b(nao (posso|da|consigo|vai dar|tenho como|vou poder|estarei|vou estar|fica bom|serve)|impossivel|cancel\w*|desmarc\w*|remarc\w*|adiar|outro (dia|horario)|nao,)/.test(
    normalizar(texto),
  );
}

const RE_HORA = /\b(?:as\s+|a\s+)?(\d{1,2})(?:\s*h\s*(\d{2})?|:(\d{2})|\s+horas?)\b/g;
/** Quantos horários o texto cita ("amanhã às 10h ou sábado às 9h" = 2). Mais de um é ambíguo. */
export function contarHorarios(texto: string): number {
  return [...normalizar(texto).matchAll(RE_HORA)].length;
}

const DIAS: Record<string, number> = { domingo: 0, segunda: 1, terca: 2, quarta: 3, quinta: 4, sexta: 5, sabado: 6 };

/** Partes da data no horário de Brasília. */
function partesBR(ms: number) {
  const d = new Date(ms + OFFSET_BR_MIN * 60_000);
  return { ano: d.getUTCFullYear(), mes: d.getUTCMonth(), dia: d.getUTCDate(), semana: d.getUTCDay() };
}
function msBR(ano: number, mes: number, dia: number, hora: number, minuto: number): number {
  return Date.UTC(ano, mes, dia, hora, minuto) - OFFSET_BR_MIN * 60_000;
}

/**
 * Horário de visita proposto pelo cliente: "amanhã às 10h", "sábado 9h30", "dia 03/10 às 14:00", "hoje 16h".
 * Só devolve horário no futuro e entre 7h e 19h. Sem dia explícito, não adivinha.
 */
export function extrairVisita(texto: string, agora: number): number | null {
  const t = normalizar(texto);
  const h = t.match(/\b(?:as\s+|a\s+)?(\d{1,2})(?:\s*h\s*(\d{2})?|:(\d{2})|\s+horas?)\b/);
  if (!h) return null;
  const hora = Number(h[1]);
  const minuto = Number(h[2] ?? h[3] ?? 0);
  if (hora < 7 || hora > 19 || minuto > 59) return null;
  const hoje = partesBR(agora);
  let alvo: { ano: number; mes: number; dia: number } | null = null;
  const data = t.match(/\bdia (\d{1,2})(?:\/(\d{1,2}))?\b/) ?? t.match(/\b(\d{1,2})\/(\d{1,2})\b/);
  if (data) {
    const dia = Number(data[1]);
    if (dia < 1 || dia > 31) return null;
    let ano = hoje.ano;
    let mes = data[2] ? Number(data[2]) - 1 : hoje.mes;
    if (mes < 0 || mes > 11) return null;
    // Data já passada: com mês explícito vai para o ano que vem; só com o dia, para o mês que vem.
    if (msBR(ano, mes, dia, hora, minuto) <= agora) {
      if (data[2]) ano += 1;
      else mes += 1; // Date.UTC normaliza dezembro + 1
    }
    alvo = { ano, mes, dia };
  } else if (/\bdepois de amanha\b/.test(t)) {
    alvo = { ...hoje, dia: hoje.dia + 2 };
  } else if (/\bamanha\b/.test(t)) {
    alvo = { ...hoje, dia: hoje.dia + 1 };
  } else if (/\bhoje\b/.test(t)) {
    alvo = { ...hoje };
  } else {
    const nome = Object.keys(DIAS).find(d => new RegExp(`\\b${d}(-feira)?\\b`).test(t));
    if (nome !== undefined) {
      let delta = (DIAS[nome]! - hoje.semana + 7) % 7;
      if (delta === 0 && msBR(hoje.ano, hoje.mes, hoje.dia, hora, minuto) <= agora) delta = 7;
      alvo = { ...hoje, dia: hoje.dia + delta };
    }
  }
  if (!alvo) return null;
  const quando = msBR(alvo.ano, alvo.mes, alvo.dia, hora, minuto);
  // Data com dia e mês explícitos precisa existir no calendário: 31/02 não vira 03/03.
  if (data) {
    const real = partesBR(quando);
    const mesEsperado = ((alvo.mes % 12) + 12) % 12;
    if (real.dia !== alvo.dia || real.mes !== mesEsperado) return null;
  }
  return quando > agora ? quando : null;
}

export function formatarQuando(ms: number): string {
  const d = new Date(ms + OFFSET_BR_MIN * 60_000);
  const dias = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  return `${dias[d.getUTCDay()]} ${dd}/${mm} às ${hh}h${mi === '00' ? '' : mi}`;
}

export function primeiroNome(nome: string): string {
  const n = nome.trim().split(/\s+/)[0] ?? '';
  return n ? n[0]!.toUpperCase() + n.slice(1).toLowerCase() : '';
}
