# 26 · Helm & Packaging

> **In one line:** Helm is the package manager for Kubernetes — it templates a bundle of manifests into a versioned, parameterized **chart**, installs it as a tracked **release**, and lets you upgrade and roll back atomically.

---

## 1. Overview

A real application is never one manifest. It's a Deployment, a Service, an Ingress, a ConfigMap, a couple of Secrets, an HPA, maybe an RBAC Role — a dozen YAML files that must move together and differ per environment (2 replicas in staging, 10 in prod; different hostnames, image tags, resource limits). Copy-pasting and hand-editing that YAML across environments is how drift and outages happen.

**Helm** solves this by treating those manifests as a **chart**: a versioned package of Go-templated YAML plus a `values.yaml` file of defaults. You install a chart into a cluster to produce a **release** — a named, revision-tracked instance — overriding values per environment. Because Helm records every revision, `helm upgrade` and `helm rollback` become single, atomic, reversible operations, and `helm diff` shows exactly what will change before you apply it.

You reach for Helm when you need to **package and share** an app (your own or third-party — Postgres, Prometheus, cert-manager all ship as charts), when you need **the same app across many environments** with different config, or when you want **release semantics**: install/upgrade/rollback/history as first-class verbs instead of `kubectl apply` and hope.

Helm 3 (current) is **client-only** — no in-cluster Tiller component. Release state lives in Secrets in the target namespace, and Helm talks to the API server with your kubeconfig credentials, so it inherits your RBAC.

## 2. Core Concepts

- **Chart** — the package: a directory (or `.tgz`) with `Chart.yaml` (name, version, appVersion), `values.yaml` (default config), a `templates/` dir of Go-templated manifests, and optional `charts/` (dependencies) and `crds/`.
- **Release** — one installed instance of a chart in a cluster, identified by a name (`myapp`) and namespace. Installing the same chart twice with different names gives two independent releases.
- **Values** — the parameters. Precedence, lowest to highest: chart `values.yaml` → parent chart values → `-f myvalues.yaml` files (left to right) → `--set key=val` on the CLI. Higher wins.
- **Templates** — files in `templates/` rendered with the **Go template** engine plus Sprig functions. `{{ .Values.x }}`, `{{ .Release.Name }}`, `{{ .Chart.Version }}` are the common built-in objects.
- **Revision** — each install/upgrade bumps an integer revision; `helm history` lists them and `helm rollback <name> <rev>` restores one. State is stored as a Secret named `sh.helm.release.v1.<name>.v<rev>`.
- **Repository** — an HTTP server (or OCI registry) hosting packaged charts and an `index.yaml`. `helm repo add`, `helm search`, `helm pull`.
- **Dependencies (subcharts)** — a chart can declare other charts in `Chart.yaml` `dependencies:`; `helm dependency update` vendors them into `charts/`. Subchart values are namespaced under the subchart's name.
- **Hooks** — annotated resources that run at lifecycle points (`pre-install`, `post-upgrade`, `pre-delete`) — e.g. a migration Job before an upgrade.
- **`helm template` vs `helm install`** — `template` renders manifests locally (client-side, no cluster); `install` renders *and* applies *and* records a release.

## 3. Syntax & Examples

**Scaffold and inspect a chart:**

```bash
helm create myapp            # generate a starter chart in ./myapp
helm lint myapp              # static-validate templates + values
helm template myapp          # render to stdout — no cluster needed
```

**Chart.yaml — the package metadata:**

```yaml
apiVersion: v2
name: myapp
version: 1.4.0          # the CHART version (bump on any chart change)
appVersion: "2.7.1"     # the APP version shipped (informational)
description: Acme web API
dependencies:
  - name: postgresql
    version: "15.x.x"
    repository: https://charts.bitnami.com/bitnami
    condition: postgresql.enabled   # toggle subchart via a value
```

**values.yaml — the defaults:**

```yaml
replicaCount: 2
image:
  repository: ghcr.io/acme/myapp
  tag: ""                # empty → template falls back to .Chart.AppVersion
resources:
  requests: { cpu: 100m, memory: 128Mi }
ingress:
  enabled: false
  host: myapp.example.com
```

