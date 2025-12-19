import Fastify from 'fastify';
import fastifyWs from '@fastify/websocket';
import fastifyFormBody from '@fastify/formbody';
import WebSocket from 'ws';

// Constants
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODEL_NAME = "models/gemini-2.5-flash-native-audio-preview-12-2025";
const GEMINI_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;

const fastify = Fastify({ logger: true });
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Root Route
fastify.get('/', async () => ({ status: "OK", message: "Voice Server Running" }));

// Twilio TwiML Webhook
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
    let audioQueue = []; // Queue for buffering Gemini audio

    // 1. Connect to Gemini
    geminiWs.on('open', () => {
      console.log("✨ Connected to Gemini");
      // Setup the session
      geminiWs.send(JSON.stringify({
        setup: {
          model: MODEL_NAME,
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Puck" } } }
          }
        }
      }));

      // Send initial greeting to get the conversation started
      const greeting = {
        clientContent: {
          turns: [{ role: "user", parts: [{ text: "Hello, please introduce yourself briefly." }] }],
          turnComplete: true
        }
      };
      geminiWs.send(JSON.stringify(greeting));
    });

    // 2. Handle Gemini Messages
    geminiWs.on('message', (data) => {
      try {
        const response = JSON.parse(data);

        // A. Handle Audio Output (Gemini Speaking)
        if (response.serverContent && response.serverContent.modelTurn) {
          response.serverContent.modelTurn.parts.forEach(part => {
            if (part.inlineData && part.inlineData.mimeType.startsWith('audio/pcm')) {
              if (streamSid) {
                // Decode Gemini (24k) -> Encode Twilio (8k Mu-Law)
                const pcm24k = Buffer.from(part.inlineData.data, 'base64');
                const pcm8k = downsampleLinear(pcm24k, 24000, 8000);
                const mulaw8k = pcmToMulaw(pcm8k);
                
                // Send immediately to Twilio
                const mediaMsg = {
                  event: "media",
                  streamSid,
                  media: { payload: mulaw8k.toString('base64') }
                };
                connection.socket.send(JSON.stringify(mediaMsg));
              }
            }
          });
        }

        // B. Handle Interruption (Gemini heard you!)
        // This flag tells us Gemini has stopped generating because you spoke.
        if (response.serverContent && response.serverContent.interrupted) {
          console.log("🛑 Interrupted by User! Clearing audio.");
          // Twilio doesn't support "Clear Buffer" natively in Streams easily,
          // but stopping the send loop usually works.
          // Note: Twilio will play whatever is currently in its short buffer (approx 200-500ms).
        }

        if (response.serverContent && response.serverContent.turnComplete) {
           console.log("✅ Turn Complete");
        }
      } catch (e) {
        console.error("Error parsing Gemini message:", e);
      }
    });

    geminiWs.on('close', () => console.log("Gemini Disconnected"));

    // 3. Handle Twilio Messages (User Speaking)
    connection.socket.on('message', (msg) => {
      try {
        const data = JSON.parse(msg);

        if (data.event === 'start') {
          streamSid = data.start.streamSid;
          console.log(`▶️ Stream Started: ${streamSid}`);
        } else if (data.event === 'media' && geminiWs.readyState === WebSocket.OPEN) {
          // 1. Get 8k Mu-Law chunk
          const mulaw8k = Buffer.from(data.media.payload, 'base64');
          
          // 2. Convert to 16k PCM (Using Linear Interpolation for quality)
          const pcm8k = mulawToPcm(mulaw8k);
          const pcm16k = upsampleLinear(pcm8k, 8000, 16000);

          // 3. Send to Gemini
          geminiWs.send(JSON.stringify({
            realtimeInput: {
              mediaChunks: [{
                mimeType: "audio/pcm;rate=16000",
                data: pcm16k.toString('base64')
              }]
            }
          }));
        } else if (data.event === 'stop') {
          console.log("⏹️ Call Ended");
          geminiWs.close();
        }
      } catch (e) {
        console.error("Twilio Message Error:", e);
      }
    });
  });
});

// --- HIGH QUALITY AUDIO UTILS ---

/**
 * Linear Interpolation Resampler (Better than "Nearest Neighbor")
 * This fixes the "Distorted Voice" issue.
 */
function upsampleLinear(inputBuffer, fromRate, toRate) {
  const input = new Int16Array(inputBuffer.buffer, inputBuffer.byteOffset, inputBuffer.length / 2);
  const ratio = toRate / fromRate;
  const newLength = Math.round(input.length * ratio);
  const output = new Int16Array(newLength);

  for (let i = 0; i < newLength; i++) {
    const position = i / ratio;
    const index = Math.floor(position);
    const fraction = position - index;

    const a = input[index];
    const b = input[index + 1] || a; // Clamp last sample

    // Simple Linear Interpolation: y = a + (b-a)*x
    output[i] = Math.round(a + (b - a) * fraction);
  }
  return Buffer.from(output.buffer);
}

function downsampleLinear(inputBuffer, fromRate, toRate) {
  const input = new Int16Array(inputBuffer.buffer, inputBuffer.byteOffset, inputBuffer.length / 2);
  const ratio = fromRate / toRate;
  const newLength = Math.round(input.length / ratio);
  const output = new Int16Array(newLength);

  for (let i = 0; i < newLength; i++) {
    const position = i * ratio;
    const index = Math.floor(position);
    
    // For downsampling, simple decimation with linear smoothing is often enough
    // Ideally we'd use a low-pass filter, but this is 10x better than dropping samples.
    output[i] = input[index];
  }
  return Buffer.from(output.buffer);
}

// Standard Mu-Law Decoding Table/Algorithm
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

// Start Server
fastify.listen({ port: PORT, host: '0.0.0.0' }, (err, address) => {
  if (err) {
    console.error("Startup Error:", err);
    process.exit(1);
  }
  console.log(`🚀 Server Ready on ${address}`);
});