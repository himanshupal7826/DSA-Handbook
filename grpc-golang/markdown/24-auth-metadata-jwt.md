# 24 · Build: Authentication with Metadata, JWT, mTLS & Per-RPC Credentials

> **In one line:** gRPC separates *channel* security (TLS/mTLS, set once per connection) from *call* identity (a token in metadata, attached per RPC) — and the mistakes that matter are validating a token only at stream open, failing open on an unlisted method, and disabling `RequireTransportSecurity`.

---

## 1. Overview

Authentication in gRPC has two independent layers, and conflating them is the source of most confusion.

**Transport credentials** secure the connection. Exactly one applies per `ClientConn`: TLS verifying the server, mTLS additionally verifying the client, or `insecure.NewCredentials()` for local development. This layer answers "am I talking to the right machine, over a channel nobody can read?"

**Per-RPC credentials** carry caller identity, as metadata attached to each call. Several can apply. This layer answers "who is making this request, and may they?" — and it is where JWTs, OAuth tokens and service-account credentials live.

Both are needed in production. mTLS alone tells you which *service* is calling but not which *user* on whose behalf; a JWT alone travels in plaintext without TLS. The strongest common arrangement is mTLS between services for workload identity, plus a propagated user token for end-user identity, with the server checking both.

The enforcement point is an **interceptor** (chapter 23), because a new method must not be able to forget it. That means both a unary and a stream variant, sharing one implementation, with a policy that **fails closed** — a method not listed in the policy map is denied, not exposed.

The stream-specific hazard deserves its own mention: a token validated at stream open can outlive its expiry by hours. A 15-minute stream lifetime cap is usually the whole answer.

## 2. Core Concepts

- **Transport credentials** — `grpc.WithTransportCredentials` / `grpc.Creds`. One per connection.
- **mTLS** — mutual TLS: the server verifies the client's certificate, giving a cryptographic workload identity.
- **Per-RPC credentials** — `credentials.PerRPCCredentials`: an interface returning metadata for each call.
- **`RequireTransportSecurity()`** — the guard that stops credentials travelling over an insecure channel. Never return `false`.
- **Metadata** — key/value headers. Keys are lowercased; `-bin` suffix means binary, base64-encoded on the wire.
- **`authorization: Bearer <token>`** — the conventional header, matching HTTP practice.
- **JWT** — a signed token carrying claims: issuer, subject, audience, expiry, scopes.
- **JWKS** — the issuer's public keys, fetched over HTTPS and cached, used to verify signatures locally.
- **Principal** — the verified identity placed in the context for handlers to read.
- **Fail closed** — an unlisted method is denied. The default must be "no", not "yes".
- **Token propagation** — forwarding the caller's identity downstream, versus exchanging it for a service token.

## 3. Theory & Principles

### The two layers, and what each proves

| | Transport credentials | Per-RPC credentials |
|---|---|---|
| Scope | The connection | Each call |
| Answers | "Which machine, over what channel?" | "Which caller, with what rights?" |
| Set with | `grpc.Creds` / `WithTransportCredentials` | `WithPerRPCCredentials`, or `grpc.PerRPCCredentials` per call |
| Typical | TLS 1.3, mTLS | JWT, OAuth 2 token, service-account token |
| Verified by | The TLS stack, before any gRPC code runs | Your interceptor |
| Rotation | Certificate lifetime (hours to months) | Token lifetime (minutes to hours) |
| Failure code | Connection refused / handshake error | `Unauthenticated` |

mTLS gives you an identity that cannot be forged or replayed, established before a single byte of gRPC traffic flows — which makes it excellent for **workload** identity (service A talking to service B). It is poor for **end-user** identity, because certificates are per-workload and rotating them per user is impractical. Hence the layered arrangement: mTLS proves the calling service, a propagated token proves the end user.

### JWT validation: what must be checked

A JWT is only as good as the checks you perform. The minimum set, all of which are easy to omit:

1. **Signature**, against the issuer's current public key from JWKS — fetched over HTTPS and cached with a TTL, refreshed on an unknown key id.
2. **Algorithm**, against an allow-list. Accepting whatever the header says enables the classic `alg: none` and RS256→HS256 confusion attacks.
3. **`iss`** matches the expected issuer exactly.
4. **`aud`** contains your service. Without this, a token minted for another service is accepted here — a real and common escalation path.
5. **`exp`** and **`nbf`**, with a small clock-skew allowance (30–60 seconds).
6. **`sub`** is present and is the identity you record.
7. **Scopes or roles**, checked against what the method requires.

The library does items 1–2 and 5 if configured correctly; items 3, 4 and 7 are yours, and item 4 is the one most often missing.

**Never echo verification errors to the client.** "Key id `abc` not found in JWKS from `https://internal-idp/…`" tells an attacker your key ids and issuer topology. Return `Unauthenticated: invalid token` and log the detail.

### `Unauthenticated` vs `PermissionDenied`

- **`Unauthenticated`** — no credentials, malformed credentials, expired, wrong signature, wrong audience. The client should refresh and retry once.
- **`PermissionDenied`** — the identity is valid but lacks the required rights. Retrying never helps.

Conflating them produces clients that retry-loop on authorization failures or fail to refresh expiring tokens. And where enumeration matters, an object-level authorization failure may need to be `NotFound` instead (chapter 15).

