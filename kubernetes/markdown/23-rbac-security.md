# 23 · RBAC & Pod Security

> **In one line:** Control *who can do what* to the API with Roles and bindings, and *what a running container is allowed to do* with securityContext and Pod Security Admission — two independent layers that together enforce least privilege.

---

## 1. Overview

Kubernetes security splits into two questions that are easy to conflate but live in completely different places. First: **who is allowed to call the API server, and for which verbs on which resources?** That is **RBAC** — Role-Based Access Control — enforced by an authorization module in the API server. Second: **once a Pod is running on a node, what is it allowed to do to that node and to the kernel?** That is the **securityContext** on the pod/container plus **Pod Security Admission**, enforced at admission time and by the kubelet/container runtime.

RBAC answers *"can this ServiceAccount create Deployments in namespace `prod`?"* Pod security answers *"can this container run as root, mount the host filesystem, or gain `CAP_SYS_ADMIN`?"* A cluster that gets RBAC right but lets every pod run privileged is still one container escape away from a compromised node. You need both.

You reach for this on day one of any shared or production cluster. The default `ServiceAccount` mounted into every pod should be able to do almost nothing; humans and CI systems should get narrowly-scoped Roles; and every workload should declare a hardened `securityContext` so that a bug in the app can't be leveraged into a node takeover.

The guiding principle throughout is **least privilege**: grant the smallest set of verbs, on the smallest set of resources, in the smallest scope, for the shortest identity — and deny everything else by default.

## 2. Core Concepts

- **Subjects** — the identities RBAC grants to: **Users** and **Groups** (external, from certs/OIDC — Kubernetes has no user database) and **ServiceAccounts** (in-cluster identities, namespaced objects that pods authenticate as via a mounted token).
- **Role vs ClusterRole** — a **Role** is namespaced and grants verbs on resources *within one namespace*; a **ClusterRole** is cluster-scoped and can grant access to cluster-scoped resources (nodes, PVs), to namespaced resources across *all* namespaces, or to non-resource URLs (`/healthz`).
- **RoleBinding vs ClusterRoleBinding** — a **RoleBinding** grants a Role *or a ClusterRole* to subjects **within one namespace**; a **ClusterRoleBinding** grants a ClusterRole across the **whole cluster**. Reusing a ClusterRole via a RoleBinding is the common "define once, grant per-namespace" pattern.
- **Rules are purely additive** — RBAC is **default-deny** with no "deny" rules. Effective permissions are the union of every binding a subject matches. To remove access you delete a binding, never add an exclusion.
- **verbs / resources / apiGroups** — a rule is the triple `apiGroups × resources × verbs` (e.g. `apps` × `deployments` × `[get,list,watch]`), optionally narrowed by `resourceNames`.
- **ServiceAccount token projection** — modern clusters mount a short-lived, audience-bound **projected** token (auto-rotated, expires) instead of a permanent Secret. Set `automountServiceAccountToken: false` when a pod needs no API access.
- **securityContext** — pod- and container-level settings that constrain the process: `runAsNonRoot`, `runAsUser`, `readOnlyRootFilesystem`, `allowPrivilegeEscalation`, `capabilities.drop`, `seccompProfile`.
- **Pod Security Admission (PSA)** — the built-in admission controller (GA in 1.25, replacing PodSecurityPolicy) that enforces the three **Pod Security Standards** — `privileged`, `baseline`, `restricted` — per namespace via labels, in `enforce` / `audit` / `warn` modes.

## 3. Syntax & Examples

**A namespaced Role — read-only on pods and their logs:**

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  namespace: prod
  name: pod-reader
rules:
  - apiGroups: [""]                       # "" = the core API group
    resources: ["pods", "pods/log"]
    verbs: ["get", "list", "watch"]
```

**Bind it to a ServiceAccount in that namespace:**

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  namespace: prod
  name: read-pods
subjects:
  - kind: ServiceAccount
    name: log-collector
    namespace: prod
roleRef:
  kind: Role
  name: pod-reader
  apiGroup: rbac.authorization.k8s.io
```

