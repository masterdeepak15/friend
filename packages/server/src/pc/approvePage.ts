/**
 * The page the owner opens to approve a new PC (the agent opens it in the browser, or the owner types its address). It is one small
 * self-contained page: it reads the PC's details with the owner's own session, lets the owner choose what the PC may do, and approves
 * with the PIN. Everything that comes from the PC is put on the page as text, never as markup.
 */
export function approvePage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Add a PC to Friend</title>
<style>
:root{color-scheme:dark light;--bg:#0a101c;--ink:#e8f4ff;--muted:#8fa8c0;--accent:#3fd8ff;--edge:rgba(120,200,255,.3)}
@media (prefers-color-scheme: light){:root{--bg:#f4f8fc;--ink:#10202e;--muted:#4a6178;--accent:#0a7aa5;--edge:rgba(10,90,130,.3)}}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,sans-serif;display:grid;place-items:start center;min-height:100vh;padding:24px 16px}
main{max-width:560px;width:100%;border:1px solid var(--edge);border-radius:14px;padding:22px 24px}
h1{margin:0 0 6px;font-size:22px;color:var(--accent)}p{margin:8px 0}.muted{color:var(--muted);font-size:14px}
label{display:flex;gap:10px;align-items:flex-start;margin:8px 0}input[type=text],input[type=password],select,textarea{width:100%;padding:9px 10px;border-radius:8px;border:1px solid var(--edge);background:transparent;color:inherit;font:inherit;box-sizing:border-box}
button{margin-top:14px;padding:10px 18px;border-radius:9px;border:1px solid var(--accent);background:var(--accent);color:#001018;font:inherit;font-weight:600;cursor:pointer}button:disabled{opacity:.5}
.card{border:1px solid var(--edge);border-radius:10px;padding:10px 14px;margin:12px 0}.bad{color:#ff7a7a}.ok{color:#5be08a}
</style></head><body><main>
<h1>Add a PC to Friend</h1>
<p id="msg" class="muted">Loading...</p>
<form id="form" hidden>
  <div class="card"><div><strong id="host"></strong></div><div class="muted" id="os"></div></div>
  <label>Name <input id="name" type="text" maxlength="60" autocomplete="off"></label>
  <p class="muted">What may Friend do on this PC? Everything is off until you switch it on. Anything that cannot be undone still asks you first.</p>
  <label><input type="checkbox" id="control"> <span><b>Control the screen</b>: look at it, move the mouse, type (only in a control session that you start or approve)</span></label>
  <label><input type="checkbox" id="screen"> <span><b>Screenshots</b></span></label>
  <label><input type="checkbox" id="shell"> <span><b>Commands and terminals</b> (PowerShell, Claude Code)</span></label>
  <label><input type="checkbox" id="process"> <span><b>Programs</b>: list and end</span></label>
  <label><input type="checkbox" id="registry"> <span><b>Registry</b></span></label>
  <label><span style="min-width:90px"><b>Files</b></span> <select id="files"><option value="off">off</option><option value="read">read only</option><option value="write">read and write</option></select></label>
  <label><span style="min-width:90px"><b>Folders</b></span> <textarea id="folders" rows="3" placeholder="One folder per line, for example D:\\shop. Files and terminals work only inside these."></textarea></label>
  <label><span style="min-width:90px"><b>Your PIN</b></span> <input id="pin" type="password" inputmode="numeric" autocomplete="off"></label>
  <button id="go" type="submit">Approve this PC</button>
</form>
<script>
(function () {
  var code = new URLSearchParams(location.search).get('code') || '';
  var msg = document.getElementById('msg'), form = document.getElementById('form');
  function say(t, cls) { msg.textContent = t; msg.className = cls || 'muted'; }
  function $(id) { return document.getElementById(id); }
  fetch('/api/pc/enroll/' + encodeURIComponent(code), { credentials: 'same-origin' }).then(function (r) {
    if (r.status === 401) { say('Sign in to Friend in this browser first (open Friend and enter your password), then reload this page.', 'bad'); return null; }
    if (!r.ok) { say('That code is not valid any more. Run the install command on the PC again.', 'bad'); return null; }
    return r.json();
  }).then(function (d) {
    if (!d) return;
    $('host').textContent = d.host || 'A new PC'; $('os').textContent = d.os || '';
    $('name').value = d.name || '';
    var p = d.permissions || {};
    ['control', 'screen', 'shell', 'process', 'registry'].forEach(function (k) { $(k).checked = !!p[k]; });
    $('files').value = p.files || 'off'; $('folders').value = (p.folders || []).join('\\n');
    say('Friend is asked to add this PC. Check that this is your PC, then choose what it may do.');
    form.hidden = false;
  }).catch(function () { say('Could not reach Friend.', 'bad'); });
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    $('go').disabled = true;
    var body = {
      pin: $('pin').value, name: $('name').value.trim(),
      permissions: { control: $('control').checked, screen: $('screen').checked, shell: $('shell').checked, registry: $('registry').checked, process: $('process').checked, files: $('files').value, folders: $('folders').value.split('\\n').map(function (s) { return s.trim(); }).filter(Boolean) }
    };
    fetch('/api/pc/enroll/' + encodeURIComponent(code) + '/approve', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (x) {
        if (x.ok) { form.hidden = true; say('Approved. You can close this page: the PC connects by itself and starts again after a restart.', 'ok'); }
        else { say((x.j && x.j.error) || 'That did not work.', 'bad'); $('go').disabled = false; }
      }).catch(function () { say('Could not reach Friend.', 'bad'); $('go').disabled = false; });
  });
})();
</script></main></body></html>`;
}
