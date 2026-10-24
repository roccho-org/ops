# mizchi/jq

A jq clone implemented in MoonBit. Provides `compile`, `run`, and `run_string` for JSON query/transform.

## Quick Start

```mbt check
///|
test {
  inspect(
    @jq.run_string(".foo", "{\"foo\":42}"),
    content=(
      #|["42"]
    ),
  )
}
```

## API

### run_string — One-shot string-based execution

```mbt check
///|
test {
  inspect(
    @jq.run_string("[.[] | select(. > 3)]", "[1,2,3,4,5]"),
    content=(
      #|["[4,5]"]
    ),
  )
}
```

### run — Execute with Json value

```mbt check
///|
test {
  let input = @json.parse("{\"a\":1,\"b\":2}")
  let results = @jq.run("{sum: (.a + .b)}", input)
  inspect(
    results[0].stringify(),
    content=(
      #|{"sum":3}
    ),
  )
}
```

### compile + run_compiled — Pre-compile for repeated use

```mbt check
///|
test {
  let filter = @jq.compile("map(. * 2)")
  let r1 = @jq.run_compiled(filter, @json.parse("[1,2,3]"))
  let r2 = @jq.run_compiled(filter, @json.parse("[10,20]"))
  inspect(r1[0].stringify(), content="[2,4,6]")
  inspect(r2[0].stringify(), content="[20,40]")
}
```

## Error Handling

```mbt check
///|
test {
  let result = @jq.run_string(".foo", "not json") catch {
    @jq.JqError::JqError(msg) => ["Error: " + msg]
  }
  inspect(result[0].has_prefix("Error:"), content="true")
}
```

## Examples

### Field Access and Pipes

```mbt check
///|
test {
  let input = "{\"user\":{\"name\":\"alice\",\"age\":30}}"
  inspect(
    @jq.run_string(".user.name", input),
    content=(
      #|["\"alice\""]
    ),
  )
  inspect(
    @jq.run_string(".user | keys", input),
    content=(
      #|["[\"age\",\"name\"]"]
    ),
  )
}
```

### Array Operations

```mbt check
///|
test {
  let arr = "[3,1,4,1,5,9,2,6]"
  inspect(
    @jq.run_string("sort | unique", arr),
    content=(
      #|["[1,2,3,4,5,6,9]"]
    ),
  )
  inspect(
    @jq.run_string("map(. * 2) | add", arr),
    content=(
      #|["62"]
    ),
  )
}
```

### Reduce

```mbt check
///|
test {
  inspect(
    @jq.run_string("reduce .[] as $x (0; . + $x)", "[1,2,3,4,5]"),
    content=(
      #|["15"]
    ),
  )
}
```

### Object Construction

```mbt check
///|
test {
  let input = "[{\"name\":\"a\",\"val\":1},{\"name\":\"b\",\"val\":2}]"
  inspect(
    @jq.run_string("map({(.name): .val}) | add", input),
    content=(
      #|["{\"a\":1,\"b\":2}"]
    ),
  )
}
```

### Conditionals

```mbt check
///|
test {
  inspect(
    @jq.run_string(
      "map(if . > 0 then \"pos\" elif . == 0 then \"zero\" else \"neg\" end)", "[-1,0,1]",
    ),
    content=(
      #|["[\"neg\",\"zero\",\"pos\"]"]
    ),
  )
}
```

### User-Defined Functions

```mbt check
///|
test {
  inspect(
    @jq.run_string(
      "def double: . * 2; def inc: . + 1; map(double | inc)", "[1,2,3]",
    ),
    content=(
      #|["[3,5,7]"]
    ),
  )
}
```

### Format Strings

```mbt check
///|
test {
  inspect(
    @jq.run_string("@base64", "\"hello\""),
    content=(
      #|["\"aGVsbG8=\""]
    ),
  )
  inspect(
    @jq.run_string("@base64d", "\"aGVsbG8=\""),
    content=(
      #|["\"hello\""]
    ),
  )
}
```
