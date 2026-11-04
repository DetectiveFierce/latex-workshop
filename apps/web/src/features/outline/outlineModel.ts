export type SourceSymbol = {
  name: string;
  detail: string;
  kind: number;
  line: number;
  endLine: number;
  children: SourceSymbol[];
};
export type OutlineNode = {
  id: string;
  path: string;
  name: string;
  label: string;
  line: number;
  endLine: number;
  category: 'section' | 'equation' | 'figure' | 'table' | 'theorem' | 'label';
  level: number;
  numbered: boolean;
  number: string;
  children: OutlineNode[];
};

/** Resolve includes within the project; paths never escape the project root. */
export function sourceIncludes(path: string, content: string): { path: string; line: number }[] {
  const folder = path.split('/').slice(0, -1);
  const clean = content.replace(/(?<!\\)%[^\n]*/g, '');
  return [...clean.matchAll(/\\(?:input|include|subfile)\s*\{([^}]+)\}/g)].flatMap((match) => {
    const target = match[1]?.trim();
    if (!target || target.includes('\\') || target.startsWith('/')) return [];
    const parts = [...folder];
    for (const part of target.split('/')) {
      if (part === '..') {
        if (!parts.length) return [];
        parts.pop();
      } else if (part && part !== '.') parts.push(part);
    }
    const resolved = parts.join('/');
    return [
      {
        path: resolved.endsWith('.tex') ? resolved : `${resolved}.tex`,
        line: clean.slice(0, match.index).split('\n').length,
      },
    ];
  });
}
export function includedPaths(path: string, content: string): string[] {
  return sourceIncludes(path, content).map((include) => include.path);
}

/** TexLab determines symbol ranges/hierarchy; saved source supplies types and labels. */
export function symbolsToOutline(
  path: string,
  content: string,
  symbols: SourceSymbol[],
): OutlineNode[] {
  const lines = content.split('\n');
  const convert = (symbol: SourceSymbol): OutlineNode => {
    const source = lines[symbol.line - 1] ?? '';
    const label =
      /\\label\s*\{([^}]+)\}/.exec(source)?.[1] ??
      (/^[^\s{}]+:[^\s{}]+$/.test(symbol.detail)
        ? symbol.detail
        : /^(?:eq|fig|tab|thm|lem|prop|sec):/.test(symbol.name)
          ? symbol.name
          : '');
    const heading =
      /\\(part|chapter|(?:sub){0,2}section|(?:sub)?paragraph)(\*)?\s*(?:\[[^\]]*\])?\s*\{/.exec(
        source,
      );
    const category: OutlineNode['category'] = heading
      ? 'section'
      : /(?:equation|align|gather|multline|eq:)/i.test(`${source} ${symbol.name} ${symbol.detail}`)
        ? 'equation'
        : /(?:figure|fig:)/i.test(`${source} ${symbol.name} ${symbol.detail}`)
          ? 'figure'
          : /(?:table|tab:)/i.test(`${source} ${symbol.name} ${symbol.detail}`)
            ? 'table'
            : /(?:theorem|lemma|proposition|corollary|definition|remark|thm:|lem:|prop:)/i.test(
                  `${source} ${symbol.name} ${symbol.detail}`,
                )
              ? 'theorem'
              : 'label';
    const headingName = heading?.[1] ?? 'section';
    const level =
      headingName === 'part' || headingName === 'chapter'
        ? 1
        : headingName === 'section'
          ? 1
          : headingName === 'subsection'
            ? 2
            : headingName === 'subsubsection'
              ? 3
              : 4;
    const name =
      label === symbol.name && category !== 'label'
        ? category === 'theorem'
          ? /lem:|lemma/i.test(`${label} ${source}`)
            ? 'Lemma'
            : /prop:|proposition/i.test(`${label} ${source}`)
              ? 'Proposition'
              : 'Theorem'
          : category[0]?.toUpperCase() + category.slice(1)
        : symbol.name;
    return {
      id: `${path}:${symbol.line}:${symbol.name}`,
      path,
      name,
      label,
      line: symbol.line,
      endLine: symbol.endLine,
      category,
      level,
      numbered: !heading?.[2],
      number: '',
      children: symbol.children.map(convert),
    };
  };
  return symbols.map(convert);
}

function flattenOutline(nodes: OutlineNode[]): OutlineNode[] {
  return nodes.flatMap((node) => [{ ...node, children: [] }, ...flattenOutline(node.children)]);
}

/** Rebuild section depth after inserting included files at their source positions. */
export function mergeIncludedOutline(
  own: OutlineNode[],
  included: { line: number; nodes: OutlineNode[] }[],
): OutlineNode[] {
  const events = [
    ...flattenOutline(own).map((node) => ({ line: node.line, nodes: [node] })),
    ...included.map((include) => ({ ...include, nodes: flattenOutline(include.nodes) })),
  ].sort((left, right) => left.line - right.line);
  const roots: OutlineNode[] = [];
  const sections: OutlineNode[] = [];
  for (const node of events.flatMap((event) => event.nodes)) {
    if (node.category === 'section') {
      while (sections.length && (sections.at(-1)?.level ?? 0) >= node.level) sections.pop();
      const parent = sections.at(-1);
      (parent ? parent.children : roots).push(node);
      sections.push(node);
    } else {
      const parent = sections.at(-1);
      (parent ? parent.children : roots).push(node);
    }
  }
  return roots;
}

/** Section numbering follows source order. Object numbers remain TexLab-authoritative. */
export function numberOutline(nodes: OutlineNode[]): OutlineNode[] {
  const sections = [0, 0, 0, 0];
  const number = (node: OutlineNode): OutlineNode => {
    let value = '';
    if (node.category === 'section' && node.numbered) {
      const index = Math.min(3, Math.max(0, node.level - 1));
      sections[index] = (sections[index] ?? 0) + 1;
      for (let next = index + 1; next < sections.length; next++) sections[next] = 0;
      value = sections.slice(0, index + 1).join('.');
    }
    return { ...node, number: value, children: node.children.map(number) };
  };
  return nodes.map(number);
}
