---
title: Painel financeiro
icon: 🧾
morrowControls:
  - id: year-control
    name: Ano
    type: number
    value: 2026
    defaultValue: 2026
    options: []
    format:
      min: 2020
      max: 2100
      step: 1
  - id: month-control
    name: Mês
    type: number
    value: 12
    defaultValue: 1
    options: []
    format:
      min: 1
      max: 12
      step: 1
---

# Painel financeiro

**Ano:** <span data-morrow-control="year-control">Ano</span> &nbsp; **Mês:** <span data-morrow-control="month-control">Mês</span>

**Total do mês:** <span data-morrow-result="%7B%22resultId%22%3A%22monthly-total%22%2C%22pageId%22%3A%22finance-panel%22%2C%22name%22%3A%22Total%20do%20m%C3%AAs%22%2C%22formula%22%3A%22%60Despesas%20de%20demonstra%C3%A7%C3%A3o%60.Filter(Year(CurrentValue.Data)%20%3D%20Ano%20and%20Month(CurrentValue.Data)%20%3D%20M%C3%AAs).Valor.Sum()%22%2C%22bindings%22%3A%5B%7B%22start%22%3A0%2C%22end%22%3A26%2C%22source%22%3A%22%60Despesas%20de%20demonstra%C3%A7%C3%A3o%60%22%2C%22kind%22%3A%22database%22%2C%22databaseId%22%3A%22expense-table%22%7D%2C%7B%22start%22%3A52%2C%22end%22%3A56%2C%22source%22%3A%22Data%22%2C%22kind%22%3A%22property%22%2C%22databaseId%22%3A%22expense-table%22%2C%22propertyId%22%3A%22expense-date%22%7D%2C%7B%22start%22%3A60%2C%22end%22%3A63%2C%22source%22%3A%22Ano%22%2C%22pageId%22%3A%22finance-panel%22%2C%22kind%22%3A%22control%22%2C%22controlId%22%3A%22year-control%22%7D%2C%7B%22start%22%3A87%2C%22end%22%3A91%2C%22source%22%3A%22Data%22%2C%22kind%22%3A%22property%22%2C%22databaseId%22%3A%22expense-table%22%2C%22propertyId%22%3A%22expense-date%22%7D%2C%7B%22start%22%3A95%2C%22end%22%3A98%2C%22source%22%3A%22M%C3%AAs%22%2C%22pageId%22%3A%22finance-panel%22%2C%22kind%22%3A%22control%22%2C%22controlId%22%3A%22month-control%22%7D%2C%7B%22start%22%3A100%2C%22end%22%3A105%2C%22source%22%3A%22Valor%22%2C%22kind%22%3A%22property%22%2C%22databaseId%22%3A%22expense-table%22%2C%22propertyId%22%3A%22expense-amount%22%7D%5D%2C%22outputType%22%3A%22currency%22%2C%22format%22%3A%7B%22locale%22%3A%22pt-BR%22%2C%22currency%22%3A%22BRL%22%2C%22precision%22%3A2%7D%7D">Total do mês</span>

**Pendente:** <span data-morrow-result="%7B%22resultId%22%3A%22pending-total%22%2C%22pageId%22%3A%22finance-panel%22%2C%22name%22%3A%22Total%20pendente%22%2C%22formula%22%3A%22%60Despesas%20de%20demonstra%C3%A7%C3%A3o%60.Filter(Year(CurrentValue.Data)%20%3D%20Ano%20and%20Month(CurrentValue.Data)%20%3D%20M%C3%AAs%20and%20CurrentValue.%60Pago%3F%60%20%3D%20false).Valor.Sum()%22%2C%22bindings%22%3A%5B%7B%22start%22%3A0%2C%22end%22%3A26%2C%22source%22%3A%22%60Despesas%20de%20demonstra%C3%A7%C3%A3o%60%22%2C%22kind%22%3A%22database%22%2C%22databaseId%22%3A%22expense-table%22%7D%2C%7B%22start%22%3A52%2C%22end%22%3A56%2C%22source%22%3A%22Data%22%2C%22kind%22%3A%22property%22%2C%22databaseId%22%3A%22expense-table%22%2C%22propertyId%22%3A%22expense-date%22%7D%2C%7B%22start%22%3A60%2C%22end%22%3A63%2C%22source%22%3A%22Ano%22%2C%22pageId%22%3A%22finance-panel%22%2C%22kind%22%3A%22control%22%2C%22controlId%22%3A%22year-control%22%7D%2C%7B%22start%22%3A87%2C%22end%22%3A91%2C%22source%22%3A%22Data%22%2C%22kind%22%3A%22property%22%2C%22databaseId%22%3A%22expense-table%22%2C%22propertyId%22%3A%22expense-date%22%7D%2C%7B%22start%22%3A95%2C%22end%22%3A98%2C%22source%22%3A%22M%C3%AAs%22%2C%22pageId%22%3A%22finance-panel%22%2C%22kind%22%3A%22control%22%2C%22controlId%22%3A%22month-control%22%7D%2C%7B%22start%22%3A116%2C%22end%22%3A123%2C%22source%22%3A%22%60Pago%3F%60%22%2C%22kind%22%3A%22property%22%2C%22databaseId%22%3A%22expense-table%22%2C%22propertyId%22%3A%22expense-paid%22%7D%2C%7B%22start%22%3A133%2C%22end%22%3A138%2C%22source%22%3A%22Valor%22%2C%22kind%22%3A%22property%22%2C%22databaseId%22%3A%22expense-table%22%2C%22propertyId%22%3A%22expense-amount%22%7D%5D%2C%22outputType%22%3A%22currency%22%2C%22format%22%3A%7B%22locale%22%3A%22pt-BR%22%2C%22currency%22%3A%22BRL%22%2C%22precision%22%3A2%7D%7D">Total pendente</span>

