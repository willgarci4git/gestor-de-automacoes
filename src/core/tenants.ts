/**
 * Registro de tenants (clientes). Cada arquivo tenants/<id>.json parametriza os fluxos
 * compartilhados — é isto que permite "criar um bot novo" sem escrever fluxo novo.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { TenantConfig } from './types.ts';

export class TenantRegistry {
  private readonly tenants = new Map<string, TenantConfig>();

  set(t: TenantConfig): void {
    if (!t?.id || !/^[\w-]{1,64}$/.test(t.id)) throw new Error(`tenant inválido: ${JSON.stringify(t?.id)}`);
    if (t.businessHours) {
      for (const [day, ranges] of Object.entries(t.businessHours.days)) {
        if (!/^[0-6]$/.test(day)) throw new Error(`tenant ${t.id}: dia "${day}" inválido (0=domingo..6=sábado)`);
        for (const [a, b] of ranges) {
          if (!/^\d{2}:\d{2}$/.test(a) || !/^\d{2}:\d{2}$/.test(b) || a >= b) throw new Error(`tenant ${t.id}: faixa inválida ${a}-${b}`);
        }
      }
    }
    this.tenants.set(t.id, { ...t, params: t.params ?? {} });
  }

  get(id: string): TenantConfig {
    return this.tenants.get(id) ?? this.tenants.get('default') ?? { id, params: {} };
  }

  list(): TenantConfig[] {
    return [...this.tenants.values()];
  }

  loadDir(dir: string): void {
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      this.set(JSON.parse(readFileSync(join(dir, f), 'utf8')) as TenantConfig);
    }
  }
}

/** Partes de data/hora no fuso informado (sem dependências). */
export function zonedParts(now: Date, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone, hour: '2-digit', minute: '2-digit', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hourCycle: 'h23',
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}`, hour: Number(parts.hour), weekday };
}

export function isBusinessHours(tenant: TenantConfig, now: Date, defaultTz: string): boolean | null {
  if (!tenant.businessHours) return null; // não configurado
  const z = zonedParts(now, tenant.timezone ?? defaultTz);
  if (tenant.businessHours.holidays?.includes(z.date)) return false;
  return (tenant.businessHours.days[String(z.weekday)] ?? []).some(([a, b]) => z.time >= a && z.time < b);
}

export function greetingFor(hour: number): string {
  if (hour >= 5 && hour < 12) return 'Bom dia';
  if (hour >= 12 && hour < 18) return 'Boa tarde';
  return 'Boa noite';
}
