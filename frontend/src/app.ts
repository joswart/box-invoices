// ============================================================
// Types
// ============================================================

interface XMPInfo {
  documentType: string;
  fileName: string;
  version: string;
  conformanceLevel: string;
  namespace: string;
}

interface ValidationResult {
  xmp: XMPInfo | null;
  xmpFileNameMatch: boolean;
  afRelationship: string | null;
  afRelationshipValid: boolean;
  wellFormed: boolean;
  parseErrors: string[];
  structureErrors: string[];
  profileId: string;
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

interface Address {
  name: string;
  street: string;
  city: string;
  postcode: string;
  country: string;
  taxId: string;
  vatId: string;
  email: string;
}

interface LineItem {
  position: string;
  description: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  total: string;
  taxRate: string;
}

interface TaxLine {
  category: string;
  rate: string;
  base: string;
  amount: string;
}

interface Invoice {
  format: 'CII' | 'UBL';
  id: string;
  type: string;
  issueDate: string;
  dueDate: string;
  currency: string;
  buyerReference: string;
  note: string;
  seller: Address;
  buyer: Address;
  items: LineItem[];
  taxes: TaxLine[];
  netTotal: string;
  taxTotal: string;
  grossTotal: string;
  prepaidAmount: string;
  duePayable: string;
}

// ============================================================
// XML helpers (works without namespace awareness)
// ============================================================

function first(node: Element | Document, localName: string): Element | null {
  const els = node.getElementsByTagName('*');
  for (let i = 0; i < els.length; i++) {
    if (els[i].localName === localName) return els[i];
  }
  return null;
}

function all(node: Element | Document, localName: string): Element[] {
  const result: Element[] = [];
  const els = node.getElementsByTagName('*');
  for (let i = 0; i < els.length; i++) {
    if (els[i].localName === localName) result.push(els[i]);
  }
  return result;
}

function text(node: Element | Document, localName: string): string {
  return first(node, localName)?.textContent?.trim() ?? '';
}

function attr(node: Element | Document, localName: string, attrName: string): string {
  return first(node, localName)?.getAttribute(attrName)?.trim() ?? '';
}

// ============================================================
// CII (Cross Industry Invoice) parser — ZUGFeRD / Factur-X
// ============================================================

function parseCII(doc: Document): Invoice {
  const trx = first(doc, 'SupplyChainTradeTransaction');
  const agreement = trx ? first(trx, 'ApplicableHeaderTradeAgreement') : null;
  const settlement = trx ? first(trx, 'ApplicableHeaderTradeSettlement') : null;
  const exDoc = first(doc, 'ExchangedDocument');

  function parseAddress(parent: Element | null): Address {
    if (!parent) return emptyAddress();
    const ta = first(parent, 'TradeAddress');
    const taxReg = all(parent, 'SpecifiedTaxRegistration');
    let taxId = '';
    let vatId = '';
    for (const tr of taxReg) {
      const id = text(tr, 'ID');
      const schemeId = first(tr, 'ID')?.getAttribute('schemeID') ?? '';
      if (schemeId === 'FC') taxId = id;
      else if (schemeId === 'VA') vatId = id;
      else if (!taxId) taxId = id;
    }
    return {
      name: text(parent, 'Name'),
      street: ta ? text(ta, 'LineOne') : '',
      city: ta ? text(ta, 'CityName') : '',
      postcode: ta ? text(ta, 'PostcodeCode') : '',
      country: ta ? text(ta, 'CountryID') : '',
      taxId,
      vatId,
      email: text(parent, 'URIID'),
    };
  }

  const sellerParent = agreement ? first(agreement, 'SellerTradeParty') : null;
  const buyerParent = agreement ? first(agreement, 'BuyerTradeParty') : null;

  // Line items
  const lineEls = trx ? all(trx, 'IncludedSupplyChainTradeLineItem') : [];
  const items: LineItem[] = lineEls.map((el, idx) => {
    const product = first(el, 'SpecifiedTradeProduct');
    const lineAgreement = first(el, 'SpecifiedLineTradeAgreement');
    const lineDelivery = first(el, 'SpecifiedLineTradeDelivery');
    const lineSettlement = first(el, 'SpecifiedLineTradeSettlement');
    const tax = lineSettlement ? first(lineSettlement, 'ApplicableTradeTax') : null;
    const summation = lineSettlement ? first(lineSettlement, 'SpecifiedTradeSettlementLineMonetarySummation') : null;
    return {
      position: text(el, 'LineID') || String(idx + 1),
      description: product ? (text(product, 'Name') || text(product, 'Description')) : '',
      quantity: lineDelivery ? text(lineDelivery, 'BilledQuantity') : '',
      unit: lineDelivery ? (attr(lineDelivery, 'BilledQuantity', 'unitCode') || '') : '',
      unitPrice: lineAgreement ? text(lineAgreement, 'ChargeAmount') : '',
      total: summation ? text(summation, 'LineTotalAmount') : '',
      taxRate: tax ? text(tax, 'RateApplicablePercent') : '',
    };
  });

  // Tax breakdown
  const taxEls = settlement ? all(settlement, 'ApplicableTradeTax') : [];
  const taxes: TaxLine[] = taxEls.map((el) => ({
    category: text(el, 'CategoryCode'),
    rate: text(el, 'RateApplicablePercent'),
    base: text(el, 'BasisAmount'),
    amount: text(el, 'CalculatedAmount'),
  }));

  // Summation
  const summation = settlement ? first(settlement, 'SpecifiedTradeSettlementHeaderMonetarySummation') : null;

  // Payment terms / due date
  const payTerms = settlement ? first(settlement, 'SpecifiedTradePaymentTerms') : null;

  // Invoice type code mapping
  const typeCode = exDoc ? text(exDoc, 'TypeCode') : '';

  return {
    format: 'CII',
    id: exDoc ? text(exDoc, 'ID') : '',
    type: invoiceTypeName(typeCode),
    issueDate: formatCIIDate(exDoc ? text(exDoc, 'DateTimeString') : ''),
    dueDate: payTerms ? formatCIIDate(text(payTerms, 'DateTimeString')) : '',
    currency: settlement ? text(settlement, 'InvoiceCurrencyCode') : '',
    buyerReference: agreement ? text(agreement, 'BuyerReference') : '',
    note: exDoc ? text(exDoc, 'Content') : '',
    seller: parseAddress(sellerParent),
    buyer: parseAddress(buyerParent),
    items,
    taxes,
    netTotal: summation ? text(summation, 'LineTotalAmount') : '',
    taxTotal: summation ? text(summation, 'TaxTotalAmount') : '',
    grossTotal: summation ? text(summation, 'GrandTotalAmount') : '',
    prepaidAmount: summation ? text(summation, 'TotalPrepaidAmount') : '',
    duePayable: summation ? text(summation, 'DuePayableAmount') : '',
  };
}

// ============================================================
// UBL (Universal Business Language) parser
// ============================================================

function parseUBL(doc: Document): Invoice {
  function parseAddress(parent: Element | null): Address {
    if (!parent) return emptyAddress();
    const party = first(parent, 'Party');
    if (!party) return emptyAddress();
    const postalAddr = first(party, 'PostalAddress');
    const taxScheme = first(party, 'PartyTaxScheme');
    const legalEntity = first(party, 'PartyLegalEntity');
    const contact = first(party, 'Contact');
    return {
      name: text(party, 'RegistrationName') || text(party, 'Name'),
      street: postalAddr ? text(postalAddr, 'StreetName') : '',
      city: postalAddr ? text(postalAddr, 'CityName') : '',
      postcode: postalAddr ? text(postalAddr, 'PostalZone') : '',
      country: postalAddr ? text(postalAddr, 'IdentificationCode') : '',
      taxId: legalEntity ? text(legalEntity, 'CompanyID') : '',
      vatId: taxScheme ? text(taxScheme, 'CompanyID') : '',
      email: contact ? text(contact, 'ElectronicMail') : '',
    };
  }

  // Line items
  const lineEls = all(doc, 'InvoiceLine').length
    ? all(doc, 'InvoiceLine')
    : all(doc, 'CreditNoteLine');

  const items: LineItem[] = lineEls.map((el, idx) => {
    const item = first(el, 'Item');
    const price = first(el, 'Price');
    const classTax = item ? first(item, 'ClassifiedTaxCategory') : null;
    return {
      position: text(el, 'ID') || String(idx + 1),
      description: item ? (text(item, 'Name') || text(item, 'Description')) : '',
      quantity: text(el, 'InvoicedQuantity') || text(el, 'CreditedQuantity'),
      unit:
        first(el, 'InvoicedQuantity')?.getAttribute('unitCode') ??
        first(el, 'CreditedQuantity')?.getAttribute('unitCode') ??
        '',
      unitPrice: price ? text(price, 'PriceAmount') : '',
      total: text(el, 'LineExtensionAmount'),
      taxRate: classTax ? text(classTax, 'Percent') : '',
    };
  });

  // Tax totals
  const taxTotals = all(doc, 'TaxSubtotal');
  const taxes: TaxLine[] = taxTotals.map((el) => {
    const cat = first(el, 'TaxCategory');
    return {
      category: cat ? text(cat, 'ID') : '',
      rate: cat ? text(cat, 'Percent') : '',
      base: text(el, 'TaxableAmount'),
      amount: text(el, 'TaxAmount'),
    };
  });

  const legalMonetary = first(doc, 'LegalMonetaryTotal');
  const typeCode = text(doc, 'InvoiceTypeCode');

  return {
    format: 'UBL',
    id: text(doc, 'ID'),
    type: invoiceTypeName(typeCode),
    issueDate: formatISODate(text(doc, 'IssueDate')),
    dueDate: formatISODate(text(doc, 'PaymentDueDate') || text(doc, 'DueDate')),
    currency: first(doc, 'DocumentCurrencyCode')?.textContent?.trim() ?? '',
    buyerReference: text(doc, 'BuyerReference'),
    note: text(doc, 'Note'),
    seller: parseAddress(first(doc, 'AccountingSupplierParty')),
    buyer: parseAddress(first(doc, 'AccountingCustomerParty')),
    items,
    taxes,
    netTotal: legalMonetary ? text(legalMonetary, 'LineExtensionAmount') : '',
    taxTotal: text(doc, 'TaxAmount'),
    grossTotal: legalMonetary ? text(legalMonetary, 'PayableAmount') : '',
    prepaidAmount: legalMonetary ? text(legalMonetary, 'PrepaidAmount') : '',
    duePayable: legalMonetary ? text(legalMonetary, 'PayableAmount') : '',
  };
}

// ============================================================
// Shared utilities
// ============================================================

function emptyAddress(): Address {
  return { name: '', street: '', city: '', postcode: '', country: '', taxId: '', vatId: '', email: '' };
}

function formatCIIDate(raw: string): string {
  // CII dates are typically YYYYMMDD
  if (!raw) return '';
  if (raw.length === 8) {
    return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  }
  return raw;
}

function formatISODate(raw: string): string {
  return raw; // UBL uses ISO 8601 already
}

function invoiceTypeName(code: string): string {
  const map: Record<string, string> = {
    '380': 'Commercial Invoice',
    '381': 'Credit Note',
    '384': 'Corrected Invoice',
    '386': 'Prepayment Invoice',
    '389': 'Self-Billed Invoice',
    '875': 'Partial Invoice',
    '376': 'Commission Note',
  };
  return code ? (map[code] ?? `Type ${code}`) : 'Invoice';
}

function parseInvoice(xmlString: string): Invoice {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlString, 'text/xml');
  const rootNs = doc.documentElement.namespaceURI ?? '';
  if (rootNs.includes('CrossIndustryInvoice') || doc.documentElement.localName === 'CrossIndustryInvoice') {
    return parseCII(doc);
  }
  return parseUBL(doc);
}

