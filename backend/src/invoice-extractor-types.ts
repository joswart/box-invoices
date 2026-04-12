import { DOMParser } from '@xmldom/xmldom';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type N = any;

// ---------------------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------------------

/** First descendant element with the given localName */
export function find(node: N, localName: string): N {
  if (!node) return null;
  const els = node.getElementsByTagName('*');
  for (let i = 0; i < els.length; i++) {
    if (els[i].localName === localName) return els[i];
  }
  return null;
}

/** All descendant elements with the given localName */
export function findAll(node: N, localName: string): N[] {
  if (!node) return [];
  const result: N[] = [];
  const els = node.getElementsByTagName('*');
  for (let i = 0; i < els.length; i++) {
    if (els[i].localName === localName) result.push(els[i]);
  }
  return result;
}

/** Text content of first descendant with the given localName */
export function t(node: N, localName: string): string {
  return find(node, localName)?.textContent?.trim() ?? '';
}

/** Text content of a direct child element */
export function ct(node: N, localName: string): string {
  if (!node?.childNodes) return '';
  for (let i = 0; i < node.childNodes.length; i++) {
    const c = node.childNodes[i];
    if (c.nodeType === 1 && c.localName === localName) return c.textContent?.trim() ?? '';
  }
  return '';
}

/** Parse a string to number, returns null when empty/NaN */
export function num(s: string): number | null {
  if (!s) return null;
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

/** Parse an XML string and return the document, stripping BOM if present */
export function parseXmlDoc(xmlString: string): N {
  const parser = new DOMParser();
  return parser.parseFromString(xmlString.replace(/^\uFEFF/, ''), 'text/xml');
}

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

export interface LineItemData {
  lineId: string;
  productName: string;
  sellerProductId: string;
  globalProductId: string;
  billedQuantity: number | null;
  unitCode: string;
  grossUnitPrice: number | null;
  netUnitPrice: number | null;
  lineTotalAmount: number | null;
  taxRatePercent: number | null;
  taxCategoryCode: string;
}

export interface TaxLineData {
  categoryCode: string;
  ratePercent: number | null;
  basisAmount: number | null;
  calculatedAmount: number | null;
}

export interface ExtractedInvoice {
  format: 'CII' | 'UBL' | 'FacturaE' | 'KSeF';

  // Document header
  invoiceNumber: string;
  /** Raw date string: YYYYMMDD (CII) or YYYY-MM-DD (UBL) */
  invoiceDate: string;
  typeCode: string;
  documentName: string;
  profileUri: string;
  notes: string;

  // Document references
  buyerOrderReference: string;
  sellerOrderReference: string;
  contractReference: string;
  projectReference: string;
  deliveryNoteReference: string;
  accountingReference: string;
  referencedInvoiceNumber: string;
  referencedInvoiceDate: string;

  // Currency
  currencyCode: string;
  taxCurrencyCode: string;

  // Dates (same raw formats as invoiceDate)
  dueDate: string;
  deliveryDate: string;

  // Payment
  paymentTerms: string;
  paymentMeansCode: string;
  iban: string;
  bic: string;
  paymentReference: string;

  // Seller
  sellerName: string;
  sellerGlobalId: string;
  sellerStreet: string;
  sellerCity: string;
  sellerPostalCode: string;
  sellerCountry: string;
  sellerVatId: string;
  sellerTaxNumber: string;
  sellerContactName: string;
  sellerContactEmail: string;
  sellerContactPhone: string;

  // Buyer
  buyerName: string;
  buyerGlobalId: string;
  buyerStreet: string;
  buyerCity: string;
  buyerPostalCode: string;
  buyerCountry: string;
  buyerVatId: string;
  buyerReference: string;
  buyerContactName: string;
  buyerContactEmail: string;

  // Ship-to
  shipToName: string;
  shipToStreet: string;
  shipToCity: string;
  shipToPostalCode: string;
  shipToCountry: string;

  // Monetary totals
  lineExtensionAmount: number | null;
  taxBasisTotalAmount: number | null;
  taxTotalAmount: number | null;
  grandTotalAmount: number | null;
  duePayableAmount: number | null;
  prepaidAmount: number | null;

  taxes: TaxLineData[];
  lineItems: LineItemData[];
}

// ---------------------------------------------------------------------------
// Shared party helpers
// ---------------------------------------------------------------------------

export interface PartyInfo {
  name: string;
  globalId: string;
  street: string;
  city: string;
  postalCode: string;
  country: string;
  vatId: string;
  taxNumber: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
}

export function emptyParty(): PartyInfo {
  return {
    name: '', globalId: '', street: '', city: '', postalCode: '', country: '',
    vatId: '', taxNumber: '', contactName: '', contactEmail: '', contactPhone: '',
  };
}
