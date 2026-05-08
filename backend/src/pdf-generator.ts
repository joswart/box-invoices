import fs from 'fs';
import path from 'path';
import Handlebars from 'handlebars';
import puppeteer, { Browser } from 'puppeteer';
import { PDFDocument, AFRelationship, PDFName, PDFString, PDFArray } from 'pdf-lib';

// ---------------------------------------------------------------------------
// Invoice template — visual settings for PDF rendering
// ---------------------------------------------------------------------------

export interface InvoiceTemplate {
  logoDataUrl?: string;    // base64 data URL (PNG or JPEG)
  headerText?: string;     // tagline shown in the top-left header area
  footerText?: string;     // bottom footer line
  font?: 'sans' | 'serif' | 'mono';
  accentColor?: string;    // hex color, e.g. '#2563EB'
}

// ---------------------------------------------------------------------------
// Shared types (mirrored in frontend invoice-form.ts)
// ---------------------------------------------------------------------------

export interface LineItem {
  description: string;
  quantity: string;
  unitCode: string;
  unitPrice: string;
  vatRate: string;
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

// ---------------------------------------------------------------------------
// Profile URI mapping
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Embedded sRGB ICC profile (sRGB IEC61966-2.1, 3144 bytes)
// ---------------------------------------------------------------------------
const SRGB_ICC_B64 =
  'AAAMSExpbm8CEAAAbW50clJHQiBYWVogB84AAgAJAAYAMQAAYWNzcE1TRlQAAAAASUVDIHNSR0IA' +
  'AAAAAAAAAAAAAAAAAPbWAAEAAAAA0y1IUCAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAARY3BydAAAAVAAAAAzZGVzYwAAAYQAAABsd3RwdAAAAfAAAA' +
  'AUYmtwdAAAAgQAAAAUclhZWgAAAhgAAAAUZ1hZWgAAAiwAAAAUYlhZWgAAAkAAAAAUZG1uZAAA' +
  'AlQAAABwZG1kZAAAAsQAAACIdnVlZAAAA0wAAACGdmlldwAAA9QAAAAkbHVtaQAAA/gAAAAUbW' +
  'VhcwAABAwAAAAkdGVjaAAABDAAAAAMclRSQwAABDwAAAgMZ1RSQwAABDwAAAgMYlRSQwAABDwA' +
  'AAgMdGV4dAAAAABDb3B5cmlnaHQgKGMpIDE5OTggSGV3bGV0dC1QYWNrYXJkIENvbXBhbnkA' +
  'AGRlc2MAAAAAAAAAEnNSR0IgSUVDNjE5NjYtMi4xAAAAAAAAAAAAAAASc1JHQiBJRUM2MTk2Ni' +
  '0yLjEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFhZ' +
  'WiAAAAAAAADzUQABAAAAARbMWFlaIAAAAAAAAAAAAAAAAAAAAABYWVogAAAAAAAAb6IAADj1AAAD' +
  'kFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9kZXNjAAAAAAAAABZJRUMg' +
  'aHR0cDovL3d3dy5pZWMuY2gAAAAAAAAAAAAAABZJRUMgaHR0cDovL3d3dy5pZWMuY2gAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAZGVzYwAAAAAAAAAuSUVDIDYx' +
  'OTY2LTIuMSBEZWZhdWx0IFJHQiBjb2xvdXIgc3BhY2UgLSBzUkdCAAAAAAAAAAAAAAAuSUVD' +
  'IDYxOTY2LTIuMSBEZWZhdWx0IFJHQiBjb2xvdXIgc3BhY2UgLSBzUkdCAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAGRlc2MAAAAAAAAALFJlZmVyZW5jZSBWaWV3aW5nIENvbmRpdGlvbiBpbiBJ' +
  'RUM2MTk2Ni0yLjEAAAAAAAAAAAAAACxSZWZlcmVuY2UgVmlld2luZyBDb25kaXRpb24gaW4g' +
  'SUVSNJTE5NjYtMi4xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB2aWV3AAAAAAATpP4AFF8uAB' +
  'DPFAAD7cwABBMLAANcngAAAAFYWVogAAAAAABMCVYAUAAAAFcf521lYXMAAAAAAAAAAQAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAKPAAAAAnNpZyAAAAAAQ1JUIGN1cnYAAAAAAAAEAAAAAAUACgAPABQAGQAe' +
  'ACMAKAAtADIANwA7AEAARQBKAE8AVABZAF4AYwBoAG0AcgB3AHwAgQCGAIsAkACVAJoAnwCk' +
  'AKkArgCyALcAvADBAMYAywDQANUA2wDgAOUA6wDwAPYA+wEBAQcBDQETARkBHwElASsBMgE4' +
  'AT4BRQFMAVIBWQFgAWcBbgF1AXwBgwGLAZIBmgGhAakBsQG5AcEByQHRAdkB4QHpAfIB+gID' +
  'AgwCFAIdAiYCLwI4AkECSwJUAl0CZwJxAnoChAKOApgCogKsArYCwQLLAtUC4ALrAvUDAAML' +
  'AxYDIQMtAzgDQwNPA1oDZgNyA34DigOWA6IDrgO6A8cD0wPgA+wD+QQGBBMEIAQtBDsESARV' +
  'BGMEcQR+BIwEmgSoBLYExATTBOEE8AT+BQ0FHAUrBToFSQVYBWcFdwWGBZYFpgW1BcUF1QXl' +
  'BfYGBgYWBicGNwZIBlkGagZ7BowGnQavBsAG0QbjBvUHBwcZBysHPQdPB2EHdAeGB5kHrAe/' +
  'B9IH5Qf4CAsIHwgyCEYIWghuCIIIlgiqCL4I0gjnCPsJEAklCToJTwlkCXkJjwmkCboJzwnl' +
  'CfsKEQonCj0KVApqCoEKmAquCsUK3ArzCwsLIgs5C1ELaQuAC5gLsAvIC+EL+QwSDCoMQwxc' +
  'DHUMjgynDMAM2QzzDQ0NJg1ADVoNdA2ODakNww3eDfgOEw4uDkkOZA5/DpsOtg7SDu4PCQ8l' +
  'D0EPXg96D5YPsw/PD+wQCRAmEEMQYRB+EJsQuRDXEPURExExEU8RbRGMEaoRyRHoEgcSJhJF' +
  'EmQShBKjEsMS4xMDEyMTQxNjE4MTpBPFE+UUBhQnFEkUahSLFK0UzhTwFRIVNBVWFXgVmxW9' +
  'FeAWAxYmFkkWbBaPFrIW1hb6Fx0XQRdlF4kXrhfSF/cYGxhAGGUYihivGNUY+hkgGUUZaxmR' +
  'GbcZ3RoEGioaURp3Gp4axRrsGxQbOxtjG4obshvaHAIcKhxSHHscoxzMHPUdHh1HHXAdmR3D' +
  'HeweFh5AHmoelB6+HukfEx8+H2kflB+/H+ogFSBBIGwgmCDEIPAhHCFIIXUhoSHOIfsiJyJV' +
  'IoIiryLdIwojOCNmI5QjwiPwJB8kTSR8JKsk2iUJJTglaCWXJccl9yYnJlcmhya3JugnGCdJ' +
  'J3onqyfcKA0oPyhxKKIo1CkGKTgpaymdKdAqAio1KmgqmyrPKwIrNitpK50r0SwFLDksbiyiLNct' +
  'DC1BLXYtqy3hLhYuTC6CLrcu7i8kL1ovkS/HL/4wNTBsMKQw2zESMUoxgjG6MfIyKjJjMpsy' +
  '1DMNM0YzfzO4M/E0KzRlNJ402TUTNU01hzXCNf02NzZyNq426TckN2A3nDfXOBQ4UDiMOMg5' +
  'BTlCOX85vDn5OjY6dDqyOu87LTtrO6o76DwnPGU8pDzjPSI9YT2hPeA+ID5gPqA+4D8hP2E/' +
  'oj/iQCNAZECmQOdBKUFqQaxB7kIwQnJCtUL3QzpDfUPARANER0SKRM5FEkVVRZpF3kYiRmdG' +
  'q0bwRzVHe0fASAVIS0iRSNdJHUljSalJ8Eo3Sn1KxEsMS1NLmkviTCpMcky6TQJNSk2TTdxO' +
  'JU5uTrdPAE9JT5NP3VAnUHFQu1EGUVBRm1HmUjFSfFLHUxNTX1OqU/ZUQlSPVNtVKFV1VcJW' +
  'D1ZcVqlW91dEV5JX4FgvWH1Yy1kaWWlZuFoHWlZaplr1W0VblVvlXDVchlzWXSddeF3JXhpe' +
  'bF69Xw9fYV+zYAVgV2CqYPxhT2GiYfViSWKcYvBjQ2OXY+tkQGSUZOllPWWSZedmPWaSZuhn' +
  'PWeTZ+loP2iWaOxpQ2maafFqSGqfavdrT2una/9sV2yvbQhtYG25bhJua27Ebx5veG/RcCtw' +
  'hnDgcTpxlXHwcktypnMBc11zuHQUdHB0zHUodYV14XY+dpt2+HdWd7N4EXhueMx5KnmJeed6' +
  'RnqlewR7Y3vCfCF8gXzhfUF9oX4BfmJ+wn8jf4R/5YBHgKiBCoFrgc2CMIKSgvSDV4O6hB2E' +
  'gITjhUeFq4YOhnKG14c7h5+IBIhpiM6JM4mZif6KZIrKizCLlov8jGOMyo0xjZiN/45mjs6P' +
  'No+ekAaQbpDWkT+RqJIRknqS45NNk7aUIJSKlPSVX5XJljSWn5cKl3WX4JhMmLiZJJmQmfya' +
  'aJrVm0Kbr5wcnImc951kndKeQJ6unx2fi5/6oGmg2KFHobaiJqKWowajdqPmpFakx6U4pammG' +
  'qaLpv2nbqfgqFKoxKk3qamqHKqPqwKrdavprFys0K1ErbiuLa6hrxavi7AAsHWw6rFgsdayS7' +
  'LCszizrrQltJy1E7WKtgG2ebbwt2i34LhZuNG5SrnCuju6tbsuu6e8IbybvRW9j74KvoS+/79' +
  '6v/XAcMDswWfB48JfwtvDWMPUxFHEzsVLxcjGRsbDx0HHv8g9yLzJOsm5yjjKt8s2y7bMNcy' +
  '1zTXNtc42zrbPN8+40DnQutE80b7SP9LB00TTxtRJ1MvVTtXR1lXW2Ndc1+DYZNjo2WzZ8dp2' +
  '2vvbgNwF3IrdEN2W3hzeot8p36/gNuC94UThzOJT4tvjY+Pr5HPk/OWE5g3mlucf56noMui8' +
  '6Ubp0Opb6uXrcOv77IbtEe2c7ijutO9A78zwWPDl8XLx//KM8xnzp/Q09ML1UPXe9m32+/eK' +
  '+Bn4qPk4+cf6V/rn+3f8B/yY/Sn9uv5L/tz/bf//';

function getSrgbIccBytes(): Buffer {
  return Buffer.from(SRGB_ICC_B64.replace(/\s/g, ''), 'base64');
}

// ---------------------------------------------------------------------------
// Calculation helpers
// ---------------------------------------------------------------------------

interface ComputedLine {
  description: string;
  quantity: number;
  unitCode: string;
  unitPrice: number;
  vatRate: number;
  lineTotal: number;
  idx: number;
}

interface VatGroup {
  rate: number;
  basis: number;
  tax: number;
}

interface Totals {
  lines: ComputedLine[];
  vatGroups: VatGroup[];
  lineTotal: number;
  taxTotal: number;
  grandTotal: number;
}

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
  const lineTotal  = lines.reduce((s, l) => s + l.lineTotal, 0);
  const taxTotal   = vatGroups.reduce((s, g) => s + g.tax, 0);
  return { lines, vatGroups, lineTotal, taxTotal, grandTotal: lineTotal + taxTotal };
}

