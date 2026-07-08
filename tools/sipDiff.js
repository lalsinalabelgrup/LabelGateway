#!/usr/bin/env node
/**
 * sipDiff.js — Side-by-side diff of two raw SIP 200 OK files.
 *
 * Usage:
 *   node tools/sipDiff.js <file-A> <file-B>
 *
 * Typical invocation after a test run:
 *   node tools/sipDiff.js \
 *     logs/sip/2024-...-answer-200ok.txt \
 *     path/to/3cx-200ok.txt
 *
 * How to get file-B (the 3CX 200 OK):
 *   Option 1 — 3CX SIP Trace
 *     Management Console → Monitoring → SIP Trace
 *     Make a test call to a 3CX extension, let it answer, stay connected.
 *     Stop the trace, copy the "200 OK" block into a text file.
 *
 *   Option 2 — sngrep (Linux / WSL)
 *     sngrep -O 3cx-call.pcap
 *     Make the test call, press q to stop.
 *     sngrep -I 3cx-call.pcap   (filter on the 200 OK you want, press Enter, p)
 *
 *   Option 3 — Wireshark on the SIP server LAN interface
 *     Capture filter: udp port 5060
 *     After capture: File → Export PDUs to File → SIP
 *     Find the 200 OK, right-click → Copy → All Visible Items
 *     Paste into a text file (headers + blank line + SDP body).
 *
 * Output: lines marked ◄ differ between A and B.
 */

"use strict";

const fs   = require("fs");
const path = require("path");

/* ── SIP/SDP parser ─────────────────────────────────────────────────────── */

function parseSip(text) {
  // Normalise line endings
  const normalised = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const blankLine  = normalised.indexOf("\n\n");
  const headerText = blankLine >= 0 ? normalised.slice(0, blankLine)    : normalised;
  const bodyText   = blankLine >= 0 ? normalised.slice(blankLine + 2)   : "";

  const headerLines = headerText.split("\n");
  const firstLine   = headerLines[0] || "";
  const headers     = {};

  for (let i = 1; i < headerLines.length; i++) {
    const m = headerLines[i].match(/^([^:]+):\s*(.*)/);
    if (!m) continue;
    const key = m[1].trim().toLowerCase();
    const val = m[2].trim();
    // Accumulate duplicate headers (e.g. Record-Route) with " | " separator
    headers[key] = headers[key] ? `${headers[key]} | ${val}` : val;
  }

  // Parse SDP body — keep full lines grouped by type letter
  const sdp = {};
  for (const line of bodyText.split("\n")) {
    const m = line.trim().match(/^([a-z])=(.*)/);
    if (!m) continue;
    const k = m[1];
    if (!sdp[k]) sdp[k] = [];
    sdp[k].push(m[2]);
  }

  return { firstLine, headers, sdp, rawBody: bodyText.trim() };
}

/* ── Render helpers ─────────────────────────────────────────────────────── */

const COL = 50;          // width of each value column
const HDR = 22;          // width of the label column

function trunc(str, len) {
  str = str == null ? "" : String(str);
  return str.length > len ? str.slice(0, len - 1) + "…" : str;
}

function row(label, a, b) {
  const av  = trunc(a, COL);
  const bv  = trunc(b, COL);
  const mark = a !== b ? " ◄" : "";
  return `${trunc(label, HDR).padEnd(HDR)} │ ${av.padEnd(COL)} │ ${bv.padEnd(COL)}${mark}`;
}

function separator() {
  return "─".repeat(HDR) + "─┼─" + "─".repeat(COL) + "─┼─" + "─".repeat(COL);
}

function header(a, b) {
  return row("Field", a, b);
}

/* ── Comparison ─────────────────────────────────────────────────────────── */

// SIP headers to always show, in this order
const SIP_PRIORITY = [
  "contact", "via", "from", "to", "cseq",
  "allow", "supported", "require",
  "session-expires", "min-se",
  "user-agent", "content-type", "content-length",
];

// SDP line types to always show, in order
const SDP_PRIORITY = ["v", "o", "s", "c", "t", "m"];

