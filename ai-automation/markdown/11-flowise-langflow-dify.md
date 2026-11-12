# 11 · Flowise, Langflow & Dify

> **In one line:** Flowise, Langflow and Dify let you drag chat models, prompts, retrievers, memory and tools onto a canvas and get a working chatbot, RAG assistant or agent with a REST API in an afternoon; your job as a developer is to self-host them safely, call them from Python behind a thin façade, and know when a flow has outgrown the canvas and should become code.

> **Versions used:** Flowise 3.1 (Docker `flowiseai/flowise`) · Langflow 1.13 (Docker `langflowai/langflow`, components via `lfx`) · Dify 1.15 (Docker Compose from the `langgenius/dify` repo) · httpx 0.28 · python-dotenv 1.2 · **Fast-moving:** all three ship releases every few weeks. Node and component names, auth settings, API response shapes for streaming, and plugin systems change between minor versions (Langflow moved custom components from `langflow.custom` to `lfx` in 1.7; Dify moved model providers into plugins in 1.0; Flowise replaced its old username/password env vars with user accounts in 3.x). Pin image tags and re-test your API clients after every upgrade.

---

## 1. Overview

> **Builds on:** [Ch 08 · Local Models](topic.html?p=08-local-models) (Ollama as the model behind every canvas), [Ch 09 · n8n Fundamentals](topic.html?p=09-n8n-fundamentals) (Docker self-hosting, webhooks) and [Ch 10 · Make, Zapier & Power Automate](topic.html?p=10-make-zapier-power-automate) (the other low-code family). Theory: [AI Engineering · RAG](../ai-engineering/topic.html?p=29-rag).

n8n and Zapier are **workflow** tools: "when X happens, do A, B, C", with an AI step somewhere in the middle. **Visual LLM app builders** start from the other end: the product *is* the LLM app. You build the chatbot, the RAG pipeline or the agent on a canvas, test it in a built-in chat panel, and every flow gets an API endpoint (and often an embeddable chat widget) for free.

The three you'll meet most:
- **Flowise**: Node.js/TypeScript, built on LangChain.js and LlamaIndex.ts concepts. *Chatflows* (chains, RAG) and *Agentflows* (multi-step, multi-agent graphs with conditions, loops and human input). Apache-2.0.
- **Langflow**: Python, with components that are Python classes you can edit in the UI. Flows double as API endpoints and as **MCP servers**. MIT.
- **Dify**: a fuller "LLMOps platform": apps (Chatbot, Chatflow, Workflow, Agent, Text Generator), a built-in **Knowledge** base (ingest, chunk, embed, retrieve), prompt/app logs and annotation, a plugin marketplace for models and tools, multi-user workspaces. Open source under a modified Apache 2.0 licence with extra conditions.

Where they sit:

```mermaid
flowchart LR
    U["Users: website widget, Slack, internal app"] --> FA["Your Python facade: FastAPI"]
    N8N["n8n workflow (Ch 09)"] --> FA
    FA -->|"REST + API key"| B{"Visual builder"}
    B --> FL["Flowise chatflow / agentflow"]
    B --> LF["Langflow flow"]
    B --> DF["Dify app"]
    FL --> M["Ollama / Claude / OpenAI"]
    LF --> M
    DF --> M
    FL --> V[("Vector store: Chroma, Qdrant, pgvector")]
    LF --> V
    DF --> K[("Dify Knowledge (built-in)")]
```

> **Why this matters:** these tools compress the first 80% of an LLM app (prototype, stakeholder demo, internal pilot) from weeks to hours, and non-developers can tweak prompts without a deploy. The last 20% (tests, versioned prompts, custom auth, unusual control flow, cost controls) is where you either keep them behind a façade or graduate to LangChain/LangGraph code ([Ch 13](topic.html?p=13-langchain-core-lcel), [Ch 23](topic.html?p=23-langgraph-fundamentals)).

---

## 2. Key Concepts

- **Flow / app**: a graph of nodes saved as JSON in the builder's database. Flowise calls them **chatflows** and **agentflows**, Langflow **flows** (inside **projects**), Dify **apps** of a given *type*.
- **Node / component**: one building block: chat model, prompt template, document loader, text splitter, embeddings, vector store, retriever, memory, tool, agent, condition. Edges connect typed ports (a retriever port only accepts a retriever).
- **RAG pipeline on a canvas**: loader → splitter → embeddings → vector store (**upsert** step) and, at question time, retriever → prompt → model (**query** step). Dify hides the upsert side inside **Knowledge**: you upload files and choose chunking and embedding settings.
- **Memory / session**: chat history keyed by a session or conversation id. Flowise: `overrideConfig.sessionId`; Langflow: `session_id`; Dify: `conversation_id` (returned by the first call) plus a required `user` id.
- **Prediction / run API**: every flow has an HTTP endpoint. Flowise `POST /api/v1/prediction/{flowId}`; Langflow `POST /api/v1/run/{flowId}`; Dify `POST /v1/chat-messages` (chat-type apps) or `POST /v1/workflows/run` (workflow apps), where the **API key identifies the app**.
- **Overrides / tweaks / inputs**: per-request parameter changes without editing the flow. Flowise `overrideConfig` (must be allowed per flow), Langflow `tweaks` keyed by component id, Dify `inputs` for variables defined in the app.
- **Streaming**: all three stream tokens as **Server-Sent Events** when asked (`streaming: true`, `?stream=true`, `response_mode: "streaming"`). Event names differ per tool.
- **Credentials and variables**: provider API keys stored encrypted in the builder (Flowise *Credentials*, Langflow *Global Variables*, Dify *Model Providers* / plugins). Flows reference them by name; exported flow JSON shouldn't contain the key (check before committing).
- **Custom code**: Flowise *Custom Tool* / *Custom Function* nodes (JavaScript), Langflow custom components (Python classes), Dify *Code* node (Python or JavaScript in a sandbox) and custom tools from an OpenAPI schema or a plugin.

> **Analogy:** a professional kitchen's prep station with labelled containers. Every ingredient (node) has a fixed shape, so you can't plug the wrong thing in, and anyone on the team can rearrange the line. But if you want a dish nobody has a container for, you write a recipe (code) instead.

How a RAG chatflow maps across the three tools:

