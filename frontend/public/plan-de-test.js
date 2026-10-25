(function () {
  var FILE = 'Plan_de_test_MoodIT.xlsx';
  var STYLES = 'plan-de-test.styles.json';
  var statusEl = document.getElementById('status');
  var tabsEl = document.getElementById('tabs');
  var sheetEl = document.getElementById('sheet');
  var wb = null;
  var styles = null; // { defaults:{bg,fg}, sheets:{ name:{ "r,c":{b,f,w} } } }

  function setError(msg) {
    statusEl.style.display = '';
    statusEl.className = 'error';
    statusEl.textContent = msg;
  }

  function cellText(cell) {
    if (!cell) return '';
    if (cell.w != null) return cell.w;
    if (cell.v == null) return '';
    return String(cell.v);
  }

  // Plage réellement utilisée : on rogne les lignes/colonnes vides en fin.
  function usedRange(ws) {
    var ref = ws['!ref'];
    if (!ref) return null;
    var full = XLSX.utils.decode_range(ref);
    var maxR = -1, maxC = -1;
    for (var R = full.s.r; R <= full.e.r; R++) {
      for (var C = full.s.c; C <= full.e.c; C++) {
        var cell = ws[XLSX.utils.encode_cell({ r: R, c: C })];
        if (cell && cellText(cell).trim() !== '') {
          if (R > maxR) maxR = R;
          if (C > maxC) maxC = C;
        }
      }
    }
    // On étend si une fusion dépasse le contenu.
    (ws['!merges'] || []).forEach(function (m) {
      if (m.e.r > maxR) maxR = m.e.r;
      if (m.e.c > maxC) maxC = m.e.c;
    });
    if (maxR < full.s.r || maxC < full.s.c) return null;
    return { s: { r: full.s.r, c: full.s.c }, e: { r: maxR, c: maxC } };
  }

  // anchors : cellule haut-gauche d'une fusion (span) ; covered : cellules masquées.
  function buildMergeMaps(ws) {
    var anchors = {}, covered = {};
    (ws['!merges'] || []).forEach(function (m) {
      anchors[m.s.r + ':' + m.s.c] = {
        rowspan: m.e.r - m.s.r + 1,
        colspan: m.e.c - m.s.c + 1
      };
      for (var R = m.s.r; R <= m.e.r; R++) {
        for (var C = m.s.c; C <= m.e.c; C++) {
          if (R === m.s.r && C === m.s.c) continue;
          covered[R + ':' + C] = true;
        }
      }
    });
    return { anchors: anchors, covered: covered };
  }

  function renderSheet(name) {
    var ws = wb.Sheets[name];
    sheetEl.textContent = '';
    var range = ws ? usedRange(ws) : null;
    if (!range) {
      var empty = document.createElement('p');
      empty.textContent = 'Feuille vide.';
      empty.style.color = 'var(--muted)';
      sheetEl.appendChild(empty);
      return;
    }
    var mm = buildMergeMaps(ws);
    var styleMap = (styles && styles.sheets[name]) || null;
    var table = document.createElement('table');
    var thead = document.createElement('thead');
    var tbody = document.createElement('tbody');

    for (var R = range.s.r; R <= range.e.r; R++) {
      var isHeader = (R === range.s.r);
      var tr = document.createElement('tr');
      for (var C = range.s.c; C <= range.e.c; C++) {
        var key = R + ':' + C;
        if (mm.covered[key]) continue;
        var cell = ws[XLSX.utils.encode_cell({ r: R, c: C })];
        var td = document.createElement(isHeader ? 'th' : 'td');
        var a = mm.anchors[key];
        if (a) {
          if (a.rowspan > 1) td.rowSpan = a.rowspan;
          if (a.colspan > 1) td.colSpan = a.colspan;
        }
        td.textContent = cellText(cell);
        if (!isHeader && cell && cell.t === 'n') td.className = 'num';
        // Couleurs du document Excel (fond/texte/gras) — cf. plan-de-test.styles.json.
        var st = styleMap && styleMap[key];
        if (st) {
          if (st.b) td.style.backgroundColor = '#' + st.b;
          if (st.f) td.style.color = '#' + st.f;
          if (st.w) td.style.fontWeight = '700';
        }
        tr.appendChild(td);
      }
      (isHeader ? thead : tbody).appendChild(tr);
    }
    table.appendChild(thead);
    table.appendChild(tbody);
    sheetEl.appendChild(table);
    sheetEl.scrollTop = 0;
  }

  function selectTab(name, btn) {
    Array.prototype.forEach.call(tabsEl.children, function (b) {
      b.setAttribute('aria-selected', b === btn ? 'true' : 'false');
    });
    try { history.replaceState(null, '', '#' + encodeURIComponent(name)); } catch (e) { /* noop */ }
    renderSheet(name);
  }

  function buildTabs() {
    wb.SheetNames.forEach(function (name) {
      var btn = document.createElement('button');
      btn.className = 'tab';
      btn.type = 'button';
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', 'false');
      btn.textContent = name;
      btn.addEventListener('click', function () { selectTab(name, btn); });
      tabsEl.appendChild(btn);
    });
  }

  function initialIndex() {
    var h = decodeURIComponent((location.hash || '').replace(/^#/, ''));
    var idx = wb.SheetNames.indexOf(h);
    return idx >= 0 ? idx : 0;
  }

  // Les styles sont optionnels : en cas d'échec, on rend quand même les données.
  var stylesReq = fetch(STYLES)
    .then(function (r) { return r.ok ? r.json() : null; })
    .catch(function () { return null; });

  var dataReq = fetch(FILE).then(function (r) {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.arrayBuffer();
  });

  Promise.all([dataReq, stylesReq])
    .then(function (res) {
      styles = res[1];
      wb = XLSX.read(res[0], { type: 'array' });
      if (!wb.SheetNames.length) throw new Error('classeur vide');
      statusEl.style.display = 'none';
      buildTabs();
      var idx = initialIndex();
      selectTab(wb.SheetNames[idx], tabsEl.children[idx]);
    })
    .catch(function (e) {
      setError('Impossible de charger le plan de test : ' + e.message);
    });
})();
