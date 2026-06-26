/**
 * roleClassifier.js
 *
 * Determines whether a voice note was sent by "Edoofa Team" or by
 * "Student/Parent".
 *
 * DESIGN DECISION: We classify using WhatsApp metadata (the sender's
 * JID, plus the message's own `fromMe` flag) rather than asking the AI
 * to guess from audio content. This is deterministic and 100% reliable,
 * vs. AI inference which could misclassify based on tone/content. The
 * brief asks us to "identify" the sender - metadata is the correct,
 * robust source of truth for this, not NLP guessing. There is no AI
 * fallback for this step; if metadata is ever ambiguous (e.g. a missing
 * JID), we classify as "Unknown" rather than guess (see classify()).
 *
 * IMPORTANT EDGE CASE: the WhatsApp account actually linked to this
 * pipeline (the one that scanned the QR code) is very likely an Edoofa
 * team member's own phone. When THAT phone sends a voice note,
 * Baileys marks the message with `key.fromMe = true`, and `key.participant`
 * is often missing or unreliable for own-sent messages in a group
 * context. We must check `fromMe` FIRST, before falling back to JID
 * roster lookups - otherwise the team member's own notes can be
 * misclassified or crash on a malformed/missing JID.
 *
 * Production note: maintain a roster of Edoofa team member phone
 * numbers (the numbers used to operate inside these groups). Anyone
 * NOT on that roster (and not the linked account itself) is treated as
 * Student/Parent. For the prototype, this roster is a simple array - in
 * production this should live in the same Google Sheet (a second tab)
 * or a lightweight DB table so ops can update it without a code deploy.
 */

class RoleClassifier {
  constructor(edoofaTeamNumbers = []) {
    // Normalize to bare digits for comparison (WhatsApp JIDs look like
    // "919876543210@s.whatsapp.net")
    this.teamNumbers = new Set(
      edoofaTeamNumbers.map((n) => n.replace(/\D/g, ''))
    );
  }

  /**
   * @param {string|undefined} senderJid - msg.key.participant (group) or
   *   msg.key.remoteJid (1:1). May be undefined/malformed for own-sent
   *   messages in some Baileys versions - hence the `fromMe` check.
   * @param {boolean} fromMe - msg.key.fromMe. True if the LINKED account
   *   (the phone that scanned the QR) sent this message.
   * @returns {'Edoofa Team' | 'Student/Parent' | 'Unknown'}
   */
  classify(senderJid, fromMe = false) {
    // The linked device's own outgoing messages are always the Edoofa
    // team operator, regardless of what JID Baileys reports for them.
    if (fromMe) {
      return 'Edoofa Team';
    }

    const digits = (senderJid || '').replace(/\D/g, '');
    if (!digits) {
      // No usable identity at all - don't silently guess "Student/Parent"
      // on a malformed payload. Surface it as Unknown so ops can review
      // the row instead of trusting a wrong label.
      return 'Unknown';
    }

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