```svg
<svg viewBox="0 0 880 500" width="100%" height="500" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="au1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#0ea5e9"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Two independent layers &#8212; production needs both</text>

  <rect x="24" y="42" width="410" height="190" rx="10" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="229" y="64" text-anchor="middle" fill="#1e40af" font-size="12" font-weight="bold">Transport credentials &#8212; the CONNECTION</text>
  <text x="42" y="88" fill="#1d4ed8" font-size="10">Set once per ClientConn. Verified by the TLS stack,</text>
  <text x="42" y="104" fill="#1d4ed8" font-size="10">before a single byte of gRPC traffic flows.</text>
  <text x="42" y="128" fill="#1e40af" font-size="10" font-weight="bold">mTLS proves WORKLOAD identity:</text>
  <text x="42" y="144" fill="#1d4ed8" font-size="10">&#8226; cannot be forged or replayed</text>
  <text x="42" y="160" fill="#1d4ed8" font-size="10">&#8226; read from peer.AuthInfo &#8594; TLSInfo &#8594; VerifiedChains</text>
  <text x="42" y="184" fill="#b91c1c" font-size="10" font-weight="bold">But NOT end-user identity: certificates are per-workload,</text>
  <text x="42" y="200" fill="#991b1b" font-size="10">and rotating them per user is impractical.</text>
  <text x="42" y="222" fill="#1e40af" font-size="10" font-weight="bold">Failure mode: handshake error, not a gRPC status.</text>

  <rect x="446" y="42" width="410" height="190" rx="10" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="651" y="64" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">Per-RPC credentials &#8212; the CALL</text>
  <text x="464" y="88" fill="#166534" font-size="10">Metadata attached to every call. Several may apply.</text>
  <text x="464" y="104" fill="#166534" font-size="10">Verified by YOUR interceptor.</text>
  <text x="464" y="128" fill="#15803d" font-size="10" font-weight="bold">A JWT proves END-USER identity:</text>
  <text x="464" y="144" fill="#166534" font-size="10">&#8226; authorization: Bearer &lt;token&gt;</text>
  <text x="464" y="160" fill="#166534" font-size="10">&#8226; short-lived, refreshable, carries scopes</text>
  <text x="464" y="184" fill="#b91c1c" font-size="10" font-weight="bold">RequireTransportSecurity() must return TRUE:</text>
  <text x="464" y="200" fill="#991b1b" font-size="10">it is what stops tokens travelling in plaintext.</text>
  <text x="464" y="222" fill="#15803d" font-size="10" font-weight="bold">Failure mode: codes.Unauthenticated.</text>

  <rect x="24" y="250" width="832" height="110" rx="10" fill="#fefce8" stroke="#ca8a04" stroke-width="2"/>
  <text x="440" y="272" text-anchor="middle" fill="#854d0e" font-size="12" font-weight="bold">The strong arrangement: both, checked together</text>
  <rect x="60" y="288" width="180" height="52" rx="6" fill="#fff" stroke="#ca8a04"/>
  <text x="150" y="308" text-anchor="middle" fill="#713f12" font-size="10" font-weight="bold">mTLS</text>
  <text x="150" y="326" text-anchor="middle" fill="#854d0e" font-size="9">"orders-service is calling"</text>
  <text x="256" y="318" fill="#854d0e" font-size="14" font-weight="bold">+</text>
  <rect x="278" y="288" width="180" height="52" rx="6" fill="#fff" stroke="#ca8a04"/>
  <text x="368" y="308" text-anchor="middle" fill="#713f12" font-size="10" font-weight="bold">propagated JWT</text>
  <text x="368" y="326" text-anchor="middle" fill="#854d0e" font-size="9">"on behalf of user u_42"</text>
  <text x="474" y="318" fill="#854d0e" font-size="14" font-weight="bold">=</text>
  <rect x="496" y="288" width="336" height="52" rx="6" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="664" y="308" text-anchor="middle" fill="#92400e" font-size="10" font-weight="bold">both dimensions verified</text>
  <text x="664" y="326" text-anchor="middle" fill="#b45309" font-size="9">a stolen token is useless without the client certificate</text>

  <rect x="24" y="378" width="832" height="112" rx="10" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="440" y="400" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">JWT checks &#8212; and the one everyone omits</text>
  <g font-size="10">
    <text x="50" y="424" fill="#166534">&#10003; signature via cached JWKS</text>
    <text x="290" y="424" fill="#166534">&#10003; algorithm ALLOW-LIST (blocks alg:none, RS256&#8594;HS256)</text>
    <text x="640" y="424" fill="#166534">&#10003; exp / nbf + skew</text>
    <text x="50" y="446" fill="#166534">&#10003; iss matches exactly</text>
    <text x="290" y="446" fill="#166534">&#10003; sub present and recorded</text>
    <text x="640" y="446" fill="#166534">&#10003; scopes vs the method</text>
    <text x="50" y="472" fill="#b91c1c" font-weight="bold">&#10007; aud contains THIS service</text>
    <text x="290" y="472" fill="#991b1b">&#8212; omit it and a token minted for another service is accepted here.</text>
    <text x="290" y="486" fill="#991b1b">A real, common privilege-escalation path.</text>
  </g>
</svg>
```

### The stream problem

Authentication happens once, when the stream opens. A 30-minute stream authorised by a token expiring in five minutes remains authorised for the remaining 25 — the interceptor never runs again.

Options, in order of preference:

1. **Cap stream lifetime below token lifetime** (chapter 16). One decision, and it also bounds deploy drains and rebalances load. This is almost always the right answer.
2. **Periodic re-validation** inside the handler: store the expiry at open, check it on a ticker, terminate with `Unauthenticated` when it passes.
3. **In-band refresh** for bidi: the client sends a refreshed credential as a stream message. Only viable for bidirectional, and it is real protocol design.

What is not acceptable is validating once and never again, because it silently converts a one-hour token into an indefinite grant.

## 4. Architecture & Workflow

The request path:

1. **TLS/mTLS handshake.** The transport verifies certificates before any gRPC code runs. A failure here is a connection error, not a status.
2. **Auth interceptor** extracts `authorization` from metadata, verifies the token, and builds a principal.
3. **Workload check** (if mTLS): the client certificate's identity is compared against what the token claims, so a stolen token from another workload is rejected.
4. **Method policy**: the required scopes for this `FullMethod` are checked. An unlisted method is **denied**.
5. **Principal into the context** — via the context for unary, via a wrapped stream for streaming.
6. **Handler** performs object-level authorization, which needs the resource and therefore cannot happen earlier (chapter 15).

