#!/usr/bin/env python3
"""Generate tools/topics/ai_automation_topics.json — the AI Automation handbook manifest (full TOC)."""
import json, html, os

OUT = "/Users/himanshu/Temp11/DSA-Patterns-Handbook/tools/topics/ai_automation_topics.json"
MD = "/Users/himanshu/Temp11/DSA-Patterns-Handbook/ai-automation/markdown"

PARTS = [
    # (category name, level, icon, part label)
    ("Part 1 · LLM Fundamentals", "Beginner", "🧠"),
    ("Part 2 · No-Code & Low-Code", "Beginner", "🧩"),
    ("Part 3 · LangChain", "Intermediate", "⛓️"),
    ("Part 4 · RAG", "Intermediate", "📚"),
    ("Part 5 · Agents & Multi-Agent", "Advanced", "🤖"),
    ("Part 6 · Protocols", "Advanced", "🔌"),
    ("Part 7 · Automation Integrations", "Advanced", "📬"),
    ("Part 8 · Scheduling & Orchestration", "Advanced", "⏱️"),
    ("Part 9 · Deployment & LLMOps", "Expert", "🚀"),
    ("Part 10 · Security", "Expert", "🛡️"),
    ("Appendices", "Expert", "📎"),
]

# (part_index, slug-suffix, name, summary, keywords, kind)
C = [
 (0, "how-llms-work", "How LLMs Work: Tokens, Context, Temperature, Hallucinations & Cost",
  "The working model an automation engineer needs: tokens, context windows, sampling and temperature, why models hallucinate, and how to estimate and control cost before you ship.",
  ["tokens", "context window", "temperature", "top-p", "hallucination", "cost", "tiktoken", "latency"]),
 (0, "prompt-engineering", "Prompt Engineering: System Prompts, Few-Shot & Chain-of-Thought",
  "Prompts as code: system prompts, few-shot examples, delimiters, chain-of-thought vs reasoning models, prompt templates, versioning and a regression harness.",
  ["system prompt", "few-shot", "chain-of-thought", "prompt template", "delimiters", "prompt versioning"]),
 (0, "structured-outputs", "Structured Outputs: Reliable JSON with Pydantic",
  "From 'please reply in JSON' to schema-constrained decoding: JSON mode, json_schema / strict structured outputs, Pydantic models, Instructor, validation and repair loops.",
  ["json", "pydantic", "json schema", "structured outputs", "instructor", "validation", "extraction"]),
 (0, "function-calling", "Function Calling & Tool Use",
  "How models request your functions: tool schemas, the tool-use loop, parallel calls, errors, tool choice, and safe execution — the foundation of every agent.",
  ["function calling", "tool use", "tool loop", "parallel tools", "tool_choice", "strict tools"]),
 (0, "embeddings", "Embeddings & Semantic Similarity",
  "Text as vectors: embedding models, cosine similarity, normalisation, batching, dimensions and cost — semantic search, dedup, clustering and routing without a vector DB.",
  ["embeddings", "cosine similarity", "vectors", "sentence-transformers", "semantic search", "dimensions"]),
 (0, "model-apis", "Model APIs: OpenAI, Claude, Gemini & Groq",
  "The four API families you will meet in production: their SDKs, request shapes, streaming, errors and rate limits — and a thin provider-neutral client you own.",
  ["openai", "anthropic", "claude", "gemini", "groq", "streaming", "sdk", "rate limits"]),
 (0, "multi-provider-routing", "Multi-Provider Routing: LiteLLM & OpenRouter",
  "One interface, many models: LiteLLM SDK and proxy, OpenRouter, fallbacks, load balancing, cost-based routing, budgets and virtual keys.",
  ["litellm", "openrouter", "fallback", "routing", "gateway", "proxy", "budget"]),
 (0, "local-models", "Local Models: Ollama & Hugging Face",
  "Run models on your own hardware: Ollama, its OpenAI-compatible endpoint, quantisation and VRAM, Hugging Face transformers and Inference Providers — and when local is worth it.",
  ["ollama", "hugging face", "transformers", "gguf", "quantization", "local llm", "privacy"]),

 (1, "n8n-fundamentals", "n8n: Triggers, Nodes, AI Agent Node, Code Node, Webhooks & Self-Hosting",
  "Self-hosted workflow automation: triggers, nodes and items, expressions, the AI Agent node with tools and memory, the Code node, webhooks, credentials and Docker deployment.",
  ["n8n", "workflow", "trigger", "webhook", "ai agent node", "code node", "docker", "self-hosting"]),
 (1, "make-zapier-power-automate", "Make, Zapier & Power Automate",
  "The SaaS automation platforms: scenarios, zaps and flows, AI steps, pricing models, limits and governance — and how they compare to n8n.",
  ["make", "zapier", "power automate", "saas automation", "no-code", "operations"]),
 (1, "flowise-langflow-dify", "Flowise, Langflow & Dify",
  "Visual LLM app builders: drag-and-drop chains, RAG and agents, their APIs, self-hosting, and when to graduate to code.",
  ["flowise", "langflow", "dify", "visual builder", "low-code llm", "chatflow"]),
 (1, "n8n-with-python", "Connecting n8n with Python Scripts",
  "Hybrid automation: n8n calling FastAPI services, Python calling n8n webhooks, Execute Command, queues, auth, and where each piece of logic should live.",
  ["n8n", "python", "fastapi", "webhook", "hybrid automation", "microservice"]),

 (2, "langchain-core-lcel", "LangChain Core: Prompts, Chains (LCEL) & Output Parsers",
  "LangChain's building blocks: chat models, prompt templates, the Runnable interface and LCEL, output parsers, structured output, streaming and batching.",
  ["langchain", "lcel", "runnable", "prompt template", "output parser", "chat model"]),
 (2, "langchain-tools-agents", "LangChain Tools & Agents",
  "Tools as Python functions, tool-calling models, create_agent, middleware, and how LangChain agents relate to LangGraph.",
  ["langchain", "tools", "agents", "create_agent", "tool calling", "middleware"]),
 (2, "document-loaders-splitters", "Document Loaders & Text Splitters",
  "Getting documents into LLM-sized pieces: loaders for PDFs, web, Office and databases; recursive, token, markdown and semantic splitters; metadata.",
  ["document loader", "text splitter", "chunk size", "overlap", "metadata", "langchain"]),

 (3, "rag-fundamentals", "RAG Fundamentals: Chunking, Embeddings & Retrieval",
  "The full retrieval-augmented generation pipeline: ingest, chunk, embed, store, retrieve, generate with citations — and the failure modes at each step.",
  ["rag", "retrieval", "chunking", "embeddings", "citations", "grounding"]),
 (3, "reranking-hybrid-search", "Reranking & Hybrid Search",
  "Beyond top-k cosine: BM25 + vector hybrid search, reciprocal rank fusion, cross-encoder reranking, query rewriting, HyDE and multi-query.",
  ["reranking", "hybrid search", "bm25", "rrf", "cross-encoder", "query rewriting", "hyde"]),
 (3, "vector-databases", "Vector Databases: Chroma, FAISS, Qdrant, Pinecone & pgvector",
  "Where embeddings live: ANN indexes (HNSW, IVF), filtering, persistence, scaling and cost — five stores compared with the same code.",
  ["vector database", "chroma", "faiss", "qdrant", "pinecone", "pgvector", "hnsw"]),
 (3, "llamaindex-haystack", "LlamaIndex & Haystack",
  "Two RAG-first frameworks: LlamaIndex indexes, query engines and workflows; Haystack pipelines and components — compared with LangChain.",
  ["llamaindex", "haystack", "query engine", "pipeline", "rag framework"]),
 (3, "document-parsing", "Document Parsing: PyMuPDF, Unstructured & Docling",
  "Garbage in, garbage out: extracting text, tables and layout from PDFs and Office files, OCR fallbacks, and parsing at scale.",
  ["pymupdf", "unstructured", "docling", "pdf parsing", "tables", "layout"]),

 (4, "agent-patterns", "Agent Patterns: ReAct, Planning & Reflection",
  "How agents think: the ReAct loop, plan-and-execute, reflection and self-critique, stopping conditions, and when a workflow beats an agent.",
  ["react", "planning", "reflection", "agent loop", "plan-and-execute", "workflow vs agent"]),
 (4, "agent-memory-mem0", "Agent Memory & Mem0",
  "Short-term vs long-term memory, summarisation, semantic memory stores, Mem0 for user-level memory, and privacy of remembered data.",
  ["memory", "mem0", "long-term memory", "summarization", "personalization"]),
 (4, "langgraph-fundamentals", "LangGraph: State, Nodes & Edges",
  "Agents as graphs: typed state, reducers, nodes, conditional edges, cycles, tool nodes, subgraphs and streaming.",
  ["langgraph", "state graph", "nodes", "edges", "reducers", "conditional edges"]),
 (4, "langgraph-production", "LangGraph in Production: Checkpoints & Human-in-the-Loop",
  "Durable agents: checkpointers, threads, interrupts and approvals, time travel, persistence with Postgres, and deployment.",
  ["langgraph", "checkpoint", "human-in-the-loop", "interrupt", "persistence", "thread"]),
 (4, "crewai", "CrewAI: Roles, Tasks & Crews",
  "Role-based multi-agent teams: agents, tasks, crews, processes, flows, tools and memory — with an honest look at cost and control.",
  ["crewai", "multi-agent", "roles", "tasks", "crew", "flows"]),
 (4, "vendor-agent-sdks", "OpenAI Agents SDK, Claude Agent SDK & Google ADK",
  "The model vendors' agent frameworks: agents, handoffs, guardrails and tracing; Claude Code as a library; Google's Agent Development Kit — compared.",
  ["openai agents sdk", "claude agent sdk", "google adk", "handoffs", "guardrails"]),
 (4, "agent-frameworks-tour", "PydanticAI, AutoGen/AG2, smolagents & DSPy",
  "Four more philosophies: type-safe agents, conversational multi-agent, code-writing agents, and programming (not prompting) LLMs.",
  ["pydanticai", "autogen", "ag2", "smolagents", "dspy", "framework comparison"]),

 (5, "mcp-fastmcp", "MCP: Building Model Context Protocol Servers with FastMCP",
  "The USB-C of AI tools: MCP hosts, clients and servers, tools/resources/prompts, transports, building servers with FastMCP, auth and security.",
  ["mcp", "model context protocol", "fastmcp", "tools", "resources", "stdio", "streamable http"]),
 (5, "a2a-protocol", "A2A: The Agent-to-Agent Protocol",
  "How independent agents discover and delegate to each other: agent cards, tasks, messages, artifacts, streaming — and how A2A complements MCP.",
  ["a2a", "agent card", "agent-to-agent", "interoperability", "tasks"]),

 (6, "google-workspace-m365", "Gmail, Google Workspace & Microsoft 365",
  "Automating email, calendars, docs and sheets: OAuth, service accounts, Gmail and Graph APIs, push notifications, and AI triage pipelines.",
  ["gmail", "google workspace", "microsoft 365", "graph api", "oauth", "email automation"]),
 (6, "chat-bots", "Telegram, WhatsApp, Slack & Discord Bots",
  "AI assistants where users already are: bot APIs, webhooks vs polling, message formats, rate limits and conversation state.",
  ["telegram", "whatsapp", "slack", "discord", "chatbot", "webhook"]),
 (6, "browser-agents", "Browser Agents: Playwright & browser-use",
  "Automating the web: deterministic Playwright scripts, LLM-driven browser agents, selectors vs vision, anti-bot reality and safety.",
  ["playwright", "browser-use", "web automation", "scraping", "computer use"]),
 (6, "voice-agents", "Voice: Whisper, ElevenLabs, Vapi & Retell",
  "Speech in, speech out: transcription, text-to-speech, real-time voice agents, latency budgets and telephony.",
  ["whisper", "speech to text", "elevenlabs", "tts", "vapi", "retell", "voice agent"]),
 (6, "ocr-vision", "OCR & Multimodal Vision",
  "Reading images and documents: Tesseract and cloud OCR versus vision LLMs, invoice and receipt extraction, and accuracy checks.",
  ["ocr", "tesseract", "vision", "multimodal", "invoice extraction", "image"]),
 (6, "rpa", "RPA: UiPath & pyautogui",
  "When there is no API: robotic process automation, desktop scripting with pyautogui, UiPath, and adding AI to legacy workflows.",
  ["rpa", "uipath", "pyautogui", "desktop automation", "legacy"]),

 (7, "scheduling-task-queues", "Cron, APScheduler & Celery + Redis",
  "Running automations on time and in the background: cron, APScheduler, Celery workers with Redis, retries and idempotency.",
  ["cron", "apscheduler", "celery", "redis", "task queue", "scheduling"]),
 (7, "workflow-orchestrators", "Prefect, Airflow & Temporal",
  "Orchestrating multi-step pipelines: DAGs, flows, durable execution, retries and observability — which orchestrator for which job.",
  ["prefect", "airflow", "temporal", "orchestration", "dag", "durable execution"]),

 (8, "ai-uis", "UIs for AI Apps: Streamlit, Gradio & Chainlit",
  "Putting a face on an automation: chat UIs, file upload, streaming, auth and sharing — three frameworks compared.",
  ["streamlit", "gradio", "chainlit", "chat ui", "demo"]),
 (8, "deploy-docker-cicd", "Deployment: Docker, Cloud/VPS Hosting & GitHub Actions",
  "Shipping AI services: Dockerfiles for Python AI apps, VPS vs PaaS vs serverless, secrets, and CI/CD with evals in the pipeline.",
  ["docker", "vps", "cloud", "github actions", "ci/cd", "deployment"]),
 (8, "observability-langsmith-langfuse", "Monitoring: LangSmith & Langfuse",
  "Seeing inside LLM apps: traces, spans, prompts, token and cost tracking, user feedback, datasets — hosted and self-hosted.",
  ["langsmith", "langfuse", "tracing", "observability", "opentelemetry", "monitoring"]),
 (8, "evaluation", "Evaluation: RAGAS, DeepEval & promptfoo",
  "Proving your automation works: golden datasets, LLM-as-judge, RAG metrics, regression tests in CI and red-teaming.",
  ["evaluation", "ragas", "deepeval", "promptfoo", "llm as judge", "regression"]),
 (8, "reliability-cost", "Caching, Rate Limits, Retries & Cost Tracking",
  "Production hardening: prompt and response caching, backoff, circuit breakers, concurrency limits, budgets and per-feature cost attribution.",
  ["caching", "rate limits", "retries", "backoff", "cost tracking", "budget"]),

 (9, "prompt-injection-sandboxing", "Prompt Injection & Sandboxing Code Execution",
  "The top LLM risk: direct and indirect injection, the lethal trifecta, defence in depth, least privilege, and running model-written code safely.",
  ["prompt injection", "indirect injection", "sandbox", "least privilege", "owasp llm", "code execution"]),
 (9, "secrets-pii", "Secrets Management & PII Handling",
  "Keeping keys and personal data safe: env vars, secret managers, rotation, PII detection and redaction with Presidio, retention and compliance.",
  ["secrets", "api keys", "pii", "presidio", "redaction", "gdpr", "compliance"]),

 (10, "glossary", "Appendix A · Glossary of AI Automation Terms",
  "Every term used in the handbook, defined in one or two plain sentences with a link to its home chapter.",
  ["glossary", "terms", "definitions"]),
 (10, "cheat-sheet", "Appendix B · Cheat Sheet: Key Commands & Snippets",
  "One-screen reference: install commands, env vars, the canonical snippet for each SDK and framework, and Docker one-liners.",
  ["cheat sheet", "commands", "snippets", "reference"]),
 (10, "portfolio-projects", "Appendix C · 10 Portfolio Project Ideas",
  "Ten projects from beginner to advanced, each with scope, stack, stretch goals and what it proves to an employer or client.",
  ["portfolio", "projects", "ideas", "beginner to advanced"]),
 (10, "capstone", "Appendix D · Capstone: n8n + LangGraph + RAG + MCP, Deployed",
  "An end-to-end support-operations automation: n8n intake, a LangGraph agent with RAG and MCP tools, human approval, Docker deployment, tracing and evals.",
  ["capstone", "n8n", "langgraph", "rag", "mcp", "deployment"]),
 (10, "roadmap", "Appendix E · 12-Week Learning Roadmap",
  "A week-by-week plan through the handbook with hours, deliverables and checkpoints.",
  ["roadmap", "12 weeks", "study plan", "learning path"]),
]

