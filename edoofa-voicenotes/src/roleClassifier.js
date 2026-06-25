/**
 * roleClassifier.js
 *
 * Determines whether a voice note was sent by "Edoofa Team" or by
 * "Student/Parent".
 *
 * DESIGN DECISION: We classify using WhatsApp metadata (the sender's
 * JID) rather than asking the AI to guess from audio content. This is
 * deterministic and 100% reliable, vs. AI inference which could
 * misclassify based on tone/content. The brief asks us to "identify"
 * the sender - metadata is the correct, robust source of truth for this,
 * not NLP guessing.
 *
 * Production note: maintain a roster of Edoofa team member phone
 * numbers (the numbers used to operate inside these groups). Anyone
 * NOT on that roster is treated as Student/Parent. For the prototype,
 * this roster is a simple array - in production this should live in
 * the same Google Sheet (a second tab) or a lightweight DB table so
 * ops can update it without a code deploy.
 */

class RoleClassifier {
  constructor(edoofaTeamNumbers = []) {
    // Normalize to bare digits for comparison (WhatsApp JIDs look like
    // "919876543210@s.whatsapp.net")
    this.teamNumbers = new Set(
      edoofaTeamNumbers.map((n) => n.replace(/\D/g, ''))
    );
  }

  classify(senderJid) {
    const digits = (senderJid || '').replace(/\D/g, '');
    // Strip WhatsApp's internal suffixes if any digits leaked through
    if (this.teamNumbers.has(digits)) {
      return 'Edoofa Team';
    }
    return 'Student/Parent';
  }

  addTeamNumber(number) {
    this.teamNumbers.add(number.replace(/\D/g, ''));
  }
}

module.exports = { RoleClassifier };
