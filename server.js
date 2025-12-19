import Fastify from 'fastify';
import fastifyWs from '@fastify/websocket';
import fastifyFormBody from '@fastify/formbody';
import WebSocket from 'ws';

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODEL_NAME = "models/gemini-2.5-flash-native-audio-preview-12-2025";
const GEMINI_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;

const fastify = Fastify({ logger: true });
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

fastify.get('/', async () => ({ status: "OK", message: "Gemini Voice Bridge" }));

// TwiML Hook
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

// WebSocket Handler
fastify.register(async (fastify) => {
  fastify.get('/media-stream', { websocket: true }, (connection, req) => {
    console.log("📞 Call Connected");

    let streamSid = null;
    let geminiWs = new WebSocket(GEMINI_URL);
    
    // BUFFERING LOGIC
    let audioBuffer = []; // Store raw chunks here
    const BUFFER_SIZE = 5; // Send every 5 chunks (approx 100ms)

    // 1. Connect to Gemini
    geminiWs.on('open', () => {
      console.log("✨ Connected to Gemini");
      geminiWs.send(JSON.stringify({
        setup: {
          model: MODEL_NAME,
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Puck" } } }
          }
        }
      }));
      
      // Initial Greeting
      geminiWs.send(JSON.stringify({
        clientContent: {
          turns: [{ role: "user", parts: [{ text: "Hello, please introduce yourself." }] }],
          turnComplete: true
        }
      }));
    });

    // 2. Handle Gemini Output
    geminiWs.on('message', (data) => {
      try {
        const response = JSON.parse(data);

        // Audio Output
        if (response.serverContent && response.serverContent.modelTurn) {
          response.serverContent.modelTurn.parts.forEach(part => {
            if (part.inlineData && part.inlineData.mimeType.startsWith('audio/pcm')) {
              if (streamSid) {
                const pcm24k = Buffer.from(part.inlineData.data, 'base64');
                const pcm8k = downsampleTo8k(pcm24k);
                const mulaw8k = pcmToMulaw(pcm8k);
                
                connection.socket.send(JSON.stringify({
                  event: "media",
                  streamSid,
                  media: { payload: mulaw8k.toString('base64') }
                }));
              }
            }
          });
        }

        // Interruption Handling
        if (response.serverContent && response.serverContent.interrupted) {
          console.log("🛑 Interrupted!");
          if (streamSid) connection.socket.send(JSON.stringify({ event: "clear", streamSid }));
        }
      } catch (e) {
        console.error("Gemini Error:", e);
      }
    });

    geminiWs.on('close', () => console.log("Gemini Disconnected"));

    // 3. Handle Twilio Input (With Buffering)
    connection.socket.on('message', (msg) => {
      try {
        const data = JSON.parse(msg);

        if (data.event === 'start') {
          streamSid = data.start.streamSid;
          console.log(`▶️ Stream Started: ${streamSid}`);
        } else if (data.event === 'media' && geminiWs.readyState === WebSocket.OPEN) {
          
          // A. Decode Mu-Law to PCM
          const chunk = Buffer.from(data.media.payload, 'base64');
          audioBuffer.push(chunk);

          // B. Only send when buffer is full (reduces packet fragmentation)
          if (audioBuffer.length >= BUFFER_SIZE) {
            const combinedBuffer = Buffer.concat(audioBuffer);
            audioBuffer = []; // Clear buffer

            // C. Convert to PCM -> Boost Volume -> Upsample
            const pcm8k = mulawToPcm(combinedBuffer);
            
            // Volume Boost (3x) + Clamping
            for (let i = 0; i < pcm8k.length; i++) {
               let val = pcm8k[i] * 3;
               if (val > 32767) val = 32767;
               if (val < -32768) val = -32768;
               pcm8k[i] = val;
            }

            // D. Upsample to 16k (Linear Interpolation)
            const pcm16k = upsampleTo16k(pcm8k);

            // E. Send to Gemini
            geminiWs.send(JSON.stringify({
              realtimeInput: {
                mediaChunks: [{
                  mimeType: "audio/pcm;rate=16000",
                  data: pcm16k.toString('base64')
                }]
              }
            }));
          }
        } else if (data.event === 'stop') {
          geminiWs.close();
        }
      } catch (e) {
        console.error("Twilio Error:", e);
      }
    });
  });
});

// --- AUDIO UTILS (Optimized) ---

function upsampleTo16k(buffer) {
  // Linear Interpolation (High Quality)
  const input = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.length / 2);
  const output = new Int16Array(input.length * 2);
  for (let i = 0; i < input.length; i++) {
    const current = input[i];
    const next = (i < input.length - 1) ? input[i+1] : current;
    output[i * 2] = current;
    output[i * 2 + 1] = Math.round((current + next) / 2);
  }
  return Buffer.from(output.buffer);
}

function downsampleTo8k(buffer) {
  const input = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.length / 2);
  const output = new Int16Array(Math.floor(input.length / 3));
  for (let i = 0; i < output.length; i++) {
    output[i] = input[i * 3];
  }
  return Buffer.from(output.buffer);
}

// G.711 Mu-Law Logic
const BIAS = 0x84;
const CLIP = 32635;

function pcmToMulaw(buffer) {
  const pcm = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.length / 2);
  const mulaw = new Uint8Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) mulaw[i] = encodeMuLaw(pcm[i]);
  return Buffer.from(mulaw);
}

function mulawToPcm(buffer) {
  const pcmBuffer = new Int16Array(buffer.length);
  for (let i = 0; i < buffer.length; i++) pcmBuffer[i] = decodeMuLaw(buffer[i]);
  return Buffer.from(pcmBuffer.buffer);
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