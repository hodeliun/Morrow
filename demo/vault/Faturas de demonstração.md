---
title: Faturas de demonstração
icon: 📅
kind: database
database:
  properties:
    - id: invoice-date
      name: Data
      type: date
      options: []
      format:
        locale: pt-BR
        dateStyle: long
    - id: invoice-bank
      name: Banco
      type: relation
      options: []
      relation:
        targetDatabaseId: bank-table
        multiple: false
        isInverse: false
        displayPropertyId: bank-name
        inversePropertyId: null
        filters: []
    - id: invoice-expenses
      name: Despesas
      type: relation
      options: []
      relation:
        targetDatabaseId: expense-table
        multiple: true
        isInverse: true
        displayPropertyId: null
        inversePropertyId: expense-invoice
        filters: []
    - id: invoice-total
      name: Total da fatura
      type: currency
      options: []
      fillMode: calculated
      formula: ThisRow.Despesas.Valor.Sum()
      format:
        locale: pt-BR
        currency: BRL
        precision: 2
  views:
    - id: invoice-all
      name: Faturas
      type: table
      filters: []
      sorts: []
      groupBy: null
      dateProp: null
      hidden: []
      summaries:
        invoice-total: sum
---

# Faturas de demonstração

O campo “Total da fatura” soma as despesas relacionadas; Banco é uma relação com a tabela de bancos.
