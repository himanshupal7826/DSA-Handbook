# 45 · Appendix A · Glossary of AI Automation Terms

> **In one line:** Every term this handbook relies on, defined in one or two plain sentences, with a link to the chapter where it is taught in depth.

---

## How to use this glossary

- Terms are sorted A to Z. Each entry ends with an arrow link to its **home chapter**, the place the concept is explained with code.
- Definitions are deliberately short. If one sentence is not enough for you, follow the link instead of guessing.
- Product names (n8n, Chroma, Langfuse…) are listed alongside concepts because in AI automation the tool names *are* the vocabulary.
- For the theory behind tokens, attention and training, see the companion [AI Engineering handbook](../ai-engineering/topic.html?p=25-how-llms-work).

**Jump to:** [A](#a) · [B](#b) · [C](#c) · [D](#d) · [E](#e) · [F](#f) · [G](#g) · [H](#h) · [I](#i) · [J](#j) · [K](#k) · [L](#l) · [M](#m) · [N](#n) · [O](#o) · [P](#p) · [Q](#q) · [R](#r) · [S](#s) · [T](#t) · [U](#u) · [V](#v) · [W](#w) · [X](#x) · [Z](#z)

---

## A

**A2A (Agent-to-Agent protocol)** — An open protocol that lets independent agents, built by different teams or vendors, discover each other and delegate work over HTTP. It complements MCP: MCP connects an agent to tools, A2A connects agents to agents. → [Ch 29 · A2A Protocol](topic.html?p=29-a2a-protocol)

**Adaptive thinking** — Claude's built-in reasoning mode on current models, where the model decides how much to think before answering. You steer depth and cost with the `effort` setting instead of a token budget. → [Ch 06 · Model APIs](topic.html?p=06-model-apis)

**Agent** — A program in which an LLM chooses the next action (call a tool, ask a question, finish) in a loop until a goal is met. More flexible than a fixed workflow, and harder to test and bound. → [Ch 21 · Agent Patterns](topic.html?p=21-agent-patterns)

**Agent card** — A JSON document an A2A agent publishes (usually at `/.well-known/agent-card.json`) describing its name, skills, endpoint and auth. Other agents read it to decide whether and how to delegate. → [Ch 29 · A2A Protocol](topic.html?p=29-a2a-protocol)

**Agent loop** — The cycle of model call, tool execution and result feedback that repeats until the model returns a final answer or a step limit is hit. Every agent framework is a variation of it. → [Ch 21 · Agent Patterns](topic.html?p=21-agent-patterns)

**AI Agent node** — The n8n node that wraps an LLM with tools, memory and an output parser inside a workflow. Sub-nodes plug in the chat model, memory store and tools. → [Ch 09 · n8n Fundamentals](topic.html?p=09-n8n-fundamentals)

**Airflow** — Apache Airflow, the long-established Python DAG scheduler for batch data pipelines. Strong for scheduled ETL, less natural for event-driven or long-waiting AI workflows. → [Ch 37 · Workflow Orchestrators](topic.html?p=37-workflow-orchestrators)

**Alias (model alias)** — A capability name such as `fast`, `smart` or `local` that your code requests instead of a vendor model id. A router maps each alias to one or more real deployments. → [Ch 07 · Multi-Provider Routing](topic.html?p=07-multi-provider-routing)

**ANN (approximate nearest neighbour)** — Search that finds vectors close to a query without comparing against every stored vector. It trades a little recall for large speed gains and is what vector databases do. → [Ch 18 · Vector Databases](topic.html?p=18-vector-databases)

**APScheduler** — A Python library for in-process scheduling with cron, interval and date triggers. Good for a single service; reach for Celery beat or an orchestrator once you need several workers. → [Ch 36 · Scheduling & Task Queues](topic.html?p=36-scheduling-task-queues)

**Artifact (A2A)** — The output an A2A task produces, such as a document, file or structured data, returned as typed parts. Separate from the conversational messages exchanged while the task runs. → [Ch 29 · A2A Protocol](topic.html?p=29-a2a-protocol)

**AutoGen / AG2** — Multi-agent frameworks in which agents converse with each other to solve a task. AG2 is the community fork that continues the original AutoGen 0.2 design. → [Ch 27 · Agent Frameworks Tour](topic.html?p=27-agent-frameworks-tour)

---

## B

**Backoff** — Waiting progressively longer between retries (for example 1s, 2s, 4s plus jitter) so a struggling API can recover. Use it for 429 and 5xx errors, never for 400s. → [Ch 42 · Reliability & Cost](topic.html?p=42-reliability-cost)

**Batching** — Sending many inputs in one call or one job, such as a list of texts to an embedding endpoint or `.batch()` on a LangChain runnable. Cuts overhead and is often cheaper. → [Ch 13 · LangChain Core](topic.html?p=13-langchain-core-lcel)

**BM25** — A classic keyword ranking function based on term frequency and document length. It catches exact matches (SKUs, error codes, names) that embeddings miss. → [Ch 17 · Reranking & Hybrid Search](topic.html?p=17-reranking-hybrid-search)

**BPE (byte-pair encoding)** — The tokenisation scheme most LLMs use: frequent character sequences are merged into single tokens. It explains why rare words and non-English text cost more tokens. → [Ch 01 · How LLMs Work](topic.html?p=01-how-llms-work)

**browser-use** — An open-source Python library that lets an LLM drive a real browser through Playwright by reading the page and choosing clicks and keystrokes. → [Ch 32 · Browser Agents](topic.html?p=32-browser-agents)

**Budget** — A spending cap on a key, team or project, enforced by a gateway such as the LiteLLM proxy. Requests are rejected once the cap is reached. → [Ch 07 · Multi-Provider Routing](topic.html?p=07-multi-provider-routing)

---

## C

**Celery** — A distributed task queue for Python: your app enqueues jobs, workers execute them with retries, and a broker such as Redis carries the messages. → [Ch 36 · Scheduling & Task Queues](topic.html?p=36-scheduling-task-queues)

**Celery beat** — Celery's scheduler process, which enqueues tasks on a cron or interval schedule for workers to pick up. → [Ch 36 · Scheduling & Task Queues](topic.html?p=36-scheduling-task-queues)

**Chain (LangChain)** — A composition of runnables, typically prompt, then model, then parser, built with the `|` operator. It is itself a runnable with `invoke`, `stream` and `batch`. → [Ch 13 · LangChain Core](topic.html?p=13-langchain-core-lcel)

**Chain-of-thought (CoT)** — Prompting a model to reason step by step before answering. Reasoning models do this internally, so explicit CoT matters most for smaller or non-reasoning models. → [Ch 02 · Prompt Engineering](topic.html?p=02-prompt-engineering)

**Chainlit** — A Python framework for chat-style AI UIs with built-in display of intermediate steps, streaming and auth hooks. → [Ch 38 · UIs for AI Apps](topic.html?p=38-ai-uis)

**Chat model** — An LLM accessed through a messages interface (system, user, assistant, tool) rather than raw text completion. Every modern API and framework is built around it. → [Ch 13 · LangChain Core](topic.html?p=13-langchain-core-lcel)

**Checkpointer** — The LangGraph component that saves graph state after each step, keyed by thread id. It enables resumption after crashes, human-in-the-loop pauses and time travel. → [Ch 24 · LangGraph in Production](topic.html?p=24-langgraph-production)

**Chroma** — An open-source embedding database that runs in-process, on disk or as a server. The handbook's default local vector store. → [Ch 18 · Vector Databases](topic.html?p=18-vector-databases)

**Chunk overlap** — The number of characters or tokens repeated between neighbouring chunks so a sentence split across a boundary still appears whole in one of them. → [Ch 15 · Loaders & Splitters](topic.html?p=15-document-loaders-splitters)

**Chunking** — Splitting documents into retrieval-sized pieces before embedding. Chunk size and boundaries are among the biggest levers on RAG quality. → [Ch 16 · RAG Fundamentals](topic.html?p=16-rag-fundamentals)

**Circuit breaker** — A guard that stops calling a failing dependency for a cool-down period after repeated errors, so you fail fast and fall back instead of piling up timeouts. → [Ch 42 · Reliability & Cost](topic.html?p=42-reliability-cost)

**Citations** — References from a generated answer back to the source chunks it used. They let users verify claims and let you measure grounding. → [Ch 16 · RAG Fundamentals](topic.html?p=16-rag-fundamentals)

**Claude Agent SDK** — Anthropic's library that exposes the Claude Code agent harness (tools, file editing, permissions, subagents) for use in your own Python programs. → [Ch 26 · Vendor Agent SDKs](topic.html?p=26-vendor-agent-sdks)

**Code node** — The n8n node where you write JavaScript or Python to transform items when built-in nodes are not enough. → [Ch 09 · n8n Fundamentals](topic.html?p=09-n8n-fundamentals)

**Computer use** — Letting a model operate a desktop or browser through screenshots and mouse or keyboard actions. Powerful for UIs without APIs, slow and risky without a sandbox. → [Ch 32 · Browser Agents](topic.html?p=32-browser-agents)

**Conditional edge** — A LangGraph edge whose destination is chosen at runtime by a function that inspects the state, for example routing to tools or to the end. → [Ch 23 · LangGraph Fundamentals](topic.html?p=23-langgraph-fundamentals)

**Context window** — The maximum number of tokens (input plus output) a model can attend to in one request. Everything the model knows about your task must fit inside it. → [Ch 01 · How LLMs Work](topic.html?p=01-how-llms-work)

**Cosine similarity** — The cosine of the angle between two vectors, from -1 to 1. On normalised embeddings it equals the dot product and measures semantic closeness. → [Ch 05 · Embeddings](topic.html?p=05-embeddings)

**Cost per token** — How providers bill: a price per million input tokens and a usually higher price per million output tokens. Multiply by volume to estimate monthly spend. → [Ch 01 · How LLMs Work](topic.html?p=01-how-llms-work)

**Credentials (n8n)** — Encrypted secrets stored once in n8n and referenced by nodes, so API keys never appear inside workflow JSON. → [Ch 09 · n8n Fundamentals](topic.html?p=09-n8n-fundamentals)

**Crew** — In CrewAI, a group of agents and tasks run under a process (sequential or hierarchical) to reach a shared goal. → [Ch 25 · CrewAI](topic.html?p=25-crewai)

**CrewAI** — A Python framework for role-based multi-agent teams: you define agents with roles and goals, tasks with expected outputs, and a crew that runs them. → [Ch 25 · CrewAI](topic.html?p=25-crewai)

**Cron** — The Unix scheduling syntax (`minute hour day month weekday`) and daemon. Still the simplest way to run a script on a timetable. → [Ch 36 · Scheduling & Task Queues](topic.html?p=36-scheduling-task-queues)

**Cross-encoder** — A model that scores a query and a document together, giving more accurate relevance than comparing separate embeddings. Used to rerank a short candidate list. → [Ch 17 · Reranking & Hybrid Search](topic.html?p=17-reranking-hybrid-search)

---

## D

**DAG (directed acyclic graph)** — A set of steps with dependencies and no cycles, the model used by Airflow and most data orchestrators to decide execution order. → [Ch 37 · Workflow Orchestrators](topic.html?p=37-workflow-orchestrators)

**DeepEval** — A pytest-style Python framework for LLM evaluation with built-in metrics such as answer relevancy, faithfulness and G-Eval. → [Ch 41 · Evaluation](topic.html?p=41-evaluation)

**Delimiters** — Markers such as XML tags or triple backticks that separate instructions from data in a prompt. They reduce confusion and make injection harder, but do not prevent it. → [Ch 02 · Prompt Engineering](topic.html?p=02-prompt-engineering)

**Dense retrieval** — Retrieval by embedding similarity, as opposed to sparse keyword retrieval like BM25. Good at paraphrase, weaker at exact identifiers. → [Ch 17 · Reranking & Hybrid Search](topic.html?p=17-reranking-hybrid-search)

**Dify** — An open-source platform for building LLM apps, RAG and agents visually, with built-in datasets, an API and self-hosting via Docker. → [Ch 11 · Flowise, Langflow & Dify](topic.html?p=11-flowise-langflow-dify)

**Dimensions** — The length of an embedding vector, such as 384, 768 or 1536. More dimensions cost more storage and compute and do not always mean better retrieval. → [Ch 05 · Embeddings](topic.html?p=05-embeddings)

**Docker Compose** — A YAML file that defines several containers (API, worker, database, n8n, Ollama) and starts them together with one command. → [Ch 39 · Deployment & CI/CD](topic.html?p=39-deploy-docker-cicd)

**Docling** — An open-source document converter from IBM that extracts layout, tables and reading order from PDFs and Office files into Markdown or JSON. → [Ch 20 · Document Parsing](topic.html?p=20-document-parsing)

**Document loader** — A component that reads a source (PDF, web page, Notion, SQL) into document objects with text and metadata, ready for splitting. → [Ch 15 · Loaders & Splitters](topic.html?p=15-document-loaders-splitters)

**DSPy** — A framework for programming rather than prompting LLMs: you declare input and output signatures and let optimisers tune prompts and examples against a metric. → [Ch 27 · Agent Frameworks Tour](topic.html?p=27-agent-frameworks-tour)

**Durable execution** — Running workflows so that their progress survives crashes and restarts, resuming exactly where they stopped. Temporal is the canonical implementation. → [Ch 37 · Workflow Orchestrators](topic.html?p=37-workflow-orchestrators)

---

## E

**Effort** — Claude's `output_config={"effort": ...}` setting (low to max) that trades answer depth for latency and cost on current models, replacing sampling parameters. → [Ch 06 · Model APIs](topic.html?p=06-model-apis)

**ElevenLabs** — A commercial text-to-speech and voice platform with realistic voices, streaming synthesis and voice-agent tooling. → [Ch 33 · Voice Agents](topic.html?p=33-voice-agents)

**Embedding** — A fixed-length vector of numbers that represents the meaning of a text, so similar meanings land near each other in vector space. → [Ch 05 · Embeddings](topic.html?p=05-embeddings)

**Embedding model** — A model that turns text into embeddings, such as `nomic-embed-text` locally or `text-embedding-3-small` from OpenAI. Queries and documents must use the same one. → [Ch 05 · Embeddings](topic.html?p=05-embeddings)

**Evaluation (eval)** — A repeatable test of LLM output quality against a dataset and metrics. The LLM equivalent of a unit-test suite, and the gate for every prompt or model change. → [Ch 41 · Evaluation](topic.html?p=41-evaluation)

**Execute Command node** — An n8n node that runs a shell command on the n8n host, such as a Python script. Convenient, but it couples n8n to the host and is disabled by default in recent versions. → [Ch 12 · n8n with Python](topic.html?p=12-n8n-with-python)

**Expressions (n8n)** — The `{{ }}` syntax in n8n node fields that reads data from previous nodes, such as `{{ $json.email }}`. → [Ch 09 · n8n Fundamentals](topic.html?p=09-n8n-fundamentals)

---

## F

**FAISS** — Meta's in-memory library for fast vector similarity search. A building block rather than a database: no server, persistence or metadata filtering out of the box. → [Ch 18 · Vector Databases](topic.html?p=18-vector-databases)

**Fallback** — A backup model or provider tried automatically when the primary one fails, is rate-limited or rejects a too-long prompt. → [Ch 07 · Multi-Provider Routing](topic.html?p=07-multi-provider-routing)

**FastAPI** — A Python web framework built on type hints and Pydantic. The usual way to expose an AI automation as an HTTP service that n8n or other systems can call. → [Ch 12 · n8n with Python](topic.html?p=12-n8n-with-python)

**FastMCP** — The high-level Python API for building MCP servers with decorators (`@mcp.tool`, `@mcp.resource`, `@mcp.prompt`). Ships inside the official `mcp` SDK and as a standalone package. → [Ch 28 · MCP & FastMCP](topic.html?p=28-mcp-fastmcp)

**Few-shot prompting** — Including a handful of worked input and output examples in the prompt so the model copies the format and decision style. → [Ch 02 · Prompt Engineering](topic.html?p=02-prompt-engineering)

**Flow (CrewAI)** — CrewAI's event-driven workflow layer, where you chain steps and crews with decorators and explicit state for more control than a free-running crew. → [Ch 25 · CrewAI](topic.html?p=25-crewai)

**Flowise** — An open-source drag-and-drop builder for LangChain-style chatflows and agent flows, exposed through a REST API. → [Ch 11 · Flowise, Langflow & Dify](topic.html?p=11-flowise-langflow-dify)

**Function calling** — The API feature where the model returns a structured request to call one of your functions with JSON arguments, instead of plain text. Also called tool use. → [Ch 04 · Function Calling](topic.html?p=04-function-calling)

---

## G

**Gateway (LLM gateway)** — A proxy between your apps and model providers that centralises keys, routing, fallbacks, budgets and logging. The LiteLLM proxy is one. → [Ch 07 · Multi-Provider Routing](topic.html?p=07-multi-provider-routing)

**Gemini** — Google's model family, accessed with the `google-genai` SDK through either the Gemini Developer API or Vertex AI. → [Ch 06 · Model APIs](topic.html?p=06-model-apis)

**GGUF** — The file format used by llama.cpp and Ollama for quantised local models. One file holds the weights and metadata. → [Ch 08 · Local Models](topic.html?p=08-local-models)

**GitHub Actions** — GitHub's CI/CD service. In this handbook it runs tests, builds images and runs eval suites that block a merge when quality drops. → [Ch 39 · Deployment & CI/CD](topic.html?p=39-deploy-docker-cicd)

**Golden dataset** — A curated set of inputs with expected outputs or grading criteria, used to measure every change to prompts, models or retrieval. → [Ch 41 · Evaluation](topic.html?p=41-evaluation)

**Gradio** — A Python library for quick ML and LLM demos with prebuilt components, popular on Hugging Face Spaces. → [Ch 38 · UIs for AI Apps](topic.html?p=38-ai-uis)

**Graph API (Microsoft)** — Microsoft's single REST API for Outlook mail, calendars, Teams and OneDrive data in Microsoft 365. → [Ch 30 · Gmail & Microsoft 365](topic.html?p=30-google-workspace-m365)

**Groq** — An inference provider running open-weight models on custom LPU hardware with very low latency, behind a Chat-Completions-shaped API. → [Ch 06 · Model APIs](topic.html?p=06-model-apis)

**Grounding** — Constraining a model's answer to supplied sources, such as retrieved chunks, so claims can be traced and hallucination drops. → [Ch 16 · RAG Fundamentals](topic.html?p=16-rag-fundamentals)

**Guardrails** — Checks that run before or after a model call to block unsafe inputs or invalid outputs, such as PII filters, topic limits or schema validation. → [Ch 26 · Vendor Agent SDKs](topic.html?p=26-vendor-agent-sdks)

---

## H

**Hallucination** — A fluent, confident output that is not supported by the input or by facts. A natural result of next-token prediction, reduced (never eliminated) by grounding and validation. → [Ch 01 · How LLMs Work](topic.html?p=01-how-llms-work)

**Handoff** — Transferring control of a conversation from one agent to another specialised agent, a first-class concept in the OpenAI Agents SDK. → [Ch 26 · Vendor Agent SDKs](topic.html?p=26-vendor-agent-sdks)

**Haystack** — deepset's open-source framework for building RAG and agent pipelines from typed, composable components. → [Ch 19 · LlamaIndex & Haystack](topic.html?p=19-llamaindex-haystack)

**HNSW** — Hierarchical Navigable Small World, a graph-based ANN index used by most vector databases. Fast and accurate, at the cost of memory. → [Ch 18 · Vector Databases](topic.html?p=18-vector-databases)

**Hugging Face Hub** — The largest public hub of open models and datasets, plus libraries such as `transformers` and hosted Inference Providers. → [Ch 08 · Local Models](topic.html?p=08-local-models)

**Human-in-the-loop (HITL)** — Pausing an automation so a person approves, edits or rejects an action before it takes effect. Essential for refunds, emails to customers and anything irreversible. → [Ch 24 · LangGraph in Production](topic.html?p=24-langgraph-production)

**Hybrid search** — Combining keyword (BM25) and vector retrieval and fusing the result lists, so you get both exact matches and paraphrase matches. → [Ch 17 · Reranking & Hybrid Search](topic.html?p=17-reranking-hybrid-search)

**HyDE** — Hypothetical Document Embeddings: the model writes an imagined answer, and you embed that instead of the short query to retrieve better matches. → [Ch 17 · Reranking & Hybrid Search](topic.html?p=17-reranking-hybrid-search)

---

## I

**Idempotency** — Designing an operation so running it twice has the same effect as once, usually via an idempotency key. Critical whenever retries or duplicate webhooks are possible. → [Ch 36 · Scheduling & Task Queues](topic.html?p=36-scheduling-task-queues)

**Indirect prompt injection** — Malicious instructions hidden in content the model reads (an email, web page, PDF or tool result) rather than typed by the user. → [Ch 43 · Prompt Injection & Sandboxing](topic.html?p=43-prompt-injection-sandboxing)

**Inference Providers (Hugging Face)** — Hugging Face's routed access to open models hosted by partner providers, through one token and an OpenAI-compatible endpoint. → [Ch 08 · Local Models](topic.html?p=08-local-models)

**Instructor** — A library that patches LLM clients to return validated Pydantic objects, with automatic re-asking on validation errors. → [Ch 03 · Structured Outputs](topic.html?p=03-structured-outputs)

**Interrupt** — LangGraph's `interrupt()` call, which pauses a graph mid-node, saves state through the checkpointer, and resumes when you send `Command(resume=...)`. → [Ch 24 · LangGraph in Production](topic.html?p=24-langgraph-production)

**Items (n8n)** — The array of JSON objects that flows between n8n nodes. Most nodes run once per item. → [Ch 09 · n8n Fundamentals](topic.html?p=09-n8n-fundamentals)

**IVF (inverted file index)** — An ANN index that clusters vectors and searches only the nearest clusters. Lower memory than HNSW, usually tuned with `nprobe`. → [Ch 18 · Vector Databases](topic.html?p=18-vector-databases)

---

## J

**JSON mode** — A provider setting that guarantees syntactically valid JSON but not that it matches your schema. Superseded by structured outputs where available. → [Ch 03 · Structured Outputs](topic.html?p=03-structured-outputs)

**JSON Schema** — The standard vocabulary for describing JSON structure. Tool definitions and structured outputs are both expressed in it, usually generated from Pydantic. → [Ch 03 · Structured Outputs](topic.html?p=03-structured-outputs)

---

## K

**keep_alive** — The Ollama option that controls how long a model stays loaded in memory after a request. Set it high to avoid cold-start latency. → [Ch 08 · Local Models](topic.html?p=08-local-models)

**Knowledge base (KB)** — The curated set of documents an assistant may answer from, chunked and indexed for retrieval. → [Ch 16 · RAG Fundamentals](topic.html?p=16-rag-fundamentals)

---

## L

**LangChain** — A Python framework of interchangeable components (chat models, prompts, parsers, retrievers, tools) composed with LCEL, plus a large integrations ecosystem. → [Ch 13 · LangChain Core](topic.html?p=13-langchain-core-lcel)

**Langflow** — An open-source visual builder for LangChain-style flows that can export flows and serve them as APIs. → [Ch 11 · Flowise, Langflow & Dify](topic.html?p=11-flowise-langflow-dify)

**Langfuse** — An open-source LLM observability platform (self-hostable) for traces, prompt management, cost tracking, user feedback and datasets. → [Ch 40 · Observability](topic.html?p=40-observability-langsmith-langfuse)

**LangGraph** — LangChain's low-level library for building agents as stateful graphs of nodes and edges, with cycles, persistence and human-in-the-loop support. → [Ch 23 · LangGraph Fundamentals](topic.html?p=23-langgraph-fundamentals)

**LangSmith** — LangChain's hosted platform for tracing, evaluation and prompt management. Works with or without LangChain code. → [Ch 40 · Observability](topic.html?p=40-observability-langsmith-langfuse)

**Latency** — Time from request to response. For LLMs, split it into time to first token and generation speed (tokens per second). → [Ch 01 · How LLMs Work](topic.html?p=01-how-llms-work)

**LCEL (LangChain Expression Language)** — The pipe syntax (`prompt | model | parser`) that composes runnables into a chain with streaming, batching and async for free. → [Ch 13 · LangChain Core](topic.html?p=13-langchain-core-lcel)

**Least privilege** — Giving each agent, tool and key only the permissions it strictly needs, so a compromised or confused model can do limited damage. → [Ch 43 · Prompt Injection & Sandboxing](topic.html?p=43-prompt-injection-sandboxing)

**Lethal trifecta** — The dangerous combination of an agent that has access to private data, reads untrusted content and can communicate externally. Remove one leg to break exfiltration paths. → [Ch 43 · Prompt Injection & Sandboxing](topic.html?p=43-prompt-injection-sandboxing)

**LiteLLM** — A Python SDK and proxy that calls 100+ providers through one OpenAI-shaped interface, with routing, fallbacks, cost tracking and budgets. → [Ch 07 · Multi-Provider Routing](topic.html?p=07-multi-provider-routing)

**LlamaIndex** — A data framework focused on RAG: loaders, indexes, query engines and event-driven workflows over your documents. → [Ch 19 · LlamaIndex & Haystack](topic.html?p=19-llamaindex-haystack)

**LLM-as-judge** — Using a model, with a rubric, to grade another model's output. Scales evaluation, but must itself be validated against human labels. → [Ch 41 · Evaluation](topic.html?p=41-evaluation)

**Load balancing** — Spreading requests over several deployments of the same model (keys, regions, providers) to raise throughput and survive outages. → [Ch 07 · Multi-Provider Routing](topic.html?p=07-multi-provider-routing)

**Long-term memory** — Facts about a user or task stored outside the context window, such as in a database or vector store, and recalled in later sessions. → [Ch 22 · Agent Memory](topic.html?p=22-agent-memory-mem0)

---

## M

**Make** — A SaaS visual automation platform (formerly Integromat) built on scenarios of modules, billed per operation. → [Ch 10 · Make, Zapier & Power Automate](topic.html?p=10-make-zapier-power-automate)

**MCP (Model Context Protocol)** — An open protocol that standardises how AI applications connect to tools, data and prompts. Write a server once and any MCP host can use it. → [Ch 28 · MCP & FastMCP](topic.html?p=28-mcp-fastmcp)

**MCP client** — The connector inside a host application that maintains a one-to-one session with an MCP server. → [Ch 28 · MCP & FastMCP](topic.html?p=28-mcp-fastmcp)

**MCP host** — The AI application (Claude Desktop, an IDE, your agent) that runs MCP clients and decides when to use the tools they expose. → [Ch 28 · MCP & FastMCP](topic.html?p=28-mcp-fastmcp)

**MCP server** — A program that exposes tools, resources and prompts over MCP, via stdio or Streamable HTTP. → [Ch 28 · MCP & FastMCP](topic.html?p=28-mcp-fastmcp)

**Mem0** — An open-source and hosted memory layer that extracts, stores and retrieves user-level facts for agents across sessions. → [Ch 22 · Agent Memory](topic.html?p=22-agent-memory-mem0)

**Metadata filtering** — Restricting a vector search with structured conditions, such as tenant, date or document type, before or during similarity ranking. → [Ch 18 · Vector Databases](topic.html?p=18-vector-databases)

**Middleware (LangChain agents)** — Hooks around the agent loop in LangChain's `create_agent` for things like summarisation, human approval, PII handling and call limits. → [Ch 14 · LangChain Tools & Agents](topic.html?p=14-langchain-tools-agents)

**Modelfile** — An Ollama file that builds a named model from a base model plus a system prompt and default parameters. → [Ch 08 · Local Models](topic.html?p=08-local-models)

**Multi-agent system** — Several specialised agents cooperating, via a supervisor, handoffs or a shared conversation. Adds capability and cost; justify it with evals. → [Ch 25 · CrewAI](topic.html?p=25-crewai)

**Multi-query retrieval** — Having the model rewrite a question into several variants, retrieving for each and merging the results to improve recall. → [Ch 17 · Reranking & Hybrid Search](topic.html?p=17-reranking-hybrid-search)

**Multimodal model** — A model that accepts more than text, such as images, PDFs or audio, alongside instructions. → [Ch 34 · OCR & Vision](topic.html?p=34-ocr-vision)

---

## N

**n8n** — A fair-code, self-hostable workflow automation tool with 400+ integrations, AI nodes and code steps. The handbook's default low-code platform. → [Ch 09 · n8n Fundamentals](topic.html?p=09-n8n-fundamentals)

**Node (LangGraph)** — A Python function that receives the current graph state and returns a partial update. Nodes do the work; edges decide what runs next. → [Ch 23 · LangGraph Fundamentals](topic.html?p=23-langgraph-fundamentals)

**Normalisation (vectors)** — Scaling a vector to unit length so the dot product equals cosine similarity. Many embedding pipelines do it by default. → [Ch 05 · Embeddings](topic.html?p=05-embeddings)

**num_ctx** — The Ollama option that sets a model's context length. The default is small, so set it explicitly for long prompts. → [Ch 08 · Local Models](topic.html?p=08-local-models)

---

## O

**OAuth 2.0** — The delegated-authorisation standard used by Google, Microsoft and Slack APIs. Your automation gets scoped tokens instead of passwords. → [Ch 30 · Gmail & Microsoft 365](topic.html?p=30-google-workspace-m365)

**Observability** — Being able to see what an LLM app did and why: traces of prompts, tool calls, latency, tokens, cost and feedback. → [Ch 40 · Observability](topic.html?p=40-observability-langsmith-langfuse)

**OCR (optical character recognition)** — Converting images of text into machine-readable text. Tesseract and cloud OCR do it directly; vision LLMs read and interpret at once. → [Ch 34 · OCR & Vision](topic.html?p=34-ocr-vision)

**Ollama** — A local model runner with a simple CLI, a native REST API on port 11434 and an OpenAI-compatible `/v1` endpoint. The handbook's free default. → [Ch 08 · Local Models](topic.html?p=08-local-models)

**OpenAI Agents SDK** — OpenAI's lightweight Python framework for agents with tools, handoffs, guardrails, sessions and built-in tracing. → [Ch 26 · Vendor Agent SDKs](topic.html?p=26-vendor-agent-sdks)

**OpenAI-compatible API** — Any server that accepts the Chat Completions request shape, such as Ollama, Groq, vLLM, OpenRouter or the LiteLLM proxy. One client reaches them all. → [Ch 06 · Model APIs](topic.html?p=06-model-apis)

**OpenRouter** — A hosted gateway that exposes hundreds of models from many vendors through one OpenAI-compatible endpoint, one key and one bill. → [Ch 07 · Multi-Provider Routing](topic.html?p=07-multi-provider-routing)

**OpenTelemetry (OTel)** — The vendor-neutral standard for traces, metrics and logs. Langfuse and many LLM tools accept OTel spans. → [Ch 40 · Observability](topic.html?p=40-observability-langsmith-langfuse)

**Output parser** — A LangChain component that turns raw model text into a typed result, such as a string, JSON or a Pydantic object. → [Ch 13 · LangChain Core](topic.html?p=13-langchain-core-lcel)

**OWASP Top 10 for LLM Applications** — OWASP's ranked list of LLM risks, with prompt injection at the top, plus insecure output handling, excessive agency and data leakage. → [Ch 43 · Prompt Injection & Sandboxing](topic.html?p=43-prompt-injection-sandboxing)

---

## P

**Parallel tool calls** — A single model turn that requests several tool calls at once. Execute them (concurrently if safe) and return all results together. → [Ch 04 · Function Calling](topic.html?p=04-function-calling)

**pgvector** — A PostgreSQL extension that adds a vector column type and ANN indexes, so embeddings live next to your relational data. → [Ch 18 · Vector Databases](topic.html?p=18-vector-databases)

**PII (personally identifiable information)** — Data that identifies a person, such as names, emails, phone numbers or IDs. Detect, minimise and redact it before it reaches prompts, logs or traces. → [Ch 44 · Secrets & PII](topic.html?p=44-secrets-pii)

**Pinecone** — A fully managed, serverless vector database. No ops, usage-based pricing. → [Ch 18 · Vector Databases](topic.html?p=18-vector-databases)

**Plan-and-execute** — An agent pattern where the model first writes a plan of steps, then executes them one by one, re-planning if needed. → [Ch 21 · Agent Patterns](topic.html?p=21-agent-patterns)

**Playwright** — Microsoft's browser automation library for deterministic scripts with auto-waiting selectors. The foundation under most browser agents. → [Ch 32 · Browser Agents](topic.html?p=32-browser-agents)

**Power Automate** — Microsoft's automation platform for Microsoft 365 and Dynamics, with cloud flows, desktop RPA and AI Builder. → [Ch 10 · Make, Zapier & Power Automate](topic.html?p=10-make-zapier-power-automate)

**Prefect** — A Python-native workflow orchestrator: decorate functions as `@flow` and `@task` to get retries, caching, scheduling and a UI. → [Ch 37 · Workflow Orchestrators](topic.html?p=37-workflow-orchestrators)

**Presidio** — Microsoft's open-source PII detection (analyzer) and anonymisation (anonymizer) toolkit, extensible with custom recognisers. → [Ch 44 · Secrets & PII](topic.html?p=44-secrets-pii)

**Process (CrewAI)** — How a crew runs its tasks: `sequential` in order, or `hierarchical` with a manager agent delegating. → [Ch 25 · CrewAI](topic.html?p=25-crewai)

**Prompt caching** — Reusing the processed prefix of a long, repeated prompt (system prompt, documents, tools) across requests for lower cost and latency. → [Ch 42 · Reliability & Cost](topic.html?p=42-reliability-cost)

**Prompt injection** — Input crafted to override an LLM's instructions, either typed directly by a user or hidden in content the model reads. The top LLM security risk. → [Ch 43 · Prompt Injection & Sandboxing](topic.html?p=43-prompt-injection-sandboxing)

**Prompt template** — A prompt with named placeholders filled at runtime, kept in code or files and versioned like any other source. → [Ch 02 · Prompt Engineering](topic.html?p=02-prompt-engineering)

**Prompt versioning** — Storing prompts as named, versioned artifacts and tying every output and eval result to the version that produced it. → [Ch 02 · Prompt Engineering](topic.html?p=02-prompt-engineering)

**promptfoo** — A CLI and library for testing prompts and models against YAML-defined test cases and assertions, including red-team scans. Easy to run in CI. → [Ch 41 · Evaluation](topic.html?p=41-evaluation)

**pyautogui** — A Python library that moves the mouse, types and takes screenshots for desktop automation when no API exists. → [Ch 35 · RPA](topic.html?p=35-rpa)

**Pydantic** — Python's data-validation library. Models generate JSON Schema for tools and structured outputs and validate what comes back. → [Ch 03 · Structured Outputs](topic.html?p=03-structured-outputs)

**PydanticAI** — A type-safe agent framework from the Pydantic team, with typed dependencies, structured results and model-agnostic providers. → [Ch 27 · Agent Frameworks Tour](topic.html?p=27-agent-frameworks-tour)

**PyMuPDF** — A fast PDF library (imported as `pymupdf`) for text, images and layout extraction. A strong default first parser. → [Ch 20 · Document Parsing](topic.html?p=20-document-parsing)

---

## Q

**Qdrant** — An open-source, Rust-based vector database with rich payload filtering, available self-hosted or as a cloud service. → [Ch 18 · Vector Databases](topic.html?p=18-vector-databases)

**Quantisation** — Storing model weights at lower precision (8-, 5- or 4-bit) to cut memory and speed up inference, with a small quality cost. → [Ch 08 · Local Models](topic.html?p=08-local-models)

**Query rewriting** — Using a model to turn a conversational or vague question into a standalone, retrieval-friendly query before searching. → [Ch 17 · Reranking & Hybrid Search](topic.html?p=17-reranking-hybrid-search)

---

## R

**RAG (retrieval-augmented generation)** — Retrieving relevant chunks from your documents and placing them in the prompt so the model answers from them, with citations. → [Ch 16 · RAG Fundamentals](topic.html?p=16-rag-fundamentals)

**RAGAS** — An evaluation library with RAG-specific metrics such as faithfulness, answer relevancy, context precision and context recall. → [Ch 41 · Evaluation](topic.html?p=41-evaluation)

**Rate limit** — A provider cap on requests or tokens per minute. Exceeding it returns HTTP 429; handle it with backoff, queues and concurrency limits. → [Ch 42 · Reliability & Cost](topic.html?p=42-reliability-cost)

**ReAct** — Reason plus Act: the agent alternates between reasoning about what to do and calling a tool, observing the result each time. → [Ch 21 · Agent Patterns](topic.html?p=21-agent-patterns)

**Reciprocal rank fusion (RRF)** — A simple way to merge ranked lists: each document scores the sum of 1/(k + rank) across lists. Robust because it ignores raw score scales. → [Ch 17 · Reranking & Hybrid Search](topic.html?p=17-reranking-hybrid-search)

**Red-teaming** — Deliberately attacking your own LLM app with jailbreaks, injections and abuse cases to find weaknesses before users do. → [Ch 41 · Evaluation](topic.html?p=41-evaluation)

**Redaction** — Replacing sensitive values with placeholders or masks, such as `<EMAIL_ADDRESS>`, before text is stored, logged or sent to a model. → [Ch 44 · Secrets & PII](topic.html?p=44-secrets-pii)

**Reducer** — A LangGraph function attached to a state key that defines how updates merge, such as `add_messages` appending to the message list instead of overwriting it. → [Ch 23 · LangGraph Fundamentals](topic.html?p=23-langgraph-fundamentals)

**Reflection** — An agent pattern where the model critiques its own draft against criteria and revises it. Costs extra calls; use it where quality matters. → [Ch 21 · Agent Patterns](topic.html?p=21-agent-patterns)

**Reranking** — Re-scoring the top retrieved candidates with a stronger model (cross-encoder or LLM) and keeping the best few for the prompt. → [Ch 17 · Reranking & Hybrid Search](topic.html?p=17-reranking-hybrid-search)

**Resources (MCP)** — Read-only data an MCP server exposes by URI, such as files or records, which the host can load into context. → [Ch 28 · MCP & FastMCP](topic.html?p=28-mcp-fastmcp)

**Responses API** — OpenAI's primary API surface (`client.responses.create`) with built-in tools, reasoning items and conversation state. → [Ch 06 · Model APIs](topic.html?p=06-model-apis)

**Retell** — A platform for building real-time phone voice agents on top of your own LLM logic. → [Ch 33 · Voice Agents](topic.html?p=33-voice-agents)

**Retry** — Re-sending a failed request. Safe only for transient errors and idempotent operations, and always with backoff and a maximum. → [Ch 42 · Reliability & Cost](topic.html?p=42-reliability-cost)

**Router (LiteLLM)** — LiteLLM's `Router` class, which load-balances across deployments of an alias and applies fallbacks, cooldowns and retries. → [Ch 07 · Multi-Provider Routing](topic.html?p=07-multi-provider-routing)

**RPA (robotic process automation)** — Software robots that operate applications through their UI the way a person would. The tool of last resort for systems without APIs. → [Ch 35 · RPA](topic.html?p=35-rpa)

**Runnable** — LangChain's universal interface: any component with `invoke`, `batch`, `stream` and async variants that can be piped into others. → [Ch 13 · LangChain Core](topic.html?p=13-langchain-core-lcel)

---

## S

**Sampling** — How a model picks the next token from its probability distribution, shaped by temperature, top-p and top-k. → [Ch 01 · How LLMs Work](topic.html?p=01-how-llms-work)

**Sandbox** — An isolated environment (container, microVM, restricted interpreter) where model-written code runs without access to your secrets, network or host. → [Ch 43 · Prompt Injection & Sandboxing](topic.html?p=43-prompt-injection-sandboxing)

**Secret manager** — A service (AWS Secrets Manager, GCP Secret Manager, Vault, Doppler) that stores, audits and rotates credentials outside your code and images. → [Ch 44 · Secrets & PII](topic.html?p=44-secrets-pii)

**Selector** — A CSS, text or role-based locator that identifies an element on a web page for a browser automation to act on. → [Ch 32 · Browser Agents](topic.html?p=32-browser-agents)

**Semantic search** — Finding text by meaning rather than keywords, by comparing embeddings of the query and the documents. → [Ch 05 · Embeddings](topic.html?p=05-embeddings)

**Semantic splitter** — A text splitter that places chunk boundaries where embedding similarity between neighbouring sentences drops, so chunks follow topics. → [Ch 15 · Loaders & Splitters](topic.html?p=15-document-loaders-splitters)

**sentence-transformers** — A Python library for running local embedding and cross-encoder models from Hugging Face. → [Ch 05 · Embeddings](topic.html?p=05-embeddings)

**Service account** — A non-human Google Cloud identity used for server-to-server API access, optionally with domain-wide delegation in Workspace. → [Ch 30 · Gmail & Microsoft 365](topic.html?p=30-google-workspace-m365)

**Short-term memory** — The recent conversation kept in the context window for the current session, often trimmed or summarised to fit. → [Ch 22 · Agent Memory](topic.html?p=22-agent-memory-mem0)

**smolagents** — Hugging Face's minimal agent library whose agents write and run Python code as their actions. → [Ch 27 · Agent Frameworks Tour](topic.html?p=27-agent-frameworks-tour)

**Span** — One timed unit of work inside a trace, such as a model call, retrieval or tool execution, with inputs, outputs and metadata. → [Ch 40 · Observability](topic.html?p=40-observability-langsmith-langfuse)

**Speech-to-text (STT)** — Transcribing audio into text, with models such as Whisper. The first stage of any voice agent. → [Ch 33 · Voice Agents](topic.html?p=33-voice-agents)

**StateGraph** — The LangGraph builder class: declare a typed state, add nodes and edges, then `compile()` it into a runnable graph. → [Ch 23 · LangGraph Fundamentals](topic.html?p=23-langgraph-fundamentals)

**stdio transport** — Running an MCP server as a subprocess that talks over standard input and output. The default for local desktop hosts. → [Ch 28 · MCP & FastMCP](topic.html?p=28-mcp-fastmcp)

**Streamable HTTP** — The MCP transport for remote servers: a single HTTP endpoint with optional server-sent-event streaming. → [Ch 28 · MCP & FastMCP](topic.html?p=28-mcp-fastmcp)

**Streaming** — Receiving model output token by token as it is generated, for responsive UIs and earlier processing. → [Ch 06 · Model APIs](topic.html?p=06-model-apis)

**Streamlit** — A Python framework that turns scripts into web apps, with chat elements (`st.chat_input`, `st.chat_message`) for AI UIs. → [Ch 38 · UIs for AI Apps](topic.html?p=38-ai-uis)

**Strict tools** — Tool definitions marked `strict` with `additionalProperties: false` so the model's arguments are guaranteed to match the schema. → [Ch 04 · Function Calling](topic.html?p=04-function-calling)

**Structured outputs** — Schema-constrained generation: the provider guarantees the response matches your JSON Schema, usually supplied as a Pydantic model. → [Ch 03 · Structured Outputs](topic.html?p=03-structured-outputs)

**Subgraph** — A compiled LangGraph used as a node inside another graph, for modular or multi-agent designs. → [Ch 23 · LangGraph Fundamentals](topic.html?p=23-langgraph-fundamentals)

**Summarisation memory** — Compressing older conversation turns into a running summary so long sessions fit in the context window. → [Ch 22 · Agent Memory](topic.html?p=22-agent-memory-mem0)

**Supervisor pattern** — A multi-agent design in which one coordinating agent routes work to specialist agents and assembles their results. → [Ch 25 · CrewAI](topic.html?p=25-crewai)

**System prompt** — The top-level instructions that define the model's role, rules and output format for a conversation. → [Ch 02 · Prompt Engineering](topic.html?p=02-prompt-engineering)

---

## T

**Task (A2A)** — The stateful unit of work in A2A, with a lifecycle (submitted, working, input-required, completed, failed) and resulting artifacts. → [Ch 29 · A2A Protocol](topic.html?p=29-a2a-protocol)

**Task (CrewAI)** — A unit of work in CrewAI with a description, an expected output and an assigned agent. → [Ch 25 · CrewAI](topic.html?p=25-crewai)

**Task queue** — A broker plus workers that run jobs asynchronously outside the request path, with retries and concurrency control. → [Ch 36 · Scheduling & Task Queues](topic.html?p=36-scheduling-task-queues)

**Temperature** — A sampling setting that sharpens (low) or flattens (high) the next-token distribution. Current Claude models reject it in favour of `effort`. → [Ch 01 · How LLMs Work](topic.html?p=01-how-llms-work)

**Temporal** — A durable-execution platform where workflows are ordinary code whose state survives crashes, with activities for side effects. → [Ch 37 · Workflow Orchestrators](topic.html?p=37-workflow-orchestrators)

**Tesseract** — The long-standing open-source OCR engine. Free and offline, weaker on complex layouts and handwriting than vision LLMs. → [Ch 34 · OCR & Vision](topic.html?p=34-ocr-vision)

**Text splitter** — A component that breaks documents into chunks by characters, tokens, Markdown headers or semantics, with configurable overlap. → [Ch 15 · Loaders & Splitters](topic.html?p=15-document-loaders-splitters)

**Text-to-speech (TTS)** — Synthesising spoken audio from text, the output stage of a voice agent. → [Ch 33 · Voice Agents](topic.html?p=33-voice-agents)

**Thread (LangGraph)** — An id that groups the checkpoints of one conversation or run, passed as `config={"configurable": {"thread_id": ...}}`. → [Ch 24 · LangGraph in Production](topic.html?p=24-langgraph-production)

**tiktoken** — OpenAI's fast tokeniser library, used to count tokens for OpenAI models. Other vendors provide their own counting endpoints. → [Ch 01 · How LLMs Work](topic.html?p=01-how-llms-work)

**Time travel** — Replaying or forking a LangGraph run from an earlier checkpoint, to debug or to try a different path. → [Ch 24 · LangGraph in Production](topic.html?p=24-langgraph-production)

**Token** — The unit a model reads and writes: a word, part of a word or punctuation mark. Limits, prices and speed are all measured in tokens. → [Ch 01 · How LLMs Work](topic.html?p=01-how-llms-work)

**Tool** — A function you expose to a model with a name, description and JSON Schema for its arguments. The model asks; your code executes. → [Ch 04 · Function Calling](topic.html?p=04-function-calling)

**Tool choice** — The setting that tells the model whether it may, must or must not call tools, or must call a specific one. → [Ch 04 · Function Calling](topic.html?p=04-function-calling)

**Tool loop** — Call the model, execute any requested tools, append the results, call again, until a final text answer or a step limit. → [Ch 04 · Function Calling](topic.html?p=04-function-calling)

**ToolNode** — A prebuilt LangGraph node that executes the tool calls in the last AI message and appends the results as tool messages. → [Ch 23 · LangGraph Fundamentals](topic.html?p=23-langgraph-fundamentals)

**Top-k (retrieval)** — The number of nearest chunks returned by a search. Too few misses evidence; too many dilutes the prompt. → [Ch 16 · RAG Fundamentals](topic.html?p=16-rag-fundamentals)

**Top-p (nucleus sampling)** — Sampling only from the smallest set of tokens whose probabilities sum to p. An alternative or complement to temperature. → [Ch 01 · How LLMs Work](topic.html?p=01-how-llms-work)

**Trace** — The full record of one request through an LLM app, made of nested spans, used for debugging, cost and quality analysis. → [Ch 40 · Observability](topic.html?p=40-observability-langsmith-langfuse)

**transformers** — Hugging Face's Python library for loading and running open models in-process with PyTorch. → [Ch 08 · Local Models](topic.html?p=08-local-models)

---

## U

**UiPath** — A leading enterprise RPA platform with a visual studio, orchestrator and AI document understanding. → [Ch 35 · RPA](topic.html?p=35-rpa)

**Unstructured** — An open-source library and API that partitions many file types into typed elements (titles, tables, text) for RAG ingestion. → [Ch 20 · Document Parsing](topic.html?p=20-document-parsing)

---

## V

**Vapi** — A developer platform for real-time voice agents that wires telephony, STT, your LLM and TTS together. → [Ch 33 · Voice Agents](topic.html?p=33-voice-agents)

**Vector database** — A store optimised for saving embeddings and running fast similarity search with metadata filters, such as Chroma, Qdrant or pgvector. → [Ch 18 · Vector Databases](topic.html?p=18-vector-databases)

**Virtual key** — A key issued by a gateway such as the LiteLLM proxy that maps to real provider keys and carries its own budget, rate limit and model list. → [Ch 07 · Multi-Provider Routing](topic.html?p=07-multi-provider-routing)

**Vision LLM** — A multimodal model that reads images and documents and can answer questions or extract fields from them directly. → [Ch 34 · OCR & Vision](topic.html?p=34-ocr-vision)

**VPS (virtual private server)** — A rented Linux virtual machine where you run Docker Compose yourself. Cheap, flexible, and the ops are on you. → [Ch 39 · Deployment & CI/CD](topic.html?p=39-deploy-docker-cicd)

**VRAM** — GPU memory. Model size times precision, plus the KV cache for the context, must fit in it for fast local inference. → [Ch 08 · Local Models](topic.html?p=08-local-models)

---

## W

**Webhook** — An HTTP endpoint that another system calls when an event happens. The trigger behind most real-time automations. → [Ch 09 · n8n Fundamentals](topic.html?p=09-n8n-fundamentals)

**Webhook vs polling** — Push delivery of events to your endpoint versus repeatedly asking an API for changes. Bots use webhooks in production and polling in development. → [Ch 31 · Chat Bots](topic.html?p=31-chat-bots)

**WhatsApp Cloud API** — Meta's hosted API for WhatsApp Business messaging, using webhooks for inbound messages and message templates outside the 24-hour window. → [Ch 31 · Chat Bots](topic.html?p=31-chat-bots)

**Whisper** — OpenAI's open speech-recognition model family, run locally (for example with faster-whisper) or through APIs. → [Ch 33 · Voice Agents](topic.html?p=33-voice-agents)

**Workflow vs agent** — A workflow follows code-defined steps; an agent lets the model choose them. Prefer workflows until the task truly needs open-ended decisions. → [Ch 21 · Agent Patterns](topic.html?p=21-agent-patterns)

---

## X

**XML tags (in prompts)** — Wrapping prompt sections in tags such as `<email>` or `<rules>` to separate instructions from data. Especially effective with Claude. → [Ch 02 · Prompt Engineering](topic.html?p=02-prompt-engineering)

---

## Z

**Zapier** — The largest SaaS automation platform, built on trigger and action zaps across thousands of apps, billed per task. → [Ch 10 · Make, Zapier & Power Automate](topic.html?p=10-make-zapier-power-automate)

**Zero-shot** — Asking a model to perform a task with instructions only and no examples. Try it first; add few-shot examples when the format or judgement drifts. → [Ch 02 · Prompt Engineering](topic.html?p=02-prompt-engineering)

---

## Terms by chapter

| Chapter | Terms defined here |
|---|---|
| [Ch 01 · How LLMs Work](topic.html?p=01-how-llms-work) | BPE, Context window, Cost per token, Hallucination, Latency, Sampling, Temperature, tiktoken, Token, Top-p |
| [Ch 02 · Prompt Engineering](topic.html?p=02-prompt-engineering) | Chain-of-thought, Delimiters, Few-shot prompting, Prompt template, Prompt versioning, System prompt, XML tags, Zero-shot |
| [Ch 03 · Structured Outputs](topic.html?p=03-structured-outputs) | Instructor, JSON mode, JSON Schema, Pydantic, Structured outputs |
| [Ch 04 · Function Calling](topic.html?p=04-function-calling) | Function calling, Parallel tool calls, Strict tools, Tool, Tool choice, Tool loop |
| [Ch 05 · Embeddings](topic.html?p=05-embeddings) | Cosine similarity, Dimensions, Embedding, Embedding model, Normalisation, Semantic search, sentence-transformers |
| [Ch 06 · Model APIs](topic.html?p=06-model-apis) | Adaptive thinking, Effort, Gemini, Groq, OpenAI-compatible API, Responses API, Streaming |
| [Ch 07 · Multi-Provider Routing](topic.html?p=07-multi-provider-routing) | Alias, Budget, Fallback, Gateway, LiteLLM, Load balancing, OpenRouter, Router, Virtual key |
| [Ch 08 · Local Models](topic.html?p=08-local-models) | GGUF, Hugging Face Hub, Inference Providers, keep_alive, Modelfile, num_ctx, Ollama, Quantisation, transformers, VRAM |
| [Ch 09 · n8n Fundamentals](topic.html?p=09-n8n-fundamentals) | AI Agent node, Code node, Credentials, Expressions, Items, n8n, Webhook |
| [Ch 10 · Make, Zapier & Power Automate](topic.html?p=10-make-zapier-power-automate) | Make, Power Automate, Zapier |
| [Ch 11 · Flowise, Langflow & Dify](topic.html?p=11-flowise-langflow-dify) | Dify, Flowise, Langflow |
| [Ch 12 · n8n with Python](topic.html?p=12-n8n-with-python) | Execute Command node, FastAPI |
| [Ch 13 · LangChain Core](topic.html?p=13-langchain-core-lcel) | Batching, Chain, Chat model, LangChain, LCEL, Output parser, Runnable |
| [Ch 14 · LangChain Tools & Agents](topic.html?p=14-langchain-tools-agents) | Middleware |
| [Ch 15 · Loaders & Splitters](topic.html?p=15-document-loaders-splitters) | Chunk overlap, Document loader, Semantic splitter, Text splitter |
| [Ch 16 · RAG Fundamentals](topic.html?p=16-rag-fundamentals) | Chunking, Citations, Grounding, Knowledge base, RAG, Top-k |
| [Ch 17 · Reranking & Hybrid Search](topic.html?p=17-reranking-hybrid-search) | BM25, Cross-encoder, Dense retrieval, Hybrid search, HyDE, Multi-query retrieval, Query rewriting, Reciprocal rank fusion, Reranking |
| [Ch 18 · Vector Databases](topic.html?p=18-vector-databases) | ANN, Chroma, FAISS, HNSW, IVF, Metadata filtering, pgvector, Pinecone, Qdrant, Vector database |
| [Ch 19 · LlamaIndex & Haystack](topic.html?p=19-llamaindex-haystack) | Haystack, LlamaIndex |
| [Ch 20 · Document Parsing](topic.html?p=20-document-parsing) | Docling, PyMuPDF, Unstructured |
| [Ch 21 · Agent Patterns](topic.html?p=21-agent-patterns) | Agent, Agent loop, Plan-and-execute, ReAct, Reflection, Workflow vs agent |
| [Ch 22 · Agent Memory](topic.html?p=22-agent-memory-mem0) | Long-term memory, Mem0, Short-term memory, Summarisation memory |
| [Ch 23 · LangGraph Fundamentals](topic.html?p=23-langgraph-fundamentals) | Conditional edge, LangGraph, Node, Reducer, StateGraph, Subgraph, ToolNode |
| [Ch 24 · LangGraph in Production](topic.html?p=24-langgraph-production) | Checkpointer, Human-in-the-loop, Interrupt, Thread, Time travel |
| [Ch 25 · CrewAI](topic.html?p=25-crewai) | Crew, CrewAI, Flow, Multi-agent system, Process, Supervisor pattern, Task |
| [Ch 26 · Vendor Agent SDKs](topic.html?p=26-vendor-agent-sdks) | Claude Agent SDK, Guardrails, Handoff, OpenAI Agents SDK |
| [Ch 27 · Agent Frameworks Tour](topic.html?p=27-agent-frameworks-tour) | AutoGen / AG2, DSPy, PydanticAI, smolagents |
| [Ch 28 · MCP & FastMCP](topic.html?p=28-mcp-fastmcp) | FastMCP, MCP, MCP client, MCP host, MCP server, Resources, stdio transport, Streamable HTTP |
| [Ch 29 · A2A Protocol](topic.html?p=29-a2a-protocol) | A2A, Agent card, Artifact, Task |
| [Ch 30 · Gmail & Microsoft 365](topic.html?p=30-google-workspace-m365) | Graph API, OAuth 2.0, Service account |
| [Ch 31 · Chat Bots](topic.html?p=31-chat-bots) | Webhook vs polling, WhatsApp Cloud API |
| [Ch 32 · Browser Agents](topic.html?p=32-browser-agents) | browser-use, Computer use, Playwright, Selector |
| [Ch 33 · Voice Agents](topic.html?p=33-voice-agents) | ElevenLabs, Retell, Speech-to-text, Text-to-speech, Vapi, Whisper |
| [Ch 34 · OCR & Vision](topic.html?p=34-ocr-vision) | Multimodal model, OCR, Tesseract, Vision LLM |
| [Ch 35 · RPA](topic.html?p=35-rpa) | pyautogui, RPA, UiPath |
| [Ch 36 · Scheduling & Task Queues](topic.html?p=36-scheduling-task-queues) | APScheduler, Celery, Celery beat, Cron, Idempotency, Task queue |
| [Ch 37 · Workflow Orchestrators](topic.html?p=37-workflow-orchestrators) | Airflow, DAG, Durable execution, Prefect, Temporal |
| [Ch 38 · UIs for AI Apps](topic.html?p=38-ai-uis) | Chainlit, Gradio, Streamlit |
| [Ch 39 · Deployment & CI/CD](topic.html?p=39-deploy-docker-cicd) | Docker Compose, GitHub Actions, VPS |
| [Ch 40 · Observability](topic.html?p=40-observability-langsmith-langfuse) | Langfuse, LangSmith, Observability, OpenTelemetry, Span, Trace |
| [Ch 41 · Evaluation](topic.html?p=41-evaluation) | DeepEval, Evaluation, Golden dataset, LLM-as-judge, promptfoo, RAGAS, Red-teaming |
| [Ch 42 · Reliability & Cost](topic.html?p=42-reliability-cost) | Backoff, Circuit breaker, Prompt caching, Rate limit, Retry |
| [Ch 43 · Prompt Injection & Sandboxing](topic.html?p=43-prompt-injection-sandboxing) | Indirect prompt injection, Least privilege, Lethal trifecta, OWASP Top 10 for LLM Applications, Prompt injection, Sandbox |
| [Ch 44 · Secrets & PII](topic.html?p=44-secrets-pii) | PII, Presidio, Redaction, Secret manager |

**Next:** keep the [Cheat Sheet](topic.html?p=46-cheat-sheet) open while you build, or start the [12-Week Roadmap](topic.html?p=49-roadmap).

---

*AI Automation with Python Handbook — chapter 45.*
