// The two small pages an agent's browser window shows. No scripts; everything inserted is escaped.
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const shell = (body) => `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect to TaskHub</title>
<style>
*{box-sizing:border-box}body{margin:0;padding:24px 16px;font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#fff;color:#111}
main{max-width:380px;margin:0 auto}h1{font-size:22px;margin:0 0 12px}p{font-size:14px;line-height:1.5;color:#444}
label{display:block;font-size:13px;font-weight:600;margin:12px 0 4px}input[type=text],input[type=password]{width:100%;padding:10px;font-size:16px;border:1px solid #ccc;border-radius:8px}
.row{display:flex;gap:8px;margin-top:18px}button{flex:1;padding:11px;font-size:15px;font-weight:700;border-radius:8px;border:1px solid #ccc;background:#fff;color:#111;cursor:pointer}
button.go{background:#D4621A;border-color:#D4621A;color:#fff}.box{border:1px solid #e4e4e4;border-radius:8px;padding:10px 12px;word-break:break-word}
.err{color:#a3263b;font-weight:600}
@media (prefers-color-scheme:dark){body{background:#000;color:#eee}p{color:#bbb}input,button{background:#111;color:#eee}.box,input,button{border-color:#333}.err{color:#f598a8}}
</style></head><body><main>${body}</main></body></html>`;

/** Where the person will be sent: the host, or the app for a desktop address. */
const destination = (uri) => { const u = new URL(uri); return u.host || `${u.protocol}//`; };

function signInPage({ params, clientName, error }) {
  const hidden = Object.entries(params).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
  return shell(`<h1>Connect to TaskHub</h1>
<div class="box"><p><strong>${esc(clientName)}</strong> asks to read your to-dos.</p>
<p>It can read your tasks, their notes, comments and attachment links. It cannot change anything.</p>
<p>After you allow it, you go back to <strong>${esc(destination(params.redirect_uri))}</strong>. Continue only if you started this.</p></div>
${error ? `<p class="err" role="alert">${esc(error)}</p>` : ''}
<form method="post" action="/oauth/authorize">${hidden}
<label for="u">Username</label><input id="u" type="text" name="username" autocomplete="username" autocapitalize="none" required>
<label for="p">Password</label><input id="p" type="password" name="password" autocomplete="current-password" required>
<div class="row"><button class="go" type="submit" name="action" value="allow">Allow</button>
<button type="submit" name="action" value="deny" formnovalidate>Cancel</button></div></form>`);
}

const messagePage = (text) => shell(`<h1>Connect to TaskHub</h1><p>${esc(text)}</p>`);

module.exports = { signInPage, messagePage, esc };