// ---------------------------------------------------------------------------
// CII XML builder
// ---------------------------------------------------------------------------

function e(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtDate(d: string): string {
  return d.replace(/-/g, '');
}

function opt(xml: string, condition: boolean): string {
  return condition ? xml : '';
}

export function buildCiiXml(data: InvoiceFormData): string {
  const { lines, vatGroups, lineTotal, taxTotal, grandTotal } = computeTotals(data);
  const currency = data.currency || 'EUR';
  const date    = fmtDate(data.invoiceDate || new Date().toISOString().slice(0, 10));
  const dueDate = fmtDate(data.dueDate);

  const lineItemsXml = lines.map((l) => `
    <ram:IncludedSupplyChainTradeLineItem>
      <ram:AssociatedDocumentLineDocument>
        <ram:LineID>${l.idx}</ram:LineID>
      </ram:AssociatedDocumentLineDocument>
      <ram:SpecifiedTradeProduct>
        <ram:Name>${e(l.description || `Item ${l.idx}`)}</ram:Name>
      </ram:SpecifiedTradeProduct>
      <ram:SpecifiedLineTradeAgreement>
        <ram:NetPriceProductTradePrice>
          <ram:ChargeAmount>${l.unitPrice.toFixed(2)}</ram:ChargeAmount>
        </ram:NetPriceProductTradePrice>
      </ram:SpecifiedLineTradeAgreement>
      <ram:SpecifiedLineTradeDelivery>
        <ram:BilledQuantity unitCode="${e(l.unitCode)}">${l.quantity.toFixed(4)}</ram:BilledQuantity>
      </ram:SpecifiedLineTradeDelivery>
      <ram:SpecifiedLineTradeSettlement>
        <ram:ApplicableTradeTax>
          <ram:TypeCode>VAT</ram:TypeCode>
          <ram:CategoryCode>S</ram:CategoryCode>
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

  const sellerAddress = (data.sellerPostalCode || data.sellerStreet || data.sellerCity || data.sellerCountry)
    ? `<ram:PostalTradeAddress>
          ${opt(`<ram:PostcodeCode>${e(data.sellerPostalCode)}</ram:PostcodeCode>`, !!data.sellerPostalCode)}
          ${opt(`<ram:LineOne>${e(data.sellerStreet)}</ram:LineOne>`, !!data.sellerStreet)}
          ${opt(`<ram:CityName>${e(data.sellerCity)}</ram:CityName>`, !!data.sellerCity)}
          ${opt(`<ram:CountryID>${e(data.sellerCountry)}</ram:CountryID>`, !!data.sellerCountry)}
        </ram:PostalTradeAddress>` : '';

  const buyerAddress = (data.buyerPostalCode || data.buyerStreet || data.buyerCity || data.buyerCountry)
    ? `<ram:PostalTradeAddress>
          ${opt(`<ram:PostcodeCode>${e(data.buyerPostalCode)}</ram:PostcodeCode>`, !!data.buyerPostalCode)}
          ${opt(`<ram:LineOne>${e(data.buyerStreet)}</ram:LineOne>`, !!data.buyerStreet)}
          ${opt(`<ram:CityName>${e(data.buyerCity)}</ram:CityName>`, !!data.buyerCity)}
          ${opt(`<ram:CountryID>${e(data.buyerCountry)}</ram:CountryID>`, !!data.buyerCountry)}
        </ram:PostalTradeAddress>` : '';

  const paymentMeansXml = (data.paymentMeansCode || data.iban || data.bic) ? `
      <ram:SpecifiedTradeSettlementPaymentMeans>
        ${opt(`<ram:TypeCode>${e(data.paymentMeansCode)}</ram:TypeCode>`, !!data.paymentMeansCode)}
        ${opt(`<ram:PayeePartyCreditorFinancialAccount>
          <ram:IBANID>${e(data.iban)}</ram:IBANID>
          ${opt(`<ram:ProprietaryID>${e(data.bic)}</ram:ProprietaryID>`, !!data.bic)}
        </ram:PayeePartyCreditorFinancialAccount>`, !!data.iban)}
      </ram:SpecifiedTradeSettlementPaymentMeans>` : '';

  const paymentTermsXml = (data.paymentTerms || data.dueDate) ? `
      <ram:SpecifiedTradePaymentTerms>
        ${opt(`<ram:Description>${e(data.paymentTerms)}</ram:Description>`, !!data.paymentTerms)}
        ${opt(`<ram:DueDateDateTime>
          <udt:DateTimeString format="102">${dueDate}</udt:DateTimeString>
        </ram:DueDateDateTime>`, !!data.dueDate)}
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
    <ram:ID>${e(data.invoiceNumber || 'DRAFT')}</ram:ID>
    <ram:TypeCode>${e(data.invoiceType || '380')}</ram:TypeCode>
    <ram:IssueDateTime>
      <udt:DateTimeString format="102">${date}</udt:DateTimeString>
    </ram:IssueDateTime>
    ${opt(`<ram:IncludedNote><ram:Content>${e(data.notes)}</ram:Content></ram:IncludedNote>`, !!data.notes)}
  </rsm:ExchangedDocument>

  <rsm:SupplyChainTradeTransaction>
    ${lineItemsXml}
    <ram:ApplicableHeaderTradeAgreement>
      ${opt(`<ram:BuyerReference>${e(data.buyerReference)}</ram:BuyerReference>`, !!data.buyerReference)}
      <ram:SellerTradeParty>
        <ram:Name>${e(data.sellerName || 'Seller')}</ram:Name>
        ${sellerAddress}
        ${opt(`<ram:SpecifiedTaxRegistration>
          <ram:ID schemeID="VA">${e(data.sellerVatId)}</ram:ID>
        </ram:SpecifiedTaxRegistration>`, !!data.sellerVatId)}
        ${opt(`<ram:SpecifiedTaxRegistration>
          <ram:ID schemeID="FC">${e(data.sellerTaxNumber)}</ram:ID>
        </ram:SpecifiedTaxRegistration>`, !!data.sellerTaxNumber)}
      </ram:SellerTradeParty>
      <ram:BuyerTradeParty>
        <ram:Name>${e(data.buyerName || 'Buyer')}</ram:Name>
        ${buyerAddress}
        ${opt(`<ram:SpecifiedTaxRegistration>
          <ram:ID schemeID="VA">${e(data.buyerVatId)}</ram:ID>
        </ram:SpecifiedTaxRegistration>`, !!data.buyerVatId)}
      </ram:BuyerTradeParty>
    </ram:ApplicableHeaderTradeAgreement>

    <ram:ApplicableHeaderTradeDelivery/>

    <ram:ApplicableHeaderTradeSettlement>
      ${opt(`<ram:PaymentReference>${e(data.paymentReference)}</ram:PaymentReference>`, !!data.paymentReference)}
      <ram:InvoiceCurrencyCode>${e(currency)}</ram:InvoiceCurrencyCode>
      ${paymentMeansXml}
      ${vatTaxXml}
      ${paymentTermsXml}
      <ram:SpecifiedTradeSettlementHeaderMonetarySummation>
        <ram:LineTotalAmount>${lineTotal.toFixed(2)}</ram:LineTotalAmount>
        <ram:TaxBasisTotalAmount>${lineTotal.toFixed(2)}</ram:TaxBasisTotalAmount>
        <ram:TaxTotalAmount currencyID="${e(currency)}">${taxTotal.toFixed(2)}</ram:TaxTotalAmount>
        <ram:GrandTotalAmount>${grandTotal.toFixed(2)}</ram:GrandTotalAmount>
        <ram:DuePayableAmount>${grandTotal.toFixed(2)}</ram:DuePayableAmount>
      </ram:SpecifiedTradeSettlementHeaderMonetarySummation>
    </ram:ApplicableHeaderTradeSettlement>

  </rsm:SupplyChainTradeTransaction>

</rsm:CrossIndustryInvoice>`;
}

// ---------------------------------------------------------------------------
// ZUGFeRD XMP metadata
// ---------------------------------------------------------------------------

function buildXmpMetadata(conformanceLevel: string): string {
  const now = new Date().toISOString().replace(/\.\d+Z$/, '+00:00');
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description xmlns:fx="urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#" rdf:about="">
      <fx:DocumentType>INVOICE</fx:DocumentType>
      <fx:DocumentFileName>factur-x.xml</fx:DocumentFileName>
      <fx:Version>1.0</fx:Version>
      <fx:ConformanceLevel>${conformanceLevel}</fx:ConformanceLevel>
    </rdf:Description>
    <rdf:Description xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/" rdf:about="">
      <pdfaid:part>3</pdfaid:part>
      <pdfaid:conformance>B</pdfaid:conformance>
    </rdf:Description>
    <rdf:Description xmlns:xmp="http://ns.adobe.com/xap/1.0/" rdf:about="">
      <xmp:CreatorTool>e-Invoice Viewer</xmp:CreatorTool>
      <xmp:CreateDate>${now}</xmp:CreateDate>
      <xmp:ModifyDate>${now}</xmp:ModifyDate>
    </rdf:Description>
    <rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" rdf:about="">
      <dc:format>application/pdf</dc:format>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

// ---------------------------------------------------------------------------
// Handlebars template rendering
// ---------------------------------------------------------------------------

const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');
let compiledTemplate: Handlebars.TemplateDelegate | null = null;

function getTemplate(): Handlebars.TemplateDelegate {
  if (!compiledTemplate) {
    const src = fs.readFileSync(path.join(TEMPLATES_DIR, 'invoice.hbs'), 'utf-8');
    compiledTemplate = Handlebars.compile(src);
  }
  return compiledTemplate;
}

const FONT_FAMILIES: Record<string, string> = {
  sans:  '"DejaVu Sans", Arial, Helvetica, sans-serif',
  serif: '"DejaVu Serif", Georgia, "Times New Roman", serif',
  mono:  '"DejaVu Sans Mono", "Courier New", Courier, monospace',
};

const TYPE_LABELS: Record<string, string> = {
  '380': 'Rechnung',
  '381': 'Stornorechnung',
  '384': 'Korrekturrechnung',
  '389': 'Gutschrift',
};

function formatGermanDate(iso: string): string {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return (d && m && y) ? `${d}.${m}.${y}` : iso;
}

function buildTemplateContext(data: InvoiceFormData, template?: InvoiceTemplate): Record<string, unknown> {
  const { lines, vatGroups, lineTotal, taxTotal, grandTotal } = computeTotals(data);
  const currency = data.currency || 'EUR';
  const fmt = (n: number) =>
    n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ' + currency;

  return {
    // Visual settings
    accentColor: template?.accentColor || '#2563EB',
    fontFamily:  FONT_FAMILIES[template?.font || 'sans'],
    logoDataUrl: template?.logoDataUrl  || '',
    headerText:  template?.headerText   || '',
    footerText:  template?.footerText   || '',

    // Invoice meta
    invoiceNumber: data.invoiceNumber || 'ENTWURF',
    invoiceDate:   formatGermanDate(data.invoiceDate),
    dueDate:       formatGermanDate(data.dueDate),
    typeLabel:     TYPE_LABELS[data.invoiceType] ?? 'Rechnung',
    currency,
    profile: (data.profile || 'en16931').toUpperCase().replace('EN16931', 'EN 16931'),

    // Seller
    sellerName:        data.sellerName,
    sellerStreet:      data.sellerStreet,
    sellerCity:        data.sellerCity,
    sellerPostalCode:  data.sellerPostalCode,
    sellerCountry:     data.sellerCountry !== 'DE' ? data.sellerCountry : '',
    sellerVatId:       data.sellerVatId,
    sellerTaxNumber:   data.sellerTaxNumber,

    // Buyer
    buyerName:        data.buyerName,
    buyerReference:   data.buyerReference,
    buyerStreet:      data.buyerStreet,
    buyerCity:        data.buyerCity,
    buyerPostalCode:  data.buyerPostalCode,
    buyerCountry:     data.buyerCountry !== 'DE' ? data.buyerCountry : '',
    buyerVatId:       data.buyerVatId,

    // Line items
    lineItems: lines.map((l) => ({
      idx:               l.idx,
      description:       l.description || `Position ${l.idx}`,
      quantity:          l.quantity.toLocaleString('de-DE', { maximumFractionDigits: 4 }),
      unitCode:          l.unitCode === 'C62' ? 'Stk.' : l.unitCode,
      unitPriceFormatted: fmt(l.unitPrice),
      vatRate:           l.vatRate.toLocaleString('de-DE'),
      lineTotalFormatted: fmt(l.lineTotal),
    })),

    // Totals
    subtotalFormatted:  fmt(lineTotal),
    vatGroups: vatGroups.map((g) => ({
      rate:        g.rate.toLocaleString('de-DE'),
      taxFormatted: fmt(g.tax),
    })),
    taxTotalFormatted:   fmt(taxTotal),
    grandTotalFormatted: fmt(grandTotal),

    // Payment
    iban:             data.iban,
    bic:              data.bic,
    paymentReference: data.paymentReference,
    paymentTerms:     data.paymentTerms,

    // Letter
    letter: data.letter || '',

    // Notes
    notes: data.notes,

    // Flags
    hasPaymentInfo: !!(data.iban || data.paymentTerms),
    notes_exist:    !!data.notes,
  };
}

export function renderInvoiceHtml(data: InvoiceFormData, template?: InvoiceTemplate): string {
  const ctx = buildTemplateContext(data, template);
  // Handlebars uses {{#if notes}} so map notes_exist back to notes boolean
  (ctx as Record<string, unknown>)['notes'] = data.notes || '';
  return getTemplate()(ctx);
}

// ---------------------------------------------------------------------------
// Puppeteer browser management (singleton)
// ---------------------------------------------------------------------------

let _browserPromise: Promise<Browser> | null = null;

function getBrowser(): Promise<Browser> {
  if (!_browserPromise) {
    _browserPromise = puppeteer
      .launch({
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
        ],
        headless: true,
      })
      .catch((err) => {
        _browserPromise = null;
        throw err;
      });
  }
  return _browserPromise;
}

async function htmlToPdf(html: string): Promise<Buffer> {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: 'load' });
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
    });
    return Buffer.from(pdfBuffer);
  } finally {
    await page.close();
  }
}

// ---------------------------------------------------------------------------
// Attach ZUGFeRD XML + PDF/A-3b metadata to a Puppeteer-generated PDF
// ---------------------------------------------------------------------------

async function attachZugferdXml(
  pdfBuffer: Buffer,
  xmlBytes: Buffer,
  conformanceLevel: string,
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(pdfBuffer);

  pdfDoc.setTitle('Invoice');
  pdfDoc.setCreator('e-Invoice Viewer');
  pdfDoc.setProducer('e-Invoice Viewer · Puppeteer · pdf-lib');

  // ── Attach XML ────────────────────────────────────────────────────────────
  await pdfDoc.attach(xmlBytes, 'factur-x.xml', {
    mimeType: 'application/xml',
    description: 'Factur-X/ZUGFeRD Invoice XML',
    creationDate: new Date(),
    modificationDate: new Date(),
    afRelationship: AFRelationship.Alternative,
  });

  // ── OutputIntent (sRGB IEC61966-2.1 ICC profile) ──────────────────────────
  const iccBytes     = getSrgbIccBytes();
  const iccStream    = pdfDoc.context.stream(iccBytes, { N: 3 });
  const iccStreamRef = pdfDoc.context.register(iccStream);

  const outputIntentDict = pdfDoc.context.obj({
    Type: 'OutputIntent',
    S:    'GTS_PDFA1',
    OutputConditionIdentifier: PDFString.of('sRGB IEC61966-2.1'),
    RegistryName: PDFString.of('http://www.color.org'),
    Info: PDFString.of('sRGB IEC61966-2.1'),
    DestOutputProfile: iccStreamRef,
  });
  const outputIntentRef = pdfDoc.context.register(outputIntentDict);

  const existingOutputIntents = pdfDoc.catalog.lookup(PDFName.of('OutputIntents'));
  if (existingOutputIntents instanceof PDFArray) {
    existingOutputIntents.push(outputIntentRef);
  } else {
    pdfDoc.catalog.set(PDFName.of('OutputIntents'), PDFArray.withContext(pdfDoc.context));
    (pdfDoc.catalog.lookup(PDFName.of('OutputIntents')) as PDFArray).push(outputIntentRef);
  }

  // ── ZUGFeRD XMP metadata ──────────────────────────────────────────────────
  const xmpBytes  = Buffer.from(buildXmpMetadata(conformanceLevel), 'utf-8');
  const xmpStream = pdfDoc.context.stream(xmpBytes, { Type: 'Metadata', Subtype: 'XML' });
  const xmpRef    = pdfDoc.context.register(xmpStream);
  pdfDoc.catalog.set(PDFName.of('Metadata'), xmpRef);

  return pdfDoc.save({ useObjectStreams: false });
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function generateZugferdPdf(data: InvoiceFormData, template?: InvoiceTemplate): Promise<Uint8Array> {
  const xmlString = buildCiiXml(data);
  const xmlBytes  = Buffer.from(xmlString, 'utf-8');

  const conformanceLevels: Record<string, string> = {
    minimum: 'MINIMUM', basicwl: 'BASIC WL', basic: 'BASIC', en16931: 'EN 16931', extended: 'EXTENDED',
  };
  const conformanceLevel = conformanceLevels[data.profile] ?? 'EN 16931';

  const html      = renderInvoiceHtml(data, template);
  const pdfBuffer = await htmlToPdf(html);

  return attachZugferdXml(pdfBuffer, xmlBytes, conformanceLevel);
}
