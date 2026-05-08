import { parseImportFile, downloadCsvTemplate, downloadExcelTemplate } from './invoice-import';
import Handlebars from 'handlebars';
import invoiceTemplateSource from './templates/invoice.hbs';

// ============================================================
// Types
// ============================================================

export interface LineItem {
  description: string;
  quantity: string;
  unitCode: string;
  unitPrice: string;
  vatRate: string;
}

export interface InvoiceTemplate {
  logoDataUrl: string;
  headerText: string;
  footerText: string;
  font: 'sans' | 'serif' | 'mono';
  accentColor: string;
}

export interface InvoiceFormData {
  invoiceNumber: string;
  invoiceDate: string;
  invoiceType: string;
  currency: string;
  profile: string;
  letter: string;
  notes: string;
  sellerName: string;
  sellerStreet: string;
  sellerCity: string;
  sellerPostalCode: string;
  sellerCountry: string;
  sellerVatId: string;
  sellerTaxNumber: string;
  buyerName: string;
  buyerReference: string;
  buyerStreet: string;
  buyerCity: string;
  buyerPostalCode: string;
  buyerCountry: string;
  buyerVatId: string;
  paymentMeansCode: string;
  iban: string;
  bic: string;
  paymentReference: string;
  paymentTerms: string;
  dueDate: string;
  lineItems: LineItem[];
}

function emptyData(): InvoiceFormData {
  return {
    invoiceNumber: '', invoiceDate: '', invoiceType: '380', currency: 'EUR',
    profile: 'en16931', letter: '', notes: '',
    sellerName: '', sellerStreet: '', sellerCity: '', sellerPostalCode: '',
    sellerCountry: 'DE', sellerVatId: '', sellerTaxNumber: '',
    buyerName: '', buyerReference: '', buyerStreet: '', buyerCity: '',
    buyerPostalCode: '', buyerCountry: 'DE', buyerVatId: '',
    paymentMeansCode: '58', iban: '', bic: '', paymentReference: '',
    paymentTerms: '', dueDate: '',
    lineItems: [{ description: '', quantity: '1', unitCode: 'C62', unitPrice: '', vatRate: '19' }],
  };
}

function emptyTemplate(): InvoiceTemplate {
  return { logoDataUrl: '', headerText: '', footerText: '', font: 'sans', accentColor: '#2563EB' };
}

const TEMPLATE_STORAGE_KEY = 'invoice-template-v1';

function saveTemplate(t: InvoiceTemplate): void {
  try { localStorage.setItem(TEMPLATE_STORAGE_KEY, JSON.stringify(t)); } catch { /* quota exceeded */ }
}

function loadStoredTemplate(): InvoiceTemplate {
  try {
    const raw = localStorage.getItem(TEMPLATE_STORAGE_KEY);
    if (raw) return { ...emptyTemplate(), ...JSON.parse(raw) as Partial<InvoiceTemplate> };
  } catch { /* corrupted — fall through */ }
  return emptyTemplate();
}

// ============================================================
// CII XML builder (mirrors backend pdf-generator.ts)
// ============================================================

const PROFILE_URIS: Record<string, string> = {
  minimum:  'urn:factur-x.eu:1p0:minimum',
  basicwl:  'urn:factur-x.eu:1p0:basicwl',
  basic:    'urn:factur-x.eu:1p0:basic',
  en16931:  'urn:cen.eu:en16931:2017#compliant#urn:factur-x.eu:1p0:en16931',
  extended: 'urn:cen.eu:en16931:2017#conformant#urn:factur-x.eu:1p0:extended',
};

function profileUri(key: string): string {
  return PROFILE_URIS[key] ?? PROFILE_URIS.en16931;
}

function xmlEsc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtDate(d: string): string {
  return d.replace(/-/g, '');
}

function opt(xml: string, condition: boolean): string {
  return condition ? xml : '';
}

interface ComputedLine { description: string; quantity: number; unitCode: string; unitPrice: number; vatRate: number; lineTotal: number; idx: number; }
interface VatGroup { rate: number; basis: number; tax: number; }
interface Totals { lines: ComputedLine[]; vatGroups: VatGroup[]; lineTotal: number; taxTotal: number; grandTotal: number; }

function computeTotals(data: InvoiceFormData): Totals {
  const lines: ComputedLine[] = data.lineItems.map((item, i) => {
    const quantity  = parseFloat(item.quantity)  || 0;
    const unitPrice = parseFloat(item.unitPrice) || 0;
    const vatRate   = parseFloat(item.vatRate)   || 0;
    return { description: item.description, quantity, unitCode: item.unitCode || 'C62', unitPrice, vatRate, lineTotal: quantity * unitPrice, idx: i + 1 };
  });
  const vatMap = new Map<number, VatGroup>();
  for (const l of lines) {
    const g = vatMap.get(l.vatRate) ?? { rate: l.vatRate, basis: 0, tax: 0 };
    g.basis += l.lineTotal; g.tax += l.lineTotal * l.vatRate / 100;
    vatMap.set(l.vatRate, g);
  }
  const vatGroups = Array.from(vatMap.values());
  const lineTotal = lines.reduce((s, l) => s + l.lineTotal, 0);
  const taxTotal  = vatGroups.reduce((s, g) => s + g.tax, 0);
  return { lines, vatGroups, lineTotal, taxTotal, grandTotal: lineTotal + taxTotal };
}

