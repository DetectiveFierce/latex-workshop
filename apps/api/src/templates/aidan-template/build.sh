#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
OUT_DIR="$ROOT_DIR/out"
SOURCE="$ROOT_DIR/template.tex"
PDF_NAME="template.pdf"

mkdir -p "$OUT_DIR"

for ext in aux fdb_latexmk fls log out synctex.gz toc; do
  rm -f "$ROOT_DIR/template.$ext"
done

latexmk \
  -pdf \
  -interaction=nonstopmode \
  -halt-on-error \
  -outdir="$OUT_DIR" \
  "$SOURCE"

mv "$OUT_DIR/$PDF_NAME" "$ROOT_DIR/$PDF_NAME"

for ext in aux fdb_latexmk fls log out synctex.gz toc; do
  rm -f "$ROOT_DIR/template.$ext"
done