```svg
<svg viewBox="0 0 880 350" width="100%" height="350" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs><marker id="aa11a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#334155"/></marker></defs>
  <text x="440" y="22" text-anchor="middle" font-size="14" font-weight="700" fill="#1e293b">One RAG chatbot, three canvases, one API call</text>
  <text x="20" y="56" font-weight="700" fill="#334155">Ingest (once)</text>
  <rect x="20" y="66" width="120" height="44" rx="7" fill="#fef3c7" stroke="#d97706"/>
  <text x="80" y="92" text-anchor="middle" fill="#1e293b">Loader: PDF, web</text>
  <line x1="142" y1="88" x2="168" y2="88" stroke="#334155" stroke-width="1.5" marker-end="url(#aa11a)"/>
  <rect x="170" y="66" width="120" height="44" rx="7" fill="#fef3c7" stroke="#d97706"/>
  <text x="230" y="92" text-anchor="middle" fill="#1e293b">Text splitter</text>
  <line x1="292" y1="88" x2="318" y2="88" stroke="#334155" stroke-width="1.5" marker-end="url(#aa11a)"/>
  <rect x="320" y="66" width="120" height="44" rx="7" fill="#fef3c7" stroke="#d97706"/>
  <text x="380" y="92" text-anchor="middle" fill="#1e293b">Embeddings</text>
  <line x1="442" y1="88" x2="468" y2="88" stroke="#334155" stroke-width="1.5" marker-end="url(#aa11a)"/>
  <rect x="470" y="66" width="130" height="44" rx="7" fill="#dcfce7" stroke="#16a34a"/>
  <text x="535" y="92" text-anchor="middle" font-weight="700" fill="#1e293b">Vector store</text>
  <text x="20" y="146" font-weight="700" fill="#334155">Query (every message)</text>
  <rect x="20" y="156" width="120" height="44" rx="7" fill="#dbeafe" stroke="#2563eb"/>
  <text x="80" y="182" text-anchor="middle" fill="#1e293b">Question + session</text>
  <line x1="142" y1="178" x2="168" y2="178" stroke="#334155" stroke-width="1.5" marker-end="url(#aa11a)"/>
  <rect x="170" y="156" width="120" height="44" rx="7" fill="#dbeafe" stroke="#2563eb"/>
  <text x="230" y="182" text-anchor="middle" fill="#1e293b">Retriever (top-k)</text>
  <line x1="535" y1="112" x2="240" y2="154" stroke="#16a34a" stroke-width="1.2" stroke-dasharray="4 3"/>
  <line x1="292" y1="178" x2="318" y2="178" stroke="#334155" stroke-width="1.5" marker-end="url(#aa11a)"/>
  <rect x="320" y="156" width="120" height="44" rx="7" fill="#dbeafe" stroke="#2563eb"/>
  <text x="380" y="176" text-anchor="middle" fill="#1e293b">Prompt + memory</text>
  <text x="380" y="191" text-anchor="middle" fill="#334155">context, history</text>
  <line x1="442" y1="178" x2="468" y2="178" stroke="#334155" stroke-width="1.5" marker-end="url(#aa11a)"/>
  <rect x="470" y="156" width="130" height="44" rx="7" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="535" y="182" text-anchor="middle" font-weight="700" fill="#1e293b">Chat model</text>
  <line x1="602" y1="178" x2="628" y2="178" stroke="#334155" stroke-width="1.5" marker-end="url(#aa11a)"/>
  <rect x="630" y="156" width="110" height="44" rx="7" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="685" y="176" text-anchor="middle" fill="#1e293b">Answer +</text>
  <text x="685" y="191" text-anchor="middle" fill="#334155">source docs</text>
  <rect x="20" y="226" width="270" height="108" rx="8" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="155" y="248" text-anchor="middle" font-weight="700" fill="#1e293b">Flowise</text>
  <text x="32" y="268" fill="#334155">Chatflow: Conversational Retrieval QA</text>
  <text x="32" y="286" fill="#334155">or Agentflow V2 with a Retriever tool</text>
  <text x="32" y="304" fill="#334155">POST /api/v1/prediction/{flowId}</text>
  <text x="32" y="322" fill="#334155">session: overrideConfig.sessionId</text>
  <rect x="305" y="226" width="270" height="108" rx="8" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="440" y="248" text-anchor="middle" font-weight="700" fill="#1e293b">Langflow</text>
  <text x="317" y="268" fill="#334155">Vector Store RAG template:</text>
  <text x="317" y="286" fill="#334155">components are editable Python</text>
  <text x="317" y="304" fill="#334155">POST /api/v1/run/{flowId}</text>
  <text x="317" y="322" fill="#334155">session: session_id · key: x-api-key</text>
  <rect x="590" y="226" width="270" height="108" rx="8" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="725" y="248" text-anchor="middle" font-weight="700" fill="#1e293b">Dify</text>
  <text x="602" y="268" fill="#334155">Knowledge base + Chatbot/Chatflow app</text>
  <text x="602" y="286" fill="#334155">(ingest side handled by Dify)</text>
  <text x="602" y="304" fill="#334155">POST /v1/chat-messages (key = app)</text>
  <text x="602" y="322" fill="#334155">session: conversation_id + user</text>
  <rect x="760" y="66" width="100" height="134" rx="8" fill="#fee2e2" stroke="#dc2626"/>
  <text x="810" y="90" text-anchor="middle" font-weight="700" fill="#1e293b">You own</text>
  <text x="810" y="110" text-anchor="middle" fill="#334155">auth</text>
  <text x="810" y="128" text-anchor="middle" fill="#334155">backups</text>
  <text x="810" y="146" text-anchor="middle" fill="#334155">upgrades</text>
  <text x="810" y="164" text-anchor="middle" fill="#334155">evals</text>
  <text x="810" y="182" text-anchor="middle" fill="#334155">cost limits</text>
</svg>
```

> **Gotcha:** "it has an API" doesn't mean "it's production-ready". The flow's prompt, model and retriever can be changed by anyone with editor access, instantly, with no review. Treat edits like deploys: restrict editor roles, export flows to git, and run a regression script (Mini Project) after every change.

---

## 3. Setup

Run all three locally with Docker, each pointing at your host's Ollama (Ch 08). From inside a container, the host is `http://host.docker.internal:11434` (Docker Desktop; on Linux add `extra_hosts: ["host.docker.internal:host-gateway"]`).

