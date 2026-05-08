import * as XLSX from 'xlsx';
import type { InvoiceFormData, LineItem } from './invoice-form';

// ============================================================
// Field registry
// ============================================================

const HEADER_FIELDS = [
  'invoiceNumber', 'invoiceDate', 'dueDate', 'invoiceType', 'currency', 'profile', 'letter', 'notes',
  'sellerName', 'sellerStreet', 'sellerPostalCode', 'sellerCity', 'sellerCountry', 'sellerVatId', 'sellerTaxNumber',
  'buyerName', 'buyerReference', 'buyerStreet', 'buyerPostalCode', 'buyerCity', 'buyerCountry', 'buyerVatId',
  'paymentMeansCode', 'iban', 'bic', 'paymentReference', 'paymentTerms',
] as const;

type HeaderField = typeof HEADER_FIELDS[number];

const HEADER_FIELD_SET = new Set<string>(HEADER_FIELDS);

const TEMPLATE_ROWS: [HeaderField, string][] = [
  ['invoiceNumber',    'INV-2024-001'],
  ['invoiceDate',      '2024-01-15'],
  ['dueDate',          '2024-02-14'],
  ['invoiceType',      '380'],
  ['currency',         'EUR'],
  ['profile',          'en16931'],
  ['notes',            'Thank you for your business'],
  ['sellerName',       'Your Company B.V.'],
  ['sellerStreet',     'Main Street 1'],
  ['sellerPostalCode', '1234 AB'],
  ['sellerCity',       'Amsterdam'],
  ['sellerCountry',    'NL'],
  ['sellerVatId',      'NL123456789B01'],
  ['sellerTaxNumber',  ''],
  ['buyerName',        'Customer B.V.'],
  ['buyerReference',   'PO-12345'],
  ['buyerStreet',      'Customer Street 5'],
  ['buyerPostalCode',  '5678 CD'],
  ['buyerCity',        'Rotterdam'],
  ['buyerCountry',     'NL'],
  ['buyerVatId',       'NL987654321B01'],
  ['paymentMeansCode', '58'],
  ['iban',             'NL00BANK0000000000'],
  ['bic',              'BANKNLNX'],
  ['paymentReference', 'INV-2024-001'],
  ['paymentTerms',     'Net 30 days'],
];

const TEMPLATE_ITEMS: [string, string, string, string, string][] = [
  ['Consulting Services', '10', 'HUR', '125.00', '21'],
  ['Software License',    '1',  'C62', '500.00',  '21'],
  ['Travel Expenses',     '1',  'C62', '250.00',  '0'],
];

// ============================================================
// Helpers
// ============================================================

function defaultData(): InvoiceFormData {
  return {
    invoiceNumber: '', invoiceDate: '', invoiceType: '380', currency: 'EUR',
    profile: 'en16931', letter: '', notes: '',
    sellerName: '', sellerStreet: '', sellerCity: '', sellerPostalCode: '',
    sellerCountry: '', sellerVatId: '', sellerTaxNumber: '',
    buyerName: '', buyerReference: '', buyerStreet: '', buyerCity: '',
    buyerPostalCode: '', buyerCountry: '', buyerVatId: '',
    paymentMeansCode: '58', iban: '', bic: '', paymentReference: '',
    paymentTerms: '', dueDate: '',
    lineItems: [],
  };
}

function fallbackItem(): LineItem {
  return { description: '', quantity: '1', unitCode: 'C62', unitPrice: '', vatRate: '21' };
}

function applyHeader(data: InvoiceFormData, key: string, value: string): void {
  if (HEADER_FIELD_SET.has(key)) {
    (data as unknown as Record<string, string>)[key] = value;
  }
}

function parseLineItemFromCells(headers: string[], cells: string[]): LineItem | null {
  const item: LineItem = { description: '', quantity: '1', unitCode: 'C62', unitPrice: '0', vatRate: '21' };
  headers.forEach((h, i) => {
    const val = (cells[i] ?? '').trim();
    switch (h) {
      case 'description': item.description = val; break;
      case 'quantity':    item.quantity    = val || '1'; break;
      case 'unitcode':    item.unitCode    = val || 'C62'; break;
      case 'unitprice':   item.unitPrice   = val || '0'; break;
      case 'vatrate':     item.vatRate     = val || '0'; break;
    }
  });
  return item.description || item.unitPrice !== '0' ? item : null;
}

// ============================================================
// CSV parser
// ============================================================

function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  for (const line of lines) {
    const cells: string[] = [];
    let inQuote = false;
    let cell = '';
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuote && line[i + 1] === '"') { cell += '"'; i++; }
        else inQuote = !inQuote;
      } else if (ch === ',' && !inQuote) {
        cells.push(cell.trim()); cell = '';
      } else {
        cell += ch;
      }
    }
    cells.push(cell.trim());
    rows.push(cells);
  }
  return rows;
}

