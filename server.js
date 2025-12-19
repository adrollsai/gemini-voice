// DEBUG: Confirm server is starting
console.log("🚀 Starting Server...");

import Fastify from 'fastify';
import fastifyWs from '@fastify/websocket';
import fastifyFormBody from '@fastify/formbody';
import WebSocket from 'ws';

// Required for Render to assign the correct port
const PORT = process.env.PORT || 3000;

// Check for API Key (Will warn if missing, but won't crash)
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.warn("⚠️ WARNING: GEMINI_API_KEY is missing in Render Environment Variables!");
}

const GEMINI_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;
const MODEL_NAME = "models/gemini-2.5-flash-native-audio-preview-12-2025";

const fastify = Fastify({ logger: true });

// Register Plugins
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// 1. HEALTH CHECK ROUTE (Open this in browser to test)
fastify.get('/', async (request, reply) => {
  return { status: "OK", message: "Server is running!", timestamp: new Date() };
});

// 2. TWILIO WEBHOOK
fastify.all('/twiml', async (request, reply) => {
  const host = request.headers.host;
  // Handle both local and production URLs
  const protocol = host.includes('localhost') ? 'ws' : 'wss';
  const wssUrl = `${protocol}://${host}/media-stream`;

  reply.type('text/xml');
  return `<?xml version="1.0" encoding="UTF-8"?>
  <Response>
      <Say>Connecting to Gemini 2.5.</Say>
      <Connect>
          <Stream url="${wssUrl}" />
      </Connect>
      <Pause length="300" />
  </Response>`;
});

// 3. WEBSOCKET ROUTE
fastify.register(async (fastify) => {
  fastify.get('/media-stream', { websocket: true }, (connection, req) => {
    console.log("✅ Twilio Connected");

    let streamSid = null;
    let geminiWs = new WebSocket(GEMINI_URL);

    geminiWs.on('open', () => {
      console.log("✅ Gemini Socket Open");
      geminiWs.send(JSON.stringify({
        setup: {
          model: MODEL_NAME,
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Puck" } } }
          }
        }
      }));
    });

    geminiWs.on('message', (data) => {
      try {
        const response = JSON.parse(data);
        if (response.serverContent && response.serverContent.modelTurn) {
          response.serverContent.modelTurn.parts.forEach(part => {
            if (part.inlineData && part.inlineData.mimeType.startsWith('audio/pcm')) {
              if (streamSid) {
                const pcm24k = Buffer.from(part.inlineData.data, 'base64');
                const mulaw8k = pcmToMulaw(downsampleTo8k(pcm24k));
                connection.socket.send(JSON.stringify({
                  event: "media",
                  streamSid,
                  media: { payload: mulaw8k.toString('base64') }
                }));
              }
            }
          });
        }
      } catch (e) {
        console.error("Gemini Parse Error", e);
      }
    });

    geminiWs.on('close', (code, reason) => {
      console.log(`❌ Gemini Closed: ${code} ${reason}`);
    });

    geminiWs.on('error', (error) => {
      console.error("❌ Gemini Error:", error);
    });

    connection.socket.on('message', (msg) => {
      try {
        const data = JSON.parse(msg);
        if (data.event === 'start') {
          streamSid = data.start.streamSid;
          console.log(`▶️ Stream Started: ${streamSid}`);
          if (geminiWs.readyState === WebSocket.OPEN) {
            // Send initial greeting trigger
            geminiWs.send(JSON.stringify({ clientContent: { turns: [{ role: "user", parts: [{ text: "Hello, please introduce yourself." }] }], turnComplete: true } }));
          }
        } else if (data.event === 'media' && geminiWs.readyState === WebSocket.OPEN) {
          const pcm16k = upsampleTo16k(mulawToPcm(Buffer.from(data.media.payload, 'base64')));
          geminiWs.send(JSON.stringify({
            realtimeInput: {
              mediaChunks: [{ mimeType: "audio/pcm;rate=16000", data: pcm16k.toString('base64') }]
            }
          }));
        } else if (data.event === 'stop') {
          geminiWs.close();
        }
      } catch (e) {
        console.error("Twilio Parse Error", e);
      }
    });
  });
});

// AUDIO UTILS
function downsampleTo8k(b){const i=new Int16Array(b.buffer,b.byteOffset,b.length/2),o=new Int16Array(Math.floor(i.length/3));for(let j=0;j<o.length;j++)o[j]=i[j*3];return Buffer.from(o.buffer);}
function upsampleTo16k(b){const i=new Int16Array(b.buffer,b.byteOffset,b.length/2),o=new Int16Array(i.length*2);for(let j=0;j<i.length;j++){o[j*2]=i[j];o[j*2+1]=i[j];}return Buffer.from(o.buffer);}
const BIAS=0x84,CLIP=32635;
function pcmToMulaw(b){const p=new Int16Array(b.buffer,b.byteOffset,b.length/2),m=new Uint8Array(p.length);for(let j=0;j<p.length;j++)m[j]=encodeMuLaw(p[j]);return Buffer.from(m);}
function mulawToPcm(b){const p=new Int16Array(b.length);for(let j=0;j<b.length;j++)p[j]=decodeMuLaw(b[j]);return Buffer.from(p.buffer);}
function encodeMuLaw(s){let sg=(s>>8)&0x80;if(sg)s=-s;if(s>CLIP)s=CLIP;s+=BIAS;let e=7;for(let m=0x4000;(s&m)===0&&e>0;e--,m>>=1){}let mt=(s>>(e+3))&0x0F;return~(sg|(e<<4)|mt);}
function decodeMuLaw(m){m=~m;let sg=m&0x80,e=(m>>4)&0x07,mt=m&0x0F,s=(2*mt+33)<<(12-e);s-=BIAS;return sg?-s:s;}

// Start Server
fastify.listen({ port: PORT, host: '0.0.0.0' }, (err, address) => {
  if (err) {
    console.error("❌ Startup Error:", err);
    process.exit(1);
  }
  console.log(`🚀 Server listening on ${address}`);
});