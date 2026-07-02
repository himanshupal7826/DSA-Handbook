# 08 · Jobs & CronJobs

> **In one line:** A **Job** runs pods to *completion* (batch/one-shot work); a **CronJob** creates Jobs on a **schedule** — the controllers for tasks that finish, not services that stay up.

---

## 1. Overview

Deployments, StatefulSets, and DaemonSets all manage **long-running** pods — they restart them forever. But a lot of real work *finishes*: a database migration, a nightly report, an image-processing batch, a backup, a queue-drain. For those, restarting on exit is wrong; you want to run *until success*, then stop.

A **Job** owns pods and tracks **completions**. It runs a pod, and if the pod succeeds (exit 0) the Job records a completion; if it fails, the Job retries up to `backoffLimit`. You can require N successful completions (`completions`) and run several at once (`parallelism`), turning a Job into a small batch engine.

A **CronJob** is a thin controller on top: on each cron tick it creates a **new Job** from a template. It adds scheduling semantics — how many past runs to keep, what to do if a run overlaps the previous one (`concurrencyPolicy`), and how late is "too late" to start (`startingDeadlineSeconds`). Reach for these whenever the unit of work has a **defined end**.

## 2. Core Concepts

- **Job** — runs pods to successful completion; tracks how many have succeeded.
- **`completions`** — total number of successful pod runs required for the Job to be complete (default 1).
- **`parallelism`** — how many pods may run concurrently (default 1). With `completions` unset and a work queue, pods run in parallel until they self-terminate.
- **`backoffLimit`** — number of retries before the Job is marked **Failed** (default 6). Failed pods retry with exponential back-off (capped at 6 min).
- **`restartPolicy`** — for Job pods must be `Never` or `OnFailure` (**not** `Always`). `OnFailure` restarts the *container in place*; `Never` creates a *new pod* per attempt.
- **`activeDeadlineSeconds`** — wall-clock cap; the Job is killed and marked Failed if it runs longer, regardless of retries left.
- **`ttlSecondsAfterFinished`** — auto-delete the Job (and its pods) N seconds after it finishes, so completed Jobs don't pile up.
- **Completion modes** — `NonIndexed` (default; any N successes) vs `Indexed` (each pod gets a unique `JOB_COMPLETION_INDEX`, for partitioned/sharded work).
- **CronJob `schedule`** — standard cron (`"*/5 * * * *"`), evaluated in the CronJob's `timeZone` (or controller TZ if unset).
- **`concurrencyPolicy`** — `Allow` (default, overlap OK), `Forbid` (skip if previous still running), `Replace` (kill the running one, start fresh).
- **`startingDeadlineSeconds`** — if the controller misses the scheduled time by more than this, that run is skipped (missed schedule).
- **History limits** — `successfulJobsHistoryLimit` / `failedJobsHistoryLimit` bound how many finished Jobs are retained.
- **Idempotency** — because pods retry and CronJobs can double-fire, the work must be safe to run more than once.

## 3. Syntax & Examples

A one-shot Job (a DB migration) — no retries beyond one, auto-clean after:

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: migrate
spec:
  backoffLimit: 2
  activeDeadlineSeconds: 600
  ttlSecondsAfterFinished: 300      # GC 5 min after finish
  template:
    spec:
      restartPolicy: Never          # new pod per attempt
      containers:
        - name: migrate
          image: myapp/migrate:1.4
          command: ["./migrate", "up"]
```

A parallel batch — 12 items, 4 at a time, each pod knows its shard:

```yaml
apiVersion: batch/v1
kind: Job
metadata: { name: resize-batch }
spec:
  completions: 12
  parallelism: 4
  completionMode: Indexed           # pod gets JOB_COMPLETION_INDEX 0..11
  template:
    spec:
      restartPolicy: OnFailure
      containers:
        - name: worker
          image: myapp/resize:2.0
          command: ["sh", "-c", "process-shard $JOB_COMPLETION_INDEX"]
```

A CronJob — every 5 minutes, never overlap, skip if >100s late, keep small history:

```yaml
apiVersion: batch/v1
kind: CronJob
metadata: { name: report }
spec:
  schedule: "*/5 * * * *"
  timeZone: "Asia/Kolkata"
  concurrencyPolicy: Forbid          # don't start if prior run still going
  startingDeadlineSeconds: 100
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 1
  jobTemplate:
    spec:
      backoffLimit: 3
      template:
        spec:
          restartPolicy: OnFailure
          containers:
            - name: report
              image: myapp/report:1.0
              command: ["./run-report"]