```yaml
# docker-compose.yml — Flowise and Langflow side by side (Dify has its own compose, below)
services:
  flowise:
    image: flowiseai/flowise:${FLOWISE_VERSION}
    restart: unless-stopped
    ports: ["3000:3000"]
    environment:
      PORT: "3000"
      DATABASE_TYPE: postgres
      DATABASE_HOST: postgres
      DATABASE_PORT: "5432"
      DATABASE_NAME: flowise
      DATABASE_USER: flowise
      DATABASE_PASSWORD: ${POSTGRES_PASSWORD}
      FLOWISE_SECRETKEY_OVERWRITE: ${FLOWISE_SECRETKEY}   # encrypts stored credentials; back it up
    volumes: ["flowise:/root/.flowise"]
    extra_hosts: ["host.docker.internal:host-gateway"]
    depends_on: [postgres]

  langflow:
    image: langflowai/langflow:${LANGFLOW_VERSION}
    restart: unless-stopped
    ports: ["7860:7860"]
    environment:
      LANGFLOW_DATABASE_URL: postgresql://langflow:${POSTGRES_PASSWORD}@postgres:5432/langflow
      LANGFLOW_CONFIG_DIR: /app/langflow
      LANGFLOW_AUTO_LOGIN: "false"                         # require login; default dev mode auto-logs-in
      LANGFLOW_SUPERUSER: admin
      LANGFLOW_SUPERUSER_PASSWORD: ${LANGFLOW_ADMIN_PASSWORD}
      LANGFLOW_SECRET_KEY: ${LANGFLOW_SECRET_KEY}          # encrypts global variables; back it up
    volumes: ["langflow:/app/langflow"]
    extra_hosts: ["host.docker.internal:host-gateway"]
    depends_on: [postgres]

  postgres:
    image: postgres:16
    restart: unless-stopped
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes: ["pg:/var/lib/postgresql/data", "./init-db.sql:/docker-entrypoint-initdb.d/init.sql:ro"]

volumes: {flowise: {}, langflow: {}, pg: {}}
```

`init-db.sql` creates the two databases and users (`CREATE USER flowise WITH PASSWORD '...'; CREATE DATABASE flowise OWNER flowise;` and the same for `langflow`). Dify is a larger stack (API, worker, web, Postgres, Redis, a vector DB, a sandbox for Code nodes, a plugin daemon, nginx), so use its own Compose file:

```bash
git clone --depth 1 --branch 1.15.0 https://github.com/langgenius/dify.git   # pin a release tag
cd dify/docker && cp .env.example .env      # set SECRET_KEY and change default passwords in .env
docker compose up -d
open http://localhost/install               # create the admin account
```

The environment file for the Compose stack above and for the Python clients in this chapter:

```bash
# .env.example  (for the compose file above and the Python clients in this chapter)
FLOWISE_VERSION=3.1.4                # pin exact tags; check each project's releases page
LANGFLOW_VERSION=1.13.0
POSTGRES_PASSWORD=change-me
FLOWISE_SECRETKEY=                   # python3 -c 'import secrets; print(secrets.token_urlsafe(32))'
LANGFLOW_SECRET_KEY=
LANGFLOW_ADMIN_PASSWORD=
# --- Python clients ---
FLOWISE_URL=http://localhost:3000
FLOWISE_FLOW_ID=                     # from the chatflow URL or its API dialog
FLOWISE_API_KEY=                     # Flowise → API Keys, then assign to the flow
LANGFLOW_URL=http://localhost:7860
LANGFLOW_FLOW_ID=
LANGFLOW_API_KEY=                    # Langflow → Settings → API Keys
DIFY_URL=http://localhost/v1         # Dify Cloud: https://api.dify.ai/v1
DIFY_APP_KEY=                        # app → API Access → API Key (starts with app-)
```

Finally, the Python side and the two local models:

```bash
pip install "httpx>=0.27,<1" "python-dotenv>=1" "fastapi>=0.115,<1" "uvicorn>=0.30" pytest
ollama pull llama3.2 && ollama pull nomic-embed-text
```

Connecting each builder to Ollama:
- **Flowise:** *ChatOllama* node, Base URL `http://host.docker.internal:11434`, model `llama3.2`; *Ollama Embeddings* node with `nomic-embed-text`.
- **Langflow:** *Ollama* model component, Base URL as above; *Ollama Embeddings* component.
- **Dify:** *Settings → Model Provider*, install the **Ollama** plugin, add `llama3.2` (LLM) and `nomic-embed-text` (Text Embedding) with Base URL `http://host.docker.internal:11434`.

> **Version note:** Flowise 3.x has user accounts and organisations; the old `FLOWISE_USERNAME`/`FLOWISE_PASSWORD` basic-auth env vars from 1.x/2.x are gone. Langflow's `LANGFLOW_AUTO_LOGIN=true` (the convenient default for local dev) means **anyone who can reach port 7860 is admin**; turn it off before exposing it anywhere. Check each project's env-var reference for your exact version.

---

## 4. Code Examples

Build one simple flow in each tool first (chat model + prompt + memory is enough; RAG comes in the Mini Project), then call it from Python. All clients below share a pattern: env vars for URLs and keys, a session id for memory, a timeout, and a normalised return shape.

### Example 1: Calling a Flowise chatflow

```python
# flowise_client.py — call a Flowise chatflow/agentflow: blocking and streaming
import json
import os
import uuid

import httpx
from dotenv import load_dotenv

load_dotenv()
BASE = os.getenv("FLOWISE_URL", "http://localhost:3000").rstrip("/")
FLOW_ID = os.getenv("FLOWISE_FLOW_ID", "")
HEADERS = {"Authorization": f"Bearer {os.environ.get('FLOWISE_API_KEY', '')}"}


def ask(question: str, session_id: str, timeout: float = 120) -> dict:
    body = {"question": question, "overrideConfig": {"sessionId": session_id}}
    r = httpx.post(f"{BASE}/api/v1/prediction/{FLOW_ID}", json=body, headers=HEADERS, timeout=timeout)
    r.raise_for_status()
    data = r.json()
    return {
        "answer": data.get("text", ""),
        "session_id": data.get("sessionId") or session_id,
        "sources": [d.get("metadata", {}).get("source") for d in data.get("sourceDocuments") or []],
        "tools": [t.get("tool") for t in data.get("usedTools") or []],
    }


def stream(question: str, session_id: str):
    """Yield answer tokens. Flowise streams SSE lines like: data: {"event": "token", "data": "Hel"}."""
    body = {"question": question, "streaming": True, "overrideConfig": {"sessionId": session_id}}
    with httpx.stream("POST", f"{BASE}/api/v1/prediction/{FLOW_ID}", json=body, headers=HEADERS,
                      timeout=httpx.Timeout(120, connect=5)) as r:
        r.raise_for_status()
        for line in r.iter_lines():
            if not line.startswith("data:"):
                continue
            try:
                evt = json.loads(line[5:].strip())
            except json.JSONDecodeError:
                continue
            if evt.get("event") == "token":
                yield evt.get("data", "")
            elif evt.get("event") == "error":
                raise RuntimeError(evt.get("data"))


if __name__ == "__main__":
    sid = f"py-{uuid.uuid4().hex[:8]}"
    print(ask("My name is Priya. What can you help me with?", sid))
    print("".join(stream("What's my name?", sid)))       # memory works because the session id is reused
```

