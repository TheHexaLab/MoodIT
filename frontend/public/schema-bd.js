var stage = document.getElementById('stage');
var svgEl = document.getElementById('schema');
var WORLD = { x: -89.0, y: -89.0, w: 4923.0, h: 3436.0 };
var view = { x: WORLD.x, y: WORLD.y, w: WORLD.w, h: WORLD.h };
var animId = null;
var WMIN = 60, WMAX = WORLD.w * 4;

function stW() { return stage.clientWidth  || window.innerWidth || 1024; }
function stH() { return stage.clientHeight || ((window.innerHeight || 768) - 52); }
function aspect() { return stH() / stW(); }
function applyView() {
  view.h = view.w * aspect();
  svgEl.setAttribute('width',  stW());
  svgEl.setAttribute('height', stH());
  svgEl.setAttribute('viewBox', view.x + ' ' + view.y + ' ' + view.w + ' ' + view.h);
}
function pxToWorld(px, py) {
  return [view.x + (px / stW()) * view.w, view.y + (py / stH()) * view.h];
}
function targetFor(x, y, w, h, pad) {
  var a = aspect();
  var tw = w + 2 * pad, th = h + 2 * pad;
  if (th / tw > a) tw = th / a;
  return { x: x + w/2 - tw/2, y: y + h/2 - (tw * a)/2, w: tw };
}
function stopAnim() { if (animId) { cancelAnimationFrame(animId); animId = null; } }
function animateTo(t) {
  stopAnim();
  var s = { x: view.x, y: view.y, w: view.w };
  var t0 = (window.performance && performance.now) ? performance.now() : +new Date();
  var D = 550;
  function now() { return (window.performance && performance.now) ? performance.now() : +new Date(); }
  function step() {
    var k = Math.min(1, (now() - t0) / D);
    k = k < .5 ? 4*k*k*k : 1 - Math.pow(-2*k + 2, 3) / 2;
    view.x = s.x + (t.x - s.x) * k;
    view.y = s.y + (t.y - s.y) * k;
    view.w = s.w + (t.w - s.w) * k;
    applyView();
    if (k < 1) animId = requestAnimationFrame(step); else animId = null;
  }
  if (!window.requestAnimationFrame) { view.x = t.x; view.y = t.y; view.w = t.w; applyView(); return; }
  animId = requestAnimationFrame(step);
}
function goTo(x, y, w, h) { animateTo(targetFor(x, y, w, h, 30)); }
function fitAll(smooth) {
  var t = targetFor(WORLD.x, WORLD.y, WORLD.w, WORLD.h, 20);
  if (smooth) animateTo(t);
  else { view.x = t.x; view.y = t.y; view.w = t.w; applyView(); }
}
function zoomAt(px, py, f) {
  var w2 = Math.min(WMAX, Math.max(WMIN, view.w / f));
  f = view.w / w2;
  var wpt = pxToWorld(px, py);
  view.w = w2;
  view.x = wpt[0] - (wpt[0] - view.x) / f;
  view.y = wpt[1] - (wpt[1] - view.y) / f;
  applyView();
}
function stagePos(e) {
  var r = stage.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}

// --- molette / trackpad ---
function onWheel(e) {
  e.preventDefault(); stopAnim();
  var d = (e.deltaY !== undefined) ? e.deltaY : -e.wheelDelta;
  var p = stagePos(e);
  var f = e.ctrlKey ? Math.exp(-d * 0.01) : (d < 0 ? 1.18 : 1/1.18);
  zoomAt(p[0], p[1], f);
}
stage.addEventListener('wheel', onWheel, { passive: false });

// --- souris : glisser ---
var mDown = false, mX = 0, mY = 0;
stage.addEventListener('mousedown', function(e) {
  if (e.button !== 0) return;
  mDown = true; mX = e.clientX; mY = e.clientY;
  stage.className = 'drag'; stopAnim(); e.preventDefault();
});
window.addEventListener('mousemove', function(e) {
  if (!mDown) return;
  view.x -= (e.clientX - mX) * view.w / stW();
  view.y -= (e.clientY - mY) * view.h / stH();
  mX = e.clientX; mY = e.clientY; applyView();
});
window.addEventListener('mouseup', function() { mDown = false; stage.className = ''; });

