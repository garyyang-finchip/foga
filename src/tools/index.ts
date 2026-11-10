import { ADMIN_CAPABILITIES } from "./admin.js";
import { Catalog } from "./catalog.js";
import { DOCUMENT_CAPABILITIES } from "./documents.js";
import { FLOW_CAPABILITIES } from "./flows.js";
import { IDENTITY_CAPABILITIES } from "./identity.js";
import { MEDITATION_CAPABILITIES } from "./meditation.js";
import { PROPAGATION_CAPABILITIES } from "./propagation.js";
import { READ_CAPABILITIES } from "./read.js";
import { SPECIFICATION_CAPABILITIES } from "./specification.js";
import { TENDER_CAPABILITIES } from "./tenders.js";

export { Catalog, hashInput, succeeded } from "./catalog.js";
export type { CapabilitySummary, InvokeOptions } from "./catalog.js";
export * from "./types.js";

/** The catalog every entrance exposes: the Loop D path of the design memo's 43 capabilities (Phase 3a), the documents, the administration, the ERC-8490 maintenance (0.8.0), the ERC-8489 flows (0.9.0) and the cell specification (1.0.0). */
export function defaultCatalog(): Catalog {
  const c = new Catalog();
  for (const cap of [...READ_CAPABILITIES, ...PROPAGATION_CAPABILITIES, ...TENDER_CAPABILITIES, ...IDENTITY_CAPABILITIES, ...DOCUMENT_CAPABILITIES, ...MEDITATION_CAPABILITIES, ...FLOW_CAPABILITIES, ...SPECIFICATION_CAPABILITIES, ...ADMIN_CAPABILITIES]) c.register(cap);
  return c;
}