function compare(nameA, a, nameB, b) {
  /* ── First line ── */
  console.log("\n╔══ STATUS LINE ══════════════════════════════════════════════╗");
  console.log(`  A (${nameA}): ${a.firstLine}`);
  console.log(`  B (${nameB}): ${b.firstLine}`);

  /* ── SIP headers ── */
  console.log("\n╔══ SIP HEADERS ═════════════════════════════════════════════╗");
  console.log(separator());
  console.log(header(nameA.slice(0, COL), nameB.slice(0, COL)));
  console.log(separator());

  const allSipKeys = new Set([
    ...SIP_PRIORITY,
    ...Object.keys(a.headers).filter(k => !SIP_PRIORITY.includes(k)).sort(),
    ...Object.keys(b.headers).filter(k => !SIP_PRIORITY.includes(k)).sort(),
  ]);

  for (const key of allSipKeys) {
    const av = a.headers[key] || "";
    const bv = b.headers[key] || "";
    if (!av && !bv) continue;
    console.log(row(key, av, bv));
  }
  console.log(separator());

  /* ── SDP body ── */
  console.log("\n╔══ SDP BODY ════════════════════════════════════════════════╗");
  console.log(separator());
  console.log(header(nameA.slice(0, COL), nameB.slice(0, COL)));
  console.log(separator());

  const allSdpKeys = new Set([
    ...SDP_PRIORITY,
    ...Object.keys(a.sdp).filter(k => !SDP_PRIORITY.includes(k)).sort(),
    ...Object.keys(b.sdp).filter(k => !SDP_PRIORITY.includes(k)).sort(),
  ]);

  for (const key of allSdpKeys) {
    const aLines = (a.sdp[key] || []);
    const bLines = (b.sdp[key] || []);
    const maxLen = Math.max(aLines.length, bLines.length, 1);
    for (let i = 0; i < maxLen; i++) {
      const av = aLines[i] != null ? `${key}=${aLines[i]}` : "";
      const bv = bLines[i] != null ? `${key}=${bLines[i]}` : "";
      console.log(row(i === 0 ? `sdp:${key}=` : "", av, bv));
    }
  }
  console.log(separator());

  /* ── Checklist ── */
  console.log("\n╔══ CHECKLIST ═══════════════════════════════════════════════╗");
  const checks = [
    {
      label: "Contact: IP reachable from PBX?",
      a: a.headers["contact"] || "",
      b: b.headers["contact"] || "",
    },
    {
      label: "Contact: stable port (not ephemeral)?",
      a: a.headers["contact"] || "",
      b: b.headers["contact"] || "",
    },
    {
      label: "SDP c= IP reachable from PBX?",
      a: (a.sdp["c"] || [])[0] || "",
      b: (b.sdp["c"] || [])[0] || "",
    },
    {
      label: "SDP m=audio port in RTP range?",
      a: (a.sdp["m"] || [])[0] || "",
      b: (b.sdp["m"] || [])[0] || "",
    },
    {
      label: "telephone-event in m= codecs?",
      a: (a.sdp["m"] || [])[0] || "",
      b: (b.sdp["m"] || [])[0] || "",
    },
    {
      label: "a=rtpmap:101 telephone-event?",
      a: (a.sdp["a"] || []).find(l => l.startsWith("rtpmap:101")) || "(absent)",
      b: (b.sdp["a"] || []).find(l => l.startsWith("rtpmap:101")) || "(absent)",
    },
    {
      label: "a=ptime present?",
      a: (a.sdp["a"] || []).find(l => l.startsWith("ptime")) || "(absent)",
      b: (b.sdp["a"] || []).find(l => l.startsWith("ptime")) || "(absent)",
    },
    {
      label: "a=rtcp present?",
      a: (a.sdp["a"] || []).find(l => l.startsWith("rtcp")) || "(absent)",
      b: (b.sdp["a"] || []).find(l => l.startsWith("rtcp")) || "(absent)",
    },
    {
      label: "Session-Expires echoed?",
      a: a.headers["session-expires"] || "(absent)",
      b: b.headers["session-expires"] || "(absent)",
    },
    {
      label: "Require: timer echoed?",
      a: a.headers["require"] || "(absent)",
      b: b.headers["require"] || "(absent)",
    },
    {
      label: "Allow set matches?",
      a: a.headers["allow"] || "",
      b: b.headers["allow"] || "",
    },
    {
      label: "Supported set matches?",
      a: a.headers["supported"] || "(absent)",
      b: b.headers["supported"] || "(absent)",
    },
  ];

  let diffs = 0;
  for (const c of checks) {
    const same = c.a === c.b;
    if (!same) diffs++;
    const mark = same ? "✓" : "✗";
    console.log(`  [${mark}] ${c.label}`);
    if (!same) {
      console.log(`       A: ${trunc(c.a, 80)}`);
      console.log(`       B: ${trunc(c.b, 80)}`);
    }
  }
  console.log(`\n  ${diffs} checklist item(s) differ.\n`);
}

/* ── Entry point ────────────────────────────────────────────────────────── */

const [,, fileA, fileB] = process.argv;

if (!fileA || !fileB) {
  console.error([
    "",
    "Usage:",
    "  node tools/sipDiff.js <200ok-A.txt> <200ok-B.txt>",
    "",
    "Examples:",
    "  node tools/sipDiff.js logs/sip/2024-...-answer-200ok.txt 3cx-200ok.txt",
    "",
    "File format: raw SIP response text (headers, blank line, SDP body).",
    "Both CRLF and LF line endings are accepted.",
    "",
    "How to get the 3CX file:",
    "  3CX Management Console → Monitoring → SIP Trace",
    "  Or use sngrep / Wireshark on the SIP port (UDP 5060).",
    "",
  ].join("\n"));
  process.exit(1);
}

const textA = fs.readFileSync(fileA, "utf8");
const textB = fs.readFileSync(fileB, "utf8");
const nameA = path.basename(fileA);
const nameB = path.basename(fileB);

compare(nameA, parseSip(textA), nameB, parseSip(textB));
