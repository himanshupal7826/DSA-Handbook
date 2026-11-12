# 44 · Secrets Management & PII Handling

> **In one line:** An AI automation multiplies the places where keys and personal data end up: prompts, provider logs, traces, caches, vector stores, CI logs. Keep secrets out of code and out of model reach, inject and rotate them from a secret manager, detect and redact or pseudonymise PII before it leaves your process, and give every copy a retention period and an erase path.

> **Versions used:** presidio-analyzer / presidio-anonymizer 2.2.366 with spaCy 3.8 (`en_core_web_sm`) · pydantic 2.14 · pydantic-settings 2.16 · hvac 2.4 · boto3 1.x · anthropic 2.8 · openai 3.x · python-dotenv 1.x · gitleaks 8.x · Python 3.11+ (verified Nov 2026) · **Fast-moving:** provider data-retention terms and zero-data-retention eligibility, regional processing options, EU AI Act guidance, and secret-scanning rule sets. This chapter is engineering guidance, not legal advice: involve your DPO or counsel for compliance decisions.

---

## 1. Overview

> **Builds on:** [Ch 39 · Deploy with Docker & CI/CD](topic.html?p=39-deploy-docker-cicd) (where secrets get injected), [Ch 40 · Monitoring](topic.html?p=40-observability-langsmith-langfuse) (traces are copies of your data), [Ch 43 · Prompt Injection & Sandboxing](topic.html?p=43-prompt-injection-sandboxing) (a hijacked model will try to read secrets). Docker specifics: [Docker · Secrets](../docker/topic.html?p=24-secrets).

You already keep database passwords out of git and know not to log credit card numbers. Two things make AI automations harder:

1. **More secrets, more powerful ones.** An automation holds model API keys (billable by the minute), CRM and email tokens, a Langfuse secret key, webhook signing secrets, cloud credentials. A leaked LLM key is drained within hours by bots that scan GitHub.
2. **Personal data flows to more places by design.** The whole point is to send a customer's email to a model. That one email can then live in the provider's logs, your trace store, your response cache, your vector database, your n8n execution history and your application logs, each with its own retention and access rules.

The data path, and where each control sits:

```mermaid
flowchart LR
    SM["Secret manager: Vault, AWS, Infisical"] -->|"inject at runtime"| APP["Automation process"]
    IN["Inbound email, form, ticket: contains PII"] --> APP
    APP --> DET["PII detection: Presidio"]
    DET --> PS["Pseudonymise: PERSON_1, EMAIL_1, vault stays local"]
    PS --> LLM["LLM provider: zero retention where available"]
    LLM --> RS["Restore placeholders"]
    RS --> ACT["Action: reply, CRM update"]
    APP --> LOG["Logs: redacting filter"]
    APP --> TR["Traces: mask before export"]
    APP --> VDB["Vector store and caches: TTL + delete by subject id"]
    ACT --> AUD["Audit log: who, what, when, no raw PII"]
```

---

## 2. Key Concepts

**Secrets**

- **Secret**: anything that grants access: API keys, OAuth refresh tokens, DB passwords, webhook signing secrets, private keys. Not secret: model names, URLs, feature flags (keep those in normal config).
- **Secret lifecycle**: create → store → inject → use → **rotate** → revoke → audit. Most leaks happen at "store" (git, Slack, tickets) and "use" (logs, error messages, traces).
- **Injection, not embedding**: the app receives secrets at runtime as environment variables or mounted files (`/run/secrets/...`). Images, repos and prompts never contain them.
- **Secret manager**: a service that stores, versions, audits and rotates secrets: HashiCorp Vault or its open-source fork **OpenBao**, **Infisical** (open source), AWS Secrets Manager, Google Secret Manager, Azure Key Vault, Doppler and 1Password (paid). **SOPS + age** encrypts secrets files in git for small teams.
- **Workload identity**: instead of a long-lived cloud key, the workload proves who it is (Kubernetes service account, GitHub Actions OIDC, an instance role) and gets short-lived credentials. Best for cloud access; LLM provider keys are usually still static keys you must rotate.
- **Least privilege for keys**: one key per service and environment, project-scoped, with spend limits where the provider supports them, so a leak has a small blast radius and a clear owner.
- **Secret scanning**: gitleaks, detect-secrets or TruffleHog in pre-commit and CI; GitHub push protection on the server side.

**Personal data**

- **PII / personal data**: anything that identifies a person directly (name, email, phone) or indirectly (order id + postcode, IP address). Under GDPR, **special categories** (health, religion, biometrics...) need extra care.
- **Redaction**: remove or replace the value irreversibly (`<EMAIL>`). **Masking**: partial (`****1111`). **Pseudonymisation**: replace with a consistent token that you can reverse with a separately held key or mapping. **Anonymisation**: irreversible so that no one can re-identify. Under GDPR, pseudonymised data **is still personal data**; only true anonymisation takes it out of scope.
- **Data minimisation**: send the model only what the task needs. A triage classifier doesn't need the customer's phone number.
- **Processors and DPAs**: an LLM provider processing your customers' data is a (sub)processor; you need a data processing agreement and to list them in your records.
- **Provider data controls**: check each provider's commercial terms for API data use, retention period for abuse monitoring, zero-data-retention eligibility and regional processing. Don't assume; read the current policy page for your plan.
- **Retention and erasure**: every store holding personal data needs a retention period and a way to find and delete one person's records (data subject requests).

> **Analogy:** a hotel. Secrets are room keys: issued per guest and per room, handed over at check-in (injection), changed when lost (rotation), and never written on the door (code). Personal data is the guest register: front desk staff see names, housekeeping sees room numbers only (minimisation), the register is shredded after the legally required period (retention), and a guest can ask to be removed (erasure).

Where copies of personal data accumulate in a typical LLM automation, and the control for each:

