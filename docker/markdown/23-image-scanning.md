# 23 · Image Scanning & Supply-Chain Security

> **In one line:** Know exactly what's in your images and where it came from — scan for CVEs, generate an SBOM, sign and attest builds, and pin by digest — so a compromised dependency or registry can't silently ship into production.

---

## 1. Overview

Every container image is a stack of other people's software: a base OS, language runtimes, and dozens of transitive libraries. **Supply-chain security** is the discipline of proving *what* is inside an image (its ingredients), *whether* any of it has known vulnerabilities, and *that* it was built by you and hasn't been tampered with since. Attacks like SolarWinds, `event-stream`, and typosquatted packages showed that the build pipeline itself is a target.

The core loop is: **scan** images for CVEs (Docker Scout, Trivy, Grype) in CI and reject builds over a severity threshold; **generate an SBOM** (Software Bill of Materials) so you have a queryable inventory of every package and version; **sign** the image and **attach attestations** (SBOM + build provenance) with cosign so consumers can verify authenticity; and **pin base images by digest** so `FROM` can never resolve to a different, unreviewed image.

You reach for this the moment images leave a laptop — in CI, in a shared registry, and at deploy admission. The goal isn't zero CVEs (impossible); it's *knowing your exposure*, *patching fast*, and *being unforgeable*.

## 2. Core Concepts

- **CVE scanning** — matching the packages in an image against vulnerability databases (NVD, distro advisories, GitHub Advisory DB). Tools: **Docker Scout**, **Trivy**, **Grype**, Clair.
- **Base-image freshness** — most CVEs come from the base OS layer; rebuilding on an updated base (or a slim/distroless base) clears more than app-level fixes ever will.
- **SBOM (Software Bill of Materials)** — a machine-readable inventory of every component + version + license, in **SPDX** or **CycloneDX** format. Answers "am I affected by CVE-X?" in seconds instead of a re-scan.
- **Image signing** — a cryptographic signature over the image *digest* proving who published it. **cosign** (Sigstore) is the de-facto standard, with keyless signing via OIDC + the public transparency log **Rekor**.
- **Provenance / attestations** — signed statements *about* an image: how it was built (SLSA provenance — source repo, commit, builder), its SBOM, scan results. Attached to the image in the registry.
- **Pinning by digest** — referencing `image@sha256:…` instead of a mutable tag, so the exact bytes are immutable and tags can't be repointed under you.
- **Severity gating** — failing CI when a scan finds vulnerabilities at/above a threshold (e.g. `HIGH`/`CRITICAL` with a fix available), with an auditable exception process.
- **Admission verification** — the cluster (via policy-controller/Kyverno) refuses to run images that aren't signed by a trusted key and don't carry required attestations.

## 3. Syntax & Examples

**Scan an image for CVEs** — Trivy and Docker Scout:

```bash
trivy image --severity HIGH,CRITICAL --exit-code 1 myapp:1.0   # fail CI on High+
docker scout cves myapp:1.0                                     # CVE list
docker scout recommendations myapp:1.0                          # base-image upgrade advice
```

**Generate an SBOM** in CycloneDX or SPDX:

```bash
trivy image --format cyclonedx --output sbom.json myapp:1.0
syft myapp:1.0 -o spdx-json > sbom.spdx.json
# BuildKit can emit an SBOM at build time:
docker buildx build --sbom=true --provenance=true -t myapp:1.0 --push .
```