items = []
for i, (p, suffix, name, summary, kw) in enumerate(C, 1):
    cat, lvl, _ = PARTS[p]
    it = {"id": i, "slug": "%02d-%s" % (i, suffix), "name": name, "category": cat, "level": lvl,
          "summary": summary, "keywords": kw, "refs": ["Official documentation"]}
    if p == 10:
        it["kind"] = "appendix"
    items.append(it)

# phases (30-day journey) = parts
phases, last = [], {}
for it in items:
    last[it["category"]] = it["id"]
for cat, lvl, ic in PARTS:
    phases.append({"until": last[cat], "label": cat.split("· ", 1)[-1]})

# ---- home intro: thesis + stats + full table of contents ----
def esc(s): return html.escape(s, quote=True)

BOX = ('flex:1 1 150px;padding:12px 16px;border:1px solid var(--border);'
       'border-radius:var(--radius);background:var(--bg-elev)')
def stat(n, label):
    return ('<div style="%s"><div style="font-size:26px;font-weight:800;color:var(--accent);line-height:1.1">%s</div>'
            '<div style="font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-soft);margin-top:4px">%s</div></div>'
            % (BOX, n, label))

toc = []
for cat, lvl, ic in PARTS:
    rows = [it for it in items if it["category"] == cat]
    def li(it):
        if os.path.exists(os.path.join(MD, it["slug"] + ".md")):
            return '<li style="margin:2px 0"><a href="topic.html?p=%s">%s</a></li>' % (it["slug"], esc(it["name"]))
        return ('<li style="margin:2px 0;color:var(--text-soft)">%s <span style="font-size:11px;'
                'text-transform:uppercase;letter-spacing:.05em;opacity:.8">· coming soon</span></li>' % esc(it["name"]))
    lis = "".join(li(it) for it in rows)
    toc.append('<details style="border:1px solid var(--border);border-radius:var(--radius);background:var(--bg-elev);'
               'padding:8px 14px;margin:0 0 8px"><summary style="cursor:pointer;font-weight:600">%s %s '
               '<span class="badge lvl-%s" style="margin-left:6px">%02d–%02d</span></summary>'
               '<ol start="%d" style="margin:8px 0 4px;padding-left:28px;font-size:14px">%s</ol></details>'
               % (ic, esc(cat), lvl, rows[0]["id"], rows[-1]["id"], rows[0]["id"], lis))