```svg
<svg viewBox="0 0 880 330" width="100%" height="330" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs><marker id="aa44a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#334155"/></marker></defs>
  <text x="440" y="22" text-anchor="middle" font-size="14" font-weight="700" fill="#1e293b">One customer email, seven copies: give each a control</text>
  <rect x="20" y="130" width="150" height="70" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="95" y="158" text-anchor="middle" font-weight="700" fill="#1e293b">Inbound email</text>
  <text x="95" y="176" text-anchor="middle" fill="#334155">name, email, order</text>
  <rect x="230" y="130" width="160" height="70" rx="8" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="310" y="158" text-anchor="middle" font-weight="700" fill="#1e293b">Your process</text>
  <text x="310" y="176" text-anchor="middle" fill="#334155">detect + pseudonymise</text>
  <line x1="170" y1="165" x2="228" y2="165" stroke="#334155" stroke-width="1.5" marker-end="url(#aa44a)"/>
  <rect x="470" y="40" width="190" height="44" rx="6" fill="#fef3c7" stroke="#d97706"/>
  <text x="565" y="58" text-anchor="middle" font-weight="700" fill="#1e293b">LLM provider</text>
  <text x="565" y="74" text-anchor="middle" fill="#334155">placeholders only, ZDR, DPA</text>
  <rect x="470" y="94" width="190" height="44" rx="6" fill="#fef3c7" stroke="#d97706"/>
  <text x="565" y="112" text-anchor="middle" font-weight="700" fill="#1e293b">Traces</text>
  <text x="565" y="128" text-anchor="middle" fill="#334155">mask before export, 30-day TTL</text>
  <rect x="470" y="148" width="190" height="44" rx="6" fill="#fef3c7" stroke="#d97706"/>
  <text x="565" y="166" text-anchor="middle" font-weight="700" fill="#1e293b">App logs</text>
  <text x="565" y="182" text-anchor="middle" fill="#334155">redacting log filter</text>
  <rect x="470" y="202" width="190" height="44" rx="6" fill="#fef3c7" stroke="#d97706"/>
  <text x="565" y="220" text-anchor="middle" font-weight="700" fill="#1e293b">Response cache</text>
  <text x="565" y="236" text-anchor="middle" fill="#334155">key on pseudonymised text, TTL</text>
  <rect x="470" y="256" width="190" height="44" rx="6" fill="#fef3c7" stroke="#d97706"/>
  <text x="565" y="274" text-anchor="middle" font-weight="700" fill="#1e293b">Vector store</text>
  <text x="565" y="290" text-anchor="middle" fill="#334155">subject_id metadata, delete by id</text>
  <line x1="390" y1="150" x2="468" y2="62" stroke="#334155" stroke-width="1.2" marker-end="url(#aa44a)"/>
  <line x1="390" y1="158" x2="468" y2="116" stroke="#334155" stroke-width="1.2" marker-end="url(#aa44a)"/>
  <line x1="390" y1="168" x2="468" y2="170" stroke="#334155" stroke-width="1.2" marker-end="url(#aa44a)"/>
  <line x1="390" y1="176" x2="468" y2="224" stroke="#334155" stroke-width="1.2" marker-end="url(#aa44a)"/>
  <line x1="390" y1="184" x2="468" y2="278" stroke="#334155" stroke-width="1.2" marker-end="url(#aa44a)"/>
  <rect x="710" y="94" width="150" height="70" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="785" y="120" text-anchor="middle" font-weight="700" fill="#1e293b">Pseudonym vault</text>
  <text x="785" y="138" text-anchor="middle" fill="#334155">per request, in memory</text>
  <text x="785" y="152" text-anchor="middle" fill="#334155">or encrypted, short TTL</text>
  <rect x="710" y="190" width="150" height="70" rx="8" fill="#fee2e2" stroke="#dc2626"/>
  <text x="785" y="216" text-anchor="middle" font-weight="700" fill="#1e293b">Erasure job</text>
  <text x="785" y="234" text-anchor="middle" fill="#334155">find + delete by</text>
  <text x="785" y="248" text-anchor="middle" fill="#334155">subject id everywhere</text>
  <line x1="390" y1="140" x2="708" y2="125" stroke="#16a34a" stroke-width="1.2" stroke-dasharray="4 3" marker-end="url(#aa44a)"/>
  <line x1="662" y1="250" x2="708" y2="230" stroke="#dc2626" stroke-width="1.2" stroke-dasharray="4 3" marker-end="url(#aa44a)"/>
</svg>
```

---

## 3. Setup

```bash
pip install "presidio-analyzer>=2.2,<3" "presidio-anonymizer>=2.2,<3" "pydantic>=2.7,<3" \
            "pydantic-settings>=2.4,<3" "python-dotenv>=1" "anthropic>=2.8,<3"
python -m spacy download en_core_web_sm       # ~13 MB; en_core_web_lg detects names better (~400 MB)
pip install "hvac>=2.4,<3" "boto3>=1.34"      # only if you use Vault/OpenBao or AWS Secrets Manager
brew install gitleaks                          # or download a release binary; also runs as pre-commit
```

```bash
# .env.example — chapter 44   (copy to .env for LOCAL DEV ONLY; .env is in .gitignore)
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
LLM_BASE_URL=http://localhost:11434/v1
LLM_API_KEY=ollama
LLM_MODEL=llama3.2
CLAUDE_MODEL=claude-sonnet-5-5

SECRETS_BACKEND=env                 # env | aws | vault
SECRETS_DIR=/run/secrets            # Docker/Kubernetes secret mount
SECRETS_CACHE_TTL_S=300
VAULT_ADDR=http://127.0.0.1:8200
VAULT_ROLE_ID=
VAULT_SECRET_ID=
AWS_REGION=eu-west-1

PII_MODE=pseudonymise               # off | redact | pseudonymise
PII_SCORE_THRESHOLD=0.4
RETENTION_DAYS=30
```

Commit `.env.example` with empty values; add `.env`, `*.pem`, `secrets/` to `.gitignore`. Every script uses `load_dotenv()` for local development; in production the same variable names are injected by the platform, so code doesn't change between environments.

---

## 4. Code Examples

### Example 1: Typed settings with `SecretStr`

`SecretStr` keeps a secret from showing up in `print`, `repr`, logs, tracebacks and serialised config dumps, which is where most accidental leaks happen.

```python
# settings.py — typed config: secrets come from env vars or mounted secret files, never code
from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", secrets_dir=None, extra="ignore")

    anthropic_api_key: SecretStr | None = None
    openai_api_key: SecretStr | None = None
    langfuse_secret_key: SecretStr | None = None
    database_url: SecretStr = Field(default=SecretStr("sqlite:///dev.db"))
    llm_model: str = "llama3.2"
    pii_mode: str = "pseudonymise"          # off | redact | pseudonymise


if __name__ == "__main__":
    import os
    os.environ["ANTHROPIC_API_KEY"] = "sk-ant-demo-not-real"         # simulates the deployment env
    s = Settings()
    print(s)                                                          # secrets are masked
    print(repr(s.anthropic_api_key))
    print(s.model_dump_json(include={"anthropic_api_key", "llm_model"}))
    key = s.anthropic_api_key.get_secret_value()                      # explicit, greppable unwrap
    print("unwrapped length:", len(key))
```

```text
anthropic_api_key=SecretStr('**********') openai_api_key=None langfuse_secret_key=None database_url=SecretStr('**********') llm_model='llama3.2' pii_mode='pseudonymise'
SecretStr('**********')
{"anthropic_api_key":"**********","llm_model":"llama3.2"}
unwrapped length: 20
```

Set `secrets_dir="/run/secrets"` in production and pydantic-settings reads `/run/secrets/anthropic_api_key` as a file. Pass the unwrapped value straight into the SDK constructor (`anthropic.Anthropic(api_key=s.anthropic_api_key.get_secret_value())`) and never store it in another variable that might get logged.

### Example 2: One `get_secret()` for every environment

Local dev reads `.env`; Docker and Kubernetes mount files; production may use a secret manager. Hide that behind one function with a short cache so **rotated secrets propagate** without a restart.

