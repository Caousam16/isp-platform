import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { Invoice, Organization, Payment, Subscriber } from "./domain";

const navy = rgb(0.04, 0.13, 0.23);
const teal = rgb(0.02, 0.55, 0.51);
const gray = rgb(0.38, 0.43, 0.48);

function amount(value: number, currency: string) {
  return `${currency} ${new Intl.NumberFormat("en-PH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value / 100)}`;
}

function safeText(value: string) {
  return value.replace(/[^\x20-\x7E]/g, " ").replace(/\s+/g, " ").trim();
}

function drawText(page: PDFPage, font: PDFFont, text: string, x: number, y: number, size = 10, color = navy) {
  page.drawText(safeText(text), { x, y, size, font, color });
}

function download(bytes: Uint8Array, filename: string) {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const blob = new Blob([buffer], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename.replace(/[^A-Za-z0-9._-]/g, "-");
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function documentBase(organization: Organization, label: string, number: string) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`${label} ${number}`);
  pdf.setAuthor(organization.name);
  pdf.setCreator("SOUTHWOODS ISP Platform");
  const page = pdf.addPage([595.28, 841.89]);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  page.drawRectangle({ x: 0, y: 742, width: 595.28, height: 100, color: navy });
  drawText(page, bold, organization.name.toUpperCase(), 48, 797, 18, rgb(1, 1, 1));
  drawText(page, regular, organization.address || "Business address not configured", 48, 777, 9, rgb(0.84, 0.9, 0.94));
  drawText(page, regular, [organization.tax_id, organization.contact_email, organization.contact_phone].filter(Boolean).join(" | "), 48, 760, 8, rgb(0.84, 0.9, 0.94));
  drawText(page, bold, label.toUpperCase(), 390, 797, 15, rgb(1, 1, 1));
  drawText(page, regular, number, 390, 776, 10, rgb(1, 1, 1));
  return { pdf, page, regular, bold };
}

function partyBlock(page: PDFPage, regular: PDFFont, bold: PDFFont, subscriber: Subscriber, dateLabel: string, date: string) {
  drawText(page, bold, "BILL TO", 48, 708, 9, teal);
  drawText(page, bold, subscriber.name, 48, 688, 12);
  drawText(page, regular, `Account: ${subscriber.account_number}`, 48, 671, 9, gray);
  drawText(page, regular, subscriber.address, 48, 654, 9, gray);
  drawText(page, regular, [subscriber.email, subscriber.phone].filter(Boolean).join(" | "), 48, 637, 9, gray);
  drawText(page, bold, dateLabel.toUpperCase(), 410, 688, 8, teal);
  drawText(page, regular, date, 410, 671, 10);
}

function footer(page: PDFPage, regular: PDFFont, organization: Organization) {
  page.drawLine({ start: { x: 48, y: 72 }, end: { x: 547, y: 72 }, thickness: 0.7, color: rgb(0.8, 0.83, 0.86) });
  drawText(page, regular, "Computer-generated document. No signature is required.", 48, 54, 8, gray);
  drawText(page, regular, `Questions: ${organization.contact_email || organization.contact_phone || "contact the billing office"}`, 48, 40, 8, gray);
}

export async function downloadInvoicePdf(invoice: Invoice, subscriber: Subscriber, organization: Organization) {
  const { pdf, page, regular, bold } = await documentBase(organization, "Official Invoice", invoice.number);
  partyBlock(page, regular, bold, subscriber, "Issued", invoice.issued_on);
  drawText(page, bold, "DESCRIPTION", 48, 580, 9, teal);
  drawText(page, bold, "DUE DATE", 380, 580, 9, teal);
  drawText(page, bold, "AMOUNT", 475, 580, 9, teal);
  page.drawLine({ start: { x: 48, y: 570 }, end: { x: 547, y: 570 }, thickness: 1, color: teal });
  drawText(page, regular, invoice.description, 48, 545, 10);
  drawText(page, regular, invoice.due_on, 380, 545, 10);
  drawText(page, bold, amount(invoice.total_minor, invoice.currency), 455, 545, 10);
  page.drawRectangle({ x: 350, y: 455, width: 197, height: 58, color: rgb(0.94, 0.97, 0.98) });
  drawText(page, bold, "TOTAL DUE", 370, 487, 10, gray);
  drawText(page, bold, amount(Math.max(0, invoice.total_minor - invoice.paid_minor), invoice.currency), 430, 468, 15);
  footer(page, regular, organization);
  download(await pdf.save(), `${invoice.number}.pdf`);
}

export async function downloadReceiptPdf(payment: Payment, invoice: Invoice | undefined, subscriber: Subscriber, organization: Organization) {
  const { pdf, page, regular, bold } = await documentBase(organization, "Official Receipt", payment.receipt_number);
  partyBlock(page, regular, bold, subscriber, "Received", payment.received_at.slice(0, 10));
  const rows = [
    ["Amount received", amount(payment.amount_minor, payment.currency)],
    ["Payment method", payment.payment_method],
    ["Payment reference", payment.reference],
    ["Applied to invoice", invoice?.number ?? "Unallocated"],
  ];
  let y = 570;
  for (const [label, value] of rows) {
    drawText(page, bold, label.toUpperCase(), 48, y, 8, teal);
    drawText(page, regular, value, 235, y, 11);
    page.drawLine({ start: { x: 48, y: y - 12 }, end: { x: 547, y: y - 12 }, thickness: 0.5, color: rgb(0.84, 0.87, 0.89) });
    y -= 48;
  }
  page.drawRectangle({ x: 48, y: 315, width: 499, height: 72, color: rgb(0.93, 0.98, 0.97) });
  drawText(page, bold, "PAYMENT RECEIVED", 68, 359, 10, teal);
  drawText(page, bold, amount(payment.amount_minor, payment.currency), 68, 334, 20);
  footer(page, regular, organization);
  download(await pdf.save(), `${payment.receipt_number}.pdf`);
}
