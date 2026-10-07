/**
 * Normalização e casamento de texto livre.
 * O curso observa que plataformas como BotConversa "já reconhecem variações" de palavras-chave;
 * aqui isso é feito de forma explícita e testável: sem acento, minúsculas, sem pontuação,
 * casamento por frase, por palavra e tolerância a 1 erro de digitação em palavras longas.
 */

export function normalize(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** Plural simples em pt-BR: "planos" -> "plano", "consultas" -> "consulta". */
function stem(word: string): string {
  if (word.length > 4 && word.endsWith('oes')) return word.slice(0, -3) + 'ao';
  if (word.length > 3 && word.endsWith('s')) return word.slice(0, -1);
  return word;
}

/**
 * Retorna true se `input` casa com o termo.
 * - termo com várias palavras: precisa aparecer como frase
 * - termo com uma palavra: basta existir uma palavra do input igual (ou 1 edição, se >= 5 letras)
 */
export function matchesTerm(input: string, term: string): boolean {
  const ni = normalize(input);
  const nt = normalize(term);
  if (!ni || !nt) return false;
  if (ni === nt) return true;
  if (nt.includes(' ')) return (' ' + ni + ' ').includes(' ' + nt + ' ');
  const target = stem(nt);
  return ni.split(' ').some((w) => {
    const sw = stem(w);
    if (sw === target) return true;
    return target.length >= 5 && Math.abs(sw.length - target.length) <= 1 && levenshtein(sw, target) <= 1;
  });
}

export function matchesAny(input: string, terms: string[] | undefined): boolean {
  return !!terms?.some((t) => matchesTerm(input, t));
}