```python
# secrets_loader.py — one get_secret() for every environment: env → mounted file → secret manager
import os
import time
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()                                   # local dev only; prod injects real env/files
SECRETS_DIR = Path(os.getenv("SECRETS_DIR", "/run/secrets"))   # Docker/K8s mount point
BACKEND = os.getenv("SECRETS_BACKEND", "env")                   # env | aws | vault
TTL_S = int(os.getenv("SECRETS_CACHE_TTL_S", "300"))            # re-read so rotation propagates
_cache: dict[str, tuple[float, str]] = {}


def _from_aws(name: str) -> str:
    import boto3                                                 # pip install boto3
    client = boto3.client("secretsmanager", region_name=os.getenv("AWS_REGION", "eu-west-1"))
    return client.get_secret_value(SecretId=name)["SecretString"]


def _from_vault(name: str) -> str:
    import hvac                                                  # pip install hvac (works with OpenBao too)
    client = hvac.Client(url=os.environ["VAULT_ADDR"])
    client.auth.approle.login(role_id=os.environ["VAULT_ROLE_ID"],
                              secret_id=os.environ["VAULT_SECRET_ID"])
    resp = client.secrets.kv.v2.read_secret_version(path=name, mount_point="secret",
                                                    raise_on_deleted_version=True)
    return resp["data"]["data"]["value"]                         # convention: one key named "value"


def get_secret(name: str, secrets_dir: Path | None = None) -> str:
    """name like 'anthropic_api_key'. Raises KeyError if missing: fail fast at startup."""
    now, folder = time.monotonic(), secrets_dir or SECRETS_DIR
    if (hit := _cache.get(name)) and now - hit[0] < TTL_S:
        return hit[1]
    value = os.getenv(name.upper())
    if value is None and (folder / name).is_file():
        value = (folder / name).read_text().strip()
    if value is None and BACKEND == "aws":
        value = _from_aws(name)
    if value is None and BACKEND == "vault":
        value = _from_vault(name)
    if not value:
        raise KeyError(f"secret {name!r} not found (env, {folder.name or folder}, {BACKEND})")
    _cache[name] = (now, value)
    return value


if __name__ == "__main__":
    import tempfile
    os.environ["ANTHROPIC_API_KEY"] = "sk-ant-from-env"
    print(get_secret("anthropic_api_key")[:10] + "...")
    with tempfile.TemporaryDirectory() as d:                     # simulate a Docker secret mount
        (Path(d) / "db_password").write_text("s3cr3t-from-file\n")
        print(get_secret("db_password", secrets_dir=Path(d))[:6] + "...")
    try:
        get_secret("missing_key", secrets_dir=Path("/nonexistent"))
    except KeyError as e:
        print("KeyError:", e)
```

```text
sk-ant-fro...
s3cr3t...
KeyError: "secret 'missing_key' not found (env, nonexistent, env)"
```

Call `get_secret()` for every required secret **at startup** so a missing one crashes the deploy, not the first customer request at 3 a.m. Note that the error message names the secret but never prints a value.

### Example 3: Docker Compose secrets instead of environment variables

Environment variables are visible to `docker inspect`, child processes and crash reporters. File-mounted secrets are narrower: only the services you list can read them.

```yaml
# compose.yaml — secrets as files under /run/secrets, not env vars
services:
  triage:
    build: .
    environment:
      SECRETS_DIR: /run/secrets
      LLM_MODEL: llama3.2
    secrets:
      - anthropic_api_key
      - langfuse_secret_key
  n8n:
    image: docker.n8n.io/n8nio/n8n:latest
    environment:
      N8N_ENCRYPTION_KEY_FILE: /run/secrets/n8n_encryption_key
    secrets:
      - n8n_encryption_key
secrets:
  anthropic_api_key:
    file: ./secrets/anthropic_api_key.txt        # gitignored; created by your deploy tooling
  langfuse_secret_key:
    file: ./secrets/langfuse_secret_key.txt
  n8n_encryption_key:
    file: ./secrets/n8n_encryption_key.txt
```

Many images (n8n, Postgres) support a `_FILE` suffix convention for reading a variable's value from a file; check each image's docs. In Kubernetes, the equivalent is a `Secret` mounted as a volume, ideally synced from your secret manager by the External Secrets Operator.

### Example 4: Zero-downtime key rotation

Rotation is only painless if the app tolerates two valid keys at once. The pattern: create the new key, deploy it as primary with the old one as fallback, watch traffic move, then revoke the old one.

```python
# rotating_client.py — try the primary key; on an auth failure, fall back and alert
import logging
import os
from typing import Callable

from dotenv import load_dotenv

load_dotenv()
log = logging.getLogger("keys")


class AuthError(Exception):
    """Stand-in; in real code catch anthropic.AuthenticationError / openai.AuthenticationError."""


class RotatingKeys:
    def __init__(self, primary_env: str, secondary_env: str):
        self.keys = [k for k in (os.getenv(primary_env), os.getenv(secondary_env)) if k]
        if not self.keys:
            raise KeyError(f"set {primary_env} (and optionally {secondary_env})")

    def call(self, fn: Callable[[str], str]) -> str:
        last: Exception | None = None
        for i, key in enumerate(self.keys):
            try:
                result = fn(key)
                if i > 0:
                    log.warning("primary key rejected; served by fallback key #%d. Rotate now.", i)
                return result
            except AuthError as exc:          # 401 only. Never fall back on 429/5xx.
                last = exc
        raise RuntimeError("all keys rejected") from last


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    os.environ["LLM_KEY_PRIMARY"], os.environ["LLM_KEY_SECONDARY"] = "revoked-key", "new-key"

    def fake_llm(key: str) -> str:            # real code: anthropic.Anthropic(api_key=key).messages.create(...)
        if key == "revoked-key":
            raise AuthError("401 invalid x-api-key")
        return "BILLING"

    print(RotatingKeys("LLM_KEY_PRIMARY", "LLM_KEY_SECONDARY").call(fake_llm))
```

```text
WARNING primary key rejected; served by fallback key #1. Rotate now.
BILLING
```

Rotate on a schedule (every 60–90 days for static keys) **and** immediately when someone leaves, a laptop is lost, or a scanner flags a leak. When a key leaks, revoke first and investigate second: bots exploit leaked LLM keys within minutes.

### Example 5: A logging filter that scrubs secrets and PII

Exceptions from HTTP clients love to include headers and URLs. Put a redacting filter on the **handler** so every logger, including third-party libraries, passes through it.