// ============================================================
// HTML rendering
// ============================================================

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmt(amount: string, currency: string): string {
  if (!amount) return '—';
  const n = parseFloat(amount);
  if (isNaN(n)) return esc(amount);
  try {
    return n.toLocaleString(undefined, {
      style: 'currency',
      currency: currency || 'EUR',
      minimumFractionDigits: 2,
    });
  } catch {
    return `${n.toFixed(2)} ${currency}`;
  }
}

function addressHtml(a: Address): string {
  const lines: string[] = [];
  if (a.name) lines.push(`<strong>${esc(a.name)}</strong>`);
  if (a.street) lines.push(esc(a.street));
  const cityLine = [a.postcode, a.city].filter(Boolean).join(' ');
  if (cityLine) lines.push(esc(cityLine));
  if (a.country) lines.push(esc(a.country));
  if (a.vatId) lines.push(`VAT: ${esc(a.vatId)}`);
  if (a.taxId && a.taxId !== a.vatId) lines.push(`Tax ID: ${esc(a.taxId)}`);
  if (a.email) lines.push(`<a href="mailto:${esc(a.email)}">${esc(a.email)}</a>`);
  return lines.join('<br>') || '—';
}

// ============================================================
// Validation section renderer
// ============================================================

function shortProfileName(uri: string): string {
  const map: Record<string, string> = {
    minimum: 'Minimum',
    basicwl: 'Basic WL',
    basic: 'Basic',
    en16931: 'EN 16931',
    extended: 'Extended',
    xrechnung_1: 'XRechnung 1.x',
    xrechnung_2: 'XRechnung 2.x',
    xrechnung_3: 'XRechnung 3.x',
  };
  // Last colon-separated segment
  const last = uri.split(':').pop()?.toLowerCase() ?? '';
  // Handle "xrechnung_2.3" style
  for (const [k, v] of Object.entries(map)) {
    if (last.startsWith(k)) return v;
  }
  return uri; // Return full URI if we can't shorten it
}

