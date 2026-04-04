require('dotenv').config();

const http = require('http');
const https = require('https');
const wa = require('@open-wa/wa-automate');
const axios = require('axios');

const CONFIG = {
  cloud: {
    token: process.env.HF_TOKEN || '',
    model: process.env.HF_MODEL || 'mistralai/Mistral-7B-Instruct-v0.2',
    url: process.env.HF_URL || 'https://api-inference.huggingface.co/models',
    maxTokens: Number(process.env.CLOUD_MAX_TOKENS || 80),
    temperature: Number(process.env.CLOUD_TEMPERATURE || 0.4),
  },
  local: {
    url: process.env.OLLAMA_URL || 'http://127.0.0.1:11434/api/generate',
    model: process.env.OLLAMA_MODEL || 'gemma:2b',
    maxTokens: Number(process.env.LOCAL_MAX_TOKENS || 64),
    temperature: Number(process.env.LOCAL_TEMPERATURE || 0.3),
  },
  system: {
    timeout: Number(process.env.TIMEOUT_MS || 12000),
    simpleThreshold: Number(process.env.SIMPLE_THRESHOLD || 60),
  },
  features: {
    guardrails: process.env.ENABLE_GUARDRAILS === 'true',
    memory: process.env.ENABLE_MEMORY === 'true',
    logs: process.env.ENABLE_LOGS !== 'false',
  },
  memory: {
    limit: Number(process.env.MEMORY_LIMIT || 6),
  },
  fallback: {
    enabled: process.env.ENABLE_FALLBACK !== 'false',
    onTimeout: process.env.FALLBACK_ON_TIMEOUT !== 'false',
    onError: process.env.FALLBACK_ON_ERROR !== 'false',
    onInvalid: process.env.FALLBACK_ON_INVALID !== 'false',
  },
  language: {
    blockNonSpanish: process.env.BLOCK_NON_SPANISH === 'true',
    minLatinRatio: Number(process.env.MIN_LATIN_RATIO || 0.75),
  },
  debug: {
    mode: process.env.DEBUG_MODE === 'true',
    level: process.env.LOG_LEVEL || 'info',
  },
  whatsapp: {
    sessionId: process.env.WA_SESSION_ID || 'ollama-whatsapp-bot',
    chromePath: process.env.CHROME_PATH || '',
  },
};

const SAFETY_FALLBACK_MESSAGE = 'Lo siento, tuve un problema procesando tu mensaje. ¿Podés intentar de nuevo?';
const MESSAGE_LIMIT = 200;
const QUICK_REPLIES = {
  hola: 'Hola, ¡todo bien por acá! ✨',
  buenas: '¡Hola! ¿Cómo te ayudo? ✨',
  gracias: '¡Con gusto! 🤝',
  'muchas gracias': '¡Con mucho gusto! 🙌',
  chao: '¡Hasta luego! 👋',
  adios: '¡Hasta pronto! 👋',
  bye: '¡Que estés bien! 👋',
};

const userMemory = new Map();

const httpClient = axios.create({
  timeout: CONFIG.system.timeout,
  proxy: false,
  headers: {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  },
  httpAgent: new http.Agent({ keepAlive: true }),
  httpsAgent: new https.Agent({ keepAlive: true }),
});

function getChromeExecutablePath() {
  if (CONFIG.whatsapp.chromePath) return CONFIG.whatsapp.chromePath;
  if (process.platform === 'linux') return '/usr/bin/google-chrome';
  if (process.platform === 'darwin') return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (process.platform === 'win32') return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  return undefined;
}

function logStructured(entry) {
  if (!CONFIG.features.logs) return;
  console.log(JSON.stringify(entry));
}

function withTimeoutSignal() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONFIG.system.timeout);
  return { signal: controller.signal, cancel: () => clearTimeout(timeout) };
}

