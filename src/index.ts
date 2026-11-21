import { DurableObject } from "cloudflare:workers";
import {
  ContainerHarness,
  type ContainerAgent
} from "agents/harness/container";
import { Lifecycle } from "agents/lifecycle";

export { ContainerEgress } from "agents/harness/container";

interface Env {
  CF_CODEX_API_TOKEN: string;
}

interface PromptBody {
  text?: string;
  repo?: string;
  ref?: string;
  operationId?: string;
}

const CODEX_VERSION = "0.157.0";
const GO_VERSION = "1.26.11";
const GO_LINUX_AMD64_SHA256 =
  "9849f4e04ee35303714e34fbc3ac8ab44ea3e448a95aa182f91e3b9b79c710ec";
const AGENT_USER = "10001:10001";

/**
 * The built-in codex() preset always configures API-key egress. This agent
 * keeps the same managed image and Codex adapter but deliberately supplies
 * no provider override. Codex therefore uses its normal ChatGPT login.
 *
 * auth.json is symlinked into the adapter's mirrored session directory. That
 * makes refreshed OAuth credentials survive container replacement alongside
 * Codex's normal session files.
 */
function subscriptionCodex(): ContainerAgent {
  return {
    adapter: "codex",
    image: {
      kind: "managed",
      setup: [
        {
          name: "install Codex",
          command: [
            "npm",
            "install",
            "--global",
            "--no-fund",
            "--no-audit",
            `@openai/codex@${CODEX_VERSION}`
          ]
        },
        {
          name: "install Go toolchain",
          command: [
            "sh",
            "-c",
            [
              "set -eu",
              "apt-get update -qq",
              "apt-get install -y -qq --no-install-recommends curl build-essential pkg-config",
              `curl -fsSLo /tmp/go.tgz https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz`,
              `echo '${GO_LINUX_AMD64_SHA256}  /tmp/go.tgz' | sha256sum --check -`,
              "rm -rf /usr/local/go",
              "tar -C /usr/local -xzf /tmp/go.tgz",
              "ln -sfn /usr/local/go/bin/go /usr/local/bin/go",
              "ln -sfn /usr/local/go/bin/gofmt /usr/local/bin/gofmt",
              "go version",
              "rm -f /tmp/go.tgz",
              "rm -rf /var/lib/apt/lists/*"
            ].join("; ")
          ]
        },
        {
          name: "configure ChatGPT subscription authentication",
          user: "agent",
          command: [
            "sh",
            "-c",
            [
              "set -eu",
              "mkdir -p ~/.codex/sessions",
              "ln -sfn sessions/.cf-codex-auth.json ~/.codex/auth.json",
              "printf '%s\\n' 'cli_auth_credentials_store = \"file\"' 'forced_login_method = \"chatgpt\"' 'model_reasoning_effort = \"high\"' > ~/.codex/config.toml",
              "printf '%s\\n' 'Work autonomously, explain important decisions, and run relevant tests before reporting completion.' > ~/.codex/AGENTS.md",
              "chmod 700 ~/.codex"
            ].join("; ")
          ]
        }
      ]
    },
    env: {},
    egress: [],
    options: {}
  };
}

export class CodexAgent extends DurableObject<Env> {
  readonly harness = new ContainerHarness({
    container: containerOf(this.ctx),
    egress: this.ctx.exports.ContainerEgress,
    agent: subscriptionCodex(),
    // Leave enough time to complete device-code authentication.
    idleTimeoutMs: 15 * 60_000
  });

  readonly lifecycle = Lifecycle.install(this).use(this.harness);

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const route = url.pathname.replace(/^\/+|\/+$/g, "");
    const session = this.harness.session();

    if (request.method === "POST" && route === "prepare") {
      return this.prepare();
    }

    if (request.method === "POST" && route === "login") {
      return this.login(request.signal);
    }

    if (request.method === "GET" && route === "auth") {
      return this.authStatus();
    }

    if (request.method === "POST" && route === "prompt") {
      const body = await request.json<PromptBody>();
      if (!body.text?.trim()) return jsonError("text is required", 400);

      const options = body.operationId
        ? { operationId: body.operationId }
        : undefined;
      const receipt = await session.submit(bootstrapPrompt(body), options);
      return Response.json(receipt, { status: 202 });
    }

    const operationMatch = /^operations\/([^/]+)$/.exec(route);
    if (request.method === "GET" && operationMatch?.[1]) {
      return Response.json(
        await session.wait(decodeURIComponent(operationMatch[1]), request.signal)
      );
    }

    if (request.method === "GET" && route === "messages") {
      return Response.json(await session.messages());
    }

    if (request.method === "GET" && route === "events") {
      return this.events(request.signal);
    }

    if (request.method === "POST" && route === "abort") {
      return Response.json({ aborted: await session.abort() });
    }

    if (request.method === "POST" && route === "stop") {
      this.ctx.waitUntil(this.harness.stop());
      return Response.json({ stopping: true }, { status: 202 });
    }

    if (request.method === "GET" && route === "") {
      const messages = await session.messages();
      const last = messages.at(-1);
      return Response.json({
        container: await this.harness.container(),
        pending: await this.harness.pending(),
        messageCount: messages.length,
        lastActivity: last?.createdAt,
        latestText: latestAssistantText(messages)
      });
    }

