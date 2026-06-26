/**
 * transcribe.js
 * Uses Groq Whisper for speech-to-text.
 * Requires:
 *   GROQ_API_KEY=gsk_xxxxxxxxx
 */

const OpenAI = require("openai");
const fs = require("fs");

const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
const GROQ_TRANSCRIPTION_MODEL = "whisper-large-v3";

class Transcriber {
  constructor(apiKey) {
    this.client = new OpenAI({
      apiKey,
      baseURL: GROQ_BASE_URL,
    });
  }

  async transcribe(filePath) {
    const audio = fs.createReadStream(filePath);

    const response = await this.client.audio.transcriptions.create({
      file: audio,
      model: GROQ_TRANSCRIPTION_MODEL,
      response_format: "json",
      language: "en", // remove this if you expect multiple languages
    });

    return response.text;
  }
}

module.exports = { Transcriber };