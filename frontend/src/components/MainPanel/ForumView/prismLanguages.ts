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
