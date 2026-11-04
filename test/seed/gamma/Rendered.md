---
status: draft
---
# Rendered

A clean page that renders through the server: an expression, the page context, a query over tasks, a template include and a transclusion. It calls only functions of the shipped allowlist.

Sum: ${1 + 1}

Current page: ${_CTX.currentPage.name}

## Tasks
${template.each(query[[from t = index.tag "task" where string.startsWith(t.page, "Projects/") order by t.name]], templates.taskItem)}

## Projects
${query[[from p = index.tag "project" order by p.name select p.name]]}

## Transclusion
![[Projects/One]]