```svg
<svg viewBox="0 0 880 420" width="100%" height="420" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="ap1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#0ea5e9"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Where each check happens</text>

  <rect x="30" y="42" width="160" height="66" rx="8" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="110" y="64" text-anchor="middle" fill="#1e40af" font-size="11" font-weight="bold">1. TLS handshake</text>
  <text x="110" y="82" text-anchor="middle" fill="#1d4ed8" font-size="9">before ANY gRPC code</text>
  <text x="110" y="98" text-anchor="middle" fill="#1d4ed8" font-size="9">failure = conn error</text>

  <path d="M192,75 L226,75" stroke="#0ea5e9" stroke-width="2" marker-end="url(#ap1)"/>

  <rect x="230" y="42" width="160" height="66" rx="8" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="310" y="64" text-anchor="middle" fill="#15803d" font-size="11" font-weight="bold">2. verify token</text>
  <text x="310" y="82" text-anchor="middle" fill="#166534" font-size="9">sig, alg, iss, aud, exp</text>
  <text x="310" y="98" text-anchor="middle" fill="#166534" font-size="9">&#8594; Unauthenticated</text>

  <path d="M392,75 L426,75" stroke="#0ea5e9" stroke-width="2" marker-end="url(#ap1)"/>

  <rect x="430" y="42" width="180" height="66" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="520" y="64" text-anchor="middle" fill="#92400e" font-size="11" font-weight="bold">3. workload binding</text>
  <text x="520" y="82" text-anchor="middle" fill="#b45309" font-size="9">cert identity vs token claim</text>
  <text x="520" y="98" text-anchor="middle" fill="#b45309" font-size="9">stolen token &#8594; rejected</text>

  <path d="M612,75 L646,75" stroke="#0ea5e9" stroke-width="2" marker-end="url(#ap1)"/>

  <rect x="650" y="42" width="180" height="66" rx="8" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="740" y="64" text-anchor="middle" fill="#5b21b6" font-size="11" font-weight="bold">4. method policy</text>
  <text x="740" y="82" text-anchor="middle" fill="#6d28d9" font-size="9">required scopes</text>
  <text x="740" y="98" text-anchor="middle" fill="#6d28d9" font-size="9">&#8594; PermissionDenied</text>

  <path d="M740,110 L740,144" stroke="#0ea5e9" stroke-width="2" marker-end="url(#ap1)"/>

  <rect x="560" y="148" width="270" height="60" rx="8" fill="#f1f5f9" stroke="#64748b" stroke-width="2"/>
  <text x="695" y="170" text-anchor="middle" fill="#334155" font-size="11" font-weight="bold">5. principal &#8594; context</text>
  <text x="695" y="188" text-anchor="middle" fill="#475569" font-size="9">unary: ctx &#183; stream: wrap + override Context()</text>

  <path d="M560,178 L526,178" stroke="#0ea5e9" stroke-width="2" marker-end="url(#ap1)"/>

  <rect x="250" y="148" width="270" height="60" rx="8" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="385" y="170" text-anchor="middle" fill="#15803d" font-size="11" font-weight="bold">6. object-level authz</text>
  <text x="385" y="188" text-anchor="middle" fill="#166534" font-size="9">in the HANDLER &#8212; it needs the resource</text>

  <rect x="30" y="228" width="410" height="180" rx="10" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="235" y="250" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">Fail closed &#8212; the most valuable line in the file</text>
  <g font-family="ui-monospace,monospace" font-size="10" fill="#7f1d1d">
    <text x="46" y="276">policy, known := policies[fullMethod]</text>
    <text x="46" y="294">if !known {</text>
    <text x="46" y="312">    return PermissionDenied   &#8592; DENY</text>
    <text x="46" y="330">}</text>
  </g>
  <text x="46" y="356" fill="#991b1b" font-size="10">A method added on a Friday without a policy entry is</text>
  <text x="46" y="372" fill="#991b1b" font-size="10">DENIED, not exposed. Fail open and it ships public.</text>
  <text x="46" y="396" fill="#b91c1c" font-size="10" font-weight="bold">Back it with a reflection test over GetServiceInfo().</text>

  <rect x="452" y="228" width="378" height="180" rx="10" fill="#fefce8" stroke="#ca8a04" stroke-width="2"/>
  <text x="641" y="250" text-anchor="middle" fill="#854d0e" font-size="12" font-weight="bold">The stream problem</text>
  <text x="468" y="274" fill="#713f12" font-size="10">Auth runs ONCE, at stream open. A 30-minute stream</text>
  <text x="468" y="290" fill="#713f12" font-size="10">authorised by a 5-minute token stays authorised for 25.</text>
  <text x="468" y="316" fill="#854d0e" font-size="10" font-weight="bold">1. Cap stream lifetime below token lifetime &#8212; usually</text>
  <text x="468" y="332" fill="#713f12" font-size="10">   the whole answer, and it bounds deploys too.</text>
  <text x="468" y="352" fill="#713f12" font-size="10">2. Re-validate on a ticker inside the handler.</text>
  <text x="468" y="372" fill="#713f12" font-size="10">3. In-band refresh (bidi only) &#8212; real protocol design.</text>
  <text x="468" y="396" fill="#b91c1c" font-size="10" font-weight="bold">Never: validate once and never again.</text>
</svg>
```

## 5. Implementation

### Server: TLS and mTLS

```go
package server

import (
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"os"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
)

// serverTLS builds transport credentials. When clientCAFile is set, the server
// REQUIRES and VERIFIES a client certificate — that is mTLS, and it gives you
// a workload identity established before any gRPC code runs.
func serverTLS(certFile, keyFile, clientCAFile string) (credentials.TransportCredentials, error) {
	cert, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err != nil {
		return nil, fmt.Errorf("load server key pair: %w", err)
	}

	cfg := &tls.Config{
		Certificates: []tls.Certificate{cert},
		MinVersion:   tls.VersionTLS13,
		NextProtos:   []string{"h2"}, // ALPN must advertise HTTP/2 for gRPC
	}

	if clientCAFile != "" {
		pem, err := os.ReadFile(clientCAFile)
		if err != nil {
			return nil, fmt.Errorf("read client CA: %w", err)
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(pem) {
			return nil, errors.New("client CA file contained no valid certificates")
		}
		cfg.ClientCAs = pool
		// RequireAndVerifyClientCert, not VerifyClientCertIfGiven: the latter
		// makes mTLS optional, which means it is not mTLS.
		cfg.ClientAuth = tls.RequireAndVerifyClientCert
	}

	return credentials.NewTLS(cfg), nil
}
```