// --- tactile : 1 doigt glisse, 2 doigts pincent ---
var tD = 0, tC = null, tP = null;
stage.addEventListener('touchstart', function(e) {
  stopAnim();
  if (e.touches.length === 1) { tP = [e.touches[0].clientX, e.touches[0].clientY]; }
  else if (e.touches.length === 2) {
    var a = e.touches[0], b = e.touches[1];
    tD = Math.sqrt(Math.pow(a.clientX-b.clientX,2) + Math.pow(a.clientY-b.clientY,2));
    tC = [(a.clientX+b.clientX)/2, (a.clientY+b.clientY)/2];
  }
  e.preventDefault();
}, { passive: false });
stage.addEventListener('touchmove', function(e) {
  if (e.touches.length === 1 && tP) {
    var t = e.touches[0];
    view.x -= (t.clientX - tP[0]) * view.w / stW();
    view.y -= (t.clientY - tP[1]) * view.h / stH();
    tP = [t.clientX, t.clientY]; applyView();
  } else if (e.touches.length === 2 && tD > 0) {
    var a = e.touches[0], b = e.touches[1];
    var d = Math.sqrt(Math.pow(a.clientX-b.clientX,2) + Math.pow(a.clientY-b.clientY,2));
    var c = [(a.clientX+b.clientX)/2, (a.clientY+b.clientY)/2];
    var r = stage.getBoundingClientRect();
    if (d > 0) zoomAt(c[0]-r.left, c[1]-r.top, d / tD);
    view.x -= (c[0] - tC[0]) * view.w / stW();
    view.y -= (c[1] - tC[1]) * view.h / stH();
    applyView();
    tD = d; tC = c;
  }
  e.preventDefault();
}, { passive: false });
stage.addEventListener('touchend', function(e) {
  if (e.touches.length === 0) { tP = null; tD = 0; }
  else if (e.touches.length === 1) { tP = [e.touches[0].clientX, e.touches[0].clientY]; tD = 0; }
});

// --- double-clic ---
stage.addEventListener('dblclick', function(e) {
  e.preventDefault();
  var p = stagePos(e);
  var wpt = pxToWorld(p[0], p[1]);
  var w2 = Math.max(WMIN, view.w / 2);
  animateTo({ x: wpt[0] - w2/2, y: wpt[1] - (w2 * aspect())/2, w: w2 });
});

// --- clavier ---
var Z = [[3243, 914, 1124, 1366], [12, 12, 1322, 641], [1474, 1150, 1579, 940], [3243, 2299, 1445, 906], [1824, 2509, 1229, 487], [910, 672, 424, 696]];
window.addEventListener('keydown', function(e) {
  var k = e.key || String.fromCharCode(e.keyCode);
  if (k === '0') fitAll(true);
  var n = parseInt(k, 10);
  if (n >= 1 && n <= Z.length) { var z = Z[n-1]; goTo(z[0], z[1], z[2], z[3]); }
});

var lastW = window.innerWidth;
window.addEventListener('resize', function() {
  applyView();
  if (Math.abs(window.innerWidth - lastW) > 40) { lastW = window.innerWidth; fitAll(false); }
});
fitAll(false);
window.addEventListener('load', function() { fitAll(false); });


// --- boutons de navigation (CSP: pas de onclick inline) ---
Array.prototype.forEach.call(document.querySelectorAll('[data-home]'), function (b) {
  b.addEventListener('click', function () { fitAll(true); });
});
Array.prototype.forEach.call(document.querySelectorAll('[data-goto]'), function (b) {
  b.addEventListener('click', function () {
    var z = b.getAttribute('data-goto').split(',').map(Number);
    goTo(z[0], z[1], z[2], z[3]);
  });
});
