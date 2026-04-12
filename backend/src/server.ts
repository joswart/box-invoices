import express, { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { promisify } from 'util';
import { DOMParser } from '@xmldom/xmldom';
import { extractInvoice } from './invoice-extractor';
import { mapToBoxMetadata } from './metadata-mapper';
import { createBoxClient, downloadFileFromBox, moveFileInBox, applyMetadataToFile } from './box-client';

const execAsync = promisify(exec);
const app = express();

// ---------------------------------------------------------------------------
// Multer setup
// ---------------------------------------------------------------------------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'application/pdf' || file.originalname.endsWith('.pdf')) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are accepted'));
    }
  },
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Well-known embedded-file names for ZUGFeRD / Factur-X / XRechnung */
const KNOWN_NAMES: readonly string[] = [
  'factur-x.xml',
  'ZUGFeRD-invoice.xml',
  'zugferd-invoice.xml',
  'xrechnung.xml',
  'order-x.xml',
  'EN16931.xml',
];

/** Namespace URIs that indicate an EN16931-compliant document */
const EN16931_NAMESPACES: readonly string[] = [
  'urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100',
  'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2',
  'urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2',
];

/** XMP namespace URIs used by ZUGFeRD / Factur-X versions */
const ZUGFERD_XMP_NAMESPACES: readonly string[] = [
  'urn:ferd:pdfa:CrossIndustryDocument:invoice:1p0#',       // ZUGFeRD 1.0
  'urn:zugferd:pdfa:CrossIndustryDocument:invoice:2p0#',    // ZUGFeRD 2.0
  'urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#',   // ZUGFeRD 2.1 / Factur-X
];

/** AFRelationship values valid per spec */
const VALID_AF_RELATIONSHIPS = new Set(['Alternative', 'Source']);

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

interface UploadSuccess {
  success: true;
  pdfBase64: string;
  xml: string;
  attachmentName: string;
  validation: ValidationResult;
}

interface UploadError {
  success: false;
  error: string;
}

type UploadResponse = UploadSuccess | UploadError;

// ---------------------------------------------------------------------------
// 1. XMP metadata extraction
// ---------------------------------------------------------------------------

/**
 * Extract the raw XMP packet from PDF bytes by scanning for the xpacket marker.
 * PDF/A-3 XMP is always stored uncompressed, so a byte-level search is reliable.
 */
function extractRawXMP(buf: Buffer): string | null {
  // Operate in latin1 so byte values survive round-trip; re-encode as UTF-8 afterwards
  const raw = buf.toString('latin1');
  const start = raw.indexOf('<?xpacket begin=');
  if (start === -1) return null;
  const endMarker = '<?xpacket end=';
  const endIdx = raw.lastIndexOf(endMarker);
  const end = endIdx !== -1 ? raw.indexOf('?>', endIdx) + 2 : raw.length;
  return Buffer.from(raw.slice(start, end), 'latin1').toString('utf-8');
}

