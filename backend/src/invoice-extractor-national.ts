import {
  N,
  find,
  findAll,
  t,
  ct,
  num,
  emptyParty,
  PartyInfo,
  LineItemData,
  TaxLineData,
  ExtractedInvoice,
} from './invoice-extractor-types';

// ---------------------------------------------------------------------------
// FacturaE 3.2.x extractor — Spain
// ---------------------------------------------------------------------------

function extractFEParty(party: N): PartyInfo {
  if (!party) return emptyParty();

  const taxId = find(party, 'TaxIdentification');
  const vatId = taxId ? t(taxId, 'TaxIdentificationNumber') : '';

  const legal = find(party, 'LegalEntity');
  const individual = find(party, 'Individual');
  const name = legal
    ? t(legal, 'CorporateName')
    : individual
      ? [t(individual, 'Name'), t(individual, 'FirstSurname'), t(individual, 'SecondSurname')]
          .filter(Boolean).join(' ')
      : '';

  const addrSpain = find(party, 'AddressInSpain');
  const addrOverseas = find(party, 'OverseasAddress');
  const addr = addrSpain ?? addrOverseas;

  const contact = find(party, 'ContactDetails');

  return {
    name,
    globalId: '',
    street: addr ? t(addr, 'Address') : '',
    city: addr ? t(addr, 'Town') : '',
    postalCode: addr ? t(addr, 'PostCode') : '',
    country: addr ? (t(addr, 'CountryCode') || 'ES') : 'ES',
    vatId,
    taxNumber: '',
    contactName: contact ? t(contact, 'ContactPersons') : '',
    contactEmail: contact ? t(contact, 'ElectronicMail') : '',
    contactPhone: contact ? t(contact, 'Telephone') : '',
  };
}

