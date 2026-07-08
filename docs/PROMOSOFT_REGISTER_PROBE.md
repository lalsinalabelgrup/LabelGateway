# PromoSoft SIP REGISTER — Probe Results

**Generated:** 2026-06-29T15:01:11.255Z
**Server:** `prelabel2.guccontactcenter.com:5060/udp`
**Domain:** `prelabel2.guccontactcenter.com`
**Extension:** `102`

---

## Winning Variant

**Variant A** — Baseline — registrar=domain, From@domain, auth-uri=sip:domain, qop=auto, Contact=local, rport=yes

**Auth notes:** realm="asterisk" qop=none algorithm=MD5 → SUCCESS

## Exact Settings

```
REGISTER URI:  sip:prelabel2.guccontactcenter.com
From/To:       sip:<extension>@prelabel2.guccontactcenter.com
Auth URI:      sip:prelabel2.guccontactcenter.com
Via rport:     true
Contact mode:  local  (rport = use server-reflected address)
qop mode:      auto      (auto = use qop if server offers it)
```

---

## TODO: Apply to PromoSoftSipClient.register()

In `src/adapters/promosoft/PromoSoftSipClient.js`:

```javascript
// _buildRegister — use these values:
//   registrarDomain: "prelabel2.guccontactcenter.com"
//   fromDomain:      "prelabel2.guccontactcenter.com"
//   authUri:         "sip:prelabel2.guccontactcenter.com"
//   useRport:        true
//   contactMode:     "local"
//   qopMode:         "auto"
```

---

## All Variants Tested

| Variant | First | Final | Notes |
|---------|-------|-------|-------|
| A | 401 | 200 | realm="asterisk" qop=none algorithm=MD5 → SUCCESS |