Illustrative output:

```text
{'answer': 'Hi Priya! I can answer questions about Acme Cloud plans, billing and setup.', 'session_id': 'py-3f9a1c2e', 'sources': [], 'tools': []}
Your name is Priya.
```

> **Gotcha:** Flowise ignores `overrideConfig` keys that aren't enabled for that flow (*Configuration → Security → Override Configuration* in recent versions). If your session id "doesn't work", check that `sessionId` is allowed. Agentflow V2 flows can also be started with `form` inputs instead of `question`, and paused human-input nodes are resumed with `humanInput`.

### Example 2: Calling a Langflow flow, with tweaks

```python
# langflow_client.py — run a Langflow flow, override a component's settings per request
import os
import uuid

import httpx
from dotenv import load_dotenv

load_dotenv()
BASE = os.getenv("LANGFLOW_URL", "http://localhost:7860").rstrip("/")
FLOW_ID = os.getenv("LANGFLOW_FLOW_ID", "")
HEADERS = {"x-api-key": os.environ.get("LANGFLOW_API_KEY", "")}


def extract_text(data: dict) -> str:
    """Pull the chat message out of Langflow's nested run response."""
    try:
        return data["outputs"][0]["outputs"][0]["results"]["message"]["text"]
    except (KeyError, IndexError, TypeError):
        return ""


def run(message: str, session_id: str, tweaks: dict | None = None, timeout: float = 120) -> dict:
    body = {"input_value": message, "input_type": "chat", "output_type": "chat", "session_id": session_id}
    if tweaks:
        body["tweaks"] = tweaks          # {"<component id>": {"<field>": value}}; ids look like "Ollama-x1Y2z"
    r = httpx.post(f"{BASE}/api/v1/run/{FLOW_ID}", json=body, headers=HEADERS, timeout=timeout)
    r.raise_for_status()
    data = r.json()
    return {"answer": extract_text(data), "session_id": data.get("session_id", session_id)}


if __name__ == "__main__":
    sid = f"py-{uuid.uuid4().hex[:8]}"
    print(run("Summarise our refund policy in one sentence.", sid))
    # Same flow, different model for this one call (component id from the flow's API panel → Tweaks tab):
    print(run("Same, but in German.", sid, tweaks={"OllamaModel-abc12": {"model_name": "qwen3:8b"}}))
```

Illustrative output:

```text
{'answer': 'You can get a full refund within 30 days of purchase, paid back to the original payment method.', 'session_id': 'py-51c0d7aa'}
{'answer': 'Innerhalb von 30 Tagen nach dem Kauf erhalten Sie eine volle Rückerstattung auf die ursprüngliche Zahlungsmethode.', 'session_id': 'py-51c0d7aa'}
```

The response path `outputs[0].outputs[0].results.message.text` is what the official docs show for chat output; it's deeply nested because one run can have several outputs. Add `?stream=true` for `token` events followed by an `end` event. `POST /api/v1/webhook/{flow_id}` accepts arbitrary JSON and runs the flow in the background (returns `"status": "in progress"`): handy as an n8n or GitHub webhook target. Refused tweak keys return `422` (`TWEAKS_REFUSED`) in recent versions, so tweak only fields you've checked.

### Example 3: Calling a Dify app: chat, streaming and workflows

```python
# dify_client.py — chat-messages (blocking + streaming) and workflows/run
import json
import os

import httpx
from dotenv import load_dotenv

load_dotenv()
BASE = os.getenv("DIFY_URL", "http://localhost/v1").rstrip("/")
HEADERS = {"Authorization": f"Bearer {os.environ.get('DIFY_APP_KEY', '')}"}    # the key selects the app


def chat(query: str, user: str, conversation_id: str = "", inputs: dict | None = None) -> dict:
    body = {"inputs": inputs or {}, "query": query, "response_mode": "blocking",
            "conversation_id": conversation_id, "user": user}
    r = httpx.post(f"{BASE}/chat-messages", json=body, headers=HEADERS, timeout=120)
    r.raise_for_status()
    d = r.json()
    meta = d.get("metadata", {})
    return {"answer": d.get("answer", ""), "conversation_id": d.get("conversation_id", ""),
            "usage": meta.get("usage", {}),
            "sources": [x.get("document_name") for x in meta.get("retriever_resources") or []]}


def parse_sse(lines):
    """Turn Dify SSE lines into (event, payload) tuples. Pure function: unit-testable without a server."""
    for line in lines:
        if line.startswith("data:"):
            try:
                payload = json.loads(line[5:].strip())
            except json.JSONDecodeError:
                continue
            yield payload.get("event", ""), payload


def chat_stream(query: str, user: str, conversation_id: str = ""):
    body = {"inputs": {}, "query": query, "response_mode": "streaming",
            "conversation_id": conversation_id, "user": user}
    with httpx.stream("POST", f"{BASE}/chat-messages", json=body, headers=HEADERS,
                      timeout=httpx.Timeout(120, connect=5)) as r:
        r.raise_for_status()
        for event, p in parse_sse(r.iter_lines()):
            if event in ("message", "agent_message"):      # chatbot / chatflow vs agent apps
                yield p.get("answer", "")
            elif event == "error":
                raise RuntimeError(p.get("message"))


def run_workflow(inputs: dict, user: str) -> dict:
    r = httpx.post(f"{BASE}/workflows/run", json={"inputs": inputs, "response_mode": "blocking", "user": user},
                   headers=HEADERS, timeout=300)
    r.raise_for_status()
    data = r.json()["data"]
    return {"status": data["status"], "outputs": data.get("outputs"), "seconds": data.get("elapsed_time")}


if __name__ == "__main__":
    first = chat("Do you offer SSO?", user="user-42")
    print(first)
    print("".join(chat_stream("On which plan?", user="user-42", conversation_id=first["conversation_id"])))
```

Illustrative output:

```text
{'answer': 'Yes, SAML SSO is available.', 'conversation_id': '2b1f…', 'usage': {'prompt_tokens': 412, 'completion_tokens': 9, 'total_tokens': 421, …}, 'sources': ['faq.md']}
SAML SSO is available on the Enterprise plan only.
```

Dify specifics worth knowing:
- The `user` field is **required** and scopes conversations: a `conversation_id` from user A won't continue for user B. Use your own stable user id.
- **Agent** apps stream (`agent_thought`, `agent_message`, `message_end`); use streaming mode for them. **Chatflow** streams also emit `workflow_started` / `node_started` / `node_finished` / `workflow_finished` events you can use for progress UIs.
- `message_end` carries `metadata.usage` (tokens, and price if configured) and `retriever_resources` (citations).
- **Workflow** apps (no chat) go to `/workflows/run` and return `data.outputs` keyed by the variables of your *End* node.
- Each app has its own key. Knowledge bases have a separate **dataset API key** for document upload endpoints.

