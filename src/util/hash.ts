import { createHash } from "node:crypto";

export function sha256Hex(data: string | Buffer): string {
  return "0x" + createHash("sha256").update(data).digest("hex");
}
