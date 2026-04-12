import { ExtractedInvoice } from './invoice-extractor';

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

/**
 * Convert a raw invoice date string to RFC 3339 (required by Box metadata).
 * Accepts YYYYMMDD (CII) or YYYY-MM-DD (UBL/ISO).
 */
function toBoxDate(raw: string): string | undefined {
  if (!raw) return undefined;
  if (raw.length === 8 && !raw.includes('-')) {
    // CII YYYYMMDD → YYYY-MM-DD
    return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T00:00:00.000Z`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return `${raw}T00:00:00.000Z`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Enum resolution maps (key = parsed code, value = Box option key)
// ---------------------------------------------------------------------------

const INVOICE_TYPE_MAP: Record<string, string> = {
  '380': '380 - Commercial Invoice',
  '381': '381 - Credit Note',
  '384': '384 - Corrected Invoice',
  '389': '389 - Self-Billed Invoice',
};

/** Map profile URI fragment to Box enum option key */
function resolveProfile(uri: string): string | undefined {
  if (!uri) return undefined;
  const lower = uri.toLowerCase();
  // Order matters: check more specific patterns first
  if (lower.includes('xrechnung')) return 'XRECHNUNG';
  if (lower.includes('extended')) return 'EXTENDED';
  if (lower.includes('en16931')) return 'EN16931';
  if (lower.includes('basicwl') || lower.includes('basic-wl') || lower.includes('basic_wl')) return 'BASIC WL';
  if (lower.includes('basic')) return 'BASIC';
  if (lower.includes('minimum')) return 'MINIMUM';
  return undefined;
}

const TAX_CATEGORY_MAP: Record<string, string> = {
  'S':  'S - Standard rate',
  'Z':  'Z - Zero rated',
  'E':  'E - Exempt',
  'AE': 'AE - Reverse charge',
  'K':  'K - Intra-EU',
  'G':  'G - Export',
  'O':  'O - Outside scope',
  'L':  'L - IGIC (Canary Islands)',
  'M':  'M - IPSI (Ceuta/Melilla)',
};

const PAYMENT_MEANS_MAP: Record<string, string> = {
  '10': '10 - Cash',
  '30': '30 - Credit Transfer',
  '48': '48 - Bank Card',
  '58': '58 - SEPA Credit Transfer',
  '59': '59 - SEPA Direct Debit',
};

// ---------------------------------------------------------------------------
// Mapper
// ---------------------------------------------------------------------------

/**
 * Map an extracted invoice to a Box metadata object whose keys match the
 * `zugferd_invoice` template (or any template with the same field keys).
 * Only fields with a non-empty value are included so Box does not reject
 * the request due to null / empty strings in required-type fields.
 */
export function mapToBoxMetadata(inv: ExtractedInvoice): Record<string, unknown> {
  const meta: Record<string, unknown> = {};

  function str(key: string, value: string): void {
    if (value) meta[key] = value;
  }
  function dt(key: string, raw: string): void {
    const v = toBoxDate(raw);
    if (v) meta[key] = v;
  }
  function flt(key: string, value: number | null): void {
    if (value !== null) meta[key] = value;
  }
  function en(key: string, map: Record<string, string>, code: string): void {
    const v = map[code];
    if (v) meta[key] = v;
  }

  // Document
  str('invoiceNumber', inv.invoiceNumber);
  dt('invoiceDate', inv.invoiceDate);
  en('invoiceTypeCode', INVOICE_TYPE_MAP, inv.typeCode);
  str('documentName', inv.documentName);
  const profile = resolveProfile(inv.profileUri);
  if (profile) meta['zugferdProfile'] = profile;
  str('currencyCode', inv.currencyCode);
  str('taxCurrencyCode', inv.taxCurrencyCode);
  dt('dueDate', inv.dueDate);
  str('paymentTerms', inv.paymentTerms);
  str('notes', inv.notes);

  // References
  str('buyerOrderReference', inv.buyerOrderReference);
  str('sellerOrderReference', inv.sellerOrderReference);
  str('contractReference', inv.contractReference);
  str('projectReference', inv.projectReference);
  dt('deliveryDate', inv.deliveryDate);
  str('deliveryNoteReference', inv.deliveryNoteReference);
  str('referencedInvoiceNumber', inv.referencedInvoiceNumber);
  dt('referencedInvoiceDate', inv.referencedInvoiceDate);
  str('accountingReference', inv.accountingReference);

  // Seller
  str('sellerName', inv.sellerName);
  str('sellerGlobalId', inv.sellerGlobalId);
  str('sellerStreet', inv.sellerStreet);
  str('sellerCity', inv.sellerCity);
  str('sellerPostalCode', inv.sellerPostalCode);
  str('sellerCountry', inv.sellerCountry);
  str('sellerVatId', inv.sellerVatId);
  str('sellerTaxNumber', inv.sellerTaxNumber);
  str('sellerContactName', inv.sellerContactName);
  str('sellerContactEmail', inv.sellerContactEmail);
  str('sellerContactPhone', inv.sellerContactPhone);

  // Buyer
  str('buyerName', inv.buyerName);
  str('buyerGlobalId', inv.buyerGlobalId);
  str('buyerStreet', inv.buyerStreet);
  str('buyerCity', inv.buyerCity);
  str('buyerPostalCode', inv.buyerPostalCode);
  str('buyerCountry', inv.buyerCountry);
  str('buyerVatId', inv.buyerVatId);
  str('buyerReference', inv.buyerReference);
  str('buyerContactName', inv.buyerContactName);
  str('buyerContactEmail', inv.buyerContactEmail);

  // Ship-to
  str('shipToName', inv.shipToName);
  str('shipToStreet', inv.shipToStreet);
  str('shipToCity', inv.shipToCity);
  str('shipToPostalCode', inv.shipToPostalCode);
  str('shipToCountry', inv.shipToCountry);

  // Monetary totals
  flt('lineExtensionAmount', inv.lineExtensionAmount);
  flt('taxBasisTotalAmount', inv.taxBasisTotalAmount);
  flt('taxTotalAmount', inv.taxTotalAmount);
  flt('grandTotalAmount', inv.grandTotalAmount);
  flt('duePayableAmount', inv.duePayableAmount);
  flt('prepaidAmount', inv.prepaidAmount);

  // Primary tax rate (first tax line)
  if (inv.taxes.length > 0) {
    const tx1 = inv.taxes[0];
    en('taxCategoryCode', TAX_CATEGORY_MAP, tx1.categoryCode);
    flt('taxRatePercent', tx1.ratePercent);
  }
  // Secondary tax rate (second tax line, e.g. reduced rate alongside standard)
  if (inv.taxes.length > 1) {
    const tx2 = inv.taxes[1];
    flt('taxRate2Percent', tx2.ratePercent);
    flt('taxAmount2', tx2.calculatedAmount);
  }

  // Payment
  en('paymentMeansCode', PAYMENT_MEANS_MAP, inv.paymentMeansCode);
  str('iban', inv.iban);
  str('bic', inv.bic);
  str('paymentReference', inv.paymentReference);

  // Line items — serialised to JSON string (Box has no array field type)
  if (inv.lineItems.length > 0) {
    meta['lineItems'] = JSON.stringify(inv.lineItems);
  }

  return meta;
}
