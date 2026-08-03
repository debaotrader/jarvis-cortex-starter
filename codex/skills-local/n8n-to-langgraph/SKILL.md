---
name: n8n-to-langgraph
description: "INVOKE THIS SKILL when converting n8n workflows to LangGraph applications, analyzing n8n workflow JSON files for conversion, or reviewing an n8n-to-LangGraph conversion. Covers the full pipeline: workflow analysis, architecture planning, implementation via ralph-loop, and review."
argument-hint: "<workflows-dir> [review]"
---

# n8n → LangGraph Conversion

## Conversion Domain Knowledge

### Concept Mapping

| n8n Concept | LangGraph Equivalent |
|---|---|
| Workflow | StateGraph |
| Sub-workflow | Tool (StructuredTool) or nested graph |
| Webhook trigger | HTTP route (ElysiaJS/Express/etc.) |
| Schedule trigger | Cron job or external scheduler |
| AI Agent node | createReactAgent (inner agent) |
| Code node | Utility function or graph node |
| IF/Switch node | Conditional edges |
| Set/Edit Fields | State update in node return |
| Sticky Notes | Code comments |
| Credentials | Environment variables (.env) |
| Execution data | State schema (Annotation) |
| Wait node | sleep() in graph node |
| Error trigger | try/catch + conditional edge |
| Google OAuth credentials | Google Service Account (JSON key file) |
| — (no n8n equivalent) | Langfuse observability (CallbackHandler) |
| — (no n8n equivalent) | Logger service (structured logging) |

### Prompt Extraction

Where to find prompts in n8n JSON:
- `parameters.systemMessage` — AI Agent system prompt
- `parameters.text` — AI Agent user message template
- `parameters.messages` — Chat model message array
- AI Agent tool descriptions — in connected tool nodes' `parameters.description`
- Code nodes may contain prompt templates as string literals

### Google APIs — Service Account (NOT OAuth)

All Google integrations (Calendar, Sheets, Drive, Gmail, etc.) MUST use
**Service Account** authentication, NEVER OAuth2 user-consent flow.

n8n workflows often use OAuth credentials for Google services, but converted
apps must replace these with Service Account credentials for server-to-server
authentication (no browser, no user consent, no token refresh dance).

**Setup**:
1. Create a Service Account in Google Cloud Console
2. Download the JSON key file
3. Share the target resources (calendars, spreadsheets, etc.) with the
   Service Account email (`xxx@project.iam.gserviceaccount.com`)
4. For Gmail: enable domain-wide delegation and impersonate the target user

**Environment variables** (add to .env):
```env
GOOGLE_SERVICE_ACCOUNT_KEY_PATH=./google-service-account.json
# Or inline as base64:
GOOGLE_SERVICE_ACCOUNT_KEY_BASE64=eyJ0eXBlIjoi...
# For Gmail domain-wide delegation:
GOOGLE_IMPERSONATE_EMAIL=user@domain.com
```

**Auth helper module** — create `src/lib/google-auth.ts`:

```typescript
import { google } from "googleapis";

export function getGoogleAuth(scopes: string[], impersonateEmail?: string) {
  const keyPath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH;
  const keyBase64 = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_BASE64;

  let credentials: object;
  if (keyPath) {
    credentials = JSON.parse(Bun.file(keyPath).text());
  } else if (keyBase64) {
    credentials = JSON.parse(Buffer.from(keyBase64, "base64").toString());
  } else {
    throw new Error("Google Service Account credentials not configured");
  }

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes,
    clientOptions: impersonateEmail
      ? { subject: impersonateEmail }
      : undefined,
  });

  return auth;
}
```

**Usage**:
```typescript
const auth = getGoogleAuth(["https://www.googleapis.com/auth/calendar.readonly"]);
const calendar = google.calendar({ version: "v3", auth });
```

**Package**: `googleapis` (add via `bun add googleapis`)

### State Management

n8n uses per-execution data that flows between nodes. LangGraph uses persistent
checkpointers (PostgresSaver, MemorySaver) with thread-based state.

Key differences:
- n8n: data is ephemeral per execution, stored in `$json`, `$node[]`
- LangGraph: state persists across invocations via checkpointer
- Map n8n execution data → LangGraph state schema (Annotation.Root)
- Map n8n static data → LangGraph Store or database

### HTTP Server Binding