**templates/deployment.yaml — the template:**

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "myapp.fullname" . }}
  labels: {{- include "myapp.labels" . | nindent 4 }}
spec:
  replicas: {{ .Values.replicaCount }}
  selector:
    matchLabels: {{- include "myapp.selectorLabels" . | nindent 6 }}
  template:
    metadata:
      labels: {{- include "myapp.selectorLabels" . | nindent 8 }}
    spec:
      containers:
        - name: {{ .Chart.Name }}
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}"
          resources: {{- toYaml .Values.resources | nindent 12 }}
```

**Conditionals, loops, and the `-` whitespace chomp:**

```yaml
{{- if .Values.ingress.enabled }}
apiVersion: networking.k8s.io/v1
kind: Ingress
# ...
  rules:
    {{- range .Values.ingress.hosts }}
    - host: {{ .host | quote }}
    {{- end }}
{{- end }}
```

## 4. Worked Example

Install to staging, override for prod, upgrade, then roll back a bad release.

```bash
# Install — creates release "web" in namespace staging (revision 1)
$ helm install web ./myapp -n staging --create-namespace \
    --set replicaCount=2 --set image.tag=2.7.1
NAME: web
LAST DEPLOYED: Thu Jul  3 10:02:11 2026
STATUS: deployed
REVISION: 1

# Preview a prod upgrade WITHOUT applying (helm-diff plugin)
$ helm diff upgrade web ./myapp -f prod-values.yaml
web, Deployment (apps) has changed:
-   replicas: 2
+   replicas: 10

# Ship it — atomic upgrade, auto-rollback if it fails to become ready
$ helm upgrade web ./myapp -f prod-values.yaml --atomic --timeout 5m
Release "web" has been upgraded. REVISION: 2

# A bad image tag went out — inspect history
$ helm history web
REVISION  STATUS      CHART       APP VERSION  DESCRIPTION
1         superseded  myapp-1.4.0 2.7.1        Install complete
2         deployed    myapp-1.4.0 2.7.2        Upgrade complete