function parseXMPInfo(xmp: string): XMPInfo | null {
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
function extractAFRelationship(buf: Buffer): string | null {
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

function validateXMLStructure(xmlContent: string): StructureCheck {
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

    // Invoice ID lives inside ExchangedDocument, not the context
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

    // Profile ID from guideline context
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
  } else {
    structureErrors.push(
      `Unknown root element <${rootName}> — expected CrossIndustryInvoice, Invoice, or CreditNote`,
    );
  }

  return { wellFormed: true, parseErrors, structureErrors, profileId };
}

// ---------------------------------------------------------------------------
// Existing helpers
// ---------------------------------------------------------------------------

function isEN16931(xmlContent: string): boolean {
  return EN16931_NAMESPACES.some((ns) => xmlContent.includes(ns));
}

function findXmlAttachment(
  attachDir: string,
  files: string[],
): { name: string; content: string } | null {
  for (const name of KNOWN_NAMES) {
    if (files.includes(name)) {
      const content = fs.readFileSync(path.join(attachDir, name), 'utf-8');
      if (isEN16931(content)) return { name, content };
    }
  }
  for (const file of files) {
    if (file.toLowerCase().endsWith('.xml')) {
      const content = fs.readFileSync(path.join(attachDir, file), 'utf-8');
      if (isEN16931(content)) return { name: file, content };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// /process — extract ZUGFeRD XML, write Box metadata, route to folder
//
// Called from Box automation: the document already lives in Box.
// The request body supplies the Box file ID; this service downloads the PDF,
// extracts the embedded invoice XML, applies metadata, and optionally moves
// the file to a target or error folder.
// ---------------------------------------------------------------------------

interface ProcessSuccess {
  success: true;
  boxFileId: string;
  folderId?: string;
  fileName: string;
  invoiceNumber: string;
  metadata: Record<string, unknown>;
}

interface ProcessError {
  success: false;
  error: string;
  boxFileId?: string;
  folderId?: string;
  fileName?: string;
}

type ProcessResponse = ProcessSuccess | ProcessError;

app.post(
  '/process',
  express.json(),
  express.urlencoded({ extended: false }),
  async (req: Request, res: Response<ProcessResponse>): Promise<void> => {
    const { boxFileId, metadataTemplateKey, configKey, targetFolder, errorFolder } = req.body as {
      boxFileId?: string;
      metadataTemplateKey?: string;
      configKey?: string;
      targetFolder?: string;
      errorFolder?: string;
    };

    if (!boxFileId) {
      res.status(400).json({ success: false, error: 'boxFileId is required.' });
      return;
    }
    if (!configKey) {
      res.status(400).json({ success: false, error: 'configKey is required.' });
      return;
    }

    const templateKey = metadataTemplateKey ?? 'zugferd_invoice';

    // --- Initialise Box client ---
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let boxClient: any;
    try {
      boxClient = createBoxClient(configKey);
    } catch (err) {
      res.status(400).json({ success: false, error: String(err) });
      return;
    }

    // --- Download PDF from Box ---
    let pdfBuffer: Buffer;
    let filename: string;
    try {
      ({ buffer: pdfBuffer, filename } = await downloadFileFromBox(boxClient, boxFileId));
    } catch (err) {
      res.status(400).json({ success: false, error: `Failed to download file from Box: ${String(err)}`, boxFileId });
      return;
    }

    // --- Extract ZUGFeRD XML from PDF ---
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zugferd-'));
    const pdfPath = path.join(tmpDir, 'invoice.pdf');
    const attachDir = path.join(tmpDir, 'attachments');
    fs.mkdirSync(attachDir);

    try {
      fs.writeFileSync(pdfPath, pdfBuffer);

      try {
        await execAsync(`pdfdetach -saveall -o "${attachDir}" "${pdfPath}"`);
      } catch {
        // Non-zero exit when no attachments — handled below
      }

      const files = fs.existsSync(attachDir) ? fs.readdirSync(attachDir) : [];
      const xmlResult = findXmlAttachment(attachDir, files);

      if (!xmlResult) {
        const detail = files.length === 0
          ? 'This PDF contains no embedded attachments. A ZUGFeRD / Factur-X PDF must embed the invoice XML.'
          : `No EN16931-compliant XML attachment found. Embedded files: ${files.join(', ')}`;

        if (errorFolder) await moveFileInBox(boxClient, boxFileId, errorFolder);
        res.json({ success: false, error: detail, boxFileId, folderId: errorFolder, fileName: filename });
        return;
      }

      // --- Parse invoice fields ---
      let invoice;
      try {
        invoice = extractInvoice(xmlResult.content);
      } catch (err) {
        if (errorFolder) await moveFileInBox(boxClient, boxFileId, errorFolder);
        res.json({
          success: false,
          error: `Invoice XML could not be parsed: ${String(err)}`,
          boxFileId,
          folderId: errorFolder,
          fileName: filename,
        });
        return;
      }

      // --- Map to Box metadata and apply to the existing file ---
      const metadata = mapToBoxMetadata(invoice);
      await applyMetadataToFile(boxClient, boxFileId, templateKey, metadata);

      if (targetFolder) await moveFileInBox(boxClient, boxFileId, targetFolder);

      res.json({
        success: true,
        boxFileId,
        folderId: targetFolder,
        fileName: filename,
        invoiceNumber: invoice.invoiceNumber,
        metadata,
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  },
);

// ---------------------------------------------------------------------------
// /upload — viewer endpoint (unchanged)
// ---------------------------------------------------------------------------

app.post(
  '/upload',
  upload.single('pdf'),
  async (req: Request, res: Response<UploadResponse>) => {
    if (!req.file) {
      res.status(400).json({ success: false, error: 'No PDF file uploaded.' });
      return;
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zugferd-'));
    const pdfPath = path.join(tmpDir, 'invoice.pdf');
    const attachDir = path.join(tmpDir, 'attachments');
    fs.mkdirSync(attachDir);

    try {
      fs.writeFileSync(pdfPath, req.file.buffer);

      // --- Extract attachments ---
      try {
        await execAsync(`pdfdetach -saveall -o "${attachDir}" "${pdfPath}"`);
      } catch {
        // Non-zero exit when no attachments — handled below
      }

      const files = fs.existsSync(attachDir) ? fs.readdirSync(attachDir) : [];
      const result = findXmlAttachment(attachDir, files);

      if (!result) {
        const detail =
          files.length === 0
            ? 'This PDF contains no embedded attachments. A ZUGFeRD / Factur-X PDF must embed the invoice XML.'
            : `No EN16931-compliant XML attachment found. Embedded files: ${files.join(', ')}`;
        res.json({ success: false, error: detail });
        return;
      }

      // --- 1. XMP ---
      const rawXMP = extractRawXMP(req.file.buffer);
      const xmp = rawXMP ? parseXMPInfo(rawXMP) : null;

      // --- 2. AFRelationship ---
      const afRelationship = extractAFRelationship(req.file.buffer);
      const afRelationshipValid =
        afRelationship !== null && VALID_AF_RELATIONSHIPS.has(afRelationship);

      // --- 3. XML structural validation ---
      const structure = validateXMLStructure(result.content);

      const validation: ValidationResult = {
        xmp,
        xmpFileNameMatch: xmp ? xmp.fileName === result.name : false,
        afRelationship,
        afRelationshipValid,
        ...structure,
        valid:
          structure.wellFormed &&
          structure.structureErrors.length === 0 &&
          afRelationshipValid,
      };

      res.json({
        success: true,
        pdfBase64: req.file.buffer.toString('base64'),
        xml: result.content,
        attachmentName: result.name,
        validation,
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  },
);

app.get('/health', (_req: Request, res: Response) => {
  res.json({ ok: true });
});

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  res.status(400).json({ success: false, error: err.message ?? 'Unknown error' });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT ?? '3000', 10);
app.listen(PORT, () => console.log(`Backend listening on :${PORT}`));
