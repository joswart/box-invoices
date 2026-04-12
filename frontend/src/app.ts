import { UploadResponse, parseInvoice } from './invoice-parsers';
import { esc, renderValidation, renderInvoice } from './invoice-renderer';

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
  const isPdf = file.name.toLowerCase().endsWith('.pdf') || file.type === 'application/pdf';
  const isXml = file.name.toLowerCase().endsWith('.xml') || file.type === 'application/xml' || file.type === 'text/xml';

  if (!isPdf && !isXml) {
    showError('Please upload a PDF or XML invoice file.');
    return;
  }

  hideError();
  setLoading(true);

  try {
    const formData = new FormData();
    formData.append('pdf', file);

    const resp = await fetch('/api/upload', { method: 'POST', body: formData });

    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`Server error ${resp.status}: ${txt}`);
    }

    const data: UploadResponse = await resp.json();

    if (!data.success) {
      showError(data.error);
      return;
    }

    currentXml = data.xml;

    $('upload-screen').classList.add('hidden');
    $('viewer-screen').classList.remove('hidden');

    ($('header-filename') as HTMLElement).textContent = file.name;
    ($('header-badge') as HTMLElement).textContent = data.attachmentName;
    ($('xml-filename') as HTMLElement).textContent = data.attachmentName;

    // PDF viewer — only shown when the upload was a PDF with embedded XML
    const pdfPanel = $('pdf-panel');
    const divider = $('viewer-divider');
    if (data.pdfBase64) {
      pdfPanel.classList.remove('hidden');
      divider.classList.remove('hidden');
      const pdfBytes = Uint8Array.from(atob(data.pdfBase64), (c) => c.charCodeAt(0));
      const blob = new Blob([pdfBytes], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      ($('pdf-frame') as HTMLIFrameElement).src = url;
    } else {
      pdfPanel.classList.add('hidden');
      divider.classList.add('hidden');
      ($('pdf-frame') as HTMLIFrameElement).src = '';
    }

    const validationHtml = renderValidation(data.validation);
    let invoiceHtml = '';
    try {
      const inv = parseInvoice(data.xml);
      invoiceHtml = renderInvoice(inv);
    } catch {
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
    $('pdf-panel').classList.remove('hidden');
    $('viewer-divider').classList.remove('hidden');
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
