// Runner JSX/TSX (fichier FIXE, injecté tel quel par CodeAssembler). Monte un environnement DOM
// (happy-dom), transpile le composant étudiant (Babel), puis exécute le harnais DANS LA MÊME
// PORTÉE que le code étudiant. Le harnais dispose de :
//   html                 : rendu statique de <Composant /> (sans props)
//   render(C, p)         : rend un composant en HTML statique (avec props)
//   mount(C, p)          : MONTE un composant dans le DOM (interactif) → renvoie le conteneur
//   click(el)            : simule un clic (avec flush des mises à jour React)
//   fireEvent(el, t, i)  : simule un événement `t` (input, change, submit…)
//   document, window     : le DOM (happy-dom)
//   React, ReactDOMServer, useState/useEffect/useRef/... (hooks)
//   + toutes les fonctions définies par l'étudiant
const fs = require('fs');
const rt = require('./react-runtime.js');
const { React, ReactDOMServer, ReactDOMClient, act, HappyDOM, Babel } = rt;

// Environnement DOM global (React DOM client en a besoin).
const win = new HappyDOM.Window({ url: 'http://localhost/' });
global.window = win;
global.document = win.document;
global.navigator = win.navigator;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
['HTMLElement', 'Element', 'Node', 'Text', 'Event', 'MouseEvent', 'KeyboardEvent', 'InputEvent', 'CustomEvent', 'getComputedStyle', 'customElements', 'requestAnimationFrame', 'cancelAnimationFrame'].forEach((k) => {
  if (win[k] !== undefined) global[k] = win[k];
});

let result;
try {
  let src = fs.readFileSync(__dirname + '/component.tsx', 'utf8');
  // Retire imports/exports (React est fourni, pas de système de modules ici).
  src = src.replace(/^\s*import\s.+$/gm, '').replace(/^\s*export\s+(default\s+)?/gm, '');
  const js = Babel.transform(src, { presets: ['react', 'typescript'], filename: 'component.tsx' }).code;
  const harness = fs.readFileSync(__dirname + '/harness.js', 'utf8');

  const preamble =
    'var React = __R, ReactDOMServer = __RDS;\n' +
    'var useState=React.useState,useEffect=React.useEffect,useRef=React.useRef,useMemo=React.useMemo,useCallback=React.useCallback,useReducer=React.useReducer,useContext=React.useContext,Fragment=React.Fragment;\n' +
    'var render = function(C, p){ return __RDS.renderToStaticMarkup(React.createElement(C, p||{})); };\n' +
    'var mount = function(C, p){ var ct=document.createElement("div"); document.body.appendChild(ct); var root=__RDC.createRoot(ct); __act(function(){ root.render(React.createElement(C, p||{})); }); return ct; };\n' +
    'var click = function(el){ __act(function(){ el.dispatchEvent(new window.MouseEvent("click", { bubbles:true, cancelable:true })); }); };\n' +
    'var fireEvent = function(el, type, init){ __act(function(){ el.dispatchEvent(new window.Event(type, Object.assign({ bubbles:true, cancelable:true }, init||{}))); }); };\n';

  const body =
    preamble +
    js + '\n' +
    'var html; try { if (typeof Composant !== "undefined") { html = render(Composant); } } catch (e) { html = undefined; }\n' +
    'return (function(){\n' + harness + '\n})();';

  const fn = new Function('__R', '__RDS', '__RDC', '__act', 'document', 'window', body);
  result = fn(React, ReactDOMServer, ReactDOMClient, act, global.document, global.window);
} catch (e) {
  console.error(e && e.stack ? e.stack : String(e));
  process.exit(1);
}
// Anti-triche : n'émettre le nonce secret sur stderr QUE si le harnais a réussi. Le verdict est
// lu sur la présence du nonce (pas sur l'exit code, falsifiable).
if (result) {
  try { process.stderr.write(fs.readFileSync(__dirname + '/moodit-nonce.txt', 'utf8')); } catch (e) {}
}
process.exit(result ? 0 : 1);