### Reading the mTLS identity

```go
import "google.golang.org/grpc/peer"

// WorkloadIdentity extracts the verified client certificate's identity.
//
// This is the strongest identity available: it was verified by the TLS stack
// before any gRPC code ran, and it cannot be forged or replayed the way a
// bearer token can.
func WorkloadIdentity(ctx context.Context) (string, bool) {
	p, ok := peer.FromContext(ctx)
	if !ok {
		return "", false
	}
	tlsInfo, ok := p.AuthInfo.(credentials.TLSInfo)
	if !ok {
		return "", false // not a TLS connection
	}
	if len(tlsInfo.State.VerifiedChains) == 0 || len(tlsInfo.State.VerifiedChains[0]) == 0 {
		return "", false // no verified client certificate
	}

	leaf := tlsInfo.State.VerifiedChains[0][0]

	// Prefer a SPIFFE URI SAN when present — it is the modern workload-identity
	// convention and is unambiguous. Fall back to the Common Name.
	for _, u := range leaf.URIs {
		if u.Scheme == "spiffe" {
			return u.String(), true
		}
	}
	return leaf.Subject.CommonName, true
}
```

### JWT verification

```go
package auth

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/MicahParks/keyfunc/v3"
	"github.com/golang-jwt/jwt/v5"
)

type Principal struct {
	Subject  string
	Issuer   string
	Scopes   map[string]struct{}
	Workload string    // from mTLS, when present
	Expiry   time.Time // needed for stream re-validation
}

func (p *Principal) HasScope(s string) bool {
	_, ok := p.Scopes[s]
	return ok
}

type Verifier struct {
	// jwks caches the issuer's public keys and refreshes them in the
	// background. A synchronous fetch per request would couple every RPC's
	// latency to the identity provider.
	jwks keyfunc.Keyfunc

	issuer   string
	audience string
}

func NewVerifier(ctx context.Context, jwksURL, issuer, audience string) (*Verifier, error) {
	if issuer == "" || audience == "" {
		// Refuse to construct a verifier that cannot check iss and aud.
		return nil, errors.New("issuer and audience are required")
	}
	k, err := keyfunc.NewDefaultCtx(ctx, []string{jwksURL})
	if err != nil {
		return nil, fmt.Errorf("initialise JWKS: %w", err)
	}
	return &Verifier{jwks: k, issuer: issuer, audience: audience}, nil
}

// Verify performs every check. Omitting any one of them is a real vulnerability.
func (v *Verifier) Verify(ctx context.Context, raw string) (*Principal, error) {
	token, err := jwt.Parse(raw, v.jwks.Keyfunc,
		// ALGORITHM ALLOW-LIST. Without it, an attacker can present a token
		// with alg:none, or swap RS256 for HS256 and sign with the public key.
		// This single option blocks a whole class of attacks.
		jwt.WithValidMethods([]string{"RS256", "ES256"}),

		// AUDIENCE. The check most often omitted: without it, a token minted
		// for a different service is accepted here — a real escalation path.
		jwt.WithAudience(v.audience),

		jwt.WithIssuer(v.issuer),
		jwt.WithExpirationRequired(),
		jwt.WithLeeway(30*time.Second), // modest clock-skew allowance
	)
	if err != nil {
		// Wrap for OUR logs. The caller must never see this text: it discloses
		// key ids, issuer URLs and clock-skew details.
		return nil, fmt.Errorf("jwt validation: %w", err)
	}

	claims, ok := token.Claims.(jwt.MapClaims)
	if !ok {
		return nil, errors.New("unexpected claims type")
	}

	sub, err := claims.GetSubject()
	if err != nil || sub == "" {
		return nil, errors.New("missing sub claim")
	}
	exp, err := claims.GetExpirationTime()
	if err != nil || exp == nil {
		return nil, errors.New("missing exp claim")
	}

	// Scopes may be a space-delimited string (OAuth 2) or an array.
	scopes := map[string]struct{}{}
	switch s := claims["scope"].(type) {
	case string:
		for _, sc := range strings.Fields(s) {
			scopes[sc] = struct{}{}
		}
	case []any:
		for _, sc := range s {
			if str, ok := sc.(string); ok {
				scopes[str] = struct{}{}
			}
		}
	}

	return &Principal{
		Subject: sub, Issuer: v.issuer, Scopes: scopes,
		Expiry: exp.Time,
	}, nil
}
```

### The auth interceptor, with both variants