**Total de 2026:** <span data-morrow-result="%7B%22resultId%22%3A%22annual-total%22%2C%22pageId%22%3A%22finance-panel%22%2C%22name%22%3A%22Total%20anual%22%2C%22formula%22%3A%22%60Despesas%20de%20demonstra%C3%A7%C3%A3o%60.Filter(Year(CurrentValue.Data)%20%3D%20Ano).Valor.Sum()%22%2C%22bindings%22%3A%5B%7B%22start%22%3A0%2C%22end%22%3A26%2C%22source%22%3A%22%60Despesas%20de%20demonstra%C3%A7%C3%A3o%60%22%2C%22kind%22%3A%22database%22%2C%22databaseId%22%3A%22expense-table%22%7D%2C%7B%22start%22%3A52%2C%22end%22%3A56%2C%22source%22%3A%22Data%22%2C%22kind%22%3A%22property%22%2C%22databaseId%22%3A%22expense-table%22%2C%22propertyId%22%3A%22expense-date%22%7D%2C%7B%22start%22%3A60%2C%22end%22%3A63%2C%22source%22%3A%22Ano%22%2C%22pageId%22%3A%22finance-panel%22%2C%22kind%22%3A%22control%22%2C%22controlId%22%3A%22year-control%22%7D%2C%7B%22start%22%3A65%2C%22end%22%3A70%2C%22source%22%3A%22Valor%22%2C%22kind%22%3A%22property%22%2C%22databaseId%22%3A%22expense-table%22%2C%22propertyId%22%3A%22expense-amount%22%7D%5D%2C%22outputType%22%3A%22currency%22%2C%22format%22%3A%7B%22locale%22%3A%22pt-BR%22%2C%22currency%22%3A%22BRL%22%2C%22precision%22%3A2%7D%7D">Total anual</span>

Com Ano 2026 e Mês 12, a view mostra duas despesas, total de R$ 100,00 e pendente de R$ 60,00. Troque os controles para 2027 e 1: deve restar uma despesa de R$ 25,00 sem editar datas.

## Despesas filtradas

<!-- morrow:linked-view:v1:%7B%22sourceDatabaseId%22%3A%22expense-table%22%2C%22blockId%22%3A%22finance-expenses-month-block%22%2C%22view%22%3A%7B%22id%22%3A%22linked-expenses-month%22%2C%22name%22%3A%22Despesas%20do%20ano%20e%20m%C3%AAs%22%2C%22type%22%3A%22table%22%2C%22filters%22%3A%5B%7B%22id%22%3A%22linked-expenses-date-filter%22%2C%22prop%22%3A%22%24formula%22%2C%22op%22%3A%22is%22%2C%22value%22%3Anull%2C%22formula%22%3A%22Year(ThisRow.Data)%20%3D%20Ano%20and%20Month(ThisRow.Data)%20%3D%20M%C3%AAs%22%2C%22formulaBindings%22%3A%5B%7B%22start%22%3A13%2C%22end%22%3A17%2C%22source%22%3A%22Data%22%2C%22kind%22%3A%22property%22%2C%22databaseId%22%3A%22expense-table%22%2C%22propertyId%22%3A%22expense-date%22%7D%2C%7B%22start%22%3A21%2C%22end%22%3A24%2C%22source%22%3A%22Ano%22%2C%22pageId%22%3A%22finance-panel%22%2C%22kind%22%3A%22control%22%2C%22controlId%22%3A%22year-control%22%7D%2C%7B%22start%22%3A43%2C%22end%22%3A47%2C%22source%22%3A%22Data%22%2C%22kind%22%3A%22property%22%2C%22databaseId%22%3A%22expense-table%22%2C%22propertyId%22%3A%22expense-date%22%7D%2C%7B%22start%22%3A51%2C%22end%22%3A54%2C%22source%22%3A%22M%C3%AAs%22%2C%22pageId%22%3A%22finance-panel%22%2C%22kind%22%3A%22control%22%2C%22controlId%22%3A%22month-control%22%7D%5D%7D%5D%2C%22sorts%22%3A%5B%5D%2C%22groupBy%22%3Anull%2C%22dateProp%22%3Anull%2C%22hidden%22%3A%5B%5D%2C%22widths%22%3A%7B%22title%22%3A250%2C%22expense-date%22%3A130%2C%22expense-amount%22%3A120%7D%2C%22summaries%22%3A%7B%22expense-amount%22%3A%22sum%22%7D%7D%7D -->

**Visualização vinculada:** abra no Morrow para editar as linhas compartilhadas.

As páginas [[Faturas de demonstração]], [[Bancos de demonstração]] e [[Categorias de demonstração]] mostram as relações e a soma calculada por fatura.