**A ClusterRole reused per-namespace via a RoleBinding** — the deployer only in `prod`:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole                          # defined once, cluster-wide
metadata: { name: deployer }
rules:
  - apiGroups: ["apps"]
    resources: ["deployments", "replicasets"]
    verbs: ["get", "list", "watch", "create", "update", "patch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding                          # but granted ONLY in prod
metadata: { name: deploy-prod, namespace: prod }
subjects:
  - { kind: ServiceAccount, name: ci-bot, namespace: cicd }
roleRef: { kind: ClusterRole, name: deployer, apiGroup: rbac.authorization.k8s.io }
```

**A dedicated ServiceAccount for a workload (never use `default`):**

```yaml
apiVersion: v1
kind: ServiceAccount
metadata: { name: log-collector, namespace: prod }
automountServiceAccountToken: true         # false if the pod needs no API access
```

**A hardened container securityContext:**

```yaml
spec:
  securityContext:                         # pod-level: applies to all containers
    runAsNonRoot: true
    runAsUser: 10001
    fsGroup: 10001
    seccompProfile: { type: RuntimeDefault }
  containers:
    - name: app
      image: ghcr.io/acme/app:1.0
      securityContext:                     # container-level: overrides/refines
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities:
          drop: ["ALL"]                    # drop every Linux capability
```

**Enforce the `restricted` standard on a namespace:**

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: prod
  labels:
    pod-security.kubernetes.io/enforce: restricted   # reject non-conforming pods
    pod-security.kubernetes.io/enforce-version: latest
    pod-security.kubernetes.io/warn: restricted      # also warn on kubectl apply
    pod-security.kubernetes.io/audit: restricted      # and record in audit log
```

## 4. Worked Example

Goal: give a `log-collector` ServiceAccount read-only pod access in `prod`, then prove the permission boundary with `kubectl auth can-i`.

```bash
# 1. Create SA, Role, RoleBinding
$ kubectl apply -f sa.yaml -f role.yaml -f rolebinding.yaml
serviceaccount/log-collector created
role.rbac.authorization.k8s.io/pod-reader created
rolebinding.rbac.authorization.k8s.io/read-pods created

# 2. Test as the ServiceAccount (impersonation) — allowed verbs
$ kubectl auth can-i list pods -n prod \
    --as=system:serviceaccount:prod:log-collector
yes

# 3. Test a verb it should NOT have
$ kubectl auth can-i delete pods -n prod \
    --as=system:serviceaccount:prod:log-collector
no

# 4. Test cross-namespace — Role is namespaced, so denied elsewhere
$ kubectl auth can-i list pods -n kube-system \
    --as=system:serviceaccount:prod:log-collector
no
```

Now confirm Pod Security Admission rejects an unhardened pod in the `restricted` namespace:

```text
$ kubectl -n prod run bad --image=nginx --privileged
Error from server (Forbidden): pods "bad" is forbidden: violates PodSecurity
"restricted:latest": privileged (container "bad" must not set
securityContext.privileged=true), allowPrivilegeEscalation != false,
unrestricted capabilities (must drop "ALL"), runAsNonRoot != true,
seccompProfile (must be "RuntimeDefault" or "Localhost")
```

The single `enforce: restricted` label rejected five distinct violations before the pod ever reached a node.

## 5. Under the Hood

Every API request flows through three gates in order: **authentication** (who are you? — cert, token, OIDC), **authorization** (are you allowed? — RBAC evaluates every Role/ClusterRole bound to your subject and returns allow if *any* rule matches), then **admission** (mutating + validating webhooks, including Pod Security Admission). RBAC is default-deny: if no rule grants the verb, the request is rejected with `403 Forbidden`. Pod security then runs at admission — after authorization but before the object is persisted — so a hardened namespace rejects a bad pod regardless of who submitted it.

```svg
<svg viewBox="0 0 760 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="ah" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="380" y="24" text-anchor="middle" fill="#1e293b" font-weight="700">API request lifecycle — two security layers</text>

  <rect x="20" y="60" width="120" height="54" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="80" y="83" text-anchor="middle" fill="#1e293b" font-weight="600">kubectl /</text>
  <text x="80" y="100" text-anchor="middle" fill="#64748b">ServiceAccount</text>

  <rect x="180" y="60" width="120" height="54" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="240" y="83" text-anchor="middle" fill="#1e293b" font-weight="600">AuthN</text>
  <text x="240" y="100" text-anchor="middle" fill="#64748b">who are you?</text>

  <rect x="340" y="60" width="120" height="54" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="400" y="80" text-anchor="middle" fill="#1e293b" font-weight="600">AuthZ · RBAC</text>
  <text x="400" y="97" text-anchor="middle" fill="#64748b">Role + binding</text>
  <text x="400" y="110" text-anchor="middle" fill="#64748b">= verb allowed?</text>

  <rect x="500" y="60" width="130" height="54" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="565" y="80" text-anchor="middle" fill="#1e293b" font-weight="600">Admission · PSA</text>
  <text x="565" y="97" text-anchor="middle" fill="#64748b">securityContext</text>
  <text x="565" y="110" text-anchor="middle" fill="#64748b">vs standard?</text>

  <rect x="660" y="60" width="80" height="54" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="700" y="90" text-anchor="middle" fill="#1e293b" font-weight="600">etcd</text>
  <text x="700" y="105" text-anchor="middle" fill="#64748b">stored</text>

  <line x1="140" y1="87" x2="176" y2="87" stroke="#475569" marker-end="url(#ah)"/>
  <line x1="300" y1="87" x2="336" y2="87" stroke="#475569" marker-end="url(#ah)"/>
  <line x1="460" y1="87" x2="496" y2="87" stroke="#475569" marker-end="url(#ah)"/>
  <line x1="630" y1="87" x2="656" y2="87" stroke="#475569" marker-end="url(#ah)"/>

  <text x="400" y="150" text-anchor="middle" fill="#b91c1c" font-weight="600">403 Forbidden ← no matching RBAC rule (default deny)</text>
  <text x="565" y="172" text-anchor="middle" fill="#b91c1c" font-weight="600">Forbidden ← violates restricted standard</text>

  <rect x="60" y="205" width="640" height="70" rx="8" fill="#f8fafc" stroke="#475569" stroke-dasharray="4 3"/>
  <text x="380" y="228" text-anchor="middle" fill="#1e293b" font-weight="600">securityContext (enforced by kubelet + container runtime at runtime)</text>
  <text x="380" y="248" text-anchor="middle" fill="#64748b">runAsNonRoot · readOnlyRootFilesystem · allowPrivilegeEscalation:false</text>
  <text x="380" y="265" text-anchor="middle" fill="#64748b">capabilities.drop:[ALL] · seccompProfile:RuntimeDefault</text>
</svg>
```

RBAC objects are just watched API resources — the API server keeps them cached and evaluates authorization in-memory, so it is fast even with thousands of rules. Pod Security Admission is *not* configurable per-rule like the old PodSecurityPolicy; it applies one of three fixed, versioned standards, which is precisely why it is simpler and harder to misconfigure.

## 6. Variations & Trade-offs

| Mechanism | Scope | Enforces | When to use |
|---|---|---|---|
| **Role + RoleBinding** | one namespace | API verbs | per-team, per-namespace access |
| **ClusterRole + ClusterRoleBinding** | whole cluster | API verbs | cluster admins, node/PV access, operators |
| **ClusterRole + RoleBinding** | one namespace | API verbs | define once, grant per-namespace |
| **securityContext** | pod / container | runtime privileges | every workload — always set it |
| **Pod Security Admission** | namespace | pod hardening | guardrail: reject unhardened pods |
| **OPA Gatekeeper / Kyverno** | cluster (policy) | arbitrary policy | when the 3 fixed PSA standards aren't enough |

PSA is deliberately coarse — three standards, no custom rules. When you need "images only from our registry" or "every pod must have a cost-center label," you layer a **policy engine** (Kyverno, OPA Gatekeeper) on top; PSA handles the security baseline, the policy engine handles org-specific rules. Prefer PSA first because it ships built-in with zero extra components.

For RBAC, the frequent choice is **aggregated ClusterRoles** (using `aggregationRule` with label selectors) so you can extend the built-in `view`/`edit`/`admin` roles with your CRD's verbs without editing them.

## 7. Production / Performance Notes

- **Never grant `cluster-admin` to a ServiceAccount.** A leaked token then owns the cluster. Scope CI bots to exactly the namespaces and verbs they deploy to.
- **Audit wildcards.** `verbs: ["*"]`, `resources: ["*"]`, or `apiGroups: ["*"]` in a bound ClusterRole is a red flag. Run `kubectl get clusterrolebindings -o wide` and review who has broad grants.
- **Disable `automountServiceAccountToken`** on pods that never call the API — most stateless web apps don't. It removes an attacker's easiest pivot.
- **Escalation guardrails:** RBAC prevents privilege *escalation* — you can't `create`/`bind` a Role granting verbs you don't already hold, unless you have the `escalate`/`bind` verb. Don't grant those loosely.
- **Roll PSA out in stages:** set `warn` + `audit` to `restricted` first, watch the audit log for violations, fix workloads, *then* flip `enforce`. Flipping enforce blind will break running deploys.
- **`readOnlyRootFilesystem: true`** breaks apps that scribble to `/tmp` or `/var`. Mount an `emptyDir` at those paths rather than dropping the setting.
- **Use `kubectl auth can-i --list`** as any subject to see its full effective permission set — the fastest way to review least-privilege.

## 8. Common Mistakes

1. ⚠️ **Binding to the `default` ServiceAccount.** Every pod without an explicit SA uses `default`; granting it permissions leaks them to unrelated workloads. *Fix:* one dedicated SA per workload, `default` stays powerless.
2. ⚠️ **Using a ClusterRoleBinding when a RoleBinding would do.** This grants the ClusterRole in *every* namespace. *Fix:* bind the ClusterRole with a namespaced RoleBinding to scope it.
3. ⚠️ **Wildcard verbs "just to make it work."** `verbs: ["*"]` in prod is a standing incident. *Fix:* enumerate the exact verbs; `kubectl auth can-i` to verify.
4. ⚠️ **Forgetting `runAsNonRoot`, so the container runs as UID 0.** A container escape then lands as root on the node. *Fix:* set `runAsNonRoot: true` + a non-zero `runAsUser`, and build images with a non-root `USER`.
5. ⚠️ **Setting only pod-level securityContext and expecting `capabilities` to apply.** `capabilities` and `readOnlyRootFilesystem` are **container-level only** — pod-level is ignored for them. *Fix:* put them under the container's `securityContext`.
6. ⚠️ **Enabling PSA `enforce: restricted` cluster-wide overnight.** It rejects every non-conforming existing pod on the next reschedule. *Fix:* `warn`/`audit` first, remediate, then `enforce`.
7. ⚠️ **Confusing authentication with authorization.** A valid token that RBAC doesn't grant still gets `403`. *Fix:* a `403` means "add a Role"; a `401` means "fix the credential."
8. ⚠️ **Leaving `allowPrivilegeEscalation` unset (defaults to true for non-root under some setups).** setuid binaries can then gain privileges. *Fix:* always set `allowPrivilegeEscalation: false`.

## 9. Interview Questions

**Q: What is the difference between a Role and a ClusterRole, and between a RoleBinding and a ClusterRoleBinding?**
A: A Role is namespaced and grants verbs on resources within one namespace; a ClusterRole is cluster-scoped and can grant access to cluster-scoped resources, to namespaced resources across all namespaces, or to non-resource URLs. A RoleBinding grants a Role (or a ClusterRole) to subjects within one namespace; a ClusterRoleBinding grants a ClusterRole across the entire cluster. The common pattern is defining a ClusterRole once and binding it per-namespace with a RoleBinding.

**Q: Kubernetes RBAC has no deny rules — how do you take away a permission?**
A: RBAC is purely additive and default-deny. Effective permissions are the union of all rules from all bindings a subject matches. You cannot write a deny; you remove access by deleting or narrowing the binding/Role that grants it. If you need true deny semantics you use an external policy engine like OPA Gatekeeper or Kyverno.

**Q: A pod uses the `default` ServiceAccount and can suddenly list secrets cluster-wide. What likely happened?**
A: Someone created a ClusterRoleBinding (or a RoleBinding to a powerful ClusterRole) targeting the `default` SA, or bound a broad role in that namespace to `default`. Because every pod without an explicit `serviceAccountName` runs as `default`, the permission leaked to all such pods. Fix: give each workload a dedicated SA and keep `default` unprivileged.

**Q: What does `runAsNonRoot: true` actually enforce, and how is it different from `runAsUser: 1000`?**
A: `runAsNonRoot: true` tells the kubelet to refuse to start the container if its effective user is UID 0 — it's a validation guard, checked at container start. `runAsUser: 1000` sets the UID explicitly. They complement each other: `runAsUser` picks the identity, `runAsNonRoot` is a fail-safe that blocks the pod if an image somehow still resolves to root (e.g. no `USER` in the Dockerfile and no runAsUser). Best practice is to set both.

**Q: Why drop all capabilities and add back only what's needed, rather than leaving defaults?**
A: Containers start with a default set of Linux capabilities (NET_BIND_SERVICE, CHOWN, SETUID, etc.) that most apps never use but an attacker can. `drop: ["ALL"]` then `add: [...]` follows least privilege — you grant only the specific kernel capability the workload requires (e.g. NET_BIND_SERVICE to bind port 80). It shrinks the kernel attack surface available after a compromise.

**Q: What is Pod Security Admission and how does it relate to the deprecated PodSecurityPolicy?**
A: PSA is the built-in admission controller (GA in 1.25) that replaced PodSecurityPolicy. It enforces one of three fixed Pod Security Standards — privileged, baseline, restricted — per namespace via labels, in enforce/audit/warn modes. Unlike PSP it isn't itself an RBAC-gated resource with ordering pitfalls; it's simpler and versioned, but also less flexible — for custom rules you add Kyverno or Gatekeeper.

**Q: How would you safely roll out `restricted` Pod Security to an existing production namespace? (senior)**
A: Never flip `enforce` first — it rejects every non-conforming pod on the next reschedule. Set `warn` and `audit` to `restricted` to surface violations via kubectl warnings and the audit log without blocking. Fix each workload's securityContext, verify no audit violations remain, then set `enforce: restricted`. Pin `enforce-version` so a cluster upgrade doesn't silently tighten the standard under you.

**Q: What is `readOnlyRootFilesystem` and what breaks when you enable it? (senior)**
A: It mounts the container's root filesystem read-only, so a compromised process can't modify binaries or drop persistence. It breaks apps that write to paths like `/tmp`, `/var/run`, or a cache dir. The fix is to mount writable `emptyDir` volumes at exactly those paths, keeping the rest of the filesystem immutable. It's one of the highest-value, lowest-cost hardening settings.

**Q: How does RBAC prevent a user from granting themselves more power than they have? (senior)**
A: Two guardrails. Privilege *escalation prevention*: you can't create or update a Role/ClusterRole containing verbs/resources you don't already possess, unless you hold the special `escalate` verb. And *binding restriction*: you can't create a binding to a Role unless you already have its permissions or hold the `bind` verb on it. This stops a namespace-admin from minting a cluster-admin role and binding it to themselves.

**Q: A ServiceAccount token was leaked. What's your blast-radius assessment and response?**
A: First, `kubectl auth can-i --list --as=system:serviceaccount:<ns>:<sa>` to enumerate exactly what the token can do — that's the blast radius. If it's scoped tightly (the goal), impact is limited to those verbs/namespace. Response: delete the SA's token secret / rotate (projected tokens auto-expire, which is why they're preferred), review audit logs for actions taken with it, and tighten the binding. Long-term: `automountServiceAccountToken: false` where the API isn't needed.