Generated apps MUST bind to `0.0.0.0` (all interfaces), NOT `localhost` or
`127.0.0.1`. This ensures the server is reachable from external services
(e.g., Chatwoot webhooks).

```typescript
// ElysiaJS
app.listen({ hostname: "0.0.0.0", port: Number(process.env.PORT ?? 3000) });

// Express
app.listen(Number(process.env.PORT ?? 3000), "0.0.0.0");

// Bun.serve
Bun.serve({ hostname: "0.0.0.0", port: Number(process.env.PORT ?? 3000), fetch: handler });
```

### package.json Scripts

The generated `package.json` MUST include a `dev` script using Bun's `--hot` flag
for hot reloading (preserves state, faster than `--watch`):

```json
{
  "scripts": {
    "dev": "bun --hot src/index.ts",
    "start": "bun src/index.ts"
  }
}
```

`--hot` reloads modules in-place without restarting the process, keeping
HTTP connections and in-memory state alive. Use `--watch` only if `--hot`
causes issues with a specific library.

### Tool Factory Pattern

When tools need webhook/request context (e.g., conversation ID, phone number),
use factory functions that capture context in closure:

```typescript
function createTools(context: { telefone: string; conversationId: number }) {
  return [
    tool(async (input) => {
      // context.telefone available here
    }, { name: "...", schema: z.object({...}) })
  ];
}
```

### Logger Service (Default)

All converted LangGraph applications MUST include a centralized logger service
for structured, leveled logging. Use **pino** as the logging library.

**Package**: `pino` + `pino-pretty` (dev dependency)

**Helper module** — create `src/lib/logger.ts`:

```typescript
import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  transport:
    process.env.NODE_ENV !== "production"
      ? { target: "pino-pretty", options: { colorize: true } }
      : undefined,
});

export function createChildLogger(context: Record<string, unknown>) {
  return logger.child(context);
}
```

Design principles:
- **Leveled**: `trace`, `debug`, `info`, `warn`, `error`, `fatal` — configurable via LOG_LEVEL env var
- **Structured**: all log entries are JSON in production, pretty-printed in dev
- **Child loggers**: use `createChildLogger` to add context (request ID, conversation ID, etc.)
- **Zero-cost in prod**: pino is fast and low-overhead by design

**Where to log** (be generous — logs are cheap, debugging without them is expensive):

| Location | What to log | Level |
|---|---|---|
| Server startup | Host, port, public IP, environment | `info` |
| Webhook received | Route, method, conversation ID, payload size | `info` |
| Graph invocation start | Graph name, thread ID, input summary | `info` |
| Graph invocation end | Graph name, thread ID, duration, output summary | `info` |
| Node entry/exit | Node name, state snapshot (key fields) | `debug` |
| Tool execution | Tool name, input params, output summary, duration | `debug` |
| LLM call | Model, token count, latency (via Langfuse, but also log) | `debug` |
| Conditional routing | Decision made, which branch taken, why | `debug` |
| External API call | Service, method, URL, status code, duration | `info` |
| External API error | Service, method, URL, status code, error body | `error` |
| State update | Key fields changed, new values (redact sensitive data) | `debug` |
| Error caught | Error message, stack trace, context | `error` |
| Webhook response sent | Status code, duration from receipt | `info` |
| Langfuse flush | Success/failure of handler shutdown | `debug` |
| Credential validation | Service name, success/failure (never log secrets) | `info` |

**Usage patterns**:

```typescript
import { logger, createChildLogger } from "./lib/logger";

// At server startup
logger.info({ host: "0.0.0.0", port: 3000, publicIp }, "Server started");

// In webhook handler — create child logger with request context
const log = createChildLogger({ route: "/webhook/chatwoot", conversationId });
log.info({ payloadSize: body.length }, "Webhook received");

// In graph node
log.debug({ node: "classify_intent", threadId }, "Entering node");
// ... node logic ...
log.debug({ node: "classify_intent", result: intent }, "Exiting node");

// In tool execution
log.debug({ tool: "buscar_agenda", input: { date } }, "Tool called");
const result = await fetchCalendar(date);
log.debug({ tool: "buscar_agenda", slots: result.length }, "Tool completed");

// Error handling
try {
  await chatwootApi.sendMessage(conversationId, text);
  log.info({ service: "chatwoot", conversationId }, "Message sent");
} catch (err) {
  log.error({ service: "chatwoot", conversationId, err }, "Failed to send message");
  throw err;
}
```