export function extractFacturaE(doc: N): ExtractedInvoice {
  const fileHeader = find(doc, 'FileHeader');
  const schemaVersion = fileHeader ? t(fileHeader, 'SchemaVersion') : '3.2';
  const profileUri = `urn:facturae:${schemaVersion}`;

  const seller = extractFEParty(find(doc, 'SellerParty'));
  const buyer = extractFEParty(find(doc, 'BuyerParty'));

  const invoice = find(doc, 'Invoice');
  const header = invoice ? find(invoice, 'InvoiceHeader') : null;
  const issueData = invoice ? find(invoice, 'InvoiceIssueData') : null;

  const seriesCode = header ? t(header, 'InvoiceSeriesCode') : '';
  const invoiceNum = header ? t(header, 'InvoiceNumber') : '';
  const invoiceNumber = [seriesCode, invoiceNum].filter(Boolean).join('-');
  const typeCode = header ? t(header, 'InvoiceDocumentType') : '';

  const invoiceDate = issueData ? t(issueData, 'IssueDate') : '';
  const currencyCode = issueData ? t(issueData, 'InvoiceCurrencyCode') : '';
  const taxCurrencyCode = issueData ? (t(issueData, 'TaxCurrencyCode') || currencyCode) : '';
  const deliveryDate = issueData ? t(issueData, 'OperationDate') : '';
  const buyerOrderReference = issueData ? t(issueData, 'ReceiverContractReference') : '';
  const contractReference = issueData ? t(issueData, 'ContractReference') : '';

  const payDetails = invoice ? find(invoice, 'PaymentDetails') : null;
  const installment = payDetails ? find(payDetails, 'Installment') : null;
  const dueDate = installment ? t(installment, 'InstallmentDueDate') : '';
  const paymentMeansCode = installment ? t(installment, 'PaymentMeans') : '';
  const creditorAcct = installment ? find(installment, 'AccountToBeCredited') : null;
  const iban = creditorAcct ? t(creditorAcct, 'IBAN') : '';

  const taxesNode = invoice ? find(invoice, 'TaxesOutputs') : null;
  const taxEls = taxesNode ? findAll(taxesNode, 'Tax') : [];
  const taxes: TaxLineData[] = taxEls.map((el) => {
    const feTypeCode = t(el, 'TaxTypeCode');
    // 01=IVA→S, 02=IPSI→M, 03=IGIC→L, 05=IRPF (withholding, skip category)
    const categoryCode = feTypeCode === '01' ? 'S' : feTypeCode === '03' ? 'L' : feTypeCode === '02' ? 'M' : 'S';
    return {
      categoryCode,
      ratePercent: num(t(el, 'TaxRate')),
      basisAmount: num(t(find(el, 'TaxableBase'), 'TotalAmount')),
      calculatedAmount: num(t(find(el, 'TaxAmount'), 'TotalAmount')),
    };
  });

  const totals = invoice ? find(invoice, 'InvoiceTotals') : null;
  const lineExtensionAmount = totals ? num(t(totals, 'TotalGrossAmountBeforeTaxes')) : null;
  const taxTotalAmount = totals ? num(t(totals, 'TotalTaxOutputs')) : null;
  const grandTotalAmount = totals ? num(t(totals, 'InvoiceTotal')) : null;
  const duePayableAmount = totals ? num(t(totals, 'TotalOutstandingAmount')) : null;

  const correctiveDetails = invoice ? find(invoice, 'CorrectiveDetails') : null;
  const referencedInvoiceNumber = correctiveDetails ? t(correctiveDetails, 'InvoicesRelated') : '';

  const itemsNode = invoice ? find(invoice, 'Items') : null;
  const lineEls = itemsNode ? findAll(itemsNode, 'InvoiceLine') : [];
  const lineItems: LineItemData[] = lineEls.map((el, idx) => {
    const lineTaxes = find(el, 'TaxesOutputs');
    const lineTax = lineTaxes ? find(lineTaxes, 'Tax') : null;
    const feTypeCode = lineTax ? t(lineTax, 'TaxTypeCode') : '';
    const lineCategoryCode = feTypeCode === '01' ? 'S' : feTypeCode === '03' ? 'L' : feTypeCode === '02' ? 'M' : 'S';
    return {
      lineId: t(el, 'ReceiverTransactionReference') || t(el, 'IssuerTransactionReference') || String(idx + 1),
      productName: t(el, 'ItemDescription'),
      sellerProductId: t(el, 'ArticleCode'),
      globalProductId: '',
      billedQuantity: num(t(el, 'Quantity')),
      unitCode: t(el, 'UnitOfMeasure'),
      grossUnitPrice: num(t(el, 'UnitPriceWithoutTax')),
      netUnitPrice: num(t(el, 'UnitPriceWithoutTax')),
      lineTotalAmount: num(t(el, 'TotalCost')),
      taxRatePercent: lineTax ? num(t(lineTax, 'TaxRate')) : null,
      taxCategoryCode: lineCategoryCode,
    };
  });

  const notes = invoice ? t(find(invoice, 'InvoiceAdditionalData'), 'InvoiceAdditionalInformation') : '';

  const s = seller;
  const b = buyer;

  return {
    format: 'FacturaE',
    invoiceNumber, invoiceDate, typeCode, documentName: '', profileUri, notes,
    buyerOrderReference, sellerOrderReference: '', contractReference, projectReference: '',
    deliveryNoteReference: '', accountingReference: '',
    referencedInvoiceNumber, referencedInvoiceDate: '',
    currencyCode, taxCurrencyCode, dueDate, deliveryDate,
    paymentTerms: '', paymentMeansCode, iban, bic: '', paymentReference: '',
    sellerName: s.name, sellerGlobalId: s.globalId,
    sellerStreet: s.street, sellerCity: s.city, sellerPostalCode: s.postalCode,
    sellerCountry: s.country, sellerVatId: s.vatId, sellerTaxNumber: s.taxNumber,
    sellerContactName: s.contactName, sellerContactEmail: s.contactEmail,
    sellerContactPhone: s.contactPhone,
    buyerName: b.name, buyerGlobalId: b.globalId,
    buyerStreet: b.street, buyerCity: b.city, buyerPostalCode: b.postalCode,
    buyerCountry: b.country, buyerVatId: b.vatId, buyerReference: '',
    buyerContactName: b.contactName, buyerContactEmail: b.contactEmail,
    shipToName: '', shipToStreet: '', shipToCity: '', shipToPostalCode: '', shipToCountry: '',
    lineExtensionAmount,
    taxBasisTotalAmount: lineExtensionAmount,
    taxTotalAmount,
    grandTotalAmount,
    duePayableAmount,
    prepaidAmount: null,
    taxes,
    lineItems,
  };
}

