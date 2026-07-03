# 27 · CRDs & Operators

> **In one line:** A **CustomResourceDefinition** teaches the API server a new object type, and an **operator** is a controller that watches those objects and drives the real world toward them — encoding a human operator's runbook as a reconcile loop.

---

## 1. Overview

Kubernetes ships with a fixed vocabulary — `Pod`, `Deployment`, `Service`, `Job`. For anything stateful or domain-specific (a Postgres cluster, a Kafka topic, a TLS certificate, a Redis failover) the built-in nouns run out. You *could* automate those with bash + `kubectl`, but you'd be reinventing the control loop, the retries, the drift correction, and the observability that Kubernetes already does well.

A **CustomResourceDefinition (CRD)** extends the API server with a new kind — say `kind: PostgresCluster` — so `kubectl get postgrescluster` works, RBAC applies, `kubectl apply` stores it in etcd, and it shows up in the API like any native object. A CRD by itself is *inert data*: it just gets validated and stored. Nothing happens.

The **operator** is the active half. It's a **controller** — a program running in-cluster that watches your custom resources and continuously **reconciles** actual state toward the declared `spec`. The operator encodes the operational knowledge a senior SRE would apply by hand: "if the primary dies, promote a replica; take backups nightly; on version bump, do a rolling minor upgrade." That's the **operator pattern**: *software that runs software*, packaging day-2 operations (upgrades, failover, backup, scaling) into a controller.

Reach for a CRD + operator when you have a **stateful or complex application whose correct operation requires domain logic** that a generic `Deployment` can't express. Reach for something simpler (Helm chart, `Deployment` + `ConfigMap`) when your app is stateless and "apply the manifest" is the whole story.

## 2. Core Concepts

- **CustomResourceDefinition (CRD)** — a manifest that registers a new API type (group/version/kind, e.g. `db.acme.io/v1/PostgresCluster`) with an **OpenAPI v3 schema** for validation. After it's applied, instances of that kind are **Custom Resources (CRs)**.
- **Custom Resource (CR)** — an instance of the CRD; the user's *desired state*, e.g. a `PostgresCluster` asking for 3 replicas and version 15.
- **Controller** — a control loop that watches resources and acts to make the world match `spec`. Deployments, ReplicaSets, and your operator are all controllers.
- **Reconcile loop** — the heart of every controller: **observe → diff → act → requeue**, repeated forever and level-triggered (it acts on *current state*, not on the event that woke it).
- **spec vs status** — `spec` is the user's desired intent (write-facing); `status` is the controller's observed reality (the operator writes it back). Users own `spec`; the controller owns `status`.
- **Operator** — a CRD (the API) plus its controller (the brains), shipped together. The CRD defines *what* users can ask for; the controller knows *how* to deliver it.
- **Informer / watch cache** — controllers don't poll etcd; they `watch` the API and cache objects locally, reconciling on change. Cheap and scalable.
- **Owner references & garbage collection** — resources the operator creates (Pods, Services, PVCs) carry an `ownerReference` back to the CR, so deleting the CR cascade-deletes its children.
- **Finalizers** — string keys on an object that block deletion until the operator runs cleanup (deregister from a cloud LB, snapshot a volume) and removes the key.
- **Level-triggered, not edge-triggered** — reconcile is idempotent and re-derives desired state each pass, so a missed event or a restart self-heals on the next loop.

## 3. Syntax & Examples

A minimal CRD registering a new `CronTab` kind:

```yaml
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: crontabs.stable.acme.io      # must be <plural>.<group>
spec:
  group: stable.acme.io
  scope: Namespaced                  # or Cluster
  names:
    plural: crontabs
    singular: crontab
    kind: CronTab
    shortNames: [ct]
  versions:
    - name: v1
      served: true
      storage: true                  # exactly one version is the storage version
      schema:
        openAPIV3Schema:
          type: object
          properties:
            spec:
              type: object
              required: [cronSpec, image]
              properties:
                cronSpec: { type: string, pattern: '^(\S+\s+){4}\S+$' }
                image:    { type: string }
                replicas: { type: integer, minimum: 1, default: 1 }
            status:
              type: object
              properties:
                phase: { type: string }
      subresources:
        status: {}                   # enables the /status subresource
      additionalPrinterColumns:
        - name: Image
          type: string
          jsonPath: .spec.image
        - name: Phase
          type: string
          jsonPath: .status.phase
```

Now the API server accepts instances of that kind:

