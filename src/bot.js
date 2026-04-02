require('dotenv').config();

const http = require('http');
const https = require('https');
const wa = require('@open-wa/wa-automate');
const axios = require('axios');

const OLLAMA_FAILURE_REPLY = 'En este momento no puedo responder 😅 intentá más tarde';
const SYSTEM_ERROR_REPLY = 'Ocurrió un error 😅 intentá luego';
const INVALID_TEXT_REPLY = '¿Podés reescribir el mensaje de forma clara, por favor?';
const INTRO_MESSAGE = 'Hola, soy el asistente de Jose 🤖✨';
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const OLLAMA_URL = process.env.OLLAMA_URL || `${OLLAMA_HOST}/api/generate`;
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'tinyllama';
const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  'Respondé en español, 1 línea, voseo tico, corto y natural. Sin inglés. Sin explicaciones.';
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS || 15000);
const OLLAMA_MAX_RETRIES = Number(process.env.OLLAMA_MAX_RETRIES || 1);
const HEALTH_CHECK_TIMEOUT_MS = Number(process.env.OLLAMA_HEALTH_TIMEOUT_MS || 5000);

let lastHealthCheckTs = 0;
let lastHealthStatus = null;

const introducedUsers = new Set();

const QUICK_REPLIES = {
  hola: 'Hola, todo bien ✨',
  'todo bien?': 'Todo bien, gracias por preguntar ✨',
  gracias: 'Con gusto 🤝',
};

const ollamaHttpClient = axios.create({
  timeout: OLLAMA_TIMEOUT_MS,
  proxy: false,
  headers: {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  },
  httpAgent: new http.Agent({ keepAlive: true }),
  httpsAgent: new https.Agent({ keepAlive: true }),
});

function logMissingEnvWarnings() {
  const optionalWithDefaults = ['OLLAMA_HOST', 'OLLAMA_URL', 'OLLAMA_MODEL', 'SYSTEM_PROMPT', 'OLLAMA_TIMEOUT_MS'];

  optionalWithDefaults.forEach((key) => {
    if (!process.env[key]) {
      console.warn(`[CONFIG][WARN] ${key} is not set. Using default value.`);
    }
  });
}

function getOllamaBaseUrl() {
  try {
    const url = new URL(OLLAMA_URL);
    return `${url.protocol}//${url.host}`;
  } catch (error) {
    console.warn('[CONFIG][WARN] Invalid OLLAMA_URL. Falling back to http://127.0.0.1:11434');
    return 'http://127.0.0.1:11434';
  }
}

function getChromeExecutablePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;

  if (process.platform === 'linux') return '/usr/bin/google-chrome';
  if (process.platform === 'darwin') return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (process.platform === 'win32') return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

  return undefined;
}