**CRITICAL**: Never log secrets, API keys, tokens, or full request bodies containing
sensitive user data. Redact or omit sensitive fields.

### Langfuse Observability (Default)

All converted LangGraph applications MUST include Langfuse integration by default
for tracing, token usage, latency, and cost monitoring.

**Packages**: `langfuse` + `langfuse-langchain`

**Environment variables** (add to .env alongside other credentials):
```env
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_BASEURL=https://cloud.langfuse.com
```

**Helper module** — create `src/lib/langfuse.ts` (or equivalent path):

```typescript
import { CallbackHandler } from "langfuse-langchain";

const langfuseActive =
  !!process.env.LANGFUSE_SECRET_KEY && !!process.env.LANGFUSE_PUBLIC_KEY;

export function createLangfuseHandler(
  traceName: string,
  opts: {
    sessionId?: string;
    userId?: string;
    metadata?: Record<string, unknown>;
    tags?: string[];
  } = {},
): CallbackHandler | undefined {
  if (!langfuseActive) return undefined;

  return new CallbackHandler({
    secretKey: process.env.LANGFUSE_SECRET_KEY!,
    publicKey: process.env.LANGFUSE_PUBLIC_KEY!,
    baseUrl: process.env.LANGFUSE_BASEURL ?? "https://cloud.langfuse.com",
    sessionId: opts.sessionId,
    userId: opts.userId,
    metadata: { ...opts.metadata, traceName },
    tags: opts.tags,
  });
}

export async function flushLangfuseHandler(
  handler: CallbackHandler | undefined,
): Promise<void> {
  if (handler) {
    await handler.shutdownAsync();
  }
}
```

Design principles:
- **Opt-in via env vars**: returns `undefined` when keys are missing — zero overhead in dev/test
- **One handler per trace**: each request/invocation gets its own handler so traces don't mix
- **`traceName` in metadata**: stored in metadata for dashboard filtering
- **Always call `shutdownAsync()`**: use try/finally to guarantee buffered events are flushed

**Usage in graph/agent invocations**:

```typescript
// For compiled graph.invoke()
const langfuseHandler = createLangfuseHandler("my-graph", {
  sessionId: threadId,
});
try {
  const result = await graph.invoke(initialState, {
    configurable: { thread_id: threadId },
    callbacks: langfuseHandler ? [langfuseHandler] : undefined,
  });
} finally {
  await flushLangfuseHandler(langfuseHandler);
}

// For createReactAgent .invoke()
const langfuseHandler = createLangfuseHandler("react-agent", {
  sessionId: conversationId,
  userId: userId,
});
try {
  const result = await agent.invoke(
    { messages },
    langfuseHandler ? { callbacks: [langfuseHandler] } : undefined,
  );
} finally {
  await flushLangfuseHandler(langfuseHandler);
}
```

Callback propagation is automatic — passing callbacks to `graph.invoke()` or
`agent.invoke()` propagates to all nested LLM calls, tool calls, and sub-chains.
No changes needed in tools or prompts.

### Testing Strategy

Use **Bun's native test runner** (`bun test`) — NEVER install vitest, jest, mocha,
or any external test framework. Bun has built-in `describe`, `it`, `expect`, `mock`,
`spyOn`, `beforeEach`, `afterEach`, and lifecycle hooks.

```typescript
import { describe, it, expect, mock, spyOn, beforeEach } from "bun:test";

describe("myTool", () => {
  it("should return expected result", async () => {
    const mockFetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ ok: true })))
    );
    // ... test logic
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
```

Key Bun test features to use:
- `mock()` for creating mock functions (replaces `vi.fn()` / `jest.fn()`)
- `spyOn(object, method)` for spying on existing methods
- `mock.module("module-name", () => ...)` for module mocking
- Test files: `*.test.ts` naming convention
- Run with: `bun test` (auto-discovers test files)
- Run specific: `bun test src/tools/my-tool.test.ts`

Tests after each implementation milestone (not TDD):
1. **Foundation** (env, DB): validate config loading, connection setup
2. **Services** (API clients): mock HTTP, verify request shapes
3. **Tools**: each tool with mocked services, verify output
4. **Graphs**: routing logic with mock LLM, verify node transitions
5. **Routes**: webhook handlers end-to-end with mocked graph

