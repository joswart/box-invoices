import {
  N,
  find,
  findAll,
  t,
  ct,
  num,
  parseXmlDoc,
  emptyParty,
  PartyInfo,
  LineItemData,
  TaxLineData,
  ExtractedInvoice,
} from './invoice-extractor-types';
import { extractFacturaE, extractKSeF } from './invoice-extractor-national';

// Re-export types so consumers (metadata-mapper, server) need only one import
export type { LineItemData, TaxLineData, ExtractedInvoice };

// ---------------------------------------------------------------------------
// CII (Cross Industry Invoice) extractor — ZUGFeRD 2.x / Factur-X / XRechnung
// ---------------------------------------------------------------------------

function extractCIIParty(partyNode: N): PartyInfo {
  if (!partyNode) return emptyParty();

  const addr = find(partyNode, 'PostalTradeAddress');
  const contact = find(partyNode, 'DefinedTradeContact');

  const taxRegs = findAll(partyNode, 'SpecifiedTaxRegistration');
  let vatId = '';
  let taxNumber = '';
  for (const reg of taxRegs) {
    const idEl = find(reg, 'ID');
    const scheme = idEl?.getAttribute('schemeID') ?? '';
    const val: string = idEl?.textContent?.trim() ?? '';
    if (scheme === 'VA') vatId = val;
    else if (scheme === 'FC') taxNumber = val;
    else if (!taxNumber) taxNumber = val;
  }

  const globalIdEl = find(partyNode, 'GlobalID');
  const globalId: string = globalIdEl?.textContent?.trim() ?? '';

  let contactEmail = '';
  let contactPhone = '';
  if (contact) {
    const emailNode = find(contact, 'EmailURIUniversalCommunication');
    contactEmail = emailNode ? t(emailNode, 'URIID') : '';
    const phoneNode = find(contact, 'TelephoneUniversalCommunication');
    contactPhone = phoneNode ? t(phoneNode, 'CompleteNumber') : '';
  }

  return {
    name: t(partyNode, 'Name'),
    globalId,
    street: addr ? t(addr, 'LineOne') : '',
    city: addr ? t(addr, 'CityName') : '',
    postalCode: addr ? t(addr, 'PostcodeCode') : '',
    country: addr ? t(addr, 'CountryID') : '',
    vatId,
    taxNumber,
    contactName: contact ? t(contact, 'PersonName') : '',
    contactEmail,
    contactPhone,
  };
}

