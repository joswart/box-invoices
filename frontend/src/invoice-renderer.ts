import type { ValidationResult, Invoice, Address } from './invoice-parsers';

// ============================================================
// HTML helpers
// ============================================================

export function esc(s: string): string {
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
  if (!uri) return '';
  const lower = uri.toLowerCase();

  if (lower.includes('xrechnung')) return 'XRechnung';
  if (lower.includes('extended')) return 'EN16931 Extended';
  if (lower.includes('en16931') && !lower.includes('cen.eu')) return 'EN 16931';
  if (lower.includes('basicwl') || lower.includes('basic-wl') || lower.includes('basic_wl')) return 'Basic WL';
  if (lower.includes('basic') && !lower.includes('peppol')) return 'Basic';
  if (lower.includes('minimum')) return 'Minimum';

  if (lower.includes('peppol.eu') || lower.includes('fdc:peppol')) {
    if (lower.includes('aunz') || lower.includes('au-nz')) return 'PEPPOL BIS 3.0 (AU/NZ)';
    if (lower.includes('sg') || lower.includes('singapore'))    return 'PEPPOL BIS 3.0 (SG)';
    if (lower.includes('japan') || lower.includes(':jp:'))      return 'PEPPOL BIS 3.0 (JP)';
    return 'PEPPOL BIS 3.0';
  }

  if (lower.includes('cen.eu:en16931')) {
    if (lower.includes(':ro') || lower.includes('ro-cius'))  return 'RO-CIUS';
    if (lower.includes(':pt') || lower.includes('pt-cius'))  return 'PT-CIUS';
    if (lower.includes(':hr') || lower.includes('ciiur'))    return 'HR-CIUS';
    if (lower.includes(':rs') || lower.includes('efaktura')) return 'RS-CIUS';
    if (lower.includes(':sk') || lower.includes('is.efa'))   return 'SK-CIUS';
    if (lower.includes(':dk') || lower.includes('oioubl'))   return 'DK-OIOUBL';
    return 'EN 16931';
  }

  if (lower.includes('facturae')) {
    const ver = uri.replace(/.*:/, '');
    return ver ? `FacturaE ${ver}` : 'FacturaE';
  }
  if (lower.includes('ksef')) {
    return lower.includes('fa(3)') ? 'KSeF FA(3)' : 'KSeF FA(2)';
  }
  if (uri.startsWith('FA (')) return `KSeF ${uri}`;

  return uri;
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

export function renderValidation(v: ValidationResult): string {
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

// ============================================================
// Invoice data renderer
// ============================================================

export function renderInvoice(inv: Invoice): string {
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
            (tx) => `
          <tr>
            <td>${esc(tx.category) || '—'}</td>
            <td class="num">${tx.rate ? esc(tx.rate) + ' %' : '—'}</td>
            <td class="num">${fmt(tx.base, cur)}</td>
            <td class="num">${fmt(tx.amount, cur)}</td>
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
