# mizchi/jq

A jq clone implemented in MoonBit.

## Install CLI

```bash
moon install mizchi/jq/cmd/moonjq
```

This installs `moonjq` to `~/.moon/bin/moonjq`.

```bash
echo '{"name":"alice","age":30}' | moonjq '.name'
# "alice"

echo '[1,2,3,4,5]' | moonjq 'map(. * 2) | add'
# 30

echo '[{"a":1},{"a":2},{"a":3}]' | moonjq '[.[] | select(.a > 1)]'
# [{"a":2},{"a":3}]
```

## Use as Library

```bash
moon add mizchi/jq
```

```moonbit
let results = @jq.run(".foo", @json.parse("{\"foo\":42}"))
// results = [Number(42)]

// Pre-compile for repeated use
let filter = @jq.compile("map(. + 1)")
let r1 = @jq.run_compiled(filter, @json.parse("[1,2,3]"))
// r1 = [Array([Number(2), Number(3), Number(4)])]
```

See [README.mbt.md](src/README.mbt.md) for full doc-tested API examples.

## Compatibility

96.2% compatible with jq 1.8.1 (252/262 verified tests).

429 of 514 jq.test cases ported. 496 MoonBit tests total, all passing.

### Supported Features

| Category | Features |
|---|---|
| Basic | `.`, `.foo`, `.[n]`, `.[]`, `..`, `.[m:n]` |
| Operators | `\|`, `,`, `+ - * / %`, `== != < > <= >=`, `and or not`, `//` |
| Assignment | `=`, `\|=`, `+=`, `-=`, `*=`, `/=`, `%=`, `//=` |
| Construction | `[expr]`, `{k: v}`, `{foo}` (shorthand), `(expr)`, `"\(.expr)"` |
| Control | `if-then-elif-else-end`, `try-catch`, `.foo?`, `foreach`, `while`, `until`, `label/break` |
| Binding | `as $x`, `as [$a,$b]`, `as {a:$x}`, `?//`, `reduce`, `def` |
| Path | `path()`, `setpath()`, `getpath()`, `delpaths()`, `del()`, `pick()` |
| Builtins | `length`, `keys`, `values`, `type`, `select`, `map`, `map_values`, `empty`, `add`, `sort`, `sort_by`, `group_by`, `unique`, `unique_by`, `reverse`, `flatten`, `min`, `max`, `min_by`, `max_by`, `first`, `last`, `limit`, `range`, `has`, `contains`, `inside`, `any`, `all`, `tostring`, `tonumber`, `toboolean`, `tojson`, `fromjson`, `ascii_downcase`, `ascii_upcase`, `split`, `join`, `startswith`, `endswith`, `ltrimstr`, `rtrimstr`, `trim`, `ltrim`, `rtrim`, `trimstr`, `abs`, `fabs`, `floor`, `ceil`, `round`, `explode`, `implode`, `to_entries`, `from_entries`, `with_entries`, `walk`, `transpose`, `bsearch`, `indices`, `index`, `rindex`, `not`, `recurse`, `debug`, `IN`, `INDEX`, `error`, `paths`, `isempty`, `nth`, `skip`, `builtins`, `utf8bytelength`, `$__loc__` |
| Math | `sqrt`, `sin`, `cos`, `atan`, `atan2`, `log`, `log2`, `exp`, `exp2`, `pow`, `infinite`, `nan`, `isnan`, `isinfinite`, `isfinite`, `isnormal` |
| Formats | `@base64`, `@base64d`, `@json`, `@text`, `@html`, `@uri` |
| Types | `numbers`, `strings`, `booleans`, `nulls`, `arrays`, `objects`, `iterables`, `scalars` |

### Excluded Tests (85 of 514)

| Feature | Tests | Notes |
|---|---|---|
| `import/include` | 10 | Module system (out of scope) |
| `input` | 1 | Multi-input I/O |

### Remaining Incompatibilities (10 of 262 tested)

All caused by platform constraints (IEEE 754 double / JS string handling):

| Issue | Tests | Detail |
|---|---|---|
| Large integers > 2^53 | 4 | Overflow to `Infinity` instead of exact representation |
| `-0` handling | 1 | `abs` on `-0.0` outputs `0` instead of `-0` |
| NUL byte (`\u0000`) in strings | 2 | `contains` and `toboolean` misbehave with embedded NUL |
| `path()` error message | 1 | Missing result value in error message |
| `pick(last)` negative index | 1 | Different error from jq |
| `fromjson` error message | 1 | MoonBit JSON parser produces different error text |

## Quick Commands

```bash
just           # check + test
just fmt       # format code
just check     # type check
just test      # run tests
just moonjq FILTER  # run CLI
```

## License

Apache-2.0