function check(pass: boolean, label: string, detail = ''): string {
  const cls = pass ? 'check-pass' : 'check-fail';
  const icon = pass
    ? `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" fill="#D1FAE5" stroke="#059669" stroke-width="1.5"/><path d="M4.5 8l2.5 2.5 4-4" stroke="#059669" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`
    : `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" fill="#FEE2E2" stroke="#DC2626" stroke-width="1.5"/><path d="M5.5 5.5l5 5M10.5 5.5l-5 5" stroke="#DC2626" stroke-width="1.5" stroke-linecap="round"/></svg>`;
  return `<div class="check-row ${cls}">${icon}<span>${esc(label)}${detail ? `<span class="check-detail">${esc(detail)}</span>` : ''}</span></div>`;
}

function warn(label: string, detail = ''): string {
  const icon = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 2L14.5 13H1.5L8 2z" fill="#FEF3C7" stroke="#D97706" stroke-width="1.5" stroke-linejoin="round"/><path d="M8 6v3.5M8 11.5h.01" stroke="#D97706" stroke-width="1.5" stroke-linecap="round"/></svg>`;
  return `<div class="check-row check-warn">${icon}<span>${esc(label)}${detail ? `<span class="check-detail">${esc(detail)}</span>` : ''}</span></div>`;
}

