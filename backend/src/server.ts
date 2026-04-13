import express, { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { promisify } from 'util';
import { extractInvoice } from './invoice-extractor';
import { mapToBoxMetadata } from './metadata-mapper';
import { createBoxClient, downloadFileFromBox, moveFileInBox, applyMetadataToFile } from './box-client';
import {
  XMPInfo,
  ValidationResult,
  extractRawXMP,
  parseXMPInfo,
  extractAFRelationship,
  validateXMLStructure,
  isSupportedFormat,
  findXmlAttachment,
  VALID_AF_RELATIONSHIPS,
} from './validator';

const execAsync = promisify(exec);
const app = express();

// ---------------------------------------------------------------------------
// Multer setup
// ---------------------------------------------------------------------------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const isPdf = file.mimetype === 'application/pdf' || file.originalname.endsWith('.pdf');
    const isXml = file.mimetype === 'application/xml' || file.mimetype === 'text/xml' || file.originalname.endsWith('.xml');
    if (isPdf || isXml) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF and XML files are accepted'));
    }
  },
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// Re-export for API consumers that import from server
export type { XMPInfo, ValidationResult };

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

// ---------------------------------------------------------------------------
// /process — extract ZUGFeRD XML, write Box metadata, route to folder
//
// Called from Box automation: the document already lives in Box.
// The request body supplies the Box file ID; this service downloads the PDF,
// extracts the embedded invoice XML, applies metadata, and optionally moves
// the file to a target or error folder.
// ---------------------------------------------------------------------------

app.post(
  '/process',
  express.json({ type: ['application/json', 'text/plain', '*/*'] }),
  express.urlencoded({ extended: false }),
  async (req: Request, res: Response<ProcessResponse>): Promise<void> => {
    const body = req.body as {
      boxFileId?: string;
      metadataTemplateKey?: string;
      configKey?: string;
      targetFolder?: string;
      errorFolder?: string;
      source?: { type?: string; id?: string };
    };
    const query = req.query as Record<string, string | undefined>;

    // Support static config via query params (for Box webhook URL configuration)
    const configKey = body.configKey ?? query.configKey;
    const metadataTemplateKey = body.metadataTemplateKey ?? query.metadataTemplateKey;
    const targetFolder = body.targetFolder ?? query.targetFolder;
    const errorFolder = body.errorFolder ?? query.errorFolder;

    // Support Box webhook payload format: file ID is in body.source.id
    const boxFileId = body.boxFileId ?? (body.source?.type === 'file' ? body.source.id : undefined);

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
// /upload — viewer endpoint
// ---------------------------------------------------------------------------

app.post(
  '/upload',
  upload.single('pdf'),
  async (req: Request, res: Response<UploadResponse>) => {
    if (!req.file) {
      res.status(400).json({ success: false, error: 'No file uploaded.' });
      return;
    }

    const isXmlUpload =
      req.file.originalname.toLowerCase().endsWith('.xml') ||
      req.file.mimetype === 'application/xml' ||
      req.file.mimetype === 'text/xml';

    // Direct XML upload path (FacturaE, KSeF, standalone PEPPOL, etc.)
    if (isXmlUpload) {
      const xmlContent = req.file.buffer.toString('utf-8').replace(/^\uFEFF/, '');

      if (!isSupportedFormat(xmlContent)) {
        res.json({
          success: false,
          error:
            'Unsupported XML format. Expected CrossIndustryInvoice (ZUGFeRD/Factur-X), ' +
            'UBL Invoice/CreditNote (XRechnung/PEPPOL), FacturaE (Spain), or KSeF Faktura (Poland).',
        });
        return;
      }

      const structure = validateXMLStructure(xmlContent);
      const validation: ValidationResult = {
        xmp: null,
        xmpFileNameMatch: false,
        afRelationship: null,
        afRelationshipValid: false,
        ...structure,
        valid: structure.wellFormed && structure.structureErrors.length === 0,
      };

      res.json({
        success: true,
        pdfBase64: '',
        xml: xmlContent,
        attachmentName: req.file.originalname,
        validation,
      });
      return;
    }

    // PDF upload path — extract embedded XML via pdfdetach
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zugferd-'));
    const pdfPath = path.join(tmpDir, 'invoice.pdf');
    const attachDir = path.join(tmpDir, 'attachments');
    fs.mkdirSync(attachDir);

    try {
      fs.writeFileSync(pdfPath, req.file.buffer);

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
            : `No supported XML attachment found. Embedded files: ${files.join(', ')}`;
        res.json({ success: false, error: detail });
        return;
      }

      const rawXMP = extractRawXMP(req.file.buffer);
      const xmp = rawXMP ? parseXMPInfo(rawXMP) : null;

      const afRelationship = extractAFRelationship(req.file.buffer);
      const afRelationshipValid =
        afRelationship !== null && VALID_AF_RELATIONSHIPS.has(afRelationship);

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
