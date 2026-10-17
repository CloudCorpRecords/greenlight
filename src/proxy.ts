/**
 * `greenlight proxy`: a tiny localhost forwarder that attaches the user's
 * GitHub token server-side. Greenlight's own reads are unauthenticated at
 * 60/hr on the shared anonymous quota; the proxy lifts a user's setup to
 * the authenticated 5000/hr budget without their token ever touching a
 * browser, a log, or a tool's arguments beyond one env var.
 *
 *   export GITHUB_TOKEN=<classic-token>
 *   greenlight proxy &            # default 127.0.0.1:8792
 *   export GREENLIGHT_GITHUB_BASE_URL=http://127.0.0.1:8792 GITHUB_TOKEN=proxy
 *
 * Security model, stated plainly: the token is read once at startup from
 * GITHUB_TOKEN (or GH_TOKEN) and is never logged, never stored, and never
 * echoed. Incoming Authorization headers are ignored so a stray value
 * cannot leak through. The server binds 127.0.0.1 only, and it forwards
 * to exactly one upstream: https://api.github.com. Absolute-form request
 * targets (http://...) are rejected so the proxy cannot be aimed at other
 * hosts.
 */
import { createServer, request as httpRequest, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";

export const PROXY_DEFAULT_PORT = 8792;
export const PROXY_UPSTREAM = "https://api.github.com";

/** The exact client env line the command prints on startup. */
export function proxyClientEnv(port: number): string {
  return `GREENLIGHT_GITHUB_BASE_URL=http://127.0.0.1:${port} GITHUB_TOKEN=proxy`;
}

export interface ProxyConfig {
  token: string;
  tokenVar: string;
  port: number;
  upstream: string;
}

/**
 * Read the proxy configuration from the environment. Pure: returns the
 * config or the human-readable refusal, and never the token on the
 * refusal path either.
 */
export function resolveProxyConfig(env: NodeJS.ProcessEnv, port = PROXY_DEFAULT_PORT, upstream = PROXY_UPSTREAM): ProxyConfig | { error: string } {
  const tokenVar = env.GITHUB_TOKEN ? "GITHUB_TOKEN" : env.GH_TOKEN ? "GH_TOKEN" : undefined;
  const token = tokenVar ? env[tokenVar] : undefined;
  if (!tokenVar || !token) {
    return {
      error:
        "greenlight proxy needs a token: export GITHUB_TOKEN=<your-classic-token> first " +
        "(a classic personal access token; no scopes needed for public repos). The token is read once at startup and never logged or stored.",
    };
  }
  return { token, tokenVar, port, upstream };
}

interface StartedProxy {
  server: Server;
  port: number;
  stop: () => Promise<void>;
}

function forwardRequest(upstream: string, token: string, clientReq: IncomingMessage, clientRes: ServerResponse): void {
  const target = clientReq.url ?? "/";
  // Absolute-form targets would let a client aim the proxy at another
  // host; refuse them outright.
  if (/^https?:\/\//i.test(target)) {
    clientRes.writeHead(400, { "content-type": "text/plain" });
    clientRes.end("greenlight proxy: absolute-form request targets are rejected");
    return;
  }
  const upstreamUrl = new URL(target, upstream);
  const useHttps = upstreamUrl.protocol === "https:";
  const doRequest = useHttps ? httpsRequest : httpRequest;
  const headers: Record<string, string | string[] | undefined> = { ...clientReq.headers };
  delete headers["authorization"];
  delete headers["host"];
  delete headers["connection"];
  // The whole point: attach the startup token server-side.
  headers["authorization"] = `Bearer ${token}`;
  const upstreamReq = doRequest(
    {
      protocol: upstreamUrl.protocol,
      hostname: upstreamUrl.hostname,
      port: upstreamUrl.port || (useHttps ? 443 : 80),
      path: upstreamUrl.pathname + upstreamUrl.search,
      method: clientReq.method,
      headers: headers as Record<string, string | string[]>,
    },
    (upstreamRes) => {
      const out: Record<string, string | string[] | undefined> = {};
      for (const [k, v] of Object.entries(upstreamRes.headers)) {
        if (k.toLowerCase() === "transfer-encoding") continue;
        out[k] = v;
      }
      clientRes.writeHead(upstreamRes.statusCode ?? 502, out as Record<string, string | string[]>);
      upstreamRes.pipe(clientRes);
    }
  );
  upstreamReq.on("error", () => {
    if (!clientRes.headersSent) clientRes.writeHead(502, { "content-type": "text/plain" });
    clientRes.end("greenlight proxy: upstream unreachable");
  });
  upstreamReq.setTimeout(60000, () => upstreamReq.destroy(new Error("upstream timeout")));
  clientReq.pipe(upstreamReq);
}

/**
 * Start the proxy. Resolves when the socket is bound; the returned stop()
 * drains it. The token travels only in the Authorization header toward the
 * fixed upstream.
 */
export async function startProxy(config: ProxyConfig): Promise<StartedProxy> {
  const server = createServer((req, res) => forwardRequest(config.upstream, config.token, req, res));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : config.port;
  return {
    server,
    port,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