function renderValidation(v: ValidationResult): string {
  // --- XMP section ---
  let xmpRows = '';
  if (v.xmp) {
    xmpRows = `
      <dl class="inv-fields">
        ${v.xmp.documentType ? `<dt>Document Type</dt><dd>${esc(v.xmp.documentType)}</dd>` : ''}
        ${v.xmp.fileName ? `<dt>Declared Filename</dt><dd>${esc(v.xmp.fileName)}</dd>` : ''}
        ${v.xmp.version ? `<dt>Version</dt><dd>${esc(v.xmp.version)}</dd>` : ''}
        ${v.xmp.conformanceLevel ? `<dt>Conformance Level</dt><dd>${esc(v.xmp.conformanceLevel)}</dd>` : ''}
      </dl>
      <div class="check-list" style="margin-top:10px">
        ${v.xmpFileNameMatch
          ? check(true, 'XMP filename matches attachment')
          : check(false, 'XMP filename mismatch', `XMP says "${v.xmp.fileName}"`)
        }
      </div>`;
  } else {
    xmpRows = warn('No ZUGFeRD/Factur-X XMP metadata found in this PDF', 'The PDF may not be PDF/A-3 compliant');
  }

  // --- AFRelationship section ---
  let afRow = '';
  if (v.afRelationship) {
    afRow = check(
      v.afRelationshipValid,
      `AFRelationship: ${v.afRelationship}`,
      v.afRelationshipValid ? '' : 'Expected "Alternative" or "Source"',
    );
  } else {
    afRow = warn('No /AFRelationship key found', 'Required by PDF/A-3 associated-file spec');
  }

  // --- Structural checks ---
  const xmlRows: string[] = [];
  xmlRows.push(check(v.wellFormed, 'XML is well-formed'));
  if (!v.wellFormed) {
    for (const e of v.parseErrors) {
      xmlRows.push(`<div class="check-indent check-fail-text">${esc(e)}</div>`);
    }
  }
  if (v.wellFormed) {
    if (v.structureErrors.length === 0) {
      xmlRows.push(check(true, 'All required elements present'));
    } else {
      xmlRows.push(check(false, `${v.structureErrors.length} structural issue${v.structureErrors.length > 1 ? 's' : ''}`));
      for (const e of v.structureErrors) {
        xmlRows.push(`<div class="check-indent check-fail-text">${esc(e)}</div>`);
      }
    }
  }
  if (v.profileId) {
    const short = shortProfileName(v.profileId);
    const label = short !== v.profileId ? `Profile: ${short}` : 'Profile ID';
    xmlRows.push(`<div class="check-row check-info">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" fill="#EFF6FF" stroke="#2563EB" stroke-width="1.5"/><path d="M8 7v4M8 5h.01" stroke="#2563EB" stroke-width="1.5" stroke-linecap="round"/></svg>
      <span>${esc(label)}<span class="check-detail profile-uri" title="${esc(v.profileId)}">${esc(short !== v.profileId ? v.profileId : v.profileId)}</span></span>
    </div>`);
  }

  // --- Overall badge ---
  const overallBadge = v.valid
    ? `<span class="val-badge val-ok">Valid</span>`
    : `<span class="val-badge val-fail">Issues found</span>`;

  return `
    <div class="inv-section inv-validation">
      <h2 class="inv-section-title">EN16931 Validation ${overallBadge}</h2>

      <div class="val-group">
        <div class="val-group-title">XMP Metadata</div>
        ${xmpRows}
      </div>

      <div class="val-group">
        <div class="val-group-title">PDF Structure</div>
        <div class="check-list">${afRow}</div>
      </div>

      <div class="val-group">
        <div class="val-group-title">XML Validity</div>
        <div class="check-list">${xmlRows.join('')}</div>
      </div>
    </div>`;
}

