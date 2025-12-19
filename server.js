import Fastify from 'fastify';
import fastifyWs from '@fastify/websocket';
import fastifyFormBody from '@fastify/formbody';
import WebSocket from 'ws';

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODEL = "models/gemini-2.5-flash-native-audio-preview-12-2025";
const GEMINI_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;

const fastify = Fastify({ logger: true });
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

fastify.get('/', async () => ({ status: "OK", system: "Gemini 2.5 Voice Bridge" }));

// 1. Twilio Webhook
fastify.all('/twiml', async (request, reply) => {
  const host = request.headers.host;
  const wssUrl = `wss://${host}/media-stream`;
  reply.type('text/xml');
  return `<?xml version="1.0" encoding="UTF-8"?>
  <Response>
      <Connect>
          <Stream url="${wssUrl}" />
      </Connect>
      <Pause length="3600" />
  </Response>`;
});

// 2. WebSocket Handler
fastify.register(async (fastify) => {
  fastify.get('/media-stream', { websocket: true }, (connection, req) => {
    console.log("📞 Twilio Stream Connected");

    let streamSid = null;
    let geminiWs = new WebSocket(GEMINI_URL);
    let audioBuffer = []; // Buffer to collect chunks

    // Connect to Gemini
    geminiWs.on('open', () => {
      console.log("✨ Connected to Gemini 2.5");

      // Setup Message
      const setupMsg = {
        setup: {
          model: MODEL,
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName: "Puck" } }
            }
          }
        }
      };
      geminiWs.send(JSON.stringify(setupMsg));

      // Initial Greeting
      const greetingMsg = {
        clientContent: {
          turns: [{
            role: "user",
            parts: [{ text: "Hello, please introduce yourself." }]
          }],
          turnComplete: true
        }
      };
      geminiWs.send(JSON.stringify(greetingMsg));
    });

    // Handle Gemini Responses
    geminiWs.on('message', (data) => {
      try {
        const response = JSON.parse(data);

        // 1. Audio Output
        if (response.serverContent && response.serverContent.modelTurn) {
          response.serverContent.modelTurn.parts.forEach(part => {
            if (part.inlineData && part.inlineData.mimeType.startsWith('audio/pcm')) {
              // Gemini 24k -> Twilio 8k Mu-Law
              const pcm24k = Buffer.from(part.inlineData.data, 'base64');
              const pcm8k = downsampleTo8k(pcm24k);
              const mulaw8k = pcmToMulaw(pcm8k);
              
              if (streamSid) {
                connection.socket.send(JSON.stringify({
                  event: "media",
                  streamSid,
                  media: { payload: mulaw8k.toString('base64') }
                }));
              }
            }
          });
        }

        // 2. Interruption Handling
        if (response.serverContent && response.serverContent.interrupted) {
          console.log("🛑 Gemini Interrupted");
          if (streamSid) {
            connection.socket.send(JSON.stringify({ event: "clear", streamSid }));
          }
        }
      } catch (e) {
        console.error("Gemini Parse Error:", e);
      }
    });

    geminiWs.on('close', () => console.log("Gemini Disconnected"));
    geminiWs.on('error', (err) => console.error("Gemini Error:", err));

    // Handle Twilio Audio
    connection.socket.on('message', (msg) => {
      try {
        const data = JSON.parse(msg);

        if (data.event === 'start') {
          streamSid = data.start.streamSid;
          console.log(`▶️ Stream Started: ${streamSid}`);
        } else if (data.event === 'media' && geminiWs.readyState === WebSocket.OPEN) {
          
          // 1. Buffer the audio
          const chunk = Buffer.from(data.media.payload, 'base64');
          audioBuffer.push(chunk);

          // 2. Only send when we have enough data (approx 100ms)
          // This prevents "fragmentation" where packets are too small for the AI to hear.
          if (audioBuffer.length >= 5) {
            const combinedBuffer = Buffer.concat(audioBuffer);
            audioBuffer = []; // Clear buffer

            // 3. Decode -> Upsample (Linear) -> Encode
            const pcm8k = mulawToPcm(combinedBuffer);
            const pcm16k = upsampleLinear(pcm8k, 8000, 16000);
            const base64Audio = pcm16k.toString('base64');

            // 4. Send to Gemini
            const audioMsg = {
              realtimeInput: {
                mediaChunks: [{
                  mimeType: "audio/pcm;rate=16000",
                  data: base64Audio
                }]
              }
            };
            geminiWs.send(JSON.stringify(audioMsg));
          }
        
        } else if (data.event === 'stop') {
          console.log("⏹️ Call Stopped");
          geminiWs.close();
        }
      } catch (e) {
        console.error("Twilio Error:", e);
      }
    });
  });
});

// --- HIGH QUALITY AUDIO UTILS ---

/**
 * Linear Interpolation Resampler (8k -> 16k)
 * Smooths the audio curve so it sounds like human speech, not static.
 */
function upsampleLinear(inputBuffer, fromRate, toRate) {
  const input = new Int16Array(inputBuffer.buffer, inputBuffer.byteOffset, inputBuffer.length / 2);
  const output = new Int16Array(input.length * 2);

  for (let i = 0; i < input.length; i++) {
    const current = input[i];
    const next = (i < input.length - 1) ? input[i+1] : current;
    
    output[i * 2] = current;
    // The "Average" creates the smooth line between points
    output[i * 2 + 1] = Math.round((current + next) / 2); 
  }
  return Buffer.from(output.buffer);
}

// Downsampler 24k -> 8k
function downsampleTo8k(buffer) {
  const input = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.length / 2);
  const output = new Int16Array(Math.floor(input.length / 3));
  for (let i = 0; i < output.length; i++) {
    output[i] = input[i * 3];
  }
  return Buffer.from(output.buffer);
}

// G.711 Mu-Law Decoding
function mulawToPcm(buffer) {
  const pcmBuffer = new Int16Array(buffer.length);
  for (let i = 0; i < buffer.length; i++) {
    pcmBuffer[i] = decodeMuLaw(buffer[i]);
  }
  return Buffer.from(pcmBuffer.buffer);
}

const BIAS = 0x84;
const CLIP = 32635;

function pcmToMulaw(buffer) {
  const pcm = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.length / 2);
  const mulaw = new Uint8Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) mulaw[i] = encodeMuLaw(pcm[i]);
  return Buffer.from(mulaw);
}

function encodeMuLaw(sample) {
  let sign = (sample >> 8) & 0x80;
  if (sign !== 0) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) { }
  let mantissa = (sample >> (exponent + 3)) & 0x0F;
  let byte = ~(sign | (exponent << 4) | mantissa);
  return byte;
}

function decodeMuLaw(muLawByte) {
  muLawByte = ~muLawByte;
  let sign = muLawByte & 0x80;
  let exponent = (muLawByte >> 4) & 0x07;
  let mantissa = muLawByte & 0x0F;
  let sample = (2 * mantissa + 33) << (12 - exponent);
  sample -= BIAS;
  return (sign === 0 ? sample : -sample);
}

fastify.listen({ port: PORT, host: '0.0.0.0' }, (err, address) => {
  if (err) { console.error(err); process.exit(1); }
  console.log(`🚀 Server listening on ${address}`);
});