### Graph Visualization

Create a `visualize-graphs.ts` script using LangGraph's built-in method:

```typescript
import { graph } from "./graphs/main-agent/graph";
const png = await graph.getGraph().drawMermaidPng();
await Bun.write("main-agent.png", png);
```

Run after implementation to verify graph topology visually.

### Common Pitfalls

1. **Simplified prompts** — Extract VERBATIM, adapt minimally
2. **Missing branches** — n8n IF/Switch can have many outputs; map ALL
3. **Lost error handling** — n8n error triggers → try/catch + conditional edges
4. **Credential gaps** — List ALL env vars needed before implementing
5. **Package.json edits** — NEVER edit manually; always `bun add <pkg>`
6. **Language mismatch** — Use user's language in code naming, not English
7. **Localhost binding** — Server MUST bind to `0.0.0.0`, never localhost/127.0.0.1
8. **Webhook URLs with localhost** — Always detect public IP (`curl -s ifconfig.me`)
   and use it for webhook URLs so external services can reach the app
9. **Manual webhook setup** — Use MCP Chatwoot tools to register webhooks
   automatically instead of asking the user to do it manually
10. **Missing logging** — Every graph node, tool, API call, webhook handler,
    and error path MUST have logging. Use the logger service, not console.log
11. **Google OAuth** — NEVER use OAuth2 for Google APIs. Always use Service Account
    credentials. n8n uses OAuth but converted apps must use Service Account.

---

## Orchestration Instructions

When the user invokes `/n8n-to-langgraph` (or context matches):

If $ARGUMENTS contains "review", go to **Review Mode** below.
Otherwise, run the Analysis + Planning pipeline:

### PHASE 1: WORKFLOW ANALYSIS

1. Identify all workflow JSON files in the `$ARGUMENTS` directory
2. Launch 2-3 `workflow-analyzer` agents in parallel
   - Each receives a batch of workflow file paths
   - Agents have n8n skills preloaded (n8n-workflow-patterns,
     n8n-node-configuration, n8n-code-javascript)
3. Read agent results and consolidate:
   - All integrations found (Chatwoot, Google Calendar, OpenAI, etc.)
   - All credentials/env vars needed
   - All system prompts extracted verbatim
   - Data flow between workflows
4. Present analysis summary to user
5. **CREDENTIAL SETUP (MANDATORY GATE — do not proceed to Phase 2 without this)**:
   - Create .env file with all needed variables (placeholders for values)
   - Include LANGFUSE_SECRET_KEY, LANGFUSE_PUBLIC_KEY, LANGFUSE_BASEURL in .env
   - Ask user to fill in the actual credentials
   - Test connections where possible (e.g. curl Chatwoot API with provided token)
   - Do not proceed until user confirms credentials are set up
   - If user wants to skip, acknowledge that manual testing won't be
     possible until credentials are configured later
6. **PUBLIC IP DETECTION**:
   - Detect the machine's public IP by running: `curl -s ifconfig.me`
   - Store the public IP for use in webhook URLs
   - Determine the app's PORT from .env (default 3000)
   - Build the webhook base URL: `http://<PUBLIC_IP>:<PORT>`
   - Save PUBLIC_IP and WEBHOOK_BASE_URL to .env for reference