```go
type policy struct {
	Public bool
	Scopes []string
}

// Policy as DATA, keyed by fully-qualified method. Declaring it this way is
// what makes fail-closed possible and reviewable.
var policies = map[string]policy{
	"/grpc.health.v1.Health/Check":                       {Public: true},
	"/acme.inventory.v1.InventoryService/GetItem":        {Scopes: []string{"inventory:read"}},
	"/acme.inventory.v1.InventoryService/UpdateItem":     {Scopes: []string{"inventory:write"}},
	"/acme.inventory.v1.InventoryService/ReserveStock":   {Scopes: []string{"inventory:reserve"}},
	"/acme.inventory.v1.InventoryService/WatchStock":     {Scopes: []string{"inventory:read"}},
	"/acme.inventory.v1.InventoryService/SyncInventory":  {Scopes: []string{"inventory:write"}},
}

// authenticate is shared by both interceptor shapes so unary and streaming
// methods cannot diverge in what they enforce.
func authenticate(ctx context.Context, v *Verifier, fullMethod string) (context.Context, error) {
	pol, known := policies[fullMethod]
	if !known {
		// FAIL CLOSED. A method added without a policy entry is denied, not
		// exposed. Back this with a reflection test (see below).
		return nil, status.Errorf(codes.PermissionDenied,
			"no authorization policy declared for %s", fullMethod)
	}
	if pol.Public {
		return ctx, nil
	}

	md, ok := metadata.FromIncomingContext(ctx)
	if !ok {
		return nil, status.Error(codes.Unauthenticated, "missing metadata")
	}
	vals := md.Get("authorization")
	if len(vals) == 0 {
		return nil, status.Error(codes.Unauthenticated, "missing authorization header")
	}
	raw, found := strings.CutPrefix(vals[0], "Bearer ")
	if !found {
		return nil, status.Error(codes.Unauthenticated, "expected a Bearer token")
	}

	principal, err := v.Verify(ctx, raw)
	if err != nil {
		// Log the detail; return an opaque message.
		slog.WarnContext(ctx, "token verification failed",
			"method", fullMethod, "err", err)
		return nil, status.Error(codes.Unauthenticated, "invalid token")
	}

	// Bind the token to the workload when mTLS is in use: a token stolen from
	// one service is then useless when presented by another.
	if wl, ok := WorkloadIdentity(ctx); ok {
		principal.Workload = wl
		if !allowedWorkloadForSubject(wl, principal.Subject) {
			slog.WarnContext(ctx, "token/workload mismatch",
				"workload", wl, "subject", principal.Subject)
			return nil, status.Error(codes.PermissionDenied, "credential mismatch")
		}
	}

	for _, required := range pol.Scopes {
		if !principal.HasScope(required) {
			// PermissionDenied, not Unauthenticated: the identity is valid,
			// the rights are not, and only one of those a refresh can fix.
			return nil, status.Errorf(codes.PermissionDenied,
				"missing required scope %q", required)
		}
	}

	return ContextWithPrincipal(ctx, principal), nil
}

func UnaryAuth(v *Verifier) grpc.UnaryServerInterceptor {
	return func(ctx context.Context, req any, info *grpc.UnaryServerInfo,
		handler grpc.UnaryHandler) (any, error) {
		ctx, err := authenticate(ctx, v, info.FullMethod)
		if err != nil {
			return nil, err
		}
		return handler(ctx, req)
	}
}

// StreamAuth is NOT optional. Implementing only the unary variant leaves every
// streaming method unauthenticated — silently, with no warning.
func StreamAuth(v *Verifier) grpc.StreamServerInterceptor {
	return func(srv any, ss grpc.ServerStream, info *grpc.StreamServerInfo,
		handler grpc.StreamHandler) error {
		ctx, err := authenticate(ss.Context(), v, info.FullMethod)
		if err != nil {
			return err
		}
		// Wrapping is the only way to make the principal visible to a
		// streaming handler (chapter 23).
		return handler(srv, wrapStream(ss, ctx))
	}
}
```

### The test that actually prevents the Friday-afternoon gap

```go
// TestEveryMethodHasAPolicy walks the server's registered services and asserts
// each method appears in the policy map.
//
// This is the test that catches a newly added RPC before it ships, rather than
// relying on someone remembering to update two files.
func TestEveryMethodHasAPolicy(t *testing.T) {
	srv := grpc.NewServer()
	inventoryv1.RegisterInventoryServiceServer(srv, &inventory.Service{})
	healthpb.RegisterHealthServer(srv, health.NewServer())

	for svcName, info := range srv.GetServiceInfo() {
		for _, m := range info.Methods {
			full := fmt.Sprintf("/%s/%s", svcName, m.Name)
			if _, ok := policies[full]; !ok {
				t.Errorf("method %s has no authorization policy entry", full)
			}
		}
	}
}
```

### Client: per-RPC credentials

```go
// tokenCredentials implements credentials.PerRPCCredentials.
type tokenCredentials struct {
	source TokenSource // caches and refreshes
}

func (t *tokenCredentials) GetRequestMetadata(
	ctx context.Context, uri ...string,
) (map[string]string, error) {
	// This runs on EVERY call, so it must be cheap: the token source caches
	// and refreshes in the background rather than fetching per request.
	tok, err := t.source.Token(ctx)
	if err != nil {
		return nil, status.Errorf(codes.Unauthenticated, "obtain token: %v", err)
	}
	return map[string]string{"authorization": "Bearer " + tok}, nil
}

// RequireTransportSecurity MUST return true. Returning false lets gRPC send
// the token over an insecure connection, which is exactly how bearer tokens
// end up in plaintext on the wire.
func (t *tokenCredentials) RequireTransportSecurity() bool { return true }

func newAuthenticatedClient(target string, src TokenSource, tlsCfg *tls.Config) (*grpc.ClientConn, error) {
	return grpc.NewClient(target,
		// Layer 1: the connection.
		grpc.WithTransportCredentials(credentials.NewTLS(tlsCfg)),
		// Layer 2: the caller's identity, attached to every call.
		grpc.WithPerRPCCredentials(&tokenCredentials{source: src}),
	)
}
```

### Propagating identity downstream

```go
// forwardIdentity passes the caller's token to a downstream service.
//
// Two models, and the choice matters:
//
//  1. PROPAGATION (this function): forward the end-user token unchanged. The
//     downstream service sees the real user, so its own authorization works
//     naturally. Requires the token's audience to include that service, or
//     the aud check will correctly reject it.
//
//  2. EXCHANGE: swap the user token for a service token that asserts "orders
//     acting for user u_42". Stronger, because each hop's audience is exact
//     and a leaked token has a narrow blast radius. Needs an identity provider
//     that supports token exchange (RFC 8693).
//
// Propagation is simpler; exchange is safer. Whichever you choose, do not
// silently drop the user identity and call downstream as the service itself —
// that loses the audit trail and over-privileges every call.
func forwardIdentity(ctx context.Context) context.Context {
	md, ok := metadata.FromIncomingContext(ctx)
	if !ok {
		return ctx
	}
	out := metadata.MD{}
	for _, k := range []string{"authorization", "x-request-id", "traceparent"} {
		if v := md.Get(k); len(v) > 0 {
			out.Set(k, v...)
		}
	}
	return metadata.NewOutgoingContext(ctx, out)
}
```

### Re-validating on a long stream

