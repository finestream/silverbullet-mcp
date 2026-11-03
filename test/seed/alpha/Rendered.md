---
status: draft
---
# Rendered

Sum: ${1 + 2}

Current page: ${_CTX.currentPage.name}

## Query
${query[[from p = index.pages("project") order by p.name select {Name = p.name, Status = p.status}]]}

## Template
${template.each(query[[from p = index.pages("project") order by p.name]], template.new[==[* [[${name}]] is ${status}
]==])}

## Transclusion
![[Projects/One]]
