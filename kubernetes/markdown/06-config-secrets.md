# 06 · ConfigMaps & Secrets

> **In one line:** Externalize configuration and sensitive data from images.

---

## 1. Overview

**ConfigMaps** hold non-sensitive config; **Secrets** hold sensitive data (base64-encoded, ideally encrypted at rest). Both inject into pods as **environment variables** or mounted **files**, keeping config out of images for the 12-factor app pattern.

## 2. Key Concepts

- ConfigMap = key/value config; Secret = sensitive key/value.
- Inject as env vars or mounted volume files.
- Secrets are base64 (not encrypted by default) — enable encryption at rest.
- Mounted config can update without rebuilding images.
- Use external secret managers for stronger security.

## 3. Syntax & Code

```yaml
apiVersion: v1
kind: ConfigMap
metadata: {name: app-config}
data:
  LOG_LEVEL: info
---
apiVersion: v1
kind: Secret
metadata: {name: app-secret}
type: Opaque
stringData:
  DB_PASSWORD: s3cr3t
```

## 4. Worked Example

**Consume in a pod**

Inject config as env and secret as a file:

```yaml
envFrom: [{configMapRef: {name: app-config}}]
volumeMounts: [{name: sec, mountPath: /etc/secret, readOnly: true}]
volumes: [{name: sec, secret: {secretName: app-secret}}]
```

## 5. Best Practices

- ✅ Keep all config out of images (12-factor).
- ✅ Use Secrets for credentials; enable etcd encryption at rest.
- ✅ Prefer external secret managers (Vault, cloud KMS) for prod.
- ✅ Restrict access via RBAC.
- ✅ Mount config as files when hot-reload is desired.

## 6. Common Pitfalls

1. ⚠️ Treating base64 as encryption (it isn't).
2. ⚠️ Committing Secret manifests to git in plaintext.
3. ⚠️ Baking config into images.
4. ⚠️ Broad RBAC exposing all Secrets.
5. ⚠️ Env-var secrets leaking via crash dumps/logs.
6. ⚠️ Forgetting pods need restart for env (not file) updates.

## 7. Interview Questions

1. **Q: ConfigMap vs Secret?**
   A: Both store key/values for injection; Secrets are for sensitive data (base64, RBAC-restricted, encryptable at rest).

2. **Q: Are Secrets encrypted?**
   A: Base64-encoded by default; enable encryption at rest and/or use an external secret manager.

3. **Q: How are they consumed?**
   A: As environment variables or mounted as files in the pod.

4. **Q: Why externalize config?**
   A: 12-factor: same image across environments, config injected at runtime.

5. **Q: Do env updates hot-reload?**
   A: No — changing a ConfigMap doesn't update env in a running pod; mounted files can update.

6. **Q: How to secure Secrets?**
   A: RBAC, encryption at rest, external managers, and avoid logging them.

7. **Q: Risk of committing Secrets to git?**
   A: Plaintext/base64 exposure; use sealed-secrets or external stores.

8. **Q: envFrom vs valueFrom?**
   A: envFrom injects all keys; valueFrom maps a single key to a variable.

## 8. Practice

- [ ] Inject a ConfigMap as env and a Secret as a file.
- [ ] Enable a hot-reloadable mounted config.
- [ ] Restrict Secret access via RBAC.

## 9. Quick Revision

ConfigMaps (config) + Secrets (sensitive, base64/RBAC/encrypt-at-rest) inject as env or files. Keep config out of images; use external secret managers in prod; env changes need restart, files can hot-reload.

**References:** ConfigMaps; Secrets

---

*Kubernetes Handbook — topic 06.*
