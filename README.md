# Ollama WhatsApp Bot (Node.js + open-wa)

Bot de WhatsApp en Node.js que envía mensajes entrantes a Ollama local y devuelve respuestas conversacionales.

## Requisitos

- Node.js 25.8.1 (o compatible)
- npm 11.11.0 (o compatible)
- Linux/macOS/Windows
- Google Chrome instalado (si no, define `CHROME_PATH`)
- Ollama corriendo localmente (`ollama serve`)
- Modelo descargado en Ollama (ejemplo: `ollama pull mistral`)

## Instalación

```bash
npm install
cp .env.example .env
```

## Variables de entorno (`.env`)

```env
OLLAMA_URL=http://127.0.0.1:11434/api/generate
OLLAMA_MODEL=mistral
SYSTEM_PROMPT=You are a friendly assistant that speaks casually and naturally, like a close friend.
WA_SESSION_ID=ollama-whatsapp-bot
OLLAMA_TIMEOUT_MS=15000
OLLAMA_MAX_RETRIES=2
OLLAMA_HEALTH_TIMEOUT_MS=5000
# CHROME_PATH=/usr/bin/google-chrome
```

## Probar Ollama desde terminal

```bash
curl -X POST http://127.0.0.1:11434/api/generate \
  -H "Content-Type: application/json" \
  -d '{"model":"mistral","prompt":"Hola, ¿me escuchas?","stream":false}'
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
- Si todo falla, responde fallback seguro:
  - `Lo siento, tuve un problema técnico 😅. Intentá de nuevo en un momento.`
- `checkOllamaHealth()` valida conectividad de Ollama antes del procesamiento.

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
   - aumenta `OLLAMA_TIMEOUT_MS` (ej. 30000)
   - confirma que el modelo esté descargado (`ollama pull mistral`)
4. Si hay errores de conexión:
   - usa `127.0.0.1` en lugar de `localhost`
   - revisa firewall/proxy local
5. Si el bot responde fallback frecuente:
   - revisa logs `[OLLAMA][HEALTH]`, `[OLLAMA][RETRY]` y `[OLLAMA][ERROR]`.