// ---------------------------------------------------------------------------
// KSeF (Krajowy System e-Faktur) extractor — Poland FA(2) / FA(3)
// ---------------------------------------------------------------------------

function extractKSeFParty(node: N): PartyInfo {
  if (!node) return emptyParty();
  const daneId = find(node, 'DaneIdentyfikacyjne');
  const adres = find(node, 'Adres');
  const kontakt = find(node, 'DaneKontaktowe');

  return {
    name: daneId ? t(daneId, 'Nazwa') : '',
    globalId: '',
    street: adres ? t(adres, 'AdresL1') : '',
    // AdresL2 typically contains postcode + city in Polish addresses
    city: adres ? t(adres, 'AdresL2') : '',
    postalCode: '',
    country: adres ? (t(adres, 'KodKraju') || 'PL') : 'PL',
    vatId: daneId ? t(daneId, 'NIP') : '',
    taxNumber: daneId ? t(daneId, 'NIP') : '',
    contactName: '',
    contactEmail: kontakt ? t(kontakt, 'Email') : '',
    contactPhone: kontakt ? t(kontakt, 'Telefon') : '',
  };
}

export function extractKSeF(doc: N): ExtractedInvoice {
  const naglowek = find(doc, 'Naglowek');
  const kodFormularza = naglowek ? t(naglowek, 'KodFormularza') : '';
  const profileUri = `urn:ksef.mf.gov.pl:${kodFormularza.replace(/\s+/g, '')}`;

  const seller = extractKSeFParty(find(doc, 'Podmiot1'));
  const buyer = extractKSeFParty(find(doc, 'Podmiot2'));

  const fa = find(doc, 'Fa');
  const currencyCode = fa ? (ct(fa, 'KodWaluty') || 'PLN') : 'PLN';
  const invoiceDate = fa ? ct(fa, 'P_1') : '';
  const invoiceNumber = fa ? ct(fa, 'P_2') : '';
  const deliveryDate = fa ? ct(fa, 'P_6') : '';

  const rodzajFaktury = fa ? ct(fa, 'RodzajFaktury') : '';
  const typeCodeMap: Record<string, string> = {
    VAT: '380', ZAL: '386', ROZ: '380', UPR: '380',
    KOR: '381', KOR_ZAL: '381', KOR_ROZ: '381',
  };
  const typeCode = typeCodeMap[rodzajFaktury] ?? '380';

  // Tax totals — P_13_1..P_13_6 are tax bases, P_14_1..P_14_6 are tax amounts
  // Standard Polish VAT rates: slot 1=23%, 2=8%, 3=5%, 4=0%, 5=exempt(ZW), 6=not-subject(NP)
  const slotRates: Array<number | null> = [23, 8, 5, 0, null, null];
  const slotCategories = ['S', 'S', 'S', 'Z', 'E', 'O'];

  let taxBasisTotal = 0;
  let taxAmountTotal = 0;
  const taxes: TaxLineData[] = [];

  for (let i = 0; i < 6; i++) {
    const baseField = `P_13_${i + 1}`;
    const taxField = `P_14_${i + 1}`;
    const base = fa ? num(t(fa, baseField)) : null;
    if (base !== null) {
      const taxAmt = fa ? num(t(fa, taxField)) : null;
      taxBasisTotal += base;
      taxAmountTotal += taxAmt ?? 0;
      taxes.push({
        categoryCode: slotCategories[i],
        ratePercent: slotRates[i],
        basisAmount: base,
        calculatedAmount: taxAmt,
      });
    }
  }

  const grandTotalAmount = fa ? num(t(fa, 'P_15')) : null;

  const platnosc = fa ? find(fa, 'Platnosc') : null;
  const terminNode = platnosc ? find(platnosc, 'TerminPlatnosci') : null;
  const dueDate = terminNode ? t(terminNode, 'Termin') : '';
  const numerKonta = platnosc ? t(platnosc, 'NumerKonta') : '';
  // Polish NRB account numbers (26 digits) in KSeF omit the country prefix
  const iban = numerKonta
    ? (numerKonta.startsWith('PL') ? numerKonta : `PL${numerKonta}`)
    : '';
  const paymentReference = platnosc ? t(platnosc, 'TytulPlatnosci') : '';

  const buyerOrderReference = fa ? t(fa, 'NumerZamowienia') : '';
  const contractReference = fa ? t(fa, 'NumerUmowy') : '';

  const lineEls = fa ? findAll(fa, 'FaWiersz') : [];
  const lineItems: LineItemData[] = lineEls.map((el, idx) => {
    const vatRateRaw = t(el, 'P_12');
    const vatRateNum = (vatRateRaw === 'zw' || vatRateRaw === 'np' || vatRateRaw === '')
      ? null
      : num(vatRateRaw);
    const categoryCode = vatRateRaw === 'zw' ? 'E' : vatRateRaw === 'np' ? 'O' : vatRateNum === 0 ? 'Z' : 'S';
    return {
      lineId: t(el, 'NrWierszaFa') || String(idx + 1),
      productName: t(el, 'P_7'),
      sellerProductId: '',
      globalProductId: '',
      billedQuantity: num(t(el, 'P_8B')),
      unitCode: t(el, 'P_8A'),
      grossUnitPrice: num(t(el, 'P_9B')) ?? num(t(el, 'P_9A')),
      netUnitPrice: num(t(el, 'P_9A')),
      lineTotalAmount: num(t(el, 'P_11')),
      taxRatePercent: vatRateNum,
      taxCategoryCode: categoryCode,
    };
  });

  const s = seller;
  const b = buyer;

  return {
    format: 'KSeF',
    invoiceNumber, invoiceDate, typeCode, documentName: '', profileUri, notes: '',
    buyerOrderReference, sellerOrderReference: '', contractReference, projectReference: '',
    deliveryNoteReference: '', accountingReference: '',
    referencedInvoiceNumber: '', referencedInvoiceDate: '',
    currencyCode, taxCurrencyCode: currencyCode, dueDate, deliveryDate,
    paymentTerms: '', paymentMeansCode: platnosc ? t(platnosc, 'FormaPlatnosci') : '',
    iban, bic: '', paymentReference,
    sellerName: s.name, sellerGlobalId: s.globalId,
    sellerStreet: s.street, sellerCity: s.city, sellerPostalCode: s.postalCode,
    sellerCountry: s.country, sellerVatId: s.vatId, sellerTaxNumber: s.taxNumber,
    sellerContactName: s.contactName, sellerContactEmail: s.contactEmail,
    sellerContactPhone: s.contactPhone,
    buyerName: b.name, buyerGlobalId: b.globalId,
    buyerStreet: b.street, buyerCity: b.city, buyerPostalCode: b.postalCode,
    buyerCountry: b.country, buyerVatId: b.vatId, buyerReference: '',
    buyerContactName: b.contactName, buyerContactEmail: b.contactEmail,
    shipToName: '', shipToStreet: '', shipToCity: '', shipToPostalCode: '', shipToCountry: '',
    lineExtensionAmount: taxBasisTotal > 0 ? taxBasisTotal : null,
    taxBasisTotalAmount: taxBasisTotal > 0 ? taxBasisTotal : null,
    taxTotalAmount: taxAmountTotal > 0 ? taxAmountTotal : null,
    grandTotalAmount,
    duePayableAmount: grandTotalAmount,
    prepaidAmount: null,
    taxes,
    lineItems,
  };
}
