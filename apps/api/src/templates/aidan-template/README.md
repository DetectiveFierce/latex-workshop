# LaTeX PDF Template

This repository is a LaTeX port of the styling from
[`DetectiveFierce/rmd-template`](https://github.com/DetectiveFierce/rmd-template).
It keeps the same PDF look, header rules, colors, typography helpers, proof-line
blocks, math utilities, and table spacing, but removes the R Markdown, knitr,
YAML, and R package machinery.

## Quick Start

1. Edit `template.tex`.
2. Set the document title and author in the LaTeX preamble:

```tex
\renewcommand{\mytitle}{Your Title}
\renewcommand{\myauthor}{Your Name}
```

3. Compile the document:

```sh
./build.sh
```

The build script writes LaTeX intermediates and the first PDF pass into `out/`,
then moves only the finished `template.pdf` back to the project root.

## Requirements

You need a LaTeX distribution that can render PDF output with `pdflatex`. No R
installation or R packages are required.

## Build Pipeline

Use `./build.sh` as the unified build entry point. It creates `out/`, runs
`latexmk` with `out/` as the build directory, and moves the completed
`out/template.pdf` to `template.pdf`.

The included `.latexmkrc` also points direct `latexmk` invocations at `out/`, but
the build script is the intended workflow because it performs the final PDF copy.

## What's Included

`template.tex` is the main starter document. It includes a normal LaTeX preamble
wired to the shared header and examples of the custom proof-line, math, and code
listing styles.

`build.sh` is the unified build pipeline. It keeps generated files in `out/` and
publishes only the finished PDF to the template root.

`lib/in_header.tex` is the header entry point. It loads the package list, custom
commands, and document configuration.

`lib/packages.tex` contains LaTeX package imports for math, graphics, TikZ,
layout, tables, boxes, colors, captions, hyperlinks, and pure LaTeX code
listings.

`lib/commands.tex` contains custom authoring tools:

- `\mytitle` and `\myauthor` metadata commands.
- `\UNsection`, `\UNsubsection`, and `\multiheading` heading helpers.
- `\highlight{...}` for green emphasized text.
- `\mathbox{color}{...}` for boxed display math.
- `proofline` for nested proof/explanation blocks with a vertical rule.
- TikZ helpers, custom bullets, circled enumerate labels, and table column types.

`lib/config.tex` contains document-wide styling:

- Page geometry and header/footer rules.
- The shared color palette.
- Display math spacing.
- Table spacing.
- Section formatting.
- Pure LaTeX `listings` code styling.

## Typical Customization

For a new document, edit `template.tex` directly or copy it to another `.tex`
file in the project root.

Update the title and author in the preamble, then write using normal LaTeX and
the custom commands from `lib/commands.tex`.

If you need to change visual styling across every document, edit the files in
`lib/` instead of repeating LaTeX in individual documents.