function renderInvoice(inv: Invoice): string {
  const cur = inv.currency;

  const hasItems = inv.items.length > 0;
  const hasTaxes = inv.taxes.length > 0;

  const itemsHtml = hasItems
    ? `
    <table class="inv-table">
      <thead>
        <tr>
          <th>#</th>
          <th>Description</th>
          <th class="num">Qty</th>
          <th class="num">Unit Price</th>
          <th class="num">VAT %</th>
          <th class="num">Total</th>
        </tr>
      </thead>
      <tbody>
        ${inv.items
          .map(
            (it) => `
          <tr>
            <td>${esc(it.position)}</td>
            <td>${esc(it.description) || '—'}</td>
            <td class="num">${esc(it.quantity)} ${esc(it.unit)}</td>
            <td class="num">${fmt(it.unitPrice, cur)}</td>
            <td class="num">${it.taxRate ? esc(it.taxRate) + ' %' : '—'}</td>
            <td class="num">${fmt(it.total, cur)}</td>
          </tr>`,
          )
          .join('')}
      </tbody>
    </table>`
    : '<p class="muted">No line items</p>';

  const taxHtml = hasTaxes
    ? `
    <table class="inv-table">
      <thead>
        <tr>
          <th>Category</th>
          <th class="num">Rate</th>
          <th class="num">Base Amount</th>
          <th class="num">Tax Amount</th>
        </tr>
      </thead>
      <tbody>
        ${inv.taxes
          .map(
            (t) => `
          <tr>
            <td>${esc(t.category) || '—'}</td>
            <td class="num">${t.rate ? esc(t.rate) + ' %' : '—'}</td>
            <td class="num">${fmt(t.base, cur)}</td>
            <td class="num">${fmt(t.amount, cur)}</td>
          </tr>`,
          )
          .join('')}
      </tbody>
    </table>`
    : '';

  return `
    <div class="inv-section">
      <h2 class="inv-section-title">Document</h2>
      <dl class="inv-fields">
        <dt>Invoice No.</dt><dd>${esc(inv.id) || '—'}</dd>
        <dt>Type</dt><dd>${esc(inv.type) || '—'}</dd>
        <dt>Issue Date</dt><dd>${esc(inv.issueDate) || '—'}</dd>
        ${inv.dueDate ? `<dt>Due Date</dt><dd>${esc(inv.dueDate)}</dd>` : ''}
        <dt>Currency</dt><dd>${esc(inv.currency) || '—'}</dd>
        ${inv.buyerReference ? `<dt>Buyer Reference</dt><dd>${esc(inv.buyerReference)}</dd>` : ''}
        ${inv.note ? `<dt>Note</dt><dd>${esc(inv.note)}</dd>` : ''}
      </dl>
    </div>

    <div class="inv-parties">
      <div class="inv-section party">
        <h2 class="inv-section-title">Seller</h2>
        <p>${addressHtml(inv.seller)}</p>
      </div>
      <div class="inv-section party">
        <h2 class="inv-section-title">Buyer</h2>
        <p>${addressHtml(inv.buyer)}</p>
      </div>
    </div>

    <div class="inv-section">
      <h2 class="inv-section-title">Line Items</h2>
      ${itemsHtml}
    </div>

    ${hasTaxes ? `<div class="inv-section"><h2 class="inv-section-title">Tax Breakdown</h2>${taxHtml}</div>` : ''}

    <div class="inv-section inv-totals">
      <h2 class="inv-section-title">Totals</h2>
      <dl class="inv-fields totals">
        <dt>Net Total</dt><dd>${fmt(inv.netTotal, cur)}</dd>
        <dt>Tax Total</dt><dd>${fmt(inv.taxTotal, cur)}</dd>
        <dt>Gross Total</dt><dd class="gross">${fmt(inv.grossTotal, cur)}</dd>
        ${inv.prepaidAmount && parseFloat(inv.prepaidAmount) !== 0
          ? `<dt>Prepaid</dt><dd>${fmt(inv.prepaidAmount, cur)}</dd>`
          : ''}
        ${inv.duePayable && inv.duePayable !== inv.grossTotal
          ? `<dt>Due</dt><dd class="gross">${fmt(inv.duePayable, cur)}</dd>`
          : ''}
      </dl>
    </div>`;
}

