require('dotenv').config();

const http = require('http');
const https = require('https');
const wa = require('@open-wa/wa-automate');
const axios = require('axios');

const FALLBACK_REPLY =
  'Lo siento, tuve un problema técnico 😅. Intentá de nuevo en un momento.';
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434/api/generate';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'mistral';
const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  'You are a friendly assistant that speaks casually and naturally, like a close friend.';
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS || 15000);
const OLLAMA_MAX_RETRIES = Number(process.env.OLLAMA_MAX_RETRIES || 2);
const HEALTH_CHECK_TIMEOUT_MS = Number(process.env.OLLAMA_HEALTH_TIMEOUT_MS || 5000);

let lastHealthCheckTs = 0;
let lastHealthStatus = null;

const ollamaHttpClient = axios.create({
  timeout: OLLAMA_TIMEOUT_MS,
  proxy: false,
  headers: {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  },
  httpAgent: new http.Agent({
    keepAlive: true,
    family: 4,
  }),
  httpsAgent: new https.Agent({
    keepAlive: true,
  }),
});

function logMissingEnvWarnings() {
  const optionalWithDefaults = ['OLLAMA_URL', 'OLLAMA_MODEL', 'SYSTEM_PROMPT', 'OLLAMA_TIMEOUT_MS'];

  optionalWithDefaults.forEach((key) => {
    if (!process.env[key]) {
      console.warn(`[CONFIG][WARN] ${key} is not set. Using default value.`);
    }
  });
}

function getChromeExecutablePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;

  const platform = process.platform;

  if (platform === 'linux') return '/usr/bin/google-chrome';
  if (platform === 'darwin') return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (platform === 'win32') return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

  return undefined;
}

