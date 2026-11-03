# Inert

Backticked: `${1 + 1}` and plain: ${2 + 2}

A `lua` fence is only highlighted:

```lua
function inert_marker() return "inert" end
```

<!--
A space-lua fence inside an HTML comment does not load:

```space-lua
function comment_marker() return "comment" end
```
-->
