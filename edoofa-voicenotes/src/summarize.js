/**
 * summarize.js
 * Uses Claude to turn a raw transcript into a structured summary +
 * action items. Also used as a FALLBACK for sender-role classification
 * when WhatsApp metadata alone is ambiguous (see roleClassifier.js for
 * the primary, metadata-based approach).
 */

const Anthropic = require('@anthropic-ai/sdk');

class Summarizer {
  constructor(apiKey) {
    this.client = new Anthropic({ apiKey });
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

    const response = await this.client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');

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
