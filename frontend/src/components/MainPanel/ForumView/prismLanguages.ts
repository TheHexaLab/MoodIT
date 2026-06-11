// Enregistrement des grammaires Prism (effet de bord). `./prismSetup` est importe
// EN PREMIER : il assigne `globalThis.Prism`, sur lequel les fichiers ci-dessous
// viennent greffer leurs grammaires. L'ordre respecte les dependances (ex. cpp
// etend c, php a besoin de markup-templating, tsx a besoin de jsx + typescript).
import './prismSetup';

import 'prismjs/components/prism-markup-templating';
import 'prismjs/components/prism-c';
import 'prismjs/components/prism-cpp';
import 'prismjs/components/prism-python';
import 'prismjs/components/prism-java';
import 'prismjs/components/prism-csharp';
import 'prismjs/components/prism-go';
import 'prismjs/components/prism-rust';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-yaml';
import 'prismjs/components/prism-sql';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-php';
import 'prismjs/components/prism-ruby';
import 'prismjs/components/prism-vhdl';
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-jsx';
import 'prismjs/components/prism-tsx';

import { Prism } from './prismSetup';

// ─── Detection de l'instanciation / usage d'un type selon le langage. ───
// Prism colore deja l'instanciation via `class-name` pour Java, TypeScript,
// Rust, PHP et Ruby, et via `constructor-invocation` (alias `class-name`) pour
// C#. Restent C/C++, Python et Go, ou l'usage d'un type n'est pas reconnu : on
// ajoute des motifs heuristiques (types en PascalCase) pour ces langages.

/**
 * Ajoute des motifs au token `class-name` d'une grammaire, en les priorisant.
 * Le token `class-name` peut etre absent (Go), un objet unique (Python) ou un
 * tableau (C/C++) : on normalise tout en tableau sans perdre l'existant.
 * `insertBeforeToken` sert quand le token n'existe pas encore (placement).
 */
type ClassNamePattern = RegExp | { pattern: RegExp; lookbehind?: boolean };

function addClassNamePatterns(
  lang: string,
  patterns: ClassNamePattern[],
  insertBeforeToken?: string
) {
  const grammar = Prism.languages[lang] as Record<string, unknown> | undefined;
  if (!grammar) return;
  const existing = grammar['class-name'];
  if (Array.isArray(existing)) existing.unshift(...patterns);
  else if (existing) grammar['class-name'] = [...patterns, existing];
  else if (insertBeforeToken) {
    Prism.languages.insertBefore(lang, insertBeforeToken, {
      'class-name': patterns,
    } as unknown as Parameters<typeof Prism.languages.insertBefore>[2]);
  } else grammar['class-name'] = patterns;
}

// C/C++ : `new MyClass(...)` et l'usage d'un type `MyClass obj;`, `Widget* p = …`.
for (const lang of ['c', 'cpp']) {
  addClassNamePatterns(lang, [
    { pattern: /(\bnew\s+)[A-Z]\w*/, lookbehind: true },
    /\b[A-Z]\w*(?=\s*[*&]*\s*[a-z_]\w*\s*[;,)=({[])/,
  ]);
}

// Python : instanciation = appel d'un nom PascalCase, ex. `MyClass(...)`.
addClassNamePatterns('python', [/\b[A-Z]\w*(?=\s*\()/]);

// Go : litteral compose d'un type PascalCase, ex. `Point{}`, `&Config{…}`.
addClassNamePatterns('go', [/\b[A-Z]\w*(?=\s*\{)/], 'function');
