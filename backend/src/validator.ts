import fs from 'fs';
import path from 'path';
import { DOMParser } from '@xmldom/xmldom';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Well-known embedded-file names for ZUGFeRD / Factur-X / XRechnung and national formats */
export const KNOWN_NAMES: readonly string[] = [
  // ZUGFeRD / Factur-X
  'factur-x.xml',
  'ZUGFeRD-invoice.xml',
  'zugferd-invoice.xml',
  'xrechnung.xml',
  'order-x.xml',
  'EN16931.xml',
  // PEPPOL / generic UBL
  'invoice.xml',
  'ubl-invoice.xml',
  // FacturaE (Spain)
  'facturae.xml',
  'factura.xml',
  // KSeF (Poland)
  'faktura.xml',
  'ksef.xml',
];

/** Namespace URIs that indicate a supported invoice format */
export const SUPPORTED_NAMESPACES: readonly string[] = [
  // CII — ZUGFeRD 2.x / Factur-X / XRechnung CII
  'urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100',
  // UBL 2.1 — XRechnung, PEPPOL BIS 3.0, national CIUS profiles (RO, PT, HR, RS, SK, …)
  'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2',
  'urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2',
  // FacturaE 3.2.x — Spain
  'http://www.facturae.gob.es/formato/Version3.2/Facturae_v3.2.2.xsd',
  'http://www.facturae.gob.es/formato/Version3.2/Facturae_v3.2.1.xsd',
  'http://www.facturae.gob.es/formato/Version3.2/Facturae_v3.2.xsd',
  'http://www.facturae.es/Facturae/2009/v3.2/Facturae',
  // KSeF FA(2) / FA(3) — Poland
  'http://crd.gov.pl/wzor/2023/06/29/12648/',
  'http://crd.gov.pl/wzor/2021/11/29/11089/',
  'https://ksef.mf.gov.pl/schema/gtw/svc/online/types/v2',
];

/** XMP namespace URIs used by ZUGFeRD / Factur-X versions */
const ZUGFERD_XMP_NAMESPACES: readonly string[] = [
  'urn:ferd:pdfa:CrossIndustryDocument:invoice:1p0#',       // ZUGFeRD 1.0
  'urn:zugferd:pdfa:CrossIndustryDocument:invoice:2p0#',    // ZUGFeRD 2.0
  'urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#',   // ZUGFeRD 2.1 / Factur-X
];

/** AFRelationship values valid per spec */
export const VALID_AF_RELATIONSHIPS = new Set(['Alternative', 'Source']);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface XMPInfo {
  documentType: string;      // "INVOICE"
  fileName: string;          // "factur-x.xml"
  version: string;           // "1.0"
  conformanceLevel: string;  // "EN 16931"
  namespace: string;         // "urn:factur-x:..."
}

export interface ValidationResult {
  /** Parsed XMP metadata, null when the PDF has no ZUGFeRD XMP block */
  xmp: XMPInfo | null;
  /** XMP declares the same filename as the extracted attachment */
  xmpFileNameMatch: boolean;
  /** Value of /AFRelationship from the embedded-file dictionary */
  afRelationship: string | null;
  /** True when AFRelationship is "Alternative" or "Source" */
  afRelationshipValid: boolean;
  /** XML is well-formed */
  wellFormed: boolean;
  /** XML parse errors (only populated when wellFormed is false) */
  parseErrors: string[];
  /** Missing/invalid required elements per EN16931 */
  structureErrors: string[];
  /** Guideline profile URI from ExchangedDocumentContext */
  profileId: string;
  /** Overall: all checks passed */
  valid: boolean;
}

// ---------------------------------------------------------------------------
// 1. XMP metadata extraction
// ---------------------------------------------------------------------------

/**
 * Extract the raw XMP packet from PDF bytes by scanning for the xpacket marker.
 * PDF/A-3 XMP is always stored uncompressed, so a byte-level search is reliable.
 */
export function extractRawXMP(buf: Buffer): string | null {
  // Operate in latin1 so byte values survive round-trip; re-encode as UTF-8 afterwards
  const raw = buf.toString('latin1');
  const start = raw.indexOf('<?xpacket begin=');
  if (start === -1) return null;
  const endMarker = '<?xpacket end=';
  const endIdx = raw.lastIndexOf(endMarker);
  const end = endIdx !== -1 ? raw.indexOf('?>', endIdx) + 2 : raw.length;
  return Buffer.from(raw.slice(start, end), 'latin1').toString('utf-8');
}

