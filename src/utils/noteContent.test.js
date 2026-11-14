const test = require('node:test');
const assert = require('node:assert');
const { sanitizeHtml, plainText, cleanSheet, sheetText } = require('./noteContent');

test('the editor formatting survives', () => {
  const html = '<h1>Plan</h1><p><b>Bold</b> <i>it</i> <u>u</u></p><ul><li>one</li></ul><ol><li>two</li></ol><font size="5">big</font>';
  assert.equal(sanitizeHtml(html), html);
});

test('tick lists keep their marks and nothing else', () => {
  assert.equal(
    sanitizeHtml('<ul data-check="1" class="x" onclick="a()"><li data-done="1" style="color:red">done</li><li data-done="0">open</li></ul>'),
    '<ul data-check="1"><li data-done="1">done</li><li>open</li></ul>'
  );
});

test('scripts, handlers, links and pictures are cut away', () => {
  assert.equal(sanitizeHtml('<p onclick="x()">a</p><script>alert(1)</script><img src=x onerror=alert(1)><a href="javascript:x">b</a>'), '<p>a</p>b');
  assert.equal(sanitizeHtml('<scr<script>ipt>alert(1)</script>'), '&lt;scr');
  assert.equal(sanitizeHtml('<svg><script>x</script></svg>ok'), 'ok');
  assert.equal(sanitizeHtml('<style>p{}</style><iframe src="x"></iframe>ok'), 'ok');
});

test('a stray angle bracket becomes text, never a tag', () => {
  assert.equal(sanitizeHtml('1 < 2 and 3 > 2'), '1 &lt; 2 and 3 &gt; 2');
});

test('font keeps only a size from 1 to 7', () => {
  assert.equal(sanitizeHtml('<font size="9" color="red" face="x">a</font>'), '<font>a</font>');
  assert.equal(sanitizeHtml("<font size='2'>a</font>"), '<font size="2">a</font>');
});

test('plain text reads like the note', () => {
  assert.equal(plainText('<h1>Plan</h1><p>Buy&nbsp;cement &amp; sand</p><ul><li>one</li><li>two</li></ul>'), 'Plan\nBuy cement & sand\none\ntwo');
});

test('a sheet is squared off and trimmed', () => {
  const s = cleanSheet({ rows: [['Item', 'Cost', ''], [null], ['Cement', 420], ['', '', '']], widths: [10, 9000, 'x'] });
  assert.deepEqual(s.rows, [['Item', 'Cost'], ['', ''], ['Cement', '420']]);
  assert.deepEqual(s.widths, [50, 600]);
});

test('an empty or broken sheet is one empty column', () => {
  assert.deepEqual(cleanSheet(null), { rows: [], widths: [] });
  assert.deepEqual(cleanSheet({ rows: 'x' }), { rows: [], widths: [] });
});

test('sheet text joins the filled cells', () => {
  assert.equal(sheetText({ rows: [['Item', 'Cost'], ['', ''], ['Cement', '420']] }), 'Item  Cost\nCement  420');
});