```go
// WatchStock re-checks the token periodically, for the case where capping the
// stream lifetime below token lifetime is not acceptable.
func (s *Service) WatchStock(
	req *inventoryv1.WatchStockRequest,
	stream inventoryv1.InventoryService_WatchStockServer,
) error {
	ctx := stream.Context()
	principal, _ := PrincipalFromContext(ctx)

	// The simpler alternative, and usually the right one: cap the stream at
	// less than the token's remaining validity and let the client reconnect
	// with a fresh token.
	//   maxAge := min(30*time.Minute, time.Until(principal.Expiry))

	authCheck := time.NewTicker(1 * time.Minute)
	defer authCheck.Stop()

	for {
		select {
		case <-ctx.Done():
			return status.FromContextError(ctx.Err()).Err()

		case <-authCheck.C:
			if time.Now().After(principal.Expiry) {
				// Terminate rather than silently continuing on an expired grant.
				return status.Error(codes.Unauthenticated,
					"token expired; reconnect with a fresh token")
			}

		case ev := <-events:
			if err := stream.Send(toProto(ev)); err != nil {
				return err
			}
		}
	}
}
```

## 6. Advantages, Disadvantages & Trade-offs

**Advantages**
- **Two independent layers** let you separate workload identity from user identity and verify both.
- **mTLS identity is established before any application code runs** and cannot be forged or replayed.
- **`RequireTransportSecurity`** makes accidental plaintext token transmission a library-level error rather than a code review question.
- **Interceptors make enforcement unforgettable**, and a fail-closed policy map makes gaps loud.
- **Local JWT validation** means no per-request round trip to an identity provider.

**Disadvantages**
- **Certificate management is real work** — issuance, rotation, revocation, trust distribution.
- **Streams authenticate once**, so long-lived streams need explicit handling.
- **JWT validation has many steps**, each individually easy to omit, and `aud` in particular.
- **Bearer tokens are replayable** if intercepted, which is why transport security is not optional.
- **mTLS gives no end-user identity**, so it is never the whole answer for user-facing systems.

**Trade-offs**
- *Propagation vs exchange:* propagating the user token is simple and preserves identity, but the token's audience must include every hop and a leak is broad. Exchange narrows each hop's audience at the cost of an identity provider that supports it.
- *Stream lifetime cap vs re-validation:* capping is one decision that also bounds deploy drains and rebalances load; re-validation keeps streams long-lived at the cost of protocol and handler complexity.
- *mTLS everywhere vs at the mesh boundary:* everywhere is strongest and costs certificate plumbing in every service; at the boundary is cheaper but trusts the internal network.

## 7. Common Mistakes & Best Practices

- **Implementing only the unary auth interceptor.** Streaming methods are then unauthenticated, silently.
- **Failing open on an unlisted method.** A method added without a policy entry ships public.
- **Omitting the `aud` check.** A token minted for another service is accepted here.
- **Not allow-listing algorithms.** Enables `alg: none` and RS256→HS256 confusion.
- **`RequireTransportSecurity()` returning `false`.** Tokens travel in plaintext.
- **`VerifyClientCertIfGiven` instead of `RequireAndVerifyClientCert`.** That is optional mTLS, which is not mTLS.
- **Echoing verification errors.** They disclose key ids, issuer URLs and clock skew.
- **Fetching JWKS synchronously per request.** Couples every RPC's latency to the identity provider.
- **Validating a stream's token only at open.** A one-hour token becomes an indefinite grant.
- **Logging the `authorization` header.** It ends up in log aggregation, permanently.
- **Conflating `Unauthenticated` and `PermissionDenied`.** Clients then retry-loop or fail to refresh.
- **Dropping user identity when calling downstream.** Loses the audit trail and over-privileges the call.
- **Skipping object-level authorization** because the interceptor "already did auth". It checked scopes, not this resource.

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** `grpcurl -H "authorization: Bearer $TOKEN"` exercises the path by hand. For mTLS problems, `openssl s_client -connect host:443 -cert client.pem -key client.key` isolates the handshake from gRPC entirely. Log the `sub`, the method and the decision — never the token.
- **Monitoring.** Count `Unauthenticated` and `PermissionDenied` separately and by method: a spike in the first usually means an expiring credential or a clock problem, a spike in the second means a policy change or a misconfigured client. Alert on JWKS fetch failures, because a stale key cache eventually rejects everything. Track certificate expiry as a gauge — expired certificates cause outages that look like network failures.
- **Security.** Short token lifetimes plus refresh limit replay damage. mTLS plus token binding means a stolen token is useless from another workload. Keep an algorithm allow-list, check `aud`, and cap stream lifetimes below token lifetimes. Never return verification details to callers. Rotate certificates automatically, and test that rotation works before you need it.
- **Scaling.** Verification must be local and cached: JWKS fetched in the background with a TTL and refreshed on unknown key ids, never synchronously per call. Introspection endpoints do not scale — prefer self-contained tokens. mTLS handshakes are CPU-heavy, which is another reason connections should be long-lived and reused rather than pooled per request (chapter 19).

## 9. Interview Questions

**Q: What is the difference between transport credentials and per-RPC credentials?**
A: Transport credentials secure the connection and exactly one applies per `ClientConn` — TLS, mTLS, or `insecure`. They are verified by the TLS stack before any gRPC code runs, and answer "which machine, over what channel". Per-RPC credentials attach caller identity to each call as metadata, several can apply, and they are verified by your interceptor — they answer "which caller, with what rights". Production needs both: mTLS proves the calling workload, a token proves the end user.

**Q: What does `RequireTransportSecurity` do and why must it return true?**
A: It tells gRPC whether these credentials may be sent over an insecure connection. Returning `true` makes the library refuse to attach them to a plaintext channel, which is what prevents a bearer token — a replayable secret — travelling in the clear. Returning `false` is occasionally done to make local development easier, and it is how tokens end up captured in a packet trace. If you need insecure local development, use a separate configuration path rather than weakening the credential.

