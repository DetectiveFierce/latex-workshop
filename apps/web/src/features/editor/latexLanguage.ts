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
        [
          /\\(?:begin|end|documentclass|usepackage|RequirePackage|input|include|bibliography)(?=\[|\{)/,
          { token: 'keyword', next: '@argument' },
        ],
        [/\\(?:label|ref|eqref|pageref|cite|citep|citet)\{[^}]*\}/, 'latex.reference'],
        [
          /\\(?:title|author|date|part|chapter|section|subsection|subsubsection|paragraph)\*?(?=\{)/,
          { token: 'keyword', next: '@heading' },
        ],
        [/\\[a-zA-Z@]+\*?/, 'keyword'],
        [/\\./, 'string.escape'],
        [/\$[^$\n]+\$/, 'latex.math'],
        [/\$\$?|\\\[|\\\]/, 'delimiter.math'],
        [/[{}[\]()]/, '@brackets'],
        [/\b\d+(?:\.\d+)?\b/, 'number'],
      ],
      argument: [
        [/\[[^\]]*\]/, 'latex.option'],
        [/\{[^}]*\}/, { token: 'type.identifier', next: '@pop' }],
        ['', { token: '', next: '@pop' }],
      ],
      heading: [[/\{/, { token: 'string', switchTo: '@headingText' }]],
      headingText: [
        [/[^{}]+/, 'string'],
        [/\{/, 'string', '@push'],
        [/\}/, 'string', '@pop'],
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
      'editorLineNumber.foreground': hon.disabled,
      'editorCursor.foreground': hon.textBright,
      'editor.selectionBackground': hon.selection,
      'editor.inactiveSelectionBackground': hon.hover,
      'editor.lineHighlightBackground': hon.hover,
      'editorIndentGuide.background1': hon.hover,
      'editorIndentGuide.activeBackground1': hon.active,
      'editorWidget.background': hon.app,
      'editorWidget.foreground': hon.textBright,
      'editorWidget.border': hon.border,
      'input.background': hon.terminal,
      'input.foreground': hon.textBright,
      'input.border': hon.border,
      'input.placeholderForeground': hon.muted,
      'inputOption.activeBackground': hon.active,
      'inputOption.activeBorder': hon.green,
      'inputOption.activeForeground': hon.textBright,
      'inputOption.hoverBackground': hon.hover,
      'toolbar.hoverBackground': hon.hover,
      errorForeground: hon.red,
      'editorSuggestWidget.background': hon.app,
      'editorSuggestWidget.selectedBackground': hon.active,
      'editorHoverWidget.background': hon.app,
      'menu.background': hon.surface,
      'menu.foreground': hon.textBright,
      'menu.border': hon.border,
      'menu.selectionBackground': hon.active,
      'menu.selectionForeground': hon.textBright,
      'menu.selectionBorder': hon.green,
      'menu.separatorBackground': hon.border,
      'menubar.selectionBackground': hon.active,
      'menubar.selectionForeground': hon.textBright,
      'keybindingLabel.background': hon.terminal,
      'keybindingLabel.foreground': hon.text,
      'keybindingLabel.border': hon.border,
      'keybindingLabel.bottomBorder': hon.active,
      'widget.shadow': hon.widgetShadow,
      focusBorder: hon.focus,
    },
    rules: [
      { token: 'comment', foreground: hon.muted.replace('#', '') },
      { token: 'keyword', foreground: hon.red.slice(1) },
      { token: 'string', foreground: hon.yellow.slice(1) },
      { token: 'string.escape', foreground: hon.yellow.slice(1) },
      { token: 'number', foreground: hon.magenta.slice(1) },
      { token: 'type.identifier', foreground: hon.cyan.slice(1) },
      { token: 'latex.reference', foreground: hon.green.slice(1) },
      { token: 'latex.option', foreground: hon.orange.slice(1) },
      { token: 'latex.math', foreground: hon.orange.slice(1) },
      { token: 'delimiter.math', foreground: hon.green.slice(1) },
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
