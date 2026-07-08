#!/usr/bin/env node
/**
 * promosoftRegisterProbe.js
 *
 * Iterative SIP REGISTER diagnostic probe for PromoSoft / GUC Contact Center.
 * Tests multiple REGISTER variants one by one until one receives 200 OK.
 *
 * Usage:
 *   npm run probe:promosoft-register
 *
 * Reads from .env — extension and password are allowed here because this is
 * a local diagnostic tool, not the runtime adapter. Never log the password.
 *
 * Output:
 *   Per-variant console output + final summary table.
 *   On success: docs/PROMOSOFT_REGISTER_PROBE.md is written.
 */

'use strict';

require('dotenv').config();

const dgram  = require('node:dgram');
const crypto = require('node:crypto');
const fs     = require('node:fs');
const path   = require('node:path');

/* ── Config ─────────────────────────────────────────────────────────────── */

const CFG = {
  server:    process.env.PROMOSOFT_SIP_SERVER,
  port:      parseInt(process.env.PROMOSOFT_SIP_PORT || '5060', 10),
  transport: process.env.PROMOSOFT_SIP_TRANSPORT || 'udp',
  domain:    process.env.PROMOSOFT_SIP_DOMAIN || process.env.PROMOSOFT_SIP_SERVER,
  extension: process.env.PROMOSOFT_EXTENSION,
  password:  process.env.PROMOSOFT_PASSWORD,   // read but NEVER printed
  debug:     process.env.PROMOSOFT_DEBUG === 'true',
};

if (!CFG.server)    { console.error('[probe] PROMOSOFT_SIP_SERVER not set');  process.exit(1); }
if (!CFG.extension) { console.error('[probe] PROMOSOFT_EXTENSION not set');   process.exit(1); }
if (!CFG.password)  { console.error('[probe] PROMOSOFT_PASSWORD not set');    process.exit(1); }

const TRANSACTION_TIMEOUT_MS = 10_000;  // per REGISTER attempt
const VARIANT_DELAY_MS       =  2_000;  // pause between variants

/* ── Crypto helpers ─────────────────────────────────────────────────────── */

const md5    = (s) => crypto.createHash('md5').update(s).digest('hex');
const hex    = (n) => crypto.randomBytes(n).toString('hex');
const newTag    = () => hex(6);
const newCallId = (ip) => `${hex(8)}@${ip || 'local'}`;
const newBranch = () => `z9hG4bK${hex(8)}`;

/* ── SIP parser ─────────────────────────────────────────────────────────── */

function parseMessage(text) {
  const lines = text.split('\r\n');
  let status = null, reason = null, method = null;

  const sm = lines[0].match(/^SIP\/2\.0\s+(\d+)\s*(.*)/);
  if (sm) { status = parseInt(sm[1], 10); reason = sm[2] || ''; }
  else {
    const rm = lines[0].match(/^([A-Z]+)\s+/);
    if (rm) method = rm[1];
  }

  const headers = {};
  for (const line of lines.slice(1)) {
    if (!line) break;
    const i = line.indexOf(':');
    if (i < 0) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    const val = line.slice(i + 1).trim();
    // compact form header expansion (v→via, f→from, etc.) not needed here
    headers[key] = val;
  }
  return { status, reason, method, headers };
}

