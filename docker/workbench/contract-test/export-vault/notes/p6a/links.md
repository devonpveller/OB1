---
title: "Link shapes"
---
# Link shapes

The tester's attempt-2 shapes (ADV-4), each a link pandoc reads, plus attribute blocks:

[click
me](javascript:EVILMULTI())

[`code`](javascript:EVILCODE())

[x](javascript:EVILNEST((1)))

see [ref].

[ref]:
    javascript:EVILREFDEF()

[ok](http://example.com){onclick="EVILLATTR()"}

[x](
javascript:EVILNLDEST())

![alt](http://example.com/a.png){onerror="EVILIATTR()"}

`c`{onclick="EVILC()"} and a raw `x`{=html}

## A heading {#h onclick="EVILH()"}

[sp]{onclick="EVILSP()"}

::: {onclick="EVILDV()"}
inside a div
:::

<a href="javascript:EVILA()">anchor</a> and <javascript:EVILAUTO()>

$ [m](javascript:EVILMATH()) $

A safe link [stays](https://example.org/safe) and cites [[source/f6a00000-0000-4000-8000-000000000001|one]].