**Q: What must you validate in a JWT?**
A: The signature against the issuer's current public key from a cached JWKS; the algorithm against an allow-list, which blocks `alg: none` and RS256→HS256 confusion; the issuer, matched exactly; the audience, which must contain your service; expiry and not-before with a small skew allowance; the subject, which is the identity you record; and the scopes against what the method requires. The library handles signature, algorithm and expiry if configured; issuer, audience and scopes are yours. Audience is the one most often omitted, and omitting it means a token minted for a different service is accepted here.

**Q: How do you get the client's identity from mTLS?**
A: From `peer.FromContext(ctx)`, type-asserting `p.AuthInfo` to `credentials.TLSInfo`, and reading `State.VerifiedChains[0][0]` — the verified leaf certificate. Prefer a SPIFFE URI SAN if present, since that is the modern workload-identity convention and is unambiguous; otherwise fall back to the Common Name. The reason to prefer this over a header is that it was verified cryptographically by the TLS stack before any application code ran, so it cannot be forged or replayed.

**Q: Why is a streaming method a special case for authentication?**
A: Because the interceptor runs once, when the stream opens, and never again. A thirty-minute stream authorised by a token expiring in five minutes stays authorised for the remaining twenty-five — the token silently becomes an indefinite grant. The usual fix is to cap stream lifetime below token lifetime and close with `Unavailable` plus a reconnect hint, which also bounds deploy drains and rebalances load. Alternatives are periodic re-validation inside the handler against the expiry captured at open, or in-band credential refresh for bidirectional streams.

**Q: `Unauthenticated` or `PermissionDenied`?**
A: `Unauthenticated` when there are no credentials, or they are malformed, expired, wrongly signed or for the wrong audience — the client should refresh and retry once. `PermissionDenied` when the identity is valid but lacks the required rights, where retrying never helps. Conflating them produces clients that retry-loop on authorization failures or fail to refresh expiring tokens. And where resource existence is itself sensitive, an object-level authorization failure may need to be `NotFound` instead, to avoid an existence oracle.

**Q: How do you make sure a new method cannot ship unauthenticated?**
A: Three things together. Enforce in an interceptor, with both unary and stream variants sharing one function so they cannot diverge. Declare the policy as data keyed by fully-qualified method, and **fail closed** — an unlisted method is denied, not permitted. And add a test that walks `srv.GetServiceInfo()`, enumerates every registered method including streaming ones, and asserts each has a policy entry. That last test is what actually catches it, because it fails when someone adds a method rather than when someone remembers to check.

**Q: (Senior) Design authentication for a service mesh with end-user identity.**
A: Two layers. mTLS between every service for workload identity, ideally with SPIFFE IDs so the identity is structured rather than a Common Name convention, and certificates issued and rotated automatically by the mesh or an internal CA. On top of that, a short-lived JWT carrying the end user, validated locally against a cached JWKS with the full check set including audience. The server binds them: the token's subject or an actor claim must be consistent with the calling workload's certificate identity, so a token stolen from one service is useless when presented by another. Enforcement is an interceptor pair over a fail-closed policy map, with a reflection test asserting coverage. For propagation downstream I would prefer token exchange over raw forwarding, because it narrows each hop's audience and limits the blast radius of a leak — accepting that it needs an identity provider supporting RFC 8693, and falling back to propagation with a multi-audience token if not. Streams get lifetime caps below token validity rather than in-band refresh, because that is one decision that also solves deploy drains and load rebalancing.

**Q: (Senior) A streaming method was found unauthenticated in production. Explain how, and how you prevent recurrence.**
A: Almost certainly because only the unary interceptor existed. `ChainUnaryInterceptor` and `ChainStreamInterceptor` are separate lists, and adding auth to the first does nothing for streaming methods — no compile error, no warning, and tests usually pass a valid token anyway so nobody notices. The second possibility is that the stream interceptor existed but did not wrap the stream, so the principal never reached the handler; if the handler then reads an empty context and fails open, everything is permitted. Prevention is structural rather than procedural: share one `authenticate` function between both shapes so their logic cannot drift; fail closed on an unlisted method so a gap denies rather than exposes; and add the reflection-driven test over `GetServiceInfo()` that asserts every method has a policy and is rejected without credentials. I would also add a negative integration test per streaming method — open the stream with no token and assert `Unauthenticated` — because that is the assertion that would have caught it.

**Q: (Senior) How do you handle credential rotation without downtime?**
A: For certificates, the mechanisms are well established but must be exercised before they are needed. Servers should reload certificates without restarting, via a `tls.Config.GetCertificate` callback reading from a cache refreshed by a file watcher or the mesh's SDS API, so rotation is not a deploy. Trust distribution must precede issuance: the new CA is added to every trust store first, certificates are then issued from it, and only afterwards is the old CA removed — three separate rollouts, in that order, or you get an outage in the middle. Overlapping validity periods give room for clock skew and slow rollouts. For tokens, the client's token source refreshes in the background before expiry rather than on the first failure, so no request ever waits on the identity provider, and the server's JWKS cache refreshes on an unknown key id so a signing-key rotation is picked up automatically rather than at the next TTL. The things I would monitor are certificate expiry as a gauge with an alert well before the deadline, JWKS fetch failures, and the `Unauthenticated` rate — a spike in that during a rotation window is the signal that a step was skipped. And I would rehearse rotation in staging on a schedule, because rotation code that has never run is rotation code that does not work.

## 10. Quick Revision & Cheat Sheet

```go
// SERVER: transport (mTLS)
tlsCfg := &tls.Config{
    Certificates: []tls.Certificate{cert},
    ClientCAs:    pool,
    ClientAuth:   tls.RequireAndVerifyClientCert,   // not …IfGiven
    MinVersion:   tls.VersionTLS13,
    NextProtos:   []string{"h2"},
}
grpc.NewServer(grpc.Creds(credentials.NewTLS(tlsCfg)), …)

// SERVER: per-call identity — BOTH interceptors
grpc.ChainUnaryInterceptor(auth.UnaryAuth(v))
grpc.ChainStreamInterceptor(auth.StreamAuth(v))    // NOT optional

// CLIENT: both layers
grpc.NewClient(target,
    grpc.WithTransportCredentials(credentials.NewTLS(tlsCfg)),
    grpc.WithPerRPCCredentials(&tokenCredentials{src}),  // RequireTransportSecurity() == true
)

// JWT checks
jwt.Parse(raw, keyfunc,
    jwt.WithValidMethods([]string{"RS256","ES256"}),  // blocks alg:none
    jwt.WithAudience(myService),                      // the one people omit
    jwt.WithIssuer(expectedIssuer),
    jwt.WithExpirationRequired(),
    jwt.WithLeeway(30*time.Second))
```