# Roll back to the known-good revision 1 — instant, tracked
$ helm rollback web 1
Rollback was a success! Happy Helming!
```

`--atomic` makes the upgrade transactional: if the new pods never pass their readiness probes within `--timeout`, Helm automatically rolls the release back to the prior revision, so a botched deploy never leaves you half-migrated.

## 5. Under the Hood

Helm 3 is a **client-side templating engine plus a release ledger**. On `install`/`upgrade` it: (1) merges values by precedence, (2) renders every file in `templates/` through the Go/Sprig engine into concrete manifests, (3) runs any `pre-*` hooks, (4) applies the manifests via a three-way strategic merge against the API server, (5) waits (if `--wait`/`--atomic`) for resources to become ready, and (6) writes the rendered manifests as a **release Secret** (`sh.helm.release.v1.<name>.v<rev>`, gzipped) in the namespace. Rollback simply re-applies the manifests stored in an earlier release Secret.

```svg
<svg viewBox="0 0 760 320" width="100%" height="320" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="ah2" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="380" y="24" text-anchor="middle" fill="#1e293b" font-weight="700">helm install / upgrade pipeline</text>

  <rect x="20" y="55" width="130" height="70" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="85" y="82" text-anchor="middle" fill="#1e293b" font-weight="600">Chart</text>
  <text x="85" y="99" text-anchor="middle" fill="#64748b">templates/ +</text>
  <text x="85" y="114" text-anchor="middle" fill="#64748b">values.yaml</text>

  <rect x="190" y="55" width="130" height="70" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="255" y="76" text-anchor="middle" fill="#1e293b" font-weight="600">Merge values</text>
  <text x="255" y="93" text-anchor="middle" fill="#64748b">defaults → -f →</text>
  <text x="255" y="108" text-anchor="middle" fill="#64748b">--set (highest)</text>

  <rect x="360" y="55" width="130" height="70" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="425" y="76" text-anchor="middle" fill="#1e293b" font-weight="600">Render</text>
  <text x="425" y="93" text-anchor="middle" fill="#64748b">Go + Sprig</text>
  <text x="425" y="108" text-anchor="middle" fill="#64748b">→ manifests</text>

  <rect x="530" y="55" width="130" height="70" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="595" y="76" text-anchor="middle" fill="#1e293b" font-weight="600">Apply</text>
  <text x="595" y="93" text-anchor="middle" fill="#64748b">3-way merge</text>
  <text x="595" y="108" text-anchor="middle" fill="#64748b">→ API server</text>

  <line x1="150" y1="90" x2="186" y2="90" stroke="#475569" marker-end="url(#ah2)"/>
  <line x1="320" y1="90" x2="356" y2="90" stroke="#475569" marker-end="url(#ah2)"/>
  <line x1="490" y1="90" x2="526" y2="90" stroke="#475569" marker-end="url(#ah2)"/>

  <rect x="530" y="175" width="130" height="66" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="595" y="202" text-anchor="middle" fill="#1e293b" font-weight="600">Release Secret</text>
  <text x="595" y="219" text-anchor="middle" fill="#64748b">rev v1, v2, v3…</text>
  <text x="595" y="234" text-anchor="middle" fill="#64748b">(gzipped)</text>
  <line x1="595" y1="125" x2="595" y2="171" stroke="#475569" marker-end="url(#ah2)"/>
  <text x="672" y="152" fill="#64748b">record</text>

  <rect x="360" y="175" width="130" height="66" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="425" y="205" text-anchor="middle" fill="#1e293b" font-weight="600">rollback</text>
  <text x="425" y="223" text-anchor="middle" fill="#64748b">re-apply rev N</text>
  <line x1="530" y1="208" x2="494" y2="208" stroke="#475569" marker-end="url(#ah2)"/>

  <text x="380" y="285" text-anchor="middle" fill="#64748b" font-style="italic">--atomic: if new pods never become Ready within --timeout, auto-rollback to previous revision</text>
  <text x="380" y="305" text-anchor="middle" fill="#64748b" font-style="italic">helm template = steps 1–3 only (local render, no cluster)</text>