**Q: When do you choose a policy engine (Kyverno/Gatekeeper) over Pod Security Admission?**
A: PSA only enforces the three fixed security standards — it can't express org-specific rules. Reach for a policy engine when you need custom constraints: allowed image registries, required labels/annotations, disallowed hostPaths beyond the standard, mutation (inject sidecars/defaults), or generation of resources. Common pattern: PSA for the security baseline plus Kyverno for governance policy.

## 10. Practice

- [ ] Create a namespaced Role granting `get/list/watch` on `configmaps`, bind it to a new ServiceAccount, and prove the boundary with `kubectl auth can-i` (allowed and denied verbs).
- [ ] Define a ClusterRole and grant it in only two namespaces using two RoleBindings; confirm access is denied in a third.
- [ ] Harden a Deployment: add `runAsNonRoot`, `readOnlyRootFilesystem`, `drop: ["ALL"]`, and an `emptyDir` mounted at `/tmp`; verify the app still starts.
- [ ] Label a namespace `enforce: restricted` and try to run a `--privileged` pod; read and interpret the rejection message.
- [ ] Run `kubectl auth can-i --list --as=system:serviceaccount:default:default` and confirm the default SA is effectively powerless.

## 11. Cheat Sheet

> [!TIP]
> **RBAC** = who can call the API. **securityContext + PSA** = what a running pod can do. Both default-deny; both required.
> - **Role/RoleBinding** = one namespace · **ClusterRole/ClusterRoleBinding** = whole cluster · ClusterRole + RoleBinding = define once, grant per-ns.
> - Rules are additive, no deny. Remove access by deleting bindings. `kubectl auth can-i <verb> <res> --as=…` to test; `--list` to enumerate.
> - One dedicated **ServiceAccount** per workload; keep `default` powerless; `automountServiceAccountToken: false` when no API access needed.
> - Every pod: `runAsNonRoot: true`, `runAsUser: <non-zero>`, `allowPrivilegeEscalation: false`, `readOnlyRootFilesystem: true`, `capabilities.drop: ["ALL"]`, `seccompProfile: RuntimeDefault`.
> - `capabilities` + `readOnlyRootFilesystem` are **container-level only**. PSA standards: privileged / baseline / **restricted**; roll out `warn`+`audit` → fix → `enforce`.

**References:** Kubernetes docs — "Using RBAC Authorization", "Configure a Security Context", "Pod Security Standards", "Pod Security Admission"; CNCF Kubernetes Hardening Guide.

---
*Kubernetes Handbook — topic 23.*