    return jsonError("not found", 404);
  }

  /** Start and set up the managed container without requiring API credentials. */
  private async prepare(): Promise<Response> {
    const before = await this.harness.container();
    if (!before.running) {
      // The harness starts containers on demand. An unauthenticated Codex turn
      // exits quickly after setup; device login is run directly immediately
      // afterwards by login().
      const receipt = await this.harness.session().submit(
        "Prepare this Codex session for ChatGPT device authentication."
      );
      await this.harness.session().wait(receipt.operationId);
    }

    const container = await this.harness.container();
    if (!container.running) return jsonError("container preparation failed", 503);
    return Response.json({ prepared: true, container });
  }

  /** Stream Codex's device-code login instructions and polling output. */
  private async login(signal: AbortSignal): Promise<Response> {
    const container = await this.harness.container();
    if (!container.running) return jsonError("prepare the container first", 409);

    const process = await containerOf(this.ctx).exec(
      ["codex", "login", "--device-auth"],
      {
        cwd: "/workspace",
        env: { HOME: await sessionHome("root") },
        user: AGENT_USER,
        stderr: "combined"
      }
    );
    const stop = () => process.kill(15);
    signal.addEventListener("abort", stop, { once: true });
    void process.exitCode.finally(() => signal.removeEventListener("abort", stop));

    return new Response(process.stdout, {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store"
      }
    });
  }

  private async authStatus(): Promise<Response> {
    const container = await this.harness.container();
    if (!container.running) return jsonError("container is not running", 409);

    const process = await containerOf(this.ctx).exec(
      ["codex", "login", "status"],
      {
        cwd: "/workspace",
        env: { HOME: await sessionHome("root") },
        user: AGENT_USER,
        stderr: "combined"
      }
    );
    const output = await process.output();
    const text = new TextDecoder().decode(output.stdout).trim();
    return Response.json({
      authenticated: output.exitCode === 0,
      status: text
    });
  }

  private async events(signal: AbortSignal): Promise<Response> {
    const stream = await this.harness.session().events();
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (event: string, data: unknown) => {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
          );
        };

        send("snapshot", compactSnapshot(stream.snapshot));
        stream.start((events) => {
          for (const event of events) send(event.type, compactEvent(event));
        });
        signal.addEventListener("abort", () => {
          void stream.stop();
          controller.close();
        });
      }
    });

    return new Response(body, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache"
      }
    });
  }
}

function containerOf(ctx: DurableObjectState): Container {
  if (!ctx.container) throw new Error("Configure a container for CodexAgent");
  return ctx.container;
}

async function sessionHome(session: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(session)
  );
  const hash = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
  return `/home/agent/.harness/sessions/${hash}`;
}

function authorized(request: Request, env: Env): boolean {
  const header = request.headers.get("authorization");
  return header === `Bearer ${env.CF_CODEX_API_TOKEN}`;
}

function bootstrapPrompt(body: PromptBody): string {
  const prompt = body.text?.trim();
  if (!prompt) throw new Error("text is required");
  if (!body.repo) return prompt;

  const refInstruction = body.ref
    ? `Check out the git ref ${JSON.stringify(body.ref)}.`
    : "Use the repository's default branch.";

  return [
    "Prepare this remote coding workspace before starting the task:",
    `1. Clone ${JSON.stringify(body.repo)} into ~/workspace/repository if it is not already present.`,
    `2. ${refInstruction}`,
    "3. Work only inside ~/workspace/repository.",
    "4. Do not push changes or create a pull request unless the task explicitly asks you to.",
    "",
    "Task:",
    prompt
  ].join("\n");
}

type HarnessMessage = Awaited<ReturnType<ContainerHarness["messages"]>>[number];

function compactMessage(message: HarnessMessage): HarnessMessage {
  return {
    ...message,
    parts: message.parts.map((part) =>
      part.type === "tool"
        ? {
            type: "tool" as const,
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: {},
            state: part.state
          }
        : part
    )
  };
}

function compactSnapshot(snapshot: {
  readonly session: string;
  readonly messages: readonly HarnessMessage[];
  readonly pending: readonly unknown[];
  readonly busy: boolean;
}) {
  return {
    ...snapshot,
    messages: snapshot.messages.map(compactMessage)
  };
}

function compactEvent<T extends { readonly type: string }>(event: T): T {
  if (event.type !== "message" || !("message" in event)) return event;
  return {
    ...event,
    message: compactMessage(event.message as HarnessMessage)
  } as T;
}

function latestAssistantText(messages: readonly HarnessMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    for (let part = message.parts.length - 1; part >= 0; part -= 1) {
      const value = message.parts[part];
      if (value?.type === "text" && value.text.trim()) return value.text.trim();
    }
  }
  return undefined;
}

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return Response.json({
        service: "cf-codex",
        authentication: "chatgpt-subscription",
        status: "ok"
      });
    }

    if (!authorized(request, env)) return jsonError("unauthorized", 401);

    if (request.method === "POST" && url.pathname === "/v1/sessions") {
      const sessionId = `cx_${crypto.randomUUID().replaceAll("-", "")}`;
      const agent = ctx.exports.CodexAgent.getByName(sessionId);
      const response = await agent.fetch(
        new Request("https://cf-codex.internal/prepare", { method: "POST" })
      );
      const prepared = await response.json<Record<string, unknown>>();
      return Response.json(
        { sessionId, ...prepared },
        { status: response.status }
      );
    }

    const match = /^\/v1\/sessions\/([^/]+)(?:\/(.*))?$/.exec(url.pathname);
    if (!match?.[1]) return jsonError("not found", 404);

    const sessionId = decodeURIComponent(match[1]);
    if (!/^cx_[a-f0-9]{32}$/.test(sessionId)) {
      return jsonError("invalid session ID", 400);
    }

    const tail = match[2] ?? "";
    const internalUrl = new URL(`/${tail}${url.search}`, "https://cf-codex.internal");
    const forwarded = new Request(internalUrl, request);
    return ctx.exports.CodexAgent.getByName(sessionId).fetch(forwarded);
  }
} satisfies ExportedHandler<Env>;