function buildPrompt(userText) {
  return `${SYSTEM_PROMPT}\n\nUser: ${userText}\nAssistant:`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableError(error) {
  const code = error && error.code ? error.code : '';
  const status = error && error.response ? error.response.status : null;

  if (status && status >= 400 && status < 500) return false;

  if (code === 'ECONNABORTED') return true; // axios timeout
  if (code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'ETIMEDOUT') return true;

  return !status && !!code; // network failures usually have no HTTP status
}

async function checkOllamaHealth(force = false) {
  const now = Date.now();

  if (!force && now - lastHealthCheckTs < 30000 && lastHealthStatus !== null) {
    return lastHealthStatus;
  }

  const healthPayload = {
    model: OLLAMA_MODEL,
    prompt: 'ping',
    stream: false,
    options: { num_predict: 0 },
  };

  try {
    const startedAt = Date.now();
    const response = await ollamaHttpClient.post(OLLAMA_URL, healthPayload, {
      timeout: HEALTH_CHECK_TIMEOUT_MS,
    });

    const reachable = response && response.status >= 200 && response.status < 300;
    console.log(
      `[OLLAMA][HEALTH] reachable=${reachable} status=${response.status} elapsedMs=${Date.now() - startedAt}`
    );

    lastHealthCheckTs = now;
    lastHealthStatus = reachable;
    return reachable;
  } catch (error) {
    const code = error && error.code ? error.code : 'UNKNOWN';
    const status = error && error.response ? error.response.status : 'NO_STATUS';
    console.warn(`[OLLAMA][HEALTH] reachable=false code=${code} status=${status}`);

    lastHealthCheckTs = now;
    lastHealthStatus = false;
    return false;
  }
}

async function generateReply(userText) {
  const prompt = buildPrompt(userText); // 👈 ESTO FALTABA

  const payload = {
    model: OLLAMA_MODEL,
    prompt,
    stream: false,
    options: {
      temperature: 0.7,
      top_p: 0.9,
    },
  };

  let lastError = null;

  for (let attempt = 0; attempt <= OLLAMA_MAX_RETRIES; attempt += 1) {
    const startedAt = Date.now();
    console.log(`[OLLAMA][REQUEST] Attempt ${attempt + 1}/${OLLAMA_MAX_RETRIES + 1}`);
    console.log('[OLLAMA][REQUEST] URL:', OLLAMA_URL);
    console.log('[OLLAMA][REQUEST] Timeout(ms):', OLLAMA_TIMEOUT_MS);
    console.log('[OLLAMA][REQUEST] Payload:', JSON.stringify(payload));

    try {
      const { data, status, headers } = await ollamaHttpClient.post(OLLAMA_URL, payload);
      const elapsedMs = Date.now() - startedAt;

      console.log('[OLLAMA][RESPONSE] Status:', status);
      console.log('[OLLAMA][RESPONSE] Headers:', JSON.stringify(headers || {}));
      console.log(
  '[OLLAMA][RESPONSE] Body:',
  JSON.stringify(data || {}).slice(0, 500)
);
      console.log('[OLLAMA][RESPONSE] Elapsed(ms):', elapsedMs);

      const reply = (data && typeof data.response === 'string' ? data.response : '').trim();

if (!reply || reply.length < 2) {
  console.warn('[OLLAMA][WARN] Empty or too short response');
  return FALLBACK_REPLY;
}

return reply;
    } catch (error) {
      const elapsedMs = Date.now() - startedAt;
      const code = error && error.code ? error.code : 'UNKNOWN';
      const status = error && error.response ? error.response.status : 'NO_STATUS';
      const responseData = error && error.response ? error.response.data : null;

      console.error('[OLLAMA][ERROR] Code:', code);
      console.error('[OLLAMA][ERROR] Status:', status);
      console.error('[OLLAMA][ERROR] Elapsed(ms):', elapsedMs);
      console.error('[OLLAMA][ERROR] Message:', error && error.message ? error.message : error);
      console.error('[OLLAMA][ERROR] Response body:', JSON.stringify(responseData));

      lastError = error;

      const shouldRetry = attempt < OLLAMA_MAX_RETRIES && isRetryableError(error);

      if (!shouldRetry) break;

      const backoffMs = 500 * 2 ** attempt;
      console.warn(`[OLLAMA][RETRY] Waiting ${backoffMs}ms before retry...`);
      await sleep(backoffMs);
    }
  }

  if (lastError) {
    console.error('[OLLAMA][FINAL] Returning fallback after retries exhausted.');
  }

  return FALLBACK_REPLY;
}

async function handleIncomingMessage(client, message) {
  try {
    if (
  !message ||
  message.isGroupMsg ||
  message.fromMe ||
  (message.from && message.from.includes('@newsletter'))
) {
  return;
}

    const incomingText = (message.body || '').trim();
    if (!incomingText) return;

    console.log(`[INCOMING] ${message.from}: ${incomingText}`);

    const isHealthy = await checkOllamaHealth();
    if (!isHealthy) {
      console.warn('[FLOW] Ollama health check failed. Returning fallback response.');
      await client.sendText(message.from, FALLBACK_REPLY);
      return;
    }

    const aiResponse = await generateReply(incomingText);
    await client.sendText(message.from, aiResponse || FALLBACK_REPLY);

    console.log(`[REPLIED] ${message.from}: ${aiResponse}`);
  } catch (error) {
    console.error('[ERROR] Failed to process message:', error && error.message ? error.message : error);

    if (message && message.from) {
      await client.sendText(message.from, FALLBACK_REPLY).catch(() => {});
    }
  }
}

async function startBot() {
  logMissingEnvWarnings();

  const executablePath = getChromeExecutablePath();

  const client = await wa.create({
    sessionId: process.env.WA_SESSION_ID || 'ollama-whatsapp-bot',
    multiDevice: true,
    qrTimeout: 0,
    authTimeout: 0,
    headless: true,
    useChrome: true,
    executablePath,
    killProcessOnBrowserClose: true,
    disableSpins: true,
    logConsole: false,
  });

  const healthOk = await checkOllamaHealth(true);
  if (!healthOk) {
    console.warn('[STARTUP] Ollama health check failed. Bot will continue and retry during message handling.');
  }

  console.log('✅ WhatsApp bot is online and listening for messages...');
  console.log(`🤖 Ollama model: ${OLLAMA_MODEL}`);
  console.log(`🔗 Ollama endpoint: ${OLLAMA_URL}`);
  console.log(`⏱️ Ollama timeout(ms): ${OLLAMA_TIMEOUT_MS}`);

  client.onMessage((message) => {
    handleIncomingMessage(client, message).catch((error) => {
      console.error('[ERROR] Unhandled onMessage rejection:', error && error.message ? error.message : error);
    });
  });
}

module.exports = {
  FALLBACK_REPLY,
  buildPrompt,
  checkOllamaHealth,
  generateReply,
  getChromeExecutablePath,
  handleIncomingMessage,
  startBot,
};
