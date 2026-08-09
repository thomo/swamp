/**
 * Adds a `getAllConfigs` fan-out method to `@stateless/proxmox/qemu` —
 * fetches every VM's declarative config bag in one execution instead of
 * looping `getConfig` per vmid. Mirrors the same method added to
 * `@stateless/proxmox/lxc` in proxmox_lxc_get_all_configs.ts.
 *
 * Writes into the base type's existing `config` resource spec, using the
 * same `vm-${vmid}-config` instance naming as `getConfig`, so downstream CEL
 * reads (`data.findBySpec("<model>", "config")`) work the same regardless of
 * which method produced them.
 *
 * API transport (token auth) only — request logic is duplicated here rather
 * than imported from the pulled extension's internal `_lib/proxmox/*.ts`,
 * which isn't a stable cross-package import target.
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

async function pveGet(t: ApiTransport, path: string): Promise<unknown> {
  const url = `${t.apiUrl.replace(/\/+$/, "")}/api2/json${path}`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `PVEAPIToken=${t.tokenId}=${t.tokenSecret}`,
      Accept: "application/json",
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `GET ${path} failed: ${response.status} ${response.statusText} - ${text}`,
    );
  }
  const parsed = text ? JSON.parse(text) : {};
  return parsed.data;
}

interface GuestSummary {
  vmid: number;
  name?: string;
}

function parseGuestList(data: unknown): GuestSummary[] {
  if (!Array.isArray(data)) return [];
  return data.flatMap((g) => {
    if (g && typeof g === "object" && "vmid" in g) {
      const rec = g as Record<string, unknown>;
      return [{
        vmid: Number(rec.vmid),
        name: typeof rec.name === "string" ? rec.name : undefined,
      }];
    }
    return [];
  });
}

function parseConfig(data: unknown): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  if (data && typeof data === "object") {
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      if (typeof v === "string" || typeof v === "number") out[k] = v;
      else if (typeof v === "boolean") out[k] = v ? 1 : 0;
    }
  }
  return out;
}

export const extension = {
  type: "@stateless/proxmox/qemu",
  methods: [
    {
      getAllConfigs: {
        description:
          "Fetch the declarative config bag for every VM on the node in one " +
          "execution (fan-out over getConfig). API transport (token auth) only.",
        arguments: z.object({}),
        execute: async (
          _args: Record<string, never>,
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
          const { transport } = context.globalArgs;
          if (transport.kind !== "api") {
            throw new Error(
              "getAllConfigs only supports the 'api' transport (token auth) today.",
            );
          }
          const node = transport.node;

          const guests = parseGuestList(
            await pveGet(transport, `/nodes/${node}/qemu`),
          );
          context.logger.info("getAllConfigs: fetching {n} VMs on {node}", {
            n: guests.length,
            node,
          });

          const dataHandles = [];
          for (const guest of guests) {
            const config = parseConfig(
              await pveGet(transport, `/nodes/${node}/qemu/${guest.vmid}/config`),
            );
            const handle = await context.writeResource(
              "config",
              `vm-${guest.vmid}-config`,
              {
                vmid: guest.vmid,
                node,
                config,
                recordedAt: new Date().toISOString(),
              },
            );
            dataHandles.push(handle);
          }

          return { dataHandles };
        },
      },
    },
  ],
};