function parseDigestChallenge(header) {
  const pick = (name) => {
    const m = header.match(new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|([^,\\s]+))`, 'i'));
    return m ? (m[1] !== undefined ? m[1] : m[2]) : null;
  };
  return {
    realm:     pick('realm')     || '',
    nonce:     pick('nonce')     || '',       // used internally, NEVER logged
    qop:       pick('qop')       || null,
    algorithm: pick('algorithm') || 'MD5',
  };
}

/* ── Digest auth (RFC 2617) ─────────────────────────────────────────────── */

function computeDigestAuth({ extension, password, realm, nonce, qop, uri }) {
  // Only MD5 supported — per probe spec (J: algorithm MD5 only)
  const ha1 = md5(`${extension}:${realm}:${password}`);
  const ha2  = md5(`REGISTER:${uri}`);

  const authParams = [
    `username="${extension}"`,
    `realm="${realm}"`,
    `nonce="${nonce}"`,     // nonce appears in Authorization header but NOT in logs
    `uri="${uri}"`,
    `algorithm=MD5`,
  ];

  if (qop) {
    const nc     = '00000001';
    const cnonce = hex(8);
    const resp   = md5(`${ha1}:${nonce}:${nc}:${cnonce}:auth:${ha2}`);
    authParams.push(`cnonce="${cnonce}"`, `nc=${nc}`, `qop=auth`, `response="${resp}"`);
  } else {
    authParams.push(`response="${md5(`${ha1}:${nonce}:${ha2}`)}"`);
  }

  return `Digest ${authParams.join(', ')}`;
}

/* ── SIP message builder ────────────────────────────────────────────────── */

function buildRegister({ localIp, localPort, extension, registrarDomain, fromDomain,
                          contactAddress, callId, tag, seq, expires, authorization, useRport }) {
  const contact  = contactAddress || `${localIp}:${localPort}`;
  const rportStr = useRport ? ';rport' : '';
  const exp      = expires !== undefined ? expires : 120;

  const lines = [
    `REGISTER sip:${registrarDomain} SIP/2.0`,
    `Via: SIP/2.0/UDP ${localIp}:${localPort};branch=${newBranch()}${rportStr}`,
    `From: <sip:${extension}@${fromDomain}>;tag=${tag}`,
    `To: <sip:${extension}@${fromDomain}>`,
    `Call-ID: ${callId}`,
    `CSeq: ${seq} REGISTER`,
    `Contact: <sip:${extension}@${contact}>;expires=${exp}`,
    `Expires: ${exp}`,
    `Max-Forwards: 70`,
    `User-Agent: LabelGateway-Probe/1.0`,
    `Content-Length: 0`,
    '',
    '',
  ];
  if (authorization) lines.splice(10, 0, `Authorization: ${authorization}`);
  return lines.join('\r\n');
}

/* ── UDP transport per variant ──────────────────────────────────────────── */

async function openSocket() {
  const sock = dgram.createSocket('udp4');
  await new Promise((res, rej) => sock.bind(0, (e) => (e ? rej(e) : res())));

  const localPort = sock.address().port;
  const localIp   = await new Promise((res) => {
    const tmp = dgram.createSocket('udp4');
    tmp.connect(CFG.port, CFG.server, () => { const a = tmp.address().address; tmp.close(); res(a); });
  });

  // Persistent message router tied to this socket
  const pending = new Map();
  sock.on('message', (buf) => {
    const parsed = parseMessage(buf.toString('utf8'));
    if (parsed.status !== null) {
      const h = parsed.headers;
      const cseqNum = (h['cseq'] || '').match(/^(\d+)/)?.[1] || '0';
      const key     = `${h['call-id'] || ''}:${cseqNum}`;
      const w       = pending.get(key);
      if (w) {
        clearTimeout(w.timer);
        pending.delete(key);
        w.resolve({ ...parsed });
      } else if (CFG.debug) {
        console.log(`  [socket] unsolicited response ignored — key=${key} status=${parsed.status}`);
      }
    }
  });

  function sendAndWait(msg, callId, cseq) {
    const key = `${callId}:${cseq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(key);
        reject(new Error(`Timeout after ${TRANSACTION_TIMEOUT_MS / 1000}s (key=${key})`));
      }, TRANSACTION_TIMEOUT_MS);
      pending.set(key, { resolve, reject, timer });

      const buf = Buffer.from(msg, 'utf8');
      sock.send(buf, 0, buf.length, CFG.port, CFG.server, (err) => {
        if (err) { clearTimeout(timer); pending.delete(key); reject(err); }
      });
    });
  }

  function close() { try { sock.close(); } catch (_) {} }

  return { localIp, localPort, sendAndWait, close };
}

/* ── Single-variant runner ──────────────────────────────────────────────── */

