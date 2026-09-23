import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const field = z.string().max(512);
export const telemetrySchema = z.object({
  collectedAt: z.iso.datetime().optional(),
  identity: field,
  version: field,
  uptime: field,
  dhcpLeases: z.array(z.object({
    id: field,
    address: z.ipv4(),
    macAddress: z.string().regex(/^(?:[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5})?$/),
    hostName: field,
    server: field,
    status: field,
    dynamic: z.boolean(),
    comment: field,
  }).strict()).max(2000).default([]),
  queues: z.array(z.object({
    id: field.min(1),
    kind: z.enum(["simple", "tree"]),
    name: field,
    target: field,
    parent: field,
    maxLimit: field,
    disabled: z.boolean(),
    dynamic: z.boolean(),
    settings: z.object({maxLimit: field, limitAt: field, burstLimit: field, burstThreshold: field, burstTime: field}).strict().optional(),
    packetMarks: field.optional(),
  }).strict()).max(2000),
}).strict();
export type Telemetry = z.infer<typeof telemetrySchema>;

export function validConnectorToken(header: string | null, expectedHash: string) {
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) return false;
  const match = /^Bearer ([A-Za-z0-9_-]{43,128})$/.exec(header ?? "");
  return Boolean(match && timingSafeEqual(
    createHash("sha256").update(match[1]).digest(),
    Buffer.from(expectedHash, "hex"),
  ));
}

export async function readJsonBounded(request: Request, limit = 1_000_000): Promise<unknown> {
  if (!request.body) throw new Error("Missing body");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new Error("Payload too large");
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    reader.releaseLock();
  }
}

export async function readTelemetry(request: Request) {
  return telemetrySchema.parse(await readJsonBounded(request, 4_000_000));
}
