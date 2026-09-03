import type * as Monaco from 'monaco-editor';
import { hateOfNature as hon } from '@latex-workshop/ui';

let registered = false;

export function registerLatexLanguage(monaco: typeof Monaco) {
  if (registered) return;
  registered = true;
  monaco.languages.register({
    id: 'latex',
    extensions: ['.tex', '.sty', '.cls'],
    aliases: ['LaTeX', 'TeX'],
  });
  monaco.languages.setLanguageConfiguration('latex', {
    comments: { lineComment: '%' },
    brackets: [
      ['{', '}'],
      ['[', ']'],
      ['(', ')'],
    ],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '$', close: '$' },
    ],
    surroundingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '$', close: '$' },
    ],
    folding: { markers: { start: /^\s*%\s*#?region\b/, end: /^\s*%\s*#?endregion\b/ } },
  });
  monaco.languages.setMonarchTokensProvider('latex', {
    tokenizer: {
      root: [
        [/%.*$/, 'comment'],
        [/\\(?:begin|end)(?=\{)/, 'keyword'],
        [/\\(?:documentclass|usepackage|RequirePackage)(?=\[|\{)/, 'keyword'],
        [/\\(?:label|ref|eqref|pageref|cite|citep|citet)(?=\{)/, 'type.identifier'],
        [/\\[a-zA-Z@]+\*?/, 'keyword'],
        [/\\./, 'string.escape'],
        [/\$\$?|\\\[|\\\]/, 'delimiter.math'],
        [/[{}[\]()]/, '@brackets'],
        [/\b\d+(?:\.\d+)?\b/, 'number'],
      ],
    },
  });
  monaco.languages.registerCompletionItemProvider('latex', {
    triggerCharacters: ['\\', '{'],
    provideCompletionItems(model, position) {
      const range = model.getWordUntilPosition(position);
      const replace = new monaco.Range(
        position.lineNumber,
        range.startColumn,
        position.lineNumber,
        range.endColumn,
      );
      const snippets: ReadonlyArray<readonly [string, string, string]> = [
        ['section', '\\section{${1:Title}}', 'Section'],
        ['subsection', '\\subsection{${1:Title}}', 'Subsection'],
        ['begin', '\\begin{${1:environment}}\n\t${0}\n\\end{${1:environment}}', 'Environment'],
        [
          'figure',
          '\\begin{figure}[ht]\n\t\\centering\n\t\\includegraphics[width=${1:0.8}\\textwidth]{${2:image}}\n\t\\caption{${3:Caption}}\n\t\\label{fig:${4:key}}\n\\end{figure}',
          'Figure',
        ],
        [
          'equation',
          '\\begin{equation}\n\t${1}\n\t\\label{eq:${2:key}}\n\\end{equation}',
          'Equation',
        ],
        ['itemize', '\\begin{itemize}\n\t\\item ${1}\n\\end{itemize}', 'Itemized list'],
      ];
      return {
        suggestions: snippets.map(([label, insertText, documentation]) => ({
          label,
          insertText,
          documentation,
          range: replace,
          kind: monaco.languages.CompletionItemKind.Snippet,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
        })),
      };
    },
  });
  monaco.editor.defineTheme('hate-of-nature', {
    base: 'vs-dark',
    inherit: true,
    colors: {
      'editor.background': hon.editor,
      'editor.foreground': hon.text,
      'editorLineNumber.foreground': hon.muted,
      'editorCursor.foreground': hon.textBright,
      'editor.selectionBackground': '#3a6bff40',
      'editor.inactiveSelectionBackground': hon.hover,
      'editor.lineHighlightBackground': hon.hover,
      'editorIndentGuide.background1': hon.hover,
      'editorIndentGuide.activeBackground1': hon.active,
      'editorWidget.background': hon.app,
      'editorWidget.border': hon.border,
      'editorSuggestWidget.background': hon.app,
      'editorSuggestWidget.selectedBackground': hon.active,
      'editorHoverWidget.background': hon.app,
      focusBorder: hon.green,
    },
    rules: [
      { token: 'comment', foreground: hon.muted.replace('#', ''), fontStyle: 'italic' },
      { token: 'keyword', foreground: 'f92672' },
      { token: 'string', foreground: 'e6db74' },
      { token: 'string.escape', foreground: 'e6db74' },
      { token: 'number', foreground: 'ae81ff' },
      { token: 'type.identifier', foreground: '66d9ef' },
      { token: 'delimiter.math', foreground: 'a6e22e' },
      { token: 'delimiter', foreground: hon.text.replace('#', '') },
    ],
  });
}

export function languageFor(name: string) {
  if (/\.(tex|sty|cls)$/i.test(name)) return 'latex';
  if (/\.bib$/i.test(name)) return 'bibtex';
  if (/\.md$/i.test(name)) return 'markdown';
  if (/\.json$/i.test(name)) return 'json';
  if (/\.ya?ml$/i.test(name)) return 'yaml';
  if (/\.tsx?$/i.test(name)) return 'typescript';
  if (/\.jsx?$/i.test(name)) return 'javascript';
  if (/\.py$/i.test(name)) return 'python';
  return 'plaintext';
}