```python
# log_redaction.py — a logging filter that scrubs secrets and obvious PII from every record
import logging
import re

REDACTIONS = [
    (re.compile(r"\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{8,}"), "sk-***"),               # OpenAI/Anthropic-style
    (re.compile(r"\b(?:pk|sk)-lf-[A-Za-z0-9-]{6,}"), "lf-***"),                       # Langfuse
    (re.compile(r"\bAKIA[0-9A-Z]{16}\b"), "AKIA***"),                                 # AWS access key id
    (re.compile(r"(?i)(authorization:\s*bearer\s+)[^\s\"']+"), r"\1***"),
    (re.compile(r"(?i)\b(password|passwd|secret|token|api_key)=([^\s&]+)"), r"\1=***"),
    (re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+"), "<email>"),
    (re.compile(r"\b(?:\d[ -]?){13,16}\b"), "<card>"),
]


def scrub(text: str) -> str:
    for rx, repl in REDACTIONS:
        text = rx.sub(repl, text)
    return text


class RedactingFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        record.msg = scrub(record.getMessage())
        record.args = ()                     # message already formatted with args
        return True


def setup_logging() -> logging.Logger:
    handler = logging.StreamHandler()
    handler.addFilter(RedactingFilter())     # on the handler: covers every logger that uses it
    handler.setFormatter(logging.Formatter("%(levelname)s %(name)s: %(message)s"))
    logging.basicConfig(level=logging.INFO, handlers=[handler], force=True)
    return logging.getLogger("triage")


if __name__ == "__main__":
    log = setup_logging()
    log.info("calling LLM with key %s", "sk-ant-api03-AbCdEfGh123456")
    log.info("headers={'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.x.y'}")
    log.info("POST /hook?token=abc123&user=jane.doe@example.com card 4111 1111 1111 1111")
    log.warning("retrying with AKIAIOSFODNN7EXAMPLE password=hunter2")
```

```text
INFO triage: calling LLM with key sk-***
INFO triage: headers={'Authorization: Bearer ***'}
INFO triage: POST /hook?token=***&user=<email> card <card>
WARNING triage: retrying with AKIA*** password=***
```

Regexes are a safety net for well-formatted values. Keep the stronger rule too: don't log request bodies or prompts at INFO level at all; put them in traces with masking ([Ch 40](topic.html?p=40-observability-langsmith-langfuse), Example 5) where access is controlled.

### Example 6: Detecting PII with Presidio

**Presidio** (Microsoft, MIT licence) combines NER models, regexes with checksums (credit cards, IBANs) and context words. It runs fully locally, which matters: sending text to a cloud API to find out whether it contains PII defeats the purpose.

```python
# pii_detect.py — detect and redact PII with Presidio (offline, small spaCy model)
from presidio_analyzer import AnalyzerEngine, Pattern, PatternRecognizer
from presidio_analyzer.nlp_engine import NlpEngineProvider
from presidio_anonymizer import AnonymizerEngine
from presidio_anonymizer.entities import OperatorConfig

ENTITIES = ["PERSON", "EMAIL_ADDRESS", "PHONE_NUMBER", "CREDIT_CARD", "IBAN_CODE",
            "IP_ADDRESS", "US_SSN", "ORDER_ID"]


def build_analyzer(model: str = "en_core_web_sm") -> AnalyzerEngine:
    nlp = NlpEngineProvider(nlp_configuration={
        "nlp_engine_name": "spacy", "models": [{"lang_code": "en", "model_name": model}]}).create_engine()
    analyzer = AnalyzerEngine(nlp_engine=nlp, supported_languages=["en"])
    analyzer.registry.add_recognizer(PatternRecognizer(          # your own identifiers
        supported_entity="ORDER_ID", patterns=[Pattern("order", r"\bORD-\d{6}\b", 0.9)]))
    return analyzer


analyzer = build_analyzer()
anonymizer = AnonymizerEngine()

if __name__ == "__main__":
    text = ("Hi, I'm Priya Sharma (priya.sharma@example.com, +1 415-555-0132). "
            "Card 4111 1111 1111 1111 was charged twice for ORD-123456. My IP is 10.0.0.12.")
    results = analyzer.analyze(text=text, language="en", entities=ENTITIES, score_threshold=0.4)
    for r in sorted(results, key=lambda r: r.start):
        print(f"{r.entity_type:14} {text[r.start:r.end]!r:28} score={r.score:.2f}")
    redacted = anonymizer.anonymize(text=text, analyzer_results=results, operators={
        "DEFAULT": OperatorConfig("replace", {"new_value": "<REDACTED>"}),
        "PERSON": OperatorConfig("replace", {"new_value": "<PERSON>"}),
        "EMAIL_ADDRESS": OperatorConfig("replace", {"new_value": "<EMAIL>"}),
        "CREDIT_CARD": OperatorConfig("mask", {"masking_char": "*", "chars_to_mask": 15, "from_end": False}),
        "ORDER_ID": OperatorConfig("keep", {}),                 # needed by the automation
    })
    print(redacted.text)
```

```text
PERSON         'Priya Sharma'               score=0.85
EMAIL_ADDRESS  'priya.sharma@example.com'   score=1.00
PHONE_NUMBER   '+1 415-555-0132'            score=0.40
CREDIT_CARD    '4111 1111 1111 1111'        score=1.00
ORDER_ID       'ORD-123456'                 score=0.90
IP_ADDRESS     '10.0.0.12'                  score=0.95
Hi, I'm <PERSON> (<EMAIL>, <REDACTED>). Card ***************1111 was charged twice for ORD-123456. My IP is <REDACTED>.
```

Three things to notice from this real run:
- **Pass an explicit `entities` list.** Without it, the small model also reported `URL` matches inside the email address, an `ORGANIZATION` for "IP 10.0.0.12" and a 0.01-confidence `US_DRIVER_LICENSE`. Ask only for what your policy covers.
- **Thresholds are a trade-off.** The phone number scored exactly 0.40; at 0.5 it would have leaked. Tune on your own labelled samples and measure recall, not just precision.
- **Custom recognizers** for your own identifiers (order ids, employee ids, policy numbers) are a few lines and often the most valuable ones.

### Example 7: Reversible pseudonymisation around an LLM call

Redaction breaks tasks that need to refer to people ("reply to Priya"). **Pseudonymisation** replaces each value with a consistent placeholder, sends that to the model, and restores the real values in the reply. The mapping (the "vault") never leaves your process.

