// Fast drop-in for csv-reader 1.0.0 (make.fun): run(input) returns exactly
// csv-reader 1.0.0's {columns, rows, errors} for {text, header}.
//
// Same reading policy as the reference, reimplemented from scratch for speed:
// - a U+FEFF at the very start is dropped;
// - a record ends at LF or CRLF; a line left with no characters is no record;
// - outside quotes a CR not followed by LF is dropped (stray_cr);
// - a field opening with a quote runs to the next quote that is not doubled,
//   "" inside it is one quote, CRLF / lone CR inside it reads as LF; what
//   follows its closing quote up to the next comma or line break is appended
//   as it stands (quote_junk, when the field ends); a quote that never closes
//   is a literal character and the text after it is read again as unquoted
//   (unterminated_quote);
// - a quote inside an unquoted field is a literal character;
// - fields stay strings, never trimmed or converted;
// - columns is the first record when header is true, else null; rows holds the
//   records after it, each padded (short_row, with fields: its count) or cut
//   (long_row, with extra: the cut fields) to the first record's width;
// - each error is {code, line, row} in the order met; line is the 1-based
//   line its record starts on, row its record's index in rows (null for the
//   header).
//
// Speed comes from never building a field character by character: unquoted
// fields are scanned with charCodeAt and cut out with one slice, quoted
// fields are located with indexOf (skipping doubled quotes), cut out with one
// slice, and only unescaped / CR-normalised when the span actually needs it.
// Field readers report through shared locals instead of allocating a result
// per field, and no state is kept between calls.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;

  // The record being read: the line it starts on, and the index in rows it
  // takes (null for the header). Errors report these, not the current line.
  let recordLine = 1;
  let recordRow = null;

  // The field just read: its value, how it ended, and how many characters
  // the unquoted scan kept in this call (not counting the initial value).
  // Readers write these directly; calls are strictly sequential and the
  // caller reads them right after each call, so no result object is needed.
  let fVal = '';
  let fEnd = END;
  let fAdded = 0;

  // Reads unquoted characters onto `init` up to the next comma or line
  // break; a CR not followed by LF is dropped (stray_cr).
  function readUnquoted(init) {
    fVal = init;
    fAdded = 0;
    let seg = pos;
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 44) {
        if (pos > seg) {
          const s = text.slice(seg, pos);
          fVal += s;
          fAdded += s.length;
        }
        pos += 1;
        fEnd = COMMA;
        return;
      }
      if (c === 10) {
        if (pos > seg) {
          const s = text.slice(seg, pos);
          fVal += s;
          fAdded += s.length;
        }
        pos += 1;
        line += 1;
        fEnd = LINE_BREAK;
        return;
      }
      if (c === 13) {
        if (text.charCodeAt(pos + 1) === 10) {
          if (pos > seg) {
            const s = text.slice(seg, pos);
            fVal += s;
            fAdded += s.length;
          }
          pos += 2;
          line += 1;
          fEnd = LINE_BREAK;
          return;
        }
        if (pos > seg) {
          const s = text.slice(seg, pos);
          fVal += s;
          fAdded += s.length;
        }
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        pos += 1;
        seg = pos;
        continue;
      }
      pos += 1;
    }
    if (pos > seg) {
      const s = text.slice(seg, pos);
      fVal += s;
      fAdded += s.length;
    }
    fEnd = END;
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    // Find the closing quote: a quote not followed by another quote.
    let q = text.indexOf('"', pos + 1);
    let escaped = false;
    while (q !== -1 && text.charCodeAt(q + 1) === 34) {
      escaped = true;
      q = text.indexOf('"', q + 2);
    }
    if (q === -1) {
      // The quote never closes: it is a literal character, and the text
      // after it is read again as an unquoted field.
      pos = open + 1;
      line = openLine;
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      readUnquoted('"');
      return;
    }
    const span = text.slice(open + 1, q);
    let value;
    if (span.indexOf('\n') !== -1 || span.indexOf('\r') !== -1) {
      // Count the line breaks inside the quotes: every LF, and every CR
      // not followed by LF (a CRLF counts once, through its LF).
      let breaks = 0;
      let i = span.indexOf('\n');
      while (i !== -1) {
        breaks += 1;
        i = span.indexOf('\n', i + 1);
      }
      i = span.indexOf('\r');
      while (i !== -1) {
        if (span.charCodeAt(i + 1) !== 10) breaks += 1;
        i = span.indexOf('\r', i + 1);
      }
      line += breaks;
      value = span.indexOf('\r') === -1
        ? (escaped ? span.replaceAll('""', '"') : span)
        : (escaped
          ? span.replace(/\r\n?/g, '\n').replaceAll('""', '"')
          : span.replace(/\r\n?/g, '\n'));
    } else {
      value = escaped ? span.replaceAll('""', '"') : span;
    }
    pos = q + 1;
    if (pos >= len) {
      fVal = value;
      fAdded = 0;
      fEnd = END;
      return;
    }
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      fVal = value;
      fAdded = 0;
      fEnd = COMMA;
      return;
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      fVal = value;
      fAdded = 0;
      fEnd = LINE_BREAK;
      return;
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      fVal = value;
      fAdded = 0;
      fEnd = LINE_BREAK;
      return;
    }
    // What follows the closing quote is appended as it stands, up to the
    // next comma or line break.
    readUnquoted(value);
    if (fAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let quoted = false;
    do {
      quoted = text.charCodeAt(pos) === 34;
      if (quoted) readQuoted();
      else readUnquoted('');
      fields.push(fVal);
    } while (fEnd === COMMA);

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
