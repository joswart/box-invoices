// ============================================================
// Types
// ============================================================

export interface XMPInfo {
  documentType: string;
  fileName: string;
  version: string;
  conformanceLevel: string;
  namespace: string;
}

export interface ValidationResult {
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

export interface UploadSuccess {
  success: true;
  pdfBase64: string;
  xml: string;
  attachmentName: string;
  validation: ValidationResult;
}

export interface UploadError {
  success: false;
  error: string;
}

export type UploadResponse = UploadSuccess | UploadError;

export interface Address {
  name: string;
  street: string;
  city: string;
  postcode: string;
  country: string;
  taxId: string;
  vatId: string;
  email: string;
}

export interface LineItem {
  position: string;
  description: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  total: string;
  taxRate: string;
}

export interface TaxLine {
  category: string;
  rate: string;
  base: string;
  amount: string;
}

export interface Invoice {
  format: 'CII' | 'UBL' | 'FacturaE' | 'KSeF';
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
// Shared utilities
// ============================================================

export function emptyAddress(): Address {
  return { name: '', street: '', city: '', postcode: '', country: '', taxId: '', vatId: '', email: '' };
}

function formatCIIDate(raw: string): string {
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

  const taxEls = settlement ? all(settlement, 'ApplicableTradeTax') : [];
  const taxes: TaxLine[] = taxEls.map((el) => ({
    category: text(el, 'CategoryCode'),
    rate: text(el, 'RateApplicablePercent'),
    base: text(el, 'BasisAmount'),
    amount: text(el, 'CalculatedAmount'),
  }));

  const summation = settlement ? first(settlement, 'SpecifiedTradeSettlementHeaderMonetarySummation') : null;
  const payTerms = settlement ? first(settlement, 'SpecifiedTradePaymentTerms') : null;
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
// FacturaE 3.2.x parser — Spain
// ============================================================

function parseFacturaE(doc: Document): Invoice {
  function parseFeParty(party: Element | null): Address {
    if (!party) return emptyAddress();
    const legal = first(party, 'LegalEntity');
    const individual = first(party, 'Individual');
    const name = legal
      ? text(legal, 'CorporateName')
      : individual
        ? [text(individual, 'Name'), text(individual, 'FirstSurname'), text(individual, 'SecondSurname')]
            .filter(Boolean).join(' ')
        : '';
    const taxId = first(party, 'TaxIdentification');
    const vatId = taxId ? text(taxId, 'TaxIdentificationNumber') : '';
    const addrEl = first(party, 'AddressInSpain') ?? first(party, 'OverseasAddress');
    const contact = first(party, 'ContactDetails');
    return {
      name,
      street: addrEl ? text(addrEl, 'Address') : '',
      city: addrEl ? text(addrEl, 'Town') : '',
      postcode: addrEl ? text(addrEl, 'PostCode') : '',
      country: addrEl ? (text(addrEl, 'CountryCode') || 'ES') : 'ES',
      taxId: '',
      vatId,
      email: contact ? text(contact, 'ElectronicMail') : '',
    };
  }

  const invoice = first(doc, 'Invoice');
  const header = invoice ? first(invoice, 'InvoiceHeader') : null;
  const issueData = invoice ? first(invoice, 'InvoiceIssueData') : null;

  const seriesCode = header ? text(header, 'InvoiceSeriesCode') : '';
  const invoiceNum = header ? text(header, 'InvoiceNumber') : '';
  const id = [seriesCode, invoiceNum].filter(Boolean).join('-');
  const typeCode = header ? text(header, 'InvoiceDocumentType') : '';

  const payDetails = invoice ? first(invoice, 'PaymentDetails') : null;
  const installment = payDetails ? first(payDetails, 'Installment') : null;
  const dueDate = installment ? text(installment, 'InstallmentDueDate') : '';

  const taxesNode = invoice ? first(invoice, 'TaxesOutputs') : null;
  const taxEls = taxesNode ? all(taxesNode, 'Tax') : [];
  const taxes: TaxLine[] = taxEls.map((el) => {
    const feTypeCode = text(el, 'TaxTypeCode');
    const category = feTypeCode === '01' ? 'S' : feTypeCode === '03' ? 'L' : feTypeCode === '02' ? 'M' : 'S';
    return {
      category,
      rate: text(el, 'TaxRate'),
      base: text(first(el, 'TaxableBase') as Element, 'TotalAmount'),
      amount: text(first(el, 'TaxAmount') as Element, 'TotalAmount'),
    };
  });

  const totals = invoice ? first(invoice, 'InvoiceTotals') : null;
  const netTotal = totals ? text(totals, 'TotalGrossAmountBeforeTaxes') : '';
  const taxTotal = totals ? text(totals, 'TotalTaxOutputs') : '';
  const grossTotal = totals ? text(totals, 'InvoiceTotal') : '';

  const itemsNode = invoice ? first(invoice, 'Items') : null;
  const lineEls = itemsNode ? all(itemsNode, 'InvoiceLine') : [];
  const items: LineItem[] = lineEls.map((el, idx) => {
    const lineTaxes = first(el, 'TaxesOutputs');
    const lineTax = lineTaxes ? first(lineTaxes, 'Tax') : null;
    return {
      position: text(el, 'ReceiverTransactionReference') || text(el, 'IssuerTransactionReference') || String(idx + 1),
      description: text(el, 'ItemDescription'),
      quantity: text(el, 'Quantity'),
      unit: text(el, 'UnitOfMeasure'),
      unitPrice: text(el, 'UnitPriceWithoutTax'),
      total: text(el, 'TotalCost'),
      taxRate: lineTax ? text(lineTax, 'TaxRate') : '',
    };
  });

  const cur = issueData ? text(issueData, 'InvoiceCurrencyCode') : '';
  const feTypeMap: Record<string, string> = {
    FC: 'Complete Invoice', FA: 'Simplified Invoice', AF: 'Self Invoice',
    OR: 'Corrective Invoice', EM: 'Corrective (Substitution)', OC: 'Summary Invoice',
  };

  return {
    format: 'FacturaE',
    id,
    type: feTypeMap[typeCode] ?? (typeCode ? `Type ${typeCode}` : 'Invoice'),
    issueDate: formatISODate(issueData ? text(issueData, 'IssueDate') : ''),
    dueDate: formatISODate(dueDate),
    currency: cur,
    buyerReference: '',
    note: invoice ? text(first(invoice, 'InvoiceAdditionalData') as Element, 'InvoiceAdditionalInformation') : '',
    seller: parseFeParty(first(doc, 'SellerParty')),
    buyer: parseFeParty(first(doc, 'BuyerParty')),
    items,
    taxes,
    netTotal,
    taxTotal,
    grossTotal,
    prepaidAmount: '',
    duePayable: grossTotal,
  };
}

// ============================================================
// KSeF FA(2) / FA(3) parser — Poland
// ============================================================

function parseKSeF(doc: Document): Invoice {
  function parseKSeFParty(node: Element | null): Address {
    if (!node) return emptyAddress();
    const daneId = first(node, 'DaneIdentyfikacyjne');
    const adres = first(node, 'Adres');
    const kontakt = first(node, 'DaneKontaktowe');
    return {
      name: daneId ? text(daneId, 'Nazwa') : '',
      street: adres ? text(adres, 'AdresL1') : '',
      city: adres ? text(adres, 'AdresL2') : '',
      postcode: '',
      country: adres ? (text(adres, 'KodKraju') || 'PL') : 'PL',
      taxId: daneId ? text(daneId, 'NIP') : '',
      vatId: daneId ? text(daneId, 'NIP') : '',
      email: kontakt ? text(kontakt, 'Email') : '',
    };
  }

  const fa = first(doc, 'Fa');
  const currency = fa ? (text(fa, 'KodWaluty') || 'PLN') : 'PLN';
  const rodzaj = fa ? text(fa, 'RodzajFaktury') : '';
  const typeMap: Record<string, string> = {
    VAT: 'VAT Invoice', ZAL: 'Prepayment Invoice', ROZ: 'Final Invoice',
    KOR: 'Corrective Invoice', KOR_ZAL: 'Corrective Prepayment', KOR_ROZ: 'Corrective Final',
    UPR: 'Simplified Invoice',
  };

  const rateLabels = ['23%', '8%', '5%', '0%', 'ZW (exempt)', 'NP (not subject)'];
  const rateValues = ['S', 'S', 'S', 'Z', 'E', 'O'];
  const taxes: TaxLine[] = [];
  for (let i = 0; i < 6; i++) {
    const base = fa ? text(fa, `P_13_${i + 1}`) : '';
    if (base) {
      taxes.push({
        category: rateValues[i],
        rate: rateLabels[i],
        base,
        amount: fa ? text(fa, `P_14_${i + 1}`) : '',
      });
    }
  }

  const lineEls = fa ? all(fa, 'FaWiersz') : [];
  const items: LineItem[] = lineEls.map((el, idx) => {
    const vatRaw = text(el, 'P_12');
    return {
      position: text(el, 'NrWierszaFa') || String(idx + 1),
      description: text(el, 'P_7'),
      quantity: text(el, 'P_8B'),
      unit: text(el, 'P_8A'),
      unitPrice: text(el, 'P_9A'),
      total: text(el, 'P_11'),
      taxRate: vatRaw,
    };
  });

  const platnosc = fa ? first(fa, 'Platnosc') : null;
  const terminNode = platnosc ? first(platnosc, 'TerminPlatnosci') : null;
  const dueDate = terminNode ? text(terminNode, 'Termin') : '';

  const grandTotal = fa ? text(fa, 'P_15') : '';
  const taxBasis = taxes.reduce((s, tx) => s + (parseFloat(tx.base) || 0), 0);
  const taxAmt = taxes.reduce((s, tx) => s + (parseFloat(tx.amount) || 0), 0);

  return {
    format: 'KSeF',
    id: fa ? text(fa, 'P_2') : '',
    type: typeMap[rodzaj] ?? (rodzaj ? `KSeF ${rodzaj}` : 'Invoice'),
    issueDate: formatISODate(fa ? text(fa, 'P_1') : ''),
    dueDate: formatISODate(dueDate),
    currency,
    buyerReference: '',
    note: '',
    seller: parseKSeFParty(first(doc, 'Podmiot1')),
    buyer: parseKSeFParty(first(doc, 'Podmiot2')),
    items,
    taxes,
    netTotal: taxBasis > 0 ? String(taxBasis.toFixed(2)) : '',
    taxTotal: taxAmt > 0 ? String(taxAmt.toFixed(2)) : '',
    grossTotal: grandTotal,
    prepaidAmount: '',
    duePayable: grandTotal,
  };
}

// ============================================================
// Public entry point
// ============================================================

export function parseInvoice(xmlString: string): Invoice {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlString, 'text/xml');
  const rootName = doc.documentElement.localName;
  if (rootName === 'CrossIndustryInvoice') return parseCII(doc);
  if (rootName === 'Invoice' || rootName === 'CreditNote') return parseUBL(doc);
  if (rootName === 'Facturae') return parseFacturaE(doc);
  if (rootName === 'Faktura') return parseKSeF(doc);
  // Fallback: attempt UBL
  return parseUBL(doc);
}