function normalizeWhitespace(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function getLatinRatio(text) {
  const chars = [...String(text || '')].filter((ch) => !/\s/.test(ch));
  if (!chars.length) return 1;
  const latinChars = chars.filter((ch) => /[\p{Script=Latin}\p{Mark}\d.,;:!?¡¿'"()\-_/]/u.test(ch));
  return latinChars.length / chars.length;
}

function passesInputValidation(text) {
  if (!CONFIG.language.blockNonSpanish) return true;
  return getLatinRatio(text) >= CONFIG.language.minLatinRatio;
}

function sanitizeOutput(text, maxChars) {
  return String(text || '')
    .replace(/\r?\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars);
}

function hasRepeatedSentence(text) {
  const sentences = String(text || '')
    .split(/[.!?]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return new Set(sentences).size !== sentences.length;
}

function isOutputValid(text, maxTokens) {
  const normalized = normalizeWhitespace(text).toLowerCase();
  if (!normalized) return false;
  if (normalized.includes('dear user') || normalized.includes('dear caller')) return false;
  if (normalized.includes('system:') || normalized.includes('assistant:') || normalized.includes('instruction:')) return false;
  if (hasRepeatedSentence(normalized)) return false;
  if (normalized.length > maxTokens * 4) return false;
  return true;
}

function getQuickReply(text) {
  const key = normalizeWhitespace(text).toLowerCase();
  return QUICK_REPLIES[key] || '';
}

function isFallbackAllowed() {
  return CONFIG.fallback.enabled && (CONFIG.fallback.onTimeout || CONFIG.fallback.onError || CONFIG.fallback.onInvalid);
}

function getUserContext(userId) {
  if (!CONFIG.features.memory || !userId) return '';
  const history = userMemory.get(userId) || [];
  if (!history.length) return '';
  const lines = history.map((msg, idx) => `${idx + 1}. ${msg}`);
  return `Previous messages:\n${lines.join('\n')}`;
}

function pushMemory(userId, text) {
  if (!CONFIG.features.memory || !userId || !text) return;
  const prev = userMemory.get(userId) || [];
  prev.push(normalizeWhitespace(text));
  while (prev.length > CONFIG.memory.limit) prev.shift();
  userMemory.set(userId, prev);
}

function buildPrompt(input, context) {
  const base = 'Respondé en español claro, amigable y natural. Máximo 1 línea.';
  const parts = [base];
  if (context) parts.push(context);
  parts.push(`User: ${input}`);
  parts.push('Assistant:');
  return parts.join('\n\n');
}

async function askLocal(prompt, context) {
  const startedAt = Date.now();
  const { signal, cancel } = withTimeoutSignal();
  const payload = {
    model: CONFIG.local.model,
    prompt: buildPrompt(prompt, context),
    stream: false,
    options: {
      num_predict: CONFIG.local.maxTokens,
      temperature: CONFIG.local.temperature,
    },
  };

  try {
    const response = await httpClient.post(CONFIG.local.url, payload, { signal });
    const text = sanitizeOutput(response && response.data && response.data.response ? response.data.response : '', CONFIG.local.maxTokens * 4);
    const valid = !CONFIG.features.guardrails || isOutputValid(text, CONFIG.local.maxTokens);

    logStructured({
      source: 'local',
      latency: Date.now() - startedAt,
      fallback: false,
      error: valid ? null : 'invalid_output',
    });

    if (!text || !valid) return '';
    return text;
  } catch (error) {
    const errorMessage = error && error.name === 'CanceledError' ? 'timeout' : (error && error.message ? error.message : 'local_error');
    logStructured({ source: 'local', latency: Date.now() - startedAt, fallback: false, error: errorMessage });
    return '';
  } finally {
    cancel();
  }
}

async function askCloud(prompt, context) {
  const startedAt = Date.now();
  const { signal, cancel } = withTimeoutSignal();
  const url = `${CONFIG.cloud.url.replace(/\/+$/, '')}/${CONFIG.cloud.model}`;
  const payload = {
    inputs: buildPrompt(prompt, context),
    parameters: {
      max_new_tokens: CONFIG.cloud.maxTokens,
      temperature: CONFIG.cloud.temperature,
    },
  };

  try {
    const response = await httpClient.post(url, payload, {
      signal,
      headers: {
        Authorization: `Bearer ${CONFIG.cloud.token}`,
        'Content-Type': 'application/json',
      },
      validateStatus: () => true,
    });

    if (!response || response.status !== 200) {
      logStructured({ source: 'cloud', latency: Date.now() - startedAt, fallback: true, error: `http_${response ? response.status : 'no_response'}` });
      return '';
    }

    let rawText = '';
    if (Array.isArray(response.data) && response.data[0] && typeof response.data[0].generated_text === 'string') {
      rawText = response.data[0].generated_text;
    } else if (typeof response.data === 'string') {
      rawText = response.data;
    }

    const cleaned = sanitizeOutput(rawText.replace(payload.inputs, ''), CONFIG.cloud.maxTokens * 4);
    const valid = !CONFIG.features.guardrails || isOutputValid(cleaned, CONFIG.cloud.maxTokens);

    logStructured({
      source: 'cloud',
      latency: Date.now() - startedAt,
      fallback: !valid,
      error: valid ? null : 'invalid_output',
    });

    if (!cleaned || !valid) return '';
    return cleaned;
  } catch (error) {
    const errorMessage = error && error.name === 'CanceledError' ? 'timeout' : (error && error.message ? error.message : 'cloud_error');
    logStructured({ source: 'cloud', latency: Date.now() - startedAt, fallback: true, error: errorMessage });
    return '';
  } finally {
    cancel();
  }
}

async function routeHybrid(input, userId) {
  const text = normalizeWhitespace(input);
  if (!text) return '';

  const quick = getQuickReply(text);
  if (quick) return quick;

  if (!passesInputValidation(text)) {
    return 'Tu mensaje tiene caracteres no válidos. ¿Podés reescribirlo en español claro?';
  }

  const context = getUserContext(userId);

  if (text.length < CONFIG.system.simpleThreshold) {
    const localFirst = await askLocal(text, context);
    if (localFirst) return localFirst;
  } else {
    const cloudFirst = await askCloud(text, context);
    if (cloudFirst) return cloudFirst;
  }

  if (isFallbackAllowed()) {
    const localFallback = await askLocal(text, context);
    if (localFallback) return localFallback;
  }

  return SAFETY_FALLBACK_MESSAGE;
}

async function generateReply(userText, userId = '') {
  return routeHybrid(userText, userId);
}

async function handleIncomingMessage(client, message) {
  if (!client || !message) return;

  const from = String(message.from || '');
  const body = normalizeWhitespace(message.body || '');

  if (!from || !body) return;
  if (from.includes('@newsletter')) return;
  if (message.isMedia || message.isMMS || (message.type && message.type !== 'chat')) return;
  if (body.length > MESSAGE_LIMIT) return;

  const reply = await routeHybrid(body, from);
  const safeReply = sanitizeOutput(reply || SAFETY_FALLBACK_MESSAGE, 240);

  await client.sendText(from, safeReply).catch(() => {});

  pushMemory(from, `User: ${body}`);
  pushMemory(from, `Assistant: ${safeReply}`);
}

async function startBot() {
  const client = await wa.create({
    sessionId: CONFIG.whatsapp.sessionId,
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

  console.log('✅ WhatsApp bot is online with hybrid AI routing.');

  client.onMessage((msg) => {
    handleIncomingMessage(client, msg).catch((error) => {
      const errMsg = error && error.message ? error.message : 'handler_error';
      logStructured({ source: 'local', latency: 0, fallback: true, error: errMsg });
    });
  });
}

module.exports = {
  CONFIG,
  SAFETY_FALLBACK_MESSAGE,
  askCloud,
  askLocal,
  buildPrompt,
  generateReply,
  getChromeExecutablePath,
  handleIncomingMessage,
  routeHybrid,
  startBot,
};
