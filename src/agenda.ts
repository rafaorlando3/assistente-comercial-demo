// Agenda de visitas em iCalendar (RFC 5545). O Google Agenda assina essa URL ("Adicionar agenda > Do URL")
// e mostra as visitas sem precisar de OAuth. A integração pela API do Google fica para a implantação.
import type { Visita } from './types.js';

function utc(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}
/** Escapa texto conforme a RFC 5545 (barra, ponto e vírgula, vírgula e quebra de linha). */
export function escapar(t: string): string {
  return t.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}
/** Dobra linhas acima de 75 octetos, sem cortar um caractere UTF-8 ao meio. */
export function dobrar(linha: string): string {
  const partes: string[] = [];
  let atual = '';
  let bytes = 0;
  for (const ch of linha) {
    const b = Buffer.byteLength(ch);
    if (bytes + b > (partes.length ? 74 : 75)) {
      partes.push(atual);
      atual = '';
      bytes = 0;
    }
    atual += ch;
    bytes += b;
  }
  partes.push(atual);
  return partes.join('\r\n ');
}

export function ics(visitas: Visita[], empresa: string, duracaoMin = 60, agora = Date.now()): string {
  const linhas = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//assistente-comercial//visitas//PT',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapar(`Visitas ${empresa}`)}`,
  ];
  for (const v of [...visitas].sort((a, b) => a.quando - b.quando))
    linhas.push(
      'BEGIN:VEVENT',
      `UID:${v.id}@assistente-comercial`,
      `DTSTAMP:${utc(agora)}`,
      `DTSTART:${utc(v.quando)}`,
      `DTEND:${utc(v.quando + duracaoMin * 60_000)}`,
      `SUMMARY:${escapar(v.titulo)}`,
      'BEGIN:VALARM',
      'TRIGGER:-PT2H',
      'ACTION:DISPLAY',
      `DESCRIPTION:${escapar(v.titulo)}`,
      'END:VALARM',
      'END:VEVENT',
    );
  linhas.push('END:VCALENDAR');
  return linhas.map(dobrar).join('\r\n') + '\r\n';
}
