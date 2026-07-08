# 35 · Model Context Protocol (MCP)

> **In one line:** MCP is an open standard — a "USB-C for AI" — that lets any model connect to any tool or data source through a uniform client-server protocol, replacing bespoke integrations with a common interface.

---

## 1. Overview

Every agent needs to reach the outside world — files, databases, APIs, SaaS tools. Before MCP, each of those connections was a custom integration: a bespoke tool schema, a hand-rolled auth flow, glue code welded to one framework and one model. With `M` models and `N` tools, the ecosystem tended toward `M × N` one-off integrations, each maintained separately. **The Model Context Protocol (MCP)** collapses that to `M + N`: a tool is exposed once as an MCP **server**, and any MCP-capable **client** (an agent, an IDE, a chat app) can consume it without knowing anything tool-specific.

MCP is an open standard, introduced by Anthropic in late 2024 and now adopted broadly across the industry. The analogy the designers use is USB-C: before it, every device had its own connector; after it, one port speaks to everything. MCP is that port for AI context — a single protocol for how models discover and use external capabilities.

The problem it solves is integration sprawl and lock-in. Without a standard, connecting Claude to your company's Jira means writing Claude-specific Jira glue; connecting a different model means rewriting it. With MCP, you write one Jira MCP server, and Claude, an IDE assistant, and any future model all use it unchanged. It decouples the *capability* from the *consumer*.

A concrete example: a developer's IDE assistant needs to read the repo, query the issue tracker, and run tests. Each is an MCP server — a filesystem server (over stdio, running locally), a Jira server (over HTTP, remote), a test-runner server. The IDE is an MCP client; it connects to all three, discovers their **tools** (`run_tests`), **resources** (a file's contents), and **prompts** (a templated workflow), and the model uses them through one uniform interface. Swap the model, keep the servers. That decoupling — and the concepts of servers, tools, resources, and transports that make it work — is what this chapter covers.

---

## 2. Core Concepts

- **MCP server** — a program that exposes capabilities (tools, resources, prompts) over the protocol. Written once, consumed by any client.
- **MCP client** — the component inside a host application (agent, IDE, chat app) that connects to servers and relays their capabilities to the model.
- **Host** — the application the user interacts with (e.g. Claude Desktop, an IDE); it embeds one or more clients.
- **Tool** — a model-invokable function exposed by a server (like `run_query`); MCP tools map onto the same tool-use mechanism as native tools.
- **Resource** — read-only contextual data a server exposes (a file, a database row, a document), identified by a URI and pulled into context.
- **Prompt** — a reusable, parameterized message template a server offers (e.g. a "summarize this PR" workflow) that the host can surface to the user.
- **Transport** — how client and server communicate: **stdio** (local subprocess, pipes) or **Streamable HTTP** (remote, network).
- **JSON-RPC 2.0** — the message format MCP is built on: typed request/response and notification messages.
- **Capability negotiation** — on connect, client and server announce which features they support, so both sides know what's available.

---

## 3. Theory & Mathematical Intuition

MCP has no math — its "theory" is the economics of integration and the protocol's design principles. The core insight is combinatorial. With bespoke integrations, connecting `M` model hosts to `N` capabilities costs:

```
bespoke:   O(M × N) integrations       # every host writes glue for every tool
MCP:       O(M + N) integrations       # each host and each tool implements the protocol once
```

Each host implements a client once; each capability implements a server once; the `M × N` cross-product of glue disappears. This is the same argument that justifies any standard interface (POSIX, SQL, HTTP): standardize the boundary and the number of connectors collapses from a product to a sum.

The second design principle is the **three primitives**, which separate concerns by *who controls the interaction*:

```
Tools     → model-controlled   (the model decides to invoke; has side effects)
Resources → application-controlled (the host decides what context to load; read-only)
Prompts   → user-controlled     (the user picks a templated workflow)
```