```yaml
apiVersion: stable.acme.io/v1
kind: CronTab
metadata:
  name: nightly-report
spec:
  cronSpec: "0 3 * * *"
  image: ghcr.io/acme/report:1.4.0
  replicas: 2
```

```bash
kubectl apply -f crontab-crd.yaml          # register the type
kubectl apply -f my-crontab.yaml           # create an instance
kubectl get ct                             # uses the shortName + printer columns
kubectl explain crontab.spec               # schema is introspectable
```

The **reconcile function** (the operator's core) in Go, using controller-runtime:

```go
func (r *CronTabReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
    // 1. OBSERVE — read the current CR
    var ct stablev1.CronTab
    if err := r.Get(ctx, req.NamespacedName, &ct); err != nil {
        return ctrl.Result{}, client.IgnoreNotFound(err) // deleted → nothing to do
    }

    // 2. DIFF — compute what should exist vs what does
    desired := buildCronJob(&ct)              // pure function: CR → child object
    var found batchv1.CronJob
    err := r.Get(ctx, types.NamespacedName{Name: ct.Name, Namespace: ct.Namespace}, &found)

    // 3. ACT — create or update to close the gap (idempotent)
    if apierrors.IsNotFound(err) {
        ctrl.SetControllerReference(&ct, desired, r.Scheme) // ownerRef for GC
        if err := r.Create(ctx, desired); err != nil {
            return ctrl.Result{}, err        // error → automatic backoff + requeue
        }
    } else if !equalSpec(&found, desired) {
        found.Spec = desired.Spec
        if err := r.Update(ctx, &found); err != nil {
            return ctrl.Result{}, err
        }
    }

    // 4. STATUS — report observed reality back to the user
    ct.Status.Phase = "Ready"
    return ctrl.Result{}, r.Status().Update(ctx, &ct)
}
```

## 4. Worked Example

Let's model a tiny `WebApp` operator that turns one CR into a Deployment + Service, and watch reconciliation happen.

The CR the user applies:

```yaml
apiVersion: apps.acme.io/v1
kind: WebApp
metadata:
  name: shop
spec:
  image: ghcr.io/acme/shop:2.1.0
  replicas: 3
```

The operator reconciles it into managed children. Observing the result:

```bash
kubectl apply -f webapp.yaml
kubectl get webapp shop -o wide
kubectl get deploy,svc -l app.kubernetes.io/managed-by=webapp-operator
```

```text
NAME                        IMAGE                     REPLICAS   PHASE
webapp.apps.acme.io/shop    ghcr.io/acme/shop:2.1.0   3          Ready

NAME                    READY   UP-TO-DATE   AVAILABLE   AGE
deployment.apps/shop    3/3     3            3           12s

NAME            TYPE        CLUSTER-IP      PORT(S)   AGE
service/shop    ClusterIP   10.96.14.201    80/TCP    12s
```

Now demonstrate the **self-healing** property — delete a child by hand:

```bash
kubectl delete deployment shop         # simulate drift / accidental delete
kubectl get deploy shop -w
```

```text
Error from server (NotFound): deployments.apps "shop" not found
NAME    READY   UP-TO-DATE   AVAILABLE   AGE
shop    0/3     0            0           0s      # operator recreated it within ~1s
shop    3/3     3            3           4s
```

The Deployment came back **without any user action** — because the operator watches its owned objects and reconciles on their deletion event, re-deriving the desired state from the `WebApp` spec. That is the whole value proposition: declared intent, continuously enforced.

## 5. Under the Hood

A controller never polls etcd directly. It sets up an **informer** that maintains a `watch` on the API server, caches objects locally, and pushes keys onto a **work queue** whenever anything of interest changes (the CR itself, or any object owned by it). Worker goroutines pull keys and call `Reconcile`. Errors and rate limits cause the key to be re-queued with exponential backoff; success may request a `RequeueAfter` for periodic resync.

```svg
<svg viewBox="0 0 760 380" width="100%" height="380" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" fill="#475569"/>
    </marker>
  </defs>

  <!-- API server / etcd -->
  <rect x="270" y="20" width="220" height="54" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="380" y="42" text-anchor="middle" fill="#1e293b" font-weight="600">API Server + etcd</text>
  <text x="380" y="60" text-anchor="middle" fill="#64748b">desired spec is stored here</text>

  <!-- watch down to informer -->
  <line x1="380" y1="74" x2="380" y2="108" stroke="#475569" marker-end="url(#ah)"/>
  <text x="432" y="96" fill="#64748b">watch / list</text>

  <!-- Reconcile loop box -->
  <rect x="150" y="110" width="460" height="210" rx="8" fill="none" stroke="#64748b" stroke-dasharray="4 3"/>
  <text x="380" y="130" text-anchor="middle" fill="#64748b">operator: reconcile loop</text>

  <!-- OBSERVE -->
  <rect x="180" y="145" width="160" height="46" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="260" y="165" text-anchor="middle" fill="#1e293b" font-weight="600">1 · OBSERVE</text>
  <text x="260" y="181" text-anchor="middle" fill="#64748b">read CR + children</text>

  <!-- DIFF -->
  <rect x="420" y="145" width="160" height="46" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="500" y="165" text-anchor="middle" fill="#1e293b" font-weight="600">2 · DIFF</text>
  <text x="500" y="181" text-anchor="middle" fill="#64748b">desired vs actual</text>

  <!-- ACT -->
  <rect x="420" y="245" width="160" height="46" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="500" y="265" text-anchor="middle" fill="#1e293b" font-weight="600">3 · ACT</text>
  <text x="500" y="281" text-anchor="middle" fill="#64748b">create / update / delete</text>

  <!-- STATUS -->
  <rect x="180" y="245" width="160" height="46" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="260" y="265" text-anchor="middle" fill="#1e293b" font-weight="600">4 · STATUS</text>
  <text x="260" y="281" text-anchor="middle" fill="#64748b">write observed state</text>

  <!-- loop arrows -->
  <line x1="340" y1="168" x2="420" y2="168" stroke="#475569" marker-end="url(#ah)"/>
  <line x1="500" y1="191" x2="500" y2="245" stroke="#475569" marker-end="url(#ah)"/>
  <line x1="420" y1="268" x2="340" y2="268" stroke="#475569" marker-end="url(#ah)"/>
  <line x1="260" y1="245" x2="260" y2="191" stroke="#475569" marker-end="url(#ah)"/>
  <text x="260" y="228" text-anchor="middle" fill="#64748b">requeue ⟳</text>

  <!-- act to cluster -->
  <line x1="580" y1="268" x2="636" y2="268" stroke="#475569" marker-end="url(#ah)"/>
  <rect x="640" y="205" width="100" height="120" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="690" y="227" text-anchor="middle" fill="#1e293b" font-weight="600">children</text>
  <text x="690" y="249" text-anchor="middle" fill="#64748b">Deploy</text>
  <text x="690" y="269" text-anchor="middle" fill="#64748b">Service</text>
  <text x="690" y="289" text-anchor="middle" fill="#64748b">PVC…</text>
  <text x="690" y="313" text-anchor="middle" fill="#64748b">ownerRef</text>

  <!-- status back to api -->
  <line x1="230" y1="245" x2="300" y2="78" stroke="#475569" stroke-dasharray="3 3" marker-end="url(#ah)"/>
</svg>
```

The loop is **level-triggered**: each pass re-derives the full desired state and diffs it against reality, so a dropped watch event, an operator crash, or a hand-edit all converge on the next reconcile. This is why controllers are robust — they don't depend on seeing every event, only on eventually observing current state.

## 6. Variations & Trade-offs

| Approach | What it is | Best for | Cost |
|---|---|---|---|
| Plain `Deployment` + `ConfigMap` | Native objects, no custom code | Stateless apps | Zero — but no domain logic |
| **Helm chart** | Templated bundle of manifests | Install-time config, packaging | Renders once; no runtime reconciliation |
| **CRD only** (no controller) | Structured config store in the API | Config other tools read | Inert — nothing acts on it |
| **CRD + operator** | Custom API + controller | Stateful/complex day-2 ops | Build + maintain a controller |
| **Kubebuilder / Operator SDK** | Scaffolding for the above | Most new operators | Go, boilerplate, upgrade churn |
| **Metacontroller / KUDO** | Write reconcile in a hook/script | Simple operators, non-Go teams | Less control, extra component |

Helm and operators are **complementary**, not rivals: Helm is a *package manager* (great at day-1 install), an operator is a *runtime controller* (great at day-2 operations). Many products ship a Helm chart that *installs the operator*, which then manages the CRs. CRDs also differ from the older **aggregated API server** approach: CRDs are declarative and cheap but store in etcd with limited custom behavior; an aggregated API server is a full custom apiserver (arbitrary storage, subresources) at much higher complexity — rarely worth it.

## 7. Production / Performance Notes

- **Always version your CRD and add a conversion strategy** before you have real users. Bumping `v1alpha1 → v1` in place breaks stored objects; use `served`/`storage` versions and a conversion webhook.
- **Structural schemas are mandatory** for `apiextensions.k8s.io/v1` — they enable server-side validation, defaulting, and pruning of unknown fields. Set `x-kubernetes-preserve-unknown-fields` only where you truly need free-form data.
- **Own your `status` subresource.** With `subresources.status: {}`, a `spec` change and a `status` change have separate resourceVersions, so status writes don't fight user edits and don't trigger spec reconciles.
- **Idempotency is non-negotiable.** Reconcile can run thousands of times; every action must be safe to repeat. Use server-side apply or create-or-update helpers, never blind `Create`.
- **Set resource requests + a leader election lease.** Run the operator as a single active replica via leader election (others stand by) so two controllers don't fight over the same objects.
- **Rate limits & work-queue depth** matter at scale — thousands of CRs mean thousands of reconciles. Watch controller-runtime's `workqueue_depth` and `reconcile_duration` metrics; add `RequeueAfter` resyncs sparingly.
- **Finalizers can wedge deletion.** If the operator that owns a finalizer is down, `kubectl delete` hangs forever. Have a documented escape hatch (patch the finalizer off) and alert on stuck deletions.
- **RBAC scope creep** — an operator that manages Deployments, Services, PVCs, and Secrets needs broad permissions; scope it per-namespace where possible and audit its ClusterRole.

## 8. Common Mistakes

1. ⚠️ **Treating a CRD as an operator.** Applying a CRD gives you storage and validation only — *nothing acts on the CR*. Fix: ship a controller, or the object just sits in etcd doing nothing.
2. ⚠️ **Non-idempotent reconcile** (e.g. `Create` without checking existence, appending to a list each pass). Fix: always diff desired vs actual and use create-or-update / server-side apply.
3. ⚠️ **Writing to `spec` from the controller.** The controller owns `status`, the user owns `spec`; writing `spec` fights the user and causes reconcile storms. Fix: use the `/status` subresource.
4. ⚠️ **Edge-triggered thinking** — assuming you'll see every event and acting on the *event* instead of *current state*. Fix: re-derive full desired state each reconcile; assume events can be missed.
5. ⚠️ **No `ownerReference` on created children.** Deleting the CR then orphans its Pods/Services. Fix: `SetControllerReference` so garbage collection cascades.
6. ⚠️ **Skipping the OpenAPI schema** (or `preserve-unknown-fields` everywhere). You lose validation and get typo'd fields silently accepted. Fix: write a real structural schema with `required`, types, and patterns.
7. ⚠️ **Building an operator for a stateless app.** A `Deployment` + HPA already does it; a custom controller is pure liability. Fix: only build one when domain day-2 logic can't be expressed natively.
8. ⚠️ **In-place CRD version bumps** with no conversion. Existing objects become unreadable. Fix: add a new served version + conversion webhook, migrate, then retire the old one.

## 9. Interview Questions

**Q: What is the difference between a CRD and an operator?**
A: A CRD (CustomResourceDefinition) extends the Kubernetes API with a new object type — it adds validation and storage so the API server accepts and persists a new `kind`, but it's inert data. An operator is a CRD *plus* a controller: a running control loop that watches those custom resources and reconciles the real world toward their `spec`. The CRD is the API; the operator is the brains that acts on it.

**Q: Explain the reconcile loop and why it's level-triggered?**
A: Reconcile is observe → diff → act → requeue, run continuously. Level-triggered means each pass re-derives the full desired state from current observed state and closes the gap, rather than reacting to a specific event (edge-triggered). This makes controllers robust: a missed watch event, an operator restart, or manual drift all self-correct on the next reconcile because it always acts on *what is*, not *what changed*.

**Q: Why must a reconcile function be idempotent?**
A: Because it can run an unbounded number of times — on every relevant event, on periodic resync, and after restarts. If it isn't safe to repeat (e.g. it appends to a list or unconditionally creates), you get duplicated resources or drift. Idempotency is achieved by computing desired state and diffing against actual, so re-running converges to the same result.

**Q: What is the role of spec vs status, and who writes each?**
A: `spec` is the user's declared desired state (write-facing, owned by the user). `status` is the controller's report of observed reality (owned by the controller). Using the `/status` subresource keeps their updates independent so status writes don't trigger spec reconciles or conflict with user edits.

**Q: How does deleting a custom resource clean up the Pods and Services it created?**
A: The operator stamps every child object with an `ownerReference` pointing back to the CR (via `SetControllerReference`). Kubernetes garbage collection then cascade-deletes owned objects when the owner is deleted. For external cleanup (cloud LBs, snapshots) the operator adds a **finalizer** that blocks deletion until it runs teardown and removes the key.

**Q: When should you NOT build an operator?**
A: When the app is stateless and "apply the manifest" is the whole operational story — a `Deployment`, `Service`, `ConfigMap`, and HPA already cover it. Operators are justified by *day-2 domain logic* (failover, backup, ordered upgrades, topology-aware scaling) that native objects can't express. Otherwise a Helm chart is cheaper and lower-maintenance.

**Q: How does a controller watch for changes efficiently — does it poll etcd?**
A: No. It uses an **informer** that opens a `watch` on the API server, maintains a local cache, and enqueues keys onto a work queue on change. Workers pop keys and reconcile, with exponential backoff on error. This avoids polling, scales to many objects, and gives each controller a consistent local view.

**Q: (Senior) How do you evolve a CRD's schema without breaking existing stored objects?**
A: Never mutate a served version in place. Introduce a new API version, mark exactly one as the `storage` version, serve both, and register a **conversion webhook** (or `None` conversion if fields are compatible) to translate between them. Migrate stored objects to the new storage version, then stop serving and remove the old one. Structural schemas and defaulting make this safe.

**Q: (Senior) Two operator replicas are running — how do you prevent them from fighting over the same resources?**
A: **Leader election.** Only the replica holding a Lease reconciles; the others stand by as hot spares. controller-runtime provides this out of the box. Without it, two active controllers issue conflicting writes, causing reconcile storms and thrashing. Combine with a single work queue and optimistic concurrency (resourceVersion conflicts trigger a retry).

**Q: (Senior) Compare CRDs to an aggregated API server. When is each appropriate?**
A: A CRD stores objects in etcd with an OpenAPI schema and standard behavior — cheap, declarative, covers ~95% of extension needs. An aggregated API server is a full custom apiserver you run and register; it gives arbitrary storage backends, custom subresources, and specialized behavior, at much higher operational cost. Choose CRDs by default; reach for aggregation only when you need behavior CRDs genuinely can't provide (e.g. metrics-server, non-etcd storage).

**Q: (Senior) What can wedge a custom resource in Terminating forever, and how do you recover?**
A: A **finalizer** whose owning operator is down or erroring never gets removed, so the API server won't complete deletion. Recovery: fix/restart the operator so it runs cleanup, or as a last resort patch the finalizer out (`kubectl patch ... -p '{"metadata":{"finalizers":[]}}' --type=merge`) — accepting that external cleanup won't run. Alert on objects stuck terminating beyond a threshold.

**Q: How do additionalPrinterColumns and shortNames improve a CRD's UX?**
A: `additionalPrinterColumns` map JSONPaths from the object into `kubectl get` columns (e.g. show image and phase), so operators are readable without `-o yaml`. `shortNames` give a terse alias (`ct` for `crontab`). Both make custom resources feel first-class alongside native kinds.

## 10. Practice

- [ ] Write a CRD for a `kind: FeatureFlag` with a structural schema (`enabled: bool`, `rollout: int 0–100`), a status subresource, and printer columns; apply it and `kubectl explain` the schema.
- [ ] Scaffold an operator with Kubebuilder (`kubebuilder init` + `create api`) that reconciles a `WebApp` CR into a Deployment + Service, and verify it recreates a hand-deleted child.
- [ ] Add an `ownerReference` to the created children and confirm cascade deletion works when the CR is removed.
- [ ] Add a finalizer that logs a cleanup message, then observe how `kubectl delete` blocks until the operator removes it.
- [ ] Introduce a `v2` version of your CRD and write a `None`-strategy or webhook conversion; migrate an existing object.

## 11. Cheat Sheet

> [!TIP]
> **CRD** = teach the API server a new `kind` (schema + storage, *inert*). **CR** = an instance (the user's desired `spec`). **Operator** = CRD + **controller** that runs the reconcile loop: **observe → diff → act → requeue**, forever, *level-triggered* and *idempotent*. User owns `spec`, controller owns `status` (via the `/status` subresource). Stamp children with `ownerReference` for GC; use `finalizers` for external cleanup; use **leader election** so only one replica acts. Build one only for **stateful/day-2 domain logic** native objects can't express — otherwise use a `Deployment`/Helm chart. Scaffold with **Kubebuilder** or **Operator SDK**. Version CRDs with a **conversion webhook** from day one.

**References:** Kubernetes docs — "Extend the Kubernetes API with CustomResourceDefinitions" & "Operator pattern"; the Kubebuilder Book; Operator SDK docs; CNCF "Operator White Paper"

---
*Kubernetes Handbook — topic 27.*