export function buildCiiXml(data: InvoiceFormData): string {
  const { lines, vatGroups, lineTotal, taxTotal, grandTotal } = computeTotals(data);
  const currency = data.currency || 'EUR';
  const date    = fmtDate(data.invoiceDate || new Date().toISOString().slice(0, 10));
  const dueDate = fmtDate(data.dueDate);

  const lineItemsXml = lines.map((l) => `
    <ram:IncludedSupplyChainTradeLineItem>
      <ram:AssociatedDocumentLineDocument><ram:LineID>${l.idx}</ram:LineID></ram:AssociatedDocumentLineDocument>
      <ram:SpecifiedTradeProduct><ram:Name>${xmlEsc(l.description || `Item ${l.idx}`)}</ram:Name></ram:SpecifiedTradeProduct>
      <ram:SpecifiedLineTradeAgreement>
        <ram:NetPriceProductTradePrice><ram:ChargeAmount>${l.unitPrice.toFixed(2)}</ram:ChargeAmount></ram:NetPriceProductTradePrice>
      </ram:SpecifiedLineTradeAgreement>
      <ram:SpecifiedLineTradeDelivery>
        <ram:BilledQuantity unitCode="${xmlEsc(l.unitCode)}">${l.quantity.toFixed(4)}</ram:BilledQuantity>
      </ram:SpecifiedLineTradeDelivery>
      <ram:SpecifiedLineTradeSettlement>
        <ram:ApplicableTradeTax>
          <ram:TypeCode>VAT</ram:TypeCode><ram:CategoryCode>S</ram:CategoryCode>
          <ram:RateApplicablePercent>${l.vatRate.toFixed(2)}</ram:RateApplicablePercent>
        </ram:ApplicableTradeTax>
        <ram:SpecifiedTradeSettlementLineMonetarySummation>
          <ram:LineTotalAmount>${l.lineTotal.toFixed(2)}</ram:LineTotalAmount>
        </ram:SpecifiedTradeSettlementLineMonetarySummation>
      </ram:SpecifiedLineTradeSettlement>
    </ram:IncludedSupplyChainTradeLineItem>`).join('');

  const vatTaxXml = vatGroups.map((g) => `
      <ram:ApplicableTradeTax>
        <ram:CalculatedAmount>${g.tax.toFixed(2)}</ram:CalculatedAmount>
        <ram:TypeCode>VAT</ram:TypeCode>
        <ram:BasisAmount>${g.basis.toFixed(2)}</ram:BasisAmount>
        <ram:CategoryCode>S</ram:CategoryCode>
        <ram:RateApplicablePercent>${g.rate.toFixed(2)}</ram:RateApplicablePercent>
      </ram:ApplicableTradeTax>`).join('');

  const sellerAddr = (data.sellerPostalCode || data.sellerStreet || data.sellerCity || data.sellerCountry)
    ? `<ram:PostalTradeAddress>
          ${opt(`<ram:PostcodeCode>${xmlEsc(data.sellerPostalCode)}</ram:PostcodeCode>`, !!data.sellerPostalCode)}
          ${opt(`<ram:LineOne>${xmlEsc(data.sellerStreet)}</ram:LineOne>`, !!data.sellerStreet)}
          ${opt(`<ram:CityName>${xmlEsc(data.sellerCity)}</ram:CityName>`, !!data.sellerCity)}
          ${opt(`<ram:CountryID>${xmlEsc(data.sellerCountry)}</ram:CountryID>`, !!data.sellerCountry)}
        </ram:PostalTradeAddress>` : '';

  const buyerAddr = (data.buyerPostalCode || data.buyerStreet || data.buyerCity || data.buyerCountry)
    ? `<ram:PostalTradeAddress>
          ${opt(`<ram:PostcodeCode>${xmlEsc(data.buyerPostalCode)}</ram:PostcodeCode>`, !!data.buyerPostalCode)}
          ${opt(`<ram:LineOne>${xmlEsc(data.buyerStreet)}</ram:LineOne>`, !!data.buyerStreet)}
          ${opt(`<ram:CityName>${xmlEsc(data.buyerCity)}</ram:CityName>`, !!data.buyerCity)}
          ${opt(`<ram:CountryID>${xmlEsc(data.buyerCountry)}</ram:CountryID>`, !!data.buyerCountry)}
        </ram:PostalTradeAddress>` : '';

  const paymentMeansXml = (data.paymentMeansCode || data.iban || data.bic)
    ? `<ram:SpecifiedTradeSettlementPaymentMeans>
        ${opt(`<ram:TypeCode>${xmlEsc(data.paymentMeansCode)}</ram:TypeCode>`, !!data.paymentMeansCode)}
        ${opt(`<ram:PayeePartyCreditorFinancialAccount>
          <ram:IBANID>${xmlEsc(data.iban)}</ram:IBANID>
          ${opt(`<ram:ProprietaryID>${xmlEsc(data.bic)}</ram:ProprietaryID>`, !!data.bic)}
        </ram:PayeePartyCreditorFinancialAccount>`, !!data.iban)}
      </ram:SpecifiedTradeSettlementPaymentMeans>` : '';

  const paymentTermsXml = (data.paymentTerms || data.dueDate)
    ? `<ram:SpecifiedTradePaymentTerms>
        ${opt(`<ram:Description>${xmlEsc(data.paymentTerms)}</ram:Description>`, !!data.paymentTerms)}
        ${opt(`<ram:DueDateDateTime><udt:DateTimeString format="102">${dueDate}</udt:DateTimeString></ram:DueDateDateTime>`, !!data.dueDate)}
      </ram:SpecifiedTradePaymentTerms>` : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice
  xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"
  xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100"
  xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100">
  <rsm:ExchangedDocumentContext>
    <ram:GuidelineSpecifiedDocumentContextParameter>
      <ram:ID>${profileUri(data.profile)}</ram:ID>
    </ram:GuidelineSpecifiedDocumentContextParameter>
  </rsm:ExchangedDocumentContext>
  <rsm:ExchangedDocument>
    <ram:ID>${xmlEsc(data.invoiceNumber || 'DRAFT')}</ram:ID>
    <ram:TypeCode>${xmlEsc(data.invoiceType || '380')}</ram:TypeCode>
    <ram:IssueDateTime><udt:DateTimeString format="102">${date}</udt:DateTimeString></ram:IssueDateTime>
    ${opt(`<ram:IncludedNote><ram:Content>${xmlEsc(data.notes)}</ram:Content></ram:IncludedNote>`, !!data.notes)}
  </rsm:ExchangedDocument>
  <rsm:SupplyChainTradeTransaction>
    ${lineItemsXml}
    <ram:ApplicableHeaderTradeAgreement>
      ${opt(`<ram:BuyerReference>${xmlEsc(data.buyerReference)}</ram:BuyerReference>`, !!data.buyerReference)}
      <ram:SellerTradeParty>
        <ram:Name>${xmlEsc(data.sellerName || 'Seller')}</ram:Name>
        ${sellerAddr}
        ${opt(`<ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">${xmlEsc(data.sellerVatId)}</ram:ID></ram:SpecifiedTaxRegistration>`, !!data.sellerVatId)}
        ${opt(`<ram:SpecifiedTaxRegistration><ram:ID schemeID="FC">${xmlEsc(data.sellerTaxNumber)}</ram:ID></ram:SpecifiedTaxRegistration>`, !!data.sellerTaxNumber)}
      </ram:SellerTradeParty>
      <ram:BuyerTradeParty>
        <ram:Name>${xmlEsc(data.buyerName || 'Buyer')}</ram:Name>
        ${buyerAddr}
        ${opt(`<ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">${xmlEsc(data.buyerVatId)}</ram:ID></ram:SpecifiedTaxRegistration>`, !!data.buyerVatId)}
      </ram:BuyerTradeParty>
    </ram:ApplicableHeaderTradeAgreement>
    <ram:ApplicableHeaderTradeDelivery/>
    <ram:ApplicableHeaderTradeSettlement>
      ${opt(`<ram:PaymentReference>${xmlEsc(data.paymentReference)}</ram:PaymentReference>`, !!data.paymentReference)}
      <ram:InvoiceCurrencyCode>${xmlEsc(currency)}</ram:InvoiceCurrencyCode>
      ${paymentMeansXml}
      ${vatTaxXml}
      ${paymentTermsXml}
      <ram:SpecifiedTradeSettlementHeaderMonetarySummation>
        <ram:LineTotalAmount>${lineTotal.toFixed(2)}</ram:LineTotalAmount>
        <ram:TaxBasisTotalAmount>${lineTotal.toFixed(2)}</ram:TaxBasisTotalAmount>
        <ram:TaxTotalAmount currencyID="${xmlEsc(currency)}">${taxTotal.toFixed(2)}</ram:TaxTotalAmount>
        <ram:GrandTotalAmount>${grandTotal.toFixed(2)}</ram:GrandTotalAmount>
        <ram:DuePayableAmount>${grandTotal.toFixed(2)}</ram:DuePayableAmount>
      </ram:SpecifiedTradeSettlementHeaderMonetarySummation>
    </ram:ApplicableHeaderTradeSettlement>
  </rsm:SupplyChainTradeTransaction>
</rsm:CrossIndustryInvoice>`;
}

// ============================================================
// Invoice preview HTML renderer
// ============================================================

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtAmount(n: number, currency: string): string {
  try {
    return n.toLocaleString(undefined, { style: 'currency', currency: currency || 'EUR', minimumFractionDigits: 2 });
  } catch {
    return n.toFixed(2) + ' ' + currency;
  }
}

const TYPE_LABELS: Record<string, string> = {
  '380': 'Commercial Invoice', '381': 'Credit Note',
  '384': 'Corrected Invoice', '389': 'Self-billed Invoice',
};

const PROFILE_LABELS: Record<string, string> = {
  minimum: 'MINIMUM', basicwl: 'BASIC WL', basic: 'BASIC',
  en16931: 'EN 16931', extended: 'EXTENDED',
};

const PAYMENT_LABELS: Record<string, string> = {
  '30': 'Credit transfer', '31': 'Debit transfer',
  '48': 'Bank card', '58': 'SEPA credit transfer', '59': 'SEPA direct debit',
};

export function renderPreview(data: InvoiceFormData, template?: InvoiceTemplate): string {
  const { lines, vatGroups, lineTotal, taxTotal, grandTotal } = computeTotals(data);
  const currency = data.currency || 'EUR';

  const accentHex  = template?.accentColor || '#2563EB';
  const fontFamily = template?.font === 'serif' ? 'Georgia, "Times New Roman", serif'
    : template?.font === 'mono' ? '"SF Mono", "Fira Code", "Courier New", monospace'
    : 'inherit';

  // ── Header card ──────────────────────────────────────────────────────────
  const profileLabel = PROFILE_LABELS[data.profile] ?? data.profile;
  const typeLabel    = TYPE_LABELS[data.invoiceType] ?? data.invoiceType;

  let html = `<div class="prev-header">
    <div class="prev-title"${template?.logoDataUrl ? ' style="justify-content:space-between;align-items:flex-start"' : ''}>
      <div>
        <div style="display:flex;align-items:center;gap:8px">
          <span class="prev-invoice-label" style="color:${accentHex}">INVOICE</span>
          <span class="badge" style="background:${accentHex}1a;color:${accentHex}">${esc(profileLabel)}</span>
        </div>
        ${template?.headerText ? `<div class="prev-header-text">${esc(template.headerText)}</div>` : ''}
      </div>
      ${template?.logoDataUrl ? `<img src="${template.logoDataUrl}" class="prev-logo" alt="">` : ''}
    </div>
    <dl class="prev-meta">
      ${data.invoiceNumber ? `<dt>Invoice No</dt><dd>${esc(data.invoiceNumber)}</dd>` : ''}
      ${data.invoiceDate   ? `<dt>Date</dt><dd>${esc(data.invoiceDate)}</dd>` : ''}
      ${data.dueDate       ? `<dt>Due Date</dt><dd>${esc(data.dueDate)}</dd>` : ''}
      ${typeLabel          ? `<dt>Type</dt><dd>${esc(typeLabel)}</dd>` : ''}
      <dt>Currency</dt><dd>${esc(currency)}</dd>
    </dl>
  </div>`;

  // ── Parties ──────────────────────────────────────────────────────────────
  const partyLines = (fields: string[]): string => fields.filter(Boolean).map((l) => `<div>${esc(l)}</div>`).join('');

  html += `<div class="prev-parties">
    <div class="prev-party">
      <div class="prev-party-label" style="color:${accentHex}">FROM</div>
      <div class="prev-party-body">
        ${partyLines([
          data.sellerName,
          data.sellerStreet,
          [data.sellerPostalCode, data.sellerCity].filter(Boolean).join(' '),
          data.sellerCountry,
          data.sellerVatId ? `VAT: ${data.sellerVatId}` : '',
          data.sellerTaxNumber ? `Tax ID: ${data.sellerTaxNumber}` : '',
        ]) || '<span class="prev-empty">—</span>'}
      </div>
    </div>
    <div class="prev-party">
      <div class="prev-party-label" style="color:${accentHex}">TO</div>
      <div class="prev-party-body">
        ${partyLines([
          data.buyerName,
          data.buyerStreet,
          [data.buyerPostalCode, data.buyerCity].filter(Boolean).join(' '),
          data.buyerCountry,
          data.buyerVatId ? `VAT: ${data.buyerVatId}` : '',
          data.buyerReference ? `Ref: ${data.buyerReference}` : '',
        ]) || '<span class="prev-empty">—</span>'}
      </div>
    </div>
  </div>`;

  // ── Letter ───────────────────────────────────────────────────────────────
  if (data.letter) {
    html += `<div class="prev-section prev-letter">
      <p class="prev-letter-text">${esc(data.letter).replace(/\n/g, '<br>')}</p>
    </div>`;
  }

  // ── Line items ────────────────────────────────────────────────────────────
  if (lines.length > 0) {
    html += `<div class="prev-section">
      <table class="inv-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Description</th>
            <th class="num">Qty</th>
            <th class="num">Unit Price</th>
            <th class="num">VAT%</th>
            <th class="num">Total</th>
          </tr>
        </thead>
        <tbody>`;
    for (const l of lines) {
      html += `<tr>
          <td class="muted">${l.idx}</td>
          <td>${esc(l.description || `Item ${l.idx}`)}</td>
          <td class="num">${l.quantity}</td>
          <td class="num">${l.unitPrice.toFixed(2)}</td>
          <td class="num">${l.vatRate}%</td>
          <td class="num">${fmtAmount(l.lineTotal, currency)}</td>
        </tr>`;
    }
    html += `</tbody></table></div>`;
  }

  // ── Totals ────────────────────────────────────────────────────────────────
  html += `<div class="prev-totals">`;
  html += `<div class="prev-total-row"><span>Subtotal</span><span>${fmtAmount(lineTotal, currency)}</span></div>`;
  for (const g of vatGroups) {
    html += `<div class="prev-total-row"><span>VAT ${g.rate}%</span><span>${fmtAmount(g.tax, currency)}</span></div>`;
  }
  html += `<div class="prev-total-row prev-total-grand"><span>Total</span><span>${fmtAmount(grandTotal, currency)}</span></div>`;
  html += `</div>`;

  // ── Payment ───────────────────────────────────────────────────────────────
  if (data.iban || data.paymentTerms || data.paymentMeansCode) {
    const pmLabel = PAYMENT_LABELS[data.paymentMeansCode] ?? data.paymentMeansCode;
    html += `<div class="prev-section prev-payment">
      <div class="prev-section-title" style="color:${accentHex}">Payment</div>
      <dl class="inv-fields">
        ${pmLabel  ? `<dt>Means</dt><dd>${esc(pmLabel)}</dd>` : ''}
        ${data.iban ? `<dt>IBAN</dt><dd class="mono">${esc(data.iban)}</dd>` : ''}
        ${data.bic  ? `<dt>BIC</dt><dd class="mono">${esc(data.bic)}</dd>` : ''}
        ${data.paymentReference ? `<dt>Reference</dt><dd>${esc(data.paymentReference)}</dd>` : ''}
        ${data.paymentTerms ? `<dt>Terms</dt><dd>${esc(data.paymentTerms)}</dd>` : ''}
      </dl>
    </div>`;
  }

  // ── Notes ─────────────────────────────────────────────────────────────────
  if (data.notes) {
    html += `<div class="prev-section">
      <div class="prev-section-title" style="color:${accentHex}">Notes</div>
      <p class="prev-notes">${esc(data.notes)}</p>
    </div>`;
  }

  // ── Footer ─────────────────────────────────────────────────────────────
  if (template?.footerText) {
    html += `<div class="prev-footer">${esc(template.footerText)}</div>`;
  }

  return `<div class="prev-wrapper" style="font-family:${fontFamily}">${html}</div>`;
}

// ============================================================
// Template form HTML builder
// ============================================================

function buildTemplateFormHtml(t: InvoiceTemplate): string {
  const fontOpts: [string, string][] = [
    ['sans', 'Sans-serif (default)'],
    ['serif', 'Serif'],
    ['mono', 'Monospace'],
  ];
  const fontSelect = fontOpts.map(([v, label]) =>
    `<option value="${v}"${v === t.font ? ' selected' : ''}>${esc(label)}</option>`
  ).join('');

  const logoPreviewHtml = t.logoDataUrl
    ? `<img src="${t.logoDataUrl}" class="logo-thumb" alt="Logo"><button type="button" id="t-logo-remove" class="logo-remove-btn" title="Remove logo">&times;</button>`
    : '';

  return `<div class="form-section form-section-template">
    <div class="form-section-title">Invoice Template</div>
    <div class="form-row">
      <div class="form-field" style="flex:2 1 200px">
        <label>Logo</label>
        <div class="logo-upload-wrap">
          <input type="file" id="t-logo" accept="image/png,image/jpeg,image/gif,image/webp" style="display:none">
          <button type="button" id="t-logo-btn" class="back-btn" style="flex-shrink:0">Upload Logo</button>
          <span id="t-logo-preview" class="logo-preview-wrap">${logoPreviewHtml}</span>
        </div>
      </div>
      <div class="form-field">
        <label for="t-accent">Accent Color</label>
        <input type="color" id="t-accent" value="${esc(t.accentColor)}">
      </div>
      <div class="form-field">
        <label for="t-font">Font</label>
        <select id="t-font">${fontSelect}</select>
      </div>
    </div>
    <div class="form-row">
      <div class="form-field">
        <label for="t-header">Header Text</label>
        <textarea id="t-header" rows="2" placeholder="Tagline or registration no. shown below INVOICE">${esc(t.headerText)}</textarea>
      </div>
      <div class="form-field">
        <label for="t-footer">Footer Text</label>
        <textarea id="t-footer" rows="2" placeholder="Chamber of Commerce no., legal notice, etc.">${esc(t.footerText)}</textarea>
      </div>
    </div>
  </div>`;
}

// ============================================================
// Form HTML builder
// ============================================================

function field(id: string, label: string, type: string, value: string, placeholder = ''): string {
  return `<div class="form-field">
    <label for="${id}">${esc(label)}</label>
    <input type="${type}" id="${id}" name="${id}" value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off" />
  </div>`;
}

function selectField(id: string, label: string, options: [string, string][], value: string): string {
  const opts = options.map(([v, t]) =>
    `<option value="${esc(v)}"${v === value ? ' selected' : ''}>${esc(t)}</option>`
  ).join('');
  return `<div class="form-field">
    <label for="${id}">${esc(label)}</label>
    <select id="${id}" name="${id}">${opts}</select>
  </div>`;
}

function lineItemRow(item: LineItem, idx: number): string {
  return `<tr data-line="${idx}">
    <td><input class="line-desc" type="text" value="${esc(item.description)}" placeholder="Description" /></td>
    <td><input class="line-qty" type="number" value="${esc(item.quantity)}" min="0" step="any" /></td>
    <td><input class="line-unit" type="text" value="${esc(item.unitCode)}" placeholder="C62" style="width:52px" /></td>
    <td><input class="line-price" type="number" value="${esc(item.unitPrice)}" min="0" step="any" placeholder="0.00" /></td>
    <td><input class="line-vat" type="number" value="${esc(item.vatRate)}" min="0" max="100" step="any" /></td>
    <td><button class="remove-line-btn" title="Remove line" type="button">×</button></td>
  </tr>`;
}

function buildFormHtml(data: InvoiceFormData): string {
  return `
  <div class="import-template-bar">
    <span class="import-template-label">Start from a template:</span>
    <a href="#" id="dl-csv-template" class="template-link">Download CSV template</a>
    <span class="template-sep">·</span>
    <a href="#" id="dl-xlsx-template" class="template-link">Download Excel template</a>
  </div>

  <form id="invoice-form" autocomplete="off">

    <div class="form-section">
      <div class="form-section-title">Letter</div>
      <div class="form-field form-field-full">
        <label for="f-letter">Letter</label>
        <textarea id="f-letter" name="f-letter" rows="5" placeholder="Dear Sir or Madam, …">${esc(data.letter)}</textarea>
      </div>
    </div>

    <div class="form-section">
      <div class="form-section-title">Invoice Details</div>
      <div class="form-row">
        ${field('f-number', 'Invoice Number', 'text', data.invoiceNumber, 'RE-2025-001')}
        ${field('f-date', 'Invoice Date', 'date', data.invoiceDate)}
        ${field('f-due', 'Due Date', 'date', data.dueDate)}
      </div>
      <div class="form-row">
        ${selectField('f-type', 'Invoice Type', [
          ['380','380 · Commercial Invoice'],['381','381 · Credit Note'],
          ['384','384 · Corrected Invoice'],['389','389 · Self-billed Invoice'],
        ], data.invoiceType)}
        ${field('f-currency', 'Currency', 'text', data.currency, 'EUR')}
        ${selectField('f-profile', 'Profile', [
          ['minimum','MINIMUM'],['basicwl','BASIC WL'],['basic','BASIC'],
          ['en16931','EN 16931'],['extended','EXTENDED'],
        ], data.profile)}
      </div>
    </div>

    <div class="form-section">
      <div class="form-section-title">Seller</div>
      <div class="form-row">
        ${field('f-seller-name', 'Company Name', 'text', data.sellerName, 'Muster GmbH')}
      </div>
      <div class="form-row">
        ${field('f-seller-street', 'Street & Number', 'text', data.sellerStreet, 'Musterstraße 1')}
        ${field('f-seller-postal', 'Postal Code', 'text', data.sellerPostalCode, '10115')}
        ${field('f-seller-city', 'City', 'text', data.sellerCity, 'Berlin')}
        ${field('f-seller-country', 'Country Code', 'text', data.sellerCountry, 'DE')}
      </div>
      <div class="form-row">
        ${field('f-seller-vat', 'VAT ID', 'text', data.sellerVatId, 'DE123456789')}
        ${field('f-seller-tax', 'Tax Registration No.', 'text', data.sellerTaxNumber, '12/345/67890')}
      </div>
    </div>

    <div class="form-section">
      <div class="form-section-title">Buyer</div>
      <div class="form-row">
        ${field('f-buyer-name', 'Company Name', 'text', data.buyerName, 'Kunde AG')}
        ${field('f-buyer-ref', 'Buyer Reference', 'text', data.buyerReference, 'BE-12345')}
      </div>
      <div class="form-row">
        ${field('f-buyer-street', 'Street & Number', 'text', data.buyerStreet, 'Beispielweg 42')}
        ${field('f-buyer-postal', 'Postal Code', 'text', data.buyerPostalCode, '80331')}
        ${field('f-buyer-city', 'City', 'text', data.buyerCity, 'München')}
        ${field('f-buyer-country', 'Country Code', 'text', data.buyerCountry, 'DE')}
      </div>
      <div class="form-row">
        ${field('f-buyer-vat', 'VAT ID', 'text', data.buyerVatId, 'DE987654321')}
      </div>
    </div>

    <div class="form-section">
      <div class="form-section-title">Line Items</div>
      <div class="line-items-wrapper">
        <table class="line-items-table">
          <thead>
            <tr>
              <th>Description</th><th>Qty</th><th>Unit</th><th>Unit Price</th><th>VAT%</th><th></th>
            </tr>
          </thead>
          <tbody id="line-items-body">
            ${data.lineItems.map((item, i) => lineItemRow(item, i)).join('')}
          </tbody>
        </table>
      </div>
      <button type="button" id="add-line-btn" class="add-line-btn">+ Add line</button>
    </div>

    <div class="form-section">
      <div class="form-section-title">Payment</div>
      <div class="form-row">
        ${selectField('f-pm-code', 'Payment Means', [
          ['','— none —'],['30','30 · Credit transfer'],['31','31 · Debit transfer'],
          ['48','48 · Bank card'],['58','58 · SEPA credit transfer'],['59','59 · SEPA direct debit'],
        ], data.paymentMeansCode)}
        ${field('f-iban', 'IBAN', 'text', data.iban, 'DE89370400440532013000')}
        ${field('f-bic', 'BIC', 'text', data.bic, 'COBADEFFXXX')}
      </div>
      <div class="form-row">
        ${field('f-pay-ref', 'Payment Reference', 'text', data.paymentReference, '')}
        ${field('f-pay-terms', 'Payment Terms', 'text', data.paymentTerms, 'Zahlbar innerhalb von 30 Tagen')}
      </div>
    </div>

    <div class="form-section">
      <div class="form-section-title">Notes</div>
      <div class="form-field form-field-full">
        <label for="f-notes">Notes</label>
        <textarea id="f-notes" name="f-notes" rows="3" placeholder="Weitere Hinweise…">${esc(data.notes)}</textarea>
      </div>
    </div>

  </form>`;
}

// ============================================================
// Create screen controller
// ============================================================

// ============================================================
// Client-side preview rendering (mirrors backend buildTemplateContext)
// ============================================================

// Seed with the bundled template so the preview works immediately and offline.
// refreshTemplateFromBackend() swaps it out with the live backend version so that
// edits to invoice.hbs are reflected in the preview without a frontend rebuild.
let _compiledInvoiceTemplate = Handlebars.compile(invoiceTemplateSource);

async function refreshTemplateFromBackend(): Promise<void> {
  try {
    const resp = await fetch('/api/template');
    if (resp.ok) {
      _compiledInvoiceTemplate = Handlebars.compile(await resp.text());
    }
  } catch { /* keep using the bundled fallback */ }
}

const _FONT_FAMILIES: Record<string, string> = {
  sans:  '"DejaVu Sans", Arial, Helvetica, sans-serif',
  serif: '"DejaVu Serif", Georgia, "Times New Roman", serif',
  mono:  '"DejaVu Sans Mono", "Courier New", Courier, monospace',
};

const _TYPE_LABELS: Record<string, string> = {
  '380': 'Rechnung', '381': 'Stornorechnung',
  '384': 'Korrekturrechnung', '389': 'Gutschrift',
};

function _fmtGermanDate(iso: string): string {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return (d && m && y) ? `${d}.${m}.${y}` : iso;
}

function buildPreviewContext(data: InvoiceFormData, tmpl: InvoiceTemplate): Record<string, unknown> {
  const { lines, vatGroups, lineTotal, taxTotal, grandTotal } = computeTotals(data);
  const currency = data.currency || 'EUR';
  const fmt = (n: number) =>
    n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ' + currency;

  return {
    accentColor: tmpl.accentColor || '#2563EB',
    fontFamily:  _FONT_FAMILIES[tmpl.font || 'sans'],
    logoDataUrl: tmpl.logoDataUrl || '',
    headerText:  tmpl.headerText  || '',
    footerText:  tmpl.footerText  || '',
    invoiceNumber: data.invoiceNumber || 'ENTWURF',
    invoiceDate:   _fmtGermanDate(data.invoiceDate),
    dueDate:       _fmtGermanDate(data.dueDate),
    typeLabel:     _TYPE_LABELS[data.invoiceType] ?? 'Rechnung',
    currency,
    profile: (data.profile || 'en16931').toUpperCase().replace('EN16931', 'EN 16931'),
    sellerName:       data.sellerName,
    sellerStreet:     data.sellerStreet,
    sellerCity:       data.sellerCity,
    sellerPostalCode: data.sellerPostalCode,
    sellerCountry:    data.sellerCountry !== 'DE' ? data.sellerCountry : '',
    sellerVatId:      data.sellerVatId,
    sellerTaxNumber:  data.sellerTaxNumber,
    buyerName:        data.buyerName,
    buyerReference:   data.buyerReference,
    buyerStreet:      data.buyerStreet,
    buyerCity:        data.buyerCity,
    buyerPostalCode:  data.buyerPostalCode,
    buyerCountry:     data.buyerCountry !== 'DE' ? data.buyerCountry : '',
    buyerVatId:       data.buyerVatId,
    lineItems: lines.map((l) => ({
      idx:                l.idx,
      description:        l.description || `Position ${l.idx}`,
      quantity:           l.quantity.toLocaleString('de-DE', { maximumFractionDigits: 4 }),
      unitCode:           l.unitCode === 'C62' ? 'Stk.' : l.unitCode,
      unitPriceFormatted: fmt(l.unitPrice),
      vatRate:            l.vatRate.toLocaleString('de-DE'),
      lineTotalFormatted: fmt(l.lineTotal),
    })),
    subtotalFormatted:   fmt(lineTotal),
    vatGroups: vatGroups.map((g) => ({
      rate:        g.rate.toLocaleString('de-DE'),
      taxFormatted: fmt(g.tax),
    })),
    taxTotalFormatted:   fmt(taxTotal),
    grandTotalFormatted: fmt(grandTotal),
    iban:             data.iban,
    bic:              data.bic,
    paymentReference: data.paymentReference,
    paymentTerms:     data.paymentTerms,
    letter:           data.letter || '',
    notes:            data.notes || '',
    hasPaymentInfo:   !!(data.iban || data.paymentTerms),
    hasDueDate:       !!data.dueDate,
    hasBuyerRef:      !!data.buyerReference,
  };
}

// ============================================================
// State
// ============================================================

let formData: InvoiceFormData = emptyData();
let templateData: InvoiceTemplate = loadStoredTemplate();
let generating = false;

function readTemplateData(): InvoiceTemplate {
  const v = (id: string): string => (document.getElementById(id) as HTMLInputElement | null)?.value ?? '';
  return {
    logoDataUrl:  templateData.logoDataUrl,
    headerText:   v('t-header'),
    footerText:   v('t-footer'),
    font:         (v('t-font') || 'sans') as InvoiceTemplate['font'],
    accentColor:  v('t-accent') || '#2563EB',
  };
}

function readFormData(): InvoiceFormData {
  const v = (id: string): string => (document.getElementById(id) as HTMLInputElement | null)?.value ?? '';
  const data: InvoiceFormData = {
    invoiceNumber:    v('f-number'),
    invoiceDate:      v('f-date'),
    invoiceType:      v('f-type'),
    currency:         v('f-currency') || 'EUR',
    profile:          v('f-profile'),
    letter:           v('f-letter'),
    notes:            v('f-notes'),
    sellerName:       v('f-seller-name'),
    sellerStreet:     v('f-seller-street'),
    sellerCity:       v('f-seller-city'),
    sellerPostalCode: v('f-seller-postal'),
    sellerCountry:    v('f-seller-country'),
    sellerVatId:      v('f-seller-vat'),
    sellerTaxNumber:  v('f-seller-tax'),
    buyerName:        v('f-buyer-name'),
    buyerReference:   v('f-buyer-ref'),
    buyerStreet:      v('f-buyer-street'),
    buyerCity:        v('f-buyer-city'),
    buyerPostalCode:  v('f-buyer-postal'),
    buyerCountry:     v('f-buyer-country'),
    buyerVatId:       v('f-buyer-vat'),
    paymentMeansCode: v('f-pm-code'),
    iban:             v('f-iban'),
    bic:              v('f-bic'),
    paymentReference: v('f-pay-ref'),
    paymentTerms:     v('f-pay-terms'),
    dueDate:          v('f-due'),
    lineItems: [],
  };

  const rows = document.querySelectorAll<HTMLTableRowElement>('#line-items-body tr');
  rows.forEach((row) => {
    data.lineItems.push({
      description: (row.querySelector('.line-desc')  as HTMLInputElement).value,
      quantity:    (row.querySelector('.line-qty')   as HTMLInputElement).value  || '1',
      unitCode:    (row.querySelector('.line-unit')  as HTMLInputElement).value  || 'C62',
      unitPrice:   (row.querySelector('.line-price') as HTMLInputElement).value  || '0',
      vatRate:     (row.querySelector('.line-vat')   as HTMLInputElement).value  || '0',
    });
  });

  return data;
}

export function updatePreview(): void {
  formData   = readFormData();
  templateData = { ...templateData, ...readTemplateData() };
  saveTemplate(templateData);

  const frame = document.getElementById('create-preview-frame') as HTMLIFrameElement | null;
  if (!frame) return;

  // Scale A4 content (210mm ≈ 794px at 96 dpi) to fill the preview panel
  const A4_PX = Math.round(210 / 25.4 * 96); // 794
  const availPx = frame.offsetWidth || frame.parentElement?.clientWidth || A4_PX;
  const zoom = (availPx / A4_PX).toFixed(4);

  const ctx = buildPreviewContext(formData, templateData);
  let html = _compiledInvoiceTemplate(ctx);

  // Inject zoom only for screen display; Puppeteer uses print mode and ignores @media screen
  html = html.replace(
    '</head>',
    `<style>@media screen{html{zoom:${zoom};overflow-x:hidden}}</style></head>`
  );

  frame.srcdoc = html;
}

function addLineRow(item?: LineItem): void {
  const tbody = document.getElementById('line-items-body');
  if (!tbody) return;
  const idx = tbody.querySelectorAll('tr').length;
  const defaultItem: LineItem = item ?? { description: '', quantity: '1', unitCode: 'C62', unitPrice: '', vatRate: '21' };
  const tr = document.createElement('tr');
  tr.setAttribute('data-line', String(idx));
  tr.innerHTML = lineItemRow(defaultItem, idx).replace(/^<tr[^>]*>/, '').replace(/<\/tr>$/, '');
  tbody.appendChild(tr);
  wireLineRow(tr);
}

function wireLineRow(row: HTMLTableRowElement): void {
  row.querySelectorAll('input').forEach((input) => {
    input.addEventListener('input', updatePreview);
  });
  const removeBtn = row.querySelector('.remove-line-btn') as HTMLButtonElement | null;
  if (removeBtn) {
    removeBtn.addEventListener('click', () => {
      row.remove();
      updatePreview();
    });
  }
}

export function loadFormData(data: InvoiceFormData): void {
  formData = data;
  initCreateScreen();
}

export function initCreateScreen(): void {
  const formPanel = document.getElementById('create-form-panel');
  if (!formPanel) return;
  formPanel.innerHTML = buildTemplateFormHtml(templateData) + buildFormHtml(formData);

  // Text inputs and textareas: 'input' fires on every keystroke
  formPanel.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
    'input:not([type="file"]):not([type="color"]), textarea'
  ).forEach((el) => el.addEventListener('input', updatePreview));

  // Selects: use 'change' — 'input' is not reliably fired on <select> across browsers
  formPanel.querySelectorAll<HTMLSelectElement>('select')
    .forEach((el) => el.addEventListener('change', updatePreview));

  // Color picker: 'input' fires on every drag
  formPanel.querySelectorAll<HTMLInputElement>('input[type="color"]')
    .forEach((el) => el.addEventListener('input', updatePreview));

  // Logo upload
  const logoInput   = document.getElementById('t-logo') as HTMLInputElement | null;
  const logoBtnEl   = document.getElementById('t-logo-btn');
  const logoPreview = document.getElementById('t-logo-preview');

  if (logoBtnEl && logoInput) {
    logoBtnEl.addEventListener('click', () => logoInput.click());
    logoInput.addEventListener('change', () => {
      const file = logoInput.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (e) => {
        templateData.logoDataUrl = (e.target?.result as string) ?? '';
        saveTemplate(templateData);
        logoInput.value = '';
        if (logoPreview) {
          logoPreview.innerHTML = templateData.logoDataUrl
            ? `<img src="${templateData.logoDataUrl}" class="logo-thumb" alt="Logo"><button type="button" id="t-logo-remove" class="logo-remove-btn" title="Remove logo">&times;</button>`
            : '';
        }
        updatePreview();
      };
      reader.readAsDataURL(file);
    });
  }

  // Logo remove button (may appear after upload; use delegation)
  if (logoPreview) {
    logoPreview.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.logo-remove-btn')) {
        templateData.logoDataUrl = '';
        saveTemplate(templateData);
        logoPreview.innerHTML = '';
        updatePreview();
      }
    });
  }

  // Wire existing line item rows
  const tbody = document.getElementById('line-items-body');
  if (tbody) {
    tbody.querySelectorAll<HTMLTableRowElement>('tr').forEach(wireLineRow);
  }

  // Add line button
  const addBtn = document.getElementById('add-line-btn');
  if (addBtn) {
    addBtn.addEventListener('click', () => { addLineRow(); updatePreview(); });
  }

  // Generate PDF button
  const genBtn = document.getElementById('generate-pdf-btn');
  if (genBtn) {
    genBtn.addEventListener('click', () => void handleGeneratePdf());
  }

  // Import CSV/Excel
  const importBtn = document.getElementById('import-data-btn');
  const importInput = document.getElementById('import-file-input') as HTMLInputElement | null;
  if (importBtn && importInput) {
    importBtn.addEventListener('click', () => importInput.click());
    importInput.addEventListener('change', async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      importInput.value = '';
      if (!file) return;
      const errEl = document.getElementById('create-error');
      try {
        if (errEl) errEl.classList.add('hidden');
        loadFormData(await parseImportFile(file));
      } catch (err) {
        if (errEl) {
          errEl.textContent = err instanceof Error ? err.message : String(err);
          errEl.classList.remove('hidden');
        }
      }
    });
  }

  // Template downloads
  const dlCsvBtn = document.getElementById('dl-csv-template');
  if (dlCsvBtn) dlCsvBtn.addEventListener('click', (e) => { e.preventDefault(); downloadCsvTemplate(); });
  const dlXlsxBtn = document.getElementById('dl-xlsx-template');
  if (dlXlsxBtn) dlXlsxBtn.addEventListener('click', (e) => { e.preventDefault(); downloadExcelTemplate(); });

  // Download XML button
  const dlXmlBtn = document.getElementById('download-xml-btn-create');
  if (dlXmlBtn) {
    dlXmlBtn.addEventListener('click', () => {
      const xml = buildCiiXml(readFormData());
      const blob = new Blob([xml], { type: 'application/xml' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `invoice-${(readFormData().invoiceNumber || 'draft').replace(/[^a-zA-Z0-9-_]/g, '_')}.xml`;
      a.click();
      URL.revokeObjectURL(url);
    });
  }

  updatePreview();
  // Re-render after layout paint so frame.offsetWidth is available for zoom calculation
  requestAnimationFrame(updatePreview);
  // Fetch the live template from the backend and re-render — picks up any edits to
  // invoice.hbs without requiring a frontend rebuild
  void refreshTemplateFromBackend().then(updatePreview);

  // Keep zoom correct if the panel is resized (e.g. window resize)
  const frame = document.getElementById('create-preview-frame');
  if (frame && typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(updatePreview).observe(frame);
  }
}

async function handleGeneratePdf(): Promise<void> {
  if (generating) return;
  generating = true;

  const btn = document.getElementById('generate-pdf-btn') as HTMLButtonElement | null;
  const errEl = document.getElementById('create-error');
  if (errEl) errEl.classList.add('hidden');
  if (btn) { btn.disabled = true; btn.textContent = 'Generating…'; }

  try {
    const data = readFormData();
    const template = readTemplateData();
    const resp = await fetch('/api/generate-pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data, template }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Server error ${resp.status}: ${text}`);
    }

    const pdfBlob = await resp.blob();
    const url = URL.createObjectURL(pdfBlob);
    const a = document.createElement('a');
    a.href = url;
    const filename = `invoice-${(data.invoiceNumber || 'draft').replace(/[^a-zA-Z0-9-_]/g, '_')}.pdf`;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    if (errEl) {
      errEl.textContent = err instanceof Error ? err.message : String(err);
      errEl.classList.remove('hidden');
    }
  } finally {
    generating = false;
    if (btn) { btn.disabled = false; btn.textContent = 'Generate PDF'; }
  }
}
