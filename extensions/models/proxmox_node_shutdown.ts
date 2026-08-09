/**
 * Adds a `nodeShutdown` method to `@stateless/proxmox/lxc` — powers off the
 * Proxmox host itself via POST /nodes/{node}/status (command=shutdown). The
 * base type ships nodeStatus/nodeConfig (read-only host telemetry) but no
 * host power operation.
 *
 * Only the `api` transport (token auth) is implemented — the request/auth
 * logic is duplicated here rather than imported from the pulled extension's
 * internal `_lib/proxmox/client.ts`, which isn't a stable cross-package
 * import target (its file layout is specific to `pulled-extensions` and can
 * change between versions or when the extension is source-loaded instead).
 */
import { z } from "npm:zod@4";

interface ApiTransport {
  kind: "api";
  node: string;
  apiUrl: string;
  tokenId: string;
  tokenSecret: string;
  caCert?: string;
  skipTlsVerify?: boolean;
}

interface SshTransport {
  kind: "ssh";
  node: string;
}

type Transport = ApiTransport | SshTransport;

interface GlobalArgs {
  transport: Transport;
}

/** POST /nodes/{node}/status with command=shutdown over the PVE REST API. */
async function requestNodeShutdown(t: ApiTransport): Promise<unknown> {
  const url = `${t.apiUrl.replace(/\/+$/, "")}/api2/json/nodes/${t.node}/status`;
  const body = new URLSearchParams({ command: "shutdown" });

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `PVEAPIToken=${t.tokenId}=${t.tokenSecret}`,
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `Failed to shut down node ${t.node}: ${response.status} ${response.statusText} - ${text}`,
    );
  }
  const parsed = text ? JSON.parse(text) : {};
  return parsed.data;
}

export const extension = {
  type: "@stateless/proxmox/lxc",
  resources: {
    "nodeShutdown": {
      description: "Result of a node shutdown command",
      schema: z.object({
        node: z.string(),
        upid: z.string().optional().describe(
          "Proxmox task UPID for the shutdown, when returned",
        ),
        requestedAt: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: [
    {
      nodeShutdown: {
        description:
          "Power off the Proxmox host node (POST /nodes/{node}/status, command=shutdown). Requires confirm: true. API transport (token auth) only.",
        arguments: z.object({
          confirm: z.boolean().describe(
            "Must be true to actually issue the shutdown — safety guard against an accidental host power-off",
          ),
        }),
        execute: async (
          args: { confirm: boolean },
          context: {
            globalArgs: GlobalArgs;
            logger: { info: (msg: string, props?: unknown) => void };
            writeResource: (
              specName: string,
              name: string,
              data: Record<string, unknown>,
            ) => Promise<{ name: string }>;
          },
        ) => {
          if (!args.confirm) {
            throw new Error(
              "Refusing to shut down the Proxmox host: pass confirm: true to proceed.",
            );
          }

          const { transport } = context.globalArgs;
          if (transport.kind !== "api") {
            throw new Error(
              "nodeShutdown only supports the 'api' transport (token auth) today. " +
                "Reconfigure this model's transport to kind: 'api', or shut the node " +
                "down manually over SSH.",
            );
          }

          context.logger.info("Shutting down Proxmox node {node}", {
            node: transport.node,
          });

          const data = await requestNodeShutdown(transport);

          const handle = await context.writeResource(
            "nodeShutdown",
            "nodeShutdown",
            {
              node: transport.node,
              upid: typeof data === "string" ? data : undefined,
              requestedAt: new Date().toISOString(),
            },
          );
          return { dataHandles: [handle] };
        },
      },
    },
  ],
};
