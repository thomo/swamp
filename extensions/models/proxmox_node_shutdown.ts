/**
 * Adds a `shutdown` method to the community `@keeb/proxmox/node` type —
 * powers off the Proxmox host itself via POST /nodes/{node}/status
 * (command=shutdown). The base type only ships `auth`/`status`.
 *
 * Self-contained auth: reuses the same on-disk ticket cache the base type's
 * `auth` method writes (`.swamp/data/@keeb/proxmox/node/<defId>/auth/`), and
 * falls back to username/password if no fresh cache exists. Duplicated here
 * rather than imported from the pulled extension's internal lib, which isn't
 * a stable cross-package import target.
 */
import { z } from "npm:zod@4";

interface CurlOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  skipTlsVerify?: boolean;
}

async function fetchWithCurl(url: string, options: CurlOptions) {
  const { method = "GET", headers = {}, body, skipTlsVerify } = options;
  const args = ["-s", "-S"];
  if (skipTlsVerify) args.push("-k");
  args.push("-X", method);
  for (const [key, value] of Object.entries(headers)) {
    args.push("-H", `${key}: ${value}`);
  }
  if (body) args.push("-d", body);
  args.push("-i", url);

  // @ts-ignore - Deno API
  const command = new Deno.Command("curl", { args });
  const { code, stdout, stderr } = await command.output();
  if (code !== 0) {
    throw new Error(
      `curl failed with code ${code}: ${new TextDecoder().decode(stderr)}`,
    );
  }

  const output = new TextDecoder().decode(stdout);
  const headerEndIndex = output.indexOf("\r\n\r\n");
  const headersText = output.substring(0, headerEndIndex);
  const bodyText = output.substring(headerEndIndex + 4);
  const statusLine = headersText.split("\r\n")[0];
  const statusMatch = statusLine.match(/HTTP\/[\d.]+ (\d+)/);
  const status = statusMatch ? parseInt(statusMatch[1]) : 0;

  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: statusLine,
    text: () => bodyText,
    json: () => JSON.parse(bodyText),
  };
}

const AUTH_TTL_MS = 2 * 60 * 60 * 1000;

interface NodeGlobalArgs {
  apiUrl: string;
  node: string;
  username?: string;
  password?: string;
  realm?: string;
  skipTlsVerify?: boolean;
}

async function resolveAuth(
  globalArgs: NodeGlobalArgs,
  context: { definition: { id: string }; repoDir: string },
) {
  const { apiUrl, skipTlsVerify, username, password, realm } = globalArgs;

  try {
    const authDir =
      `${context.repoDir}/.swamp/data/@keeb/proxmox/node/${context.definition.id}/auth`;
    const entries: { name: string; isDirectory: boolean }[] = [];
    // @ts-ignore - Deno API
    for await (const entry of Deno.readDir(authDir)) {
      if (entry.isDirectory) entries.push(entry);
    }
    if (entries.length > 0) {
      const versions = entries
        .map((e) => parseInt(e.name, 10))
        .filter((n) => !isNaN(n));
      const latest = Math.max(...versions);
      const rawPath = `${authDir}/${latest}/raw`;
      const metaPath = `${authDir}/${latest}/metadata.yaml`;
      // @ts-ignore - Deno API
      const metaText = await Deno.readTextFile(metaPath);
      const createdAtMatch = metaText.match(/createdAt:\s*'([^']+)'/);
      if (createdAtMatch) {
        const ageMs = Date.now() - new Date(createdAtMatch[1]).getTime();
        if (ageMs < AUTH_TTL_MS) {
          // @ts-ignore - Deno API
          const rawText = await Deno.readTextFile(rawPath);
          const cached = JSON.parse(rawText);
          return { ticket: cached.ticket, csrfToken: cached.csrfToken };
        }
      }
    }
  } catch (_e) {
    // No usable cache — fall through to password auth.
  }

  if (!username || !password) {
    throw new Error(
      "No cached Proxmox auth found and no username/password configured. " +
        "Run the node's `auth` method first, or set username/password.",
    );
  }

  const formData = new URLSearchParams();
  formData.append("username", `${username}@${realm || "pam"}`);
  formData.append("password", password);

  const response = await fetchWithCurl(`${apiUrl}/api2/json/access/ticket`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formData.toString(),
    skipTlsVerify: skipTlsVerify ?? true,
  });
  if (!response.ok) {
    throw new Error(
      `Authentication failed: ${response.status} ${response.statusText}`,
    );
  }
  const result = response.json();
  return {
    ticket: result.data.ticket,
    csrfToken: result.data.CSRFPreventionToken,
  };
}

export const extension = {
  type: "@keeb/proxmox/node",
  resources: {
    "shutdown": {
      description: "Result of a node shutdown command",
      schema: z.object({
        upid: z.string().describe("Proxmox task UPID for the shutdown"),
        node: z.string(),
        requestedAt: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: [
    {
      shutdown: {
        description:
          "Power off the Proxmox host node (POST /nodes/{node}/status, command=shutdown). Requires confirm: true.",
        arguments: z.object({
          confirm: z.boolean().describe(
            "Must be true to actually issue the shutdown — safety guard against an accidental host power-off",
          ),
        }),
        execute: async (
          args: { confirm: boolean },
          context: {
            globalArgs: NodeGlobalArgs;
            definition: { id: string; name: string };
            repoDir: string;
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

          const { apiUrl, node, skipTlsVerify } = context.globalArgs;
          const auth = await resolveAuth(context.globalArgs, context);

          context.logger.info("Shutting down Proxmox node {node}", { node });

          const response = await fetchWithCurl(
            `${apiUrl}/api2/json/nodes/${node}/status`,
            {
              method: "POST",
              headers: {
                "Cookie": `PVEAuthCookie=${auth.ticket}`,
                "CSRFPreventionToken": auth.csrfToken,
                "Content-Type": "application/x-www-form-urlencoded",
              },
              body: new URLSearchParams({ command: "shutdown" }).toString(),
              skipTlsVerify,
            },
          );

          if (!response.ok) {
            throw new Error(
              `Failed to shut down node: ${response.status} ${response.statusText} - ${response.text()}`,
            );
          }

          const result = response.json();

          const handle = await context.writeResource("shutdown", "shutdown", {
            upid: String(result.data),
            node,
            requestedAt: new Date().toISOString(),
          });
          return { dataHandles: [handle] };
        },
      },
    },
  ],
};
