/* Vernacular workbench: decode two saved files, separate noise from the real change,
   and propose what the change means. Runs entirely in the browser. */
(function () {
  'use strict';

  var files = { a: null, b: null };
  var utf8 = new TextDecoder('utf-8', { fatal: true });

  // ---------- Decoding ----------

  function tryJSON(text) {
    try { return JSON.parse(text); } catch (e) { return undefined; }
  }

  function asText(bytes) {
    try { return utf8.decode(bytes); } catch (e) { return null; }
  }

  function decodePlain(bytes) {
    var text = asText(bytes);
    if (text === null) return null;
    var obj = tryJSON(text.trim());
    return obj === undefined ? null : { method: 'plain', obj: obj, text: text };
  }

  function decodeBase64(bytes) {
    var text = asText(bytes);
    if (text === null) return null;
    var t = text.replace(/\s+/g, '');
    if (t.length < 8 || !/^[A-Za-z0-9+/]+={0,2}$/.test(t)) return null;
    try {
      var bin = atob(t);
      var out = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      var inner = decodePlain(out);
      return inner ? { method: 'base64', obj: inner.obj, text: inner.text } : null;
    } catch (e) { return null; }
  }

  var JSON_CHARS = {};
  '"{}[]:,.-0123456789'.split('').forEach(function (c) { JSON_CHARS[c.charCodeAt(0)] = 3; });

  function charScore(v) {
    if (JSON_CHARS[v]) return JSON_CHARS[v];
    if (v >= 97 && v <= 122) return 2;            // lower-case letters
    if ((v >= 65 && v <= 90) || v === 95) return 1; // upper-case, underscore
    if (v >= 32 && v <= 126) return 0.5;
    if (v === 9 || v === 10 || v === 13) return 0.5;
    return -50;
  }

  function decodeRepeatingXor(bytes) {
    var n = bytes.length;
    if (n < 16) return null;
    for (var len = 1; len <= 16; len++) {
      var key = new Uint8Array(len);
      for (var j = 0; j < len; j++) {
        var best = 0, bestScore = -Infinity;
        for (var k = 0; k < 256; k++) {
          var s = 0;
          for (var i = j; i < n; i += len) s += charScore(bytes[i] ^ k);
          if (s > bestScore) { bestScore = s; best = k; }
        }
        key[j] = best;
      }
      var out = new Uint8Array(n);
      for (var p = 0; p < n; p++) out[p] = bytes[p] ^ key[p % len];
      var plain = decodePlain(out);
      if (plain) return { method: 'xor', key: key, obj: plain.obj, text: plain.text };
    }
    return null;
  }

  function decode(bytes) {
    return decodePlain(bytes) || decodeBase64(bytes) || decodeRepeatingXor(bytes);
  }

  // ---------- Comparing ----------

  var EMPTY_LIST = { label: 'empty list' };
  var EMPTY_GROUP = { label: 'empty group' };

  // Merge runs of sibling rows like ftsw[10] … ftsw[19] that share a reading and values.
  function groupRuns(rows) {
    var out = [];
    rows.forEach(function (r) {
      var m = r.path.match(/^(.*)\[(\d+)\]$/);
      var prev = out[out.length - 1];
      if (m && prev && prev.base === m[1] && prev.kind === r.kind && prev.before === r.before && prev.after === r.after && +m[2] === prev.last + 1) {
        prev.last = +m[2];
        prev.count++;
        prev.path = m[1] + '[' + prev.first + '–' + prev.last + ']';
        return;
      }
      var row = Object.assign({}, r);
      if (m) { row.base = m[1]; row.first = row.last = +m[2]; row.count = 1; }
      out.push(row);
    });
    out.forEach(function (r) {
      if (r.count > 1) r.reading = r.count + ' entries added together. ' + r.reading;
    });
    return out;
  }

  function flatten(obj, prefix, out) {
    out = out || {};
    if (obj !== null && typeof obj === 'object') {
      var keys = Object.keys(obj);
      if (keys.length === 0) out[prefix] = Array.isArray(obj) ? EMPTY_LIST : EMPTY_GROUP;
      keys.forEach(function (k) {
        var p = Array.isArray(obj) ? prefix + '[' + k + ']' : (prefix ? prefix + '.' + k : k);
        flatten(obj[k], p, out);
      });
    } else {
      out[prefix] = obj;
    }
    return out;
  }

  var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  function lastKey(path) {
    var m = path.match(/([A-Za-z0-9_]+)\]?$/);
    return m ? m[1] : path;
  }

  function classify(path, before, after) {
    var key = lastKey(path);
    if (UUID.test(String(after)) || UUID.test(String(before)) || /(^|_)(id|uuid|guid)$/i.test(key)) {
      return { kind: 'noise', reading: 'Generated ID. A new one is written on every save.' };
    }
    if (/name|title/i.test(key) && typeof (after === undefined ? before : after) === 'string') {
      return { kind: 'noise', reading: 'Name of the saved copy.' };
    }
    if (/(timestamp|modified|created|saved|date)/i.test(key)) {
      return { kind: 'noise', reading: 'Time of saving.' };
    }
    if (before === undefined) {
      return { kind: 'check', reading: 'Field added on save. Often a newer app version writing extra fields.' };
    }
    if (after === undefined) {
      return { kind: 'check', reading: 'Field removed on save.' };
    }
    return { kind: 'meaningful', reading: 'The change you made.' };
  }

  // Find a readable label for the object that holds a field, e.g. the block's model ID.
  function ownerLabel(obj, path) {
    var parts = path.match(/[^.[\]]+/g) || [];
    var chain = [obj];
    var cur = obj;
    for (var i = 0; i < parts.length - 1; i++) {
      if (cur === null || typeof cur !== 'object') break;
      cur = cur[parts[i]];
      chain.push(cur);
    }
    for (var c = chain.length - 1; c >= 0; c--) {
      var o = chain[c];
      if (!o || typeof o !== 'object' || Array.isArray(o)) continue;
      var keys = Object.keys(o);
      for (var k = 0; k < keys.length; k++) {
        var v = o[keys[k]];
        if (typeof v === 'string' && /(^id$|Id$|model|type|name)/.test(keys[k]) && !UUID.test(v) && !/^(dspUnit|Post|Pre)$/.test(v)) {
          return v;
        }
      }
    }
    return null;
  }

  // ---------- Rendering helpers ----------

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'text') node.textContent = attrs[k];
      else if (k === 'className') node.className = attrs[k];
      else node.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return node;
  }

  function fmt(v) {
    if (v === undefined) return '—';
    if (v === EMPTY_LIST || v === EMPTY_GROUP) return v.label;
    if (typeof v === 'number') return String(Math.round(v * 1e6) / 1e6);
    if (typeof v === 'string') return '"' + (v.length > 22 ? v.slice(0, 20) + '…' : v) + '"';
    return String(v);
  }

  function hex(bytes, count) {
    var out = [];
    for (var i = 0; i < Math.min(count, bytes.length); i++) out.push(('0' + bytes[i].toString(16)).slice(-2));
    return out.join(' ');
  }

  function keyText(key) {
    var printable = Array.prototype.every.call(key, function (b) { return b >= 33 && b <= 126; });
    var h = hex(key, key.length);
    return printable ? h + ' (the letters “' + String.fromCharCode.apply(null, key) + '”)' : h;
  }

  function show(id) { document.getElementById(id).hidden = false; }
  function hide(id) { document.getElementById(id).hidden = true; }

  // ---------- Slots ----------

  function setSlot(which, name, bytes) {
    files[which] = { name: name, bytes: bytes };
    var slot = document.getElementById('slot-' + which);
    slot.classList.add('filled');
    slot.querySelector('[data-role="file"]').textContent = name;
    slot.querySelector('[data-role="meta"]').textContent = bytes.length.toLocaleString() + ' bytes';
    run();
  }

  function readInput(which, input) {
    var f = input.files && input.files[0];
    if (!f) return;
    f.arrayBuffer().then(function (buf) { setSlot(which, f.name, new Uint8Array(buf)); });
  }

  ['a', 'b'].forEach(function (which) {
    var input = document.getElementById('file-' + which);
    var slot = document.getElementById('slot-' + which);
    input.addEventListener('change', function () { readInput(which, input); });
    input.addEventListener('dragenter', function () { slot.classList.add('dragging'); });
    input.addEventListener('dragleave', function () { slot.classList.remove('dragging'); });
    input.addEventListener('drop', function () { slot.classList.remove('dragging'); });
  });

  document.getElementById('load-example').addEventListener('click', function () {
    var btn = this;
    btn.disabled = true;
    Promise.all([
      fetch('examples/heavy-metal-before.preset').then(function (r) { return r.arrayBuffer(); }),
      fetch('examples/heavy-metal-after.preset').then(function (r) { return r.arrayBuffer(); })
    ]).then(function (bufs) {
      files.a = { name: 'Heavy_Metal.preset', bytes: new Uint8Array(bufs[0]) };
      setSlot('a', 'Heavy_Metal.preset', new Uint8Array(bufs[0]));
      setSlot('b', 'Heavy_Metal_2.preset', new Uint8Array(bufs[1]));
      exampleHint = { before: 5, after: 100 };
      run();
    }).catch(function () {
      document.getElementById('encoding-body').replaceChildren(el('p', { className: 'error', text: 'The example files could not be loaded. Open this page from the published site rather than from your disk.' }));
      show('encoding');
    }).finally(function () { btn.disabled = false; });
  });

  var exampleHint = null;

  // ---------- Main ----------

  function run() {
    if (!files.a || !files.b) return;
    var A = decode(files.a.bytes), B = decode(files.b.bytes);
    var body = document.getElementById('encoding-body');
    body.replaceChildren();
    show('encoding');

    if (!A || !B) {
      var which = !A && !B ? 'Neither file' : (!A ? 'The first file' : 'The second file');
      body.appendChild(el('h3', { text: 'Not recognised yet' }));
      body.appendChild(el('p', { text: which + ' matched a format the workbench can read: plain JSON, Base64 JSON, or JSON scrambled with a repeating key of up to 16 bytes. Binary formats, compression and encryption need the full teaching process.' }));
      hide('differences'); hide('reading');
      return;
    }

    var title, detail;
    if (A.method === 'xor') {
      title = 'Scrambled JSON, repeating ' + A.key.length + '-byte key';
      detail = 'Each byte is combined with the key ' + keyText(A.key) + ', repeated across the file. There is no checksum, so a correctly built file will be accepted as long as its contents are valid.';
    } else if (A.method === 'base64') {
      title = 'JSON wrapped in Base64';
      detail = 'The file is JSON text encoded as Base64.';
    } else {
      title = 'Plain JSON';
      detail = 'The file is readable JSON. No decoding needed.';
    }
    var sameScheme = A.method === B.method && (A.method !== 'xor' || hex(A.key, 99) === hex(B.key, 99));
    body.appendChild(el('h3', { text: title }));
    body.appendChild(el('p', { text: detail }));
    body.appendChild(el('p', { text: sameScheme ? 'Both files use the same scheme and decode completely.' : 'The two files use different schemes, which suggests they came from different app versions.' }));

    var pre = el('pre', { className: 'preview', 'aria-label': 'Start of the first file, before and after decoding' });
    pre.appendChild(el('span', { text: 'As saved   ' + hex(files.a.bytes, 24) + ' …\n' }));
    pre.appendChild(el('b', { text: 'Decoded    ' + JSON.stringify(A.obj).slice(0, 72) + ' …' }));
    body.appendChild(pre);

    // Differences
    var fa = flatten(A.obj, ''), fb = flatten(B.obj, '');
    var paths = Object.keys(fa).concat(Object.keys(fb).filter(function (k) { return !(k in fa); }));
    var rows = [];
    paths.forEach(function (p) {
      if (fa[p] === fb[p]) return;
      var c = classify(p, fa[p], fb[p]);
      rows.push({ path: p, before: fa[p], after: fb[p], kind: c.kind, reading: c.reading });
    });
    var order = { meaningful: 0, check: 1, noise: 2 };
    rows = groupRuns(rows);
    rows.sort(function (x, y) { return order[x.kind] - order[y.kind]; });

    var tbody = document.getElementById('diff-rows');
    tbody.replaceChildren();
    rows.forEach(function (r) {
      var kindWord = r.kind === 'meaningful' ? 'Meaningful' : (r.kind === 'check' ? 'Worth a check' : 'Incidental');
      tbody.appendChild(el('tr', { className: r.kind }, [
        el('td', { className: 'path', text: r.path }),
        el('td', {}, [el('span', { className: 'val before', text: fmt(r.before) })]),
        el('td', {}, [el('span', { className: 'val after', text: fmt(r.after) })]),
        el('td', {}, [el('strong', { className: 'kind', text: kindWord + '. ' }), r.reading])
      ]));
    });
    var counts = rows.reduce(function (acc, r) { acc[r.kind]++; return acc; }, { meaningful: 0, check: 0, noise: 0 });
    document.getElementById('diff-summary').textContent = rows.length === 0
      ? 'The two files are identical once decoded.'
      : rows.length + (rows.length === 1 ? ' field differs' : ' fields differ') + ': ' + counts.meaningful + ' meaningful, ' + counts.check + ' worth a check, ' + counts.noise + ' incidental.';
    show('differences');

    renderReading(rows.filter(function (r) { return r.kind === 'meaningful'; }), A.obj);
  }

  function renderReading(changes, obj) {
    var box = document.getElementById('reading-body');
    box.replaceChildren();
    if (changes.length === 0) { hide('reading'); return; }
    show('reading');

    var c = changes[0];
    var owner = ownerLabel(obj, c.path);
    var where = owner ? ' in ' + owner : '';
    var field = lastKey(c.path);

    var hypothesis = el('div');
    hypothesis.appendChild(el('h3', { text: 'Proposed meaning' }));
    var numeric = typeof c.before === 'number' && typeof c.after === 'number';
    var fraction = numeric && c.before >= 0 && c.before <= 1 && c.after >= 0 && c.after <= 1;
    if (fraction) {
      hypothesis.appendChild(el('p', { text: 'The setting “' + field + '”' + where + ' is stored as a fraction of its range, from 0 to 1. If the product shows it from 0 to 100, it went from ' + Math.round(c.before * 100) + ' to ' + Math.round(c.after * 100) + '.' }));
    } else if (numeric) {
      hypothesis.appendChild(el('p', { text: 'The setting “' + field + '”' + where + ' is stored as a number, which may be the value shown on screen or a value in real units.' }));
    } else {
      hypothesis.appendChild(el('p', { text: 'The setting “' + field + '”' + where + ' is stored by name. Each option on screen probably has its own word in the file.' }));
    }
    if (changes.length > 1) {
      hypothesis.appendChild(el('p', { className: 'small', text: changes.length + ' meaningful fields changed. For the clearest reading, change only one setting between saves.' }));
    }
    box.appendChild(hypothesis);

    var exp = el('div', { className: 'experiment' });
    exp.appendChild(el('h3', { text: 'Next experiment' }));
    if (!numeric) {
      exp.appendChild(el('p', { text: 'Save once with each option selected. The list of stored words, in order, becomes the vocabulary for this setting.' }));
      box.appendChild(exp);
      return;
    }
    exp.appendChild(el('p', { text: 'Two points fit any straight line, so check a third. Enter what the product showed for this setting in each file.' }));

    var idA = 'screen-before', idB = 'screen-after';
    var inA = el('input', { id: idA, type: 'number', inputmode: 'decimal' });
    var inB = el('input', { id: idB, type: 'number', inputmode: 'decimal' });
    if (exampleHint && fraction) { inA.value = exampleHint.before; inB.value = exampleHint.after; }
    exp.appendChild(el('label', { for: idA, text: 'Shown on screen before' }));
    exp.appendChild(inA);
    exp.appendChild(el('label', { for: idB, text: 'Shown on screen after' }));
    exp.appendChild(inB);
    var out = el('output', { for: idA + ' ' + idB, 'aria-live': 'polite' });
    exp.appendChild(out);
    box.appendChild(exp);

    function check() {
      var sa = parseFloat(inA.value), sb = parseFloat(inB.value);
      if (isNaN(sa) || isNaN(sb) || sa === sb) { out.textContent = ''; return; }
      var slope = (c.after - c.before) / (sb - sa);
      var offset = c.before - slope * sa;
      var lo = Math.min(sa, sb), hi = Math.max(sa, sb);
      var probe = (lo < 37 && hi > 37) ? 37 : Math.round(lo + (hi - lo) * 0.37);
      var expected = offset + slope * probe;
      var rule = Math.abs(offset) < 1e-6
        ? 'stored = shown × ' + (Math.round(slope * 1e6) / 1e6)
        : 'stored = ' + (Math.round(slope * 1e6) / 1e6) + ' × shown + ' + (Math.round(offset * 1e6) / 1e6);
      out.textContent = 'If the rule is ' + rule + ', setting it to ' + (Math.round(probe * 100) / 100) + ' should store ' + (Math.round(expected * 1e4) / 1e4) + '. Save at that value and add the file here to confirm.';
    }
    inA.addEventListener('input', check);
    inB.addEventListener('input', check);
    check();
  }
})();
