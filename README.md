# Ollama WhatsApp Bot (Node.js + open-wa)

Bot de WhatsApp en Node.js que envía mensajes entrantes a Ollama local y devuelve respuestas conversacionales.

## Requisitos

- Node.js 25.8.1 (o compatible)
- npm 11.11.0 (o compatible)
- Linux/macOS/Windows
- Google Chrome instalado (si no, define `CHROME_PATH`)
- Ollama corriendo localmente (`ollama serve`)
- Modelo descargado en Ollama (ejemplo: `ollama pull tinyllama`)

## Instalación

```bash
npm install
cp .env.example .env
```

## Variables de entorno (`.env`)

```env
OLLAMA_HOST=http://127.0.0.1:11434
OLLAMA_URL=http://127.0.0.1:11434/api/generate
OLLAMA_MODEL=tinyllama
SYSTEM_PROMPT=Respondé en 1 línea, voseo tico, corto y natural. Sin explicaciones.
WA_SESSION_ID=ollama-whatsapp-bot
OLLAMA_TIMEOUT_MS=15000
OLLAMA_MAX_RETRIES=1
OLLAMA_HEALTH_TIMEOUT_MS=5000
OLLAMA_NUM_PARALLEL=1
# CHROME_PATH=/usr/bin/google-chrome
```

## Probar Ollama desde terminal

```bash
curl -X POST http://127.0.0.1:11434/api/generate \
  -H "Content-Type: application/json" \
  -d '{"model":"tinyllama","prompt":"Hola, ¿me escuchas?","stream":false}'
```

## Estructura

- `index.js`: punto de entrada mínimo.
- `src/bot.js`: lógica principal del bot (Ollama + WhatsApp).
- `scripts/simulate-message.js`: simulación local sin WhatsApp real.

## Confiabilidad (retry + health check)

- `generateReply()` reintenta hasta **2 veces** (3 intentos totales).
- Reintenta sólo en timeout/errores de red (`ECONNABORTED`, `ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`).
- Usa backoff exponencial: **500ms → 1000ms**.
- **No** reintenta errores HTTP 4xx.
- Si Ollama falla o supera timeout, responde fallback inmediato:
  - `Mae luego te respondo 😅`
- `checkOllamaHealth()` valida conectividad de Ollama con `GET /api/tags` antes del procesamiento (sin invocar inferencia).
- Si el health check falla, el bot **igual intenta generar respuesta** (evita falsos negativos).

## Ejecutar bot de WhatsApp

```bash
npm start
```

Al iniciar, escanea el QR y espera mensajes.

## Simular mensaje sin WhatsApp real

Puedes pasar múltiples mensajes como argumentos:

```bash
npm run simulate -- "hola" "cómo estás" "contame un chiste"
```

También puedes pasar varios en un único argumento usando `||`:

```bash
npm run simulate -- "hola||qué tal||hacé resumen"
```

El simulador imprime:
- salida de `generateReply()`
- envío simulado por `sendText`
- tiempo de ejecución por mensaje
- separación clara entre casos

## Logging incluido

El bot imprime:
- Prompt enviado a Ollama
- URL, timeout y payload del request
- Status, headers y body de respuesta
- Tiempo total de ida y vuelta
- Errores detallados (code/status/body)
- Intentos de retry y backoff
- Resultado de health check

## Troubleshooting (timeouts/Ollama local)

1. Verifica que Ollama esté activo:
   - `ollama serve`
2. Verifica endpoint manualmente con curl (arriba).
3. Si hay timeouts:
   - aumenta `OLLAMA_TIMEOUT_MS` (ej. 45000)
   - confirma que el modelo esté descargado (`ollama pull tinyllama`)
4. Si hay errores de conexión:
   - usa `127.0.0.1` en lugar de `localhost`
   - revisa firewall/proxy local
5. Si el bot responde fallback frecuente:
   - revisa logs `[OLLAMA][HEALTH]`, `[OLLAMA][RETRY]` y `[OLLAMA][ERROR]`.




## Modo ligero para hardware limitado (CPU + ~12GB RAM)

- Modelo primario: `tinyllama`
- Alternativa: `phi3:mini`
- No usar modelos mayores a 4B en este entorno.
- No cambiar modelo automáticamente desde el bot.
- Priorizar velocidad sobre precisión (chat corto tipo WhatsApp).

Comandos sugeridos:

```bash
ollama rm mistral
ollama rm llama3
ollama pull tinyllama
ollama serve
```

> Nota: usa `ollama rm` (no `remove`).

Request optimizado que usa el bot:

```json
{
  "model": "tinyllama",
  "prompt": "Respondé en 1 línea, voseo tico, corto y natural. Sin explicaciones.",
  "stream": false,
  "options": {
    "num_predict": 25,
    "temperature": 0.7,
    "stop": ["\n"]
  }
}
```


### Modo GOD TIER (opcional ya aplicado)

- Si el mensaje parece complejo (muy largo o con señales de análisis), el bot evita IA y responde fallback inmediato para mantener latencia baja.
