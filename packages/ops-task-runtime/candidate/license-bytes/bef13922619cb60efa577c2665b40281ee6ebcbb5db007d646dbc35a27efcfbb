# syntree.mbt

Incremental syntax tree and highlighting toolkit for MoonBit.

## Packages

- `mizchi/syntree` - core tree, cursor, highlight APIs, and extension mapping
- `mizchi/syntree/<lang>` - language tokenizers + highlighters
- `mizchi/syntree/highlight` - HTML rendering with inline styles
- `mizchi/syntree/syntree_api` - JS exports for the bundled highlighters

## Supported Languages (31)

bash, c, cpp, csharp, css, dart, dockerfile, go, graphql, haskell, html, java, json, kotlin, lua, makefile, mdx, moonbit, ocaml, php, python, ruby, rust, scala, sql, swift, toml, typescript, xml, yaml, zig

## MoonBit Usage

### DCE-friendly selective imports

Import only the languages you need for tree-shaking (Dead Code Elimination):

```moonbit
import {
  "mizchi/syntree"               // core + extension mapping
  "mizchi/syntree/typescript"    // TypeScript/JavaScript only
  "mizchi/syntree/rust"          // Rust only
}

fn main {
  // Get language from filename
  let lang = @syntree.get_language_for_filename("app.tsx")  // Some("typescript")

  // Highlight based on detected language
  let source = "const x: number = 1"
  let html = match lang {
    Some("typescript") => @typescript.highlight_typescript_to_html(source)
    Some("rust") => @rust.highlight_rust_to_html(source)
    _ => source
  }
  println(html)
}
```

### Extension Mapping API

```moonbit
// Get language name from file extension
@syntree.get_language_for_ext(".ts")      // Some("typescript")
@syntree.get_language_for_ext(".rs")      // Some("rust")
@syntree.get_language_for_ext(".unknown") // None

// Get language name from filename (handles special files)
@syntree.get_language_for_filename("Dockerfile")  // Some("dockerfile")
@syntree.get_language_for_filename("Makefile")    // Some("makefile")
@syntree.get_language_for_filename("main.go")     // Some("go")

// List all supported languages
@syntree.supported_languages()  // ["bash", "c", "cpp", ...]

// Get extensions for a language
@syntree.get_extensions_for_language("typescript")  // [".js", ".jsx", ".ts", ".tsx", ...]
```

### Incremental Highlighting with LineCache

`LineCache` provides line-based caching for efficient incremental syntax highlighting. It works with any language by accepting a highlight function:

```moonbit
import { "mizchi/syntree", "mizchi/syntree/typescript" }

fn main {
  let source = "const x = 1\nlet y = 2"

  // Create LineCache with a highlight function
  let cache = @syntree.LineCache::new(source, @typescript.highlight_typescript)

  // Get tokens for a specific line
  let line0_tokens = cache.get_line_tokens(0)

  // Get all tokens flattened
  let all_tokens = cache.all_tokens()

  // Update on edit (re-tokenizes from affected line)
  let new_source = "const x = 1\nlet y = 'hello'"
  let (start_line, end_line) = cache.update(new_source, 1, @typescript.highlight_typescript)

  // Full rebuild
  cache.rebuild("new source", @typescript.highlight_typescript)
}
```

**LineCache API:**

| Method | Description |
|--------|-------------|
| `LineCache::new(source, highlight_fn)` | Create cache from source |
| `line_count()` | Number of lines |
| `get_line_tokens(line)` | Tokens for a specific line |
| `all_tokens()` | All tokens flattened |
| `get_source()` | Current source text |
| `update(new_source, edit_line, highlight_fn)` | Incremental update, returns affected range |
| `rebuild(new_source, highlight_fn)` | Full rebuild |

## JS usage

`js/syntree_api.js` wraps the MoonBit JS build output and exposes convenience helpers.

```js
import { highlight, highlightTypeScript } from "./js/syntree_api.js";

const html = highlight("const x = 1", "ts");
const html2 = highlightTypeScript("const x = 1");
```

## Reference implementation

- Lezer: https://lezer.codemirror.net/

## Development

```bash
just check
just test
just bench
just info
```