**Sign and attest with cosign** (keyless, using CI's OIDC identity):

```bash
cosign sign myregistry/myapp@sha256:abc123...          # signature -> Rekor log
cosign attest --predicate sbom.json --type cyclonedx myregistry/myapp@sha256:abc123...
cosign verify myregistry/myapp@sha256:abc123... \
  --certificate-identity-regexp '.*@myorg\.com' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

**Pin a base image by digest** in the Dockerfile:

```dockerfile
# tag is documentation; the digest is the contract
FROM python:3.12-slim@sha256:2b0a...e9f1
```

## 4. Worked Example

A CI pipeline that builds, scans, gates, and signs — the shape of a real workflow.

```bash
# 1. Build with provenance + SBOM attestations attached
docker buildx build --provenance=true --sbom=true -t reg/api:1.4 --push .

# 2. Capture the immutable digest for everything downstream
DIGEST=$(docker buildx imagetools inspect reg/api:1.4 --format '{{.Manifest.Digest}}')

# 3. Gate on vulnerabilities
trivy image --severity CRITICAL --exit-code 1 reg/api@$DIGEST

# 4. Sign the digest (keyless via CI OIDC)
cosign sign reg/api@$DIGEST
```

A realistic scan summary that the gate acts on:

```text
reg/api:1.4 (debian 12.5)
Total: 37 (CRITICAL: 1, HIGH: 6, MEDIUM: 22, LOW: 8)

┌────────────────┬────────────────┬──────────┬───────────────┬───────────────┐
│    Library     │ Vulnerability  │ Severity │ Installed Ver │  Fixed Ver    │
├────────────────┼────────────────┼──────────┼───────────────┼───────────────┤
│ libssl3        │ CVE-2024-xxxx  │ CRITICAL │ 3.0.11-1      │ 3.0.13-1      │  <- gate fails
│ libexpat1      │ CVE-2024-yyyy  │ HIGH     │ 2.5.0-1       │ 2.6.0-1       │
└────────────────┴────────────────┴──────────┴───────────────┴───────────────┘
```

The one `CRITICAL` has a fix available, so step 3 exits non-zero and the pipeline stops. The engineer bumps to `python:3.12-slim`'s newer digest (which ships patched `libssl3`), rebuilds, the scan passes, and cosign signs the clean digest. Deploy admission then verifies that signature and refuses anything unsigned.

## 5. Under the Hood

Scanning and signing operate on the **image digest** and store their outputs *alongside* the image in the registry as extra manifests, all cross-referenced by a transparency log.

```svg
<svg viewBox="0 0 640 360" width="100%" height="360" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="c" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="320" y="22" text-anchor="middle" fill="#1e293b" font-weight="700">Supply chain: from source to verified deploy</text>

  <rect x="30" y="46" width="120" height="46" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="90" y="67" text-anchor="middle" fill="#1e293b" font-weight="600">Source repo</text>
  <text x="90" y="84" text-anchor="middle" fill="#64748b">commit sha</text>

  <rect x="30" y="150" width="120" height="60" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="90" y="174" text-anchor="middle" fill="#1e293b" font-weight="600">CI build</text>
  <text x="90" y="192" text-anchor="middle" fill="#64748b">buildx +</text>
  <text x="90" y="205" text-anchor="middle" fill="#64748b">SBOM/provenance</text>

  <line x1="90" y1="92" x2="90" y2="148" stroke="#475569" marker-end="url(#c)"/>

  <!-- registry -->
  <rect x="230" y="46" width="180" height="230" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="320" y="68" text-anchor="middle" fill="#1e293b" font-weight="600">Registry (by digest)</text>
  <rect x="250" y="80" width="140" height="40" rx="8" fill="#fff" stroke="#059669"/>
  <text x="320" y="104" text-anchor="middle" fill="#1e293b">image @sha256:…</text>
  <rect x="250" y="128" width="140" height="34" rx="8" fill="#fff" stroke="#059669"/>
  <text x="320" y="149" text-anchor="middle" fill="#64748b">SBOM attestation</text>
  <rect x="250" y="170" width="140" height="34" rx="8" fill="#fff" stroke="#059669"/>
  <text x="320" y="191" text-anchor="middle" fill="#64748b">provenance (SLSA)</text>
  <rect x="250" y="212" width="140" height="34" rx="8" fill="#fff" stroke="#059669"/>
  <text x="320" y="233" text-anchor="middle" fill="#64748b">cosign signature</text>

  <line x1="150" y1="180" x2="228" y2="150" stroke="#475569" marker-end="url(#c)"/>

  <!-- rekor -->
  <rect x="250" y="300" width="140" height="42" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="320" y="321" text-anchor="middle" fill="#1e293b" font-weight="600">Rekor log</text>
  <text x="320" y="337" text-anchor="middle" fill="#64748b">public transparency</text>
  <line x1="320" y1="246" x2="320" y2="298" stroke="#475569" marker-end="url(#c)"/>

  <!-- verify/deploy -->
  <rect x="470" y="120" width="150" height="80" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="545" y="150" text-anchor="middle" fill="#1e293b" font-weight="600">Admission</text>
  <text x="545" y="168" text-anchor="middle" fill="#64748b">cosign verify</text>
  <text x="545" y="184" text-anchor="middle" fill="#64748b">reject if unsigned</text>
  <line x1="410" y1="160" x2="468" y2="160" stroke="#475569" marker-end="url(#c)"/>

  <rect x="470" y="230" width="150" height="46" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="545" y="257" text-anchor="middle" fill="#1e293b" font-weight="600">Deploy ✅ verified</text>
  <line x1="545" y1="200" x2="545" y2="228" stroke="#475569" marker-end="url(#c)"/>
</svg>
```

The image is content-addressed by its **`sha256` digest** — flip one byte and the digest changes, which is why pinning by digest is tamper-evident. Cosign signs the digest and records the signature (and the signing identity, via a short-lived OIDC cert) in **Rekor**, a public append-only transparency log, so a signature can't be quietly forged or backdated. SBOM and SLSA provenance are stored as separate attestation manifests referencing the same digest. At deploy, an admission controller runs `cosign verify` against the expected identity/issuer and required attestations, and rejects anything that doesn't match — closing the loop from source commit to running pod.

## 6. Variations & Trade-offs

| Concern | Tool / mechanism | Format | Notes |
|---|---|---|---|
| CVE scan (CLI/CI) | Trivy, Grype | table/JSON/SARIF | fast, offline DB option, `--exit-code` gating |
| CVE scan (integrated) | Docker Scout | UI + CLI | base-image *recommendations*, Docker-native |
| SBOM generation | Syft, Trivy, `buildx --sbom` | SPDX / CycloneDX | attach as attestation, not a loose file |
| Signing | cosign (Sigstore) | OCI signature | keyless (OIDC+Rekor) or key-pair |
| Provenance | `buildx --provenance`, SLSA | in-toto attestation | proves builder + source |
| Pinning | `@sha256:` digest | — | immutable; needs a bump workflow (Renovate) |
| Admission | Sigstore policy-controller, Kyverno | policy | verify signature + attestations at runtime |

**Trade-offs.** **Digest pinning** maximizes reproducibility and tamper-resistance but freezes you on an old base — pair it with **Renovate/Dependabot** to auto-open digest-bump PRs so pinning doesn't become "stale forever." **Keyless signing** removes key-management pain but depends on the public Sigstore/Rekor infrastructure and OIDC; regulated environments may prefer self-managed keys or a private Rekor. **Severity gating** must allow *auditable exceptions* (VEX statements / ignore files with expiry) or teams route around it. Scanning is only as current as its DB — a "clean" scan from last week can be dirty today.

## 7. Production / Performance Notes

- **Scan at three gates:** in CI (fail fast), in the registry (continuous re-scan as new CVEs land against *already-built* images), and at admission (verify signatures/attestations). Yesterday's clean image can be today's vulnerable one — the SBOM lets you answer "which running images contain `log4j`?" without rebuilding.
- **Fix at the base, not the leaf.** Most findings live in the OS layer; moving to **distroless** or slim bases and rebuilding on a fresh digest clears whole classes of CVEs and shrinks the surface. Docker Scout's *recommendations* surface the smallest upgrade that clears the most CVEs.
- **Cache the vuln DB** in CI (`trivy image --cache-dir`) — otherwise every job re-downloads the NVD feed. Layer-level caching also means only changed layers get re-scanned.
- **Make gating actionable.** Only fail on severities that have a **fix available**; a `CRITICAL` with no upstream patch just blocks everyone. Use VEX to record "not affected/not exploitable" with justification and expiry.
- **Sign the digest, deploy the digest.** Signatures are over the digest; if you deploy a mutable tag, you can be handed a *different* image than the one you verified. Resolve tag→digest once, then use the digest everywhere.
- **Provenance catches insider/pipeline compromise** that scanning can't — it proves the image came from *your* repo/commit via *your* builder, so a rogue image pushed straight to the registry fails verification even if it's CVE-clean.

## 8. Common Mistakes

1. ⚠️ **Scanning once at build and never again.** Fix: continuously re-scan registry images and keep SBOMs so new CVEs against old images are found.
2. ⚠️ **Chasing zero CVEs by ignoring severity/fix status.** Fix: gate on `HIGH/CRITICAL` *with fixes*; track the rest with VEX and expiry.
3. ⚠️ **Deploying a mutable tag after verifying a digest.** Fix: resolve to `@sha256:` and deploy that exact digest.
4. ⚠️ **Treating the SBOM as a one-off file in a bucket.** Fix: attach it as a signed attestation on the image so it travels with it and is verifiable.
5. ⚠️ **Signing but never verifying at admission.** Fix: enforce `cosign verify` via policy-controller/Kyverno so unsigned images are rejected.
6. ⚠️ **Pinning by digest and never updating.** Fix: automate digest bumps (Renovate) so pinned bases stay fresh.
7. ⚠️ **Fixing app deps while ignoring the base OS layer** that holds most CVEs. Fix: update/rebuild the base or switch to distroless.
8. ⚠️ **Trusting a "clean" scan as proof of safety.** Fix: scanning only covers *known* CVEs; add provenance/signing to cover tampering and unknowns.

## 9. Interview Questions

**Q: What is an SBOM and why does it matter?**
A: A Software Bill of Materials is a machine-readable inventory (SPDX or CycloneDX) of every component, version, and license in an image. It matters because when a new CVE drops you can query your stored SBOMs to instantly find every affected image — no rebuild or re-scan — turning incident response from days into minutes.

**Q: Why pin base images by digest instead of by tag?**
A: Tags are mutable — `python:3.12-slim` can be repushed to point at different bytes, so your build isn't reproducible and a compromised or changed base could slip in unreviewed. A digest (`@sha256:…`) is content-addressed and immutable; the exact bytes are fixed and tamper-evident. Pair it with an automated bump tool so it stays fresh.

**Q: What's the difference between signing and an SBOM/provenance attestation?**
A: A **signature** proves *who* published the image (authenticity/integrity of the digest). An **SBOM** describes *what's inside* it. **Provenance** describes *how it was built* (source repo, commit, builder — SLSA). Signing alone doesn't tell you the contents; attestations add verifiable metadata, and all three are anchored to the same digest.

**Q: How does keyless signing with cosign work?**
A: Cosign requests a short-lived certificate from Sigstore's Fulcio CA, binding your OIDC identity (e.g. a GitHub Actions token) to a signing key generated on the fly. It signs the image digest and records the signature and cert in **Rekor**, a public append-only transparency log. Verifiers check the signature against an expected identity and OIDC issuer — no long-lived private key to manage or leak.

**Q: What does "shift-left" and continuous scanning mean, and why both?**
A: Shift-left = scan in CI to fail bad builds before they ship. But CVE databases update constantly, so an image that passed last week may be vulnerable today. Continuous scanning re-evaluates already-built registry images against fresh advisories, and admission-time verification ensures only signed, gated images run. You need all stages because vulnerability is time-dependent.

**Q: Should CI fail on every vulnerability found? How do you avoid alert fatigue?** *(senior)*
A: No — gate on severity thresholds where a **fix is available** (typically HIGH/CRITICAL). For findings with no upstream patch or that aren't exploitable in your context, record a VEX statement or ignore entry with a justification and expiry date. This keeps the gate meaningful and auditable instead of a blanket blocker teams route around.

**Q: How does provenance protect against attacks that CVE scanning misses?** *(senior)*
A: Scanning only finds *known* vulnerabilities in *packages*. Provenance proves the image was built from a specific source commit by a specific trusted builder, so a malicious image pushed directly to the registry, or one built from a poisoned branch, fails verification even if it's CVE-clean. It defends the pipeline itself, which is where SolarWinds-class attacks live.

**Q: How do you enforce that only trusted images run in a cluster?** *(senior)*
A: Deploy an admission controller (Sigstore policy-controller, Kyverno, or Connaisseur) that runs `cosign verify` on every image, checking the signature against expected identities/issuers and requiring specific attestations (SBOM, provenance, passing scan). Unsigned or unverifiable images are rejected at the API server, and images are referenced by digest so the verified bytes are exactly what runs.

**Q: An old image in your registry just became vulnerable to a newly disclosed CVE. Walk through your response.**
A: Query stored SBOMs to find every image/service containing the affected package and version; identify which are running via digest inventory; check whether a fixed version exists; rebuild affected images on a patched base, re-scan, re-sign, and roll out by digest. If no fix exists, apply mitigations (network policy, WAF) and record a VEX/exception with expiry while tracking upstream.

## 10. Practice

- [ ] Scan an image with both Trivy and Docker Scout; compare their findings and run `docker scout recommendations` to see the smallest base upgrade that clears the most CVEs.
- [ ] Generate an SBOM with Syft in CycloneDX, then use it to answer "does this image contain OpenSSL, and which version?"
- [ ] Build with `docker buildx build --sbom=true --provenance=true` and inspect the attestations attached to the image.
- [ ] Sign an image digest with cosign keyless, then run `cosign verify` with the correct and an incorrect identity to see it pass/fail.
- [ ] Pin a Dockerfile `FROM` by digest, then configure Renovate/Dependabot to open automatic digest-bump PRs.

## 11. Cheat Sheet

> [!TIP]
> **Image Scanning & Supply-Chain Security** — know your ingredients, prove your build.
> - **Scan:** `trivy image --severity HIGH,CRITICAL --exit-code 1 img` · `docker scout cves img` — gate CI on fixable High/Critical.
> - **SBOM:** `syft img -o cyclonedx-json` or `buildx --sbom=true` — inventory for instant CVE lookups.
> - **Sign + attest:** `cosign sign img@sha256:…` (keyless via OIDC→Rekor); `cosign attest --predicate sbom.json`.
> - **Verify at admission:** `cosign verify` via policy-controller/Kyverno — reject unsigned images.
> - **Pin by digest:** `FROM base@sha256:…` + Renovate for auto-bumps.
> - Fix CVEs at the **base layer** (distroless/slim) — that's where most live.
> - Scan **continuously** (CI + registry + admission); a clean image can go vulnerable overnight.

**References:** Docker Scout docs, Aqua Trivy docs, Sigstore/cosign docs, SLSA framework (slsa.dev), CycloneDX & SPDX SBOM specs, OpenSSF Scorecard

---
*Docker Handbook — topic 23.*
