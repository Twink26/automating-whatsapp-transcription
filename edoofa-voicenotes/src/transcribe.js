/**
 * transcribe.js
 * Wraps OpenAI's Whisper API for audio transcription.
 *
 * WhatsApp voice notes arrive as OGG/Opus (.ogg). Whisper API accepts
 * ogg directly, so no conversion step is required (kept the prototype
 * simple here; ffmpeg-based normalization is listed as a production
 * hardening step in the one-pager).
 */

const OpenAI = require('openai');
const fs = require('fs');

class Transcriber {
  constructor(apiKey) {
    this.client = new OpenAI({ apiKey });
  }

  async transcribe(filePath) {
    const fileStream = fs.createReadStream(filePath);
    const response = await this.client.audio.transcriptions.create({
      file: fileStream,
      model: 'whisper-1',
      response_format: 'json',
    });
    return response.text;
  }
}

module.exports = { Transcriber };
