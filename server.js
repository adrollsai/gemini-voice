import Fastify from "fastify";
import fastifyWs from "@fastify/websocket";
import fastifyFormBody from "@fastify/formbody";
import WebSocket from "ws";
import dotenv from "dotenv";

dotenv.config();

// ---------- CONFIG ----------
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
  throw new Error("❌ GEMINI_API_KEY missing");
}

const MODEL = "gemini-live-2.5-flash-native-audio";

const GEMINI_URL =
  `wss://generativelanguage.googleapis.com/ws/gemini-live?key=${GEMINI_API_KEY}`;

const fastify = Fastify({ logger: true });
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// ---------- HEALTH ----------
fastify.get("/", async () => ({
  status: "ok",
  service: "Gemini Live 2.5 Voice Bridge"
}));

// ---------- TWIML ----------
fastify.all("/twiml", async (req, reply) => {
  const host = req.headers.host;

  reply.type("text/xml").send(`
<Response>
  <Connect>
    <Stream url="wss://${host}/media-stream" />
  </Connect>
</Response>
  `);
});

// ---------- MEDIA STREAM ----------
fastify.register(async (app) => {
  app.get("/media-stream", { websocket: true }, (conn) => {
    fastify.log.info("🔵 Twilio connected");

    let streamSid;
    let geminiReady = false;

    // ---------- GEMINI WS ----------
    const geminiWs = new WebSocket(GEMINI_URL);

    geminiWs.on("open", () => {
      fastify.log.info("🟢 Gemini connected");

      geminiWs.send(JSON.stringify({
        setup: {
          model: MODEL,
          generation_config: {
            response_modalities: ["AUDIO"]
          }
        }
      }));
    });

    geminiWs.on("message", (msg) => {
      const data = JSON.parse(msg);

      // ---- READY ----
      if (data.setupComplete && !geminiReady) {
        geminiReady = true;
        fastify.log.info("✅ Gemini ready");
        return;
      }

      // ---- AUDIO OUTPUT ----
      const parts = data.serverContent?.modelTurn?.parts;
      if (!parts || !streamSid) return;

      for (const part of parts) {
        if (part.inlineData?.mimeType?.startsWith("audio/pcm")) {
          const pcm24k = Buffer.from(part.inlineData.data, "base64");
          const mulaw = pcm24kToMulaw8k(pcm24k);

          conn.socket.send(JSON.stringify({
            event: "media",
            streamSid,
            media: { payload: mulaw.toString("base64") }
          }));
        }
      }
    });

    geminiWs.on("error", err =>
      fastify.log.error("Gemini error", err)
    );

    // ---------- TWILIO ----------
    conn.socket.on("message", (raw) => {
      const data = JSON.parse(raw);

      if (data.event === "start") {
        streamSid = data.start.streamSid;
        fastify.log.info(`▶️ Stream started ${streamSid}`);
        return;
      }

      if (data.event === "media" && geminiReady) {
        const mulaw = Buffer.from(data.media.payload, "base64");
        const pcm16k = mulaw8kToPcm16k(mulaw);

        geminiWs.send(JSON.stringify({
          input_audio_buffer: {
            audio: pcm16k.toString("base64")
          }
        }));
      }

      if (data.event === "stop") {
        fastify.log.info("⏹️ Stream ended");
        geminiWs.close();
      }
    });
  });
});

// ---------- AUDIO UTILS ----------

// ⛔ KEEP YOUR FULL MU_LAW_TABLE HERE
const MU_LAW_TABLE = [
  /* YOUR EXISTING FULL TABLE — DO NOT CHANGE */
];

function mulaw8kToPcm16k(mulaw) {
  const pcm8k = new Int16Array(mulaw.length);

  for (let i = 0; i < mulaw.length; i++) {
    pcm8k[i] = MU_LAW_TABLE[mulaw[i] ^ 0xff];
  }

  const pcm16k = new Int16Array(pcm8k.length * 2);
  for (let i = 0; i < pcm8k.length; i++) {
    pcm16k[i * 2] = pcm8k[i];
    pcm16k[i * 2 + 1] = pcm8k[i];
  }

  return Buffer.from(pcm16k.buffer);
}

function pcm24kToMulaw8k(pcm24k) {
  const pcm = new Int16Array(
    pcm24k.buffer,
    pcm24k.byteOffset,
    pcm24k.length / 2
  );

  const mulaw = new Uint8Array(Math.floor(pcm.length / 3));
  for (let i = 0; i < mulaw.length; i++) {
    mulaw[i] = encodeMuLaw(pcm[i * 3]);
  }
  return Buffer.from(mulaw);
}

const BIAS = 0x84;
const CLIP = 32635;

function encodeMuLaw(sample) {
  let sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;

  let exponent = 7;
  for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; mask >>= 1) {
    exponent--;
  }

  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa);
}

// ---------- START ----------
fastify.listen({ port: PORT, host: "0.0.0.0" }, (err, address) => {
  if (err) {
    fastify.log.error(err);
    process.exit(1);
  }
  fastify.log.info(`🚀 Listening on ${address}`);
});
