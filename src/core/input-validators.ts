/** Validadores de resposta do usuário para nós "input". Funções puras. */
import type { ValidatorSpec } from './types.ts';

export type ValidationOutcome = { ok: true; value: unknown } | { ok: false };

function validCpf(raw: string): boolean {
  const d = raw.replace(/\D/g, '');
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  const calc = (len: number) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(d[i]) * (len + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return calc(9) === Number(d[9]) && calc(10) === Number(d[10]);
}

function parseDate(raw: string): string | undefined {
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(raw.trim());
  if (!m) return undefined;
  const day = Number(m[1]);
  const month = Number(m[2]);
  let year = Number(m[3]);
  if (year < 100) year += 2000;
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) return undefined;
  return dt.toISOString().slice(0, 10);
}

export function validateAnswer(spec: ValidatorSpec | undefined, raw: string): ValidationOutcome {
  const text = raw.trim();
  const kind = spec?.kind ?? 'any';
  switch (kind) {
    case 'any':
      return text ? { ok: true, value: text } : { ok: false };
    case 'minLength':
      return text.length >= (spec as { value: number }).value ? { ok: true, value: text } : { ok: false };
    case 'email':
      return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(text) ? { ok: true, value: text.toLowerCase() } : { ok: false };
    case 'phone': {
      const digits = text.replace(/\D/g, '');
      return digits.length >= 10 && digits.length <= 13 ? { ok: true, value: digits } : { ok: false };
    }
    case 'number': {
      const s = spec as { min?: number; max?: number };
      const n = Number(text.replace(/\./g, '').replace(',', '.'));
      if (!Number.isFinite(n) || text === '') return { ok: false };
      if (s.min !== undefined && n < s.min) return { ok: false };
      if (s.max !== undefined && n > s.max) return { ok: false };
      return { ok: true, value: n };
    }
    case 'date': {
      const iso = parseDate(text);
      return iso ? { ok: true, value: iso } : { ok: false };
    }
    case 'cpf':
      return validCpf(text) ? { ok: true, value: text.replace(/\D/g, '') } : { ok: false };
    case 'regex': {
      const s = spec as { pattern: string; flags?: string };
      return new RegExp(s.pattern, s.flags).test(text) ? { ok: true, value: text } : { ok: false };
    }
    default:
      return { ok: false };
  }
}
