/**
 * Ponto de entrada. Configuração 100% por variáveis de ambiente (12-factor).
 * Veja .env.example.
 */
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBotApp } from '../runtime/app.ts';
import { SqliteStorage } from '../storage/sqlite.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { createLogger, type LogLevel } from '../core/observability.ts';
import { WhatsAppChannel } from '../channels/whatsapp.ts';
import { TelegramChannel } from '../channels/telegram.ts';
import { InstagramChannel } from '../channels/instagram.ts';
import type { ChannelAdapter } from '../channels/types.ts';
import { createHttpServer } from './http.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const env = process.env;
const logger = createLogger((env.LOG_LEVEL as LogLevel) ?? 'info');

const dbPath = env.DB_PATH ?? resolve(root, 'data/bot.db');
let storage;
if (dbPath === ':memory:') storage = new MemoryStorage();
else {
  mkdirSync(dirname(dbPath), { recursive: true });
  storage = new SqliteStorage(dbPath);
}

const adapters: ChannelAdapter[] = [];
if (env.WHATSAPP_PHONE_NUMBER_ID && env.WHATSAPP_ACCESS_TOKEN && env.WHATSAPP_APP_SECRET && env.WHATSAPP_VERIFY_TOKEN) {
  adapters.push(new WhatsAppChannel({
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID, accessToken: env.WHATSAPP_ACCESS_TOKEN,
    appSecret: env.WHATSAPP_APP_SECRET, verifyToken: env.WHATSAPP_VERIFY_TOKEN, apiVersion: env.WHATSAPP_API_VERSION,
  }));
}
if (env.INSTAGRAM_ACCOUNT_ID && env.INSTAGRAM_ACCESS_TOKEN && env.INSTAGRAM_APP_SECRET && env.INSTAGRAM_VERIFY_TOKEN) {
  adapters.push(new InstagramChannel({
    accountId: env.INSTAGRAM_ACCOUNT_ID, accessToken: env.INSTAGRAM_ACCESS_TOKEN, appSecret: env.INSTAGRAM_APP_SECRET,
    verifyToken: env.INSTAGRAM_VERIFY_TOKEN, apiVersion: env.INSTAGRAM_API_VERSION, graphBaseUrl: env.INSTAGRAM_GRAPH_BASE_URL,
    commentPublicReply: env.INSTAGRAM_COMMENT_PUBLIC_REPLY,
  }));
}
if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_WEBHOOK_SECRET) {
  adapters.push(new TelegramChannel({ botToken: env.TELEGRAM_BOT_TOKEN, webhookSecret: env.TELEGRAM_WEBHOOK_SECRET }));
}

const app = createBotApp({
  storage,
  flowsDir: env.FLOWS_DIR ?? resolve(root, 'flows'),
  tenantsDir: env.TENANTS_DIR ?? resolve(root, 'tenants'),
  adapters,
  logger,
  engineConfig: {
    timezone: env.TZ_NAME ?? 'America/Sao_Paulo',
    fallback: {
      message: env.FALLBACK_MESSAGE ?? 'Desculpe, tive um problema por aqui. Vou te encaminhar para nossa equipe.',
      handoffQueue: env.FALLBACK_QUEUE === '' ? undefined : (env.FALLBACK_QUEUE ?? 'geral'),
    },
  },
});
app.start();

if (!env.ADMIN_TOKEN) logger.warn('ADMIN_TOKEN não definido: rotas /admin, /handoff e /metrics estão ABERTAS (apenas desenvolvimento)');
const server = createHttpServer(app, { tenantId: env.TENANT_ID ?? 'default', adminToken: env.ADMIN_TOKEN, publicDir: resolve(root, 'public') });
const port = Number(env.PORT ?? 3000);
server.listen(port, () => {
  logger.info('server_started', { port, channels: Object.keys(app.adapters), flows: app.registry.list().map((f) => `${f.id}@${f.latest}`), storage: dbPath });
});

const shutdown = () => {
  logger.info('shutdown');
  app.stop();
  server.close(() => {
    storage.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