```python
# pseudonymise.py — consistent placeholders before the LLM, restore after (vault stays local)
from presidio_analyzer import PatternRecognizer
from presidio_anonymizer.entities import OperatorConfig

from pii_detect import ENTITIES, analyzer, anonymizer


class Vault:
    """Maps real values to stable placeholders for ONE request/conversation."""

    def __init__(self) -> None:
        self.forward: dict[tuple[str, str], str] = {}
        self.reverse: dict[str, str] = {}

    def placeholder(self, entity: str, value: str) -> str:
        key = (entity, value)
        if key not in self.forward:
            n = sum(1 for e, _ in self.forward if e == entity) + 1
            token = f"<{entity}_{n}>"
            self.forward[key], self.reverse[token] = token, value
        return self.forward[key]

    def restore(self, text: str) -> str:
        for token, value in sorted(self.reverse.items(), key=lambda kv: -len(kv[0])):
            text = text.replace(token, value)
        return text


def pseudonymise(text: str, vault: Vault, known_names: list[str] | None = None,
                 keep: frozenset[str] = frozenset({"ORDER_ID"})) -> str:
    # NER misses names; you usually KNOW the customer's name from the CRM, so add it explicitly.
    extra = ([PatternRecognizer(supported_entity="PERSON", deny_list=known_names)]
             if known_names else [])
    results = analyzer.analyze(text=text, language="en", entities=ENTITIES, score_threshold=0.4,
                               ad_hoc_recognizers=extra)
    operators = {e: OperatorConfig("custom", {"lambda": (lambda v, e=e: vault.placeholder(e, v))})
                 for e in ENTITIES if e not in keep}
    operators |= {e: OperatorConfig("keep", {}) for e in keep}
    return anonymizer.anonymize(text=text, analyzer_results=results, operators=operators).text


if __name__ == "__main__":
    vault = Vault()
    email = ("From Priya Sharma <priya.sharma@example.com>: my colleague John Miller and I were "
             "both charged for ORD-123456. Please reply to priya.sharma@example.com.")
    print("NER only:", pseudonymise(email, Vault()))
    safe = pseudonymise(email, vault, known_names=["Priya Sharma"])   # sender name from the CRM
    print("to LLM  :", safe)
    llm_reply = "Hi <PERSON_2>, we've refunded ORD-123456 and sent confirmation to <EMAIL_ADDRESS_1>."
    print("to user :", vault.restore(llm_reply))
```

```text
NER only: From Priya Sharma <<EMAIL_ADDRESS_1>>: my colleague <PERSON_1> and I were both charged for ORD-123456. Please reply to <EMAIL_ADDRESS_1>.
to LLM  : From <PERSON_2> <<EMAIL_ADDRESS_1>>: my colleague <PERSON_1> and I were both charged for ORD-123456. Please reply to <EMAIL_ADDRESS_1>.
to user : Hi Priya Sharma, we've refunded ORD-123456 and sent confirmation to priya.sharma@example.com.
```

The first line is the important lesson: the small spaCy model **missed "Priya Sharma"** in the `From` header but caught "John Miller" in a sentence. NER recall depends on context and model size. Defences, in order of value: add names you already know (sender, account holder) via `deny_list`; use a larger model (`en_core_web_lg` or a transformer-based NER) for production; and measure recall on a labelled sample of your own emails. Repeated values get the same placeholder (`<EMAIL_ADDRESS_1>` twice), so the model can still reason about who is who.

> **Gotcha:** placeholders must survive the model. Tell it in the system prompt to copy tokens like `<PERSON_2>` exactly, and check the reply for unknown or mangled tokens before restoring. If the model invents `<PERSON_3>`, don't send that reply.

### Example 8: Retention and erasure for the copies you keep

Every store with personal data needs a TTL and a delete-by-subject path. Key everything by a stable `subject_id` (your customer id), never by email address.

```python
# retention.py — TTL purge + right-to-erasure across your own stores (SQLite demo, runs offline)
import sqlite3
import time

DAY = 86_400


def init(db: sqlite3.Connection) -> None:
    db.executescript("""
    CREATE TABLE IF NOT EXISTS llm_calls (id INTEGER PRIMARY KEY, subject_id TEXT, created REAL,
                                          prompt_pseudo TEXT, reply_pseudo TEXT);
    CREATE TABLE IF NOT EXISTS audit (ts REAL, action TEXT, subject_id TEXT, rows INTEGER);
    CREATE INDEX IF NOT EXISTS ix_calls_subject ON llm_calls(subject_id);
    """)


def purge_expired(db: sqlite3.Connection, retention_days: int) -> int:
    cur = db.execute("DELETE FROM llm_calls WHERE created < ?", (time.time() - retention_days * DAY,))
    db.execute("INSERT INTO audit VALUES (?, 'ttl_purge', NULL, ?)", (time.time(), cur.rowcount))
    return cur.rowcount


def erase_subject(db: sqlite3.Connection, subject_id: str, extra_stores=()) -> int:
    """Data subject request: delete everywhere you can, record THAT you did (not the data)."""
    n = db.execute("DELETE FROM llm_calls WHERE subject_id = ?", (subject_id,)).rowcount
    for delete in extra_stores:            # e.g. vector store, cache, trace backend API calls
        n += delete(subject_id)
    db.execute("INSERT INTO audit VALUES (?, 'erasure', ?, ?)", (time.time(), subject_id, n))
    return n


if __name__ == "__main__":
    db = sqlite3.connect(":memory:")
    init(db)
    now = time.time()
    db.executemany("INSERT INTO llm_calls (subject_id, created, prompt_pseudo, reply_pseudo) VALUES (?,?,?,?)", [
        ("cust-1", now - 45 * DAY, "<PERSON_1> asks about ORD-1", "..."),
        ("cust-1", now - 2 * DAY, "<PERSON_1> asks again", "..."),
        ("cust-2", now - 1 * DAY, "<PERSON_1> wants a refund", "..."),
    ])
    fake_vector_delete = lambda sid: 3 if sid == "cust-2" else 0   # chroma: collection.delete(where={"subject_id": sid})
    print("ttl purged:", purge_expired(db, retention_days=30))
    print("erased cust-2:", erase_subject(db, "cust-2", extra_stores=[fake_vector_delete]))
    print("remaining:", db.execute("SELECT subject_id, prompt_pseudo FROM llm_calls").fetchall())
    print("audit:", [(a, s, r) for _, a, s, r in db.execute("SELECT * FROM audit")])
```

```text
ttl purged: 1
erased cust-2: 4
remaining: [('cust-1', '<PERSON_1> asks again')]
audit: [('ttl_purge', None, 1), ('erasure', 'cust-2', 4)]
```

Make the erasure function the single place that knows every store: your DB, the vector store (Chroma: `collection.delete(where={"subject_id": ...})`, [Ch 18](topic.html?p=18-vector-databases)), Redis caches, the trace backend (Langfuse and LangSmith have delete APIs and per-project retention settings), n8n execution data (`EXECUTIONS_DATA_MAX_AGE` / pruning settings, [Ch 09](topic.html?p=09-n8n-fundamentals)), and a request to the LLM provider if you didn't have zero retention. Then **test** it with a fake subject end to end.

### Example 9: Stop secrets reaching git and CI logs

Pre-commit secret scanning catches most leaks before they exist. Save as `.pre-commit-config.yaml` and run `pre-commit install`:

```yaml
# .pre-commit-config.yaml
repos:
  - repo: https://github.com/gitleaks/gitleaks
    rev: v8.24.0            # pin; check the releases page for the current tag
    hooks:
      - id: gitleaks
  - repo: https://github.com/pre-commit/pre-commit-hooks
    rev: v5.0.0
    hooks:
      - id: detect-private-key
      - id: check-added-large-files
```

In CI, prefer **OIDC workload identity** over stored cloud keys, and pass LLM keys only to the job steps that need them:

```yaml
# .github/workflows/deploy.yml (excerpt) — no long-lived AWS keys in GitHub
permissions:
  id-token: write          # allow the job to request an OIDC token
  contents: read
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::123456789012:role/deploy-triage
          aws-region: eu-west-1
      - name: Smoke test with the LLM key scoped to this step only
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: python smoke_test.py
```

