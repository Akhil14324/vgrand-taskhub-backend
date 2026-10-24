// Pure helpers for long transcripts.

/** Cuts the text into pieces of about `size` characters, breaking at line ends where it can. */
function splitText(text, size = 12000) {
  const parts = [];
  let rest = text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size);
    if (cut < size / 2) cut = size;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

module.exports = { splitText };
