import Fastify from 'fastify';
import fastifyWs from '@fastify/websocket';
import fastifyFormBody from '@fastify/formbody';

const PORT = process.env.PORT || 3000;
const fastify = Fastify({ logger: true });

fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

fastify.get('/', async () => "Echo Test Server Running");

// TwiML: Basic stream connection
fastify.all('/twiml', async (request, reply) => {
  const host = request.headers.host;
  const wssUrl = `wss://${host}/media-stream`;
  reply.type('text/xml');
  return `<?xml version="1.0" encoding="UTF-8"?>
  <Response>
      <Say>Echo test started. Speak now and you should hear yourself.</Say>
      <Connect>
          <Stream url="${wssUrl}" />
      </Connect>
      <Pause length="60" /> 
  </Response>`;
});

// WebSocket: The Echo Loop
fastify.register(async (fastify) => {
  fastify.get('/media-stream', { websocket: true }, (connection, req) => {
    console.log("✅ Client Connected for Echo Test");
    let streamSid = null;

    connection.socket.on('message', (msg) => {
      try {
        const data = JSON.parse(msg);

        if (data.event === 'start') {
          streamSid = data.start.streamSid;
          console.log(`▶️ Stream Started: ${streamSid}`);
        } 
        else if (data.event === 'media') {
          // --- THE DEBUG LOOP ---
          // 1. We receive your audio (base64 Mu-Law)
          const payload = data.media.payload;
          
          // 2. LOGGING: Verify we are actually receiving data
          // A standard chunk is usually 160 bytes (20ms of audio)
          const buffer = Buffer.from(payload, 'base64');
          // console.log(`🎤 Received ${buffer.length} bytes from Twilio`);

          // 3. IMMEDIATE REFLECTION
          // We send the EXACT same payload back to you.
          // No decoding, no Gemini, just raw echo.
          if (streamSid) {
            const echoMsg = {
              event: "media",
              streamSid: streamSid,
              media: {
                payload: payload
              }
            };
            connection.socket.send(JSON.stringify(echoMsg));
          }
        } 
        else if (data.event === 'stop') {
          console.log("⏹️ Call Ended");
        }
      } catch (e) {
        console.error("❌ Error:", e);
      }
    });
  });
});

fastify.listen({ port: PORT, host: '0.0.0.0' }, (err, address) => {
  if (err) { console.error(err); process.exit(1); }
  console.log(`🚀 Echo Server listening on ${address}`);
});