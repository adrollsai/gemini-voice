import Fastify from "fastify";
import fastifyWs from "@fastify/websocket";
import fastifyFormBody from "@fastify/formbody";
import WebSocket from "ws";
import dotenv from "dotenv";

dotenv.config();

/* ================= CONFIG ================= */

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
  throw new Error("❌ GEMINI_API_KEY missing");
}

const GEMINI_MODEL = "gemini-live-2.5-flash-native-audio";
const GEMINI_WS_URL =
  `wss://generativelanguage.googleapis.com/ws/gemini-live?key=${GEMINI_API_KEY}`;

/* ================= SERVER ================= */

const fastify = Fastify({ logger: true });
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

/* ================= HEALTH ================= */

fastify.get("/", async () => ({
  ok: true,
  service: "Twilio ↔ Gemini Live Voice Bridge"
}));

/* ================= TWIML ================= */

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

/* ================= MEDIA STREAM ================= */

fastify.register(async (app) => {
  app.get("/media-stream", { websocket: true }, (conn) => {
    fastify.log.info("🔵 Twilio connected");

    let streamSid;
    let geminiReady = false;

    /* ---------- Gemini WS ---------- */

    const geminiWs = new WebSocket(GEMINI_WS_URL);

    geminiWs.on("open", () => {
      fastify.log.info("🟢 Gemini connected");

      geminiWs.send(JSON.stringify({
        setup: {
          model: GEMINI_MODEL,
          generation_config: {
            response_modalities: ["AUDIO"]
          }
        }
      }));
    });

    geminiWs.on("message", (raw) => {
      const msg = JSON.parse(raw);

      if (msg.error) {
        fastify.log.error("❌ Gemini API error", msg.error);
        return;
      }

      if (msg.setupComplete && !geminiReady) {
        geminiReady = true;
        fastify.log.info("✅ Gemini ready");
        return;
      }

      const parts = msg.serverContent?.modelTurn?.parts;
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

    geminiWs.on("close", () =>
      fastify.log.info("🔴 Gemini closed")
    );

    geminiWs.on("error", (err) =>
      fastify.log.error("Gemini socket error", err)
    );

    /* ---------- Twilio ---------- */

    conn.socket.on("message", (raw) => {
      const msg = JSON.parse(raw);

      if (msg.event === "start") {
        streamSid = msg.start.streamSid;
        fastify.log.info(`▶️ Stream started ${streamSid}`);
        return;
      }

      if (msg.event === "media" && geminiReady) {
        if (geminiWs.readyState !== WebSocket.OPEN) return;

        const mulaw = Buffer.from(msg.media.payload, "base64");
        const pcm16k = mulaw8kToPcm16k(mulaw);

        geminiWs.send(JSON.stringify({
          input_audio_buffer: {
            audio: pcm16k.toString("base64")
          }
        }));
      }

      if (msg.event === "stop") {
        fastify.log.info("⏹️ Stream ended");
        geminiWs.close();
      }
    });
  });
});

/* ================= AUDIO ================= */

/* μ-law decode table (FULL REQUIRED) */
const MU_LAW_TABLE = [
  -32124,-31100,-30076,-29052,-28028,-27004,-25980,-24956,
  -23932,-22908,-21884,-20860,-19836,-18812,-17788,-16764,
  -15996,-15484,-14972,-14460,-13948,-13436,-12924,-12412,
  -11900,-11388,-10876,-10364,-9852,-9340,-8828,-8316,
  -7932,-7676,-7420,-7164,-6908,-6652,-6396,-6140,
  -5884,-5628,-5372,-5116,-4860,-4604,-4348,-4092,
  -3900,-3772,-3644,-3516,-3388,-3260,-3132,-3004,
  -2876,-2748,-2620,-2492,-2364,-2236,-2108,-1980,
  -1884,-1820,-1756,-1692,-1628,-1564,-1500,-1436,
  -1372,-1308,-1244,-1180,-1116,-1052,-988,-924,
  -876,-844,-812,-780,-748,-716,-684,-652,
  -620,-588,-556,-524,-492,-460,-428,-396,
  -372,-356,-340,-324,-308,-292,-276,-260,
  -244,-228,-212,-196,-180,-164,-148,-132,
  -120,-112,-104,-96,-88,-80,-72,-64,
  -56,-48,-40,-32,-24,-16,-8,0,
  32124,31100,30076,29052,28028,27004,25980,24956,
  23932,22908,21884,20860,19836,18812,17788,16764,
  15996,15484,14972,14460,13948,13436,12924,12412,
  11900,11388,10876,10364,9852,9340,8828,8316,
  7932,7676,7420,7164,6908,6652,6396,6140,
  5884,5628,5372,5116,4860,4604,4348,4092,
  3900,3772,3644,3516,3388,3260,3132,3004,
  2876,2748,2620,2492,2364,2236,2108,1980,
  1884,1820,1756,1692,1628,1564,1500,1436,
  1372,1308,1244,1180,1116,1052,988,924,
  876,844,812,780,748,716,684,652,
  620,588,556,524,492,460,428,396,
  372,356,340,324,308,292,276,260,
  244,228,212,196,180,164,148,132,
  120,112,104,96,88,80,72,64,
  56,48,40,32,24,16,8,0
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

/* ================= START ================= */

fastify.listen({ port: PORT, host: "0.0.0.0" }, (err, address) => {
  if (err) {
    fastify.log.error(err);
    process.exit(1);
  }
  fastify.log.info(`🚀 Server listening on ${address}`);
});