This separation matters because it maps cleanly onto trust and safety: tools *act* (so they need approval gates), resources only *read* (so they're safer to auto-load), and prompts are *user-initiated* (so they carry user intent). Collapsing them all into "tools" would lose that distinction.

The third principle is **stateful sessions over a transport**. MCP is built on JSON-RPC 2.0: the client sends `initialize`, the two sides negotiate capabilities, and then exchange typed `tools/list`, `tools/call`, `resources/read`, etc. messages. The transport (stdio or HTTP) is abstracted away — the *same* protocol logic runs whether the server is a local subprocess piped over stdin/stdout or a remote service over HTTP. That transport-independence is what lets a filesystem server run locally and a SaaS server run remotely, both speaking one protocol.

```svg
<svg viewBox="0 0 720 320" width="100%" height="320" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="720" height="320" fill="#ffffff"/>
  <text x="180" y="26" font-size="15" font-weight="bold" fill="#1e293b" text-anchor="middle">Without MCP: M × N glue</text>
  <rect x="40" y="50" width="80" height="30" rx="4" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="80" y="70" font-size="11" fill="#1e293b" text-anchor="middle">host A</text>
  <rect x="40" y="95" width="80" height="30" rx="4" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="80" y="115" font-size="11" fill="#1e293b" text-anchor="middle">host B</text>
  <rect x="240" y="50" width="80" height="30" rx="4" fill="#fef3c7" stroke="#d97706"/>
  <text x="280" y="70" font-size="11" fill="#1e293b" text-anchor="middle">Jira</text>
  <rect x="240" y="95" width="80" height="30" rx="4" fill="#fef3c7" stroke="#d97706"/>
  <text x="280" y="115" font-size="11" fill="#1e293b" text-anchor="middle">files</text>
  <rect x="240" y="140" width="80" height="30" rx="4" fill="#fef3c7" stroke="#d97706"/>
  <text x="280" y="160" font-size="11" fill="#1e293b" text-anchor="middle">DB</text>
  <line x1="120" y1="65" x2="240" y2="65" stroke="#94a3b8"/>
  <line x1="120" y1="65" x2="240" y2="110" stroke="#94a3b8"/>
  <line x1="120" y1="65" x2="240" y2="155" stroke="#94a3b8"/>
  <line x1="120" y1="110" x2="240" y2="65" stroke="#94a3b8"/>
  <line x1="120" y1="110" x2="240" y2="110" stroke="#94a3b8"/>
  <line x1="120" y1="110" x2="240" y2="155" stroke="#94a3b8"/>
  <text x="180" y="200" font-size="11" fill="#dc2626" text-anchor="middle">6 bespoke integrations</text>
  <text x="540" y="26" font-size="15" font-weight="bold" fill="#1e293b" text-anchor="middle">With MCP: M + N</text>
  <rect x="410" y="50" width="80" height="30" rx="4" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="450" y="70" font-size="11" fill="#1e293b" text-anchor="middle">host A</text>
  <rect x="410" y="95" width="80" height="30" rx="4" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="450" y="115" font-size="11" fill="#1e293b" text-anchor="middle">host B</text>
  <rect x="530" y="72" width="70" height="30" rx="4" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="565" y="92" font-size="11" fill="#1e293b" text-anchor="middle">MCP</text>
  <rect x="620" y="50" width="70" height="30" rx="4" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="655" y="70" font-size="11" fill="#1e293b" text-anchor="middle">Jira</text>
  <rect x="620" y="95" width="70" height="30" rx="4" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="655" y="115" font-size="11" fill="#1e293b" text-anchor="middle">files</text>
  <rect x="620" y="140" width="70" height="30" rx="4" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="655" y="160" font-size="11" fill="#1e293b" text-anchor="middle">DB</text>
  <line x1="490" y1="65" x2="530" y2="85" stroke="#4f46e5"/>
  <line x1="490" y1="110" x2="530" y2="90" stroke="#4f46e5"/>
  <line x1="600" y1="82" x2="620" y2="65" stroke="#16a34a"/>
  <line x1="600" y1="87" x2="620" y2="110" stroke="#16a34a"/>
  <line x1="600" y1="92" x2="620" y2="155" stroke="#16a34a"/>
  <text x="540" y="200" font-size="11" fill="#16a34a" text-anchor="middle">5 protocol implementations</text>
  <text x="360" y="250" font-size="12" fill="#1e293b" text-anchor="middle">One server per tool, one client per host — the cross-product of glue disappears.</text>
  <text x="360" y="280" font-size="11" fill="#64748b" text-anchor="middle">Primitives: tools (model-controlled), resources (app-controlled), prompts (user-controlled).</text>
</svg>
```

---

## 4. Architecture & Workflow

1. **Host embeds a client.** The user-facing app (IDE, chat, agent) instantiates an MCP client for each server it will connect to.
2. **Choose a transport.** Local capabilities run as a subprocess over **stdio**; remote capabilities run as a service over **Streamable HTTP**.
3. **Initialize.** The client sends an `initialize` request; client and server exchange versions and negotiate capabilities (which of tools/resources/prompts each supports).
4. **Discover.** The client calls `tools/list`, `resources/list`, and `prompts/list` to learn what the server offers, including each tool's JSON schema.
5. **Expose to the model.** The host presents the discovered tools to the model as native tool definitions and surfaces resources/prompts to the application/user.
6. **Model acts.** The model emits a tool call; the client translates it into a `tools/call` JSON-RPC request to the server.
7. **Server executes.** The server runs the underlying operation (query the DB, hit the API) and returns a typed result.
8. **Relay back.** The client feeds the result into the model's context as a tool result; the loop continues.
9. **Load resources / run prompts as needed.** The host reads resources (`resources/read`) to inject context, and offers server prompts as user-selectable workflows.

```svg
<svg viewBox="0 0 720 320" width="100%" height="320" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="720" height="320" fill="#ffffff"/>
  <text x="360" y="26" font-size="16" font-weight="bold" fill="#1e293b" text-anchor="middle">MCP host, client, server topology</text>
  <rect x="30" y="60" width="220" height="200" rx="8" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="140" y="82" font-size="13" font-weight="bold" fill="#1e293b" text-anchor="middle">host application</text>
  <rect x="55" y="100" width="170" height="40" rx="6" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="140" y="125" font-size="12" fill="#1e293b" text-anchor="middle">model (claude-opus-4)</text>
  <rect x="55" y="155" width="80" height="36" rx="6" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="95" y="177" font-size="11" fill="#1e293b" text-anchor="middle">client 1</text>
  <rect x="145" y="155" width="80" height="36" rx="6" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="185" y="177" font-size="11" fill="#1e293b" text-anchor="middle">client 2</text>
  <rect x="440" y="70" width="240" height="70" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="560" y="92" font-size="12" font-weight="bold" fill="#1e293b" text-anchor="middle">filesystem server (stdio)</text>
  <text x="560" y="112" font-size="11" fill="#1e293b" text-anchor="middle">tools: read, write · resources: files</text>
  <text x="560" y="128" font-size="11" fill="#64748b" text-anchor="middle">local subprocess</text>
  <rect x="440" y="170" width="240" height="70" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="560" y="192" font-size="12" font-weight="bold" fill="#1e293b" text-anchor="middle">Jira server (HTTP)</text>
  <text x="560" y="212" font-size="11" fill="#1e293b" text-anchor="middle">tools: create_issue, search</text>
  <text x="560" y="228" font-size="11" fill="#64748b" text-anchor="middle">remote service</text>
  <line x1="135" y1="173" x2="440" y2="105" stroke="#0ea5e9" stroke-width="2" marker-end="url(#f)"/>
  <text x="290" y="130" font-size="11" fill="#0ea5e9">JSON-RPC / stdio</text>
  <line x1="225" y1="173" x2="440" y2="200" stroke="#d97706" stroke-width="2" marker-end="url(#f)"/>
  <text x="300" y="205" font-size="11" fill="#d97706">JSON-RPC / HTTP</text>
  <defs>
    <marker id="f" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
      <path d="M0,0 L6,3 L0,6 Z" fill="#1e293b"/>
    </marker>
  </defs>
  <text x="360" y="288" font-size="11" fill="#1e293b" text-anchor="middle">initialize to negotiate to tools/list to tools/call — one protocol over either transport.</text>
</svg>
```

---

## 5. Implementation

A minimal MCP server exposing one tool and one resource, using the official Python SDK. This server runs over stdio and can be consumed by any MCP client.

```python
# server.py — an MCP server exposing a tool and a resource
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("inventory")

@mcp.tool()
def check_stock(sku: str) -> str:
    """Return current stock level for a product SKU.

    Call this whenever the user asks about availability or inventory.
    """
    levels = {"A100": 42, "B200": 0}
    n = levels.get(sku)
    return f"{sku}: out of stock" if n == 0 else f"{sku}: {n} units"

@mcp.resource("catalog://skus")
def list_skus() -> str:
    """Read-only list of known SKUs (application-controlled context)."""
    return "A100 - Widget\nB200 - Gadget"

if __name__ == "__main__":
    mcp.run(transport="stdio")     # or transport="streamable-http" for remote
```

Consuming that server from a Claude agent using the SDK's MCP helpers, so the server's tools drive the tool-use loop automatically:

```python
import anthropic
from anthropic.lib.tools.mcp import mcp_tool
from mcp import ClientSession
from mcp.client.stdio import stdio_client, StdioServerParameters

client = anthropic.Anthropic()

def run():
    params = StdioServerParameters(command="python", args=["server.py"])
    with stdio_client(params) as (read, write):
        with ClientSession(read, write) as session:
            session.initialize()                       # negotiate capabilities
            tools = session.list_tools().tools         # discover server tools
            runner = client.beta.messages.tool_runner(
                model="claude-sonnet-4", max_tokens=1024,
                messages=[{"role": "user", "content": "Is SKU B200 in stock?"}],
                tools=[mcp_tool(t, session) for t in tools],   # MCP tools → Claude tools
            )
            for message in runner:                     # loop until done
                pass
            return message
# The model calls check_stock('B200') via MCP; the server answers "out of stock".
```

Connecting Claude directly to a **remote** MCP server via the Messages API's built-in MCP connector (no local client code — Anthropic makes the connection server-side):

```python
resp = client.beta.messages.create(
    model="claude-opus-4", max_tokens=1024,
    betas=["mcp-client-2025-11-20"],
    mcp_servers=[{"type": "url", "url": "https://mcp.example.com/mcp",
                  "name": "inventory"}],
    tools=[{"type": "mcp_toolset", "mcp_server_name": "inventory"}],
    messages=[{"role": "user", "content": "Check stock for A100"}],
)
```

**Optimization note.** Use **stdio** for local, low-latency capabilities (filesystem, local scripts) — no network overhead — and **Streamable HTTP** for shared or remote services. Keep each server focused (one domain per server) so capability discovery stays cheap and the model isn't flooded with tools. For large tool catalogs across many servers, combine MCP with tool search so only relevant schemas load. Cache the discovered tool list; it's stable, so it belongs in the cacheable prompt prefix.

---

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
| --- | --- | --- |
| Standardization | `M+N` instead of `M×N` integrations; no lock-in | A protocol to learn; overkill for a single one-off tool |
| Reusability | Write a server once, any client uses it | Server maintenance falls on someone |
| Three primitives | Clean separation of act/read/user-intent | More concepts than "just tools" |
| Transport choice | stdio (local, fast) or HTTP (remote, shared) | Each transport has its own auth/deployment story |
| Ecosystem | Growing library of prebuilt servers | Third-party server quality and trust vary |
| Model-agnostic | Swap the model, keep the servers | Requires MCP support in the host |
| Dynamic discovery | Tools/resources found at runtime | Adds an initialization round-trip |

---

## 7. Common Mistakes & Best Practices

1. ⚠️ Building one giant server with dozens of unrelated tools → ✅ one focused server per domain; compose multiple servers in the host.
2. ⚠️ Using HTTP for a purely local capability → ✅ use stdio for local subprocesses (faster, simpler, no network exposure).
3. ⚠️ Treating a resource as a tool (or vice versa) → ✅ resources are read-only context; tools have side effects — respect the primitive.
4. ⚠️ Skipping capability negotiation and assuming features exist → ✅ check the negotiated capabilities before calling optional features.
5. ⚠️ Trusting a third-party MCP server blindly → ✅ vet servers; a malicious server can return injection payloads or exfiltrate data.
6. ⚠️ Hard-coding secrets into the server config → ✅ inject credentials via a vault/secret manager, not the connection URL or code.
7. ⚠️ Exposing destructive tools without gates → ✅ gate side-effecting tools behind host-level confirmation.
8. ⚠️ Flooding the model with every tool from every server → ✅ keep servers focused; use tool search for large catalogs.
9. ⚠️ Ignoring the remote-server auth story → ✅ use proper OAuth/token flows for HTTP servers; don't expose them unauthenticated.
10. ⚠️ Re-discovering tools on every request → ✅ cache the tool list; it's stable and belongs in the cached prefix.

---

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** MCP is JSON-RPC 2.0, so debugging is protocol tracing: log the `initialize` handshake, the negotiated capabilities, and every `tools/call` request/response pair. When a tool "doesn't work," check whether discovery even surfaced it, whether the schema matches what the model sent, and whether the server returned an error result. The MCP Inspector tool lets you exercise a server interactively before wiring it to a model.

**Monitoring.** Track per-server connection health, tool-call latency and error rate, capability-negotiation failures, and (for HTTP servers) auth failures. A server that intermittently fails discovery silently removes its tools from the model's options — monitor the discovered tool count per session.

**Security.** MCP widens the trust surface: a server can return content that the model then treats as instructions (prompt injection via tool results), and a malicious server could exfiltrate whatever the client sends it. Treat server output as untrusted data, vet third-party servers, keep credentials out of server code (inject via a vault at connection time), authenticate remote (HTTP) servers, and gate destructive tools behind human confirmation. Run local (stdio) servers with least privilege — a filesystem server should be confined to an allowed root.

**Scaling.** stdio servers are per-session subprocesses; HTTP servers are shared services that scale like any web backend — put them behind a load balancer and rate-limit. For many servers, keep each focused so the model's tool list stays manageable, and cache discovery. Remote servers centralize a capability for a whole fleet of agents, which is the main reason to prefer HTTP over stdio at scale.

---

## 9. Interview Questions

**Q: What problem does MCP solve, in one sentence?**
A: It replaces the `M×N` explosion of bespoke model-to-tool integrations with an `M+N` standard: each tool is exposed once as an MCP server and each host implements a client once, so any model can use any tool through one uniform protocol.

**Q: What are the three MCP primitives and how do they differ?**
A: Tools (model-controlled — the model invokes them; they have side effects), resources (application-controlled — read-only data the host loads into context, identified by URI), and prompts (user-controlled — reusable templated workflows the user selects). The split maps onto who initiates and whether there are side effects, which matters for safety gating.

**Q: What are the two MCP transports and when do you use each?**
A: stdio — the server runs as a local subprocess communicating over stdin/stdout pipes, used for local, low-latency capabilities like a filesystem. Streamable HTTP — the server is a remote networked service, used for shared or SaaS capabilities. Same protocol logic; only the transport differs.

**Q: How does an MCP server differ from just defining a tool in the Messages API?**
A: A native tool is defined inline in one host's request and is coupled to that host and model. An MCP server exposes the capability behind a standard protocol so *any* MCP client can discover and use it, unchanged, across models and apps. MCP tools still surface to the model through the same tool-use mechanism, but the definition lives in a reusable server.

**Q: Walk through what happens when a client connects to a server.**
A: The client sends `initialize`; the two negotiate protocol version and capabilities. The client then calls `tools/list`, `resources/list`, `prompts/list` to discover offerings and their schemas. The host exposes the tools to the model; when the model calls one, the client sends a `tools/call` request, the server executes and returns a result, and the client relays it back into the model's context.

**Q: Why separate resources from tools instead of making everything a tool?**
A: Because they differ in control and side effects. Tools act and are model-invoked, so they need approval gates; resources are read-only context the *application* decides to load, so they're safer to auto-inject. Collapsing them loses that trust distinction — you'd treat safe reads and dangerous writes identically.

**Q: (Senior) What new security risks does adopting MCP introduce?**
A: A wider trust surface. Server output flows into the model's context, so a compromised or malicious server can inject instructions (prompt injection via tool results) or exfiltrate whatever the client sends. Third-party servers you don't control are running with whatever access you grant. Mitigations: vet servers, treat their output as untrusted data, authenticate remote servers, inject credentials via a vault rather than embedding them, confine local servers to least privilege, and gate destructive tools behind confirmation.

**Q: (Senior) When is MCP overkill, and when is it essential?**
A: Overkill for a single, private, one-off tool used by one app and one model — inline tool definitions are simpler. Essential when the same capability must be shared across multiple hosts or models, when you want to avoid rewriting integrations as models change, when you're consuming an ecosystem of prebuilt servers, or when a capability should be centrally maintained for a fleet. The value is decoupling and reuse; if there's nothing to reuse or decouple, skip it.

**Q: (Senior) How does MCP relate to the underlying tool-use loop?**
A: It doesn't replace it — it feeds it. MCP standardizes *discovery and transport* of capabilities; when the model actually invokes an MCP tool, it still goes through the same `tool_use` → execute → `tool_result` loop. The client translates the model's tool call into a `tools/call` JSON-RPC message and translates the result back. MCP is the plumbing that supplies the tools; the tool-use loop is how the model uses them.

**Q: What is capability negotiation and why does it exist?**
A: On `initialize`, client and server each announce which features they support (tools, resources, prompts, and optional sub-features). It exists so neither side assumes a capability the other lacks — a client won't call `prompts/list` on a server that doesn't offer prompts. It makes the protocol extensible without breaking older peers.

**Q: What protocol is MCP built on and why does that matter?**
A: JSON-RPC 2.0 — typed request/response and notification messages. It matters because it gives MCP a well-understood, language-agnostic message format with clear request/response semantics and error handling, and it makes the protocol easy to implement, trace, and debug across any language and transport.

**Q: How would you expose a company database to Claude via MCP without exposing credentials to the model?**
A: Write a database MCP server that holds the credentials internally and exposes only safe, parameterized query tools (`run_query` restricted to read-only, allowlisted). The model calls the tool; the server — not the model — authenticates to the DB. Inject the DB credentials into the server from a vault at deploy time, never into the model's context or the connection URL.

---

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** MCP is an open, JSON-RPC-based standard that turns `M×N` bespoke integrations into `M+N`: a capability is exposed once as a **server**, consumed by any **client** inside a **host**. Three primitives — **tools** (model-controlled, act), **resources** (app-controlled, read), **prompts** (user-controlled, workflows). Two transports — **stdio** (local subprocess) and **Streamable HTTP** (remote). Connect → negotiate capabilities → discover (`tools/list`) → invoke (`tools/call`). MCP tools still run through the normal tool-use loop; it standardizes discovery and transport, not the loop itself.

| Concept | One-liner |
| --- | --- |
| Server | exposes tools/resources/prompts |
| Client | connects host to a server |
| Tool | model-controlled, side effects |
| Resource | app-controlled, read-only |
| Transport | stdio (local) or HTTP (remote) |

- **Value** → `M+N`, model-agnostic, no lock-in.
- **Primitives** → tools act, resources read, prompts are user workflows.
- **Transports** → stdio local, HTTP remote.
- **Security** → treat server output as untrusted; vault the credentials.
- **Not a loop replacement** → supplies tools to the normal tool-use loop.

---

## 11. Hands-On Exercises & Mini Project

- [ ] Build a stdio MCP server exposing one tool and one resource; test it with the MCP Inspector.
- [ ] Connect that server to a Claude agent via the SDK's `mcp_tool` helper and drive a tool call.
- [ ] Add a second server and connect both from one host; observe discovery merging their tools.
- [ ] Convert the stdio server to Streamable HTTP and connect via the Messages API MCP connector.
- [ ] Add a destructive tool and gate it behind a host-level confirmation before execution.

**Mini Project — "Team Knowledge MCP Server."** Build an MCP server that exposes a team's internal knowledge and connect it to an assistant.
*Goal:* one server that any MCP client can use to search docs, read a page (resource), and file an issue (tool).
*Requirements:* a `search_docs` tool and a `create_issue` tool with strict schemas; a `doc://<id>` resource for reading pages; stdio transport for local dev and HTTP for shared use; credentials injected via env/vault, never in code; a Claude agent client that discovers and uses it.
*Extensions:* add capability negotiation checks; add a "summarize this doc" prompt primitive; add auth to the HTTP transport; publish the server so a second host (a different app) can consume it unchanged; add tool search once the server exposes many tools.

---

## 12. Related Topics & Free Learning Resources

- **Chapter 33 — Tool & Function Calling** (the loop MCP tools plug into)
- **Chapter 32 — AI Agents: The Loop, Tools & Autonomy** (agents as the primary MCP consumers)
- **Chapter 36 — Multi-Agent Systems & Orchestration** (sharing MCP servers across a fleet of agents)

**Free Learning Resources**
- **Model Context Protocol — Official Specification & Docs** — Anthropic / MCP · *Intermediate* · the authoritative spec covering servers, clients, primitives, and transports. <https://modelcontextprotocol.io>
- **Introducing the Model Context Protocol** — Anthropic · *Beginner* · the announcement explaining the motivation and design. <https://www.anthropic.com/news/model-context-protocol>
- **MCP Python SDK** — modelcontextprotocol (GitHub) · *Intermediate* · the reference SDK with `FastMCP` server examples. <https://github.com/modelcontextprotocol/python-sdk>
- **MCP Reference Servers** — modelcontextprotocol (GitHub) · *Intermediate* · working example servers (filesystem, git, and more) to learn from and adapt. <https://github.com/modelcontextprotocol/servers>
- **MCP Connector (Anthropic Docs)** — Anthropic · *Intermediate* · connecting Claude directly to remote MCP servers from the Messages API. <https://docs.claude.com/en/docs/agents-and-tools/mcp-connector>
- **JSON-RPC 2.0 Specification** — jsonrpc.org · *Beginner–Intermediate* · the message format MCP is built on. <https://www.jsonrpc.org/specification>

---

*AI Engineering Handbook — chapter 35.*
