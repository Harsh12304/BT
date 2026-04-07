import { parse } from 'csv-parse/sync';

function parseRecipients(text) {
  const lines = text.trim().split('\n').filter(line => line.trim());
  if (lines.length === 0) return [];

  const firstLine = lines[0].trim();
  const hasHeaders = firstLine.toLowerCase().includes('number') || firstLine.toLowerCase().includes('phone');

  if (hasHeaders) {
    return parse(text, { columns: true, skip_empty_lines: true, trim: true });
  } else {
    return lines.map(line => {
      const parts = line.split(',').map(p => p.trim());
      return { number: parts[0] || '', name: parts[1] || '' };
    });
  }
}

// Test with headers
console.log('With headers:');
console.log(parseRecipients('number,name\n0987654321,Jay\n0987654321,John'));

// Test without headers
console.log('Without headers:');
console.log(parseRecipients('0987654321,Jay\n0987654321,John'));