| Concern | Answer |
|---|---|
| Which machine? | Transport credentials (TLS/mTLS) |
| Which caller? | Per-RPC credentials (JWT in metadata) |
| Workload identity | `peer.FromContext` → `TLSInfo` → `VerifiedChains[0][0]` |
| Enforcement point | Interceptor — **both** unary and stream |
| Unlisted method | **Deny** (fail closed) + reflection test |
| Bad/expired token | `Unauthenticated` |
| Valid identity, no rights | `PermissionDenied` |
| Long stream | Cap lifetime below token validity |
| Downstream identity | Propagate the token, or exchange it |

**Flash cards**
- **Two layers?** → Transport (connection) and per-RPC (call). Both needed.
- **The omitted JWT check?** → `aud`. Without it, another service's token works here.
- **`RequireTransportSecurity()`?** → Must be `true`, or tokens go in plaintext.
- **mTLS config?** → `RequireAndVerifyClientCert`, not `…IfGiven`.
- **Stream auth?** → Runs once at open. Cap the lifetime.
- **Unlisted method?** → Deny, and test for it with reflection.
- **Verification error text?** → Log it, never return it.

## 11. Hands-On Exercises & Mini Project

- [ ] Set up mTLS end to end and extract the client's SPIFFE ID or Common Name in a handler. Then connect without a client certificate and observe the handshake failure.
- [ ] Remove `jwt.WithAudience` and prove a token minted for a different service is accepted. Restore it.
- [ ] Remove `jwt.WithValidMethods` and craft an `alg: none` token that passes. Restore it.
- [ ] Implement only the unary auth interceptor, then call a streaming method without a token and confirm it succeeds. Add the stream variant.
- [ ] Delete a method's policy entry and confirm it is denied, not permitted. Then add a new RPC and watch the reflection test fail.
- [ ] Return `false` from `RequireTransportSecurity`, connect insecurely, and capture the token in `tcpdump`. Restore it.
- [ ] Open a stream with a token expiring in 30 seconds and confirm it survives for the full stream. Add a lifetime cap and confirm it does not.

### Mini Project — "Zero-Trust Inventory Service"

**Goal.** Build a service where both workload and user identity are verified on every call, gaps are impossible to introduce, and rotation is proven to work.

**Requirements.**
1. mTLS with an internal CA, SPIFFE URI SANs, `RequireAndVerifyClientCert`, and TLS 1.3.
2. JWT validation with the full check set, JWKS cached and refreshed in the background, and a refresh triggered by an unknown key id.
3. Token-to-workload binding: reject a token whose subject is inconsistent with the presenting workload's certificate identity.
4. Both auth interceptors sharing one function, over a fail-closed policy map, plus the reflection test asserting coverage.
5. Client-side per-RPC credentials with `RequireTransportSecurity() == true` and a background-refreshing token source.
6. Identity propagation to a downstream service, plus a token-exchange variant, with an audit log recording workload, subject and method for every call.
7. Streams capped below token validity, with a client that reconnects using a fresh token and a test asserting no gap.
8. Certificate hot-reload without restart, and a rehearsed rotation test: add the new CA to trust stores, issue from it, remove the old one — asserting zero failed requests throughout.

**Extensions.**
- Add object-level authorization in one handler and demonstrate that scope-level checks alone were insufficient.
- Add per-principal rate limiting (chapter 23) and show limits following the identity rather than the IP.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *Interceptors* (where enforcement lives, and the stream wrapper), *The Error Model* (`Unauthenticated` vs `PermissionDenied`), *grpc.NewClient, Transport Credentials & Connection Lifecycle* (the client side of TLS), *Unary Handlers* (object-level authorization), *Server-Side Streaming Handlers* (lifetime caps).

- **gRPC — Authentication guide** — grpc.io · *Intermediate* · TLS, mTLS, token-based auth and `PerRPCCredentials`, with Go examples. The primary reference for this chapter. <https://grpc.io/docs/guides/auth/>
- **grpc-go — credentials package** — gRPC Authors · *Intermediate* · `TransportCredentials`, `PerRPCCredentials`, `TLSInfo` and how to extract a verified peer identity. <https://pkg.go.dev/google.golang.org/grpc/credentials>
- **RFC 8725 — JSON Web Token Best Current Practices** — IETF · *Advanced* · the normative list of JWT pitfalls, including algorithm confusion and audience validation. Read before writing any verifier. <https://www.rfc-editor.org/rfc/rfc8725>
- **golang-jwt/jwt v5** — open source · *Intermediate* · the Go JWT library with `WithValidMethods`, `WithAudience`, `WithIssuer` and leeway options used here. <https://github.com/golang-jwt/jwt>
- **SPIFFE / SPIRE documentation** — CNCF · *Advanced* · workload identity via X.509 SVIDs with URI SANs, and automated issuance and rotation. <https://spiffe.io/docs/latest/spiffe-about/overview/>
- **RFC 8693 — OAuth 2.0 Token Exchange** — IETF · *Advanced* · the standard for exchanging a user token for a narrowly-scoped downstream token. <https://www.rfc-editor.org/rfc/rfc8693>
- **OWASP — Authentication and Authorization Cheat Sheets** — OWASP · *Intermediate* · the general failure modes this chapter's checks defend against. <https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html>
- **grpc-go examples — features/authentication and encryption** — gRPC Authors · *Beginner* · runnable TLS, mTLS and per-RPC credential examples. <https://github.com/grpc/grpc-go/tree/master/examples/features/encryption>

---

*gRPC with Go Handbook — chapter 24.*
