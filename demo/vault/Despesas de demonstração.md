---
title: Despesas de demonstração
icon: 💳
kind: database
database:
  properties:
    - id: expense-date
      name: Data
      type: date
      options: []
      format:
        locale: pt-BR
        dateStyle: medium
    - id: expense-amount
      name: Valor
      type: currency
      options: []
      format:
        locale: pt-BR
        currency: BRL
        precision: 2
    - id: expense-paid
      name: Pago?
      type: checkbox
      options: []
      fillMode: default
      defaultValue: false
    - id: expense-invoice
      name: Fatura
      type: relation
      options: []
      relation:
        targetDatabaseId: invoice-table
        multiple: false
        isInverse: false
        displayPropertyId: null
        inversePropertyId: invoice-expenses
        filters: []
    - id: expense-category
      name: Categoria
      type: relation
      options: []
      relation:
        targetDatabaseId: category-table
        multiple: false
        isInverse: false
        displayPropertyId: category-name
        inversePropertyId: null
        filters: []
    - id: expense-bank-label
      name: Banco projetado
      type: formula
      options: []
      formula: ThisRow.Fatura.Banco.Nome
    - id: expense-receipt
      name: Comprovante
      type: image
      options: []
      media:
        multiple: true
    - id: expense-notes
      name: Registro rico
      type: richCanvas
      options: []
  views:
    - id: expense-all
      name: Todas as despesas
      type: table
      filters: []
      sorts: []
      groupBy: null
      dateProp: null
      hidden: []
      widths:
        title: 250
        expense-date: 130
        expense-amount: 120
        expense-paid: 90
      summaries:
        expense-amount: sum
    - id: expense-controlled-month
      name: Ano e mês selecionados
      type: table
      filters:
        - id: expense-year-month-filter
          prop: $formula
          op: is
          value: null
          formula: Year(ThisRow.Data) = Ano and Month(ThisRow.Data) = Mês
          formulaBindings:
            - start: 13
              end: 17
              source: Data
              kind: property
              databaseId: expense-table
              propertyId: expense-date
            - start: 21
              end: 24
              source: Ano
              pageId: finance-panel
              kind: control
              controlId: year-control
            - start: 43
              end: 47
              source: Data
              kind: property
              databaseId: expense-table
              propertyId: expense-date
            - start: 51
              end: 54
              source: Mês
              pageId: finance-panel
              kind: control
              controlId: month-control
      sorts: []
      groupBy: null
      dateProp: null
      hidden: []
      summaries:
        expense-amount: sum
    - id: expense-pending
      name: Pendentes
      type: table
      filters:
        - id: expense-unpaid-filter
          prop: expense-paid
          op: unchecked
          value: false
      sorts: []
      groupBy: null
      dateProp: null
      hidden: []
      summaries:
        expense-amount: sum
---

# Despesas de demonstração

Dados inventados. A view “Ano e mês selecionados” usa os controles do [[Painel financeiro]].