// ============================================================
// DOM wiring
// ============================================================

let currentXml = '';

function $(id: string): HTMLElement {
  return document.getElementById(id) as HTMLElement;
}

function showError(msg: string): void {
  const banner = $('error-banner');
  const txt = $('error-text');
  txt.textContent = msg;
  banner.classList.remove('hidden');
}

function hideError(): void {
  $('error-banner').classList.add('hidden');
}

function setLoading(on: boolean): void {
  $('loading').classList.toggle('hidden', !on);
  $('drop-zone').classList.toggle('loading', on);
}

async function handleFile(file: File): Promise<void> {
  if (!file.name.endsWith('.pdf') && file.type !== 'application/pdf') {
    showError('Please upload a PDF file.');
    return;
  }

  hideError();
  setLoading(true);

  try {
    const formData = new FormData();
    formData.append('pdf', file);

    const resp = await fetch('/api/upload', { method: 'POST', body: formData });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Server error ${resp.status}: ${text}`);
    }

    const data: UploadResponse = await resp.json();

    if (!data.success) {
      showError(data.error);
      return;
    }

    currentXml = data.xml;

    // Show viewer screen
    $('upload-screen').classList.add('hidden');
    $('viewer-screen').classList.remove('hidden');

    // Header
    ($('header-filename') as HTMLElement).textContent = file.name;
    ($('header-badge') as HTMLElement).textContent = data.attachmentName;
    ($('xml-filename') as HTMLElement).textContent = data.attachmentName;

    // PDF viewer
    const pdfBytes = Uint8Array.from(atob(data.pdfBase64), (c) => c.charCodeAt(0));
    const blob = new Blob([pdfBytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    ($('pdf-frame') as HTMLIFrameElement).src = url;

    // Validation + invoice data
    const validationHtml = renderValidation(data.validation);
    let invoiceHtml = '';
    try {
      const inv = parseInvoice(data.xml);
      invoiceHtml = renderInvoice(inv);
    } catch (e) {
      invoiceHtml = `<pre class="xml-fallback">${esc(data.xml)}</pre>`;
    }
    $('invoice-content').innerHTML = validationHtml + invoiceHtml;
  } catch (e) {
    showError(e instanceof Error ? e.message : String(e));
  } finally {
    setLoading(false);
  }
}

function initUploadScreen(): void {
  const dropZone = $('drop-zone');
  const fileInput = $('file-input') as HTMLInputElement;

  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter' || (e as KeyboardEvent).key === ' ') fileInput.click();
  });

  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const file = (e as DragEvent).dataTransfer?.files[0];
    if (file) void handleFile(file);
  });

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) void handleFile(file);
    fileInput.value = '';
  });
}

function initViewerScreen(): void {
  $('back-btn').addEventListener('click', () => {
    $('viewer-screen').classList.add('hidden');
    $('upload-screen').classList.remove('hidden');
    ($('pdf-frame') as HTMLIFrameElement).src = '';
    $('invoice-content').innerHTML = '';
    currentXml = '';
  });

  $('download-xml-btn').addEventListener('click', () => {
    if (!currentXml) return;
    const blob = new Blob([currentXml], { type: 'application/xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = ($('header-badge') as HTMLElement).textContent || 'invoice.xml';
    a.click();
    URL.revokeObjectURL(url);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  initUploadScreen();
  initViewerScreen();
});
