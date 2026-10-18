---
title: "Raw HTML"
---
# Raw HTML

Before <script>alert("XSS-INLINE")</script> after <b onclick="EVIL1()">bold</b> and
<img src=x onerror="EVIL2()">.

<div>div body</div>

<script>
alert("XSS-BLOCK")
</script>

<!-- COMMENT-LEAK -->

<iframe src="javascript:EVIL4()"></iframe>

[a link](javascript:EVIL5()) and <a href="javascript:EVIL6()">anchor</a>.

[entity](jav&#x61;script:EVIL8()), [data](data:text/html;base64,PHNjcmlwdD4=), <javascript:EVIL11()>

Cite s [[source/f6a00000-0000-4000-8000-000000000001|s]].
