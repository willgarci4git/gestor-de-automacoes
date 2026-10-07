/**
 * Contrato de um canal de mensageria (Adapter pattern).
 * O adapter traduz: payload do provedor -> InboundEvent, e OutboundMessage -> API do provedor.
 * Para adicionar Telegram, Instagram etc., implemente esta interface — o núcleo não muda.
 */
import type { Address, OutboundMessage } from '../core/types.ts';

export interface ChannelAdapter {
  readonly name: string;
  send(to: Address, message: OutboundMessage): Promise<void>;
}

/** Erro que NÃO deve ser re-tentado (ex.: 4xx do provedor, número inválido). */
export class PermanentChannelError extends Error {}

/**
 * Downgrade de mensagens de escolha para texto numerado — usado por canais sem botões
 * ou quando o número de opções excede o limite do canal.
 */
export function choiceAsText(text: string, options: { label: string }[]): string {
  return `${text}\n\n${options.map((o, i) => `${i + 1}. ${o.label}`).join('\n')}\n\nResponda com o número da opção.`;
}