### Example 4: Testing your stream parsing offline

Streaming formats are the most version-sensitive part of these APIs. Keep parsers as pure functions and test them against captured samples, so an upgrade that renames an event fails a test rather than silently returning empty answers.

```python
# test_parsers.py — pytest -q  (no servers needed)
from dify_client import parse_sse
from langflow_client import extract_text

DIFY_SAMPLE = [
    'data: {"event": "message", "answer": "SAML ", "conversation_id": "c1"}',
    "",
    'data: {"event": "message", "answer": "SSO is Enterprise only.", "conversation_id": "c1"}',
    'data: {"event": "message_end", "metadata": {"usage": {"total_tokens": 421}}}',
    "event: ping",
]


def test_dify_sse_tokens_and_end():
    events = list(parse_sse(DIFY_SAMPLE))
    text = "".join(p["answer"] for e, p in events if e == "message")
    assert text == "SAML SSO is Enterprise only."
    assert events[-1][0] == "message_end"
    assert events[-1][1]["metadata"]["usage"]["total_tokens"] == 421


def test_langflow_extract_text_and_missing():
    ok = {"outputs": [{"outputs": [{"results": {"message": {"text": "hi"}}}]}]}
    assert extract_text(ok) == "hi"
    assert extract_text({"outputs": []}) == ""
```

When you upgrade a builder, capture a fresh stream with `curl -N ... > sample.txt`, add it as a fixture, and see whether the tests still pass.

### Example 5: A custom Langflow component in Python

When a node doesn't exist, Langflow lets you write one as a Python class (in the UI's code editor or as a file loaded via `LANGFLOW_COMPONENTS_PATH`). This one masks emails and card numbers before text reaches a model.

```python
# components/pii_mask.py — a Langflow custom component (Langflow 1.7+ imports from lfx)
import re

from lfx.custom.custom_component.component import Component
from lfx.io import BoolInput, MessageTextInput, Output
from lfx.schema.message import Message

EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
CARD = re.compile(r"\b(?:\d[ -]?){12,19}\b")


class PIIMask(Component):
    display_name = "PII Mask"
    description = "Masks emails and card numbers before text reaches a model."
    icon = "shield"
    name = "PIIMask"

    inputs = [
        MessageTextInput(name="text", display_name="Text"),
        BoolInput(name="mask_cards", display_name="Mask card numbers", value=True),
    ]
    outputs = [Output(name="masked", display_name="Masked text", method="mask")]

    def mask(self) -> Message:
        out = EMAIL.sub("[EMAIL]", self.text or "")
        if self.mask_cards:
            out = CARD.sub("[CARD]", out)
        self.status = f"{len(self.text or '') - len(out):+d} chars"     # shown on the node in the UI
        return Message(text=out)
```

The `Output(method="mask")` name must match a method on the class; the return annotation tells the canvas which ports it can connect to. In Langflow before 1.7 the same imports came from `langflow.custom` / `langflow.io` / `langflow.schema` (still accepted as aliases). Flowise's equivalent is a *Custom Tool* or *Custom JS Function* node (JavaScript); Dify's is a *Code* node (Python 3 or JavaScript in its sandbox) or a plugin.

> **Version note:** `lfx` is the lightweight Langflow executor package split out of Langflow around 1.6–1.7. The imports above (`lfx.custom.custom_component.component.Component`, `lfx.io.BoolInput/MessageTextInput/Output`, `lfx.schema.message.Message`) were checked against the `lfx` 1.13.2 source; the component itself wasn't executed here, because full Langflow was out of scope for this handbook's test environment. Paste it into a Custom Component node and run it once before relying on it.

### Example 6: A façade so callers never depend on the builder

Your website, Slack bot and n8n workflows should call **your** endpoint, not Flowise's or Dify's. The façade owns auth, rate limits, logging and the response shape, and lets you swap the backend (another builder, or LangChain code) without touching callers.

```python
# facade.py — one stable /v1/chat endpoint in front of any builder
import os
import secrets
import time
from typing import Literal, Protocol

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

load_dotenv()


class Backend(Protocol):
    def __call__(self, message: str, session_id: str, user_id: str) -> dict: ...


def flowise_backend(message: str, session_id: str, user_id: str) -> dict:
    import flowise_client
    r = flowise_client.ask(message, f"{user_id}:{session_id}")
    return {"answer": r["answer"], "sources": r["sources"]}


def dify_backend(message: str, session_id: str, user_id: str) -> dict:
    import dify_client
    # Dify issues its own conversation ids; a real facade maps (user, session) → conversation_id in Redis/DB
    r = dify_client.chat(message, user=user_id, conversation_id=_DIFY_CONV.get((user_id, session_id), ""))
    _DIFY_CONV[(user_id, session_id)] = r["conversation_id"]
    return {"answer": r["answer"], "sources": r["sources"]}


def echo_backend(message: str, session_id: str, user_id: str) -> dict:
    return {"answer": f"echo: {message}", "sources": []}             # for tests and local dev


_DIFY_CONV: dict[tuple[str, str], str] = {}
BACKENDS: dict[str, Backend] = {"flowise": flowise_backend, "dify": dify_backend, "echo": echo_backend}


class ChatIn(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    session_id: str = Field(min_length=1, max_length=64)


class ChatOut(BaseModel):
    answer: str
    sources: list[str | None]
    backend: Literal["flowise", "dify", "echo"]
    ms: int


app = FastAPI(title="assistant-facade")


def current_user(authorization: str = Header(default="")) -> str:
    token = authorization.removeprefix("Bearer ")
    if not secrets.compare_digest(token, os.environ["FACADE_TOKEN"]):   # replace with your real auth (JWT, SSO)
        raise HTTPException(401, "unauthorised")
    return "user-demo"


def get_backend() -> str:
    return os.getenv("ASSISTANT_BACKEND", "echo")


@app.post("/v1/chat", response_model=ChatOut)
def chat(body: ChatIn, user: str = Depends(current_user), backend: str = Depends(get_backend)) -> ChatOut:
    t0 = time.perf_counter()
    try:
        r = BACKENDS[backend](body.message, body.session_id, user)
    except Exception as e:                                             # noqa: BLE001
        raise HTTPException(502, f"assistant backend unavailable ({type(e).__name__})") from e
    return ChatOut(answer=r["answer"], sources=r["sources"], backend=backend,
                   ms=int((time.perf_counter() - t0) * 1000))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8080)
```

