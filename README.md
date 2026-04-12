# ZUGFeRD / Factur-X Invoice Processor

A containerised web application and REST API for working with ZUGFeRD 2.x, Factur-X, and XRechnung invoice PDFs.

## Features

| Capability | Details |
|---|---|
| **Viewer** | Browser UI — drag-and-drop a PDF, see the rendered invoice alongside the original document |
| **EN16931 Validation** | Checks XMP metadata, `AFRelationship`, XML well-formedness, and required element presence |
| **Metadata extraction** | Parses all 60+ EN16931 fields from both CII (ZUGFeRD/Factur-X) and UBL (XRechnung) |
| **Box integration** | `POST /process` is called from Box automation with a file ID; downloads the existing PDF from Box, maps invoice fields to a Box metadata template, and optionally moves the file to a success or error folder |

Supported profiles: MINIMUM · BASIC WL · BASIC · EN 16931 · EXTENDED · XRechnung

---

## Architecture

```
browser / API client
        │
        ▼
  nginx (port 8080)
  ├── /           → static frontend (viewer UI)
  └── /api/*      → proxied to backend:3000
        │
        ▼
  Node.js / Express backend
  ├── POST /upload   — viewer: returns parsed invoice JSON + PDF base64
  └── POST /process  — Box automation: download → extract → map → apply metadata
        │
        ├── box-node-sdk (JWT auth)    — downloads existing file from Box
        ├── pdfdetach (poppler-utils)  — extracts embedded XML
        ├── invoice-extractor          — parses CII / UBL XML
        ├── metadata-mapper            — maps fields to Box template
        └── box-node-sdk               — applies metadata + optional folder routing
```

---

## Quick start

### Prerequisites