</svg>
```

Because rendering is local, `helm template` and `helm diff` are safe, cluster-free ways to see exactly what Helm will produce — invaluable in CI and code review.

## 6. Variations & Trade-offs

| | **Helm** | **Kustomize** | **Raw `kubectl apply`** |
|---|---|---|---|
| Model | template + values | patch/overlay a base | static YAML |
| Parameterize | Go templating, any value | strategic merge + JSON patches | none |
| Packaging/share | charts + repos/OCI | no packaging | none |
| Release tracking | revisions, rollback, history | none (built into kubectl) | none |
| Logic (if/range) | yes | no (declarative only) | no |
| Learning curve | template syntax, whitespace | overlay mental model | trivial |

**Helm vs Kustomize** is the classic debate. Kustomize (built into `kubectl -k`) is *template-free*: you keep a plain-YAML base and apply overlays/patches per environment — no Go templating, no `{{ }}`, easier to read and reason about, but no conditionals, no packaging, no rollback. Helm gives you real logic, third-party chart distribution, and release semantics, at the cost of template complexity and whitespace pain. Many teams use **both**: Helm to install third-party charts, Kustomize for their own in-house manifests — or `helm template | kustomize` to post-render a chart.

## 7. Production / Performance Notes

- **Pin chart *and* app versions.** Bump `Chart.yaml` `version` on every chart change and `appVersion` on every image change; never deploy from a floating `latest`.
- **`--atomic --timeout` on every upgrade** so a failed rollout auto-reverts instead of stranding you between revisions. Pair with good readiness probes — atomic relies on them.
- **`helm diff upgrade` in CI** (helm-diff plugin) as a required review artifact — it turns "trust me" deploys into reviewable change sets.
- **Keep secrets out of `values.yaml` in git.** Use `helm secrets` (SOPS), External Secrets Operator, or a Secrets manager; committing plaintext secrets is the most common Helm leak.
- **Watch release Secret size.** Large charts with many revisions bloat etcd; set `--history-max` (default 10) to cap retained revisions.
- **`helm upgrade --install`** (idempotent) is the GitOps-friendly form — installs if absent, upgrades if present, so pipelines don't branch on existence.
- **Render, don't guess:** `helm template --debug` and `helm get manifest <release>` show exactly what was/ will be applied when a template misbehaves.

## 8. Common Mistakes

1. ⚠️ **Confusing `version` with `appVersion`.** `version` is the chart's version (bump on template changes); `appVersion` is the shipped app image version. *Fix:* bump `version` on *any* chart edit, independently of the app.
2. ⚠️ **Whitespace/indent errors from templates.** Forgetting `nindent`/`-` chomps produces invalid YAML. *Fix:* use `{{- toYaml .Values.x | nindent N }}` and validate with `helm lint` + `helm template`.
3. ⚠️ **`--set` type surprises.** `--set replicas=3` may be read as a string, and commas/dots need escaping. *Fix:* prefer `-f values-file.yaml`; use `--set-string` / `--set-json` when types matter.
4. ⚠️ **Editing live resources with `kubectl edit` after a Helm install.** The next `helm upgrade` overwrites your change via three-way merge. *Fix:* change values and re-`helm upgrade`; treat the chart as source of truth.
5. ⚠️ **Committing plaintext secrets to `values.yaml`.** *Fix:* SOPS/`helm secrets`, External Secrets, or reference existing Secrets by name.
6. ⚠️ **No readiness probes but relying on `--atomic`/`--wait`.** Helm can't detect a bad rollout without probes, so it reports success on a broken deploy. *Fix:* define real readiness probes.
7. ⚠️ **Unbounded revision history.** Hundreds of retained release Secrets bloat etcd. *Fix:* `--history-max 10` (or lower).
8. ⚠️ **Forgetting `helm dependency update` before install.** Subcharts declared in `Chart.yaml` aren't fetched automatically. *Fix:* run `helm dependency update` (or `build`) so `charts/` is populated.

## 9. Interview Questions

**Q: What problem does Helm solve that plain `kubectl apply` does not?**
A: Parameterization, packaging, and release lifecycle. Helm templates a bundle of manifests so one chart serves many environments via values; it packages that bundle as a versioned, shareable chart (its own or third-party); and it gives you release semantics — install, upgrade, rollback, and history as tracked, atomic operations — which raw `kubectl apply` has no notion of.

**Q: What is a chart, a release, and a revision?**
A: A chart is the package — templates plus default values plus metadata. A release is one installed instance of a chart in a cluster, identified by name and namespace; installing the same chart twice with different names creates two independent releases. A revision is an integer version of a release, bumped on each install/upgrade, enabling `helm history` and `helm rollback`.

**Q: Explain Helm's value precedence.**
A: From lowest to highest: the chart's own `values.yaml`, then a parent chart's values for a subchart, then `-f`/`--values` files applied left to right, then `--set`/`--set-string`/`--set-json` on the command line. Higher-precedence sources override lower ones key by key via a deep merge, so a single `--set` can override one field without touching the rest.

**Q: How do `helm template` and `helm install` differ?**
A: `helm template` renders the chart's manifests locally using the template engine and prints them — no cluster contact, no release recorded. `helm install` does the same render but then applies the manifests to the cluster and records a release Secret. `template` is ideal for CI validation, code review, and diffing; `install` actually deploys.

**Q: How does `helm rollback` work under the hood?**
A: Every install/upgrade stores the fully-rendered manifests of that revision as a gzipped Secret (`sh.helm.release.v1.<name>.v<rev>`) in the release namespace. `helm rollback <name> <rev>` reads the manifests from that earlier revision's Secret and re-applies them via a three-way merge, then records the rollback as a new revision. It's fast and reliable because the exact prior state was persisted.

**Q: What does `--atomic` do and what does it depend on? (senior)**
A: `--atomic` makes an upgrade transactional: Helm waits for the new resources to become ready, and if they don't within `--timeout`, it automatically rolls the release back to the previous revision. It depends on accurate readiness probes — without them Helm can't tell a healthy rollout from a broken one and will report success on a failed deploy.

**Q: Compare Helm and Kustomize — when would you choose each? (senior)**
A: Kustomize is template-free: a plain-YAML base plus per-environment overlay patches, built into kubectl, easy to read, but with no conditionals, packaging, or rollback. Helm offers real templating logic, third-party chart distribution, and release/rollback semantics, at the cost of template and whitespace complexity. Choose Kustomize for your own straightforward manifests where readability matters; choose Helm to consume third-party apps and when you need release lifecycle. Many teams use both.

**Q: How do chart dependencies (subcharts) work, and how are their values set? (senior)**
A: A chart declares dependencies in `Chart.yaml`; `helm dependency update` fetches them into `charts/`. On install they're rendered together. A subchart's values are namespaced under the subchart's name in the parent's values (e.g. `postgresql.auth.password`), and `condition`/`tags` toggle whether a subchart is enabled. Global values under `global:` are shared across all subcharts.

**Q: Helm 3 removed Tiller — what changed security-wise?**
A: Helm 2's Tiller was an in-cluster server that clients talked to; it often ran with broad permissions, becoming a privilege-escalation vector. Helm 3 is client-only: it talks to the API server directly with your kubeconfig, so it inherits your RBAC — you can only do what your credentials allow. Release state moved from Tiller to Secrets in the target namespace.

**Q: Where and how should secrets be handled in Helm charts?**
A: Never as plaintext in a committed `values.yaml`. Options: `helm secrets` with SOPS to encrypt values in git, the External Secrets Operator to sync from a real secrets manager, or referencing pre-existing Kubernetes Secrets by name in templates. The chart should template references to secrets, not embed their contents.

**Q: Someone `kubectl edit`ed a live Deployment that Helm manages. What happens on the next upgrade?**
A: Helm applies via a three-way strategic merge — it compares the last-applied (from the release Secret), the current live state, and the newly rendered manifest. Fields the chart manages will be reconciled back to the chart's values, silently reverting the manual edit. The correct workflow is to change the chart's values and `helm upgrade`, keeping the chart as the single source of truth.

## 10. Practice

- [ ] `helm create` a chart, then `helm template` it and read the generated Deployment/Service to understand the default scaffolding.
- [ ] Install a release with `-f staging.yaml`, upgrade it with `-f prod.yaml` using `--atomic`, then `helm history` and `helm rollback` to revision 1.
- [ ] Add the Bitnami PostgreSQL chart as a dependency, `helm dependency update`, and toggle it on/off with a `condition` value.
- [ ] Break a template's indentation on purpose and use `helm lint` + `helm template --debug` to locate and fix it.
- [ ] Reproduce the same app with Kustomize base+overlay and compare the developer experience with the Helm version.

## 11. Cheat Sheet

> [!TIP]
> **Chart** = package (templates + values). **Release** = installed instance. **Revision** = version of a release (rollback-able).
> - `helm create` · `helm lint` · `helm template` (local render) · `helm install <name> ./chart -n ns` · `helm upgrade --install --atomic --timeout 5m` · `helm rollback <name> <rev>` · `helm history <name>`.
> - **Values precedence:** chart `values.yaml` < parent < `-f` files (L→R) < `--set`. Prefer `-f` over `--set`.
> - **version** = chart version (bump on template change) · **appVersion** = shipped image version.
> - Template with `{{ .Values.x }}`, `{{ .Release.Name }}`; use `{{- toYaml … | nindent N }}` to avoid whitespace bugs.
> - `--atomic` needs readiness probes. State lives in `sh.helm.release.v1.<name>.v<rev>` Secrets; cap with `--history-max`.
> - **Helm vs Kustomize:** Helm = templating + packaging + rollback; Kustomize = template-free overlays. Use both where each fits.

**References:** Helm docs — "Charts", "Chart Template Guide", "Helm Commands"; Kustomize docs; Bitnami charts repository.

---
*Kubernetes Handbook — topic 26.*
