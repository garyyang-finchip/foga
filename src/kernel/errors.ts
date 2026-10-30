import { Interface, type ErrorDescription } from "ethers";

/**
 * Revert decoding across every interface the kernel knows (world contracts, the cell account, the ERC-8004
 * surface). A revert that bubbles out of FogaCellAccount.execute arrives as CallFailed(bytes) with the inner
 * revert data inside; it is unwrapped so the message names the real cause.
 */
export class RevertDecoder {
  private readonly ifaces: Interface[] = [];
  private readonly seen = new Set<string>();

  add(iface: Interface, name?: string): void {
    const key = name ?? iface.fragments.map((f) => f.format("sighash")).join("|");
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.ifaces.push(iface);
  }

  /** Human-readable description of revert data, or null when nothing matches. */
  describe(data: string | null | undefined): string | null {
    if (!data || data === "0x") return null;
    const selector = data.slice(0, 10);
    if (selector === "0x08c379a0") {
      try {
        const [msg] = new Interface(["error Error(string)"]).decodeErrorResult("Error", data);
        return `Error(${JSON.stringify(msg)})`;
      } catch {
        /* fall through */
      }
    }
    if (selector === "0x4e487b71") {
      try {
        const [code] = new Interface(["error Panic(uint256)"]).decodeErrorResult("Panic", data);
        return `Panic(${code})`;
      } catch {
        /* fall through */
      }
    }
    for (const iface of this.ifaces) {
      let parsed: ErrorDescription | null = null;
      try {
        parsed = iface.parseError(data);
      } catch {
        parsed = null;
      }
      if (!parsed) continue;
      if (parsed.name === "CallFailed" && parsed.args.length === 1) {
        const inner = this.describe(String(parsed.args[0]));
        return `CallFailed(${inner ?? String(parsed.args[0])})`;
      }
      const args = parsed.args.map((a) => (typeof a === "bigint" ? a.toString() : Array.isArray(a) ? JSON.stringify(a.map(String)) : String(a)));
      return `${parsed.name}(${args.join(", ")})`;
    }
    return null;
  }

  /** Extract revert data from an ethers error (CallException, or a JSON-RPC error with data). */
  static revertData(err: any): string | null {
    if (!err) return null;
    if (typeof err.data === "string") return err.data;
    if (err.info?.error?.data && typeof err.info.error.data === "string") return err.info.error.data;
    if (err.error?.data && typeof err.error.data === "string") return err.error.data;
    const m = /0x[0-9a-fA-F]{8,}/.exec(err.info?.error?.message ?? err.shortMessage ?? err.message ?? "");
    return m ? m[0] : null;
  }

  explain(err: any): string {
    const data = RevertDecoder.revertData(err);
    const described = this.describe(data);
    const base = err?.shortMessage ?? err?.message ?? String(err);
    return described ? `${described} [${base}]` : base;
  }
}