```

## 4. Worked Example

Run the batch Job and watch completions accumulate:

```bash
kubectl apply -f resize-batch.yaml
kubectl get job resize-batch -w
```

```text
NAME           COMPLETIONS   DURATION   AGE
resize-batch   0/12          2s         2s
resize-batch   4/12          20s        20s     # 4 running in parallel
resize-batch   8/12          41s        41s
resize-batch   12/12         58s        58s     # Complete
```

Inspect a CronJob's activity:

```bash
kubectl get cronjob report
kubectl get jobs -l job-name --sort-by=.metadata.creationTimestamp | tail -3
```

```text
NAME     SCHEDULE      TIMEZONE       SUSPEND   ACTIVE   LAST SCHEDULE   AGE
report   */5 * * * *   Asia/Kolkata   False     0        2m ago          3h

report-29380145   Complete   1/1   32s   17m
report-29380150   Complete   1/1   29s   12m
report-29380155   Complete   1/1   30s   7m
```

Trigger a CronJob run manually (e.g. to test):

```bash
kubectl create job --from=cronjob/report report-manual-001
```

## 5. Under the Hood

The **Job controller** watches its pods: each pod that exits 0 increments the success count; each failure schedules a retry with exponential back-off until `backoffLimit` is hit (→ Failed) or `completions` is reached (→ Complete). `parallelism` bounds how many pods are active at once. The **CronJob controller** wakes on schedule ticks, and for each due time creates a Job from `jobTemplate` — consulting `concurrencyPolicy` (is a prior Job still Active?) and `startingDeadlineSeconds` (is this tick too old to run?) before creating it.

```svg
<svg viewBox="0 0 720 320" width="100%" height="320" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="arr" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="360" y="22" text-anchor="middle" fill="#1e293b" font-weight="600">CronJob → Job → Pods (to completion)</text>

  <!-- cronjob -->
  <rect x="40" y="50" width="150" height="50" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="115" y="72" text-anchor="middle" fill="#1e293b" font-weight="600">CronJob</text>
  <text x="115" y="90" text-anchor="middle" fill="#64748b">*/5 * * * *</text>

  <!-- schedule ticks -->
  <text x="115" y="130" text-anchor="middle" fill="#64748b">each tick creates →</text>

  <!-- job -->
  <rect x="270" y="50" width="170" height="50" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="355" y="72" text-anchor="middle" fill="#1e293b" font-weight="600">Job</text>
  <text x="355" y="90" text-anchor="middle" fill="#64748b">completions:12 parallelism:4</text>

  <line x1="190" y1="75" x2="268" y2="75" stroke="#475569" marker-end="url(#arr)"/>

  <!-- pods -->
  <rect x="500" y="45" width="180" height="30" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="590" y="65" text-anchor="middle" fill="#1e293b">pod idx0 ✓</text>
  <rect x="500" y="82" width="180" height="30" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="590" y="102" text-anchor="middle" fill="#1e293b">pod idx1 ✓</text>
  <rect x="500" y="119" width="180" height="30" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="590" y="139" text-anchor="middle" fill="#1e293b">pod idx2 ✗ → retry (backoff)</text>
  <rect x="500" y="156" width="180" height="30" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="590" y="176" text-anchor="middle" fill="#1e293b">pod idx3 running…</text>

  <line x1="440" y1="75" x2="498" y2="60" stroke="#475569" marker-end="url(#arr)"/>
  <line x1="440" y1="80" x2="498" y2="97" stroke="#475569" marker-end="url(#arr)"/>
  <line x1="440" y1="85" x2="498" y2="134" stroke="#475569" marker-end="url(#arr)"/>
  <line x1="440" y1="90" x2="498" y2="171" stroke="#475569" marker-end="url(#arr)"/>

  <!-- states -->
  <rect x="270" y="230" width="380" height="60" rx="8" fill="none" stroke="#475569"/>
  <text x="460" y="252" text-anchor="middle" fill="#1e293b">Job state machine</text>
  <text x="460" y="274" text-anchor="middle" fill="#64748b">Active → (successes==completions) Complete · (retries&gt;backoffLimit) Failed</text>

  <text x="150" y="250" text-anchor="middle" fill="#64748b">concurrencyPolicy:</text>
  <text x="150" y="270" text-anchor="middle" fill="#64748b">Allow/Forbid/Replace</text>