GitHub masks registered secrets in logs, but not values derived from them (base64, substrings, JSON with the key inside). Don't `echo` them, don't run `set -x` in steps that have them, and never print `env`.

---

## 5. Real-World Use Case

**Who:** a 600-employee company's HR team. **Automation:** an HR helpdesk assistant answers policy questions and drafts replies to employee emails about leave, payroll and benefits, ~400 emails/week. Emails regularly contain health information (sick leave) and bank details, which are special-category or high-risk data.

```mermaid
flowchart TD
    E["Employee email"] --> W["n8n webhook: execution data pruned after 7 days"]
    W --> P["PII gateway: Presidio + employee directory names + IBAN and health term recognizers"]
    P -->|"health terms detected"| H["Route to human HR, no LLM call"]
    P -->|"pseudonymised text"| L["LLM: EU region, zero data retention, DPA signed"]
    L --> R["Restore placeholders, validate no unknown tokens"]
    R --> D["Draft in HR system: human approves every send"]
    P --> T["Langfuse self-hosted in EU: placeholders only, 30-day retention"]
    D --> A["Audit: subject_id, action, timestamp"]
    S["Vault: per-service keys, 60-day rotation"] --> P
    S --> L
```

**Design decisions:** the employee directory feeds a `deny_list` recognizer so every employee's name is caught regardless of NER; a custom "health terms" recognizer routes those emails to a human without any model call (data minimisation beats redaction); the LLM sees only placeholders; traces are self-hosted and masked; a nightly job purges data past retention; the DSAR script deletes across the HR DB, Langfuse, Chroma and n8n. **Numbers:** Presidio with `en_core_web_lg` adds ~40–80 ms per email on one CPU core; about 9% of emails route straight to humans; LLM cost is a few dollars a week at this volume. The compliance review took two meetings instead of a quarter because the data-flow diagram above existed and every store had a documented retention period.

---

## 6. Mini Project: A PII Gateway for LLM Calls (1–2 hours)

**Goal:** a small library every automation can wrap around its LLM calls: secrets from `get_secret()`, PII pseudonymised before the call and restored after, placeholder integrity checked, redacted logs, a pseudonymised audit trail with retention, and tests that prove no raw PII reaches the model.

**File layout**

```text
pii-gateway/
├── .env
├── settings.py          # Example 1
├── secrets_loader.py    # Example 2
├── log_redaction.py     # Example 5
├── pii_detect.py        # Example 6
├── pseudonymise.py      # Example 7
├── retention.py         # Example 8
├── gateway.py           # the wrapper
└── test_gateway.py      # offline tests with a fake model
```

**Step 1: the gateway.** The model call is injected, so tests can use a fake and production can use Ollama, Claude or anything from [Ch 07](topic.html?p=07-multi-provider-routing).

```python
# gateway.py — pseudonymise → call model → verify placeholders → restore → audit
import re
import sqlite3
import time
from typing import Callable

from log_redaction import setup_logging
from pseudonymise import Vault, pseudonymise
from retention import init

log = setup_logging()
TOKEN = re.compile(r"<[A-Z_]+_\d+>")
SYSTEM = ("You draft short customer-support replies. The text contains placeholders like "
          "<PERSON_1> or <EMAIL_ADDRESS_1>. Copy placeholders exactly; never invent new ones.")

ModelFn = Callable[[str, str], str]          # (system, user) -> reply


class PlaceholderError(Exception):
    pass


class PIIGateway:
    def __init__(self, model: ModelFn, db: sqlite3.Connection):
        self.model, self.db = model, db
        init(db)

    def complete(self, subject_id: str, text: str, known_names: list[str] | None = None) -> str:
        vault = Vault()
        safe = pseudonymise(text, vault, known_names=known_names)
        start = time.perf_counter()
        reply = self.model(SYSTEM, safe)
        unknown = set(TOKEN.findall(reply)) - set(vault.reverse)
        if unknown:
            raise PlaceholderError(f"model produced unknown placeholders: {sorted(unknown)}")
        self.db.execute("INSERT INTO llm_calls (subject_id, created, prompt_pseudo, reply_pseudo) "
                        "VALUES (?, ?, ?, ?)", (subject_id, time.time(), safe, reply))
        log.info("llm call subject=%s entities=%d latency_ms=%.0f", subject_id,
                 len(vault.reverse), (time.perf_counter() - start) * 1000)
        return vault.restore(reply)


def ollama_model(system: str, user: str) -> str:
    """Production adapter (free local default). Swap for Claude/OpenAI via Ch 06/07."""
    import os
    from openai import OpenAI
    client = OpenAI(base_url=os.getenv("LLM_BASE_URL", "http://localhost:11434/v1"),
                    api_key=os.getenv("LLM_API_KEY", "ollama"))
    r = client.chat.completions.create(model=os.getenv("LLM_MODEL", "llama3.2"), max_tokens=300,
                                       messages=[{"role": "system", "content": system},
                                                 {"role": "user", "content": user}])
    return r.choices[0].message.content or ""


if __name__ == "__main__":
    from dotenv import load_dotenv
    load_dotenv()
    gw = PIIGateway(ollama_model, sqlite3.connect("gateway.db"))
    print(gw.complete("cust-42", "Hi, this is Priya Sharma (priya.sharma@example.com). "
                      "I was charged twice for ORD-123456, please call +1 415-555-0132.",
                      known_names=["Priya Sharma"]))
```

**Step 2: tests that prove the property you care about**: the model never sees raw PII, and replies come back restored.

```python
# test_gateway.py — offline: a fake model records exactly what it was sent
import sqlite3

import pytest

from gateway import PIIGateway, PlaceholderError

RAW = ("Hi, this is Priya Sharma (priya.sharma@example.com). I was charged twice for "
       "ORD-123456, card 4111 1111 1111 1111, call +1 415-555-0132.")
SECRETS_OF_THE_CUSTOMER = ["Priya Sharma", "priya.sharma@example.com", "4111 1111 1111 1111",
                           "415-555-0132"]


def make(reply: str):
    seen: list[str] = []

    def fake(system: str, user: str) -> str:
        seen.append(user)
        return reply
    return fake, seen


def test_model_never_sees_raw_pii():
    fake, seen = make("Hello <PERSON_1>, refund issued for ORD-123456.")
    PIIGateway(fake, sqlite3.connect(":memory:")).complete("c1", RAW, known_names=["Priya Sharma"])
    assert not any(s in seen[0] for s in SECRETS_OF_THE_CUSTOMER), seen[0]
    assert "ORD-123456" in seen[0]                       # kept on purpose: needed for the task


def test_reply_is_restored():
    fake, _ = make("Hello <PERSON_1>, we emailed <EMAIL_ADDRESS_1>.")
    out = PIIGateway(fake, sqlite3.connect(":memory:")).complete("c1", RAW, known_names=["Priya Sharma"])
    assert out == "Hello Priya Sharma, we emailed priya.sharma@example.com."


def test_invented_placeholder_is_rejected():
    fake, _ = make("Hello <PERSON_7>")
    with pytest.raises(PlaceholderError):
        PIIGateway(fake, sqlite3.connect(":memory:")).complete("c1", RAW, known_names=["Priya Sharma"])


def test_audit_table_holds_no_raw_pii():
    db = sqlite3.connect(":memory:")
    fake, _ = make("Hello <PERSON_1>")
    PIIGateway(fake, db).complete("c1", RAW, known_names=["Priya Sharma"])
    stored = " ".join(r[0] + r[1] for r in db.execute("SELECT prompt_pseudo, reply_pseudo FROM llm_calls"))
    assert not any(s in stored for s in SECRETS_OF_THE_CUSTOMER)
```

