/**
 * summarize.js
 * Uses Groq (free tier) to turn a raw transcript into a structured
 * summary + action items. Sender-role classification is handled
 * entirely by roleClassifier.js using deterministic WhatsApp metadata
 * (JID / fromMe) - this module is not involved in that decision and
 * does not see or infer sender role from transcript content.
 *
 * DESIGN DECISION (cost trade-off, stated explicitly for the live
 * walkthrough): Groq's API is OpenAI-compatible, so we reuse the
 * `openai` SDK already in package.json (used by transcribe.js for
 * Whisper) and just point it at Groq's base URL instead of adding a
 * new dependency. Groq is used here over Claude/GPT-4 purely because
 * it has a usable free tier for a prototype - production should swap
 * back to a stronger paid model (Claude Sonnet or GPT-4-class) for
 * better summarization quality at scale. The swap is a one-line model
 * name + base URL change, not a rewrite, because both speak the same
 * Chat Completions-style API shape.
 */

const OpenAI = require('openai');

const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
const GROQ_MODEL = 'llama-3.3-70b-versatile';

class Summarizer {
  constructor(apiKey) {
    this.client = new OpenAI({
      apiKey,
      baseURL: GROQ_BASE_URL,
    });
  }

  /**
   * Returns { summary, actionItems } as plain strings (action items
   * newline-separated) so they drop cleanly into Sheet cells.
   */
  async summarize(transcript, context) {
    const { studentName, senderRole, senderName } = context;

    const prompt = `You are helping an EdTech operations team (Edoofa) maintain a structured log of WhatsApp voice note communications with students and parents.

Below is a transcript of ONE voice note. Produce:
1. A concise summary (2-3 sentences max) of what was discussed.
2. A bullet list of explicit action items / follow-ups mentioned (if none, write "None mentioned").

Context:
- Student/Group: ${studentName}
- Sender role: ${senderRole}
- Sender name: ${senderName}

Transcript:
"""
${transcript}
"""

Respond ONLY in this exact JSON format, no preamble, no markdown fences:
{"summary": "...", "action_items": "- item one\\n- item two"}`;

    const response = await this.client.chat.completions.create({
      model: GROQ_MODEL,
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.choices?.[0]?.message?.content || '';

    try {
      const cleaned = text.replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(cleaned);
      return {
        summary: parsed.summary || '',
        actionItems: parsed.action_items || 'None mentioned',
      };
    } catch (err) {
      // Fallback: if parsing fails, store raw model output in summary
      // rather than silently dropping data.
      return {
        summary: text.slice(0, 500),
        actionItems: 'PARSE_ERROR - see summary field',
      };
    }
  }
}

module.exports = { Summarizer };