async function runVariant(variant) {
  const { id, label, registrarDomain, fromDomain, authUri, useRport, qopMode, contactMode } = variant;

  let transport;
  try {
    transport = await openSocket();
  } catch (err) {
    return { id, label, firstStatus: null, finalStatus: null, reason: err.message, notes: 'socket open failed' };
  }

  const { localIp, localPort, sendAndWait, close } = transport;
  const callId = newCallId(localIp);
  const tag    = newTag();

  let firstStatus = null, firstReason = null;
  let finalStatus = null, finalReason = null;
  let notes = '';

  try {
    /* ── Step 1: unauthenticated REGISTER ──────────────────────────────── */
    const msg1 = buildRegister({
      localIp, localPort, extension: CFG.extension,
      registrarDomain, fromDomain, callId, tag,
      seq: 1, useRport,
    });

    if (CFG.debug) {
      console.log(`  [${id}]   Call-ID=${callId}`);
      console.log(`  [${id}]   REGISTER sip:${registrarDomain} From/To @${fromDomain} rport=${useRport}`);
    }

    const res1 = await sendAndWait(msg1, callId, 1);
    firstStatus = res1.status;
    firstReason = res1.reason;
    console.log(`  [${id}] ← ${res1.status} ${res1.reason}`);

    // Extract rport-discovered address from Via response header
    const viaResp    = res1.headers['via'] || '';
    const rportMatch = viaResp.match(/rport=(\d+)/i);
    const recvMatch  = viaResp.match(/received=([^\s;,>]+)/i);
    const discoveredPort = rportMatch ? parseInt(rportMatch[1], 10) : localPort;
    const discoveredIp   = recvMatch  ? recvMatch[1]               : localIp;

    if (discoveredIp !== localIp || discoveredPort !== localPort) {
      console.log(`  [${id}]   NAT detected: local=${localIp}:${localPort} discovered=${discoveredIp}:${discoveredPort}`);
    }

    if (res1.status === 200) {
      finalStatus = 200; finalReason = res1.reason;
      notes = 'registered without auth challenge';

    } else if (res1.status === 401 || res1.status === 407) {
      const authHeader = res1.status === 401
        ? res1.headers['www-authenticate']
        : res1.headers['proxy-authenticate'];

      if (!authHeader) {
        finalStatus = res1.status; finalReason = 'no challenge header';
        notes = `${res1.status} but missing WWW-Authenticate / Proxy-Authenticate`;
      } else {
        const ch = parseDigestChallenge(authHeader);
        // Log realm and qop presence — never log nonce or password
        console.log(`  [${id}]   realm="${ch.realm}"  qop=${ch.qop || 'none'}  algorithm=${ch.algorithm}`);
        notes = `realm="${ch.realm}" qop=${ch.qop || 'none'} algorithm=${ch.algorithm}`;

        const qopToUse = (qopMode === 'none') ? null : ch.qop;

        const authz = computeDigestAuth({
          extension: CFG.extension,
          password:  CFG.password,           // never logged — only used for HMAC
          realm:     ch.realm,
          nonce:     ch.nonce,               // never logged
          qop:       qopToUse,
          uri:       authUri,
        });

        /* ── Step 2: authenticated REGISTER ────────────────────────────── */
        const contactAddress = (contactMode === 'rport')
          ? `${discoveredIp}:${discoveredPort}`
          : null;

        if (CFG.debug && contactMode === 'rport') {
          console.log(`  [${id}]   Contact using rport-discovered address: ${discoveredIp}:${discoveredPort}`);
        }

        console.log(`  [${id}] → REGISTER (auth: uri=${authUri} qop=${qopToUse || 'none'})`);

        const msg2 = buildRegister({
          localIp, localPort, extension: CFG.extension,
          registrarDomain, fromDomain, contactAddress,
          callId, tag, seq: 2, useRport,
          authorization: authz,  // Authorization header — NOT logged
        });

        const res2 = await sendAndWait(msg2, callId, 2);
        finalStatus = res2.status;
        finalReason = res2.reason;
        console.log(`  [${id}] ← ${res2.status} ${res2.reason}`);

        if (res2.status === 200) {
          notes += ' → SUCCESS';
        } else {
          notes += ` → auth failed (${res2.status})`;
        }
      }

    } else {
      finalStatus = res1.status;
      finalReason = res1.reason;
      notes = 'unexpected initial response';
    }

    /* ── Cleanup: send Expires:0 if registered ──────────────────────────── */
    if (finalStatus === 200) {
      try {
        const u_callId = newCallId(localIp);
        const u_tag    = newTag();
        const msgU = buildRegister({
          localIp, localPort, extension: CFG.extension,
          registrarDomain, fromDomain, callId: u_callId, tag: u_tag,
          seq: 1, expires: 0, useRport: false,
        });
        await sendAndWait(msgU, u_callId, 1);
        console.log(`  [${id}]   (sent Expires:0 — unregistered cleanly)`);
      } catch (_) {
        // unregister failure is non-fatal in probe context
      }
    }

  } catch (err) {
    finalStatus = null;
    finalReason = err.message;
    notes       = 'error';
    console.log(`  [${id}] ERROR: ${err.message}`);
  } finally {
    close();
  }

  return { id, label, firstStatus, firstReason, finalStatus, finalReason, notes, variant };
}