**Run it**

```bash
pytest -q test_gateway.py               # offline; needs only presidio + en_core_web_sm
python gateway.py                       # real call through Ollama
python -c "import sqlite3, retention as r; db=sqlite3.connect('gateway.db'); print(r.purge_expired(db, 30)); db.commit()"
gitleaks detect --source . -v           # nothing should be found
```

```text
....                                                                     [100%]
4 passed
```

**Done when**
- [ ] All four tests pass offline.
- [ ] Log lines show subject id, entity count and latency, never names, emails or keys.
- [ ] `gateway.db` contains only placeholder text.
- [ ] Every secret comes from `get_secret()` / settings, and `gitleaks detect` is clean.
- [ ] `erase_subject("cust-42")` removes the subject's rows and writes an audit entry.

**Stretch goals**
- Add a `PII_MODE=redact` path for tasks that never need names, and route emails with health terms to a human without any model call.
- Encrypt the vault with a per-conversation key from your secret manager so multi-turn chats can restore placeholders across requests.
- Plug Presidio into the Langfuse `mask` function so traces carry placeholders too.
- Build a labelled set of 50 real (consented or synthetic) emails and measure detection recall per entity type at three thresholds.

---

## 7. Comparison Table

**Secret storage**

| Option | Licence / cost | Rotation & audit | Best for | Watch out |
|---|---|---|---|---|
| `.env` + python-dotenv | Free | None | Local development only | Committed by accident; shared over chat |
| Platform env vars (Render, Fly, Heroku, GitHub secrets) | Included | Manual, limited audit | Small deployments, CI | Visible to anyone with deploy rights; env leaks to children |
| Docker / Kubernetes secrets (file mounts) | Free | Via the source you sync from | Containers | K8s Secrets are base64, not encrypted, unless you enable encryption at rest |
| SOPS + age (encrypted files in git) | Free, OSS | Git history; manual rotation | Small teams, GitOps | Key distribution; decrypted files on disk |
| HashiCorp Vault / OpenBao | BSL / MPL (OpenBao OSS) | Leases, dynamic secrets, full audit | Platform teams, dynamic DB creds | Operating it is a job in itself |
| Infisical | OSS core + cloud | Versioning, rotation, audit | Developer-friendly self-hosted manager | Younger ecosystem |
| AWS / GCP / Azure secret managers | Pay per secret and call | Versioning, rotation hooks, IAM audit | Workloads already on that cloud | Cloud lock-in; IAM policy sprawl |
| Doppler / 1Password Secrets Automation | Paid | Sync, audit | Teams wanting SaaS convenience | Another vendor with your secrets |

**PII detection**

| Option | Runs | Strengths | Weak spots | Use when |
|---|---|---|---|---|
| Regex + checksums | Local | Exact for structured ids (cards, IBAN, your ids) | Names, addresses, free text | Always, as a first layer |
| **Presidio** (spaCy/transformer NER) | Local | OSS, extensible recognizers, anonymizer operators | NER recall varies with model and language | Default for self-hosted pipelines |
| Cloud DLP (Google Sensitive Data Protection, AWS Comprehend PII, Azure AI Language PII) | Cloud API | Many entity types and languages, managed | Sends data to another processor; per-call cost | Data already in that cloud; broad coverage needed |
| LLM-based detection | Model | Context-aware, catches odd formats | Slow, costly, probabilistic, and you send PII to a model | Second pass on samples, not the gate |
| LLM Guard (Anonymize scanner) | Local | Bundled with other guardrails | Heavier dependencies | You already use LLM Guard for other scanners |

