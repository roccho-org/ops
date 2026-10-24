# mwac

A WebAssembly Component Model composition tool written in [MoonBit](https://www.moonbitlang.com/).

Parses [WAC (WebAssembly Compositions)](https://github.com/bytecodealliance/wac) `.wac` scripts and composes multiple WebAssembly Components into a single component via plug/compose.

## Positioning (mwac + walyze)

- `mwac`: WAC API / composition (bundler role)
- `walyze`: wasm/component optimizer + profiler (minifier role)

Architecture guardrails:

- `mwac` is responsible for composition only (dependency resolution, instantiate/export planning, component assembly).
- binary-level optimization and profiling belong to `walyze`.
- dependency direction is fixed to `walyze -> mwac` (no direct `mwac -> walyze` dependency).
- integration contract is bytes I/O: `mwac` emits wasm/component bytes, then `walyze` optimizes/analyzes those bytes.

## Features

- `.wac` script parsing and resolution
- Component Model binary (`.wasm`) parsing (import/export extraction, type analysis)
- `plug` — satisfy a component's imports with another component's exports
- `compose` — compose multiple components based on a WAC script
- Dead Code Elimination (composition-plan level pruning of unused instances)
- WIT interface type compatibility checking

## Recommended Pipeline (Bundler + Minifier)

1. Compose components with `mwac` (produce `.component.wasm`)
2. Optimize/profile the output with `walyze`

This keeps API and optimization concerns separated while preserving a reproducible build flow.

## Project Structure

```
src/
├── component/    # Component Model binary parser, plug, encoder
└── composer/     # WAC parser, resolver, composer, DCE

examples/
├── hello/        # Single component example
├── compose/      # Multi-component composition example
├── core-module/  # Core Module plug example
└── wac/          # WAC script example
```

## WAC Script Example

```wac
package example:composition;

let hello = new example:hello {};
let greeter = new example:greeter {
  hello: hello.hello,
};

export greeter.greet;
```

## Development

```bash
just           # check + test
just fmt       # format code
just check     # type check
just test      # run tests
just run       # run main
```

## Dependencies

- [MoonBit](https://www.moonbitlang.com/) toolchain
- [mizchi/wit](https://mooncakes.io/docs/#/mizchi/wit/) — WIT parser

## License

Apache-2.0