/* ── Variant definitions ────────────────────────────────────────────────── */

const VARIANTS = [
  {
    id: 'A',
    label: 'Baseline — registrar=domain, From@domain, auth-uri=sip:domain, qop=auto, Contact=local, rport=yes',
    registrarDomain: CFG.domain,
    fromDomain:      CFG.domain,
    authUri:         `sip:${CFG.domain}`,
    useRport:        true,
    qopMode:         'auto',
    contactMode:     'local',
  },
  {
    id: 'B',
    label: 'auth-uri=sip:server (relevant when domain≠server)',
    registrarDomain: CFG.domain,
    fromDomain:      CFG.domain,
    authUri:         `sip:${CFG.server}`,
    useRport:        true,
    qopMode:         'auto',
    contactMode:     'local',
  },
  {
    id: 'C',
    label: 'From/To @server instead of @domain',
    registrarDomain: CFG.domain,
    fromDomain:      CFG.server,
    authUri:         `sip:${CFG.domain}`,
    useRport:        true,
    qopMode:         'auto',
    contactMode:     'local',
  },
  {
    id: 'D',
    label: 'All server: registrar=server, From@server, auth-uri=sip:server',
    registrarDomain: CFG.server,
    fromDomain:      CFG.server,
    authUri:         `sip:${CFG.server}`,
    useRport:        true,
    qopMode:         'auto',
    contactMode:     'local',
  },
  {
    id: 'E',
    label: 'Contact uses rport-discovered address (NAT/public IP traversal)',
    registrarDomain: CFG.domain,
    fromDomain:      CFG.domain,
    authUri:         `sip:${CFG.domain}`,
    useRport:        true,
    qopMode:         'auto',
    contactMode:     'rport',
  },
  {
    id: 'F',
    label: 'No rport in Via header (for servers that reject rport)',
    registrarDomain: CFG.domain,
    fromDomain:      CFG.domain,
    authUri:         `sip:${CFG.domain}`,
    useRport:        false,
    qopMode:         'auto',
    contactMode:     'local',
  },
  {
    id: 'G',
    label: 'Force no-qop auth even if server offers qop',
    registrarDomain: CFG.domain,
    fromDomain:      CFG.domain,
    authUri:         `sip:${CFG.domain}`,
    useRport:        true,
    qopMode:         'none',
    contactMode:     'local',
  },
  {
    id: 'H',
    label: 'All-server + rport-discovered Contact (full NAT traversal)',
    registrarDomain: CFG.server,
    fromDomain:      CFG.server,
    authUri:         `sip:${CFG.server}`,
    useRport:        true,
    qopMode:         'auto',
    contactMode:     'rport',
  },
];

/* ── Docs writer ────────────────────────────────────────────────────────── */