home = ('<section class="aa-intro" style="margin:18px 0 8px">'
        '<blockquote style="margin:0 0 16px;padding:16px 20px;border-left:4px solid var(--accent);background:var(--accent-soft);'
        'border-radius:0 var(--radius) var(--radius) 0;font-size:17px;line-height:1.5;color:var(--text)"><strong>'
        'You already know Python, APIs and data. This handbook turns that into AI automations that run unattended in production: '
        'LLM APIs, n8n, RAG, agents, MCP, integrations, scheduling, deployment, monitoring and security.</strong></blockquote>'
        '<div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:14px">'
        + stat("10", "Parts") + stat("44", "Chapters") + stat("5", "Appendices") + stat("44", "Mini projects")
        + '</div><p class="muted" style="font-size:14px;margin:0 0 10px">Every chapter follows the same 10 steps: overview, key concepts, setup, '
        'runnable Python 3.11+ code, a real business use case, a 1–2 hour mini project, a comparison table, mistakes &amp; best practices, '
        'exercises with self-check questions, and links to the official docs. Free and open-source first (Ollama, Chroma, self-hosted n8n); '
        'paid options are named alongside. For the theory underneath (transformers, training, fine-tuning) see the '
        '<a href="../ai-engineering/index.html">AI Engineering</a> handbook.</p>'
        '<h3 style="margin:18px 0 10px">Table of contents</h3>' + "".join(toc) + '</section>')

