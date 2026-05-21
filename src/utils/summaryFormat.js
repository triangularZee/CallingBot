export function normalizeSummaryFormatting(text) {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/(Q\d+\)[^\n]*)\n[ \t]*\n+(A\d+\))/g, '$1\n$2')
    .trim();
}
