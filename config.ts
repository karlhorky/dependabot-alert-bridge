import { type } from 'arktype';

const env = type({
  PORT: 'string?',
  GITHUB_WEBHOOK_SECRET: 'string',
  GITHUB_APP_ID: 'string',
  GITHUB_APP_PRIVATE_KEY: 'string',
})(process.env);

if (env instanceof type.errors) {
  console.error('[startup] Invalid environment variables');
  console.error(env.summary);
  process.exit(1);
}

const parsedPort = env.PORT ? Number(env.PORT) : 3000;

if (!Number.isInteger(parsedPort) || parsedPort <= 0) {
  console.error('[startup] PORT must be a positive integer');
  process.exit(1);
}

export const config = {
  port: parsedPort,
  webhookSecret: env.GITHUB_WEBHOOK_SECRET,
  appId: env.GITHUB_APP_ID,
  appPrivateKey: env.GITHUB_APP_PRIVATE_KEY,
};
