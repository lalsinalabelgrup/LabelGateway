/**
 * SipDumper — writes raw SIP messages to disk for offline comparison.
 *
 * Activated by PROMOSOFT_SIP_DUMP=true in .env.
 * Files land in logs/sip/ relative to the project root, one file per
 * SIP message, named:
 *   <ISO-ts>-<callId-8>-<label>.txt
 *
 * Labels used by PromoSoftSipClient:
 *   inbound-invite   incoming INVITE from Asterisk
 *   answer-200ok     our 200 OK reply
 *   ack              incoming ACK
 *   bye              incoming BYE
 *
 * The files can be diffed with:
 *   node tools/sipDiff.js logs/sip/xxx-answer-200ok.txt path/to/3cx-200ok.txt
 */

"use strict";

const fs   = require("fs");
const path = require("path");

class SipDumper {
  /**
   * @param {string} logDir  Absolute path to the dump directory.
   */
  constructor(logDir) {
    this._logDir = logDir;
    try {
      fs.mkdirSync(logDir, { recursive: true });
    } catch (e) {
      process.stderr.write(`SipDumper: cannot create ${logDir}: ${e.message}\n`);
    }
  }

  /**
   * Write one raw SIP message to a file.
   *
   * @param {string} sipCallId  SIP Call-ID of the dialog (used in filename).
   * @param {string} label      Short label: inbound-invite | answer-200ok | ack | bye
   * @param {string} text       Full raw SIP message (headers + body).
   * @returns {string|null}     Absolute path of the written file, or null on error.
   */
  dump(sipCallId, label, text) {
    try {
      const ts      = new Date().toISOString().replace(/[:.]/g, "-");
      // Keep first 8 alphanum chars of the Call-ID so related files sort together.
      const shortId = (sipCallId || "unknown").replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || "noid";
      const name    = `${ts}-${shortId}-${label}.txt`;
      const file    = path.join(this._logDir, name);
      fs.writeFileSync(file, text, "utf8");
      return file;
    } catch (e) {
      process.stderr.write(`SipDumper: write failed (${label}): ${e.message}\n`);
      return null;
    }
  }
}

module.exports = SipDumper;
