import twilio from 'twilio';
import dotenv from 'dotenv';

// Load environment variables from .env
dotenv.config();

// check if required variables exist
if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.BASE_URL) {
  console.error("❌ Error: Missing config in .env file (Check TWILIO_SID, TOKEN, or BASE_URL)");
  process.exit(1);
}

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

async function initiateCall() {
  try {
    const targetUrl = `${process.env.BASE_URL}/twiml`;
    
    console.log(`📞 Initializing call...`);
    console.log(`🔗 Webhook URL: ${targetUrl}`);
    console.log(`📱 To: ${process.env.YOUR_PHONE_NUMBER}`);
    console.log(`📱 From: ${process.env.TWILIO_PHONE_NUMBER}`);

    const call = await client.calls.create({
      url: targetUrl, 
      to: process.env.YOUR_PHONE_NUMBER, 
      from: process.env.TWILIO_PHONE_NUMBER, 
    });

    console.log(`✅ Call started! SID: ${call.sid}`);
  } catch (error) {
    console.error("❌ Failed to call:", error.message);
    if (error.code === 21205) {
      console.error("   (Tip: Check if the 'To' phone number format is correct, e.g., +15550000000)");
    }
  }
}

initiateCall();