7. **CHATWOOT WEBHOOK SETUP (interactive, using MCP Chatwoot tools)**:
   If Chatwoot is among the detected integrations, invoke the
   `chatwoot-skills:chatwoot-admin-configuration` skill for guidance
   and use MCP Chatwoot tools to configure webhooks interactively
   with the user:

   a. **Determine webhook strategy** — ask the user which approach fits:
      - **Account-level webhook** (receives events for ALL conversations):
        ```
        webhooks_create(
          account_id: <ID>,
          url: "http://<PUBLIC_IP>:<PORT>/webhook/chatwoot",
          subscriptions: ["message_created", "message_updated",
            "conversation_created", "conversation_status_changed"]
        )
        ```
      - **API inbox with webhook_url** (receives only that inbox's messages):
        ```
        inboxes_create(
          account_id: <ID>,
          name: "<inbox name>",
          channel: { type: "api", webhook_url: "http://<PUBLIC_IP>:<PORT>/webhook/chatwoot" }
        )
        ```
      - **Agent bot with outgoing_url** (bot receives conversation events):
        ```
        agent_bots_create(
          name: "<bot name>",
          outgoing_url: "http://<PUBLIC_IP>:<PORT>/webhook/chatwoot"
        )
        ```
        Then attach to inbox: `inboxes_set_agent_bot(account_id, inbox_id, agent_bot_id)`

   b. **Execute the chosen setup** using the MCP Chatwoot tools:
      - For account webhook: call `webhooks_create` with the public IP URL
        and the event subscriptions needed by the converted workflows
      - For API inbox: call `inboxes_create` with channel type "api"
      - For bot: call `agent_bots_create` then `inboxes_set_agent_bot`

   c. **Verify the configuration**:
      - List webhooks or inbox details to confirm the URL was registered
      - Show the user the configured webhook URL and subscribed events
      - Suggest a quick test: send a test message in Chatwoot and check
        that the app receives it (once the server is running)

   d. **Document the setup** in the project README or .env:
      - Which webhook strategy was chosen
      - The webhook URL and subscribed events
      - How to reconfigure if the public IP changes

   If other services need webhook registration, document the URL
   for the user to configure manually.

### PHASE 2: ARCHITECTURE & PLANNING

1. Launch `conversion-architect` agent with:
   - Full consolidated analysis from Phase 1
   - List of credentials available in .env
   - User's language preference
   - Instruction to include Logger service module (`src/lib/logger.ts`) with
     structured logging throughout all layers (routes, nodes, tools, services)
   - Instruction to include Langfuse observability module (`src/lib/langfuse.ts`)
     and wire it into all graph/agent `.invoke()` calls
   - List of detected integrations (e.g. Chatwoot, Google Calendar, etc.)
     and their corresponding skills to invoke during architecture design
     (e.g. "If you need Chatwoot patterns, invoke chatwoot-skills:chatwoot-automation-patterns")
2. Architect produces the conversion plan including:
   - Architecture overview
   - State schemas, node/edge definitions, tool specs
   - Logger service spec (`src/lib/logger.ts`) and logging placement guide
   - Langfuse helper module spec (`src/lib/langfuse.ts`) and wiring into all invoke calls
   - System prompts: ORIGINAL + PROPOSED ADAPTATION + DIFF
   - Package list (exact names for `bun add` — NEVER manual package.json)
     — must include `langfuse`, `langfuse-langchain`, `pino`, and `pino-pretty` (dev)
   - Milestone-based test plan
   - Implementation order as phased checklist
   - Graph visualization script spec (visualize-graphs.ts)
3. Present plan summary to user for review

### RALPH-LOOP HANDOFF

When the user is satisfied with the plan, instruct them to run
(in the user's language, adapting the text below accordingly):

```
/ralph-loop:ralph-loop "Leia e siga o plano de conversão em
<PLAN_FILE_PATH>. Siga as diretrizes de implementação na
seção final do plano.

Após cada milestone concluído, execute a skill de review para validar
o trabalho feito até o momento:
/n8n-to-langgraph <WORKFLOWS_DIR> review

Analise o relatório de review e corrija os problemas críticos
(confidence >= 90%) antes de avançar para o próximo milestone."
--max-iterations 15 --completion-promise
'Todos os workflows convertidos, testes passando, verificação manual completa'
```

The implementation guidelines are embedded in the plan itself (written
by the conversion-architect), so the ralph-loop prompt only needs to
reference the plan file path. All rules — bun add, user's language,
skill invocation, testing, commits, etc. — live in the plan.

The review step (`/n8n-to-langgraph <WORKFLOWS_DIR> review`) launches
the `conversion-reviewer` agents after each milestone, catching fidelity
and quality issues early instead of only at the end.

---

## Review Mode

When `$ARGUMENTS` contains "review":

1. Launch 2-3 `conversion-reviewer` agents in parallel:
   - Agent A focus: Prompt fidelity + logic completeness
   - Agent B focus: Test coverage + code quality
   - Agent C focus: Integration correctness + error handling + Langfuse wiring
   (All reviewers have langgraph + n8n + conversion skills preloaded)
2. Consolidate findings
3. Present review report:
   - Fidelity score per workflow
   - Critical issues (confidence >= 90%)
   - Important issues (confidence >= 80%)
   - Low-confidence observations (< 80%, for documentation)
   - Improvement suggestions
4. Ask user which issues to address