- Docker and Docker Compose
- A Box application configured for **JWT (Server) Authentication** ([Box documentation](https://developer.box.com/guides/authentication/jwt/))

### 1. Prepare the Box JWT config

Download the JWT configuration JSON from the Box Developer Console and place it in a `config/` directory at the project root:

```
ZUGFeRD/
└── config/
    └── mycompany.json   ← your Box JWT config file
```

The file must be readable by the container process (`chmod 644 config/mycompany.json`).

The `configKey` parameter in API calls is the filename stem — `mycompany` in the example above.

### 2. Start the stack

```bash
docker compose up --build
```

The viewer is available at `http://localhost:8080`.

---

## Using the application

### Browser viewer

1. Open `http://localhost:8080` in your browser.
2. Drag a ZUGFeRD / Factur-X / XRechnung PDF onto the drop zone, or click to browse.
3. The viewer splits into two panes:
   - **Left** — the original PDF rendered inline.
   - **Right** — parsed invoice data: EN16931 validation results, document header, seller/buyer, line items, tax breakdown, and totals. A **Download XML** button saves the embedded invoice XML.
4. Click **Upload another file** to go back.

The viewer is entirely browser-side after the initial upload; no Box credentials are required.

---

### Webservice (`POST /api/process`)

The webservice endpoint is designed to be called from **Box automation** using Box's standard webservice action. When a file event triggers the automation, Box passes the file ID to this endpoint — the PDF does not need to be uploaded again.

**What it does, step by step:**

1. Receives a Box file ID and connection parameters as a JSON (or form-encoded) POST.
2. Downloads the PDF from Box using the service account client.
3. Extracts the embedded ZUGFeRD / Factur-X / XRechnung XML using `pdfdetach`.
4. Parses all EN16931 invoice fields (CII and UBL formats are both supported).
5. Maps the parsed fields to a Box metadata template object, converting dates to RFC 3339 and resolving enum codes to their full option keys.
6. Applies the metadata to the existing Box file.
7. Optionally moves the file to a routing folder:
   - **Extraction succeeded** → moved to `targetFolder` (if provided), metadata applied.
   - **Extraction failed** (no XML, unsupported format, parse error) → moved to `errorFolder` (if provided), no metadata.
8. Returns a JSON response describing the outcome.

**curl example — success path:**

```bash
curl -X POST http://localhost:8080/api/process \
  -H "Content-Type: application/json" \
  -d '{"boxFileId":"1234567890","configKey":"mycompany","targetFolder":"123456789","errorFolder":"987654321"}'
```

**curl example — custom template key:**

```bash
curl -X POST http://localhost:8080/api/process \
  -H "Content-Type: application/json" \
  -d '{
    "boxFileId": "1234567890",
    "configKey": "mycompany",
    "targetFolder": "123456789",
    "errorFolder": "987654321",
    "metadataTemplateKey": "zugferd_invoice"
  }'
```

**JavaScript / fetch example:**

```js
const response = await fetch('http://localhost:8080/api/process', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    boxFileId: '1234567890',
    configKey: 'mycompany',
    targetFolder: '123456789',
    errorFolder: '987654321',
  }),
});
const result = await response.json();

if (result.success) {
  console.log('Metadata applied to Box file', result.boxFileId, 'with', Object.keys(result.metadata).length, 'fields');
} else {
  console.warn('Processing failed:', result.error);
}
```

**Python / requests example:**

```python
import requests

response = requests.post(
    'http://localhost:8080/api/process',
    json={
        'boxFileId': '1234567890',
        'configKey': 'mycompany',
        'targetFolder': '123456789',
        'errorFolder': '987654321',
    },
)

result = response.json()
print(result)
```

---

## API reference

### `POST /api/process`

Called from Box automation when a file event fires. Downloads the existing PDF from Box, extracts the embedded invoice XML, applies metadata to the file, and optionally moves it to a routing folder.

**Request** — `application/json` or `application/x-www-form-urlencoded`

| Field | Type | Required | Description |
|---|---|---|---|
| `boxFileId` | string | yes | ID of the PDF file already in Box |
| `configKey` | string | yes | Stem of the JWT config file in `config/` (e.g. `mycompany`) |
| `targetFolder` | string | no | Box folder ID to move the file to on success |
| `errorFolder` | string | no | Box folder ID to move the file to on failure |
| `metadataTemplateKey` | string | no | Box template key (default: `zugferd_invoice`) |

**Success response** `200`

```json
{
  "success": true,
  "boxFileId": "1234567890",
  "folderId": "9876543210",
  "fileName": "invoice.pdf",
  "invoiceNumber": "RE-2024-0042",
  "metadata": {
    "invoiceNumber": "RE-2024-0042",
    "invoiceDate": "2024-03-15T00:00:00.000Z",
    "invoiceTypeCode": "380 - Commercial Invoice",
    "zugferdProfile": "EN16931",
    "grandTotalAmount": 119.00,
    "lineItems": "[{\"lineId\":\"1\", ...}]",
    "..."
  }
}
```

`folderId` is omitted from the response when no `targetFolder` was supplied.

**Error response** `200` — file moved to `errorFolder` (if provided)

```json
{
  "success": false,
  "error": "No EN16931-compliant XML attachment found.",
  "boxFileId": "1234567890",
  "folderId": "1111111111",
  "fileName": "invoice.pdf"
}
```

**Error response** `400` — bad parameters, Box config not found, or download failure

```json
{
  "success": false,
  "error": "Box config file not found: /app/config/mycompany.json"
}
```

**Example — curl**

```bash
curl -X POST http://localhost:8080/api/process \
  -H "Content-Type: application/json" \
  -d '{
    "boxFileId": "1234567890",
    "configKey": "mycompany",
    "targetFolder": "987654321",
    "errorFolder": "111111111",
    "metadataTemplateKey": "zugferd_invoice"
  }'
```

---

### `POST /api/upload`

Viewer endpoint. Extracts the XML, validates it, and returns everything needed to render the viewer UI. Does **not** interact with Box.

**Request** — `multipart/form-data`: `pdf` file

**Response** — see `UploadSuccess` / `UploadError` in [server.ts](backend/src/server.ts)

---

## Box metadata template

The default template key is `zugferd_invoice`. It must be created in your Box enterprise before use. The full template definition (scope, fields, enum options) is reproduced below — paste it into the Box Admin Console or deploy it via the Box Metadata Templates API.

<details>
<summary>Template JSON</summary>

```json
{
  "scope": "enterprise",
  "templateKey": "zugferd_invoice",
  "displayName": "ZUGFeRD Invoice (EN16931)",
  "hidden": false,
  "copyInstanceOnItemCopy": false,
  "fields": [
    { "type": "string", "key": "invoiceNumber",           "displayName": "Invoice Number" },
    { "type": "date",   "key": "invoiceDate",             "displayName": "Invoice Date" },
    { "type": "enum",   "key": "invoiceTypeCode",         "displayName": "Invoice Type",
      "options": [
        { "key": "380 - Commercial Invoice" }, { "key": "381 - Credit Note" },
        { "key": "384 - Corrected Invoice" },  { "key": "389 - Self-Billed Invoice" }
      ]
    },
    { "type": "string", "key": "documentName",            "displayName": "Document Name" },
    { "type": "enum",   "key": "zugferdProfile",          "displayName": "ZUGFeRD Profile",
      "options": [
        { "key": "MINIMUM" }, { "key": "BASIC WL" }, { "key": "BASIC" },
        { "key": "EN16931" }, { "key": "EXTENDED" }, { "key": "XRECHNUNG" }
      ]
    },
    { "type": "string", "key": "currencyCode",            "displayName": "Currency Code" },
    { "type": "string", "key": "taxCurrencyCode",         "displayName": "Tax Currency Code" },
    { "type": "date",   "key": "dueDate",                 "displayName": "Due Date" },
    { "type": "string", "key": "paymentTerms",            "displayName": "Payment Terms" },
    { "type": "string", "key": "notes",                   "displayName": "Invoice Notes" },
    { "type": "string", "key": "buyerOrderReference",     "displayName": "Buyer Order Reference" },
    { "type": "string", "key": "sellerOrderReference",    "displayName": "Seller Order Reference" },
    { "type": "string", "key": "contractReference",       "displayName": "Contract Reference" },
    { "type": "string", "key": "projectReference",        "displayName": "Project Reference" },
    { "type": "date",   "key": "deliveryDate",            "displayName": "Delivery Date" },
    { "type": "string", "key": "deliveryNoteReference",   "displayName": "Delivery Note Reference" },
    { "type": "string", "key": "referencedInvoiceNumber", "displayName": "Referenced Invoice Number" },
    { "type": "date",   "key": "referencedInvoiceDate",   "displayName": "Referenced Invoice Date" },
    { "type": "string", "key": "accountingReference",     "displayName": "Accounting Reference" },
    { "type": "string", "key": "sellerName",              "displayName": "Seller Name" },
    { "type": "string", "key": "sellerGlobalId",          "displayName": "Seller Global ID (GLN etc.)" },
    { "type": "string", "key": "sellerStreet",            "displayName": "Seller Street" },
    { "type": "string", "key": "sellerCity",              "displayName": "Seller City" },
    { "type": "string", "key": "sellerPostalCode",        "displayName": "Seller Postal Code" },
    { "type": "string", "key": "sellerCountry",           "displayName": "Seller Country Code" },
    { "type": "string", "key": "sellerVatId",             "displayName": "Seller VAT ID" },
    { "type": "string", "key": "sellerTaxNumber",         "displayName": "Seller Tax Number" },
    { "type": "string", "key": "sellerContactName",       "displayName": "Seller Contact Name" },
    { "type": "string", "key": "sellerContactEmail",      "displayName": "Seller Contact Email" },
    { "type": "string", "key": "sellerContactPhone",      "displayName": "Seller Contact Phone" },
    { "type": "string", "key": "buyerName",               "displayName": "Buyer Name" },
    { "type": "string", "key": "buyerGlobalId",           "displayName": "Buyer Global ID (GLN etc.)" },
    { "type": "string", "key": "buyerStreet",             "displayName": "Buyer Street" },
    { "type": "string", "key": "buyerCity",               "displayName": "Buyer City" },
    { "type": "string", "key": "buyerPostalCode",         "displayName": "Buyer Postal Code" },
    { "type": "string", "key": "buyerCountry",            "displayName": "Buyer Country Code" },
    { "type": "string", "key": "buyerVatId",              "displayName": "Buyer VAT ID" },
    { "type": "string", "key": "buyerReference",          "displayName": "Buyer Reference (Leitweg-ID)" },
    { "type": "string", "key": "buyerContactName",        "displayName": "Buyer Contact Name" },
    { "type": "string", "key": "buyerContactEmail",       "displayName": "Buyer Contact Email" },
    { "type": "string", "key": "shipToName",              "displayName": "Ship-To Name" },
    { "type": "string", "key": "shipToStreet",            "displayName": "Ship-To Street" },
    { "type": "string", "key": "shipToCity",              "displayName": "Ship-To City" },
    { "type": "string", "key": "shipToPostalCode",        "displayName": "Ship-To Postal Code" },
    { "type": "string", "key": "shipToCountry",           "displayName": "Ship-To Country Code" },
    { "type": "float",  "key": "lineExtensionAmount",     "displayName": "Sum of Line Net Amounts" },
    { "type": "float",  "key": "taxBasisTotalAmount",     "displayName": "Tax Basis Total Amount" },
    { "type": "float",  "key": "taxTotalAmount",          "displayName": "VAT Total Amount" },
    { "type": "float",  "key": "grandTotalAmount",        "displayName": "Grand Total Amount (Gross)" },
    { "type": "float",  "key": "duePayableAmount",        "displayName": "Amount Due for Payment" },
    { "type": "float",  "key": "prepaidAmount",           "displayName": "Prepaid Amount" },
    { "type": "enum",   "key": "taxCategoryCode",         "displayName": "Tax Category Code",
      "options": [
        { "key": "S - Standard rate" }, { "key": "Z - Zero rated" }, { "key": "E - Exempt" },
        { "key": "AE - Reverse charge" }, { "key": "K - Intra-EU" }, { "key": "G - Export" },
        { "key": "O - Outside scope" }, { "key": "L - IGIC (Canary Islands)" },
        { "key": "M - IPSI (Ceuta/Melilla)" }
      ]
    },
    { "type": "float",  "key": "taxRatePercent",          "displayName": "Tax Rate (%)" },
    { "type": "float",  "key": "taxRate2Percent",         "displayName": "Tax Rate 2 (%)" },
    { "type": "float",  "key": "taxAmount2",              "displayName": "VAT Amount 2" },
    { "type": "enum",   "key": "paymentMeansCode",        "displayName": "Payment Means",
      "options": [
        { "key": "10 - Cash" }, { "key": "30 - Credit Transfer" }, { "key": "48 - Bank Card" },
        { "key": "58 - SEPA Credit Transfer" }, { "key": "59 - SEPA Direct Debit" }
      ]
    },
    { "type": "string", "key": "iban",                    "displayName": "IBAN" },
    { "type": "string", "key": "bic",                     "displayName": "BIC / SWIFT" },
    { "type": "string", "key": "paymentReference",        "displayName": "Payment Reference" },
    { "type": "string", "key": "lineItems",               "displayName": "Line Items (JSON)" }
  ]
}
```

</details>

### `lineItems` format

Line items are serialised as a JSON array in the `lineItems` string field:

```json
[
  {
    "lineId": "1",
    "productName": "Gelierzucker Extra 250g",
    "sellerProductId": "4711",
    "globalProductId": "1234",
    "billedQuantity": 2,
    "unitCode": "PCE",
    "grossUnitPrice": 5.00,
    "netUnitPrice": 5.00,
    "lineTotalAmount": 10.00,
    "taxRatePercent": 19,
    "taxCategoryCode": "S"
  }
]
```

---

## Field mapping

### CII (ZUGFeRD / Factur-X)

| Template field | CII XPath |
|---|---|
| `invoiceNumber` | `ExchangedDocument/ID` |
| `invoiceDate` | `ExchangedDocument/IssueDateTime/DateTimeString` |
| `typeCode` | `ExchangedDocument/TypeCode` |
| `profileUri` | `ExchangedDocumentContext/GuidelineSpecifiedDocumentContextParameter/ID` |
| `notes` | `ExchangedDocument/IncludedNote/Content` |
| `buyerOrderReference` | `ApplicableHeaderTradeAgreement/BuyerOrderReferencedDocument/IssuerAssignedID` |
| `sellerOrderReference` | `ApplicableHeaderTradeAgreement/SellerOrderReferencedDocument/IssuerAssignedID` |
| `contractReference` | `ApplicableHeaderTradeAgreement/ContractReferencedDocument/IssuerAssignedID` |
| `projectReference` | `ApplicableHeaderTradeAgreement/SpecifiedProcuringProject/ID` |
| `deliveryNoteReference` | `AdditionalReferencedDocument[TypeCode=916]/IssuerAssignedID` |
| `accountingReference` | `ReceivableSpecifiedTradeAccountingAccount/ID` |
| `referencedInvoiceNumber` | `InvoiceReferencedDocument/IssuerAssignedID` |
| `deliveryDate` | `ActualDeliverySupplyChainEvent/OccurrenceDateTime/DateTimeString` |
| `dueDate` | `SpecifiedTradePaymentTerms/DueDateDateTime/DateTimeString` |
| `paymentMeansCode` | `SpecifiedTradeSettlementPaymentMeans/TypeCode` |
| `iban` | `PayeePartyCreditorFinancialAccount/IBANID` |
| `bic` | `PayeeSpecifiedCreditorFinancialInstitution/BICID` |
| Seller address | `SellerTradeParty/PostalTradeAddress` |
| Seller contact | `SellerTradeParty/DefinedTradeContact` |
| Seller VAT ID | `SpecifiedTaxRegistration[schemeID=VA]/ID` |
| Seller tax number | `SpecifiedTaxRegistration[schemeID=FC]/ID` |

### UBL (XRechnung)

Equivalent fields are extracted from `AccountingSupplierParty`, `AccountingCustomerParty`, `PaymentMeans`, `LegalMonetaryTotal`, `TaxSubtotal`, `InvoiceLine`, etc.

---

## Project structure

```
ZUGFeRD/
├── config/                        ← Box JWT config files (not committed)
│   └── <configKey>.json
├── backend/
│   ├── src/
│   │   ├── server.ts              ← Express app, /process and /upload routes
│   │   ├── invoice-extractor.ts   ← CII + UBL field extraction
│   │   ├── metadata-mapper.ts     ← Invoice → Box metadata object
│   │   └── box-client.ts          ← Box SDK wrapper (JWT auth, download, move, metadata)
│   ├── Dockerfile
│   ├── package.json
│   └── tsconfig.json
├── frontend/
│   ├── src/app.ts                 ← Browser viewer (parse + render invoice)
│   ├── public/                    ← index.html, style.css
│   ├── Dockerfile
│   └── nginx.conf                 ← Proxies /api/* → backend:3000
├── docker-compose.yml
└── README.md
```

---

## Development

```bash
# Backend (watch mode)
cd backend && npm install && npx tsc --watch

# Frontend (watch mode)
cd frontend && npm install && npx tsc --watch

# Or build and run everything with Docker
docker compose up --build
```

The backend requires `pdfdetach` (part of poppler-utils). On macOS: `brew install poppler`. The Docker image installs it automatically.

---

## Security notes

- JWT config files contain private keys. Never commit them to version control. Add `config/` to `.gitignore`.
- The container mounts `./config` read-only (`ro`). The `node` user inside the container only needs read access to the files.
- The `/upload` viewer endpoint caps file size at 50 MB (enforced by both multer and nginx). The `/process` endpoint has no local size cap — the file is streamed directly from Box.