</svg>
```

## 6. Variations & Trade-offs

| Setting | Meaning | Trade-off |
|---|---|---|
| `restartPolicy: OnFailure` | restart container in-place | faster retries, but same pod/node; masks node issues |
| `restartPolicy: Never` | new pod per attempt | clean isolation, leaves failed pods for debugging |
| `backoffLimit` | max retries before Failed | too low → flaky failures; too high → wasted work on real bugs |
| `completions` + `parallelism` | fixed batch size / fan-out | tune to workload; parallelism bounded by cluster capacity |
| `completionMode: Indexed` | per-pod index | enables static work partitioning without a queue |
| CronJob `Allow` vs `Forbid` vs `Replace` | overlap handling | `Allow` risks pile-up; `Forbid` skips; `Replace` interrupts |
| `startingDeadlineSeconds` | how late is too late | short → miss runs after controller downtime; unset → may fire many missed runs |

Jobs are for finite work; if you find yourself setting `backoffLimit` huge and `completions: 1` for something that should always be up, you want a Deployment. CronJobs are *not* a precise real-time scheduler — ticks can be delayed under controller load; don't rely on sub-minute precision.

## 7. Production / Performance Notes

- **Always set `ttlSecondsAfterFinished`** (or history limits on CronJobs) — otherwise completed Jobs/pods accumulate and clutter the API/etcd.
- **Make the work idempotent.** A pod can be retried and a CronJob can (rarely) double-fire; running the same migration/report twice must be safe. Use natural keys, `INSERT ... ON CONFLICT`, or a run-lock.
- **Use `concurrencyPolicy: Forbid`** for jobs that must not overlap (a report that reads a moving window, a backup). `Replace` when only the latest matters.
- **Bound runtime** with `activeDeadlineSeconds` so a hung job doesn't run until the next schedule (or forever).
- **Set `timeZone`** explicitly for CronJobs — controller TZ defaults bite you across regions and DST.
- **Resource requests/limits** on batch pods; a big `parallelism` can starve the cluster. Consider a dedicated node pool or priority class.
- For **queue-driven** work, leave `completions` unset and use `parallelism` with pods that exit when the queue is empty.
- `suspend: true` pauses a CronJob (or a Job before it starts) without deleting it — handy for maintenance windows.

## 8. Common Mistakes

1. ⚠️ **`restartPolicy: Always` on a Job pod.** Rejected — Jobs require `Never`/`OnFailure`. Fix: use one of those.
2. ⚠️ **Non-idempotent work that double-runs.** Retries or overlapping CronJob ticks corrupt data. Fix: make operations idempotent / use a lock.
3. ⚠️ **No `backoffLimit`/`activeDeadlineSeconds`, so a broken job burns resources forever.** Fix: cap retries and wall-clock time.
4. ⚠️ **Completed Jobs pile up.** No TTL/history limit. Fix: `ttlSecondsAfterFinished` and CronJob history limits.
5. ⚠️ **CronJob overlaps under `Allow` and piles up runs.** Slow jobs stack. Fix: `concurrencyPolicy: Forbid` or `Replace`.
6. ⚠️ **Assuming CronJob fires exactly on time.** It can be delayed and, without `startingDeadlineSeconds`, may replay many missed runs after downtime. Fix: set a sane deadline.
7. ⚠️ **Wrong timezone assumptions.** Job runs an hour off across DST. Fix: set `timeZone` explicitly.
8. ⚠️ **Deleting a Job leaves orphan pods** if using foreground/background wrongly. Fix: rely on owner references / `kubectl delete job` (cascades by default).

## 9. Interview Questions

**Q: What's the difference between a Job and a Deployment?**
A: A Job runs pods to *completion* and stops once the required successes are reached; a Deployment keeps pods running indefinitely, restarting them on exit. Jobs are for finite batch/one-shot work; Deployments for long-running services.

**Q: What `restartPolicy` values are valid for a Job pod and how do they differ?**
A: `OnFailure` and `Never` (not `Always`). `OnFailure` restarts the container in place within the same pod; `Never` spins up a brand-new pod per attempt, which isolates state and leaves failed pods around for inspection.

**Q: Explain `completions`, `parallelism`, and `backoffLimit`.**
A: `completions` is how many successful pod runs are needed for the Job to finish; `parallelism` is how many pods may run at once; `backoffLimit` is the number of retries (with exponential back-off) before the Job is marked Failed.

**Q: What is `completionMode: Indexed` for? (senior)**
A: It assigns each pod a unique `JOB_COMPLETION_INDEX` (0..completions-1), enabling static partitioning of work across pods without an external queue — pod N processes shard N.

**Q: What does `concurrencyPolicy` control and what are the options?**
A: How a CronJob handles a new run while a previous Job is still active. `Allow` lets them overlap; `Forbid` skips the new run; `Replace` kills the running Job and starts the new one.

**Q: What does `startingDeadlineSeconds` do? (senior)**
A: It bounds how late a scheduled run may start. If the controller misses the scheduled time by more than this many seconds (e.g. after downtime), that run is counted as missed and skipped — preventing a flood of catch-up runs.

**Q: Why is idempotency critical for Jobs and CronJobs? (senior)**
A: Pods retry on failure and CronJobs can occasionally fire more than once or overlap, so the same unit of work may execute multiple times. If the operation isn't idempotent, that causes duplicate side effects (double charges, corrupt reports). Use natural keys, upserts, or run-locks.

**Q: How do you stop completed Jobs from accumulating?**
A: `ttlSecondsAfterFinished` on Jobs auto-deletes them (and pods) after they finish; CronJobs use `successfulJobsHistoryLimit`/`failedJobsHistoryLimit` to bound retained runs.

**Q: How do you cap a Job's total runtime regardless of retries?**
A: `activeDeadlineSeconds` — a wall-clock limit; when exceeded the Job is terminated and marked Failed even if `backoffLimit` retries remain.

**Q: How would you run a nightly backup that must never overlap and must be idempotent? (senior)**
A: A CronJob with `concurrencyPolicy: Forbid`, an explicit `timeZone`, `startingDeadlineSeconds` to skip stale runs, `activeDeadlineSeconds` to bound runtime, `ttlSecondsAfterFinished`/history limits for cleanup, and backup logic keyed on a deterministic snapshot name so re-runs are safe.

**Q: How do you manually trigger a CronJob run for testing?**
A: `kubectl create job --from=cronjob/<name> <run-name>` creates a one-off Job from the CronJob's template without waiting for the schedule.

## 10. Practice

- [ ] Write a Job with `completions: 6`, `parallelism: 2` and watch completions climb with `kubectl get job -w`.
- [ ] Make a container exit non-zero; observe `backoffLimit` retries and the eventual Failed state.
- [ ] Convert the Job to `completionMode: Indexed` and print `$JOB_COMPLETION_INDEX` from each pod.
- [ ] Create a CronJob every minute with `concurrencyPolicy: Forbid` and a deliberately slow job; confirm overlaps are skipped.
- [ ] Add `ttlSecondsAfterFinished` and verify finished Jobs are garbage-collected.

## 11. Cheat Sheet

> [!TIP]
> **Job** runs pods to completion: `completions` (how many successes) × `parallelism` (concurrency), retries up to `backoffLimit`, capped by `activeDeadlineSeconds`.
> Pod `restartPolicy`: **`OnFailure`** (retry container) or **`Never`** (new pod) — never `Always`.
> `completionMode: Indexed` → `$JOB_COMPLETION_INDEX` for sharding. `ttlSecondsAfterFinished` to auto-clean.
> **CronJob** = Job on a `schedule` (+`timeZone`). `concurrencyPolicy: Allow|Forbid|Replace`, `startingDeadlineSeconds` skips late runs, history limits bound retention.
> Golden rule: **make the work idempotent** — it can run more than once. Trigger ad-hoc: `kubectl create job --from=cronjob/x`.

**References:** Kubernetes docs "Jobs", "Automatic Cleanup for Finished Jobs", "CronJob", "Indexed Job for Parallel Processing", crontab.guru

---
*Kubernetes Handbook — topic 08.*