function extractCII(doc: N): ExtractedInvoice {
  // --- Profile ---
  const ctxParam = find(doc, 'GuidelineSpecifiedDocumentContextParameter');
  const profileUri = ctxParam ? t(ctxParam, 'ID') : '';

  // --- ExchangedDocument ---
  const exDoc = find(doc, 'ExchangedDocument');
  const invoiceNumber = exDoc ? ct(exDoc, 'ID') : '';
  const typeCode = exDoc ? ct(exDoc, 'TypeCode') : '';
  const documentName = exDoc ? ct(exDoc, 'Name') : '';
  const issueDtNode = exDoc ? find(exDoc, 'IssueDateTime') : null;
  const invoiceDate = issueDtNode ? t(issueDtNode, 'DateTimeString') : '';
  const noteNode = exDoc ? find(exDoc, 'IncludedNote') : null;
  const notes = noteNode ? t(noteNode, 'Content') : '';

  // --- Transaction sections ---
  const trx = find(doc, 'SupplyChainTradeTransaction');
  const agreement = trx ? find(trx, 'ApplicableHeaderTradeAgreement') : null;
  const delivery = trx ? find(trx, 'ApplicableHeaderTradeDelivery') : null;
  const settlement = trx ? find(trx, 'ApplicableHeaderTradeSettlement') : null;

  // --- References ---
  const buyerOrderReference = t(find(agreement, 'BuyerOrderReferencedDocument'), 'IssuerAssignedID');
  const sellerOrderReference = t(find(agreement, 'SellerOrderReferencedDocument'), 'IssuerAssignedID');
  const contractReference = t(find(agreement, 'ContractReferencedDocument'), 'IssuerAssignedID');
  const projectReference = t(find(agreement, 'SpecifiedProcuringProject'), 'ID');
  const buyerReference = agreement ? ct(agreement, 'BuyerReference') : '';

  // Delivery note: AdditionalReferencedDocument with TypeCode 916
  let deliveryNoteReference = '';
  if (agreement) {
    for (const addDoc of findAll(agreement, 'AdditionalReferencedDocument')) {
      if (ct(addDoc, 'TypeCode') === '916') {
        deliveryNoteReference = t(addDoc, 'IssuerAssignedID');
        break;
      }
    }
  }
  if (!deliveryNoteReference && delivery) {
    deliveryNoteReference = t(find(delivery, 'DeliveryNoteReferencedDocument'), 'IssuerAssignedID');
  }

  const acctNode = find(settlement, 'ReceivableSpecifiedTradeAccountingAccount');
  const accountingReference = acctNode ? ct(acctNode, 'ID') : '';

  const refInvDoc = find(settlement, 'InvoiceReferencedDocument');
  const referencedInvoiceNumber = refInvDoc ? t(refInvDoc, 'IssuerAssignedID') : '';
  const refInvDtNode = refInvDoc ? find(refInvDoc, 'FormattedIssueDateTime') : null;
  const referencedInvoiceDate = refInvDtNode ? t(refInvDtNode, 'DateTimeString') : '';

  // --- Parties ---
  const seller = extractCIIParty(find(agreement, 'SellerTradeParty'));
  const buyer = extractCIIParty(find(agreement, 'BuyerTradeParty'));

  // --- Ship-to ---
  const shipToParty = find(delivery, 'ShipToTradeParty');
  const shipToAddr = find(shipToParty, 'PostalTradeAddress');
  const shipToName = shipToParty ? t(shipToParty, 'Name') : '';
  const shipToStreet = shipToAddr ? t(shipToAddr, 'LineOne') : '';
  const shipToCity = shipToAddr ? t(shipToAddr, 'CityName') : '';
  const shipToPostalCode = shipToAddr ? t(shipToAddr, 'PostcodeCode') : '';
  const shipToCountry = shipToAddr ? t(shipToAddr, 'CountryID') : '';

  const deliveryDtNode = find(find(delivery, 'ActualDeliverySupplyChainEvent'), 'OccurrenceDateTime');
  const deliveryDate = deliveryDtNode ? t(deliveryDtNode, 'DateTimeString') : '';

  // --- Settlement ---
  const currencyCode = settlement ? ct(settlement, 'InvoiceCurrencyCode') : '';
  const taxCurrencyCode = settlement ? ct(settlement, 'TaxCurrencyCode') : '';
  const paymentReference = settlement ? ct(settlement, 'PaymentReference') : '';

  const payMeans = find(settlement, 'SpecifiedTradeSettlementPaymentMeans');
  const paymentMeansCode = payMeans ? ct(payMeans, 'TypeCode') : '';
  const creditorAcct = find(payMeans, 'PayeePartyCreditorFinancialAccount');
  const iban = creditorAcct ? t(creditorAcct, 'IBANID') : '';
  const creditorInst = find(payMeans, 'PayeeSpecifiedCreditorFinancialInstitution');
  const bic = creditorInst ? t(creditorInst, 'BICID') : '';

  const payTerms = find(settlement, 'SpecifiedTradePaymentTerms');
  const paymentTerms = payTerms ? t(payTerms, 'Description') : '';
  const dueDtNode = find(payTerms, 'DueDateDateTime');
  const dueDate = dueDtNode ? t(dueDtNode, 'DateTimeString') : '';

  // Taxes
  const taxEls = findAll(settlement, 'ApplicableTradeTax');
  const taxes: TaxLineData[] = taxEls.map((el) => ({
    categoryCode: t(el, 'CategoryCode'),
    ratePercent: num(t(el, 'RateApplicablePercent')),
    basisAmount: num(t(el, 'BasisAmount')),
    calculatedAmount: num(t(el, 'CalculatedAmount')),
  }));

  // Summation
  const summation = find(settlement, 'SpecifiedTradeSettlementHeaderMonetarySummation');
  const lineExtensionAmount = summation ? num(t(summation, 'LineTotalAmount')) : null;
  const taxBasisTotalAmount = summation ? num(t(summation, 'TaxBasisTotalAmount')) : null;
  const taxTotalAmount = summation ? num(t(summation, 'TaxTotalAmount')) : null;
  const grandTotalAmount = summation ? num(t(summation, 'GrandTotalAmount')) : null;
  const duePayableAmount = summation ? num(t(summation, 'DuePayableAmount')) : null;
  const prepaidAmount = summation ? num(t(summation, 'TotalPrepaidAmount')) : null;

  // --- Line items ---
  const lineEls = findAll(trx, 'IncludedSupplyChainTradeLineItem');
  const lineItems: LineItemData[] = lineEls.map((el) => {
    const product = find(el, 'SpecifiedTradeProduct');
    const lineAgreement = find(el, 'SpecifiedLineTradeAgreement');
    const lineDelivery = find(el, 'SpecifiedLineTradeDelivery');
    const lineSettlement = find(el, 'SpecifiedLineTradeSettlement');

    const globalProductIdEl = find(product, 'GlobalID');
    const globalProductId: string = globalProductIdEl?.textContent?.trim() ?? '';

    const qtyEl = find(lineDelivery, 'BilledQuantity');
    const unitCode: string = qtyEl?.getAttribute('unitCode') ?? '';

    const grossPriceEl = find(lineAgreement, 'GrossPriceProductTradePrice');
    const netPriceEl = find(lineAgreement, 'NetPriceProductTradePrice');

    const lineSummation = find(lineSettlement, 'SpecifiedTradeSettlementLineMonetarySummation');
    const lineTax = find(lineSettlement, 'ApplicableTradeTax');

    const docLine = find(el, 'AssociatedDocumentLineDocument');

    return {
      lineId: docLine ? ct(docLine, 'LineID') : '',
      productName: product ? (t(product, 'Name') || t(product, 'Description')) : '',
      sellerProductId: product ? t(product, 'SellerAssignedID') : '',
      globalProductId,
      billedQuantity: qtyEl ? num(qtyEl.textContent?.trim()) : null,
      unitCode,
      grossUnitPrice: grossPriceEl ? num(t(grossPriceEl, 'ChargeAmount')) : null,
      netUnitPrice: netPriceEl ? num(t(netPriceEl, 'ChargeAmount')) : null,
      lineTotalAmount: lineSummation ? num(t(lineSummation, 'LineTotalAmount')) : null,
      taxRatePercent: lineTax ? num(t(lineTax, 'RateApplicablePercent')) : null,
      taxCategoryCode: lineTax ? t(lineTax, 'CategoryCode') : '',
    };
  });

  const s = seller;
  const b = buyer;

  return {
    format: 'CII',
    invoiceNumber, invoiceDate, typeCode, documentName, profileUri, notes,
    buyerOrderReference, sellerOrderReference, contractReference, projectReference,
    deliveryNoteReference, accountingReference,
    referencedInvoiceNumber, referencedInvoiceDate,
    currencyCode, taxCurrencyCode,
    dueDate, deliveryDate,
    paymentTerms, paymentMeansCode, iban, bic, paymentReference,
    sellerName: s.name, sellerGlobalId: s.globalId,
    sellerStreet: s.street, sellerCity: s.city, sellerPostalCode: s.postalCode,
    sellerCountry: s.country, sellerVatId: s.vatId, sellerTaxNumber: s.taxNumber,
    sellerContactName: s.contactName, sellerContactEmail: s.contactEmail,
    sellerContactPhone: s.contactPhone,
    buyerName: b.name, buyerGlobalId: b.globalId,
    buyerStreet: b.street, buyerCity: b.city, buyerPostalCode: b.postalCode,
    buyerCountry: b.country, buyerVatId: b.vatId, buyerReference,
    buyerContactName: b.contactName, buyerContactEmail: b.contactEmail,
    shipToName, shipToStreet, shipToCity, shipToPostalCode, shipToCountry,
    lineExtensionAmount, taxBasisTotalAmount, taxTotalAmount,
    grandTotalAmount, duePayableAmount, prepaidAmount,
    taxes, lineItems,
  };
}