function buildPrompt(userText) {
  return `${SYSTEM_PROMPT}\n\nUsuario: ${userText}\nAsistente:`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableError(error) {
  const code = error && error.code ? error.code : '';
  const status = error && error.response ? error.response.status : null;

  if (status && status >= 400 && status < 500) return false;

  return code === 'ECONNABORTED' || code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || !status;
}

function isOllamaError(error) {
  if (!error) return false;
  const status = error.response && error.response.status ? error.response.status : null;
  return Boolean(error.isAxiosError || error.code || status);
}

function sanitizeReply(text) {
  const oneLine = String(text || '')
    .replace(/\r?\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return oneLine.slice(0, 140);
}

function isAllowedLatinText(text) {
  if (!text) return false;
  const latinRegex = /^[\p{Script=Latin}\p{Mark}\d\s.,;:!?¡¿'"()\-_/@#%&+*=<>\[\]{}]+$/u;
  return latinRegex.test(text);
}

function shouldIgnoreMessage(message) {
  if (!message || message.isGroupMsg || message.fromMe) return true;

  const from = String(message.from || '').toLowerCase();
  if (from.includes('@newsletter')) return true;

  if (message.isMedia || message.isMMS || (message.type && message.type !== 'chat')) return true;

  const body = String(message.body || '').trim();
  if (!body || body.length > 200) return true;

  return false;
}

async function checkOllamaHealth(force = false) {
  const now = Date.now();

  if (!force && now - lastHealthCheckTs < 30000 && lastHealthStatus !== null) {
    return lastHealthStatus;
  }

  const healthUrl = `${getOllamaBaseUrl()}/api/tags`;
  const startedAt = Date.now();

  try {
    console.log('[OLLAMA][HEALTH][REQUEST] URL:', healthUrl);
    const response = await ollamaHttpClient.get(healthUrl, {
      timeout: HEALTH_CHECK_TIMEOUT_MS,
      headers: { Accept: 'application/json' },
    });

    const reachable = response && response.status >= 200 && response.status < 300;
    console.log(`[OLLAMA][HEALTH] reachable=${reachable} status=${response.status} elapsedMs=${Date.now() - startedAt}`);

    lastHealthCheckTs = now;
    lastHealthStatus = reachable;
    return reachable;
  } catch (error) {
    const code = error && error.code ? error.code : 'UNKNOWN';
    const status = error && error.response ? error.response.status : 'NO_STATUS';
    console.warn(`[OLLAMA][HEALTH] reachable=false code=${code} status=${status} elapsedMs=${Date.now() - startedAt}`);

    lastHealthCheckTs = now;
    lastHealthStatus = false;
    return false;
  }
}

async function generateReply(userText) {
  const normalized = String(userText || '').toLowerCase().trim();
  if (QUICK_REPLIES[normalized]) {
    return sanitizeReply(QUICK_REPLIES[normalized]);
  }

  const payload = {
    model: OLLAMA_MODEL,
    prompt: buildPrompt(userText),
    stream: false,
    options: {
      num_predict: 25,
      temperature: 0.7,
      stop: ['\n'],
    },
  };

  for (let attempt = 0; attempt <= OLLAMA_MAX_RETRIES; attempt += 1) {
    const startedAt = Date.now();
    console.log(`[OLLAMA][REQUEST] Attempt ${attempt + 1}/${OLLAMA_MAX_RETRIES + 1}`);
    console.log('[OLLAMA][REQUEST] URL:', OLLAMA_URL);
    console.log('[OLLAMA][REQUEST] Model:', OLLAMA_MODEL);

    try {
      const { data, status } = await ollamaHttpClient.post(OLLAMA_URL, payload);
      const elapsedMs = Date.now() - startedAt;
      console.log('[OLLAMA][RESPONSE] Status:', status);
      console.log('[OLLAMA][RESPONSE] Elapsed(ms):', elapsedMs);

      const singleLineReply = sanitizeReply(data && typeof data.response === 'string' ? data.response : '');
      console.log('[OLLAMA][METRICS] output_tokens:', Number(data && data.eval_count ? data.eval_count : 0));
      console.log('[OLLAMA][METRICS] text:', singleLineReply);

      if (singleLineReply) return singleLineReply;
      throw new Error('EMPTY_OLLAMA_RESPONSE');
    } catch (error) {
      const elapsedMs = Date.now() - startedAt;
      const code = error && error.code ? error.code : 'UNKNOWN';
      const status = error && error.response ? error.response.status : 'NO_STATUS';
      console.error('[OLLAMA][ERROR] Code:', code);
      console.error('[OLLAMA][ERROR] Status:', status);
      console.error('[OLLAMA][ERROR] Elapsed(ms):', elapsedMs);

      const shouldRetry = attempt < OLLAMA_MAX_RETRIES && isRetryableError(error);
      if (!shouldRetry) {
        throw error;
      }

      const backoffMs = 500 * 2 ** attempt;
      console.warn(`[OLLAMA][RETRY] Waiting ${backoffMs}ms before retry...`);
      await sleep(backoffMs);
    }
  }

  throw new Error('OLLAMA_UNAVAILABLE');
}

async function handleIncomingMessage(client, message) {
  if (!client || shouldIgnoreMessage(message)) return;

  const from = String(message.from || '').trim();
  const incomingText = String(message.body || '').trim();

  if (!from || !incomingText) return;

  try {
    console.log(`[INCOMING] ${from}: ${incomingText}`);

    if (!isAllowedLatinText(incomingText)) {
      await client.sendText(from, INVALID_TEXT_REPLY);
      return;
    }

    if (!introducedUsers.has(from)) {
      introducedUsers.add(from);
      await client.sendText(from, INTRO_MESSAGE);
    }

    const isHealthy = await checkOllamaHealth();
    if (!isHealthy) {
      console.warn('[OLLAMA][HEALTH] Health check failed, attempting generation anyway...');
    }

    const aiResponse = await generateReply(incomingText);
    await client.sendText(from, sanitizeReply(aiResponse || OLLAMA_FAILURE_REPLY));
  } catch (error) {
    console.error('[ERROR] Failed to process message:', error && error.message ? error.message : error);
    const safeReply = isOllamaError(error) ? OLLAMA_FAILURE_REPLY : SYSTEM_ERROR_REPLY;
    await client.sendText(from, safeReply).catch(() => {});
  }
}

async function startBot() {
  logMissingEnvWarnings();

  const client = await wa.create({
    sessionId: process.env.WA_SESSION_ID || 'ollama-whatsapp-bot',
    multiDevice: true,
    qrTimeout: 0,
    authTimeout: 0,
    headless: true,
    useChrome: true,
    executablePath: getChromeExecutablePath(),
    killProcessOnBrowserClose: true,
    disableSpins: true,
    logConsole: false,
  });

  const healthOk = await checkOllamaHealth(true);
  if (!healthOk) {
    console.warn('[STARTUP] Ollama health check failed. Bot will still try generate requests per message.');
  }

  generateReply('hola').catch(() => {});

  console.log('✅ WhatsApp bot is online and listening for messages...');
  console.log(`🤖 Ollama model: ${OLLAMA_MODEL}`);
  console.log(`🔗 Ollama host: ${OLLAMA_HOST}`);
  console.log(`🔗 Ollama endpoint: ${OLLAMA_URL}`);
  console.log(`⏱️ Ollama timeout(ms): ${OLLAMA_TIMEOUT_MS}`);

  client.onMessage((msg) => {
    handleIncomingMessage(client, msg).catch((error) => {
      console.error('[ERROR] Unhandled onMessage rejection:', error && error.message ? error.message : error);
    });
  });
}

module.exports = {
  INTRO_MESSAGE,
  INVALID_TEXT_REPLY,
  OLLAMA_FAILURE_REPLY,
  SYSTEM_ERROR_REPLY,
  buildPrompt,
  checkOllamaHealth,
  generateReply,
  getChromeExecutablePath,
  handleIncomingMessage,
  isAllowedLatinText,
  startBot,
};