d = {
    "id": "ai-automation",
    "name": "AI Automation with Python Handbook",
    "icon": "🦾",
    "tagline": ("From LLM APIs to production agents. Build, deploy and monitor real AI automations with Python and n8n: "
                "prompts, structured outputs, tool calling, embeddings, OpenAI/Claude/Gemini/Groq, LiteLLM, Ollama, n8n, Make, Zapier, "
                "LangChain, RAG and vector databases, LangGraph, CrewAI, agent SDKs, MCP and A2A, Gmail/Slack/WhatsApp bots, browser and "
                "voice agents, Celery/Prefect/Temporal, Streamlit, Docker, Langfuse, evals, and LLM security — with mini projects, "
                "Mermaid and SVG diagrams, and a capstone."),
    "itemNoun": "Chapter",
    "videoTag": "AI automation Python",
    "levels": ["Beginner", "Intermediate", "Advanced", "Expert"],
    "categories": [{"name": c, "level": l, "icon": ic} for c, l, ic in PARTS],
    "phases": phases,
    "journey": {
        "practicePattern": "^(47|48)-",
        "practiceVerb": "Build",
        "practiceNamePrefix": "^Appendix [A-E] · \\s*",
        "conceptChallenge": "Explain how you would use {name} in a real business automation, and name one way it fails in production.",
        "practiceTabLabel": "🏗️ Build Rounds",
        "practiceIntro": "Plan a real automation end to end. Talk through each step aloud — trigger, model, tools, data, failure modes — then open the chapter to compare.",
        "practiceStartLabel": "Start build →",
        "practiceBackLabel": "← All builds",
        "practiceDrillTag": "60-min build plan",
        "practiceDrillIntro": "Work through each step. Tick items as you cover them, then compare with the full chapter.",
        "practiceSteps": [
            ["Define the job", "Who triggers it, what input arrives, what output is 'done', and what must never happen (wrong email sent, data leaked)."],
            ["Workflow or agent?", "Can the steps be fixed in advance? Prefer a deterministic workflow; use an agent only for open-ended steps."],
            ["Pick models", "Model per step by difficulty, latency and cost; a fallback provider; local model if data cannot leave."],
            ["Design prompts & schemas", "System prompt, few-shot examples, Pydantic output schemas, tool definitions."],
            ["Ground it", "Which data does it need? RAG over which sources, chunking, retrieval quality checks."],
            ["Wire integrations", "Triggers, webhooks, APIs (Gmail, Slack, CRM), MCP servers, n8n vs Python boundary."],
            ["Make it reliable", "Retries, idempotency, queues, schedules, caching, rate limits, human approval for risky actions."],
            ["Secure it", "Secrets, least-privilege tools, prompt-injection defences, PII redaction, sandboxing."],
            ["Ship & observe", "Docker, CI with evals, tracing (Langfuse/LangSmith), cost dashboards, alerting."],
        ],
    },
    "gate": {
        "requiredH2": ["## 1. Overview", "## 2. Key Concepts", "## 3. Setup", "## 4. Code Examples",
                        "## 5. Real-World Use Case", "## 6. Mini Project", "## 7. Comparison Table",
                        "## 8. Common Mistakes", "## 9. Exercises", "## 10. Summary"],
        "minSvg": 1, "minMermaid": 1, "minQ": 6,
    },
    "homeIntro": home,
    "items": items,
}
json.dump(d, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print("wrote", OUT, len(items), "items;", "phases:", [p["until"] for p in phases])