// ---------------------------------------------------------------------------
// UBL (Universal Business Language) extractor — XRechnung / EN16931
// ---------------------------------------------------------------------------

function extractUBLParty(supplierOrCustomerEl: N): PartyInfo {
  if (!supplierOrCustomerEl) return emptyParty();
  const party = find(supplierOrCustomerEl, 'Party');
  if (!party) return emptyParty();

  const postalAddr = find(party, 'PostalAddress');
  const countryEl = find(postalAddr, 'Country');
  const taxScheme = find(party, 'PartyTaxScheme');
  const legalEntity = find(party, 'PartyLegalEntity');
  const contact = find(party, 'Contact');
  const partyId = find(party, 'PartyIdentification');

  return {
    name: t(party, 'RegistrationName') || t(party, 'Name'),
    globalId: partyId ? t(partyId, 'ID') : '',
    street: postalAddr ? t(postalAddr, 'StreetName') : '',
    city: postalAddr ? t(postalAddr, 'CityName') : '',
    postalCode: postalAddr ? t(postalAddr, 'PostalZone') : '',
    country: countryEl ? t(countryEl, 'IdentificationCode') : '',
    vatId: taxScheme ? t(taxScheme, 'CompanyID') : '',
    taxNumber: legalEntity ? t(legalEntity, 'CompanyID') : '',
    contactName: contact ? t(contact, 'Name') : '',
    contactEmail: contact ? t(contact, 'ElectronicMail') : '',
    contactPhone: contact ? t(contact, 'Telephone') : '',
  };
}

