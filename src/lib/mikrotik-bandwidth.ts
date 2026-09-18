import { z } from "zod";
const rate = String.raw`\d+(?:\.\d+)?[kKmMgG]?`;
const pair = z.string().max(80).regex(new RegExp(`^${rate}/${rate}$`));
export const settingsSchema = z.object({
  maxLimit: pair, limitAt: pair, burstLimit: pair, burstThreshold: pair,
  burstTime: z.string().max(80).regex(/^[\d:.hms]+\/[\d:.hms]+$/),
}).strict();
export const queueIdentitySchema = z.object({
  id: z.string().regex(/^\*[0-9A-Fa-f]+$/), name: z.string().min(1).max(128),
  target: z.string().regex(/^(?:\d{1,3}\.){3}\d{1,3}\/32$/),
}).strict();
export const planSpeedSchema = z.object({
  download: z.number().int().min(1).max(100000),
  upload: z.number().int().min(1).max(100000),
}).strict();
export function planSettings(download: number, upload: number) {
  const valid = planSpeedSchema.parse({ download, upload });
  const maxLimit = `${valid.upload * 1000000}/${valid.download * 1000000}`;
  const burst = `${(valid.upload + 10) * 1000000}/${(valid.download + 10) * 1000000}`;
  return settingsSchema.parse({ maxLimit,
    limitAt: maxLimit, burstLimit: burst, burstThreshold: burst, burstTime: "8s/8s" });
}

export function restrictedSettings() {
  return settingsSchema.parse({
    maxLimit: "1000/1000", limitAt: "1000/1000", burstLimit: "1000/1000",
    burstThreshold: "1000/1000", burstTime: "8s/8s",
  });
}
