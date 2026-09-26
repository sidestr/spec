// Stamps the document information and XMP metadata into sidestr.pdf: what viewers, Zotero, Scholar and search read.
import { readFileSync, writeFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
const [,, file, title, author, date, subject, ...keywords] = process.argv;
const pdf = await PDFDocument.load(readFileSync(file), { updateMetadata: false });
pdf.setTitle(title, { showInWindowTitleBar: true });
pdf.setAuthor(author);
pdf.setSubject(subject);
pdf.setKeywords(keywords);
pdf.setCreator('sidestr paper build (md2html.py, Chromium, pdf-lib)');
pdf.setProducer('pdf-lib');
pdf.setCreationDate(new Date(date));
pdf.setModificationDate(new Date());
writeFileSync(file, await pdf.save());
console.log('metadata:', title, '|', author, '|', date);
