import { createServer } from 'node:http';
import { URL } from 'node:url';
import { Buffer } from 'node:buffer';
import { createAppAuth } from '@octokit/auth-app';
import { request } from '@octokit/request';
import type { EmitterWebhookEvent } from '@octokit/webhooks';
import { Webhooks } from '@octokit/webhooks';
import { config } from './config.ts';

type DispatchPayload = {
  alert_number?: number;
  ghsa_id?: string;
  severity?: string;
  ecosystem: string;
  dependencies: string[];
};

const webhooks = new Webhooks({ secret: config.webhookSecret });

const appAuth = createAppAuth({
  appId: config.appId,
  privateKey: config.appPrivateKey,
});

const githubRequest = request.defaults({
  baseUrl: 'https://api.github.com',
  headers: {
    accept: 'application/vnd.github+json',
    'user-agent': 'dependabot-alert-bridge',
    'x-github-api-version': '2022-11-28',
  },
});

webhooks.onAny((event) => {
  if (event.name !== 'dependabot_alert') {
    console.info(`[webhook] Skipped unsupported event: ${event.name}`);
  }
});

webhooks.on(
  [
    'dependabot_alert.created',
    'dependabot_alert.reopened',
    'dependabot_alert.reintroduced',
    'dependabot_alert.auto_reopened',
  ],
  async (event) => {
    const directPackage = event.payload.alert.dependency.package;

    if (!directPackage) {
      throw new Error('Missing alert.dependency.package');
    }

    if (!directPackage.ecosystem) {
      throw new Error('Missing alert.dependency.package.ecosystem');
    }

    const dependencies = [
      directPackage.name,
      ...event.payload.alert.security_advisory.vulnerabilities.map(
        (vulnerability) => vulnerability.package.name,
      ),
    ]
      .filter((name): name is string => typeof name === 'string')
      .map((name) => name.trim())
      .filter(Boolean);

    const normalizedDependencies = [...new Set(dependencies)].sort((a, b) =>
      a.localeCompare(b),
    );

    if (normalizedDependencies.length === 0) {
      throw new Error('No dependency names in dependabot alert payload');
    }

    const installationId = event.payload.installation?.id;

    if (!installationId) {
      throw new Error('Missing installation.id in webhook payload');
    }

    const dispatchPayload: DispatchPayload = {
      alert_number: event.payload.alert.number,
      ghsa_id: event.payload.alert.security_advisory.ghsa_id,
      severity: event.payload.alert.security_vulnerability.severity,
      ecosystem: directPackage.ecosystem.toLowerCase(),
      dependencies: normalizedDependencies,
    };

    const installationAuth = await appAuth({
      type: 'installation',
      installationId,
    });

    await githubRequest('POST /repos/{owner}/{repo}/dispatches', {
      owner: event.payload.repository.owner.login,
      repo: event.payload.repository.name,
      headers: {
        authorization: `token ${installationAuth.token}`,
      },
      event_type: 'dependabot-alert-opened',
      client_payload: dispatchPayload,
    });

    console.info(
      `[webhook] Dispatched dependabot-alert-opened to ${event.payload.repository.full_name} with ${normalizedDependencies.length} dependencies`,
    );
  },
);

webhooks.onError((error) => {
  console.error('[webhook] Handler error', error);
});

createServer((requestMessage, response) => {
  void (async () => {
    if (!requestMessage.url) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'missing_url' }));
      return;
    }

    const requestUrl = new URL(requestMessage.url, 'http://localhost');

    if (requestMessage.method === 'GET' && requestUrl.pathname === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    if (
      requestMessage.method !== 'POST' ||
      (requestUrl.pathname !== '/webhook' && requestUrl.pathname !== '/')
    ) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'not_found' }));
      return;
    }

    const deliveryHeader = requestMessage.headers['x-github-delivery'];
    const eventHeader = requestMessage.headers['x-github-event'];
    const signatureHeader = requestMessage.headers['x-hub-signature-256'];

    const deliveryId = Array.isArray(deliveryHeader)
      ? deliveryHeader[0]
      : deliveryHeader;
    const eventName = Array.isArray(eventHeader) ? eventHeader[0] : eventHeader;
    const signature = Array.isArray(signatureHeader)
      ? signatureHeader[0]
      : signatureHeader;

    if (!deliveryId || !eventName || !signature) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'missing_github_headers' }));
      return;
    }

    if (eventName !== 'dependabot_alert') {
      response.writeHead(202, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ skipped: 'unsupported_event', event: eventName }),
      );
      return;
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;

    for await (const chunk of requestMessage) {
      const chunkBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += chunkBuffer.length;

      if (totalBytes > 1024 * 1024) {
        requestMessage.destroy();
        response.writeHead(413, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'payload_too_large' }));
        return;
      }

      chunks.push(chunkBuffer);
    }

    const payload = Buffer.concat(chunks).toString('utf8');

    if (!(await webhooks.verify(payload, signature))) {
      console.warn('[webhook] Signature mismatch');
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'invalid_signature' }));
      return;
    }

    let parsedPayload: EmitterWebhookEvent<'dependabot_alert'>['payload'];
    try {
      parsedPayload = JSON.parse(payload);
    } catch {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'invalid_json' }));
      return;
    }

    await webhooks.receive({
      id: deliveryId,
      name: eventName,
      payload: parsedPayload,
    });

    response.writeHead(202, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ accepted: true }));
  })().catch((error: unknown) => {
    console.error('[webhook] Unexpected error', error);
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'internal_error' }));
  });
}).listen(config.port, () => {
  console.info(
    `[startup] dependabot-alert-bridge listening on port ${config.port}`,
  );
});
