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
    timeout: Number(process.env.CLOUD_TIMEOUT_MS || process.env.TIMEOUT_MS || 12000),
    retries: Number(process.env.CLOUD_RETRIES || 1),
  },
  local: {
    url: process.env.OLLAMA_URL || 'http://127.0.0.1:11434/api/generate',
    model: process.env.OLLAMA_MODEL || 'gemma:2b',
    maxTokens: Number(process.env.LOCAL_MAX_TOKENS || 64),
    temperature: Number(process.env.LOCAL_TEMPERATURE || 0.3),
    timeout: Number(process.env.LOCAL_TIMEOUT_MS || process.env.TIMEOUT_MS || 12000),
    retries: Number(process.env.LOCAL_RETRIES || 1),
  },
  system: {
    timeout: Number(process.env.TIMEOUT_MS || 12000),
    simpleThreshold: Number(process.env.SIMPLE_THRESHOLD || 60),
    healthTtlMs: Number(process.env.HEALTH_TTL_MS || 20000),
    globalTimeoutMs: Number(process.env.GLOBAL_TIMEOUT_MS || 14000),
    cacheTtlMs: Number(process.env.CACHE_TTL_MS || 45000),
    metricsWindowSize: Number(process.env.METRICS_WINDOW_SIZE || 20),
  },
  features: {
    guardrails: process.env.ENABLE_GUARDRAILS === 'true',
    memory: process.env.ENABLE_MEMORY === 'true',
    logs: process.env.ENABLE_LOGS !== 'false',
    warmup: process.env.ENABLE_WARMUP !== 'false',
    parallelMode: process.env.ENABLE_PARALLEL_MODE === 'true',
    adaptiveRouting: process.env.ENABLE_ADAPTIVE_ROUTING !== 'false',
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
const responseCache = new Map();
const healthCache = {
  local: { ok: null, updatedAt: 0 },
  cloud: { ok: null, updatedAt: 0 },
};
const modelMetrics = {
  local: { history: [], avgLatency: null, successRate: 1, timeoutRate: 0, lastTimeoutAt: 0, cooldownUntil: 0, total: 0 },
  cloud: { history: [], avgLatency: null, successRate: 1, timeoutRate: 0, lastTimeoutAt: 0, cooldownUntil: 0, total: 0 },
};

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

function createAbortControl(timeoutMs, parentSignal) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));

  if (parentSignal) {
    if (parentSignal.aborted) controller.abort();
    else parentSignal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  return { signal: controller.signal, cancel: () => clearTimeout(timeout), controller };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTimeoutError(error) {
  const code = error && error.code ? error.code : '';
  return error && (error.name === 'CanceledError' || code === 'ECONNABORTED' || code === 'ETIMEDOUT');
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

function isCloudConfigured() {
  return Boolean(CONFIG.cloud.url && CONFIG.cloud.model && CONFIG.cloud.token);
}

function isFallbackAllowed(reason) {
  if (!CONFIG.fallback.enabled) return false;
  if (reason === 'timeout') return CONFIG.fallback.onTimeout;
  if (reason === 'invalid') return CONFIG.fallback.onInvalid;
  return CONFIG.fallback.onError;
}

function cacheKeyForMessage(text) {
  return normalizeWhitespace(text).toLowerCase();
}

function getCachedResponse(text) {
  const key = cacheKeyForMessage(text);
  const hit = responseCache.get(key);
  if (!hit) return '';
  if (hit.expiresAt < Date.now()) {
    responseCache.delete(key);
    return '';
  }
  return hit.value;
}

function setCachedResponse(text, value) {
  const cleaned = sanitizeOutput(value, 240);
  if (!cleaned) return;
  responseCache.set(cacheKeyForMessage(text), {
    value: cleaned,
    expiresAt: Date.now() + CONFIG.system.cacheTtlMs,
  });
}

function recordModelOutcome(source, outcome) {
  const metric = modelMetrics[source];
  if (!metric) return;

  metric.total += 1;
  metric.history.push({
    success: Boolean(outcome.success),
    timeout: Boolean(outcome.timeout),
    latency: outcome.latency || 0,
    ts: Date.now(),
  });

  while (metric.history.length > CONFIG.system.metricsWindowSize) metric.history.shift();

  const total = metric.history.length || 1;
  const successCount = metric.history.filter((x) => x.success).length;
  const timeoutCount = metric.history.filter((x) => x.timeout).length;
  const latencyValues = metric.history.map((x) => x.latency).filter((n) => n > 0);

  metric.successRate = successCount / total;
  metric.timeoutRate = timeoutCount / total;
  metric.avgLatency = latencyValues.length
    ? Math.round(latencyValues.reduce((a, b) => a + b, 0) / latencyValues.length)
    : null;

  if (outcome.timeout) {
    metric.lastTimeoutAt = Date.now();
  }

  const recent = metric.history.slice(-3);
  const consecutiveFailures = recent.length >= 3 && recent.every((x) => !x.success);
  if (consecutiveFailures || metric.timeoutRate > 0.6) {
    metric.cooldownUntil = Date.now() + 30000;
  }
}

function isInCooldown(source) {
  const metric = modelMetrics[source];
  if (!metric) return false;
  return metric.cooldownUntil > Date.now();
}

function getModelScore(source, intent) {
  const metric = modelMetrics[source];
  const reliability = metric.successRate;
  const timeoutPenalty = metric.timeoutRate;
  const latencyNorm = metric.avgLatency ? Math.min(metric.avgLatency / 15000, 1) : 0.5;
  const cost = source === 'local' ? 1 : 0.6;
  const intentBoost = intent === 'complex' ? (source === 'cloud' ? 0.15 : -0.05) : (source === 'local' ? 0.15 : -0.05);
  const cooldownPenalty = isInCooldown(source) ? 0.9 : 0;

  const score = (reliability * 0.6) + ((1 - latencyNorm) * 0.25) + (cost * 0.15) + intentBoost - (timeoutPenalty * 0.4) - cooldownPenalty;

  return {
    source,
    score: Number(score.toFixed(4)),
    breakdown: {
      reliability: Number(reliability.toFixed(3)),
      timeoutRate: Number(timeoutPenalty.toFixed(3)),
      avgLatency: metric.avgLatency,
      cost,
      intentBoost,
      cooldown: isInCooldown(source),
    },
  };
}

function latencySnapshot() {
  return {
    local: {
      successRate: Number(modelMetrics.local.successRate.toFixed(3)),
      timeoutRate: Number(modelMetrics.local.timeoutRate.toFixed(3)),
      avgLatency: modelMetrics.local.avgLatency,
      cooldownUntil: modelMetrics.local.cooldownUntil,
    },
    cloud: {
      successRate: Number(modelMetrics.cloud.successRate.toFixed(3)),
      timeoutRate: Number(modelMetrics.cloud.timeoutRate.toFixed(3)),
      avgLatency: modelMetrics.cloud.avgLatency,
      cooldownUntil: modelMetrics.cloud.cooldownUntil,
    },
  };
}

function classifyIntent(text) {
  const normalized = normalizeWhitespace(text).toLowerCase();
  const complexHints = ['analiza', 'compará', 'explicá', 'resume', 'detalle', 'paso a paso', 'código'];
  if (normalized.length > CONFIG.system.simpleThreshold) return 'complex';
  if (complexHints.some((hint) => normalized.includes(hint))) return 'complex';
  return 'simple';
}

function getUserContext(userId) {
  if (!CONFIG.features.memory || !userId) return '';
  const history = userMemory.get(userId) || [];
  if (!history.length) return '';
  return `Previous messages:\n${history.map((msg, idx) => `${idx + 1}. ${msg}`).join('\n')}`;
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
  return [base, context || '', `User: ${input}`, 'Assistant:'].filter(Boolean).join('\n\n');
}

function remainingTime(deadlineMs, modelTimeout) {
  if (!deadlineMs) return modelTimeout;
  return Math.max(1, Math.min(modelTimeout, deadlineMs - Date.now()));
}

async function checkLocalHealth(force = false) {
  const now = Date.now();
  if (!force && healthCache.local.ok !== null && now - healthCache.local.updatedAt < CONFIG.system.healthTtlMs) {
    return healthCache.local.ok;
  }

  const { signal, cancel } = createAbortControl(Math.min(CONFIG.local.timeout, 4000));
  try {
    const baseUrl = new URL(CONFIG.local.url);
    const tagsUrl = `${baseUrl.protocol}//${baseUrl.host}/api/tags`;
    const response = await httpClient.get(tagsUrl, { signal, validateStatus: () => true });
    healthCache.local.ok = response.status >= 200 && response.status < 500;
  } catch (_error) {
    healthCache.local.ok = false;
  } finally {
    healthCache.local.updatedAt = now;
    cancel();
  }
  return healthCache.local.ok;
}

async function checkCloudHealth(force = false) {
  if (!isCloudConfigured()) return false;

  const now = Date.now();
  if (!force && healthCache.cloud.ok !== null && now - healthCache.cloud.updatedAt < CONFIG.system.healthTtlMs) {
    return healthCache.cloud.ok;
  }

  const { signal, cancel } = createAbortControl(Math.min(CONFIG.cloud.timeout, 4000));
  try {
    const url = `${CONFIG.cloud.url.replace(/\/+$/, '')}/${CONFIG.cloud.model}`;
    const response = await httpClient.get(url, {
      signal,
      headers: { Authorization: `Bearer ${CONFIG.cloud.token}` },
      validateStatus: () => true,
    });
    healthCache.cloud.ok = response.status < 500;
  } catch (_error) {
    healthCache.cloud.ok = false;
  } finally {
    healthCache.cloud.updatedAt = now;
    cancel();
  }

  return healthCache.cloud.ok;
}

async function askLocal(prompt, context, runtime = {}) {
  const payload = {
    model: CONFIG.local.model,
    prompt: buildPrompt(prompt, context),
    stream: false,
    options: {
      num_predict: CONFIG.local.maxTokens,
      temperature: CONFIG.local.temperature,
    },
  };

  for (let attempt = 0; attempt <= CONFIG.local.retries; attempt += 1) {
    const startedAt = Date.now();
    const timeoutMs = remainingTime(runtime.deadlineMs, CONFIG.local.timeout);
    if (timeoutMs <= 5) return '';

    const { signal, cancel } = createAbortControl(timeoutMs, runtime.signal);
    try {
      const response = await httpClient.post(CONFIG.local.url, payload, { signal, validateStatus: () => true });
      const latency = Date.now() - startedAt;
      const statusOk = response.status >= 200 && response.status < 300;
      const text = sanitizeOutput(response && response.data && response.data.response ? response.data.response : '', CONFIG.local.maxTokens * 4);
      const valid = statusOk && (!CONFIG.features.guardrails || isOutputValid(text, CONFIG.local.maxTokens));
      const failureType = !statusOk ? 'error' : (!valid || !text ? 'invalid' : null);

      recordModelOutcome('local', { success: Boolean(valid && text), timeout: false, latency });
      healthCache.local = { ok: statusOk, updatedAt: Date.now() };

      logStructured({ source: 'local', latency, fallback: Boolean(failureType), error: failureType, retries: attempt });

      if (valid && text) return text;
      if (!isFallbackAllowed(failureType || 'error')) return '';
    } catch (error) {
      const latency = Date.now() - startedAt;
      const timeoutHit = isTimeoutError(error);
      const failureType = timeoutHit ? 'timeout' : 'error';

      recordModelOutcome('local', { success: false, timeout: timeoutHit, latency });
      healthCache.local = { ok: false, updatedAt: Date.now() };

      logStructured({ source: 'local', latency, fallback: true, error: failureType, retries: attempt });

      if (attempt >= CONFIG.local.retries || !isFallbackAllowed(failureType)) break;
      await sleep(200 * 2 ** attempt);
    } finally {
      cancel();
    }
  }

  return '';
}

async function askCloud(prompt, context, runtime = {}) {
  if (!isCloudConfigured()) return '';

  const url = `${CONFIG.cloud.url.replace(/\/+$/, '')}/${CONFIG.cloud.model}`;
  const payload = {
    inputs: buildPrompt(prompt, context),
    parameters: {
      max_new_tokens: CONFIG.cloud.maxTokens,
      temperature: CONFIG.cloud.temperature,
    },
  };

  for (let attempt = 0; attempt <= CONFIG.cloud.retries; attempt += 1) {
    const startedAt = Date.now();
    const timeoutMs = remainingTime(runtime.deadlineMs, CONFIG.cloud.timeout);
    if (timeoutMs <= 5) return '';

    const { signal, cancel } = createAbortControl(timeoutMs, runtime.signal);

    try {
      const response = await httpClient.post(url, payload, {
        signal,
        headers: {
          Authorization: `Bearer ${CONFIG.cloud.token}`,
          'Content-Type': 'application/json',
        },
        validateStatus: () => true,
      });

      const latency = Date.now() - startedAt;
      const statusOk = response.status === 200;
      const rawText = Array.isArray(response.data) && response.data[0] && typeof response.data[0].generated_text === 'string'
        ? response.data[0].generated_text
        : (typeof response.data === 'string' ? response.data : '');
      const text = sanitizeOutput(rawText.replace(payload.inputs, ''), CONFIG.cloud.maxTokens * 4);
      const valid = statusOk && (!CONFIG.features.guardrails || isOutputValid(text, CONFIG.cloud.maxTokens));
      const failureType = !statusOk ? 'error' : (!valid || !text ? 'invalid' : null);

      recordModelOutcome('cloud', { success: Boolean(valid && text), timeout: false, latency });
      healthCache.cloud = { ok: statusOk, updatedAt: Date.now() };

      logStructured({ source: 'cloud', latency, fallback: Boolean(failureType), error: failureType, retries: attempt });

      if (valid && text) return text;
      if (!isFallbackAllowed(failureType || 'error')) return '';
    } catch (error) {
      const latency = Date.now() - startedAt;
      const timeoutHit = isTimeoutError(error);
      const failureType = timeoutHit ? 'timeout' : 'error';

      recordModelOutcome('cloud', { success: false, timeout: timeoutHit, latency });
      healthCache.cloud = { ok: false, updatedAt: Date.now() };

      logStructured({ source: 'cloud', latency, fallback: true, error: failureType, retries: attempt });

      if (attempt >= CONFIG.cloud.retries || !isFallbackAllowed(failureType)) break;
      await sleep(200 * 2 ** attempt);
    } finally {
      cancel();
    }
  }

  return '';
}

function rankModels(intent, localHealthy, cloudHealthy) {
  if (!CONFIG.features.adaptiveRouting) {
    const baseOrder = intent === 'complex' ? ['cloud', 'local'] : ['local', 'cloud'];
    const filtered = baseOrder.filter((source) => {
      if (source === 'cloud') return cloudHealthy && isCloudConfigured() && !isInCooldown('cloud');
      return localHealthy && !isInCooldown('local');
    });
    return {
      ranking: filtered,
      scores: [getModelScore('local', intent), getModelScore('cloud', intent)],
    };
  }

  const scoreLocal = getModelScore('local', intent);
  const scoreCloud = getModelScore('cloud', intent);

  const candidates = [
    { ...scoreLocal, available: localHealthy && !isInCooldown('local') },
    { ...scoreCloud, available: cloudHealthy && !isInCooldown('cloud') && isCloudConfigured() },
  ].filter((m) => m.available);

  candidates.sort((a, b) => b.score - a.score);
  return { ranking: candidates.map((x) => x.source), scores: [scoreLocal, scoreCloud] };
}

async function runParallelRace(text, context, deadlineMs) {
  const raceController = new AbortController();
  const localTask = askLocal(text, context, { deadlineMs, signal: raceController.signal })
    .then((value) => ({ source: 'local', value }));
  const cloudTask = askCloud(text, context, { deadlineMs, signal: raceController.signal })
    .then((value) => ({ source: 'cloud', value }));

  const first = await Promise.race([localTask, cloudTask]);
  if (first.value) {
    raceController.abort();
    return first;
  }

  const second = await (first.source === 'local' ? cloudTask : localTask);
  raceController.abort();
  if (second.value) return second;
  return { source: 'none', value: '' };
}

async function routeHybrid(input, userId) {
  const startedAt = Date.now();
  const deadlineMs = Date.now() + CONFIG.system.globalTimeoutMs;
  const text = normalizeWhitespace(input);
  if (!text) return '';

  const cached = getCachedResponse(text);
  if (cached) {
    logStructured({ source: 'cache', latency: Date.now() - startedAt, fallback: false, error: null, cache: 'hit' });
    return cached;
  }
  logStructured({ source: 'cache', latency: 0, fallback: false, error: null, cache: 'miss' });

  const quick = getQuickReply(text);
  if (quick) {
    setCachedResponse(text, quick);
    return quick;
  }

  if (!passesInputValidation(text)) {
    return 'Tu mensaje tiene caracteres no válidos. ¿Podés reescribirlo en español claro?';
  }

  const intent = classifyIntent(text);
  const context = getUserContext(userId);
  const [localHealthy, cloudHealthy] = await Promise.all([checkLocalHealth(), checkCloudHealth()]);
  const { ranking, scores } = rankModels(intent, localHealthy, cloudHealthy);

  if (CONFIG.features.parallelMode && localHealthy && cloudHealthy && ranking.length > 1) {
    const raceResult = await runParallelRace(text, context, deadlineMs);
    logStructured({
      source: 'router',
      latency: Date.now() - startedAt,
      fallback: raceResult.source !== ranking[0],
      error: raceResult.value ? null : 'parallel_failed',
      decisionScore: scores,
      modelRanking: ranking,
      parallelRaceWinner: raceResult.source,
      globalTimeoutTriggered: Date.now() > deadlineMs,
      latencyHistory: latencySnapshot(),
    });

    if (raceResult.value) {
      setCachedResponse(text, raceResult.value);
      return raceResult.value;
    }
  }

  const fallbackChain = [];
  for (let i = 0; i < ranking.length; i += 1) {
    if (Date.now() > deadlineMs) {
      logStructured({ source: 'router', latency: Date.now() - startedAt, fallback: true, error: 'global_timeout', globalTimeoutTriggered: true });
      return SAFETY_FALLBACK_MESSAGE;
    }

    const source = ranking[i];
    fallbackChain.push(source);
    const output = source === 'local'
      ? await askLocal(text, context, { deadlineMs })
      : await askCloud(text, context, { deadlineMs });

    if (output) {
      setCachedResponse(text, output);
      logStructured({
        source: 'router',
        latency: Date.now() - startedAt,
        fallback: i > 0,
        error: null,
        decisionScore: scores,
        modelRanking: ranking,
        fallbackChain,
        globalTimeoutTriggered: false,
        latencyHistory: latencySnapshot(),
      });
      return output;
    }
  }

  logStructured({
    source: 'router',
    latency: Date.now() - startedAt,
    fallback: true,
    error: Date.now() > deadlineMs ? 'global_timeout' : 'all_models_failed',
    decisionScore: scores,
    modelRanking: ranking,
    fallbackChain,
    globalTimeoutTriggered: Date.now() > deadlineMs,
    latencyHistory: latencySnapshot(),
  });

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

async function warmupLocalModel() {
  if (!CONFIG.features.warmup) return;
  await askLocal('hola', '').catch(() => {});
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

  await Promise.all([checkLocalHealth(true), checkCloudHealth(true)]).catch(() => {});
  await warmupLocalModel();

  console.log('✅ WhatsApp bot is online with hybrid AI routing.');

  client.onMessage((msg) => {
    handleIncomingMessage(client, msg).catch((error) => {
      const errMsg = error && error.message ? error.message : 'handler_error';
      logStructured({ source: 'handler', latency: 0, fallback: true, error: errMsg });
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