export function parseXMPInfo(xmp: string): XMPInfo | null {
  let namespace: string | null = null;
  for (const ns of ZUGFERD_XMP_NAMESPACES) {
    if (xmp.includes(ns)) { namespace = ns; break; }
  }
  if (!namespace) return null;

  // Detect the namespace prefix bound to the ZUGFeRD schema
  const prefixMatch = xmp.match(/xmlns:(\w+)=["']urn:(?:ferd|zugferd|factur-x):pdfa:/);
  const prefix = prefixMatch?.[1] ?? 'fx';

  const extract = (field: string): string => {
    const m = xmp.match(new RegExp(`<${prefix}:${field}>([^<]*)</${prefix}:${field}>`));
    return m?.[1]?.trim() ?? '';
  };

  return {
    documentType: extract('DocumentType'),
    fileName: extract('DocumentFileName'),
    version: extract('Version'),
    conformanceLevel: extract('ConformanceLevel'),
    namespace,
  };
}

// ---------------------------------------------------------------------------
// 2. AFRelationship extraction
// ---------------------------------------------------------------------------

/**
 * Scan raw PDF bytes for the /AFRelationship key in embedded-file dictionaries.
 * Searches near each known ZUGFeRD filename first for accuracy.
 */
export function extractAFRelationship(buf: Buffer): string | null {
  const content = buf.toString('latin1');
  // Look within ±600 bytes of a known attachment filename
  for (const name of KNOWN_NAMES) {
    const idx = content.indexOf(name);
    if (idx === -1) continue;
    const window = content.slice(Math.max(0, idx - 600), idx + 600);
    const m = window.match(/\/AFRelationship\s*\/(\w+)/);
    if (m) return m[1];
  }
  // Fallback: first occurrence anywhere in the file
  const m = content.match(/\/AFRelationship\s*\/(\w+)/);
  return m?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// 3. XML structural validation
// ---------------------------------------------------------------------------

// xmldom returns its own node objects; we avoid importing browser DOM types
// by using a structural alias and treating nodes as `unknown` collections.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type XmlNode = any;

function findEl(node: XmlNode, localName: string): XmlNode {
  const all = node.getElementsByTagName('*');
  for (let i = 0; i < all.length; i++) {
    if (all[i].localName === localName) return all[i];
  }
  return null;
}

function childText(node: XmlNode, localName: string): string {
  return findEl(node, localName)?.textContent?.trim() ?? '';
}

interface StructureCheck {
  wellFormed: boolean;
  parseErrors: string[];
  structureErrors: string[];
  profileId: string;
}

export function validateXMLStructure(xmlContent: string): StructureCheck {
  const parseErrors: string[] = [];
  const structureErrors: string[] = [];

  // --- Well-formedness ---
  const parser = new DOMParser();
  // Strip BOM if present
  const doc = parser.parseFromString(xmlContent.replace(/^\uFEFF/, ''), 'text/xml');

  const errEls = doc.getElementsByTagName('parsererror');
  if (errEls.length > 0) {
    const msg = (errEls[0].textContent as string | null)?.trim().slice(0, 300) ?? 'XML parse error';
    parseErrors.push(msg);
    return { wellFormed: false, parseErrors, structureErrors, profileId: '' };
  }

  // --- Structural checks ---
  const root: XmlNode = doc.documentElement;
  const rootName: string = root?.localName ?? '';
  let profileId = '';

  if (rootName === 'CrossIndustryInvoice') {
    // CII mandatory elements
    for (const el of ['ExchangedDocumentContext', 'ExchangedDocument', 'SupplyChainTradeTransaction']) {
      if (!findEl(doc, el)) structureErrors.push(`Missing required element <${el}>`);
    }

    const exDoc = findEl(doc, 'ExchangedDocument');
    if (exDoc) {
      if (!childText(exDoc, 'ID')) {
        structureErrors.push('Missing invoice ID (ExchangedDocument > ID)');
      }
      if (!childText(exDoc, 'TypeCode')) {
        structureErrors.push('Missing document type code (ExchangedDocument > TypeCode)');
      }
    }

    if (!findEl(doc, 'SellerTradeParty')) structureErrors.push('Missing SellerTradeParty');
    if (!findEl(doc, 'BuyerTradeParty'))  structureErrors.push('Missing BuyerTradeParty');

    const settlement = findEl(doc, 'ApplicableHeaderTradeSettlement');
    if (!settlement || !childText(settlement, 'InvoiceCurrencyCode')) {
      structureErrors.push('Missing InvoiceCurrencyCode');
    }

    const ctxParam = findEl(doc, 'GuidelineSpecifiedDocumentContextParameter');
    if (ctxParam) {
      profileId = childText(ctxParam, 'ID');
      if (!profileId) structureErrors.push('Missing guideline profile ID in ExchangedDocumentContext');
    } else {
      structureErrors.push('Missing GuidelineSpecifiedDocumentContextParameter');
    }

  } else if (rootName === 'Invoice' || rootName === 'CreditNote') {
    // UBL mandatory elements
    for (const el of [
      'ID', 'IssueDate',
      'AccountingSupplierParty', 'AccountingCustomerParty',
      'LegalMonetaryTotal',
    ]) {
      if (!findEl(doc, el)) structureErrors.push(`Missing required element <${el}>`);
    }
    if (!childText(doc, 'DocumentCurrencyCode')) {
      structureErrors.push('Missing DocumentCurrencyCode');
    }
    if (rootName === 'Invoice' && !childText(doc, 'InvoiceTypeCode')) {
      structureErrors.push('Missing InvoiceTypeCode');
    }
  } else if (rootName === 'Facturae') {
    // FacturaE mandatory elements
    if (!findEl(doc, 'Parties'))   structureErrors.push('Missing required element <Parties>');
    if (!findEl(doc, 'Invoices'))  structureErrors.push('Missing required element <Invoices>');
    if (!findEl(doc, 'SellerParty')) structureErrors.push('Missing SellerParty');
    if (!findEl(doc, 'BuyerParty'))  structureErrors.push('Missing BuyerParty');
    const feInvoice = findEl(doc, 'Invoice');
    if (!feInvoice) {
      structureErrors.push('No Invoice found in Facturae document');
    } else {
      if (!findEl(feInvoice, 'InvoiceHeader')) structureErrors.push('Missing InvoiceHeader');
      if (!findEl(feInvoice, 'InvoiceTotals')) structureErrors.push('Missing InvoiceTotals');
    }
    const fileHeader = findEl(doc, 'FileHeader');
    profileId = fileHeader ? `urn:facturae:${childText(fileHeader, 'SchemaVersion') || '3.2'}` : 'urn:facturae:3.2';

  } else if (rootName === 'Faktura') {
    // KSeF FA(2)/FA(3) mandatory elements
    const fa = findEl(doc, 'Fa');
    if (!fa) structureErrors.push('Missing required element <Fa>');
    if (!findEl(doc, 'Podmiot1')) structureErrors.push('Missing seller data (Podmiot1)');
    if (!findEl(doc, 'Podmiot2')) structureErrors.push('Missing buyer data (Podmiot2)');
    if (fa) {
      if (!childText(fa, 'P_1')) structureErrors.push('Missing invoice date (Fa/P_1)');
      if (!childText(fa, 'P_2')) structureErrors.push('Missing invoice number (Fa/P_2)');
      if (!childText(fa, 'P_15')) structureErrors.push('Missing total amount (Fa/P_15)');
    }
    const naglowek = findEl(doc, 'Naglowek');
    profileId = naglowek ? childText(naglowek, 'KodFormularza') : '';

  } else {
    structureErrors.push(
      `Unknown root element <${rootName}> — expected CrossIndustryInvoice, Invoice, CreditNote, Facturae, or Faktura`,
    );
  }

  return { wellFormed: true, parseErrors, structureErrors, profileId };
}

// ---------------------------------------------------------------------------
// 4. Helpers used by the /upload and /process routes
// ---------------------------------------------------------------------------

export function isSupportedFormat(xmlContent: string): boolean {
  return SUPPORTED_NAMESPACES.some((ns) => xmlContent.includes(ns));
}

export function findXmlAttachment(
  attachDir: string,
  files: string[],
): { name: string; content: string } | null {
  for (const name of KNOWN_NAMES) {
    if (files.includes(name)) {
      const content = fs.readFileSync(path.join(attachDir, name), 'utf-8');
      if (isSupportedFormat(content)) return { name, content };
    }
  }
  for (const file of files) {
    if (file.toLowerCase().endsWith('.xml')) {
      const content = fs.readFileSync(path.join(attachDir, file), 'utf-8');
      if (isSupportedFormat(content)) return { name: file, content };
    }
  }
  return null;
}
