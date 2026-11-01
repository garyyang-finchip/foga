import { ADMIN_CAPABILITIES } from "./admin.js";
import { Catalog } from "./catalog.js";
import { IDENTITY_CAPABILITIES } from "./identity.js";
import { READ_CAPABILITIES } from "./read.js";
import { TENDER_CAPABILITIES } from "./tenders.js";

export { Catalog, hashInput, succeeded } from "./catalog.js";
export type { CapabilitySummary, InvokeOptions } from "./catalog.js";
export * from "./types.js";

/** The catalog every entrance exposes: the Loop D path of the design memo's 43 capabilities, in Phase 3a. */
export function defaultCatalog(): Catalog {
  const c = new Catalog();
  for (const cap of [...READ_CAPABILITIES, ...TENDER_CAPABILITIES, ...IDENTITY_CAPABILITIES, ...ADMIN_CAPABILITIES]) c.register(cap);
  return c;
}