function parseCsv(text: string): InvoiceFormData {
  const data = defaultData();
  const rows = parseCsvRows(text);
  let inLineItems = false;
  let lineHeaders: string[] = [];

  for (const row of rows) {
    if (!row.length) continue;
    const first = (row[0] ?? '').toLowerCase();
    if (!first || first.startsWith('#')) continue;

    // Detect line items section header row
    if (first === 'description') {
      inLineItems = true;
      lineHeaders = row.map((h) => h.toLowerCase());
      continue;
    }
    // Skip the "field,value" column header row
    if (first === 'field' && (row[1] ?? '').toLowerCase() === 'value') continue;

    if (inLineItems) {
      const item = parseLineItemFromCells(lineHeaders, row);
      if (item) data.lineItems.push(item);
    } else {
      applyHeader(data, row[0] ?? '', (row[1] ?? '').trim());
    }
  }

  if (data.lineItems.length === 0) data.lineItems.push(fallbackItem());
  return data;
}

// ============================================================
// Excel parser
// ============================================================

function parseExcel(buffer: ArrayBuffer): InvoiceFormData {
  const data = defaultData();
  const wb = XLSX.read(buffer, { type: 'array', cellText: true, cellDates: false });

  // Invoice sheet → key/value rows
  const invoiceSheetName = wb.SheetNames.find((n) => /invoice/i.test(n)) ?? wb.SheetNames[0];
  if (invoiceSheetName) {
    const rows = XLSX.utils.sheet_to_json<string[]>(wb.Sheets[invoiceSheetName], { header: 1, defval: '' }) as string[][];
    for (const row of rows) {
      const key = String(row[0] ?? '').trim();
      const val = String(row[1] ?? '').trim();
      if (!key || key.toLowerCase() === 'field') continue;
      applyHeader(data, key, val);
    }
  }

  // Line Items sheet (prefer dedicated sheet, fall back to second sheet)
  const lineSheetName =
    wb.SheetNames.find((n) => /line.?items?/i.test(n)) ??
    (wb.SheetNames.length > 1 ? wb.SheetNames[1] : undefined);

  if (lineSheetName) {
    const rows = XLSX.utils.sheet_to_json<Record<string, string>>(wb.Sheets[lineSheetName], { defval: '' });
    for (const row of rows) {
      const item: LineItem = {
        description: String(row['description'] ?? row['Description'] ?? '').trim(),
        quantity:    String(row['quantity']    ?? row['Quantity']    ?? '1').trim()  || '1',
        unitCode:    String(row['unitCode']    ?? row['Unit Code']   ?? row['unitcode'] ?? 'C62').trim() || 'C62',
        unitPrice:   String(row['unitPrice']   ?? row['Unit Price']  ?? row['unitprice'] ?? '0').trim()  || '0',
        vatRate:     String(row['vatRate']     ?? row['VAT%']        ?? row['vatrate']   ?? '0').trim()  || '0',
      };
      if (item.description || item.unitPrice !== '0') data.lineItems.push(item);
    }
  }

  if (data.lineItems.length === 0) data.lineItems.push(fallbackItem());
  return data;
}

// ============================================================
// Public API
// ============================================================

export async function parseImportFile(file: File): Promise<InvoiceFormData> {
  const name = file.name.toLowerCase();
  if (name.endsWith('.csv')) {
    return parseCsv(await file.text());
  }
  if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
    return parseExcel(await file.arrayBuffer());
  }
  throw new Error('Unsupported format. Upload a .csv or .xlsx file.');
}

export function downloadCsvTemplate(): void {
  const lines: string[] = ['field,value'];
  for (const [k, v] of TEMPLATE_ROWS) {
    const safeV = v.includes(',') ? `"${v}"` : v;
    lines.push(`${k},${safeV}`);
  }
  lines.push('', 'description,quantity,unitCode,unitPrice,vatRate');
  for (const row of TEMPLATE_ITEMS) lines.push(row.join(','));

  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'invoice-template.csv'; a.click();
  URL.revokeObjectURL(url);
}

export function downloadExcelTemplate(): void {
  const wb = XLSX.utils.book_new();

  const invoiceAoa: [string, string][] = [['field', 'value'], ...TEMPLATE_ROWS];
  const invoiceSheet = XLSX.utils.aoa_to_sheet(invoiceAoa);
  invoiceSheet['!cols'] = [{ wch: 22 }, { wch: 36 }];
  XLSX.utils.book_append_sheet(wb, invoiceSheet, 'Invoice');

  const lineAoa = [
    ['description', 'quantity', 'unitCode', 'unitPrice', 'vatRate'],
    ...TEMPLATE_ITEMS,
  ];
  const lineSheet = XLSX.utils.aoa_to_sheet(lineAoa);
  lineSheet['!cols'] = [{ wch: 30 }, { wch: 10 }, { wch: 10 }, { wch: 12 }, { wch: 10 }];
  XLSX.utils.book_append_sheet(wb, lineSheet, 'Line Items');

  XLSX.writeFile(wb, 'invoice-template.xlsx');
}
