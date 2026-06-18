# 10 · Deployment & Production

> **In one line:** Run Django with WSGI/ASGI, static files, and safe settings.

---

## 1. Overview

Production Django runs behind a WSGI/ASGI server (Gunicorn/Uvicorn) and a reverse proxy (Nginx). You must set `DEBUG=False`, configure `ALLOWED_HOSTS`, serve **static**/media files properly (WhiteNoise/CDN), and externalize secrets.

## 2. Key Concepts

- Gunicorn (WSGI) / Uvicorn (ASGI) run the app; Nginx proxies.
- collectstatic gathers static assets; WhiteNoise or a CDN serves them.
- DEBUG=False + ALLOWED_HOSTS are mandatory.
- Use environment variables for secrets/DB URLs.
- Run migrate on deploy; use health checks.

## 3. Syntax & Code

```bash
python manage.py collectstatic --noinput
python manage.py migrate --noinput
gunicorn myproject.wsgi:application --workers 3 --bind 0.0.0.0:8000
```

## 4. Worked Example

**Deployment checklist**

Run Django's own check:

```bash
python manage.py check --deploy
# flags insecure settings: DEBUG, SECRET_KEY, SSL, cookies, HSTS
```

## 5. Best Practices

- ✅ Set DEBUG=False and a strict ALLOWED_HOSTS.
- ✅ Keep SECRET_KEY and DB creds in env/secret manager.
- ✅ Serve static via WhiteNoise or a CDN, not Django in prod.
- ✅ Size Gunicorn workers (~2*cores+1); add a timeout.
- ✅ Add structured logging, health checks, and monitoring.

## 6. Common Pitfalls

1. ⚠️ Shipping with DEBUG=True.
2. ⚠️ Serving static files through Django in production.
3. ⚠️ Hardcoded secrets in settings.
4. ⚠️ Too few/many Gunicorn workers.
5. ⚠️ Forgetting migrate/collectstatic in the deploy pipeline.
6. ⚠️ No HTTPS/HSTS.

## 7. Interview Questions

1. **Q: WSGI vs ASGI?**
   A: WSGI is the sync server interface (Gunicorn); ASGI supports async/websockets (Uvicorn/Daphne).

2. **Q: Why DEBUG=False in prod?**
   A: DEBUG leaks tracebacks/settings and disables some security; it's an info-disclosure risk.

3. **Q: How are static files served?**
   A: collectstatic gathers them; WhiteNoise or a CDN/reverse proxy serves them efficiently.

4. **Q: Where do secrets go?**
   A: Environment variables or a secret manager — never in code/VCS.

5. **Q: How many Gunicorn workers?**
   A: Roughly 2*CPU+1, tuned by load and request profile; add timeouts.

6. **Q: What does check --deploy do?**
   A: Audits settings for production security issues.

7. **Q: How to achieve zero-downtime deploys?**
   A: Rolling restarts, backward-compatible migrations, health checks, and a load balancer.

8. **Q: Role of Nginx?**
   A: Reverse proxy: TLS termination, static serving, buffering, and load distribution.

## 8. Practice

- [ ] Run collectstatic + migrate + gunicorn locally.
- [ ] Run check --deploy and fix flagged issues.
- [ ] Configure WhiteNoise for static files.

## 9. Quick Revision

Prod Django: Gunicorn/Uvicorn behind Nginx, DEBUG=False, strict ALLOWED_HOSTS, secrets in env, static via WhiteNoise/CDN, migrate on deploy, run check --deploy, HTTPS/HSTS, monitoring.

**References:** Deployment checklist

---

*Django Handbook — topic 10.*