function writeDoc(result) {
  const v   = result.variant;
  const now = new Date().toISOString();

  const docsDir = path.join(__dirname, '..', 'docs');
  if (!fs.existsSync(docsDir)) fs.mkdirSync(docsDir, { recursive: true });

  const docPath = path.join(docsDir, 'PROMOSOFT_REGISTER_PROBE.md');

  const lines = [
    '# PromoSoft SIP REGISTER — Probe Results',
    '',
    `**Generated:** ${now}`,
    `**Server:** \`${CFG.server}:${CFG.port}/${CFG.transport}\``,
    `**Domain:** \`${CFG.domain}\``,
    `**Extension:** \`${CFG.extension}\``,
    '',
    '---',
    '',
    '## Winning Variant',
    '',
    `**Variant ${result.id}** — ${result.label}`,
    '',
    `**Auth notes:** ${result.notes}`,
    '',
    '## Exact Settings',
    '',
    '```',
    `REGISTER URI:  sip:${v.registrarDomain}`,
    `From/To:       sip:<extension>@${v.fromDomain}`,
    `Auth URI:      ${v.authUri}`,
    `Via rport:     ${v.useRport}`,
    `Contact mode:  ${v.contactMode}  (rport = use server-reflected address)`,
    `qop mode:      ${v.qopMode}      (auto = use qop if server offers it)`,
    '```',
    '',
    '---',
    '',
    '## TODO: Apply to PromoSoftSipClient.register()',
    '',
    'In `src/adapters/promosoft/PromoSoftSipClient.js`:',
    '',
    '```javascript',
    `// _buildRegister — use these values:`,
    `//   registrarDomain: "${v.registrarDomain}"`,
    `//   fromDomain:      "${v.fromDomain}"`,
    `//   authUri:         "${v.authUri}"`,
    `//   useRport:        ${v.useRport}`,
    `//   contactMode:     "${v.contactMode}"`,
    `//   qopMode:         "${v.qopMode}"`,
    '```',
    '',
    '---',
    '',
    '## All Variants Tested',
    '',
    '| Variant | First | Final | Notes |',
    '|---------|-------|-------|-------|',
  ];

  for (const r of (writeDoc._allResults || [])) {
    lines.push(
      `| ${r.id} | ${r.firstStatus ?? '—'} | ${r.finalStatus ?? '—'} | ${(r.notes || '').replace(/\|/g, '\\|')} |`
    );
  }

  lines.push('');
  fs.writeFileSync(docPath, lines.join('\n'), 'utf8');
  console.log(`\n  Documentation written to: ${docPath}`);
}

writeDoc._allResults = null;

/* ── Main ───────────────────────────────────────────────────────────────── */

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  PromoSoft SIP REGISTER Probe                            ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  console.log('Target:');
  console.log(`  server:    ${CFG.server}`);
  console.log(`  port:      ${CFG.port}`);
  console.log(`  transport: ${CFG.transport}`);
  console.log(`  domain:    ${CFG.domain}`);
  console.log(`  extension: ${CFG.extension}`);
  console.log(`  password:  ${'*'.repeat((CFG.password || '').length)}`);
  if (CFG.domain === CFG.server) {
    console.log('\n  NOTE: domain === server — variants B/C/D/H will differ only in qop/contact/rport logic.');
  }
  console.log('');

  const results     = [];
  let successResult = null;

  for (let i = 0; i < VARIANTS.length; i++) {
    const variant = VARIANTS[i];
    console.log(`── Variant ${variant.id}: ${variant.label}`);

    const result = await runVariant(variant);
    results.push(result);

    if (result.finalStatus === 200) {
      successResult = result;
      console.log(`\n  ✓ SUCCESS: Variant ${result.id} registered extension ${CFG.extension}`);
      break;
    }

    if (i < VARIANTS.length - 1) {
      process.stdout.write(`  (waiting ${VARIANT_DELAY_MS / 1000}s before next variant…)\n`);
      await new Promise((r) => setTimeout(r, VARIANT_DELAY_MS));
    }
    console.log('');
  }

  /* ── Summary table ────────────────────────────────────────────────────── */
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  RESULTS                                                 ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  const COL = { id: 9, first: 8, final: 8 };
  console.log(
    'Variant'.padEnd(COL.id) + 'First'.padEnd(COL.first) +
    'Final'.padEnd(COL.final) + 'Notes'
  );
  console.log('─'.repeat(72));

  for (const r of results) {
    const first = r.firstStatus != null ? String(r.firstStatus) : '—';
    const final = r.finalStatus != null ? String(r.finalStatus) : 'timeout';
    console.log(
      r.id.padEnd(COL.id) + first.padEnd(COL.first) +
      final.padEnd(COL.final) + (r.notes || r.finalReason || '')
    );
  }
  console.log('─'.repeat(72));

  if (successResult) {
    console.log(`\n✓ SUCCESS: Variant ${successResult.id}`);
    console.log(`  Extension ${CFG.extension} registered against ${CFG.server}`);
    console.log(`  ${successResult.notes}`);
    writeDoc._allResults = results;
    writeDoc(successResult);
  } else {
    console.log('\n✗ No variant produced 200 OK.');
    console.log('\nPossible causes:');
    console.log('  - Wrong extension or password');
    console.log('  - Server not reachable on UDP port 5060 (firewall?)');
    console.log('  - Server requires a different auth scheme');
    console.log('  - Add PROMOSOFT_DEBUG=true to .env for raw Via/Contact details');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[probe] Fatal:', err.message);
  process.exit(1);
});