function extractUBL(doc: N): ExtractedInvoice {
  const isCredit = doc.documentElement?.localName === 'CreditNote';

  const profileUri = t(doc, 'CustomizationID') || t(doc, 'ProfileID');
  const invoiceNumber = t(doc, 'ID');
  const typeCode = t(doc, isCredit ? 'CreditNoteTypeCode' : 'InvoiceTypeCode');
  const invoiceDate = t(doc, 'IssueDate');
  const notes = t(doc, 'Note');
  const currencyCode = t(doc, 'DocumentCurrencyCode');
  const taxCurrencyCode = t(doc, 'TaxCurrencyCode');
  const buyerReference = t(doc, 'BuyerReference');

  // References
  const orderRef = find(doc, 'OrderReference');
  const buyerOrderReference = orderRef ? t(orderRef, 'ID') : '';
  const sellerOrderReference = orderRef ? t(orderRef, 'SalesOrderID') : '';

  const contractDocRef = find(doc, 'ContractDocumentReference');
  const contractReference = contractDocRef ? t(contractDocRef, 'ID') : '';

  const projRef = find(doc, 'ProjectReference');
  const projectReference = projRef ? t(projRef, 'ID') : '';

  const despatchDocRef = find(doc, 'DespatchDocumentReference');
  const deliveryNoteReference = despatchDocRef ? t(despatchDocRef, 'ID') : '';

  const accountingReference = t(doc, 'AccountingCostCode') || t(doc, 'AccountingCost');

  const billingRef = find(doc, 'BillingReference');
  const prevInvDocRef = billingRef ? find(billingRef, 'InvoiceDocumentReference') : null;
  const referencedInvoiceNumber = prevInvDocRef ? t(prevInvDocRef, 'ID') : '';
  const referencedInvoiceDate = prevInvDocRef ? t(prevInvDocRef, 'IssueDate') : '';

  // Parties
  const seller = extractUBLParty(find(doc, 'AccountingSupplierParty'));
  const buyer = extractUBLParty(find(doc, 'AccountingCustomerParty'));

  // Ship-to / Delivery
  const delivSection = find(doc, 'Delivery');
  let shipToName = '', shipToStreet = '', shipToCity = '', shipToPostalCode = '', shipToCountry = '';
  let deliveryDate = '';
  if (delivSection) {
    const shipAddr = find(delivSection, 'DeliveryAddress') ?? find(delivSection, 'Address');
    if (shipAddr) {
      const shipCountry = find(shipAddr, 'Country');
      shipToStreet = t(shipAddr, 'StreetName');
      shipToCity = t(shipAddr, 'CityName');
      shipToPostalCode = t(shipAddr, 'PostalZone');
      shipToCountry = shipCountry ? t(shipCountry, 'IdentificationCode') : '';
    }
    const delivLoc = find(delivSection, 'DeliveryLocation');
    if (delivLoc) shipToName = t(delivLoc, 'Name') || t(delivLoc, 'ID');
    deliveryDate = t(delivSection, 'ActualDeliveryDate');
  }

  // Payment means
  const payMeans = find(doc, 'PaymentMeans');
  const paymentMeansCode = payMeans ? t(payMeans, 'PaymentMeansCode') : '';
  const payeeAcct = find(payMeans, 'PayeeFinancialAccount');
  const iban = payeeAcct ? ct(payeeAcct, 'ID') : '';
  const finInstBranch = find(payeeAcct, 'FinancialInstitutionBranch');
  const bic = finInstBranch ? ct(finInstBranch, 'ID') : '';
  const paymentReference = payMeans ? t(payMeans, 'PaymentID') : '';

  const payTermsEl = find(doc, 'PaymentTerms');
  const paymentTerms = payTermsEl ? t(payTermsEl, 'Note') : '';
  const dueDate = t(doc, 'DueDate') || (payMeans ? t(payMeans, 'PaymentDueDate') : '');

  // Taxes
  const taxSubtotals = findAll(doc, 'TaxSubtotal');
  const taxes: TaxLineData[] = taxSubtotals.map((el) => {
    const cat = find(el, 'TaxCategory');
    return {
      categoryCode: cat ? t(cat, 'ID') : '',
      ratePercent: num(cat ? t(cat, 'Percent') : ''),
      basisAmount: num(t(el, 'TaxableAmount')),
      calculatedAmount: num(t(el, 'TaxAmount')),
    };
  });

  // Monetary totals
  const monetary = find(doc, 'LegalMonetaryTotal');
  const lineExtensionAmount = monetary ? num(t(monetary, 'LineExtensionAmount')) : null;
  const taxBasisTotalAmount = monetary ? num(t(monetary, 'TaxExclusiveAmount')) : null;
  const taxTotalAmount = num(t(doc, 'TaxAmount'));
  const grandTotalAmount = monetary ? num(t(monetary, 'TaxInclusiveAmount')) : null;
  const duePayableAmount = monetary ? num(t(monetary, 'PayableAmount')) : null;
  const prepaidAmount = monetary ? num(t(monetary, 'PrepaidAmount')) : null;

  // Line items
  const lineEls = findAll(doc, isCredit ? 'CreditNoteLine' : 'InvoiceLine');
  const lineItems: LineItemData[] = lineEls.map((el, idx) => {
    const item = find(el, 'Item');
    const price = find(el, 'Price');
    const classTax = find(item, 'ClassifiedTaxCategory');
    const sellerId = find(item, 'SellersItemIdentification');
    const standardId = find(item, 'StandardItemIdentification');

    const qtyEl = find(el, isCredit ? 'CreditedQuantity' : 'InvoicedQuantity');
    const unitCode: string = qtyEl?.getAttribute('unitCode') ?? '';

    const priceAmount = price ? num(t(price, 'PriceAmount')) : null;

    return {
      lineId: t(el, 'ID') || String(idx + 1),
      productName: item ? (t(item, 'Name') || t(item, 'Description')) : '',
      sellerProductId: sellerId ? t(sellerId, 'ID') : '',
      globalProductId: standardId ? t(standardId, 'ID') : '',
      billedQuantity: qtyEl ? num(qtyEl.textContent?.trim()) : null,
      unitCode,
      grossUnitPrice: priceAmount,
      netUnitPrice: priceAmount,
      lineTotalAmount: num(t(el, 'LineExtensionAmount')),
      taxRatePercent: classTax ? num(t(classTax, 'Percent')) : null,
      taxCategoryCode: classTax ? t(classTax, 'ID') : '',
    };
  });

  const s = seller;
  const b = buyer;

  return {
    format: 'UBL',
    invoiceNumber, invoiceDate, typeCode, documentName: '', profileUri, notes,
    buyerOrderReference, sellerOrderReference, contractReference, projectReference,
    deliveryNoteReference, accountingReference,
    referencedInvoiceNumber, referencedInvoiceDate,
    currencyCode, taxCurrencyCode,
    dueDate, deliveryDate,
    paymentTerms, paymentMeansCode, iban, bic, paymentReference,
    sellerName: s.name, sellerGlobalId: s.globalId,
    sellerStreet: s.street, sellerCity: s.city, sellerPostalCode: s.postalCode,
    sellerCountry: s.country, sellerVatId: s.vatId, sellerTaxNumber: s.taxNumber,
    sellerContactName: s.contactName, sellerContactEmail: s.contactEmail,
    sellerContactPhone: s.contactPhone,
    buyerName: b.name, buyerGlobalId: b.globalId,
    buyerStreet: b.street, buyerCity: b.city, buyerPostalCode: b.postalCode,
    buyerCountry: b.country, buyerVatId: b.vatId, buyerReference,
    buyerContactName: b.contactName, buyerContactEmail: b.contactEmail,
    shipToName, shipToStreet, shipToCity, shipToPostalCode, shipToCountry,
    lineExtensionAmount, taxBasisTotalAmount, taxTotalAmount,
    grandTotalAmount, duePayableAmount, prepaidAmount,
    taxes, lineItems,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function extractInvoice(xmlString: string): ExtractedInvoice {
  const doc = parseXmlDoc(xmlString);
  const rootName: string = doc.documentElement?.localName ?? '';

  if (rootName === 'CrossIndustryInvoice') return extractCII(doc);
  if (rootName === 'Invoice' || rootName === 'CreditNote') return extractUBL(doc);
  if (rootName === 'Facturae') return extractFacturaE(doc);
  if (rootName === 'Faktura') return extractKSeF(doc);

  throw new Error(`Unsupported XML root element: <${rootName}>`);
}
