const ELEVENLABS_ENDPOINT = "https://api.elevenlabs.io/v1/text-to-speech";

function normalizeProvider() {
  return String(process.env.TTS_PROVIDER || "none")
    .trim()
    .toLowerCase();
}

function isElevenLabsConfigured() {
  return Boolean(process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_VOICE_ID);
}

function isRemoteVoiceAvailable() {
  const provider = normalizeProvider();
  if (provider === "elevenlabs") {
    return isElevenLabsConfigured();
  }
  return false;
}

function getVoiceStatus() {
  const provider = normalizeProvider();
  return {
    provider,
    remoteAvailable: isRemoteVoiceAvailable(),
    fallback: "system"
  };
}

async function synthesizeWithElevenLabs(text) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  const modelId = process.env.ELEVENLABS_MODEL_ID || "eleven_multilingual_v2";

  if (!apiKey || !voiceId) {
    const err = new Error("TTS ElevenLabs non configure");
    err.status = 503;
    throw err;
  }

  const response = await fetch(`${ELEVENLABS_ENDPOINT}/${voiceId}`, {
    method: "POST",
    headers: {
      Accept: "audio/mpeg",
      "Content-Type": "application/json",
      "xi-api-key": apiKey
    },
    body: JSON.stringify({
      text,
      model_id: modelId,
      voice_settings: {
        stability: 0.28,
        similarity_boost: 0.88,
        style: 0.35,
        speaker_boost: true
      }
    })
  });

  if (!response.ok) {
    const details = await response.text().catch(() => "");
    const err = new Error(`TTS provider error ${response.status}${details ? `: ${details.slice(0, 160)}` : ""}`);
    err.status = 502;
    throw err;
  }

  const arrayBuffer = await response.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    contentType: response.headers.get("content-type") || "audio/mpeg"
  };
}

async function synthesize(text) {
  const provider = normalizeProvider();
  const message = String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 420);

  if (!message) {
    const err = new Error("Texte TTS vide");
    err.status = 400;
    throw err;
  }

  if (provider === "elevenlabs") {
    return synthesizeWithElevenLabs(message);
  }

  const err = new Error("Aucun provider TTS distant configure");
  err.status = 503;
  throw err;
}

module.exports = {
  getVoiceStatus,
  synthesize
};