**When to use which:** `.env` locally, **file-mounted secrets** in containers, and a real **secret manager** (cloud-native if you're on one cloud, Infisical or OpenBao if self-hosting) once more than one service or person needs keys. For PII, combine **regex/custom recognizers + Presidio** locally, add known names from your own systems, and use **cloud DLP** only when the data is already in that cloud and coverage matters more than one more processor.

---

## 8. Common Mistakes & Best Practices

**1. Hardcoding a key "just for testing".** It's in git history forever and in every fork.
```python
# Before
client = anthropic.Anthropic(api_key="sk-ant-api03-...")
# After
client = anthropic.Anthropic()                           # reads ANTHROPIC_API_KEY from the environment
```
If it was ever pushed: revoke the key first, then clean history. Cleaning history alone isn't enough.

**2. Secrets in prompts, tool descriptions or the model's context.** A hijacked model will repeat them ([Ch 43](topic.html?p=43-prompt-injection-sandboxing)). *Fix:* tools authenticate in code; the model gets capabilities, never credentials.

**3. One shared key for every service and environment.** You can't rotate without a coordinated outage, can't tell who leaked it, and can't cap spend per service. *Fix:* one key per service per environment, with spend limits.

**4. Logging prompts and responses at INFO.** Logs go to many more systems and people than traces do. *Fix:* redacting filter on all handlers; prompts only in access-controlled, masked traces.

**5. Treating pseudonymised data as anonymous.** It's still personal data under GDPR, and so is the vault. *Fix:* keep the vault local and short-lived, encrypt it if persisted, and include pseudonymised stores in retention and erasure.

**6. Forgetting the copies.** The DB row is deleted, but the email lives on in the vector store, the response cache, n8n execution history and traces. *Fix:* one `erase_subject()` that knows every store, tested end to end.

**7. Trusting detection blindly.** NER misses names, especially in headers, signatures, other languages and all-caps text. *Fix:* add known names, use bigger models for production, measure recall, and minimise what you send in the first place.

**8. Assuming the provider's defaults match your obligations.** Retention periods, training use and regions differ by provider, product and plan. *Fix:* read the current terms, sign a DPA, request zero retention where eligible, and record the decision.

**Best-practice checklist**
- [ ] No secret in code, images, prompts or git; gitleaks in pre-commit and CI.
- [ ] Secrets injected at runtime (files preferred), loaded through one function, validated at startup.
- [ ] One key per service and environment, with spend limits and an owner; rotation runbook tested.
- [ ] OIDC/workload identity for cloud access from CI and workloads.
- [ ] Redacting log filter on every handler; traces masked before export.
- [ ] PII detected locally; redact or pseudonymise before any model call; send the minimum.
- [ ] Every store with personal data has a retention period and a delete-by-subject path.
- [ ] Provider DPA, retention settings and data region documented; data-flow diagram kept current.

---

## 9. Exercises

1. Add an `IBAN_CODE` and a German-language test case to `pii_detect.py`. Configure a German spaCy model (`de_core_news_sm`) in the `NlpEngineProvider` and compare recall with the English-only setup.
2. Extend `secrets_loader.py` with a background refresh that re-reads secrets every `TTL_S` seconds and logs (without values) when a secret's version changes.
3. Write a script that lists every place your mini project stores data and proves `erase_subject` covers each one by inserting a canary subject and searching for it afterwards.
4. Rotate the LLM key of a running service with zero failed requests using `RotatingKeys`, then revoke the old key and confirm the warning disappears.
5. Run `gitleaks detect` on one of your old repositories. For each finding, decide: false positive, rotate, or already revoked.

### Self-check questions

**Q: Why are file-mounted secrets often preferred over environment variables in containers?**
A: Environment variables are inherited by every child process, appear in `docker inspect` and process listings for privileged users, and are commonly dumped by crash reporters and debug endpoints. Secrets mounted as files under `/run/secrets` are only available to the services you grant them to, can have restrictive file permissions, and are not copied into child environments automatically. Both are much better than baking secrets into images or code.

**Q: What's the difference between redaction, pseudonymisation and anonymisation?**
A: Redaction removes or replaces values irreversibly in that copy (`<EMAIL>`). Pseudonymisation replaces values with consistent tokens that can be reversed by whoever holds the mapping or key, which lets an LLM refer to "<PERSON_1>" and you restore the name afterwards. Anonymisation makes re-identification impossible by anyone. Under GDPR, pseudonymised data is still personal data; only properly anonymised data is out of scope.

**Q: Why run PII detection locally instead of asking an LLM or cloud API to find the PII?**
A: Sending text to an external service to discover whether it contains personal data already discloses that data to another processor, which is what you were trying to avoid. Local detection (regex, checksums, Presidio with a local NER model) keeps raw data inside your boundary. Cloud DLP can still be appropriate when the data already lives in that cloud under the same agreements.

**Q: How do you rotate an LLM API key without downtime?**
A: Create the new key while the old one remains valid, deploy the new key as primary with the old one as fallback (or roll out gradually), monitor that traffic uses the new key and fallback warnings stop, then revoke the old key. Short secret-cache TTLs or a reload mechanism let running processes pick up the new value. Fall back only on authentication errors, never on rate limits or server errors.

**Q: An engineer pushed an API key to a public repo and force-pushed it away a minute later. What do you do? (Senior)**
A: Treat it as compromised: automated scanners harvest public pushes within seconds. Revoke or rotate the key immediately, check provider usage and billing for anomalies, and review audit logs for what the key could access. Then clean history if needed (it's still in forks and caches), add pre-commit and push-protection scanning, and examine why the key existed in a local file that could be committed. Run a blameless review and give each service its own scoped key so future leaks have a smaller blast radius.

**Q: Design PII handling for an automation that must reply to customers by name using a hosted LLM. (Senior)**
A: Detect PII locally with Presidio plus custom recognizers and known names from the CRM, and pseudonymise with a per-request vault so the model sees `<PERSON_1>` and `<EMAIL_ADDRESS_1>` while identifiers the task needs (order ids) stay. Instruct the model to copy placeholders exactly, verify the reply contains no unknown or mangled tokens, then restore values. Mask traces and logs, store only pseudonymised text with a retention period, use a provider with a DPA and zero retention where possible, and implement erasure by subject id across every store. Measure detection recall on real samples and route high-risk categories to humans.

**Q: Why do retention and erasure get harder in LLM automations than in a normal CRUD app? (Senior)**
A: The same personal data is copied into many systems as a side effect: LLM provider logs, trace stores, response and semantic caches, vector databases (embeddings of chunks containing PII), workflow tools' execution history, queues and dead-letter queues, and evaluation datasets built from production traces. Each has its own retention defaults and deletion API, and embeddings or caches are often keyed by content rather than by customer. You need a stable subject id attached as metadata everywhere, TTLs per store, and one tested erasure routine that covers them all.

**Q: Why shouldn't secrets ever be put into a prompt or tool description, even an internal one?**
A: Everything in the model's context can come back out: through prompt injection, system-prompt extraction, a debugging trace, a cached response or simply the model quoting it. Context also gets copied into provider logs and your traces. Tools should authenticate in code with credentials the model never sees, so even a fully hijacked model can only use the capabilities the policy layer permits, not exfiltrate the keys behind them.

---

## 10. Summary & Official Docs

- Secrets are **injected at runtime**, never stored in code, images, prompts or git; scan with **gitleaks** in pre-commit and CI.
- Use **`SecretStr`** and one **`get_secret()`** path; fail fast at startup; prefer **file mounts** and a **secret manager** as you grow.
- **One key per service and environment**, spend limits, **rotation with overlap**, OIDC for cloud access.
- **Redacting log filters** and **masked traces**: logs and observability are copies too.
- Detect PII **locally** with regex + **Presidio**; add names you already know; measure recall.
- **Pseudonymise** when the model must refer to people, **redact** when it needn't, and **don't send** what the task doesn't need.
- Every store gets a **retention period** and a tested **erase-by-subject** path; document provider terms, DPAs and regions.

| Concern | Tool / pattern | Chapter example |
|---|---|---|
| Config with secrets | pydantic-settings `SecretStr` | Example 1 |
| Where secrets come from | env → `/run/secrets` → Vault/AWS | Examples 2–3 |
| Rotation | Two-key overlap, auth-error fallback | Example 4 |
| Logs | Redacting `logging.Filter` | Example 5 |
| PII in prompts | Presidio detect + pseudonymise/restore | Examples 6–7 |
| Retention / DSAR | TTL purge + `erase_subject()` | Example 8 |
| Leak prevention | gitleaks, OIDC in CI | Example 9 |

**Official docs**
- Microsoft Presidio: https://microsoft.github.io/presidio/
- pydantic-settings: https://docs.pydantic.dev/latest/concepts/pydantic_settings/
- OWASP Secrets Management Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html
- HashiCorp Vault: https://developer.hashicorp.com/vault/docs · OpenBao: https://openbao.org/docs/
- Infisical: https://infisical.com/docs
- AWS Secrets Manager: https://docs.aws.amazon.com/secretsmanager/
- gitleaks: https://github.com/gitleaks/gitleaks
- Docker secrets: [Docker handbook · Secrets](../docker/topic.html?p=24-secrets)
- Theory: [AI Engineering · Responsible AI & Alignment](../ai-engineering/topic.html?p=44-responsible-ai-alignment)

**Next:** [Ch 45 · Glossary](topic.html?p=45-glossary), then [Ch 48 · Capstone](topic.html?p=48-capstone), where tracing, evals, injection defences and the PII gateway all come together in one deployed automation.

---

*AI Automation with Python Handbook — chapter 44.*