Run it with the echo backend to check the plumbing:

```bash
FACADE_TOKEN=dev ASSISTANT_BACKEND=echo python facade.py &
curl -s localhost:8080/v1/chat -H 'Authorization: Bearer dev' -H 'content-type: application/json' \
     -d '{"message":"hello","session_id":"s1"}'
```

Response:

```text
{"answer":"echo: hello","sources":[],"backend":"echo","ms":0}
```

Switching `ASSISTANT_BACKEND=dify` changes the engine for every caller at once. When you later rebuild the flow in LangChain (Ch 13–14), it becomes a fourth backend function, and A/B testing old vs new is a config change.

---

## 5. Real-World Use Case

**Company:** a 120-person HR-software vendor. **Need:** an internal assistant that answers support agents' product questions from ~900 help-centre articles and release notes, plus a public website widget later. **Team:** one developer, two support leads who own the content and prompt tone.

**Build:** Dify self-hosted on one VM. A **Knowledge** base syncs the help centre nightly (Dify's API for document create/update, called by an n8n schedule workflow). A **Chatflow** app: question classifier → (product question) knowledge retrieval with reranking → LLM answer with citations, or (account-specific) a canned "please open a ticket" reply. Support leads edit prompts in Dify; the developer owns a FastAPI façade, a nightly regression script and the deployment.

```mermaid
flowchart LR
    HC["Help centre CMS"] -->|"nightly"| N8N["n8n schedule workflow"]
    N8N -->|"Dify dataset API: create/update docs"| KB[("Dify Knowledge")]
    AG["Support agent in Zendesk sidebar"] --> FA["FastAPI facade: SSO, rate limit, logs"]
    FA -->|"/v1/chat-messages"| APP["Dify Chatflow app"]
    APP --> QC{"Question classifier"}
    QC -->|"product"| RET["Knowledge retrieval + rerank"]
    RET --> LLM["LLM answer with citations"]
    QC -->|"account-specific"| CAN["Canned: open a ticket"]
    LLM --> FA
    CAN --> FA
    CI["Nightly regression: 60 Q and A pairs"] --> FA
```

**Numbers (month 2):**
- **Volume:** ~11,000 questions/month from 45 agents; p50 latency 3.2 s, p95 7 s.
- **Model:** a hosted mid-tier model via Dify's provider plugin for answers, local `nomic-embed-text` for embeddings. ~11,000 × ~2.5k input / 300 output tokens ≈ 27M in / 3.3M out per month. At, say, Sonnet 5.5's $2/$10 per M tokens that's ~$87/month; Dify's per-message `usage` let them verify it against the provider bill.
- **Quality:** the 60-question regression went from 71% to 90% "acceptable" after the leads rewrote chunking (by heading) and the system prompt over two weeks, without a single code deploy.
- **Outcome:** average handle time on "how do I…" tickets fell ~25%.
- **What later went to code:** the public widget needed per-customer permissions on documents and strict cost caps per tenant. That retrieval step moved into a LangChain service behind the same façade ([Ch 16](topic.html?p=16-rag-fundamentals)), while internal use stayed on Dify.

---

## 6. Mini Project: RAG FAQ Bot on a Canvas + Python Regression Harness (1–2 hours)

**Goal:** build a RAG FAQ bot in **Flowise or Dify** (your choice) on top of Ollama, call it through the façade, and write a regression harness that checks answers, sources, memory and latency, so every canvas edit can be verified in one command.

```text
canvas-faq/
├── .env
├── docker-compose.yml        # Setup (or Dify's compose)
├── kb/acme-faq.md
├── flowise_client.py         # Example 1
├── dify_client.py            # Example 3
├── langflow_client.py        # Example 2 (only for the parser tests)
├── facade.py                 # Example 6
├── cases.json
├── regress.py
└── test_parsers.py           # Example 4
```

**Step 1: the knowledge file.**

```text
# Acme Cloud FAQ
## Refunds
Refunds are available within 30 days of purchase, to the original payment method.
## Plans
Starter: 3 seats. Team: 20 seats. Enterprise: unlimited seats.
## SSO
SAML SSO is available on the Enterprise plan only.
## Data residency
Customer data is stored in Frankfurt (EU) by default. US hosting is available on Enterprise.
## Support hours
Email support 9:00-18:00 CET on weekdays. Enterprise has 24/7 phone support.
```

**Step 2a: Flowise path.** New *Chatflow* → add **Plain Text** or **Text File** loader (paste/upload the FAQ) → **Markdown Text Splitter** (chunk 400, overlap 50) → **Ollama Embeddings** (`nomic-embed-text`) → **In-Memory Vector Store** (or Chroma/Qdrant for persistence) → **Conversational Retrieval QA Chain** with **ChatOllama** (`llama3.2`, temperature 0) and **Buffer Memory**. Click *Upsert* (the database icon) to index. In the chain's settings set a system message: "Answer only from the context. If it's not there, say you don't know and suggest support@acme.example." Enable *Return Source Documents*. Create an API key, assign it, and allow `sessionId` in override configuration.

**Step 2b: Dify path.** *Knowledge → Create* → upload `acme-faq.md`, chunking *Custom* by `##` headings, embedding `nomic-embed-text`. *Studio → Create App → Chatflow* → keep *Start → Knowledge Retrieval → LLM → Answer*; select your knowledge base, model `llama3.2`, put `{{#context#}}` in the system prompt with the same instructions as above, and enable *Citations* in features. Publish, then copy the API key from *API Access*.

**Step 3: test cases.**

```json
[
  {"q": "How long do I have to request a refund?", "must": ["30 days"], "source": true},
  {"q": "Is SSO on the Team plan?", "must": ["Enterprise"], "source": true},
  {"q": "Where is my data stored?", "must": ["Frankfurt"], "source": true},
  {"q": "Do you have a mobile app?", "must": ["support@acme.example"], "source": false},
  {"q": "My name is Lena. Remember it.", "must": [], "source": false, "session": "mem"},
  {"q": "What is my name?", "must": ["Lena"], "source": false, "session": "mem"}
]
```

**Step 4: the regression harness.** It calls the façade, not the builder, so the same script keeps working after you migrate.

```python
# regress.py — run cases against the facade; non-zero exit on regressions (wire into CI or a nightly cron)
import json
import os
import statistics
import sys
import time
import uuid
from pathlib import Path

import httpx
from dotenv import load_dotenv

load_dotenv()
URL = os.getenv("FACADE_URL", "http://localhost:8080").rstrip("/") + "/v1/chat"
HEADERS = {"Authorization": f"Bearer {os.environ.get('FACADE_TOKEN', '')}"}


def check(case: dict, resp: dict) -> list[str]:
    problems = [f"missing {m!r}" for m in case["must"] if m.lower() not in resp["answer"].lower()]
    if case.get("source") and not any(resp.get("sources") or []):
        problems.append("expected a source citation")
    return problems


def main() -> int:
    cases = json.loads(Path(sys.argv[1] if len(sys.argv) > 1 else "cases.json").read_text())
    run_id = uuid.uuid4().hex[:6]
    lat, failed = [], 0
    with httpx.Client(timeout=120, headers=HEADERS) as c:
        for i, case in enumerate(cases):
            sid = f"{run_id}-{case.get('session', i)}"          # shared session only where the case says so
            t0 = time.perf_counter()
            r = c.post(URL, json={"message": case["q"], "session_id": sid})
            lat.append(time.perf_counter() - t0)
            if r.status_code != 200:
                print(f"FAIL [{r.status_code}] {case['q']}")
                failed += 1
                continue
            probs = check(case, r.json())
            failed += bool(probs)
            print(f"{'FAIL' if probs else 'PASS'} {lat[-1]:5.1f}s {case['q']}  {'; '.join(probs)}")
    print(f"\n{len(cases) - failed}/{len(cases)} passed · p50 {statistics.median(lat):.1f}s · max {max(lat):.1f}s")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
```

**Step 5: run.**

```bash
pytest -q test_parsers.py                                    # parsers, offline
FACADE_TOKEN=dev ASSISTANT_BACKEND=flowise python facade.py &   # or ASSISTANT_BACKEND=dify
FACADE_TOKEN=dev python regress.py cases.json
```

Illustrative output:

```text
PASS   2.4s How long do I have to request a refund?
PASS   1.9s Is SSO on the Team plan?
PASS   2.1s Where is my data stored?
PASS   1.6s Do you have a mobile app?
PASS   1.2s My name is Lena. Remember it.
PASS   1.4s What is my name?

6/6 passed · p50 1.8s · max 2.4s
```

**Done when:**
- [ ] All six cases pass through the façade; the memory pair passes only because the session id is shared.
- [ ] Change the chunk size or system prompt on the canvas, rerun `regress.py`, and see the effect (break it on purpose once).
- [ ] The builder's port is reachable only from the façade (or localhost), and the flow requires an API key.
- [ ] The flow is exported (Flowise *Export Chatflow*, Dify *Export DSL*) and committed next to `cases.json`.

**Stretch goals:** build the same bot in the second tool and run `regress.py` against both backends to compare quality and latency; add an n8n workflow that re-uploads the FAQ to the knowledge base when the file changes; add a `langchain` backend to the façade using Ch 13's pipeline and A/B it.

---

## 7. Comparison Table

| | Flowise | Langflow | Dify | n8n AI nodes ([Ch 09](topic.html?p=09-n8n-fundamentals)) | Code: LangChain/LangGraph ([Ch 13](topic.html?p=13-langchain-core-lcel)) |
|---|---|---|---|---|---|
| Built with | Node.js / TypeScript | Python | Python (API) + Next.js (web) | Node.js | Python |
| Sweet spot | Chatbots, RAG, agentflows, embeddable widget | Python-centric teams, custom components, flows as MCP servers | Team LLM apps: knowledge base, app logs, annotation, workflows | Business workflows with an AI step | Anything; full control |
| RAG ingestion | Loaders, splitters, document stores, upsert API | Components, you wire it | Built-in Knowledge with chunking UI, API | Vector store nodes | Your code (Ch 15–18) |
| Custom code | JS custom tools/functions | Python components (edit in UI) | Code node (Py/JS sandbox), plugins, OpenAPI tools | JS/Python Code node | Unlimited |
| API | `/api/v1/prediction/{id}` | `/api/v1/run/{id}`, webhook, MCP | `/v1/chat-messages`, `/v1/workflows/run` | Webhook trigger | You design it |
| Multi-user / governance | Users, workspaces (3.x) | Users, projects | Workspaces, roles, app logs, annotations | Users, projects (paid tiers for RBAC) | Your platform |
| Licence | Apache-2.0 | MIT | Open source with extra conditions (check before multi-tenant SaaS use) | Sustainable Use (fair-code) | MIT |
| Self-host weight | Light: 1 container (+ DB) | Light: 1 container (+ DB) | Heavy: ~10 containers | Medium | Your service |

**When to use which:**
- **Flowise:** fastest path to a chatbot or RAG widget, JavaScript-friendly team, light hosting.
- **Langflow:** your team writes Python and wants to drop into code inside the canvas, or you want flows exposed as MCP tools to agents ([Ch 28](topic.html?p=28-mcp-fastmcp)).
- **Dify:** non-developers will own prompts and knowledge content, and you want logs, annotations, a knowledge UI and multi-app governance out of the box; accept the heavier stack and check the licence.
- **n8n:** the job is mostly integrations and business process; the LLM is one step.
- **Graduate to code** when you need: unit tests and evals in CI gating every change, per-user/tenant data permissions in retrieval, unusual control flow (loops with state, multi-agent with custom routing), strict cost controls, or latency budgets the builder's overhead can't meet. Keep the façade, swap the backend.

---

## 8. Common Mistakes & Best Practices

**Mistake 1: exposing the builder to the internet.** Default dev settings (Langflow auto-login, unauthenticated flows, default Dify passwords) on a public IP mean anyone can read your credentials and run up your model bill. *Fix:* builders on a private network or behind SSO/VPN; only the façade is public; API keys required on every flow.

**Mistake 2: calling the builder directly from browsers or many services.** Every caller now depends on Flowise's response shape and your API key leaks to the frontend. *Fix:* one façade (Example 6) with your auth, rate limiting and a stable contract.

**Mistake 3: no version control.** Someone tweaks the prompt on Friday; Monday's answers are worse and nobody knows what changed. *Fix:* export flows (JSON / Dify DSL) to git after each change, restrict editor roles, and run the regression harness before and after.

**Mistake 4: losing the encryption secret.** Recreate the container without the persisted secret key and every stored credential is unreadable (same lesson as n8n's `N8N_ENCRYPTION_KEY`). *Fix:* set it explicitly from a secrets manager and back it up separately from the database.

**Mistake 5: SQLite and in-memory vector stores in production.** Fine for a demo; lost on restart or unshareable across replicas. *Fix:* Postgres for the app database; Chroma/Qdrant/pgvector for vectors ([Ch 18](topic.html?p=18-vector-databases)).

**Mistake 6: one shared session id.** All users share one memory and see each other's context. *Fix:* session/conversation ids per user and conversation, derived in the façade from the authenticated user.

**Mistake 7: `localhost` for Ollama inside containers.** *Fix:* `host.docker.internal` (plus `host-gateway` on Linux) or a service name on a shared network.

**Mistake 8: trusting stream formats across upgrades.** An event rename returns empty answers with HTTP 200. *Fix:* pure parser functions with captured fixtures (Example 4), pinned image tags, a staging instance.

**Mistake 9: ignoring licences.** Building a multi-tenant SaaS on a tool whose licence restricts that. *Fix:* read the licence (Dify's in particular) before committing; ask legal for anything customer-facing.

**Best-practice checklist**
- [ ] Image tags pinned; encryption secrets set explicitly and backed up; Postgres for state.
- [ ] Builder UI private; flows require API keys; only the façade is public.
- [ ] Ollama reachable via `host.docker.internal` or a service name; model names checked against `ollama list`.
- [ ] Session ids per user and conversation, created by the façade.
- [ ] Flows exported to git; a regression script runs after every canvas change.
- [ ] Token usage and latency logged per request; budget alerts.
- [ ] A written "graduate to code when…" trigger list for the team.

---

## 9. Exercises

1. **Same bot, three tools.** Build the FAQ bot in Flowise, Langflow and Dify. Run `regress.py` against each (add a Langflow backend to the façade) and fill in a table of pass rate, p50 latency and setup time.
2. **Tweaks drill.** In Langflow, find the component id of your model and use `tweaks` to switch between `llama3.2` and `qwen3:8b` per request. Compare answers on the six cases.
3. **Knowledge sync.** Write a Python script (or n8n workflow) that uploads changed Markdown files to a Dify knowledge base via its dataset API and deletes removed ones.
4. **Streaming UI.** Add a `/v1/chat/stream` endpoint to the façade that re-emits Flowise or Dify tokens as SSE, and consume it with `httpx.stream`.
5. **Graduation plan.** Pick one flow and rewrite it as an LCEL chain (Ch 13). Add it as a backend in the façade and A/B both with the regression harness.

### Self-check questions

**Q: How do visual LLM builders differ from workflow tools like n8n or Zapier?**
A: Workflow tools automate business processes across many apps, with an LLM as one step. Visual LLM builders focus on the LLM app itself (chains, RAG, agents, memory) with node types for loaders, splitters, vector stores and retrievers, a built-in chat tester and an API per flow. They often work together: n8n handles triggers and integrations and calls a Flowise or Dify flow for the LLM part.

**Q: How do you keep conversation memory across API calls in Flowise, Langflow and Dify?**
A: Send a stable session identifier with every call: Flowise uses `overrideConfig.sessionId` (it must be allowed for the flow), Langflow uses `session_id`, and Dify returns a `conversation_id` on the first call that you send back together with the same required `user` id.

**Q: Why put a façade service in front of a visual builder?**
A: It keeps the builder private, centralises your own authentication, rate limits and logging, hides vendor-specific request and response shapes behind a stable contract, maps users to session ids, and lets you swap or A/B the backend (another builder, or a code implementation) without changing any caller.

**Q: When does a flow built on a canvas need to become code?**
A: When you need tests and evals gating every change, per-user or per-tenant data permissions inside retrieval, control flow the canvas can't express cleanly (stateful loops, custom multi-agent routing), strict cost or latency budgets, or deep integration with your codebase. The usual path is to keep the façade and replace the backend with a LangChain or LangGraph implementation.

**Q: What are the security basics before exposing any of these tools?**
A: Disable auto-login and set admin credentials, require API keys on flows, keep the UI on a private network or behind SSO, set and back up the encryption secret, use Postgres instead of SQLite, pin image versions, never put provider keys in exported flow JSON, and route public traffic through a façade with rate limiting.

**Q: An upgrade of your builder left the API returning HTTP 200 with empty answers. How do you diagnose and prevent this? (Senior)**
A: Capture the raw response or stream with curl and compare it with what your client parses; typically a field moved or a streaming event was renamed. Prevent it by pinning image tags, keeping parsers as pure functions with captured fixtures in tests, upgrading on a staging instance first, and running the end-to-end regression harness through the façade before switching production.

**Q: Your team wants Dify for a customer-facing multi-tenant product. What would you check before agreeing? (Senior)**
A: The licence terms for multi-tenant SaaS use and branding, how tenant isolation would work for knowledge bases and conversations (per-tenant apps and keys vs one shared app), whether retrieval can enforce per-user document permissions, operating cost and complexity of the full stack (Postgres, Redis, vector DB, sandbox, plugin daemon), upgrade cadence and breaking changes, observability and cost controls per tenant, and an exit plan via the façade if requirements outgrow it.

---

## 10. Summary & Official Docs

- **Flowise** (Node.js, Apache-2.0): chatflows and agentflows, light to host, `POST /api/v1/prediction/{id}` with a Bearer key.
- **Langflow** (Python, MIT): editable Python components (`lfx`), tweaks per request, `POST /api/v1/run/{id}` with `x-api-key`, flows as webhooks and MCP servers.
- **Dify** (Python, licence with conditions): apps + built-in Knowledge, logs and annotations; `POST /v1/chat-messages` / `/v1/workflows/run`, app-scoped keys, required `user`.
- All three: self-host with Docker, point at Ollama via `host.docker.internal`, set encryption secrets, use Postgres, pin versions.
- Memory needs a session id per user and conversation; streaming is SSE with tool-specific events.
- Put a **façade** in front: your auth, your contract, swappable backends.
- Treat canvas edits as deploys: export to git and run a **regression harness** after each change.
- **Graduate to code** (Ch 13–14, 23) for tests, permissions, complex control flow and strict budgets.

| You want | Pick |
|---|---|
| Chatbot/RAG demo today, light ops | Flowise |
| Python components, MCP exposure | Langflow |
| Content team owns prompts and knowledge | Dify |
| Integrations-first automation | n8n |
| Full control, tests, scale | LangChain / LangGraph code |

**Official docs**
- Flowise: https://docs.flowiseai.com/ (API reference: prediction, vector upsert)
- Langflow: https://docs.langflow.org/ (Run flow API, custom components, MCP server)
- Dify: https://docs.dify.ai/ (self-hosting with Docker Compose, app API, knowledge API)
- Ollama: https://ollama.com/
- Docker background: [Docker · Compose](../docker/topic.html?p=18-compose)

**Next:** [Ch 12 · Connecting n8n with Python Scripts](topic.html?p=12-n8n-with-python): the hybrid pattern where n8n orchestrates and Python services (or a builder façade like the one above) do the thinking.

---

*AI Automation with Python Handbook — chapter 11.*
